// Sheepdog server: watches coding agents (Claude Code, Codex) on this computer and on SSH hosts,
// plus PR reviews from a Slack channel and branch status from GitHub, and serves the board UI.
// Listens on 127.0.0.1 only. Settings: ~/.config/sheepdog/config.json.
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getConfig, publicConfig, patchConfig, updateConfig, resetConfig, CONFIG_DIR, reviewSource, getState, saveStateSoon } from './config.mjs';
import { ghReviews, refreshGithubReviews } from './reviews-github.mjs';
import * as herder from './herder.mjs';
import { hostState, pollAllHosts, testHost, sshConfigHosts, validSshTarget, NO_PYTHON } from './hosts.mjs';
import { updateTabTargets, focusAgent, isFocusable, terminalsInstalled, requestAutomation, cmuxSocketMode, cmuxBlocks, CMUX_FIX, CMUX_BIN, listTabs, linkTab, focusVia, canReply, readScreen, sendToAgent } from './terminal.mjs';
import * as gh from './github.mjs';
import * as sl from './slack.mjs';
import * as history from './history.mjs';
import { suggest as suggestTickets } from './tickets.mjs';
import { DEFAULTS } from './config.mjs';
import { log, loop, run } from './util.mjs';

// SHEEPDOG_PORT=0 picks a free port (the Mac app does this) and reports it on stdout.
let PORT = Number(process.env.SHEEPDOG_PORT ?? 4848);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/sounds.js': 'sounds.js', '/icon.svg': 'icon.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// ---------------------------------------------------------------- state for the board
let cmuxBlocked = false;
setInterval(async () => { cmuxBlocked = cmuxBlocks(await cmuxSocketMode().catch(() => null)); }, 30e3).unref?.();
cmuxSocketMode().then((m) => { cmuxBlocked = cmuxBlocks(m); }, () => {});

// "Use RV- tickets and link them to Jira?": only what would change, and only while the defaults are in place
let ticketCache = { at: 0, value: null };
function ticketSuggestion() {
  const t = getConfig().tickets;
  if (t.suggestDismissed) return null;
  if (Date.now() - ticketCache.at < 60e3) return ticketCache.value;
  // each PR once: history has every PR seen; the sidebar's are usually in it already
  const r = reviewsNow();
  const s = suggestTickets([...new Set([...history.prTitles(), ...r.prs.map((p) => p.title)])], r.ticketLinks || []);
  let value = null;
  if (s) {
    const pattern = t.pattern === DEFAULTS.tickets.pattern && s.pattern !== t.pattern ? s.pattern : null;
    const link = !t.link && s.link ? s.link : null;
    if (pattern || link) value = { pattern, link, prefixes: s.prefixes, prs: s.prs };
  }
  ticketCache = { at: Date.now(), value };
  return value;
}

// The review sidebar: the Slack channel, or GitHub's open PRs (Settings › Board › Review sidebar).
function reviewsNow(c = getConfig()) {
  if (reviewSource(c) === 'github') {
    return { source: 'github', ready: c.github.auth !== 'none' && c.github.repos.length > 0, label: 'Pull requests', where: `${c.github.repos.length} repo${c.github.repos.length === 1 ? '' : 's'}`,
      ok: ghReviews.ok, at: ghReviews.at, error: ghReviews.error, prs: ghReviews.prs, ticketLinks: ghReviews.ticketLinks };
  }
  return { source: 'slack', ready: !!c.slack.token && !!c.slack.channelId, connected: !!c.slack.token, label: c.slack.channelName ? `#${c.slack.channelName}` : 'PR reviews',
    where: c.slack.channelName ? `#${c.slack.channelName}` : '', ok: sl.slack.ok, at: sl.slack.at, error: sl.slack.error, prs: sl.slack.prs, ticketLinks: sl.slack.ticketLinks };
}
// who "you" are in review history: your Slack member, or your GitHub login with GitHub as the source
const reviewMe = (c = getConfig()) => (reviewSource(c) === 'github' ? (c.github.login ? `gh:${c.github.login}` : '') : c.slack.userId);

// Short agent numbers ("agent 3"), so an agent without a ticket can still be named. Each running agent keeps
// its number while it runs (across restarts too); a number is reused once its agent is gone.
function numberAgents(keys) {
  const st = getState();
  const nos = (st.agentNos ||= {});
  let changed = false;
  for (const k of Object.keys(nos)) if (!keys.includes(k)) { delete nos[k]; changed = true; }
  const used = new Set(Object.values(nos));
  for (const k of keys) {
    if (nos[k]) continue;
    let n = 1;
    while (used.has(n)) n++;
    nos[k] = n; used.add(n); changed = true;
  }
  if (changed) saveStateSoon();
  return nos;
}

