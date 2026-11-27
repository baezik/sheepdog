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
let lastSurfaces = [];
let matchVia = new Map(); // `${hostId}:${pid}` -> { app: 'cmux'|'iterm', ... }

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
      surface: line.match(/CMUX_(?:SURFACE|PANEL)_ID=([0-9A-Fa-f-]{36})/)?.[1]?.toUpperCase() || null,
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

// ---------------------------------------------------------------- cmux: which tab owns a process
// cmux starts each tab with its own `login` process, and everything in the tab (shell, ssh, tmux attach,
// agents) descends from it. `cmux debug-terminals` gives each tab's age, so (now − age) is when the tab was
// created: the login started within a second or two of that. Pairing them tells which tab owns any process,
// without reading process environments (which macOS no longer allows) or relying on tab titles.
let tabLoginCache = { key: '', map: new Map() };
async function cmuxTabLogins(procs) {
  const cmuxApp = [...procs.values()].find((p) => /\/cmux\.app\/Contents\/MacOS\/cmux$/.test(p.comm));
  if (!cmuxApp) return new Map();
  const logins = [...procs.values()].filter((p) => p.ppid === cmuxApp.pid && /(^|\/)login$/.test(p.comm));
  if (!logins.length) return new Map();
  const out = await cmux(['debug-terminals']).catch(() => '');
  const now = Date.now();
  const tabs = [];
  for (const block of out.split(/\n(?=\[\d+\] )/)) {
    const ref = block.match(/^\[\d+\] (surface:\d+)/)?.[1];
    const age = Number(block.match(/\bcreated=([\d.]+)s/)?.[1]);
    if (ref && Number.isFinite(age)) tabs.push({ ref, at: now - age * 1000 });
  }
  const key = `${logins.map((l) => l.pid).sort().join(',')}|${tabs.map((t) => t.ref).sort().join(',')}`;
  if (key === tabLoginCache.key) return tabLoginCache.map;
  const started = await run('ps', ['-o', 'pid=,lstart=', '-p', logins.map((l) => l.pid).join(',')], { env: { LC_ALL: 'C' } }).catch(() => '');
  const loginAt = new Map();
  for (const line of started.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    const t = m && Date.parse(m[2]);
    if (t) loginAt.set(Number(m[1]), t);
  }
  // pair closest first; ps only has whole seconds, so allow a few seconds and take each side once
  const pairs = [];
  for (const t of tabs) for (const [pid, at] of loginAt) { const d = Math.abs(t.at - at); if (d < 4000) pairs.push({ ref: t.ref, pid, d }); }
  pairs.sort((a, b) => a.d - b.d);
  const map = new Map(), usedPid = new Set(), usedRef = new Set();
  for (const p of pairs) if (!usedPid.has(p.pid) && !usedRef.has(p.ref)) { map.set(p.pid, p.ref); usedPid.add(p.pid); usedRef.add(p.ref); }
  tabLoginCache = { key, map };
  return map;
}

async function processTable() {
  const out = await run('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 8000 }).catch(() => '');
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3].trim() });
  }
  return procs;
}

// local tmux: pane shell pid -> client pids showing that session (most recent first), for every tmux server
// socket of this user
async function localTmuxPanes() {
  const panes = new Map();
  const dir = `/private/tmp/tmux-${process.getuid?.() ?? ''}`;
  const sockets = [];
  try { for (const f of (await import('node:fs')).readdirSync(dir)) sockets.push(path.join(dir, f)); } catch {}
  for (const sock of sockets) {
    const list = await run(TMUX_BIN, ['-S', sock, 'list-panes', '-a', '-F', '#{pane_pid}\t#{session_name}'], { timeout: 3000 }).catch(() => '');
    if (!list) continue;
    const clients = await run(TMUX_BIN, ['-S', sock, 'list-clients', '-F', '#{client_pid}\t#{client_session}\t#{client_activity}'], { timeout: 3000 }).catch(() => '');
    const bySession = new Map();
    for (const l of clients.split('\n')) {
      const [pid, sess, act] = l.split('\t');
      if (pid && sess) (bySession.get(sess) || bySession.set(sess, []).get(sess)).push([Number(act) || 0, Number(pid)]);
    }
    for (const l of list.split('\n')) {
      const [pid, sess] = l.split('\t');
      if (pid && sess) panes.set(Number(pid), (bySession.get(sess) || []).sort((a, b) => b[0] - a[0]).map((x) => x[1]));
    }
  }
  return panes;
}

