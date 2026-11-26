// "Jump to tab": links each agent to the terminal tab it runs in and brings that tab forward.
// Supported: cmux and iTerm2 on macOS. Sheepdog only reads tab titles/ttys and selects tabs;
// it never types into or reads a session.
//
// Matching, most exact first:
//   1. CMUX_SURFACE_ID in the agent's environment (local agents started inside cmux)
//   2. terminal device: the agent's tty, or for remote agents the tty of the local `ssh` client
//      whose local port equals the remote session's SSH_CONNECTION client port
//   3. the session title inside the tab title (Codex writes "<session name> | <dir>" there)
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getConfig, getState, saveStateSoon } from './config.mjs';
import { hostState, tabTitles } from './hosts.mjs';
import { run, log } from './util.mjs';

const IS_MAC = process.platform === 'darwin';
// cmux can live in /Applications or ~/Applications
const CMUX_APP = [path.join('/Applications', 'cmux.app'), path.join(os.homedir(), 'Applications', 'cmux.app')]
  .map((a) => path.join(a, 'Contents', 'Resources', 'bin', 'cmux')).find((p) => existsSync(p)) || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const ITERM_APP = '/Applications/iTerm.app';
let targets = new Map();
let lastSurfaces = []; // `${hostId}:${pid}` -> { app: 'cmux'|'iterm', ... }