function boardState() {
  const c = getConfig();
  const hosts = c.hosts.map((h) => {
    const s = hostState.get(h.id) || {};
    const agents = (s.agents || []).map((a) => ({ ...a, focusable: !!a.pid && isFocusable(`${h.id}:${a.pid}`), focusVia: a.pid ? focusVia(`${h.id}:${a.pid}`) : null, canReply: !!a.pid && canReply(`${h.id}:${a.pid}`) }));
    return { id: h.id, name: h.name, type: h.type, enabled: h.enabled, ok: !!s.ok, at: s.at || 0, error: s.error || null, fix: s.fix || null,
      hostname: s.host, ncpu: s.ncpu, load: s.load, mem: s.mem, disk: s.disk, now: s.now, agents };
  });
  // number the agents people see (not sub-agents or headless runs); hosts that are down keep their numbers
  const shown = (h) => h.agents.filter((a) => a.pid && !a.parent && !a.headless);
  const down = new Set(c.hosts.filter((h) => !(hostState.get(h.id) || {}).ok).map((h) => `${h.id}:`));
  const keep = Object.keys(getState().agentNos || {}).filter((k) => [...down].some((d) => k.startsWith(d)));
  const nos = numberAgents([...keep, ...hosts.flatMap((h) => shown(h).map((a) => `${h.id}:${a.pid}`))]);
  for (const h of hosts) for (const a of shown(h)) a.no = nos[`${h.id}:${a.pid}`];
  return {
    now: Date.now(), setupComplete: c.setupComplete, hosts,
    github: { connected: c.github.auth !== 'none', ok: gh.github.ok, at: gh.github.at, error: gh.github.error, viewer: gh.github.viewer,
      branchNames: c.github.branches, branches: gh.github.branches },
    slack: { connected: !!c.slack.token, channel: c.slack.channelName, ok: sl.slack.ok, at: sl.slack.at, error: sl.slack.error, prs: sl.slack.prs },
    reviews: (({ ticketLinks, ...r }) => r)(reviewsNow(c)),
    herder: { rev: herder.revision() },
    events: sl.prEvents,
    cmuxBlocked,
    today: c.board.showToday ? history.today(reviewMe(c)) : null,
    settings: { idleMinutes: c.idleMinutes, alerts: c.alerts, board: c.board, ticketLink: c.tickets.link },
    ticketSuggestion: ticketSuggestion(),
  };
}

// what Herder sees: the board's agents (not sub-agents or headless runs) and the review sidebar's PRs
function herderAgents() {
  const c = getConfig();
  const out = [];
  for (const h of boardState().hosts) for (const a of h.agents) {
    if (a.headless || a.parent || !a.pid) continue;
    const key = `${h.id}:${a.pid}`;
    const since = a.stateSince || a.lastActivity || a.started || h.now || Date.now() / 1000;
    const minutes = Math.max(0, Math.round((Date.now() / 1000 - since) / 60));
    const state = a.state === 'working' ? 'working' : minutes >= c.idleMinutes ? 'idle' : 'your_turn';
    out.push({ id: a.ticket || `agent ${a.no}`, key, agent_no: a.no, ticket: a.ticket || null, title: a.title || null, machine: h.name, kind: a.kind, state, minutes_in_state: minutes,
      repo: a.repo || null, last_prompt: a.prompt || null, can_read_chat: !!a.canReply });
  }
  return out;
}
herder.useAgents(herderAgents);
setInterval(() => { try { herder.observe(herderAgents()); } catch (e) { log('herder observe:', e.message); } }, 3000).unref?.();
herder.usePrs(() => reviewsNow().prs.map((p) => ({ pr: `${p.repo}#${p.number}`, title: p.title, author: p.poster || p.author, yours: p.yours,
  posted_minutes_ago: Math.round((Date.now() - p.postedAt) / 60e3), reviewers: p.reviewers.map((r) => r.name), asked: p.asked || [], url: p.url })));