/** The cmux tab (surface ref) a local process lives in: walk up to the tab's login, or through tmux. */
function tabOfProcess(pid, procs, loginTabs, tmuxPanes, depth = 0) {
  for (let cur = pid, hops = 0; cur && cur > 1 && hops < 40; hops++) {
    if (loginTabs.has(cur)) return loginTabs.get(cur);
    if (tmuxPanes.has(cur) && depth === 0) {
      for (const client of tmuxPanes.get(cur)) {
        const t = tabOfProcess(client, procs, loginTabs, tmuxPanes, 1);
        if (t) return t;
      }
    }
    cur = procs.get(cur)?.ppid;
  }
  return null;
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
    const [cm, it, ssh, procs] = await Promise.all([cmuxSurfaces().catch(() => []), itermSessions().catch(() => []), sshClients(), processTable()]);
    const loginTabs = cm.length ? await cmuxTabLogins(procs).catch(() => new Map()) : new Map();
    const tmuxPanes = loginTabs.size ? await localTmuxPanes().catch(() => new Map()) : new Map();
    const byRef = new Map(cm.map((s) => [s.surface, s]));
    const ownTab = (pid) => (loginTabs.size ? byRef.get(tabOfProcess(pid, procs, loginTabs, tmuxPanes)) : null);
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
    const via = new Map(); // key -> how the tab was found (shown on hover, helps support)
    const pick = (key, list) => { for (const [how, t] of list) if (t) { next.set(key, t); via.set(key, how); return t; } return null; };
    for (const { hostId, a } of local) {
      pick(`${hostId}:${a.pid}`, [['process', ownTab(a.pid)], ['env', byId.get(envIds.get(a.pid))], ['tty', a.tty && byTty.get(shortTty(a.tty))], ['title', byTitle(a.title)]]);
    }
    const unlinked = [];
    for (const x of remote) {
      const c = x.a.sshPort && ssh.get(x.a.sshPort);
      const t = c && pick(`${x.hostId}:${x.a.pid}`, [['ssh', ownTab(c.pid)], ['env', byId.get(envIds.get(c.pid))], ['tty', c.tty && byTty.get(c.tty)]]);
      if (!t) unlinked.push(x);
    }
    // Not every tab reports a tty: if exactly one remote agent and one Codex-looking tab
    // ("<name> | <dir>") are left over, they belong together.
    const used = new Set([...next.values()].map((t) => t.id));
    const spare = surfaces.filter((s) => !used.has(s.id) && / \| [^|]+$/.test(s.title || ''));
    if (unlinked.length === 1 && spare.length === 1) pick(`${unlinked[0].hostId}:${unlinked[0].a.pid}`, [['guess', spare[0]]]);
    else for (const x of unlinked) pick(`${x.hostId}:${x.a.pid}`, [['title', byTitle(x.a.title)]]);

    // tabs people picked by hand ("Which tab is this agent in?") win, while that agent and tab exist
    const manual = getState().tabLinks || {};
    const alive = new Set([...local, ...remote].map((x) => `${x.hostId}:${x.a.pid}`));
    for (const [key, id] of Object.entries(manual)) {
      const t = surfaces.find((x) => x.id === id);
      if (alive.has(key) && t) { next.set(key, t); via.set(key, 'picked'); }
      else if (!alive.has(key)) { delete manual[key]; saveStateSoon(); }
    }
    lastSurfaces = surfaces;
    tabTitles.clear();
    for (const [k, t] of next) tabTitles.set(k, t.title);
    targets = next;
    matchVia = via;
  } catch (e) {
    log('tab mapping failed:', e.message);
  }
}