// cmux only lets outside programs (like Sheepdog) use its control socket in some modes, set under
// cmux › Settings › Automation › Socket Control Mode. "cmux processes only" (the default) and "Off" block us;
// "Automation mode", "Password mode" (the cmux command reads the saved password) and "Full open access" work.
const CMUX_CONFIG = path.join(os.homedir(), '.config', 'cmux', 'cmux.json');
export const CMUX_FIX = 'In cmux, open Settings › Automation and set Socket Control Mode to “Automation mode”. Then click Allow… again.';
let cmuxModeCache = null;
export async function cmuxSocketMode() {
  if (!terminalsInstalled().cmux) return null;
  if (cmuxModeCache && Date.now() - cmuxModeCache.at < 30e3) return cmuxModeCache.mode;
  let mode = null;
  try {
    // cmux.json allows // comments: only look at lines that aren't commented out
    const text = readFileSync(CMUX_CONFIG, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    mode = text.match(/"socketControlMode"\s*:\s*"(\w+)"/)?.[1] || null;
  } catch {}
  if (!mode) mode = (await run('defaults', ['read', 'com.cmuxterm.app', 'socketControlMode'], { timeout: 3000 }).catch(() => '')).trim() || 'cmuxOnly';
  cmuxModeCache = { at: Date.now(), mode };
  return mode;
}
export const cmuxBlocks = (mode) => mode === 'cmuxOnly' || mode === 'off';

export function terminalsInstalled() {
  return { cmux: IS_MAC && existsSync(CMUX_APP), iterm: IS_MAC && existsSync(ITERM_APP) };
}

export const CMUX_BIN = CMUX_APP;
const cmuxEnv = () => {
  const pw = getConfig().terminal.cmuxPassword || process.env.CMUX_SOCKET_PASSWORD;
  return pw ? { CMUX_SOCKET_PASSWORD: pw } : {};
};
const cmux = (args) => run(CMUX_APP, args, { timeout: 8000, env: cmuxEnv() });
const normTitle = (t) => (t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();
const shortTty = (t) => (t || '').replace(/^\/dev\//, '');

async function cmuxSurfaces() {
  if (!terminalsInstalled().cmux) return [];
  const tree = JSON.parse(await cmux(['tree', '--all', '--json', '--id-format', 'both']));
  const all = [];
  for (const w of tree.windows || []) for (const ws of w.workspaces || []) for (const p of ws.panes || [])
    for (const s of p.surfaces || []) {
      if (s.type && s.type !== 'terminal') continue;
      all.push({ app: 'cmux', window: w.ref, workspace: ws.id, surface: s.ref, id: s.id, tty: shortTty(s.tty), title: s.title, place: ws.title,
        titles: [s.title, ws.title].map(normTitle).filter(Boolean) });
    }
  return all;
}

const ITERM_LIST = `
set out to ""
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set out to out & (id of w) & tab & (tty of s) & tab & (name of s) & linefeed
      end repeat
    end repeat
  end repeat
end tell
return out`;

async function itermSessions() {
  if (!terminalsInstalled().iterm) return [];
  // only ask iTerm2 when it is already running, so polling never launches it
  const running = await run('pgrep', ['-x', 'iTerm2']).then(() => true, () => false);
  if (!running) return [];
  const out = await run('osascript', ['-e', ITERM_LIST], { timeout: 8000 });
  return out.trim().split('\n').filter(Boolean).map((line) => {
    const [win, tty, title] = line.split('\t');
    return { app: 'iterm', window: win, tty: shortTty(tty), id: `iterm:${tty}`, title, titles: [normTitle(title)].filter(Boolean) };
  });
}

async function sshClients() {
  // local port -> { pid, tty } for each running `ssh` client
  const res = new Map();
  const out = await run('lsof', ['-nP', '-a', '-c', 'ssh', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn'], { timeout: 8000 }).catch(() => '');
  const pidPort = new Map();
  let pid = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) { const m = line.match(/:(\d+)->/); if (m) pidPort.set(pid, Number(m[1])); }
  }
  if (!pidPort.size) return res;
  const ps = await run('ps', ['-o', 'pid=,tty=', '-p', [...pidPort.keys()].join(',')]).catch(() => '');
  for (const line of ps.trim().split('\n')) {
    const [p, tty] = line.trim().split(/\s+/);
    if (p) res.set(pidPort.get(Number(p)), { pid: Number(p), tty: tty && tty !== '??' ? tty : null });
  }
  return res;
}

async function envOf(pids) {
  // pid -> { surface: CMUX_SURFACE_ID, tmux: TMUX socket, pane: TMUX_PANE }
  const res = new Map();
  if (!pids.length) return res;
  const out = await run('ps', ['-E', '-o', 'pid=,command=', '-p', pids.join(',')]).catch(() => '');
  for (const line of out.split('\n')) {
    const pid = Number(line.match(/^\s*(\d+)\s/)?.[1]);
    if (!pid) continue;
    res.set(pid, {
      surface: line.match(/CMUX_SURFACE_ID=([0-9A-Fa-f-]{36})/)?.[1]?.toUpperCase() || null,
      tmux: line.match(/\bTMUX=([^,\s]+),/)?.[1] || null,
      pane: line.match(/\bTMUX_PANE=(%\d+)/)?.[1] || null,
    });
  }
  return res;
}

// tmux on this Mac (inside a cmux tab): an agent in tmux carries the cmux tab id of whoever started tmux.
// The tab that shows it now is the one running the `tmux attach` client for its session.
const TMUX_BIN = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p)) || 'tmux';
async function tmuxClientPids(sock, pane) {
  const base = ['-S', sock];
  const session = (await run(TMUX_BIN, [...base, 'display-message', '-p', '-t', pane, '#{session_name}'], { timeout: 3000 }).catch(() => '')).trim();
  if (!session) return [];
  const out = await run(TMUX_BIN, [...base, 'list-clients', '-F', '#{client_pid}\t#{client_session}\t#{client_activity}'], { timeout: 3000 }).catch(() => '');
  return out.split('\n').map((l) => l.split('\t')).filter((p) => p.length === 3 && p[1] === session)
    .sort((a, b) => Number(b[2]) - Number(a[2])).map((p) => Number(p[0]));
}

async function cmuxIdsFromEnv(pids) {
  const res = new Map();
  const env = await envOf(pids);
  const viaTmux = new Map(); // agent pid -> tmux client pids
  for (const [pid, e] of env) {
    if (e.tmux && e.pane) viaTmux.set(pid, await tmuxClientPids(e.tmux, e.pane));
    else if (e.surface) res.set(pid, e.surface);
  }
  const clients = await envOf([...new Set([...viaTmux.values()].flat())]);
  for (const [pid, list] of viaTmux) {
    const hit = list.map((c) => clients.get(c)?.surface).find(Boolean) || env.get(pid)?.surface;
    if (hit) res.set(pid, hit);
  }
  return res;
}

export async function updateTabTargets() {
  if (!IS_MAC) return;
  try {
    const local = [];
    const remote = [];
    for (const [hostId, h] of hostState) {
      for (const a of h.agents || []) {
        if (!a.pid) continue;
        (hostId === 'local' ? local : remote).push({ hostId, a });
      }
    }
    const [cm, it, ssh] = await Promise.all([cmuxSurfaces().catch(() => []), itermSessions().catch(() => []), sshClients()]);
    const surfaces = [...cm, ...it];
    const envIds = await cmuxIdsFromEnv([...local.map((x) => x.a.pid), ...[...ssh.values()].map((c) => c.pid)]);
    const byId = new Map(cm.filter((s) => s.id).map((s) => [String(s.id).toUpperCase(), s]));
    const byTty = new Map(surfaces.filter((s) => s.tty).map((s) => [s.tty, s]));
    const byTitle = (title) => {
      const t = normTitle(title);
      if (!t) return null;
      const hits = surfaces.filter((s) => s.titles.some((x) => x === t || x.startsWith(t + ' |') || x.includes(t)));
      return hits.length === 1 ? hits[0] : null;
    };
    const next = new Map();
    for (const { hostId, a } of local) {
      const t = byId.get(envIds.get(a.pid)) || (a.tty && byTty.get(shortTty(a.tty))) || byTitle(a.title);
      if (t) next.set(`${hostId}:${a.pid}`, t);
    }
    const unlinked = [];
    for (const x of remote) {
      const c = x.a.sshPort && ssh.get(x.a.sshPort);
      const t = c && (byId.get(envIds.get(c.pid)) || (c.tty && byTty.get(c.tty)));
      if (t) next.set(`${x.hostId}:${x.a.pid}`, t); else unlinked.push(x);
    }
    // Not every tab reports a tty: if exactly one remote agent and one Codex-looking tab
    // ("<name> | <dir>") are left over, they belong together.
    const used = new Set([...next.values()].map((t) => t.id));
    const spare = surfaces.filter((s) => !used.has(s.id) && / \| [^|]+$/.test(s.title || ''));
    if (unlinked.length === 1 && spare.length === 1) next.set(`${unlinked[0].hostId}:${unlinked[0].a.pid}`, spare[0]);
    else for (const x of unlinked) { const t = byTitle(x.a.title); if (t) next.set(`${x.hostId}:${x.a.pid}`, t); }

    // tabs people picked by hand ("Which tab is this agent in?") win, while that agent and tab exist
    const manual = getState().tabLinks || {};
    const alive = new Set([...local, ...remote].map((x) => `${x.hostId}:${x.a.pid}`));
    for (const [key, id] of Object.entries(manual)) {
      const t = surfaces.find((x) => x.id === id);
      if (alive.has(key) && t) next.set(key, t);
      else if (!alive.has(key)) { delete manual[key]; saveStateSoon(); }
    }
    lastSurfaces = surfaces;
    tabTitles.clear();
    for (const [k, t] of next) tabTitles.set(k, t.title);
    targets = next;
  } catch (e) {
    log('tab mapping failed:', e.message);
  }
}

export const isFocusable = (key) => targets.has(key);

/** Terminal tabs to pick from when Sheepdog can't tell which tab an agent is in. */
export const listTabs = () => lastSurfaces.map((s) => ({ id: s.id, app: s.app, title: s.title || '', place: s.place || '' }));

/** Remember that the agent `key` (host:pid) runs in tab `id`, and switch to it. */
export async function linkTab(key, id) {
  const t = lastSurfaces.find((x) => x.id === id);
  if (!t) throw new Error('That tab is gone; pick again');
  const st = getState();
  st.tabLinks ||= {};
  st.tabLinks[key] = id;
  saveStateSoon();
  targets.set(key, t);
  tabTitles.set(key, t.title);
  return focusAgent(key);
}

export async function focusAgent(key) {
  const t = targets.get(key);
  if (!t) return { ok: false, error: 'No terminal tab found for this agent' };
  if (t.app === 'cmux') {
    await run('open', ['-a', 'cmux']);
    if (t.window) await cmux(['focus-window', '--window', t.window]).catch(() => {});
    await cmux(['select-workspace', '--workspace', t.workspace]);
    await cmux(['focus-panel', '--panel', t.surface, '--workspace', t.workspace]).catch(() => {});
  } else {
    const tty = `/dev/${t.tty}`;
    await run('osascript', ['-e', `
on run argv
  set want to item 1 of argv
  tell application "iTerm2"
    activate
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is want then
            select w
            select t
            select s
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
end run`, tty]);
  }
  log('focused', key, '->', t.title);
  return { ok: true, title: t.title };
}

/** Ask macOS for Automation permission for a terminal app (shows the system prompt once). */
export async function requestAutomation(app) {
  if (!IS_MAC) return { ok: false, error: 'Only on macOS' };
  try {
    if (app === 'iterm') await run('osascript', ['-e', 'tell application "iTerm2" to get name'], { timeout: 60000 });
    else if (app === 'cmux') {
      cmuxModeCache = null;
      const mode = await cmuxSocketMode();
      if (cmuxBlocks(mode)) return { ok: false, error: `cmux doesn’t let Sheepdog in yet (Socket Control Mode is “${mode === 'off' ? 'Off' : 'cmux processes only'}”). ${CMUX_FIX}`, cmuxMode: mode };
      try { await cmux(['tree', '--json']); }
      catch (e) {
        // the setting can live somewhere Sheepdog didn't look; cmux's own refusal says the same thing
        if (/only process(es)? started inside cmux|access denied/i.test(e.message)) {
          cmuxModeCache = { at: Date.now(), mode: 'cmuxOnly' };
          return { ok: false, error: `cmux doesn’t let Sheepdog in yet (Socket Control Mode is “cmux processes only”). ${CMUX_FIX}`, cmuxMode: 'cmuxOnly' };
        }
        throw e;
      }
    }
    else return { ok: false, error: 'Unknown app' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
