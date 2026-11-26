// Machines ("pastures") Sheepdog watches: this computer plus any SSH hosts the user adds.
// Each poll runs probe.py locally, or pipes it to `ssh <host> python3 -`.
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig, getState, saveStateSoon } from './config.mjs';
import { run, log } from './util.mjs';

const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe.py');
const SSH_OPTS = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6',
  // trust a machine's key the first time, like answering "yes" to ssh (a changed key is still refused)
  '-o', 'StrictHostKeyChecking=accept-new',
  // ignore a RemoteCommand / RequestTTY in ~/.ssh/config (e.g. "attach to tmux"): ssh refuses to run our command
  // alongside it ("Cannot execute command-line and remote command"). Only affects Sheepdog's connections.
  '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no',
  '-o', 'ControlMaster=auto', '-o', `ControlPath=${os.tmpdir()}/sheepdog-%r@%h:%p`, '-o', 'ControlPersist=10m',
];

/** Turns ssh's error into what's wrong and how to fix it: { error, fix } (fix is a command to run, or null). */
export function sshProblem(raw, target) {
  const m = String(raw || '');
  const host = target || 'the machine';
  const known = [
    [/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i, `${host}’s identity (host key) changed since you last connected, so SSH refuses it. If the machine was reinstalled or rebuilt, forget the old key, then click Test again.`, `ssh-keygen -R ${host}`],
    [/Host key verification failed/i, `SSH doesn’t trust ${host} yet. Connect once in Terminal and answer “yes”, then click Test again.`, `ssh ${host}`],
    [/Permission denied \(.*publickey/i, `${host} wants a password, but Sheepdog can only log in with an SSH key. Copy your key to it once (asks for the password one last time).`, `ssh-copy-id ${host}`],
    [/Too many authentication failures/i, `SSH tried too many keys and ${host} gave up. Add “IdentitiesOnly yes” and the right “IdentityFile” for it in ~/.ssh/config.`, null],
    [/Could not resolve hostname/i, `Can’t find ${host}. Check the name, or the Host entry in ~/.ssh/config.`, null],
    [/timed out|No route to host|Network is unreachable/i, `${host} isn’t answering. Is it running, and are you on the right network or VPN?`, null],
    [/Connection refused/i, `${host} is up but SSH isn’t accepting connections (wrong port, or SSH isn’t running there).`, null],
    [/Cannot execute command-line and remote command/i, `The ~/.ssh/config entry for ${host} runs its own command on login. Update Sheepdog; newer versions handle this.`, null],
    [/python3: (command )?not found|No such file or directory.*python3|python3.*not found/i, `Python 3 isn’t installed on ${host}. Sheepdog needs it there to read the agents.`, 'sudo apt install -y python3'],
  ];
  for (const [re, error, fix] of known) if (re.test(m)) return { error, fix };
  return { error: m.split('\n').filter(Boolean).pop() || 'Couldn’t connect', fix: null };
}

/** user@host, alias or host:port style targets only, so a value can never become an ssh option. */
export const validSshTarget = (t) => typeof t === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,200}$/.test(t);

export const hostState = new Map(); // host id -> { ok, at, error, host, ncpu, load, mem, disk, agents, codexSessions }
const stateSeen = new Map(); // `${hostId}:${sid|pid}` -> { state, since }
export const tabTitles = new Map(); // `${hostId}:${pid}` -> title of the terminal tab the agent runs in (set by terminal.mjs)

// Which python3 runs the local probe. /usr/bin/python3 is only a stub until Apple's Command Line
// Tools are installed, and calling the stub pops up an install dialog, so it is only used once we
// know the tools are there.
export const NO_PYTHON = 'Sheepdog needs Python 3 to see agents on this Mac. Install Apple’s Command Line Tools (run xcode-select --install in Terminal), then restart Sheepdog.';
let pythonBin;
async function localPython() {
  if (pythonBin !== undefined) return pythonBin;
  if (process.env.SHEEPDOG_PYTHON) return (pythonBin = process.env.SHEEPDOG_PYTHON);
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir || dir === '/usr/bin') continue;
    try { accessSync(path.join(dir, 'python3'), constants.X_OK); return (pythonBin = path.join(dir, 'python3')); } catch {}
  }
  if (process.platform !== 'darwin') return (pythonBin = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : null);
  const tools = await run('/usr/bin/xcode-select', ['-p'], { timeout: 5000 }).then((p) => p.trim(), () => '');
  pythonBin = tools && existsSync(tools) ? '/usr/bin/python3' : null;
  if (!pythonBin) setTimeout(() => { pythonBin = undefined; }, 60000); // check again later
  return pythonBin;
}

let probeSrc = null;
async function probeOn(host) {
  if (host.type === 'local') {
    const py = await localPython();
    if (!py) throw new Error(NO_PYTHON);
    return JSON.parse(await run(py, [PROBE], { timeout: 15000 }));
  }
  if (!validSshTarget(host.ssh)) throw new Error('Invalid SSH host');
  probeSrc ||= await readFile(PROBE, 'utf8');
  let out;
  try {
    out = await run('ssh', [...SSH_OPTS, host.ssh, 'python3', '-'], { input: probeSrc, timeout: 20000 });
  } catch (e) {
    const p = sshProblem(e.message, host.ssh);
    throw Object.assign(new Error(p.error), { fix: p.fix });
  }
  return JSON.parse(out);
}

function ticketOf(a, re) {
  for (const t of [a.title, a.prompt, a.branch, a.name, a.cwd]) {
    const m = t && re && String(t).match(re);
    if (m) return m[0];
  }
  return null;
}

function ticketRegex() {
  try { return new RegExp(getConfig().tickets.pattern); } catch { return null; }
}