export const isFocusable = (key) => targets.has(key);
export const focusVia = (key) => matchVia.get(key) || null;

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

// ---------------------------------------------------------------- answering an agent from the board
// cmux can read a tab's screen and type into it, so the board can show what a waiting agent is asking and
// send the answer without switching tabs. It works for any agent (local, over ssh, inside tmux), because it
// is the tab itself that is read and typed into. Only cmux for now.
export const canReply = (key) => targets.get(key)?.app === 'cmux';
const KEYS = new Set(['enter', 'escape', 'tab', 'shift+tab', 'up', 'down', 'left', 'right', 'backspace']);

function cmuxTarget(key) {
  const t = targets.get(key);
  if (!t) throw new Error('No terminal tab found for this agent');
  if (t.app !== 'cmux') throw new Error('Answering from Sheepdog works in cmux tabs only');
  return ['--workspace', t.workspace, '--surface', t.surface];
}

/** The last lines on the agent's screen (plain text), and the part of it that is the agent's question. */
export async function readScreen(key, lines = 40, { scrollback = false } = {}) {
  const text = (await cmux(['read-screen', ...cmuxTarget(key), ...(scrollback ? ['--scrollback'] : []), '--lines', String(Math.min(200, Math.max(5, lines)))])).replace(/\s+$/, '');
  return { text, question: questionOf(text) };
}

// lines that are the agent's own chrome, not what it said
const CHROME = /^\s*(✻|✢|✳|✶|└ Tip:|Tip:|Worked for|⎿\s+(Queued|Allowed)|\? for shortcuts|← for agents)/;
/**
 * What a waiting agent is asking: the end of its screen above the input box, without the status lines.
 * Claude Code draws its input between two ──── rules (❯ inside); Codex has a "›" input line near the bottom.
 * A screen without an input box (a permission dialog, say) is kept whole: the choices are the question.
 */
export function questionOf(text, max = 18) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let cut = lines.length;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (/^\s*─{10,}$/.test(lines[i]) && /^\s*[❯>]/.test(lines[i + 1])) { cut = i; break; }
  }
  if (cut === lines.length) {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) if (/^\s*› /.test(lines[i])) { cut = i; break; }
  }
  const keep = lines.slice(0, cut).filter((l) => !CHROME.test(l)).map((l) => l.replace(/\s*\(turn off recaps in \/config\)/, '').replace(/^(\s*)※ recap:\s*/, '$1'));
  while (keep.length && !keep.at(-1).trim()) keep.pop();
  const out = keep.slice(-max);
  while (out.length && !out[0].trim()) out.shift();
  // the screen is indented the same throughout: drop the shared indent
  const indent = Math.min(...out.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return out.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

/** Type text into the agent's tab (then Enter unless `enter` is false), or press one of KEYS. */
export async function sendToAgent(key, { text, press, enter = true } = {}) {
  const at = cmuxTarget(key);
  if (press) {
    if (!KEYS.has(press)) throw new Error('Unknown key');
    await cmux(['send-key', ...at, press]);
  } else {
    // one line, no control characters; cmux reads \n, \t … in sent text as keys, so the text goes in pieces
    // that each end at a backslash, which keeps every backslash literal
    const line = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 4000);
    for (const piece of line.match(/[^\\]*\\|[^\\]+$/g) || []) await cmux(['send', ...at, '--', piece]);
    if (enter) await cmux(['send-key', ...at, 'enter']);
  }
  log('sent to', key, press ? `key ${press}` : `${String(text ?? '').length} characters`);
  return { ok: true };
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
