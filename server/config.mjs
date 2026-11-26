// Settings live in one JSON file per user: ~/.config/sheepdog/config.json (mode 600, it holds tokens).
// Small runtime state (e.g. when a 👀 reaction was first seen) lives next to it in state.json.
import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';

export const CONFIG_DIR = process.env.SHEEPDOG_CONFIG_DIR || path.join(os.homedir(), '.config', 'sheepdog');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

export const DEFAULTS = {
  version: 1,
  setupComplete: false,
  hosts: [{ id: 'local', name: 'This Mac', type: 'local', enabled: true }],
  pollSeconds: 3,
  idleMinutes: 30,
  alerts: {
    notify: true,
    sound: 'Woof', // Woof | Ding | Bleat | Silent
    windowFlash: true,
    alertAfterSeconds: 0,
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    prReview: true, // someone started reviewing your PR
    prApproved: true, // your PR was approved
    prNudgeHours: 4, // a teammate's PR has had no reviewer this long (0 = off)
  },
  board: { density: 'auto', showPrs: true },
  tickets: { pattern: '\\b[A-Z][A-Z0-9]{1,9}-\\d+\\b', link: '' },
  github: {
    auth: 'none', // none | token | gh | device
    token: '',
    login: '',
    clientId: '', // OAuth app client id for "Sign in with GitHub" (device flow)
    repos: [], // "owner/name"
    branches: ['dev', 'staging', 'main'],
  },
  slack: {
    token: '',
    team: '',
    teamUrl: '',
    user: '',
    userId: '',
    channelId: '',
    channelName: '',
    reviewing: 'eyes',
    approved: 'white_check_mark',
    lookbackDays: 14,
  },
  terminal: { cmuxPassword: '' },
};

const SECRET_PATHS = [['github', 'token'], ['slack', 'token'], ['terminal', 'cmuxPassword']];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

function writeSecure(file, data) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch {}
}

let config = null;
export function getConfig() {
  if (!config) {
    let saved = {};
    try { saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch {}
    config = merge(structuredClone(DEFAULTS), saved);
  }
  return config;
}

export function saveConfig(next) {
  config = next;
  writeSecure(CONFIG_FILE, config);
  return config;
}

export function updateConfig(fn) {
  const next = structuredClone(getConfig());
  fn(next);
  return saveConfig(next);
}

export function resetConfig() {
  return saveConfig(structuredClone(DEFAULTS));
}

/** Config as the browser may see it: secrets replaced by { set, hint }. */
export function publicConfig() {
  const c = structuredClone(getConfig());
  for (const [a, b] of SECRET_PATHS) {
    const v = c[a][b];
    c[a][b] = { set: !!v, hint: v ? `…${String(v).slice(-4)}` : '' };
  }
  return c;
}

// Settings the browser may change through POST /api/config. Tokens, auth and the Slack/GitHub
// identity are only changed by the connect endpoints, after the server has checked them.
const EDITABLE = {
  setupComplete: 'boolean', pollSeconds: 'number', idleMinutes: 'number',
  'alerts.notify': 'boolean', 'alerts.sound': ['Woof', 'Ding', 'Bleat', 'Silent'], 'alerts.windowFlash': 'boolean',
  'alerts.alertAfterSeconds': 'number', 'alerts.quietHours.enabled': 'boolean',
  'alerts.quietHours.start': 'time', 'alerts.quietHours.end': 'time',
  'alerts.prReview': 'boolean', 'alerts.prApproved': 'boolean', 'alerts.prNudgeHours': 'number',
  'board.density': ['auto', 'comfortable', 'compact'], 'board.showPrs': 'boolean',
  'tickets.pattern': 'regex', 'tickets.link': 'string',
  'github.branches': 'strings', 'github.clientId': 'string',
  'slack.channelId': 'string', 'slack.channelName': 'string', 'slack.reviewing': 'emoji', 'slack.approved': 'emoji',
  'slack.lookbackDays': 'number', 'slack.userId': 'string',
};

function check(type, v, key) {
  const bad = () => { throw new Error(`Invalid value for ${key}`); };
  if (Array.isArray(type)) return type.includes(v) ? v : bad();
  switch (type) {
    case 'boolean': return typeof v === 'boolean' ? v : bad();
    case 'number': return Number.isFinite(v) && v >= 0 && v <= 100000 ? v : bad();
    case 'string': return typeof v === 'string' && v.length <= 500 ? v.trim() : bad();
    case 'time': return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : bad();
    case 'emoji': return typeof v === 'string' && /^[a-z0-9_+'-]{1,60}$/.test(v.replace(/:/g, '')) ? v.replace(/:/g, '') : bad();
    case 'regex': try { new RegExp(v); return v; } catch { return bad(); }
    case 'strings': return Array.isArray(v) && v.length <= 10 && v.every((s) => typeof s === 'string' && /^[\w./-]{1,100}$/.test(s.trim())) ? v.map((s) => s.trim()) : bad();
    default: return bad();
  }
}

/** Apply a flat patch like { 'alerts.sound': 'Ding' } after validating every key. */
export function patchConfig(patch) {
  if (!isObj(patch)) throw new Error('Expected an object');
  const clean = {};
  for (const [key, v] of Object.entries(patch)) {
    if (!(key in EDITABLE)) throw new Error(`Setting ${key} cannot be changed here`);
    clean[key] = check(EDITABLE[key], v, key);
  }
  return updateConfig((c) => {
    for (const [key, v] of Object.entries(clean)) {
      const parts = key.split('.');
      let o = c;
      for (const p of parts.slice(0, -1)) o = o[p];
      o[parts.at(-1)] = v;
    }
  });
}

let runtime = null;
export function getState() {
  if (!runtime) {
    try { runtime = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { runtime = {}; }
  }
  return runtime;
}
let stateTimer = null;
export function saveStateSoon() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => { try { writeSecure(STATE_FILE, runtime || {}); } catch {} }, 1000);
}