// ---------------------------------------------------------------- codex terminal mapping
// Codex terminals share one app-server, so no file says which terminal shows which session.
// The probe guesses (newest terminal started before the session). Once made, a guess is kept
// ("sticky") until that terminal starts a brand-new session; when the terminal tab title names
// the session, that wins. Persisted so restarts keep the mapping.
const sessionFirstSeen = new Map();
const firstPoll = new Set();
const normTitle = (t) => (t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase();

function useSession(a, s) {
  for (const k of ['sessionId', 'title', 'prompt', 'state', 'stateSince', 'lastActivity', 'tokens', 'contextTokens', 'contextWindow', 'contextPct']) a[k] = s[k];
}

function applyCodexSticky(hostId, data) {
  const st = getState();
  st.codexSticky ||= {};
  const sticky = st.codexSticky;
  const now = Date.now();
  const sessions = new Map((data.codexSessions || []).map((s) => [s.sessionId, s]));
  for (const sid of sessions.keys()) if (!sessionFirstSeen.has(sid)) sessionFirstSeen.set(sid, firstPoll.has(hostId) ? now : 0);
  firstPoll.add(hostId);
  const alive = new Set();
  for (const a of data.agents) {
    if (a.kind !== 'codex' || !a.pid) continue;
    const key = `${hostId}:${a.pid}`;
    alive.add(key);
    const tab = normTitle((tabTitles.get(key) || '').replace(/\s+\|\s+[^|]*$/, ''));
    const fromTab = tab && [...sessions.values()].filter((s) => s.title && normTitle(s.title) === tab)
      .sort((x, y) => (y.lastActivity || 0) - (x.lastActivity || 0))[0];
    if (fromTab) {
      if (fromTab.sessionId !== a.sessionId) useSession(a, fromTab);
      sticky[key] = { sid: fromTab.sessionId, at: now };
      continue;
    }
    const prev = sticky[key];
    if (prev && sessions.has(prev.sid) && a.sessionId !== prev.sid) {
      const brandNew = a.sessionId && (sessionFirstSeen.get(a.sessionId) || 0) > prev.at;
      if (!brandNew) { useSession(a, sessions.get(prev.sid)); continue; }
    }
    if (a.sessionId && (!prev || prev.sid !== a.sessionId)) sticky[key] = { sid: a.sessionId, at: now };
  }
  for (const k of Object.keys(sticky)) if (k.startsWith(`${hostId}:`) && !alive.has(k)) delete sticky[k];
  saveStateSoon();
}

// ---------------------------------------------------------------- polling
export async function pollHost(host) {
  try {
    const data = await probeOn(host);
    applyCodexSticky(host.id, data);
    const now = Date.now() / 1000;
    const re = ticketRegex();
    for (const a of data.agents) {
      const key = `${host.id}:${a.sessionId || a.pid}`;
      const prev = stateSeen.get(key);
      if (!prev || prev.state !== a.state) stateSeen.set(key, { state: a.state, since: prev ? now : (a.lastActivity || now) });
      if (!a.stateSince) a.stateSince = stateSeen.get(key).since;
      a.host = host.id;
      a.ticket = ticketOf(a, re);
    }
    hostState.set(host.id, { ok: true, at: Date.now(), ...data });
  } catch (e) {
    const prev = hostState.get(host.id) || {};
    hostState.set(host.id, { ...prev, ok: false, at: prev.at || 0, error: e.message, fix: e.fix || null, failedAt: Date.now() });
    if (!prev.error || prev.error !== e.message) log(`probe ${host.name} failed:`, e.message);
  }
}

export async function pollAllHosts() {
  const hosts = getConfig().hosts.filter((h) => h.enabled);
  for (const id of hostState.keys()) if (!hosts.some((h) => h.id === id)) hostState.delete(id);
  await Promise.all(hosts.map(pollHost));
}

/** One-off check used by "Test" buttons: does this host answer, and what runs there? */
export async function testHost(host) {
  const t = Date.now();
  try {
    const d = await probeOn(host);
    const agents = d.agents.filter((a) => !a.parent && !a.headless);
    const names = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', agy: 'Antigravity' };
    const kinds = Object.keys(names).map((k) => [k, agents.filter((a) => a.kind === k).length]).filter(([, n]) => n);
    return { ok: true, ms: Date.now() - t, host: d.host, agents: agents.length,
      summary: kinds.length ? kinds.map(([k, n]) => `${n} ${names[k]}`).join(', ') : 'no agents running' };
  } catch (e) {
    const msg = host.type === 'local' && /ENOENT/.test(e.message) ? NO_PYTHON : e.message;
    return { ok: false, error: msg, fix: e.fix || null };
  }
}

/** Host aliases from ~/.ssh/config (and files it Includes), without wildcard patterns. */
export function sshConfigHosts() {
  const seen = new Set();
  const out = [];
  const read = (file, depth) => {
    if (depth > 3 || !existsSync(file)) return;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { return; }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      const m = line.match(/^(\w+)\s*=?\s*(.+)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === 'include') {
        for (const inc of m[2].split(/\s+/)) {
          const p = inc.replace(/^~/, os.homedir());
          const full = path.isAbsolute(p) ? p : path.join(os.homedir(), '.ssh', p);
          if (!full.includes('*')) read(full, depth + 1);
        }
      } else if (key === 'host') {
        for (const h of m[2].split(/\s+/)) {
          if (/[*?!]/.test(h) || seen.has(h) || !validSshTarget(h)) continue;
          seen.add(h);
          out.push(h);
        }
      }
    }
  };
  read(path.join(os.homedir(), '.ssh', 'config'), 0);
  return out;
}