// ---------------------------------------------------------------- routes
const routes = {
  'GET /api/state': () => boardState(),
  'GET /api/config': () => publicConfig(),
  'POST /api/config': (b) => { patchConfig(b); ticketCache.at = 0; if ('reviews.source' in b) { refreshGithubReviews(); sl.refreshSlack(); } return publicConfig(); },
  'POST /api/reset': async () => { await sl.disconnect(); resetConfig(); gh.disconnect(); return publicConfig(); },

  // statistics
  'GET /api/stats': (_, q) => history.stats(Number(q.get('days')) || 7),
  'GET /api/leaderboard': (_, q) => history.leaderboard(Number(q.get('days')) || 7, reviewMe()),
  'POST /api/stats/clear': () => { history.clear(); return { ok: true }; },

  // machines
  'GET /api/detect': async () => {
    const local = await testHost({ type: 'local' });
    const mode = await cmuxSocketMode();
    return { local, terminals: terminalsInstalled(), cmux: { mode, blocked: cmuxBlocks(mode), fix: CMUX_FIX }, gh: await gh.ghInstalled(), sshHosts: sshConfigHosts(), platform: process.platform };
  },
  'GET /api/ssh-hosts': () => sshConfigHosts(),
  'POST /api/hosts/test': async (b) => {
    const h = b.id ? getConfig().hosts.find((x) => x.id === b.id) : { type: 'ssh', ssh: b.ssh };
    if (!h) throw new Error('Unknown host');
    if (h.type === 'ssh' && !validSshTarget(h.ssh)) throw new Error('Use an alias from ~/.ssh/config or user@host');
    return testHost(h);
  },
  'POST /api/hosts/add': (b) => {
    if (!validSshTarget(b.ssh)) throw new Error('Use an alias from ~/.ssh/config or user@host');
    const c = updateConfig((cfg) => {
      if (cfg.hosts.some((h) => h.ssh === b.ssh)) return;
      const id = `ssh-${b.ssh.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()}`;
      cfg.hosts.push({ id, name: String(b.name || b.ssh).slice(0, 40), type: 'ssh', ssh: b.ssh, enabled: true });
    });
    refreshHosts();
    return c.hosts;
  },
  'POST /api/hosts/update': (b) => {
    const c = updateConfig((cfg) => {
      const h = cfg.hosts.find((x) => x.id === b.id);
      if (!h) throw new Error('Unknown host');
      if (typeof b.enabled === 'boolean') h.enabled = b.enabled;
      if (typeof b.name === 'string' && b.name.trim()) h.name = b.name.trim().slice(0, 40);
    });
    refreshHosts();
    return c.hosts;
  },
  'POST /api/hosts/remove': (b) => {
    if (b.id === 'local') throw new Error('This computer can be paused, not removed');
    const c = updateConfig((cfg) => { cfg.hosts = cfg.hosts.filter((h) => h.id !== b.id); });
    refreshHosts();
    return c.hosts;
  },

  // access: everything Sheepdog needs permission for, in one checklist (Settings › Access, setup wizard)
  'GET /api/access': async () => {
    const c = getConfig();
    const local = c.hosts.find((h) => h.type === 'local');
    const ls = hostState.get('local') || {};
    const term = terminalsInstalled();
    const mode = await cmuxSocketMode();
    let cmuxOk = null;
    if (term.cmux && !cmuxBlocks(mode)) cmuxOk = await requestAutomation('cmux').then((r) => (r.ok ? true : r.error));
    return {
      python: { enabled: !!local?.enabled, ok: !!ls.ok, error: ls.ok ? null : ls.error || null, needsTools: ls.error === NO_PYTHON },
      cmux: { installed: term.cmux, mode, blocked: cmuxBlocks(mode), ok: cmuxOk === true, error: cmuxOk === true ? null : cmuxOk },
      iterm: { installed: term.iterm },
      machines: c.hosts.filter((h) => h.type === 'ssh').map((h) => {
        const s = hostState.get(h.id) || {};
        return { id: h.id, name: h.name, ssh: h.ssh, enabled: h.enabled, ok: !!s.ok, error: s.ok ? null : s.error || null, fix: s.ok ? null : s.fix || null };
      }),
      slack: { connected: !!c.slack.token, channel: c.slack.channelName, ok: sl.slack.ok, error: sl.slack.error, bot: !!c.slack.token && !/^(xoxe\.)?xoxp-/.test(c.slack.token), me: !!c.slack.userId },
      github: { connected: c.github.auth !== 'none', ok: gh.github.ok, error: gh.github.error },
    };
  },
  // open the right settings page (macOS), or start an install
  'POST /api/access/open': async (b) => {
    const urls = {
      automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
      notifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    };
    if (process.platform !== 'darwin') throw new Error('Only on macOS');
    if (urls[b.what]) { await run('open', [urls[b.what]]); return { ok: true }; }
    if (b.what === 'cmux-settings') {
      // goes straight to Settings › Automation when cmux already lets Sheepdog in; otherwise just opens cmux
      const direct = await run(CMUX_BIN, ['settings', 'open', 'automation'], { timeout: 8000 }).then(() => true, () => false);
      if (!direct) await run('open', ['-a', 'cmux']);
      return { ok: true, direct };
    }
    if (b.what === 'python') { await run('xcode-select', ['--install']).catch(() => {}); return { ok: true }; }
    throw new Error('Unknown setting');
  },

  // terminal
  'GET /api/tabs': () => listTabs(),
  'POST /api/focus/link': (b) => {
    if (!/^[\w.-]+:\d+$/.test(b.key || '') || typeof b.id !== 'string' || b.id.length > 200) throw new Error('bad request');
    return linkTab(b.key, b.id);
  },
  'POST /api/focus': (b) => (/^[\w.-]+:\d+$/.test(b.key || '') ? focusAgent(b.key) : { ok: false, error: 'bad key' }),
  'GET /api/herder': () => herder.state(),
  'POST /api/herder/chat': async (b) => {
    // without a key, "RV-123 do X" still goes straight to that agent
    if (!getConfig().herder.key) {
      const sent = await herder.direct(b.text);
      if (sent) return sent;
      throw new Error('Start with an agent’s ticket or number (RV-123 run the tests, agent 3 run the tests), or connect a model in Settings › Herder to ask Herder anything.');
    }
    return herder.chat(b.text);
  },
  'POST /api/herder/confirm': (b) => herder.confirm(String(b.id || ''), !!b.ok),
  'POST /api/herder/reset': () => herder.reset(),
  'POST /api/herder/key': (b) => herder.setKey(b.key, { provider: b.provider === 'openai' ? 'openai' : 'anthropic', baseUrl: b.baseUrl }),
  'GET /api/herder/models': () => herder.listModels(),
  'POST /api/herder/key/clear': () => herder.clearKey(),
  'GET /api/screen': (_, q) => { const key = q.get('key') || ''; if (!/^[\w.-]+:\d+$/.test(key)) throw new Error('bad key'); return readScreen(key, Number(q.get('lines')) || 40); },
  'POST /api/send': (b) => { if (!/^[\w.-]+:\d+$/.test(b.key || '')) throw new Error('bad key'); return sendToAgent(b.key, { text: b.text, press: b.press, enter: b.enter !== false }); },
  'POST /api/terminal/allow': (b) => requestAutomation(b.app),
  'GET /api/terminal/cmux': async () => { const mode = await cmuxSocketMode(); return { mode, blocked: cmuxBlocks(mode), fix: CMUX_FIX }; },
  'POST /api/terminal/cmux-password': (b) => {
    if (typeof b.password !== 'string' || b.password.length > 200) throw new Error('Invalid password');
    updateConfig((c) => { c.terminal.cmuxPassword = b.password.trim(); });
    return { ok: true };
  },

  // github
  'GET /api/github/status': async () => {
    const c = getConfig().github;
    let me = null, error = null;
    if (c.auth !== 'none') { try { me = await gh.whoAmI(); } catch (e) { error = e.message; } }
    return { auth: c.auth, login: me?.login || c.login, scopes: me?.scopes, error, cli: await gh.ghInstalled(),
      deviceAvailable: !!(c.clientId || gh.DEVICE_CLIENT_ID), repos: c.repos, branches: c.branches };
  },
  'POST /api/github/token': async (b) => { const me = await gh.connectWithToken(b.token); gh.refreshGithub(); sl.refreshSlack(); return me; },
  'POST /api/github/use-cli': async () => { const me = await gh.connectWithGhCli(); gh.refreshGithub(); sl.refreshSlack(); return me; },
  'POST /api/github/device/start': () => gh.deviceStart(),
  'GET /api/github/device/status': () => gh.deviceStatus(),
  'POST /api/github/device/cancel': () => { gh.deviceCancel(); return { ok: true }; },
  'POST /api/github/disconnect': () => { gh.disconnect(); return { ok: true }; },
  'GET /api/github/repos': (_, q) => gh.listRepos(q.get('q') || ''),
  'POST /api/github/repos/validate': (b) => gh.validateRepo(b.repo),
  'POST /api/github/repos': (b) => {
    if (!Array.isArray(b.repos)) throw new Error('Expected repos');
    const repos = gh.setRepos(b.repos);
    if (reviewSource() === 'github') refreshGithubReviews();
    return { repos };
  },

  // slack
  'GET /api/slack/status': () => {
    const s = getConfig().slack;
    return { connected: !!s.token, team: s.team, user: s.user, userId: s.userId, kind: /^(xoxe\.)?xoxp-/.test(s.token) ? 'user' : s.token ? 'bot' : null,
      channelId: s.channelId, channelName: s.channelName, reviewing: s.reviewing, approved: s.approved, manifestUrl: sl.manifestUrl(), manifestUrlBot: sl.manifestUrl('bot'),
      error: sl.slack.error, prCount: sl.slack.prs.length };
  },
  'POST /api/slack/token': async (b) => sl.connect(b.token),
  // keepIdentity: switching tokens (e.g. to the team bot), so remember who you are
  'POST /api/slack/disconnect': async (b) => { await sl.disconnect({ keepIdentity: !!b.keepIdentity }); return { ok: true }; },
  'GET /api/slack/channels': (_, q) => sl.listChannels(q.get('q') || ''),
  'GET /api/slack/members': (_, q) => sl.listMembers(q.get('q') || ''),
  'POST /api/slack/me': async (b) => { const me = await sl.setMe(b.id); sl.refreshSlack(); return me; },
  'POST /api/slack/channel': async (b) => {
    if (!/^[CG][A-Z0-9]{4,20}$/.test(b.id || '')) throw new Error('Invalid channel');
    updateConfig((c) => { c.slack.channelId = b.id; c.slack.channelName = String(b.name || '').slice(0, 80); });
    await sl.refreshSlack();
    return { ok: sl.slack.ok, error: sl.slack.error, prCount: sl.slack.prs.length };
  },
};

