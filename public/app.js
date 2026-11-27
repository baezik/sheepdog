// Sheepdog board, settings and setup wizard. Plain JS, no build step.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Inside the Mac app the page runs in a WKWebView with a "sheepdog" message handler: notifications,
// the menu bar bark and permissions go through the app instead of the browser.
const NATIVE = window.webkit?.messageHandlers?.sheepdog || null;
const native = (msg) => { try { NATIVE?.postMessage(msg); } catch {} };
window.sheepdogNative = { notif: 'unknown', setNotif(s) { this.notif = s; rerender(); }, open(route) { route_(route); } };
// agent kinds Sheepdog recognizes, as shown to people
const KINDS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', agy: 'Antigravity' };
const kindName = (k) => KINDS[k] || k || 'Agent';
// a command that fixes a problem, with a Copy button
const fixHtml = (cmd) => (cmd ? ` <span class="fix"><code>${esc(cmd)}</code><button class="btn solid" data-act="copy" data-text="${esc(cmd)}" data-stop="1">Copy</button></span>` : '');
const get = (o, key) => key.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = 'toast'), err ? 4000 : 2200);
}

function dur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 10 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
const agoMs = (ms) => `${dur((Date.now() - ms) / 1000)} ago`;
const fmtTokens = (n) => (n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
function clock(ms) {
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday ${t}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

// ---------------------------------------------------------------- app state
let S = null;            // /api/state
let cfg = null;          // /api/config (secrets redacted)
const UI = { prFilter: 'all', pane: 'pastures', hostTest: {}, sshHosts: null, newHost: '', statsDays: 7, stats: null, statsAt: 0, statsErr: '', lbDays: 7, lb: null, lbAt: 0, lbErr: '' };
const GH = { status: null, busy: '', err: '', device: null, suggestions: null, query: '' };
const SL = { status: null, busy: '', err: '', channels: null, query: '', members: null, meQuery: '' };
const WZ = { step: 0, detect: null, selected: null, results: {} };

async function loadConfig() { cfg = await api('/api/config'); }
async function setConfig(patch) {
  try { cfg = await api('/api/config', patch); poll(true); } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- header
function hostStats(h) {
  if (!h.enabled) return '';
  const fresh = h.ok && Date.now() - h.at < 20000;
  if (!h.ncpu) return `<div class="host" title="${esc(h.error || 'connecting…')}"><span class="dot ${h.error ? 'down' : 'off'}"></span><b>${esc(h.name)}</b>${h.error ? 'offline' : 'connecting…'}</div>`;
  const load = (h.load || [0])[0];
  const cpu = Math.min(100, Math.round((100 * load) / h.ncpu));
  const queue = Math.max(0, Math.round(load - h.ncpu));
  const pct = (x) => (x && x.total ? Math.round((100 * x.used) / x.total) : null);
  const ram = pct(h.mem), disk = pct(h.disk);
  const hotCpu = cpu >= 90, hotQ = queue >= 4;
  return `<div class="host" title="${esc(h.hostname || '')}${fresh ? '' : ` · not responding: ${esc(h.error || '')}`}">
    <span class="dot ${fresh ? '' : 'down'}"></span><b>${esc(h.name)}</b>
    <span class="meter ${hotCpu ? 'hot' : ''}"><i style="width:${cpu}%"></i></span>
    <span class="${hotCpu ? 'hot' : ''}">${cpu}%</span>
    <span class="${hotQ ? 'hot' : ''}" title="Runnable work beyond the CPU count (load average minus cores)">⧗ ${queue}</span>
    ${ram != null ? `<span class="${ram >= 95 ? 'hot' : ''}">RAM ${ram}%</span>` : ''}
    ${disk != null ? `<span class="${disk >= 95 ? 'hot' : ''}">Disk ${disk}%</span>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- agents
function agentsOf(s) {
  const out = [];
  const idleAfter = s.settings.idleMinutes * 60;
  for (const h of s.hosts) {
    if (!h.enabled) continue;
    const nowSec = h.now || s.now / 1000;
    for (const a of h.agents || []) {
      if (a.headless || a.parent) continue; // sub-agents and headless runs never wait on you
      const since = a.stateSince || a.lastActivity || a.started || nowSec;
      const waited = Math.max(0, nowSec - since);
      const status = a.state === 'working' ? 'working' : waited >= idleAfter ? 'idle' : 'turn';
      out.push({ ...a, hostName: h.name, status, since: waited, key: `${h.id}:${a.sessionId || a.pid}`, focusKey: a.pid ? `${h.id}:${a.pid}` : '' });
    }
  }
  const rank = { turn: 0, working: 1, idle: 2 };
  out.sort((x, y) => rank[x.status] - rank[y.status] || (x.status === 'working' ? x.since - y.since : y.since - x.since));
  return out;
}

function ticketHtml(t) {
  if (!t) return '';
  const link = S.settings.ticketLink;
  return link && link.includes('{id}')
    ? `<a class="tk" href="${esc(link.replace('{id}', encodeURIComponent(t)))}" target="_blank" rel="noopener" data-stop="1">${esc(t)}</a>`
    : `<span class="tk">${esc(t)}</span>`;
}

function card(a) {
  const label = { turn: 'Your turn', working: 'Working', idle: 'Idle' }[a.status];
  const title = a.title || a.prompt || `${kindName(a.kind)} in ${a.repo || '?'}`;
  const tok = fmtTokens(a.tokens);
  const ctx = tok ? `<div class="ctx"><span>${tok} tokens</span></div>` : '';
  return `<div class="card ${a.status} ${a.focusable ? '' : 'nofocus'}" data-act="focus" data-key="${esc(a.focusKey)}" data-ok="${a.focusable ? 1 : 0}" data-title="${esc(title)}"
      title="${esc(a.where || '')}${a.focusable ? ' · click to open its terminal tab (⌥-click if it opens the wrong one)' : a.focusKey ? ' · click to tell Sheepdog which tab it’s in' : ''}">
    <div class="band"><span>${a.no ? `<span class="ano" title="Agent ${a.no}: tell Herder “agent ${a.no} …”">${a.no}</span>` : ''}${label}</span>${a.canReply ? `<button class="reply" data-act="reply" data-key="${esc(a.focusKey)}" data-title="${esc(title)}" title="See what it’s asking and answer here">↩ Answer</button>` : ''}<span>${dur(a.since)}</span></div>
    <div class="body">
      <div class="title">${ticketHtml(a.ticket)}<span>${esc(title)}</span></div>
      ${a.prompt && a.prompt !== title ? `<div class="prompt">${esc(a.prompt)}</div>` : ''}
      <div class="meta"><span class="chip host">${esc(a.hostName)}</span><span class="chip">${kindName(a.kind)}${a.app ? ' app' : ''}</span>${a.repo ? `<span class="repo">${esc(a.repo)}</span>` : ''}</div>
      ${ctx}
    </div>
  </div>`;
}

function renderBoard() {
  const agents = agentsOf(S);
  const board = $('board');
  const down = S.hosts.filter((h) => h.enabled && h.error && !h.ok);
  let banner = down.length ? `<div class="banner">Can't reach ${down.map((h) => `<b>${esc(h.name)}</b>`).join(', ')}: ${esc(down[0].error)}${fixHtml(down[0].fix)} <a href="#" data-act="settings" data-pane="access">Check access…</a></div>` : '';
  banner += ticketSuggestionHtml('board');
  if (S.cmuxBlocked) banner += `<div class="banner info">cmux isn’t letting Sheepdog switch tabs yet. <a href="#" data-act="settings" data-pane="access">How to fix…</a></div>`;
  if (!agents.length) {
    board.innerHTML = `${banner}<div class="empty"><div class="pic"><img src="/icon.svg" alt="" width="64" height="64"></div><b>No agents running.</b><div>Start Claude Code, Codex, Gemini CLI or Antigravity (agy)<br>on a watched machine and it will appear here.</div></div>`;
  } else {
    const d = S.settings.board.density;
    const compact = d === 'compact' || (d === 'auto' && agents.length > 10);
    board.innerHTML = `${banner}<div class="grid ${compact ? 'compact' : ''}">${agents.map(card).join('')}</div>`;
  }
  alertOn(agents);
}

// ---------------------------------------------------------------- alerts
const alerted = new Set();
let firstAlertPass = true;
function inQuietHours(q) {
  if (!q.enabled) return false;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = q.start.split(':').map(Number), [eh, em] = q.end.split(':').map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}
function alertOn(agents) {
  const al = S.settings.alerts;
  const turn = agents.filter((a) => a.status === 'turn');
  const live = new Set(turn.map((a) => a.key));
  for (const k of [...alerted]) if (!live.has(k)) alerted.delete(k);
  const fresh = turn.filter((a) => !alerted.has(a.key) && a.since >= al.alertAfterSeconds);
  fresh.forEach((a) => alerted.add(a.key));
  const n = turn.length;
  document.title = n ? `(${n}) Sheepdog` : 'Sheepdog';
  if (firstAlertPass) { firstAlertPass = false; return; }
  if (!fresh.length || inQuietHours(al.quietHours)) return;
  if (al.windowFlash) { document.body.classList.remove('pulse'); void document.body.offsetWidth; document.body.classList.add('pulse'); }
  if (al.sound !== 'Silent') window.SheepdogSounds.play(al.sound);
  native({ type: 'bark' });
  if (NATIVE) {
    if (al.notify) for (const a of fresh.slice(0, 3)) {
      native({ type: 'notify', title: `${a.title || 'An agent'} is waiting`, body: `${a.hostName} · ${kindName(a.kind)}${a.prompt ? ` — ${a.prompt}` : ''}`, id: a.key, focusKey: a.focusable ? a.focusKey : '' });
    }
  } else if (al.notify && 'Notification' in window && Notification.permission === 'granted') {
    for (const a of fresh.slice(0, 3)) {
      const n2 = new Notification(`${a.title || 'An agent'} is waiting`, { body: `${a.hostName} · ${kindName(a.kind)}${a.prompt ? ` — ${a.prompt}` : ''}`, tag: a.key });
      n2.onclick = () => { window.focus(); if (a.focusable) focusAgent(a.focusKey); n2.close(); };
    }
  }
}

// PR alerts come from the server (review started, approved, no reviewer for hours); show the ones not seen yet
let lastPrEvent = null;
function prAlerts(events) {
  if (!events) return;
  const newest = events.length ? events.at(-1).id : 0;
  if (lastPrEvent === null) { lastPrEvent = newest; return; } // don't replay what happened before the page opened
  const fresh = events.filter((e) => e.id > lastPrEvent);
  if (!fresh.length) return;
  lastPrEvent = newest;
  const al = S.settings.alerts;
  if (inQuietHours(al.quietHours)) return;
  if (al.sound !== 'Silent') window.SheepdogSounds.play(al.sound); // the sound picked in Settings, like agent alerts
  if (!al.notify) return;
  for (const e of fresh.slice(-3)) {
    if (NATIVE) native({ type: 'notify', title: e.title, body: e.body, id: `pr-${e.id}`, focusKey: '', url: e.url });
    else if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(e.title, { body: e.body, tag: `pr-${e.id}` });
      n.onclick = () => { window.open(e.url, '_blank', 'noopener'); n.close(); };
    }
  }
}

async function openTabPicker(key, title) {
  UI.tabKey = key;
  closeAll();
  $('tabScrim').hidden = false;
  $('tabBody').innerHTML = '<div class="note"><span class="spin"></span> Looking at your terminal tabs…</div>';
  let tabs = [];
  try { tabs = await api('/api/tabs'); } catch (e) { toast(e.message, true); }
  const app = { cmux: 'cmux', iterm: 'iTerm2' };
  $('tabBody').innerHTML = `<div class="note">Sheepdog couldn’t tell which tab ${title ? `“${esc(title)}”` : 'this agent'} runs in (this happens with tmux, or when the tab’s title doesn’t mention the agent). Pick it once and Sheepdog remembers it while the agent runs. ⌥-click a card later to change it.</div>
    ${tabs.length ? `<div class="tablist">${tabs.map((t) => `<button data-act="tab-pick" data-id="${esc(t.id)}"><span class="tl">${esc(t.title || 'Untitled tab')}</span><span class="tp">${esc([app[t.app], t.place].filter(Boolean).join(' · '))}</span></button>`).join('')}</div>`
      : `<div class="banner">No terminal tabs found. Is cmux or iTerm2 open, and does Sheepdog have access? <a href="#" data-act="settings" data-pane="access">Check access…</a></div>`}`;
}

// ---------------------------------------------------------------- Herder
// A chat with the orchestrator, nothing else. Herder posts there when an agent starts waiting (ticket, what it
// asks, buttons to answer or open its tab); ticket IDs in its replies are chips you can click. The panel opens
// by itself when an agent starts waiting; closed, it's a floating button at the bottom right.
const HD = { open: false, closedFor: '', state: null, rev: -1, sending: false };
const turnAgents = () => (S ? agentsOf(S).filter((a) => a.status === 'turn' && a.focusKey) : []);
const turnSig = () => turnAgents().map((a) => a.focusKey).sort().join(',');

function renderHerder() {
  const waiting = turnAgents();
  const n = waiting.length ? String(waiting.length) : '';
  $('herderCount').textContent = n;
  $('herderFabN').textContent = n;
  const sig = turnSig();
  // a new agent waiting opens the panel; closing it keeps it closed until another agent starts waiting
  if (S.settings.board.herder && waiting.length && !HD.open && !sig.split(',').every((k) => HD.closedFor.split(',').includes(k))) HD.open = true;
  // a hidden panel loses its scroll position: when it opens again, draw it fresh at the newest message
  if (HD.open && $('herder').hidden) { HD.html = ''; HD.count = 0; }
  $('herder').hidden = !HD.open;
  $('herderFab').hidden = HD.open;
  $('herderFab').classList.toggle('waiting', !!waiting.length);
  $('herderBtn').classList.toggle('on', HD.open);
  $('herderSub').textContent = waiting.length ? `${waiting.length} waiting on you` : 'nothing waiting';
  const rev = S.herder?.rev ?? 0;
  if (HD.open && rev !== HD.rev && !HD.sending) {
    HD.rev = rev;
    api('/api/herder').then((st) => { HD.state = st; renderHerderLog(); }).catch(() => {});
  } else if (HD.open) renderHerderLog(); // agent states (chip colours) change without the chat changing
}

// agents by ticket, for chips: the one waiting on you wins when a ticket has several
function agentByTicket() {
  const m = new Map();
  const rank = { turn: 0, working: 1, idle: 2 };
  for (const a of S ? agentsOf(S) : []) {
    if (!a.ticket || !a.focusKey) continue;
    const t = a.ticket.toUpperCase();
    if (!m.has(t) || rank[a.status] < rank[m.get(t).status]) m.set(t, a);
  }
  return m;
}
const chip = (a, label) => `<button class="tchip ${a.status}" data-act="tchip" data-key="${esc(a.focusKey)}" data-title="${esc(a.title || '')}" data-reply="${a.canReply ? 1 : 0}" title="${esc(`${a.title || ''} · ${a.hostName} · ${{ turn: 'waiting on you', working: 'working', idle: 'idle' }[a.status]}`)}"><i></i>${esc(label)}</button>`;
function richText(text) {
  const byT = agentByTicket();
  const byNo = new Map((S ? agentsOf(S) : []).filter((a) => a.no && a.focusKey).map((a) => [a.no, a]));
  let h = esc(text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
  // ticket IDs and "agent 3" of known agents become chips
  h = h.replace(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g, (m) => (byT.has(m) ? chip(byT.get(m), m) : m));
  return h.replace(/\b[Aa]gent #?(\d{1,4})\b/g, (m, n) => (byNo.has(Number(n)) ? chip(byNo.get(Number(n)), `agent ${n}`) : m));
}

function renderHerderLog() {
  const st = HD.state;
  const box = $('herderLog');
  if (!st) { box.innerHTML = ''; HD.html = ''; return; }
  const byKey = new Map((S ? agentsOf(S) : []).map((a) => [a.focusKey, a]));
  let html = '';
  if (!st.log.length) html += `<div class="hd-empty"><img src="/icon.svg" alt="" width="40" height="40"><b>Herder</b><span>I’ll tell you here when an agent needs you.${st.configured ? ' Ask me anything about your agents, or tell one what to do (by ticket, or “agent 3”).' : ` Type <b>RV-123</b> or <b>agent 3</b> and a message to send it to that agent. To ask me questions, connect a model in <a href="#" data-act="settings" data-pane="herder">Settings › Herder</a>.`}</span></div>`;
  for (const m of st.log) {
    if (m.role === 'you') { html += `<div class="hm you">${esc(m.text)}</div>`; continue; }
    if (m.role === 'note') { html += `<div class="hm note">${esc(m.text)}</div>`; continue; }
    if (m.wait) {
      const w = m.wait;
      const a = byKey.get(w.key);
      const tag = w.ticket || (w.no ? `agent ${w.no}` : '');
      const name = tag ? (a ? chip(a, tag) : `<span class="tchip"><i></i>${esc(tag)}</span>`) : '';
      html += `<div class="hm herder wait ${w.done ? 'done' : ''}"><span class="hd-ico"><img src="/icon.svg" alt=""></span><div class="hw">
        <div class="hw-head">${name}<b>${esc(w.title || 'An agent')}</b><span>${esc([w.machine, kindName(w.kind)].filter(Boolean).join(' · '))}</span></div>
        <div class="hw-q">${w.done ? '✓ Answered' : m.text ? richText(m.text) : 'is waiting for you…'}</div>
        ${!w.done && a ? `<div class="hw-acts">${a.canReply ? `<button class="btn" data-act="tchip" data-key="${esc(w.key)}" data-title="${esc(w.title || '')}" data-reply="1">↩ Answer</button>` : ''}<button class="btn" data-act="hd-open" data-key="${esc(w.key)}">Open tab ↗</button></div>` : ''}
      </div></div>`;
      continue;
    }
    html += `<div class="hm herder"><span class="hd-ico"><img src="/icon.svg" alt=""></span><div>${richText(m.text)}</div></div>`;
    for (const sd of m.sends || []) {
      const acts = sd.state === 'pending' ? `<span class="acts"><button class="btn primary" data-act="herder-confirm" data-id="${esc(sd.id)}" data-ok="1">Send</button><button class="btn" data-act="herder-confirm" data-id="${esc(sd.id)}" data-ok="0">Cancel</button></span>`
        : `<span class="hs-state">${sd.state === 'sent' ? '✓ sent' : 'cancelled'}</span>`;
      html += `<div class="hsend ${sd.state}"><div class="hs-to">Message to ${(([t, ...rest]) => `${richText(t)} ${esc(rest.join(' · '))}`)(sd.label.split(' · '))}</div><div class="hs-text">${esc(sd.text)}</div>${acts}</div>`;
    }
  }
  if (HD.sending) html += '<div class="hm note"><span class="spin"></span> Herder is looking…</div>';
  if (HD.html === html) return; // nothing changed: leave the chat (and where you are in it) alone
  HD.html = html;
  // keep your place: follow new messages to the bottom when you were at the bottom (or something was added),
  // otherwise put the scroll back exactly where it was (WebKit can reset it while the content is replaced)
  const sc = $('herderScroll');
  const prev = sc.scrollTop;
  const atBottom = sc.scrollHeight - prev - sc.clientHeight < 40;
  const grew = st.log.length + (HD.sending ? 1 : 0) > (HD.count ?? 0);
  HD.count = st.log.length + (HD.sending ? 1 : 0);
  box.innerHTML = html;
  sc.scrollTop = atBottom || grew ? sc.scrollHeight : prev;
}

async function herderSend() {
  const i = $('herderInput');
  const text = i.value.trim();
  if (!text || HD.sending) return;
  HD.sending = true;
  i.value = '';
  HD.state = HD.state || { log: [] };
  HD.state.log = [...HD.state.log, { role: 'you', text }];
  renderHerderLog();
  try { HD.state = await api('/api/herder/chat', { text }); HD.rev = HD.state.rev; }
  catch (e) { HD.state.log = [...HD.state.log, { role: 'note', text: e.message }]; }
  HD.sending = false;
  renderHerderLog();
  i.focus();
}

// ---------------------------------------------------------------- answering an agent
// Shows the agent's screen (read from its cmux tab, refreshed every second) with quick keys and a reply box.
async function openReply(key, title) {
  closeAll();
  UI.reply = { key, title, text: '' };
  $('replyTitle').textContent = title || 'Agent';
  $('replyScreen').textContent = 'Reading the screen…';
  $('replyScrim').hidden = false;
  await refreshReply(true);
  $('replyInput').value = '';
  $('replyInput').focus();
}
async function refreshReply(first) {
  const r = UI.reply;
  if (!r || $('replyScrim').hidden) return;
  try {
    const { text } = await api(`/api/screen?key=${encodeURIComponent(r.key)}&lines=60`);
    if (text !== r.text) {
      const pre = $('replyScreen');
      const atBottom = first || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
      pre.textContent = text || '(empty screen)';
      r.text = text;
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
  } catch (e) { $('replyScreen').textContent = e.message; }
  clearTimeout(r.timer);
  r.timer = setTimeout(refreshReply, 1000);
}
async function sendReply(body) {
  if (!UI.reply) return;
  try {
    await api('/api/send', { key: UI.reply.key, ...body });
    setTimeout(refreshReply, 250);
  } catch (e) { toast(e.message, true); }
}

async function focusAgent(key) {
  try {
    const r = await api('/api/focus', { key });
    if (!r.ok) toast(r.error || 'Could not open the tab', true);
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- PR sidebar
// The sidebar shows posts: one card per Slack post (usually one ticket), listing its PRs when it has several.
// Counts are of open PRs.
const isActive = (p) => p.status === 'open' && !p.draft;
function postsOf(prs) {
  const byTs = new Map();
  for (const p of prs) {
    const key = p.ts || p.url;
    if (!byTs.has(key)) byTs.set(key, { ts: key, prs: [], postedAt: p.postedAt, yours: p.yours, poster: p.poster, author: p.author, reviewers: p.reviewers, replies: p.replies, link: p.link, asked: p.asked || [], changes: !!p.changes, forYou: !!p.forYou, github: p.link === p.url });
    byTs.get(key).prs.push(p);
  }
  return [...byTs.values()].filter((post) => post.prs.some(isActive)).sort((a, b) => b.postedAt - a.postedAt);
}
const openPrs = (post) => post.prs.filter(isActive).length;

function postItem(post) {
  const prs = post.prs;
  const active = prs.filter(isActive);
  const who = post.yours ? 'you' : (post.poster || post.author || '').split(/\s+/)[0];
  // worst check state among the PRs still open
  const ci = active.some((p) => p.ci === 'fail') ? 'fail' : active.some((p) => p.ci === 'pending') ? 'pending' : active.some((p) => p.ci === 'ok') ? 'ok' : '';
  const reviewing = post.reviewers.length > 0;
  const multi = prs.length > 1;
  const title = (active[0] || prs[0]).title;
  const ciWord = { ok: 'checks passing', pending: 'checks running', fail: 'checks failing' };
  const mark = { approved: '✓ approved', merged: '✓ merged', closed: 'closed' };
  const list = multi ? `<div class="pr-list">${prs.map((p) => `<a class="pr-item ${p.status}" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(`${p.title} · ${ciWord[p.ci] || 'no checks'}`)}">
      <span class="ci ${p.status === 'open' ? p.ci || '' : ''}"></span><span class="repo">${esc(p.repo)} #${p.number}</span>${mark[p.status] ? `<span class="done">${mark[p.status]}</span>` : p.draft ? '<span class="done">draft</span>' : ''}</a>`).join('')}</div>` : '';
  let foot = '';
  if (reviewing || (post.replies && post.link) || post.asked.length) {
    const first = reviewing ? Math.min(...post.reviewers.map((r) => r.since)) : 0;
    const rv = reviewing ? `<span class="pr-rv"><span class="ico">${post.changes ? '✎' : '👀'}</span><span class="names">${esc(post.reviewers.map((r) => r.name).join(', '))} · ${post.changes ? 'changes requested' : `since ${esc(clock(first))}`}</span></span>`
      : post.asked.length ? `<span class="pr-rv asked"><span class="ico">⏳</span><span class="names">asked: ${esc((post.forYou ? ['you', ...post.asked] : post.asked).join(', '))}</span></span>` : '<span></span>';
    const bubble = post.replies && post.link ? `<a class="pr-replies" href="${esc(post.link)}" target="_blank" rel="noopener" title="${post.github ? 'Open the conversation on GitHub' : 'Open the thread in Slack'}">💬 ${post.replies}</a>` : '';
    foot = `<div class="pr-foot">${rv}${bubble}</div>`;
  }
  // one PR: the card opens it on GitHub; several: the card opens the Slack post, each line opens its PR
  const main = multi ? post.link || prs[0].url : prs[0].url;
  const tip = multi ? `${prs.length} PRs · open the post in Slack` : `${prs[0].repo} #${prs[0].number} · ${ciWord[prs[0].ci] || 'no checks'} · open on GitHub`;
  return `<div class="pr ${reviewing ? 'reviewing' : ''} ${post.forYou ? 'foryou' : ''}">
    <a class="pr-main" href="${esc(main)}" target="_blank" rel="noopener" title="${esc(tip)}"></a>
    <div class="pr-top"><span class="ci ${ci}"></span><span class="who">${esc(who)}</span>${multi ? `<span class="npr">${active.length === prs.length ? `${prs.length} PRs` : `${active.length} of ${prs.length} PRs open`}</span>` : ''}<span class="ago">${agoMs(post.postedAt)}</span></div>
    <div class="pr-title">${esc(title)}</div>${list}${foot}</div>`;
}

function renderPrs() {
  const show = S.settings.board.showPrs;
  $('prside').style.display = show ? '' : 'none';
  if (!show) return;
  const sl = S.reviews;
  const gh = sl.source === 'github';
  $('prChannel').textContent = sl.label;
  $('prChannel').title = gh ? `Open pull requests in ${sl.where} on GitHub` : '';
  $('prFilter').querySelector('[data-f="you"]').hidden = !gh;
  const box = $('prs');
  if (!sl.ready) {
    $('prCount').textContent = '0';
    box.innerHTML = gh
      ? `<div class="side-empty">Pick the repositories whose pull requests you want to see.<button class="btn solid" data-act="settings" data-pane="github">${S.github.connected ? 'Pick repositories…' : 'Connect GitHub…'}</button></div>`
      : `<div class="side-empty">${sl.connected ? 'Pick the Slack channel where your team posts pull requests.' : 'See who is reviewing which pull request, from your team’s Slack channel or straight from GitHub.'}
      <button class="btn solid" data-act="settings" data-pane="slack">${sl.connected ? 'Pick a channel…' : 'Connect Slack…'}</button>${sl.connected ? '' : '<button class="btn" data-act="review-github">Use GitHub instead</button>'}</div>`;
    return;
  }
  const posts = postsOf(sl.prs);
  const filters = { all: () => true, open: (post) => !post.reviewers.length, yours: (post) => post.yours, you: (post) => post.prs.some((p) => p.forYou) };
  if (!gh && UI.prFilter === 'you') UI.prFilter = 'all';
  const sum = (list) => list.reduce((n, post) => n + openPrs(post), 0);
  for (const b of $('prFilter').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.f === UI.prFilter);
    b.querySelector('span').textContent = sum(posts.filter(filters[b.dataset.f]));
  }
  $('prCount').textContent = sum(posts);
  $('prCount').title = gh ? `${sum(posts)} open PRs` : `${sum(posts)} open PRs in ${posts.length} posts`;
  const list = posts.filter(filters[UI.prFilter] || filters.all);
  let html = '';
  if (sl.error) html += `<div class="sec" style="color:#F7A2A5;font-weight:500;letter-spacing:0">${esc(sl.error)}</div>`;
  html += list.length ? list.map(postItem).join('') : `<div class="side-empty">${sl.at ? 'Nothing here.' : `<span><span class="spin"></span> ${gh ? 'Reading pull requests…' : 'Reading the channel…'}</span>`}</div>`;
  const top = box.scrollTop;
  box.innerHTML = html;
  box.scrollTop = top;
}

// ---------------------------------------------------------------- branches modal
function renderBranches() {
  const g = S.github;
  const grid = $('mergeGrid');
  $('mergeAge').textContent = g.at ? `updated ${agoMs(g.at)}` : '';
  if (!g.connected) {
    grid.style.gridTemplateColumns = '1fr';
    grid.innerHTML = `<div class="side-empty" style="padding:6px 0">Connect GitHub to see the last merge on each branch of your repositories.<button class="btn solid" data-act="settings" data-pane="github">Connect GitHub…</button></div>`;
    return;
  }
  const cols = g.branchNames;
  grid.style.gridTemplateColumns = `minmax(80px, 130px) repeat(${cols.length}, minmax(0, 1fr))`;
  let html = '<span></span>' + cols.map((c) => `<span class="h">${esc(c)}</span>`).join('');
  for (const r of g.branches) {
    html += `<span class="repo-name" title="${esc(r.repo)}">${esc(r.name)}</span>`;
    for (const b of cols) {
      const c = r.cells[b];
      if (!c) { html += `<div class="cell none">—</div>`; continue; }
      const recent = Date.now() - Date.parse(c.at) < 3600e3;
      const mark = c.state === 'fail' ? '<span class="fail">✕</span>' : c.state === 'pending' ? '<span class="pending">●</span>' : '<span class="ok">✓</span>';
      const tip = [c.msg, c.author && `by ${c.author}`, c.ci && `CI ${c.ci}`, c.deploy && `deploy ${c.deploy}${c.env ? ` (${c.env})` : ''}`].filter(Boolean).join(' · ');
      html += `<div class="cell ${recent ? 'recent' : ''}" title="${esc(tip)}">${mark}<span>${agoMs(Date.parse(c.at))}</span></div>`;
    }
  }
  if (!g.branches.length) html += `<div style="grid-column:1/-1;padding:12px 0;color:var(--text3)">${g.error ? esc(g.error) : 'No repositories added yet.'}</div>`;
  grid.innerHTML = html;
}

// ---------------------------------------------------------------- statistics
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function hrs(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = sec / 3600;
  return h < 10 ? `${h.toFixed(1).replace(/\.0$/, '')}h` : `${Math.round(h)}h`;
}
const tile = (label, value, sub) => `<div class="tile"><div class="tl">${label}</div><div class="tv">${value}</div>${sub ? `<div class="ts">${sub}</div>` : ''}</div>`;

async function loadStats(force) {
  if (!force && UI.stats?.days === UI.statsDays && Date.now() - UI.statsAt < 60e3) return renderStats();
  try { UI.stats = await api(`/api/stats?days=${UI.statsDays}`); UI.statsAt = Date.now(); UI.statsErr = ''; }
  catch (e) { UI.statsErr = e.message; }
  renderStats();
}

function barChart(d) {
  const today = d.days === 1;
  const max = Math.max(3600, ...d.series.map((b) => b.work));
  const now = Date.now();
  const cols = d.series.map((b, i) => {
    const date = new Date(b.at);
    const when = today ? `${String(date.getHours()).padStart(2, '0')}:00` : date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    const future = b.at > now;
    const tip = future ? '' : `${when} · ${hrs(b.work)} working · ${hrs(b.wait)} waiting on you${b.tokens ? ` · ${fmtTokens(b.tokens)} tokens` : ''}`;
    const lbl = today ? (i % 6 === 0 ? String(i).padStart(2, '0') : '') : d.days === 7 ? WEEKDAYS[(date.getDay() + 6) % 7] : (i % 5 === 0 || i === d.series.length - 1 ? String(date.getDate()) : '');
    return { bar: `<div class="col ${future ? 'future' : ''}" ${tip ? `data-tip="${esc(tip)}"` : ''}><i style="height:${b.work ? Math.max(2, (100 * b.work) / max) : 0}%"></i></div>`, lbl: `<span>${lbl}</span>` };
  });
  return `<div class="chart"><div class="yax"><span>${hrs(max)}</span><span>0</span></div>
    <div class="plot"><div class="bars" style="grid-template-columns:repeat(${cols.length},1fr)">${cols.map((c) => c.bar).join('')}</div>
    <div class="xax" style="grid-template-columns:repeat(${cols.length},1fr)">${cols.map((c) => c.lbl).join('')}</div></div></div>`;
}

function heatmap(d) {
  const max = Math.max(...d.heat.flat());
  if (!max) return '';
  const cells = d.heat.map((row, wd) => `<span class="hl">${WEEKDAYS[wd]}</span>${row.map((v, h) => {
    const lvl = v ? Math.min(5, Math.ceil((5 * v) / max)) : 0;
    return `<i class="l${lvl}" data-tip="${WEEKDAYS[wd]} ${String(h).padStart(2, '0')}:00 · ${v ? `${hrs(v)} of agent time` : 'no agent time'}"></i>`;
  }).join('')}`).join('');
  const hours = `<span></span>${Array.from({ length: 24 }, (_, h) => `<span class="hh">${h % 6 === 0 ? String(h).padStart(2, '0') : ''}</span>`).join('')}`;
  return `<div class="st-sec"><div class="st-h">When your agents work</div><div class="heat">${cells}${hours}</div>
    <div class="heat-key">less <i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><i class="l5"></i> more</div></div>`;
}

function table(title, rows, cols) {
  if (!rows.length) return '';
  return `<div class="st-sec"><div class="st-h">${title}</div><table class="st-t"><thead><tr>${cols.map(([h, , cls]) => `<th class="${cls || ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map(([, f, cls]) => `<td class="${cls || ''}">${f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderStats() {
  for (const b of $('statsDays').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.days) === UI.statsDays);
  const d = UI.stats;
  const body = $('statsBody');
  if (UI.statsErr) { body.innerHTML = `<div class="banner">${esc(UI.statsErr)}</div>`; return; }
  if (!d || d.days !== UI.statsDays) { body.innerHTML = '<div class="st-empty"><span class="spin"></span> Counting…</div>'; return; }
  $('statsRange').textContent = d.first ? `since ${clock(Math.max(d.from, d.first))}` : '';
  if (!d.samples && !d.prs.posted) {
    body.innerHTML = `<div class="st-empty"><div class="pic">📊</div><b>Nothing recorded yet${d.days === 1 ? ' today' : ''}.</b>
      <div>Sheepdog keeps a history of what your agents do while it runs, on this computer only. Check back once they’ve done some work.</div></div>`;
    return;
  }
  const r = d.responses, p = d.prs;
  const avgTok = d.work ? `${fmtTokens(Math.round(d.tokens / (d.work / 3600)))} per agent-hour` : '';
  let html = `<div class="tiles">
    ${tile('Agent time', hrs(d.work), `${d.agents} agent${d.agents === 1 ? '' : 's'} · ${hrs(d.wait)} waiting on you`)}
    ${tile('You answer in', r.median == null ? '—' : hrs(r.median), r.count ? `median of ${r.count} · 90% within ${hrs(r.p90)}` : 'no answers yet')}
    ${tile('In parallel', d.parallel ? String(d.parallel) : '—', d.peak ? `agents working at once · peak ${d.peak}` : 'agents working at once')}
    ${tile('Tokens', d.tokens ? fmtTokens(d.tokens) : '—', avgTok)}
  </div>
  <div class="st-sec"><div class="st-h">Agent time ${d.days === 1 ? 'per hour' : 'per day'}</div>${barChart(d)}</div>`;
  if (d.days > 1) html += heatmap(d);
  const work = (x) => hrs(x.work), tok = (x) => (x.tokens ? fmtTokens(x.tokens) : '—');
  html += `<div class="st-cols">
    ${table('By ticket', d.tickets, [['Ticket', (x) => ticketHtml(x.name)], ['Agent time', work, 'n'], ['Tokens', tok, 'n']])}
    ${table('By repository', d.repos, [['Repository', (x) => esc(x.name)], ['Agent time', work, 'n'], ['Tokens', tok, 'n']])}
    ${table('By model', d.models, [['Model', (x) => esc(x.name)], ['Agent time', work, 'n'], ['Tokens', tok, 'n']])}
    ${table('Longest waits', r.longest, [['Agent', (x) => `${x.ticket ? ticketHtml(x.ticket) + ' ' : ''}${esc(x.title || x.repo || kindName(x.kind))}`], ['Waited', (x) => hrs(x.wait), 'n'], ['When', (x) => esc(clock(x.at)), 'n when']])}
  </div>`;
  if (r.away) html += `<div class="st-note">Not counted as answers: ${r.away} time${r.away === 1 ? '' : 's'} an agent waited longer than ${S.settings.idleMinutes} min (you were away).</div>`;
  if (S.reviews.ready || p.posted) {
    html += `<div class="st-sec"><div class="st-h">PR reviews${S.reviews.where ? ` · ${esc(S.reviews.where)}` : ''}</div>`;
    if (!p.posted) html += '<div class="st-note">No pull requests posted in this period yet.</div>';
    else html += `<div class="tiles">
      ${tile('Posted', String(p.posted), p.yours ? `${p.yours} yours` : '')}
      ${tile('Until someone reviews', p.toReview == null ? '—' : hrs(p.toReview), `median · ${p.reviewed} of ${p.posted} picked up`)}
      ${tile('Until approved', p.toApprove == null ? '—' : hrs(p.toApprove), `median · ${p.approved} approved`)}
      ${tile('Your PRs wait', p.yoursToReview == null ? '—' : hrs(p.yoursToReview), 'median until someone reviews')}
    </div>${table('Reviewers', p.people, [['Name', (x) => esc(x.name)], ['👀 Reviewed', (x) => x.reviewed, 'n'], ['✅ Approved', (x) => x.approved, 'n']])}`;
    html += '</div>';
  }
  html += `<div class="st-note">Counted while Sheepdog runs. Stored on this computer only, for 90 days. <a href="#" data-act="settings" data-pane="advanced">Clear…</a></div>`;
  const top = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = top;
}

// ---------------------------------------------------------------- today strip
function delta(cur, prev, fmt = String, word = 'vs yesterday') {
  if (cur == null || prev == null) return '';
  const d = cur - prev;
  return d > 0 ? `↑${fmt(d)} ${word}` : d < 0 ? `↓${fmt(-d)} ${word}` : `same as yesterday`;
}
function renderToday() {
  const box = $('today');
  const t = S.today;
  if (!t || !S.settings.board.showToday) { box.hidden = true; return; }
  const slack = S.reviews.ready;
  const gh = S.reviews.source === 'github';
  const cell = (prio, value, ctx, label, tip) => `<div class="tt" data-p="${prio}" ${tip ? `data-tip="${esc(tip)}"` : ''}><div class="tv"><b>${value}</b>${ctx ? `<span>${ctx}</span>` : ''}</div><div class="tl">${label}</div></div>`;
  const r = t.reviews.today;
  const cells = [];
  if (slack) {
    cells.push(cell(1, t.prs.today, esc(`${delta(t.prs.today, t.prs.yesterday)}${t.prs.week ? ` · ${t.prs.week} this week` : ''}`), 'Your PRs', gh ? 'PRs you opened today (or marked ready for review)' : 'PRs you posted in the review channel today'));
    cells.push(r ? cell(1, r.total, esc(gh ? `${r.approved} approved` : `${r.eyes} 👀 · ${r.approved} ✅`), 'Reviews given', gh ? 'Teammates’ PRs you reviewed on GitHub today' : 'Teammates’ PRs you reacted to today with 👀 or ✅')
      : cell(1, '—', 'who are you?', 'Reviews given', gh ? 'Connect GitHub to count your reviews' : 'Pick yourself in Settings › Slack to count your reviews'));
  }
  cells.push(cell(2, t.reply.median == null ? '—' : hrs(t.reply.median), t.reply.median == null ? (t.reply.count ? `${t.reply.count} of 3 answers` : 'no answers yet') : `median · ${t.reply.count} answers`, 'Your reply time', 'How long agents waited before you answered them today (median)'));
  cells.push(cell(3, hrs(t.waited.today), esc(delta(t.waited.today, t.waited.yesterday, hrs)), 'Agents waited', 'Total time agents spent waiting on you today'));
  cells.push(cell(2, hrs(t.agent.today), esc(delta(t.agent.today, t.agent.yesterday, hrs)), 'Agent hours', 'Time your agents spent working today'));
  if (slack) {
    cells.push(cell(2, `${t.streak} day${t.streak === 1 ? '' : 's'}`, 'with a PR', 'Streak', 'Workdays in a row you posted at least one PR (weekends don’t break it)'));
    cells.push(cell(4, t.team.today, esc(`in ${S.reviews.where}`), 'Team PRs today', gh ? 'PRs opened today in your repositories, by everyone' : 'PRs posted in the review channel today, by everyone'));
  }
  box.innerHTML = `<button class="today-in" data-act="today-open" title="Open today’s statistics">${cells.join('')}</button>`;
  box.hidden = false;
}

// ---------------------------------------------------------------- leaderboards
const LB_TITLES = { // title, subtitle, value format, short name for the "You:" line
  reviewed: ['Reviews given', '👀 or ✅ on a teammate’s PR', (v) => String(v), 'reviews'],
  posted: ['PRs posted', 'in the review channel', (v) => String(v), 'PRs posted'],
  approved: ['Approvals given', '✅ on a teammate’s PR', (v) => String(v), 'approvals'],
  pickup: ['Fastest pickup', 'median time from post to first 👀 or ✅', (v) => hrs(v), 'pickup speed'],
};
async function loadLeaderboard(force) {
  if (!force && UI.lb?.days === UI.lbDays && Date.now() - UI.lbAt < 60e3) return renderLeaderboard();
  try { UI.lb = await api(`/api/leaderboard?days=${UI.lbDays}`); UI.lbAt = Date.now(); UI.lbErr = ''; }
  catch (e) { UI.lbErr = e.message; }
  renderLeaderboard();
}
function renderLeaderboard() {
  for (const b of $('lbDays').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.days) === UI.lbDays);
  const body = $('lbBody');
  const d = UI.lb;
  if (!S.reviews.ready) {
    body.innerHTML = `<div class="st-empty"><div class="pic">🏆</div><b>Leaderboards come from your team’s pull requests.</b><div>Connect Slack and pick your review channel, or connect GitHub and pick your repositories.</div>
      <span style="display:flex;gap:8px"><button class="btn solid" data-act="settings" data-pane="slack">Connect Slack…</button><button class="btn solid" data-act="settings" data-pane="github">Connect GitHub…</button></span></div>`;
    return;
  }
  if (UI.lbErr) { body.innerHTML = `<div class="banner">${esc(UI.lbErr)}</div>`; return; }
  if (!d || d.days !== UI.lbDays) { body.innerHTML = '<div class="st-empty"><span class="spin"></span> Counting…</div>'; return; }
  const medal = (n) => (n === 1 ? '🥇' : n === 2 ? '🥈' : n === 3 ? '🥉' : `#${n}`);
  const mine = d.boards.filter((b) => b.you).map((b) => `<b>${medal(b.you.rank)}</b> in ${LB_TITLES[b.key][3]}`);
  let html = d.me
    ? `<div class="lb-you">${mine.length ? `You: ${mine.join(' · ')}` : 'You’re not on the boards yet for this period. Post or review a PR to get on.'}</div>`
    : `<div class="lb-you">${S.reviews.source === 'github' ? 'Connect GitHub' : 'Pick yourself in <a href="#" data-act="settings" data-pane="slack">Settings › Slack</a>'} to see where you rank.</div>`;
  html += '<div class="lb-grid">';
  for (const b of d.boards) {
    const [title, sub0, fmt] = LB_TITLES[b.key];
    const sub = S.reviews.source === 'github' ? { reviewed: 'reviews on a teammate’s PR', posted: 'opened in your repositories', approved: 'approving reviews', pickup: 'median time from PR opened to first review' }[b.key] : sub0;
    const row = (r) => `<div class="lb-row ${r.you ? 'you' : ''}"><span class="lb-rank">${medal(r.rank)}</span><span class="lb-name">${esc(r.name)}${r.you ? ' <em>you</em>' : ''}</span><span class="lb-val">${esc(fmt(r.value))}</span></div>`;
    const rows = b.rows.map(row).join('');
    const extra = b.you && !b.rows.some((r) => r.you) ? `<div class="lb-gap">…</div>${row(b.you)}` : '';
    html += `<div class="lb-card"><div class="lb-h"><b>${title}</b><span>${sub}</span></div>${rows || `<div class="st-note" style="padding:8px 0">${b.key === 'pickup' ? 'Fills in as Sheepdog sees new reviews start (each person needs 2 over 7 or 30 days).' : 'No one yet.'}</div>`}${extra}</div>`;
  }
  html += `</div><div class="st-note">${S.reviews.source === 'github'
    ? `From ${esc(S.reviews.where)} on GitHub. Review times are exact (GitHub records when each review was submitted); pickup is the time from opening a PR (or marking it ready) to its first review.`
    : `From ${esc(S.reviews.where)}. Slack doesn’t record when a reaction was added: times count from when Sheepdog first saw it, and reactions found when Sheepdog wasn’t watching are left out of pickup speed. Pickup speed counts once per post. Everyone’s Sheepdog sees the same channel, so everyone sees the same boards.`}</div>`;
  body.innerHTML = html;
}

// ---------------------------------------------------------------- settings building blocks
const toggle = (key) => `<button class="toggle ${get(cfg, key) ? 'on' : ''}" data-act="toggle" data-key="${key}" aria-pressed="${!!get(cfg, key)}"></button>`;
const select = (key, opts, type = 'string') => `<select class="field" data-set="${key}" data-type="${type}">${opts.map(([v, l]) =>
  `<option value="${esc(v)}" ${String(get(cfg, key)) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const field = (key, ph = '', extra = '') => `<input class="field" data-set="${key}" value="${esc(get(cfg, key))}" placeholder="${esc(ph)}" ${extra}>`;
// stored as "eyes,mag", shown as "eyes, mag"
const emojiField = (key, ph) => `<input class="field mono" style="width:240px" spellcheck="false" data-set="${key}" value="${esc(String(get(cfg, key) || '').split(',').join(', '))}" placeholder="${esc(ph)}">`;
const row = (label, sub, ctl, cls = '') => `<div class="row ${cls}"><div class="lbl"><div>${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${ctl ? `<div class="ctl">${ctl}</div>` : ''}</div>`;
const group = (title, rows) => `<div>${title ? `<div class="group-title">${title}</div>` : ''}<div class="group">${rows.join('')}</div></div>`;
const busy = (on, label) => (on ? `<span class="spin"></span>` : label);

// ---------------------------------------------------------------- pane: machines
function hostSub(h) {
  const s = S?.hosts.find((x) => x.id === h.id);
  const t = UI.hostTest[h.id];
  if (t) return t.busy ? '<span class="spin"></span> Testing…' : `<span class="${t.ok ? 'ok' : 'err'}">${esc(t.text)}</span>${t.ok ? '' : fixHtml(t.fix)}`;
  if (!h.enabled) return h.type === 'ssh' ? `SSH · <code>${esc(h.ssh)}</code> · paused` : 'Paused';
  const where = h.type === 'ssh' ? `SSH · <code>${esc(h.ssh)}</code>` : 'This computer';
  if (!s || (!s.ok && !s.error)) return `${where} · connecting…`;
  if (!s.ok) return `<span class="err">${esc(s.error)}</span>${fixHtml(s.fix)}`;
  const agents = (s.agents || []).filter((a) => !a.parent && !a.headless);
  return `${where} · ${agents.length ? `${agents.length} agent${agents.length > 1 ? 's' : ''}` : 'no agents running'} · checked ${agoMs(s.at)}`;
}

function panePastures() {
  const hostRows = cfg.hosts.map((h) => {
    const s = S?.hosts.find((x) => x.id === h.id);
    const dot = !h.enabled ? 'off' : s?.ok ? '' : s?.error ? 'down' : 'off';
    return `<div class="row"><span class="dot ${dot}"></span><div class="lbl"><div class="${h.type === 'ssh' ? 'mono' : ''}">${esc(h.name)}</div><div class="sub">${hostSub(h)}</div></div>
      <div class="ctl"><button class="btn solid" data-act="host-test" data-id="${h.id}">Test</button>
      ${h.type === 'ssh' ? `<button class="btn" data-act="host-remove" data-id="${h.id}" title="Remove">✕</button>` : ''}
      <button class="toggle ${h.enabled ? 'on' : ''}" data-act="host-toggle" data-id="${h.id}"></button></div></div>`;
  });
  const known = new Set(cfg.hosts.map((h) => h.ssh).filter(Boolean));
  const fromConfig = (UI.sshHosts || []).filter((x) => !known.has(x));
  const t = UI.hostTest.__new;
  return `<div class="pane-head">Machines</div>
    ${group('Pastures', hostRows)}
    ${group('Add a machine', [`<div class="row col">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${fromConfig.length ? `<select class="field" id="newHostPick" data-act-change="host-pick"><option value="">From ~/.ssh/config…</option>${fromConfig.map((x) => `<option>${esc(x)}</option>`).join('')}</select>` : ''}
        <input class="field wide mono" id="newHost" placeholder="alias or user@host" value="${esc(UI.newHost)}" autocomplete="off" spellcheck="false">
        <button class="btn solid" data-act="host-add">${busy(t?.busy, 'Test and add')}</button>
      </div>
      ${t && !t.busy ? `<div class="sub ${t.ok ? 'ok' : 'err'}">${esc(t.text)}${t.ok ? '' : fixHtml(t.fix)}</div>` : ''}
      <div class="note">The machine needs SSH key login (no password prompt) and <code>python3</code>. New machines are trusted on first connect, and login commands in <code>~/.ssh/config</code> (like attaching to tmux) are skipped. Sheepdog runs a small read-only script there over SSH; nothing is installed.</div>
    </div>`])}
    ${group('Connection', [
      row('Check every', '', select('pollSeconds', [[2, '2 seconds'], [3, '3 seconds'], [5, '5 seconds'], [10, '10 seconds']], 'number')),
      row('Mark idle after', 'Waiting agents you haven’t answered', select('idleMinutes', [[10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours']], 'number')),
    ])}`;
}

// ---------------------------------------------------------------- pane: alerts
function notifStatus() {
  if (NATIVE) {
    const n = window.sheepdogNative.notif;
    if (n === 'granted') return '<span class="status-ok">✓ Allowed</span>';
    if (n === 'denied') return '<span class="sub err">Off in System Settings › Notifications</span>';
    return '<button class="btn primary" data-act="notif-allow">Allow…</button>';
  }
  if (!('Notification' in window)) return '<span class="sub">Not supported in this browser</span>';
  if (Notification.permission === 'granted') return '<span class="status-ok">✓ Allowed</span>';
  if (Notification.permission === 'denied') return '<span class="sub err">Blocked in browser settings</span>';
  return '<button class="btn primary" data-act="notif-allow">Allow…</button>';
}
function paneAlerts() {
  const q = cfg.alerts.quietHours;
  return `<div class="pane-head">Alerts</div>
    ${group('When an agent needs you', [
      row('Notification', 'Banner; click it to jump to the tab', `${notifStatus()}${toggle('alerts.notify')}`),
      row('Sound', '', `${select('alerts.sound', window.SheepdogSounds.names.map((n) => [n, n]))}<button class="btn solid" data-act="play">▶</button>`),
      row('Window flash', 'Board pulses amber twice', toggle('alerts.windowFlash')),
    ])}
    ${group('Pull requests', [
      row('Someone starts reviewing your PR', S?.slack?.connected ? '👀 on your post in the review channel' : 'Needs Slack, see Settings › Slack', toggle('alerts.prReview')),
      row('Your PR is approved', '✅ in Slack or approved on GitHub', toggle('alerts.prApproved')),
      row('A teammate’s PR has no reviewer', 'Nudge once, after', select('alerts.prNudgeHours', [[0, 'Off'], [2, '2 hours'], [4, '4 hours'], [8, '8 hours'], [24, '1 day']], 'number')),
    ])}
    ${group('Hold back', [
      row('Only alert after', 'Skip quick back-and-forth', select('alerts.alertAfterSeconds', [[0, 'Right away'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']], 'number')),
      row('Quiet hours', `${esc(q.start)} – ${esc(q.end)} · board still updates`, `<input class="field" type="time" data-set="alerts.quietHours.start" value="${esc(q.start)}"><input class="field" type="time" data-set="alerts.quietHours.end" value="${esc(q.end)}">${toggle('alerts.quietHours.enabled')}`),
    ])}`;
}

const HK = { provider: null, models: null, modelsErr: '', loading: false };
function loadHerderModels() {
  if (HK.loading || !cfg.herder.key.set) return;
  HK.loading = true;
  api('/api/herder/models').then((m) => { HK.models = m; HK.modelsErr = ''; }, (e) => { HK.models = []; HK.modelsErr = e.message; })
    .finally(() => { HK.loading = false; if (UI.pane === 'herder') renderSettings(); });
}
function paneHerder() {
  const h = cfg.herder;
  const prov = HK.provider || h.provider;
  const connected = h.key.set && prov === h.provider;
  if (connected && !HK.models && !HK.loading) loadHerderModels();
  const models = HK.models?.length ? HK.models : [h.model];
  const seg = `<div class="seg" style="width:320px">${[['anthropic', 'Anthropic'], ['openai', 'OpenAI-compatible']].map(([k, l]) => `<button class="${prov === k ? 'on' : ''}" data-act="herder-prov" data-p="${k}">${l}</button>`).join('')}</div>`;
  const conn = prov === 'openai'
    ? [row('Base URL', 'Your LiteLLM gateway, OpenRouter (https://openrouter.ai/api/v1), Ollama (http://localhost:11434/v1) or OpenAI (https://api.openai.com/v1)',
        `<input class="field wide mono" id="herderBase" placeholder="https://your-gateway/v1" value="${esc(h.provider === 'openai' ? h.baseUrl : '')}" autocomplete="off">`),
       row('API key', connected ? `Saved (${esc(h.key.hint)}). Stored on this Mac only.` : 'The gateway or provider key. Stored on this Mac only.',
        `<input class="field" id="herderKey" type="password" placeholder="${connected ? '••••••• saved' : 'key'}" autocomplete="off"><button class="btn solid" data-act="herder-key">${connected ? 'Update' : 'Connect'}</button>${connected ? '<button class="btn" data-act="herder-key-clear">Remove</button>' : ''}`)]
    : [row('Anthropic API key', connected ? `Saved (${esc(h.key.hint)}). Stored on this Mac only.` : 'From console.anthropic.com › API keys. Stored on this Mac only.',
        `<input class="field" id="herderKey" type="password" placeholder="${connected ? '••••••• saved' : 'sk-ant-…'}" autocomplete="off"><button class="btn solid" data-act="herder-key">${connected ? 'Replace' : 'Save'}</button>${connected ? '<button class="btn" data-act="herder-key-clear">Remove</button>' : ''}`)];
  if (connected) conn.push(row('Model', HK.modelsErr ? esc(HK.modelsErr) : HK.loading && !HK.models ? 'Loading the list…' : prov === 'openai' ? 'The models your endpoint offers' : 'Used for questions and summaries',
    `<select class="field" data-set="herder.model">${[...new Set(models)].map((m) => `<option value="${esc(m)}" ${m === h.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`));
  return `<div class="pane-head">Herder</div>
    <div class="note">Herder shows the agents waiting for you and what they’re asking, and you can chat with it about your agents (“what did RV-123 conclude?”, “which agents are stuck?”) or have it message them. Without a model, lines that start with a ticket (RV-123 run the tests) go straight to that agent.</div>
    ${group('Model', [row('Provider', 'Anthropic directly, or any OpenAI-compatible endpoint: a LiteLLM gateway, OpenRouter, Ollama or OpenAI', seg), ...conn])}
    ${group('Safety', [
      row('Confirm messages to agents', 'Off: when you tell Herder to send something, it sends it right away. On: you see each message first and press Send.', toggle('herder.confirmSends')),
      row('Show the panel when an agent waits', 'Herder opens with the agents on “Your turn”, and only those', toggle('board.herder')),
    ])}
    <div class="note">Herder only runs when you write to it. To answer, it sends the end of the agents’ chats you ask about, and the list of agents and PRs, to your model provider with your key. Text in agents’ chats is treated as information, never as instructions.</div>`;
}

function paneBoard() {
  return `<div class="pane-head">Board</div>
    ${group('Layout', [
      row('Density', 'Compact hides the prompt and the machine line', select('board.density', [['auto', 'Automatic (compact above 10 agents)'], ['comfortable', 'Comfortable'], ['compact', 'Compact']])),
      row('PR review sidebar', 'Hidden below 640px', toggle('board.showPrs')),
      row('Review sidebar source', 'Slack: posts in your review channel, 👀 and ✅. GitHub: open PRs in your repositories and their reviews (no Slack needed). Automatic uses Slack once a channel is picked.', select('reviews.source', [['auto', 'Automatic'], ['slack', 'Slack channel'], ['github', 'GitHub']])),
      row('Today strip', 'Your PRs, reviews given, reply time, agent hours and streak at the top', toggle('board.showToday')),
    ])}`;
}

function ticketSuggestionHtml(where) {
  const t = S?.ticketSuggestion;
  if (!t) return '';
  const host = t.link ? (t.link.match(/^https?:\/\/([^/]+)/) || [])[1] : '';
  const what = [t.pattern ? `use <b>${t.prefixes.map((p) => `${esc(p)}-…`).join(' / ')}</b> as ticket IDs` : '', t.link ? `link them to <b>${esc(host)}</b>` : ''].filter(Boolean).join(' and ');
  return `<div class="banner info suggest"><span>🎫 Your team’s PRs mention tickets like <b>${esc(t.prefixes[0])}-123</b> (${t.prs} PRs). Should Sheepdog ${what}?</span>
    <span class="acts"><button class="btn primary" data-act="tickets-accept">Use these</button>${where === 'board' ? '<button class="btn" data-act="tickets-dismiss">Not now</button>' : ''}</span></div>`;
}

function paneTickets() {
  return `<div class="pane-head">Tickets</div>${ticketSuggestionHtml('pane')}
    ${group('Ticket IDs', [
      row('Pattern', 'Regular expression, found in titles, prompts, branches and folders', field('tickets.pattern', '', 'class="field mono" style="width:220px" spellcheck="false"')),
      row('Link template', 'Makes the ticket on each card clickable. <code>{id}</code> is replaced by the ticket.', field('tickets.link', 'https://example.atlassian.net/browse/{id}', 'style="width:300px" spellcheck="false"')),
    ])}`;
}

// ---------------------------------------------------------------- pane: terminal
const TERM = { cmux: null, iterm: null, installed: null, cmuxMode: null };
const CMUX_MODES = { cmuxOnly: 'cmux processes only', off: 'Off', automation: 'Automation mode', password: 'Password mode', allowAll: 'Full open access' };
function cmuxHelpHtml() {
  const cm = TERM.cmuxMode;
  if (!TERM.installed?.cmux || !cm?.blocked) return '';
  return `<div class="banner info"><b>cmux is blocking Sheepdog.</b> Its Socket Control Mode is “${esc(CMUX_MODES[cm.mode] || cm.mode)}”, which only lets programs started inside cmux control it.
    <ol class="steps" style="margin:6px 0 0"><li>In cmux, open <b>Settings › Automation</b>.</li><li>Set <b>Socket Control Mode</b> to <b>Automation mode</b>.</li><li>Come back here and click <b>Allow…</b> next to cmux.</li></ol></div>`;
}
function paneTerminal() {
  const inst = TERM.installed;
  const r = (app, name) => {
    const st = TERM[app];
    const ctl = !inst ? '' : !inst[app] ? '<span class="sub">Not installed</span>'
      : st === 'busy' ? '<span class="spin"></span>' : st === 'ok' ? '<span class="status-ok">✓ Allowed</span>'
      : `<button class="btn ${st === 'err' ? 'solid' : 'primary'}" data-act="term-allow" data-app="${app}">${st === 'err' ? 'Try again' : 'Allow…'}</button>`;
    const sub = app === 'cmux' && cm?.mode ? `Socket Control Mode: ${esc(CMUX_MODES[cm.mode] || cm.mode)}${cm.blocked ? ' · <span class="err">blocks Sheepdog</span>' : ''}` : 'Automation access, to switch to an agent’s tab';
    return row(name, sub, ctl);
  };
  const cm = TERM.cmuxMode;
  return `<div class="pane-head">Terminal</div>${cmuxHelpHtml()}
    <div class="note">When you click an agent, Sheepdog switches your terminal to its tab. macOS asks you once per app. Sheepdog only reads tab titles and selects tabs; it never types into or reads your sessions.</div>
    ${group('Jump to tab', [r('cmux', 'cmux'), r('iterm', 'iTerm2')])}
    ${group('cmux socket password', [row('Password', 'Only if cmux runs its control socket in password mode', `<input class="field" id="cmuxPw" type="password" placeholder="${cfg.terminal.cmuxPassword.set ? '••••••• saved' : 'not set'}" autocomplete="off"><button class="btn solid" data-act="cmux-pw">Save</button>`)])}`;
}

// ---------------------------------------------------------------- pane: access
// Everything Sheepdog needs permission for, with a live status and a button that opens the right place.
const ACCESS = { data: null, at: 0, busy: false };
async function loadAccess() {
  ACCESS.busy = true; rerender();
  try { ACCESS.data = await api('/api/access'); ACCESS.at = Date.now(); } catch (e) { toast(e.message, true); }
  ACCESS.busy = false; rerender();
}
function accessItems(inWizard) {
  const d = ACCESS.data;
  if (!d) return [];
  const items = [];
  const btn = (label, act, extra = '', cls = 'solid') => `<button class="btn ${cls}" data-act="${act}" ${extra}>${label}</button>`;
  const open = (what, label) => btn(label, 'access-open', `data-what="${what}"`);
  // notifications
  const n = NATIVE ? window.sheepdogNative.notif : 'Notification' in window ? Notification.permission : 'unsupported';
  items.push({ ok: n === 'granted', name: 'Notifications', why: 'So Sheepdog can tell you when an agent waits or a PR gets reviewed.',
    status: n === 'granted' ? 'Allowed' : n === 'denied' ? 'Turned off for Sheepdog' : n === 'unsupported' || n === 'unavailable' ? 'Not available here' : 'Not allowed yet',
    actions: n === 'denied' ? (NATIVE ? open('notifications', 'Open Notification settings') : '') : n === 'granted' || n === 'unsupported' || n === 'unavailable' ? '' : btn('Allow…', 'notif-allow', '', 'primary') });
  // python on this Mac
  if (d.python.enabled) items.push({ ok: d.python.ok, name: 'Read agents on this Mac', why: 'Needs Python 3, which comes with Apple’s Command Line Tools.',
    status: d.python.ok ? 'Working' : d.python.error || 'Checking…', actions: d.python.needsTools ? open('python', 'Install Command Line Tools…') : '' });
  // cmux
  if (d.cmux.installed) {
    const blocked = d.cmux.blocked || /only process|access denied/i.test(d.cmux.error || '');
    items.push({ ok: d.cmux.ok, name: 'cmux: jump to an agent’s tab', why: 'cmux only lets outside apps control it in Automation mode.',
      status: d.cmux.ok ? `Allowed (${CMUX_MODES[d.cmux.mode] || d.cmux.mode})` : blocked ? `Blocked: Socket Control Mode is “${CMUX_MODES[d.cmux.mode] || 'cmux processes only'}”` : d.cmux.error || 'Not checked',
      steps: blocked ? ['Click <b>Open cmux</b>, then open its <b>Settings</b> (⌘,) › <b>Automation</b>.', 'Set <b>Socket Control Mode</b> to <b>Automation mode</b>.', 'Click <b>Check again</b>. Still blocked? Quit and reopen cmux once.'] : null,
      actions: blocked ? open('cmux-settings', 'Open cmux') : d.cmux.ok ? '' : btn('Try again', 'access-check') });
  }
  // iTerm2
  if (d.iterm.installed) {
    const st = TERM.iterm;
    items.push({ ok: st === 'ok', name: 'iTerm2: jump to an agent’s tab', why: 'macOS asks once whether Sheepdog may control iTerm2 (Automation).',
      status: st === 'ok' ? 'Allowed' : st === 'err' ? 'Not allowed: turn on iTerm2 for Sheepdog under Automation' : 'Not checked',
      actions: st === 'ok' ? '' : `${btn('Allow…', 'term-allow', 'data-app="iterm"', 'primary')}${st === 'err' ? open('automation', 'Open Automation settings') : ''}` });
  }
  // machines
  for (const m of d.machines.filter((x) => x.enabled)) {
    items.push({ ok: m.ok, name: `Machine: ${esc(m.name)}`, why: 'SSH key login and Python 3 on the machine.',
      status: m.ok ? 'Connected' : m.error || 'Connecting…', fix: m.fix, actions: btn('Machines…', 'pane', 'data-pane="pastures"') });
  }
  if (!inWizard) {
    if (d.slack.connected) {
      const notIn = /isn’t in that channel|not_in_channel|channel_not_found/i.test(d.slack.error || '');
      items.push({ ok: d.slack.ok && !!d.slack.channel && (!d.slack.bot || d.slack.me), name: 'Slack review channel', why: d.slack.bot ? 'The bot must be in the channel, and you pick yourself.' : 'Reads the channel with your own access.',
        status: !d.slack.channel ? 'No channel picked' : notIn ? `The Sheepdog bot isn’t in #${esc(d.slack.channel)}` : d.slack.error ? esc(d.slack.error) : d.slack.bot && !d.slack.me ? 'Pick yourself, so “Yours” and PR alerts work' : `Reading #${esc(d.slack.channel)}`,
        fix: notIn ? '/invite @Sheepdog' : null, actions: btn('Slack…', 'pane', 'data-pane="slack"') });
    }
    if (d.github.connected) items.push({ ok: d.github.ok && !d.github.error, name: 'GitHub', why: 'For PR states, checks and approvals.',
      status: d.github.error ? esc(d.github.error) : 'Connected', actions: d.github.error ? btn('GitHub…', 'pane', 'data-pane="github"') : '' });
  }
  return items;
}
function accessHtml(inWizard) {
  if (!ACCESS.data) return `<div class="note"><span class="spin"></span> Checking what Sheepdog can reach…</div>`;
  const items = accessItems(inWizard);
  const bad = items.filter((i) => !i.ok).length;
  const rows = items.map((i) => `<div class="row access ${i.ok ? 'good' : 'bad'}"><span class="mark">${i.ok ? '✓' : '!'}</span>
    <div class="lbl"><div>${i.name}</div><div class="sub">${i.ok ? esc(i.status) : `<span class="err">${i.status}</span>`}${i.fix && !i.ok ? fixHtml(i.fix) : ''}</div>
      ${!i.ok ? `<div class="sub why">${i.why}</div>` : ''}${i.steps && !i.ok ? `<ol class="steps">${i.steps.map((x) => `<li>${x}</li>`).join('')}</ol>` : ''}</div>
    ${i.actions ? `<div class="ctl">${i.actions}</div>` : ''}</div>`);
  return `<div class="access-head">${bad ? `<b>${bad} thing${bad === 1 ? '' : 's'} need${bad === 1 ? 's' : ''} your attention</b>` : '<b class="ok">✓ Sheepdog has everything it needs</b>'}
      <button class="btn solid" data-act="access-check">${busy(ACCESS.busy, 'Check again')}</button></div>
    ${group('', rows)}`;
}
function paneAccess() {
  return `<div class="pane-head">Access</div>
    <div class="note">What Sheepdog needs permission for, and whether it has it. Each button takes you to the right setting.</div>
    ${accessHtml(false)}`;
}

function paneAdvanced() {
  return `<div class="pane-head">Advanced</div>
    ${group('Setup', [
      row('Run setup again', 'Re-detect agents, machines and connections', '<button class="btn primary" data-act="wizard">Run setup…</button>'),
      row('Reset all settings', 'Forgets machines, GitHub and Slack connections', '<button class="btn danger" data-act="reset">Reset…</button>'),
    ])}
    ${group('Statistics', [
      row('Clear statistics', 'Deletes the history behind 📊 Stats (kept 90 days, on this computer only)', '<button class="btn danger" data-act="stats-clear">Clear…</button>'),
    ])}
    <div class="note">Settings and tokens are stored on this computer only, in <code>~/.config/sheepdog/config.json</code>, readable only by your user.</div>`;
}

// ---------------------------------------------------------------- GitHub (pane + wizard step)
async function loadGh() {
  try { GH.status = await api('/api/github/status'); GH.err = ''; } catch (e) { GH.err = e.message; }
  rerender();
}

function githubBody(inWizard) {
  const s = GH.status;
  if (!s) return `<div class="note"><span class="spin"></span> Checking GitHub…</div>`;
  const err = GH.err ? `<div class="sub err" style="font-size:12px">${esc(GH.err)}</div>` : '';
  if (s.auth === 'none') {
    const dev = GH.device;
    if (dev) {
      return `${group('Sign in with GitHub', [`<div class="row col" style="gap:10px">
        <div class="note">Enter this code on GitHub, then approve Sheepdog:</div>
        <div class="code-box">${esc(dev.userCode)}</div>
        <div style="display:flex;gap:8px;align-items:center"><a class="btn primary" href="${esc(dev.uri)}" target="_blank" rel="noopener">Open ${esc(dev.uri.replace(/^https:\/\//, ''))} ↗</a>
        <span class="note"><span class="spin"></span> Waiting for approval…</span><span class="spacer"></span><button class="btn" data-act="gh-device-cancel">Cancel</button></div></div>`])}${err}`;
    }
    const cli = s.cli;
    return `${group('Connect GitHub', [
      `<div class="opt"><div class="lbl"><b>GitHub CLI</b>${cli.loggedIn ? '<span class="badge">RECOMMENDED</span>' : ''}<div class="sub">${cli.loggedIn ? 'You’re logged in with <code>gh</code>. Sheepdog uses that login and stores no token.' : cli.installed ? 'Run <code>gh auth login</code> in a terminal first, then come back.' : 'Not installed (<a href="https://cli.github.com" target="_blank" rel="noopener">cli.github.com</a>).'}</div></div>
        <button class="btn ${cli.loggedIn ? 'primary' : 'solid'}" data-act="gh-cli" ${cli.installed ? '' : 'disabled'}>${busy(GH.busy === 'cli', cli.loggedIn ? 'Use gh login' : 'Check again')}</button></div>`,
      s.deviceAvailable ? `<div class="opt"><div class="lbl"><b>Sign in with GitHub</b><div class="sub">Approve Sheepdog in your browser.</div></div>
        <button class="btn solid" data-act="gh-device">${busy(GH.busy === 'device', 'Sign in…')}</button></div>` : '',
      `<div class="opt" style="flex-wrap:wrap"><div class="lbl" style="min-width:200px"><b>Personal access token</b><div class="sub"><a href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Sheepdog" target="_blank" rel="noopener">Create a token ↗</a> with <code>repo</code> and <code>read:org</code>, then paste it.</div></div>
        <div style="display:flex;gap:6px;flex:1;min-width:240px"><input class="field wide mono" id="ghToken" type="password" placeholder="ghp_… or github_pat_…" autocomplete="off"><button class="btn solid" data-act="gh-token">${busy(GH.busy === 'token', 'Connect')}</button></div></div>`,
    ])}${err}${inWizard ? '' : clientIdGroup()}`;
  }
  const via = { gh: 'GitHub CLI', token: 'personal access token', device: 'GitHub sign-in' }[s.auth];
  const repoRows = s.repos.map((r) => row(`<span class="mono">${esc(r)}</span>`, '', `<button class="btn" data-act="gh-repo-remove" data-repo="${esc(r)}">Remove</button>`));
  return `${group('Account', [`<div class="row"><span class="dot ${s.error ? 'down' : ''}"></span><div class="lbl"><div>Connected as <b>@${esc(s.login)}</b></div>
      <div class="sub ${s.error ? 'err' : ''}">${s.error ? esc(s.error) : `via ${via}${s.scopes ? ` · scopes: ${esc(s.scopes)}` : ''}`}</div></div>
      <div class="ctl"><button class="btn solid" data-act="gh-disconnect">Disconnect</button></div></div>`])}
    ${group('Repositories in the Branches view', [...repoRows, `<div class="row col">
      <div style="display:flex;gap:6px"><input class="field wide mono" id="ghRepo" data-search="gh" placeholder="owner/repo, a GitHub URL, or search your repos" value="${esc(GH.query)}" autocomplete="off" spellcheck="false">
      <button class="btn primary" data-act="gh-repo-add">${busy(GH.busy === 'repo', 'Add')}</button></div>${err}</div>
      <div class="suggest" id="ghSuggest">${ghSuggestHtml()}</div>`])}
    ${group('Tracked branches', [row('Branches', 'Columns, left to right, comma separated',
      `<input class="field mono" id="ghBranches" value="${esc(s.branches.join(', '))}" style="width:200px" spellcheck="false"><button class="btn solid" data-act="gh-branches">Save</button>`)])}
    ${inWizard ? '' : clientIdGroup()}`;
}
function clientIdGroup() {
  return group('Sign in with GitHub (optional)', [row('OAuth app client ID',
    'To offer “Sign in with GitHub”, register an OAuth app at <a href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a> with Device Flow enabled.',
    field('github.clientId', 'Ov23li…', 'class="field mono" style="width:180px" spellcheck="false"'))]);
}
function ghSuggestHtml() {
  const list = GH.suggestions;
  if (!list) return '';
  const have = new Set(GH.status?.repos || []);
  const items = list.filter((r) => !have.has(r.fullName));
  if (!items.length) return GH.query ? `<div class="note" style="padding:8px 12px">No matching repositories. You can still add owner/repo directly.</div>` : '';
  return items.map((r) => `<button data-act="gh-repo-add" data-repo="${esc(r.fullName)}"><span class="mono">${esc(r.fullName)}</span>${r.private ? '🔒' : ''}<span class="meta2">pushed ${agoMs(Date.parse(r.pushedAt))}</span></button>`).join('');
}

// ---------------------------------------------------------------- Slack (pane + wizard step)
async function loadSl() {
  try { SL.status = await api('/api/slack/status'); SL.err = ''; } catch (e) { SL.err = e.message; }
  rerender();
}

function slackBody(inWizard) {
  const s = SL.status;
  if (!s) return `<div class="note"><span class="spin"></span> Checking Slack…</div>`;
  const err = SL.err ? `<div class="sub err" style="font-size:12px">${esc(SL.err)}</div>` : '';
  const tokenInput = `<div style="display:flex;gap:6px"><input class="field wide mono" id="slToken" type="password" placeholder="xoxb-… or xoxp-…" autocomplete="off"><button class="btn solid" data-act="sl-token">${busy(SL.busy === 'token', 'Connect')}</button></div>${err}`;
  if (!s.connected) {
    return `${group('Use your team’s Sheepdog bot', [`<div class="row col" style="gap:10px">
      <div class="wiz-p" style="margin:0">If someone on your team already set Sheepdog up, ask them for the bot token (<code>xoxb-…</code>) and paste it here. Then pick the review channel and yourself.</div>
      ${tokenInput}
    </div>`])}
    ${group('Or set it up for your team', [`<div class="row col" style="gap:12px">
      <ol class="steps">
        <li><a href="${esc(s.manifestUrlBot)}" target="_blank" rel="noopener"><b>Create the Sheepdog bot</b> ↗</a>: Slack opens with everything filled in. Pick your workspace, then <b>Create</b>.</li>
        <li>Click <b>Install to Workspace</b> and <b>Allow</b>. (Admins may need to approve it.)</li>
        <li>In the review channel, type <code>/invite @Sheepdog</code>.</li>
        <li>Under <b>OAuth &amp; Permissions</b>, copy the <b>Bot User OAuth Token</b> (<code>xoxb-…</code>), paste it above, and share it with your team through a password manager.</li>
      </ol>
      <div class="note">The bot only reads messages and reactions in channels it’s invited to, and sees channel and member names like any workspace member. Nothing is posted, and the token stays on each computer.
        Prefer not to invite a bot? <a href="${esc(s.manifestUrl)}" target="_blank" rel="noopener">Create a personal app</a> instead and paste its User OAuth Token (<code>xoxp-…</code>): it reads with your own access.</div>
    </div>`])}`;
  }
  const chan = s.channelId ? `#${esc(s.channelName)}` : 'None picked';
  const chanSub = !s.channelId ? 'Pick the channel where your team posts pull requests' : s.error ? `<span class="err">${esc(s.error)}</span>` : `${s.prCount} open PR${s.prCount === 1 ? '' : 's'} found`;
  const kindSub = s.kind === 'user' ? `Your personal token · connected as ${esc(s.user)}` : `Team bot token${s.user ? ` · you are ${esc(s.user)}` : ''} · the bot must be in the review channel`;
  return `${group('Workspace', [`<div class="row"><span class="dot"></span><div class="lbl"><div><b>${esc(s.team)}</b></div>
      <div class="sub">${kindSub}</div></div>
      <div class="ctl"><button class="btn solid" data-act="sl-disconnect">Disconnect</button></div></div>`,
      ...(s.kind === 'user' && !inWizard ? [`<div class="row col" style="gap:8px"><div class="lbl"><div>Switch to your team’s bot token</div>
        <div class="sub">Reads only the channels the bot is invited to. Your personal token is revoked in Slack once the bot token works.</div></div>${tokenInput}</div>`] : [])])}
    ${s.kind === 'bot' ? group('You', [row(s.userId ? `You are <b>${esc(s.user || s.userId)}</b>` : 'Who are you?',
        'A bot token doesn’t say who you are. Pick yourself so “Yours” and PR alerts find your PRs (with GitHub connected, PRs you author are found either way).', ''),
      `<div class="row col"><input class="field wide" id="slMe" data-search="slme" placeholder="Search the review channel’s members" value="${esc(SL.meQuery)}" autocomplete="off"></div>
      <div class="suggest" id="slMeSuggest">${slMeHtml()}</div>`]) : ''}
    ${group('Review channel', [row(chan, chanSub, ''), `<div class="row col"><input class="field wide" id="slChan" data-search="sl" placeholder="Search channels" value="${esc(SL.query)}" autocomplete="off">${err}</div>
      <div class="suggest" id="slSuggest">${slSuggestHtml()}</div>`])}
    ${inWizard ? '' : group('Reactions', [
      row('Reviewing', 'Someone has started reviewing. Emoji names, comma-separated; any of them counts', emojiField('slack.reviewing', 'eyes, mag')),
      row('Approved', 'Removes the PR from the sidebar. Emoji names, comma-separated', emojiField('slack.approved', 'white_check_mark, heavy_check_mark')),
    ])}
    ${inWizard ? '' : group('History', [row('Look back', 'Older posts leave the sidebar', select('slack.lookbackDays', [[3, '3 days'], [7, '1 week'], [14, '2 weeks'], [30, '30 days']], 'number'))])}`;
}
function slMeHtml() {
  const list = SL.members;
  if (!list) return '';
  if (!list.length) return `<div class="note" style="padding:8px 12px">No one matches.</div>`;
  return list.map((u) => `<button data-act="sl-me" data-id="${esc(u.id)}">${esc(u.name)}<span class="meta2">${u.real && u.real !== u.name ? esc(u.real) : ''}</span></button>`).join('');
}
function slSuggestHtml() {
  const list = SL.channels;
  if (!list) return '';
  if (!list.length) return `<div class="note" style="padding:8px 12px">No channels match.</div>`;
  return list.map((c) => `<button data-act="sl-channel" data-id="${esc(c.id)}" data-name="${esc(c.name)}">${c.private ? '🔒' : '#'} ${esc(c.name)}
    <span class="meta2">${c.member ? '' : 'not a member · '}${c.members ?? ''} members</span></button>`).join('');
}

// ---------------------------------------------------------------- settings window
const PANES = [
  ['access', 'Access', '🔑'], ['pastures', 'Machines', '🐑'], ['alerts', 'Alerts', '🔔'], ['board', 'Board', '▦'], ['slack', 'Slack', '#'],
  ['github', 'GitHub', '⎇'], ['herder', 'Herder', '>☰'], ['tickets', 'Tickets', '⌗'], ['terminal', 'Terminal', '>_'], ['advanced', 'Advanced', '⚙︎'],
];
function renderSettings() {
  const dot = (id) => {
    if (id === 'slack') return `<span class="st" style="background:${S?.slack.connected ? (S.slack.error ? 'var(--red)' : 'var(--green)') : 'transparent'}"></span>`;
    if (id === 'access' && ACCESS.data) { const bad = accessItems(false).filter((i) => !i.ok).length; return `<span class="st" style="background:${bad ? 'var(--amber)' : 'var(--green)'}"></span>`; }
    if (id === 'github') return `<span class="st" style="background:${S?.github.connected ? (S.github.error ? 'var(--red)' : 'var(--green)') : 'transparent'}"></span>`;
    return '';
  };
  const body = {
    access: paneAccess, herder: paneHerder, pastures: panePastures, alerts: paneAlerts, board: paneBoard, tickets: paneTickets, terminal: paneTerminal, advanced: paneAdvanced,
    github: () => `<div class="pane-head">GitHub</div><div class="note">Used for the Branches view, the live state of pull requests in the sidebar, and (with GitHub as the review source in Settings › Board) the sidebar itself: open PRs in these repositories.</div>${githubBody(false)}`,
    slack: () => `<div class="pane-head">Slack</div><div class="note">The PR review sidebar reads one Slack channel. 👀 means someone is reviewing; ✅ approved PRs drop off.</div>${slackBody(false)}`,
  }[UI.pane]();
  $('prefs').innerHTML = `<nav><div class="navt">SHEEPDOG SETTINGS</div>${PANES.map(([id, name, g]) =>
    `<button class="${UI.pane === id ? 'on' : ''}" data-act="pane" data-pane="${id}"><span class="g">${g}</span>${name}${dot(id)}</button>`).join('')}</nav>
    <div class="pane">${body.replace('<div class="pane-head">', '<div class="pane-head">').replace(/(<div class="pane-head">[^<]*)/, '$1<button class="btn solid" data-act="close">Done</button>')}</div>`;
}

function openPane(pane) {
  UI.pane = pane;
  if (pane === 'github') loadGh();
  if (pane === 'access') { if (!TERM.installed) api('/api/detect').then((d) => { TERM.installed = d.terminals; TERM.cmuxMode = d.cmux; }, () => {}); loadAccess(); }
  if (pane === 'slack') loadSl();
  if (pane === 'pastures' && !UI.sshHosts) api('/api/ssh-hosts').then((h) => { UI.sshHosts = h; rerender(); }, () => {});
  if (pane === 'terminal') {
    if (!TERM.installed) api('/api/detect').then((d) => { TERM.installed = d.terminals; TERM.cmuxMode = d.cmux; rerender(); }, () => {});
    else api('/api/terminal/cmux').then((m) => { TERM.cmuxMode = m; rerender(); }, () => {});
  }
}

async function openSettings(pane) {
  if (!cfg) await loadConfig();
  closeAll();
  openPane(pane || UI.pane);
  $('settingsScrim').hidden = false;
  renderSettings();
}

// ---------------------------------------------------------------- setup wizard
const STEPS = ['welcome', 'mac', 'machines', 'terminal', 'github', 'slack', 'alerts', 'done'];
function wizardHtml() {
  const step = STEPS[WZ.step];
  let body = '';
  let center = false;
  if (step === 'welcome') {
    center = true;
    body = `<div class="hero"><span>🐕</span><span class="flock"><span>🐑</span><span>🐑</span><span>🐑</span></span></div>
      <div class="wiz-h">Let’s find your flock</div>
      <div class="wiz-p" style="max-width:380px">Sheepdog watches Claude Code, Codex, Gemini CLI and Antigravity on this computer and your other machines, and tells you the moment one is waiting for you.</div>`;
  } else if (step === 'mac') {
    const d = WZ.detect;
    const local = d?.local;
    body = `<div style="display:flex;gap:12px;align-items:center"><img src="/icon.svg" alt="" width="40" height="40"><div><div class="wiz-h">Sniffing this computer…</div><div class="wiz-p">Looking for Claude Code, Codex, Gemini CLI and Antigravity in your terminals.</div></div></div>
      ${!d ? '<div class="note"><span class="spin"></span> Looking…</div>' : group('', [
        `<div class="found"><span class="${local.ok ? 'tick' : 'err'}">${local.ok ? '✓' : '✕'}</span><div class="lbl"><div>${local.ok ? esc(local.summary[0].toUpperCase() + local.summary.slice(1)) : 'Could not run the probe'}</div><div class="sub ${local.ok ? '' : 'err'}">${local.ok ? esc(local.host) : esc(local.error)}</div></div>${local.ok && local.agents ? '<span>🐑</span>' : ''}</div>`,
        `<div class="found"><span class="tick">✓</span><div class="lbl"><div>Terminals</div><div class="sub">${[d.terminals.cmux && 'cmux', d.terminals.iterm && 'iTerm2'].filter(Boolean).join(', ') || 'No supported terminal found; cards still work, without jump-to-tab'}</div></div></div>`,
      ])}`;
  } else if (step === 'machines') {
    const hosts = WZ.detect?.sshHosts || [];
    const rows = hosts.map((h) => {
      const r = WZ.results[h];
      const on = WZ.selected.has(h);
      return `<div class="found"><button class="check ${on ? 'on' : ''}" data-act="wz-host" data-ssh="${esc(h)}">${on ? '✓' : ''}</button>
        <div class="lbl"><div class="mono">${esc(h)}</div><div class="sub ${r && !r.busy ? (r.ok ? 'ok' : 'err') : ''}">${r ? (r.busy ? '<span class="spin"></span> Testing…' : r.ok ? esc(`Connected · ${r.summary}`) : esc(r.error) + fixHtml(r.fix)) : 'Not checked'}</div></div>
        <button class="btn solid" data-act="wz-host-test" data-ssh="${esc(h)}">Test</button></div>`;
    });
    body = `<div><div class="wiz-h">Other pastures</div><div class="wiz-p">Machines from <code>~/.ssh/config</code>. Pick the ones running agents. They need key-based SSH and <code>python3</code>.</div></div>
      ${rows.length ? group('', rows) : '<div class="note">No hosts in ~/.ssh/config.</div>'}
      <div style="display:flex;gap:6px"><input class="field wide mono" id="wzHost" placeholder="Another machine: alias or user@host" autocomplete="off" spellcheck="false"><button class="btn solid" data-act="wz-host-add">Add</button></div>
      <div class="note">You can skip this and add machines later in Settings › Machines.</div>`;
  } else if (step === 'terminal') {
    if (!TERM.installed && WZ.detect) { TERM.installed = WZ.detect.terminals; TERM.cmuxMode = WZ.detect.cmux; }
    if (!ACCESS.data && !ACCESS.busy) loadAccess();
    body = `<div><div class="wiz-h">Give Sheepdog access</div><div class="wiz-p">A few things need your permission: notifications, switching to an agent’s terminal tab, and the machines you picked. Each button opens the right setting. Sheepdog reads tab titles and selects tabs. It reads a tab’s screen or types into it only when you press ↩ Answer on an agent.</div></div>
      ${accessHtml(true)}
      <div class="note">You can come back to this any time in Settings › Access.</div>`;
  } else if (step === 'github') {
    body = `<div><div class="wiz-h">Connect GitHub <span class="badge">OPTIONAL</span></div><div class="wiz-p">Shows the last merge on each branch of the repositories you pick, and whether PRs in the sidebar are merged or failing checks.</div></div>${githubBody(true)}`;
  } else if (step === 'slack') {
    body = `<div><div class="wiz-h">Connect Slack <span class="badge">OPTIONAL</span></div><div class="wiz-p">The sidebar shows pull requests from your team’s review channel: 👀 who is reviewing; approved ones drop off.</div></div>${slackBody(true)}`;
  } else if (step === 'alerts') {
    body = `<div><div class="wiz-h">How should I get your attention?</div><div class="wiz-p">A notification when an agent is waiting, plus a sound.</div></div>
      ${group('', [row('Notifications', 'Banners; click one to jump to the tab', notifStatus())])}
      <div class="sounds">${[['🐕', 'Woof'], ['🔔', 'Ding'], ['🐑', 'Bleat'], ['🔕', 'Silent']].map(([g, n]) =>
        `<button class="${cfg.alerts.sound === n ? 'on' : ''}" data-act="sound-pick" data-sound="${n}"><span class="g">${g}</span><span>${n}</span><span class="p">${n === 'Silent' ? '&nbsp;' : '▶ Play'}</span></button>`).join('')}</div>`;
  } else {
    center = true;
    const agents = S ? agentsOf(S).length : 0;
    const machines = cfg.hosts.filter((h) => h.enabled).length;
    body = `<div class="hero"><span class="flock">${'<span>🐑</span>'.repeat(Math.min(6, Math.max(1, agents)))}</span><span>🐕</span></div>
      <div class="wiz-h">Your flock is being watched. Go focus.</div>
      <div class="wiz-p">${agents} agent${agents === 1 ? '' : 's'} on ${machines} machine${machines === 1 ? '' : 's'}. ${NATIVE ? 'Sheepdog lives in your menu bar.' : 'Keep this tab open, or pin it.'} Change anything later in Settings (⌘,).</div>`;
  }
  const last = WZ.step === STEPS.length - 1;
  const optional = step === 'github' || step === 'slack' || step === 'machines';
  const next = WZ.step === 0 ? 'Get started' : last ? 'Open board' : 'Continue';
  return `<div class="wiz-body ${center ? 'center' : ''}">${body}</div>
    <div class="wiz-foot"><div class="wiz-dots">${STEPS.map((_, i) => `<i class="${i === WZ.step ? 'on' : ''}"></i>`).join('')}</div>
      ${WZ.step > 0 && !last ? '<button class="btn solid big" data-act="wz-back">Back</button>' : ''}
      ${optional ? '<button class="btn big" data-act="wz-skip">Skip</button>' : ''}
      <button class="btn primary big" data-act="wz-next">${next}</button></div>`;
}
function renderWizard() { $('wizard').innerHTML = wizardHtml(); }

async function openWizard() {
  if (!cfg) await loadConfig();
  closeAll();
  WZ.step = 0;
  WZ.detect = null;
  WZ.results = {};
  WZ.selected = new Set(cfg.hosts.filter((h) => h.type === 'ssh').map((h) => h.ssh));
  $('wizardScrim').hidden = false;
  renderWizard();
  api('/api/detect').then((d) => { WZ.detect = d; renderWizard(); }, (e) => toast(e.message, true));
  loadGh();
  loadSl();
}

async function wizardEnterStep() {
  const step = STEPS[WZ.step];
  if (step === 'done') await setConfig({ setupComplete: true });
  renderWizard();
}

async function saveWizardHosts() {
  const hosts = WZ.detect?.sshHosts || [];
  for (const ssh of hosts) {
    const have = cfg.hosts.find((h) => h.ssh === ssh);
    if (WZ.selected.has(ssh) && !have) await api('/api/hosts/add', { ssh, name: ssh });
    if (!WZ.selected.has(ssh) && have) await api('/api/hosts/remove', { id: have.id });
  }
  await loadConfig();
}

// ---------------------------------------------------------------- re-render open overlays
function rerender() {
  if (!$('settingsScrim').hidden) {
    const a = document.activeElement;
    const keep = a && a.id && $('prefs').contains(a) ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
    renderSettings();
    if (keep && $(keep.id)) { const el = $(keep.id); el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch {} }
  }
  if (!$('wizardScrim').hidden) {
    const a = document.activeElement;
    const keep = a && a.id && $('wizard').contains(a) ? { id: a.id, v: a.value } : null;
    renderWizard();
    if (keep && $(keep.id)) { const el = $(keep.id); el.value = keep.v; el.focus(); }
  }
}
function closeAll() { for (const id of ['branchesScrim', 'statsScrim', 'lbScrim', 'tabScrim', 'replyScrim', 'settingsScrim', 'wizardScrim']) $(id).hidden = true; $('tip').hidden = true; }

// ---------------------------------------------------------------- actions
const actions = {
  settings: (el) => openSettings(el.dataset.pane),
  pane: (el) => { openPane(el.dataset.pane); renderSettings(); },
  close: () => { closeAll(); if (WZ.step !== undefined && !cfg?.setupComplete) setConfig({ setupComplete: true }); },
  branches: () => { closeAll(); $('branchesScrim').hidden = false; renderBranches(); },
  stats: () => { closeAll(); $('statsScrim').hidden = false; loadStats(); },
  'today-open': () => { UI.statsDays = 1; actions.stats(); },
  leaderboard: () => { closeAll(); $('lbScrim').hidden = false; loadLeaderboard(); },
  'lb-days': (el) => { UI.lbDays = Number(el.dataset.days); loadLeaderboard(); },
  'tickets-accept': async () => {
    const t = S.ticketSuggestion;
    if (!t) return;
    const patch = {};
    if (t.pattern) patch['tickets.pattern'] = t.pattern;
    if (t.link) patch['tickets.link'] = t.link;
    await setConfig(patch);
    toast('Tickets set up');
    rerender();
  },
  'tickets-dismiss': async () => { await setConfig({ 'tickets.suggestDismissed': true }); toast('OK. Change it any time in Settings › Tickets'); },
  'access-check': () => loadAccess(),
  'access-open': async (el) => {
    try {
      const r = await api('/api/access/open', { what: el.dataset.what });
      if (el.dataset.what === 'cmux-settings') toast(r.direct ? 'Opened cmux › Settings › Automation' : 'Opened cmux: now ⌘, › Automation');
    } catch (e) { toast(e.message, true); }
  },
  copy: async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.text); toast('Copied. Paste it in Terminal'); }
    catch { toast(el.dataset.text); }
  },
  'stats-days': (el) => { UI.statsDays = Number(el.dataset.days); loadStats(); },
  'stats-clear': async () => {
    if (!confirm('Delete all Sheepdog statistics? This can’t be undone.')) return;
    try { await api('/api/stats/clear', {}); UI.stats = null; UI.statsAt = 0; toast('Statistics cleared'); } catch (e) { toast(e.message, true); }
  },
  wizard: () => openWizard(),
  focus: (el, e) => {
    if (!el.dataset.key) { toast('This agent doesn’t run in a terminal tab', true); return; }
    // not matched yet (or ⌥-click to correct a wrong match): let the person pick the tab
    if (el.dataset.ok !== '1' || e?.altKey) { openTabPicker(el.dataset.key, el.dataset.title || ''); return; }
    focusAgent(el.dataset.key);
  },
  reply: (el) => openReply(el.dataset.key, el.dataset.title),
  'herder-toggle': () => { HD.open = $('herder').hidden; HD.closedFor = HD.open ? '' : turnSig(); renderHerder(); if (HD.open) $('herderInput').focus(); },
  'herder-close': () => { HD.open = false; HD.closedFor = turnSig(); renderHerder(); },
  'herder-send': () => herderSend(),
  'herder-reset': async () => { try { HD.state = await api('/api/herder/reset', {}); HD.rev = HD.state.rev; renderHerderLog(); } catch (e) { toast(e.message, true); } },
  'herder-confirm': async (el) => { try { HD.state = await api('/api/herder/confirm', { id: el.dataset.id, ok: el.dataset.ok === '1' }); HD.rev = HD.state.rev; renderHerderLog(); } catch (e) { toast(e.message, true); } },
  tchip: (el) => (el.dataset.reply === '1' ? openReply(el.dataset.key, el.dataset.title) : focusAgent(el.dataset.key)),
  'hd-open': (el) => focusAgent(el.dataset.key),
  'herder-prov': (el) => { HK.provider = el.dataset.p; renderSettings(); },
  'herder-key': async () => {
    const provider = HK.provider || cfg.herder.provider;
    const key = $('herderKey').value.trim();
    const baseUrl = $('herderBase')?.value.trim() || '';
    if (!key && provider !== 'openai') return;
    try {
      const r = await api('/api/herder/key', { key, provider, baseUrl });
      HK.models = r.models; HK.provider = null; HD.rev = -1;
      await loadConfig(); renderSettings(); toast(`Connected. Herder uses ${r.model}`);
    } catch (e) { toast(e.message, true); }
  },
  'herder-key-clear': async () => { await api('/api/herder/key/clear', {}); HK.models = null; HD.rev = -1; await loadConfig(); renderSettings(); toast('Key removed'); },
  'review-github': async () => { await setConfig({ 'reviews.source': 'github' }); if (!S.github.connected || !S.reviews.ready) openSettings('github'); poll(true); },
  'reply-key': (el) => sendReply(el.dataset.text != null ? { text: el.dataset.text, enter: false } : { press: el.dataset.press }),
  'reply-send': () => { const i = $('replyInput'); sendReply({ text: i.value }); i.value = ''; i.focus(); },
  'reply-open': () => { const k = UI.reply?.key; closeAll(); if (k) focusAgent(k); },
  'tab-pick': async (el) => {
    try {
      const r = await api('/api/focus/link', { key: UI.tabKey, id: el.dataset.id });
      closeAll();
      if (!r.ok) toast(r.error || 'Could not open the tab', true); else toast('Got it. Sheepdog will remember this tab');
      poll(true);
    } catch (e) { toast(e.message, true); }
  },
  toggle: (el) => setConfig({ [el.dataset.key]: !get(cfg, el.dataset.key) }).then(rerender),
  play: () => window.SheepdogSounds.play(cfg.alerts.sound),
  'sound-pick': async (el) => { window.SheepdogSounds.play(el.dataset.sound); await setConfig({ 'alerts.sound': el.dataset.sound }); rerender(); },
  'notif-allow': async () => { if (NATIVE) { native({ type: 'requestNotifications' }); return; } if ('Notification' in window) await Notification.requestPermission(); rerender(); },
  reset: async () => {
    if (!confirm('Reset all Sheepdog settings? This forgets your machines and disconnects GitHub and Slack.')) return;
    await api('/api/reset', {});
    await loadConfig();
    GH.status = null; SL.status = null;
    openWizard();
  },

  // machines
  'host-toggle': async (el) => {
    const h = cfg.hosts.find((x) => x.id === el.dataset.id);
    await api('/api/hosts/update', { id: h.id, enabled: !h.enabled }).catch((e) => toast(e.message, true));
    await loadConfig(); rerender();
  },
  'host-test': async (el) => {
    const id = el.dataset.id;
    UI.hostTest[id] = { busy: true }; rerender();
    try {
      const r = await api('/api/hosts/test', { id });
      UI.hostTest[id] = { ok: r.ok, text: r.ok ? `Connected in ${r.ms} ms · ${r.summary}` : r.error, fix: r.fix };
    } catch (e) { UI.hostTest[id] = { ok: false, text: e.message }; }
    rerender();
    setTimeout(() => { delete UI.hostTest[id]; rerender(); }, 8000);
  },
  'host-remove': async (el) => {
    const h = cfg.hosts.find((x) => x.id === el.dataset.id);
    if (!confirm(`Stop watching ${h.name}?`)) return;
    await api('/api/hosts/remove', { id: h.id }).catch((e) => toast(e.message, true));
    await loadConfig(); rerender();
  },
  'host-add': async () => {
    const ssh = ($('newHost')?.value || '').trim();
    UI.newHost = ssh;
    if (!ssh) { toast('Type an SSH alias or user@host', true); return; }
    UI.hostTest.__new = { busy: true }; rerender();
    try {
      const r = await api('/api/hosts/test', { ssh });
      if (!r.ok) { UI.hostTest.__new = { ok: false, text: `Couldn’t connect: ${r.error}`, fix: r.fix }; rerender(); return; }
      await api('/api/hosts/add', { ssh, name: ssh });
      UI.hostTest.__new = { ok: true, text: `Added ${ssh} · ${r.summary}` };
      UI.newHost = '';
      await loadConfig();
    } catch (e) { UI.hostTest.__new = { ok: false, text: e.message }; }
    rerender();
  },

  // terminal
  'term-allow': async (el) => {
    const app = el.dataset.app;
    TERM[app] = 'busy'; rerender();
    const r = await api('/api/terminal/allow', { app }).catch((e) => ({ ok: false, error: e.message }));
    TERM[app] = r.ok ? 'ok' : 'err';
    if (app === 'cmux') TERM.cmuxMode = await api('/api/terminal/cmux').catch(() => TERM.cmuxMode);
    if (!r.ok) toast(`${app === 'iterm' ? 'iTerm2' : 'cmux'}: ${r.error}`, true);
    rerender();
  },
  'cmux-pw': async () => {
    await api('/api/terminal/cmux-password', { password: $('cmuxPw').value }).then(() => toast('Saved'), (e) => toast(e.message, true));
    await loadConfig(); rerender();
  },

  // github
  'gh-cli': async () => ghConnect('cli', () => api('/api/github/use-cli', {})),
  'gh-token': async () => {
    const token = $('ghToken').value; // read before ghConnect re-renders the pane (which empties the field)
    return ghConnect('token', () => api('/api/github/token', { token }));
  },
  'gh-device': async () => {
    GH.busy = 'device'; GH.err = ''; rerender();
    try { GH.device = await api('/api/github/device/start', {}); pollDevice(); } catch (e) { GH.err = e.message; }
    GH.busy = ''; rerender();
  },
  'gh-device-cancel': async () => { await api('/api/github/device/cancel', {}); GH.device = null; rerender(); },
  'gh-disconnect': async () => {
    if (!confirm('Disconnect GitHub? Your repository list is kept.')) return;
    await api('/api/github/disconnect', {}); GH.suggestions = null; loadGh(); poll(true);
  },
  'gh-repo-add': async (el) => {
    const input = el.dataset.repo || ($('ghRepo')?.value || '').trim();
    if (!input) { toast('Type owner/repo or pick one from the list', true); return; }
    GH.busy = 'repo'; GH.err = ''; rerender();
    try {
      const r = await api('/api/github/repos/validate', { repo: input });
      await api('/api/github/repos', { repos: [...GH.status.repos, r.fullName] });
      GH.query = ''; GH.suggestions = null;
      toast(`Added ${r.fullName}`);
      await loadGh();
      poll(true);
    } catch (e) { GH.err = e.message; }
    GH.busy = ''; rerender();
  },
  'gh-repo-remove': async (el) => {
    await api('/api/github/repos', { repos: GH.status.repos.filter((r) => r !== el.dataset.repo) });
    await loadGh(); poll(true);
  },
  'gh-branches': async () => {
    const list = $('ghBranches').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length) { toast('Add at least one branch', true); return; }
    await setConfig({ 'github.branches': list });
    await loadGh();
    toast('Saved');
  },

  // slack
  'sl-token': async () => {
    const token = $('slToken').value; // read before re-rendering, which empties the field
    SL.busy = 'token'; SL.err = ''; rerender();
    try {
      const r = await api('/api/slack/token', { token });
      toast(r.kind === 'bot' ? `Connected to ${r.team} with the team bot` : `Connected to ${r.team}`);
      await loadSl();
      searchChannels('');
      if (r.kind === 'bot' && !SL.status?.userId) searchMembers('');
    } catch (e) { SL.err = e.message; }
    SL.busy = ''; rerender();
  },
  'sl-disconnect': async () => {
    const personal = SL.status?.kind === 'user';
    if (!confirm(personal ? 'Disconnect Slack? Your personal Slack token is also revoked in Slack, so it stops working everywhere.' : 'Disconnect Slack? (The team’s bot token keeps working for everyone else.)')) return;
    await api('/api/slack/disconnect', {}); SL.channels = null; loadSl(); poll(true);
  },
  'sl-me': async (el) => {
    try { const me = await api('/api/slack/me', { id: el.dataset.id }); toast(`Got it, you’re ${me.name}`); SL.members = null; SL.meQuery = ''; }
    catch (e) { toast(e.message, true); }
    await loadSl(); poll(true);
  },
  'sl-channel': async (el) => {
    SL.err = '';
    toast(`Reading #${el.dataset.name}…`);
    try {
      const r = await api('/api/slack/channel', { id: el.dataset.id, name: el.dataset.name });
      if (r.error) SL.err = r.error; else toast(`#${el.dataset.name}: ${r.prCount} open PR${r.prCount === 1 ? '' : 's'} found`);
      SL.channels = null; SL.query = '';
    } catch (e) { SL.err = e.message; }
    await loadSl(); poll(true);
  },

  // wizard
  'wz-next': async () => {
    if (STEPS[WZ.step] === 'machines') await saveWizardHosts().catch((e) => toast(e.message, true));
    if (WZ.step === STEPS.length - 1) { closeAll(); return; }
    WZ.step++;
    wizardEnterStep();
  },
  'wz-skip': () => { WZ.step++; wizardEnterStep(); },
  'wz-back': () => { WZ.step = Math.max(0, WZ.step - 1); renderWizard(); },
  'wz-host': (el) => { const h = el.dataset.ssh; WZ.selected.has(h) ? WZ.selected.delete(h) : WZ.selected.add(h); renderWizard(); },
  'wz-host-test': async (el) => {
    const ssh = el.dataset.ssh;
    WZ.results[ssh] = { busy: true }; renderWizard();
    WZ.results[ssh] = await api('/api/hosts/test', { ssh }).catch((e) => ({ ok: false, error: e.message }));
    if (WZ.results[ssh].ok) WZ.selected.add(ssh);
    renderWizard();
  },
  'wz-host-add': async () => {
    const ssh = ($('wzHost')?.value || '').trim();
    if (!ssh) return;
    WZ.detect.sshHosts = [...new Set([...(WZ.detect.sshHosts || []), ssh])];
    WZ.selected.add(ssh);
    actions['wz-host-test']({ dataset: { ssh } });
  },
};

async function ghConnect(kind, fn) {
  GH.busy = kind; GH.err = ''; rerender();
  try { const me = await fn(); toast(`Connected as @${me.login}`); await loadGh(); searchRepos(''); poll(true); }
  catch (e) { GH.err = e.message; if (kind === 'cli') await loadGh(); }
  GH.busy = ''; rerender();
}

async function pollDevice() {
  while (GH.device) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!GH.device) return;
    const st = await api('/api/github/device/status').catch(() => null);
    if (!st) continue;
    if (st.status === 'done') { GH.device = null; toast(`Connected as @${st.login}`); await loadGh(); searchRepos(''); poll(true); return; }
    if (st.status !== 'pending') { GH.device = null; GH.err = st.status === 'expired' ? 'The code expired. Try again.' : st.error || 'Sign-in failed'; rerender(); return; }
  }
}

let searchTimer = null;
async function searchRepos(q) {
  GH.query = q;
  try { GH.suggestions = await api(`/api/github/repos?q=${encodeURIComponent(q)}`); } catch { GH.suggestions = null; }
  const box = $('ghSuggest'); if (box) box.innerHTML = ghSuggestHtml();
}
async function searchMembers(q) {
  SL.meQuery = q;
  try { SL.members = await api(`/api/slack/members?q=${encodeURIComponent(q)}`); } catch (e) { SL.members = null; toast(e.message, true); }
  const box = $('slMeSuggest'); if (box) box.innerHTML = slMeHtml();
}
async function searchChannels(q) {
  SL.query = q;
  try { SL.channels = await api(`/api/slack/channels?q=${encodeURIComponent(q)}`); SL.err = ''; } catch (e) { SL.channels = null; SL.err = e.message; }
  const box = $('slSuggest'); if (box) box.innerHTML = slSuggestHtml();
}

// ---------------------------------------------------------------- events
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-stop]')) { e.stopPropagation(); return; }
  const f = e.target.closest('#prFilter button');
  if (f) { UI.prFilter = f.dataset.f; renderPrs(); return; }
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) {
    if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
    actions[el.dataset.act](el, e);
    return;
  }
  if (e.target.classList.contains('scrim') && e.target.id !== 'wizardScrim') closeAll();
});
// hover tooltips for chart marks
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[data-tip]');
  const tip = $('tip');
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  tip.style.top = `${r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8}px`;
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'newHostPick' && el.value) { UI.newHost = el.value; const i = $('newHost'); if (i) i.value = el.value; return; }
  if (!el.dataset.set) return;
  const v = el.dataset.type === 'number' ? Number(el.value) : el.value;
  setConfig({ [el.dataset.set]: v }).then(() => { if (el.tagName === 'SELECT') rerender(); });
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'newHost') UI.newHost = el.value;
  const kind = el.dataset.search;
  if (!kind) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => (kind === 'gh' ? searchRepos(el.value.trim()) : kind === 'slme' ? searchMembers(el.value.trim()) : searchChannels(el.value.trim())), 250);
});
document.addEventListener('focusin', (e) => {
  const kind = e.target.dataset?.search;
  if (kind === 'gh' && !GH.suggestions) searchRepos(e.target.value.trim());
  if (kind === 'sl' && !SL.channels) searchChannels(e.target.value.trim());
  if (kind === 'slme' && !SL.members) searchMembers(e.target.value.trim());
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  if (e.key === 'Escape' && $('wizardScrim').hidden) closeAll();
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'herderInput') { e.preventDefault(); herderSend(); return; }
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    const map = { ghToken: 'gh-token', ghRepo: 'gh-repo-add', slToken: 'sl-token', newHost: 'host-add', wzHost: 'wz-host-add', ghBranches: 'gh-branches', cmuxPw: 'cmux-pw', replyInput: 'reply-send', herderKey: 'herder-key', herderBase: 'herder-key' };
    const act = map[e.target.id];
    if (act) { e.preventDefault(); actions[act]({ dataset: {} }); }
  }
});

// ---------------------------------------------------------------- polling
let lastPoll = 0;
async function poll(once) {
  try {
    S = await api('/api/state');
    lastPoll = Date.now();
    $('hosts').innerHTML = S.hosts.map(hostStats).join('');
    renderBoard();
    renderPrs();
    renderToday();
    renderHerder();
    prAlerts(S.events);
    if (!$('lbScrim').hidden && Date.now() - UI.lbAt > 60e3) loadLeaderboard(true);
    if (!$('branchesScrim').hidden) renderBranches();
    if (!$('statsScrim').hidden && Date.now() - UI.statsAt > 60e3) loadStats(true);
    if (!$('settingsScrim').hidden && UI.pane === 'pastures' && !$('prefs').contains(document.activeElement)) renderSettings();
  } catch {
    $('hosts').innerHTML = `<div class="host"><span class="dot down"></span>${NATIVE ? 'Sheepdog’s server stopped. Use the menu bar icon to restart it.' : 'Sheepdog isn’t running. Start it with <code>npm start</code>.'}</div>`;
  }
  if (!once) setTimeout(poll, 2000);
}

// Routes the Mac app (and links) can open: #settings, #settings/<pane>, #setup, #branches, #stats, #stats/<1|7|30>
function route_(r) {
  r = String(r || '').replace(/^#/, '');
  if (!r) return;
  const [what, pane] = r.split('/');
  if (what === 'settings') openSettings(PANES.some(([id]) => id === pane) ? pane : undefined);
  else if (what === 'setup') openWizard();
  else if (what === 'branches') actions.branches();
  else if (what === 'leaderboard') { if ([1, 7, 30].includes(Number(pane))) UI.lbDays = Number(pane); actions.leaderboard(); }
  else if (what === 'stats') { if ([1, 7, 30].includes(Number(pane))) UI.statsDays = Number(pane); actions.stats(); }
  else if (what === 'board') closeAll();
  history.replaceState(null, '', location.pathname);
}
window.addEventListener('hashchange', () => route_(location.hash));

(async () => {
  await loadConfig().catch(() => {});
  await poll(true);
  setTimeout(poll, 2000);
  native({ type: 'ready' });
  if (location.hash) route_(location.hash);
  else if (cfg && !cfg.setupComplete) openWizard();
})();