// ---------------------------------------------------------------- http
// Only this computer, only through our own page: the Host header must be ours (stops DNS rebinding)
// and any write must come from our origin as JSON (stops other websites posting to us).
function allowed(req) {
  const hostOk = new RegExp(`^(127\\.0\\.0\\.1|localhost):${PORT}$`).test(req.headers.host || '');
  if (!hostOk) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && !new RegExp(`^http://(127\\.0\\.0\\.1|localhost):${PORT}$`).test(origin)) return false;
  return (req.headers['content-type'] || '').startsWith('application/json');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

async function handler(req, res) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (!allowed(req)) { res.writeHead(403, headers).end('Forbidden'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const file = req.method === 'GET' && STATIC[url.pathname];
  if (file) {
    try {
      const buf = await readFile(path.join(PUBLIC, file));
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)],
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" }).end(buf);
    } catch { res.writeHead(500, headers).end(); }
    return;
  }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) { res.writeHead(404, headers).end('Not found'); return; }
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const out = await route(body, url.searchParams);
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(out ?? { ok: true }));
  } catch (e) {
    log(`${req.method} ${url.pathname}: ${e.message}`); // message only; request bodies can hold tokens
    res.writeHead(400, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
  }
}

let refreshHosts = () => {};
// Inside the Mac app, stdin is a pipe from the app: when the app goes away (even if it crashes), so do we.
if (process.env.SHEEPDOG_APP) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.resume();
}
const server = http.createServer(handler);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} is in use. Is Sheepdog already running? Set SHEEPDOG_PORT to use another.`); process.exit(1); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  PORT = server.address().port;
  log(`Sheepdog on http://127.0.0.1:${PORT}  (settings in ${CONFIG_DIR})`);
  if (process.env.SHEEPDOG_APP) console.log(`SHEEPDOG_READY port=${PORT}`);
  refreshHosts = loop(async () => { await pollAllHosts(); history.observe(hostState); }, () => Math.max(1, getConfig().pollSeconds) * 1000);
  setTimeout(() => loop(() => history.sample(hostState), history.SAMPLE_SECONDS * 1000), 15000); // after the first polls
  loop(history.prune, 6 * 3600e3);
  loop(updateTabTargets, 4000);
  loop(gh.refreshGithub, 60000);
  loop(sl.refreshSlack, 10000);
  loop(() => (reviewSource() === 'github' ? refreshGithubReviews() : null), 30000);
});
