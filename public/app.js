// Sheepdog board, settings and setup wizard. Plain JS, no build step.
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Inside the Mac app the page runs in a WKWebView with a "sheepdog" message handler: notifications,
// the menu bar bark and permissions go through the app instead of the browser.
const NATIVE = window.webkit?.messageHandlers?.sheepdog || null;
const native = (msg) => { try { NATIVE?.postMessage(msg); } catch {} };
window.sheepdogNative = { notif: 'unknown', setNotif(s) { this.notif = s; rerender(); }, open(route) { route_(route); } };
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
const UI = { prFilter: 'all', pane: 'pastures', hostTest: {}, sshHosts: null, newHost: '' };
const GH = { status: null, busy: '', err: '', device: null, suggestions: null, query: '' };
const SL = { status: null, busy: '', err: '', channels: null, query: '' };
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
  const title = a.title || a.prompt || `${a.kind === 'codex' ? 'Codex' : 'Claude'} in ${a.repo || '?'}`;
  const pct = a.contextPct;
  const tok = fmtTokens(a.tokens);
  const warn = pct != null && pct >= 85;
  const ctx = pct != null || tok ? `<div class="ctx ${warn ? 'warn' : ''}"><span class="bar"><i style="width:${Math.min(100, pct || 0)}%"></i></span>
      ${pct != null ? `<span class="pct">${pct}% context</span>` : ''}${pct != null && tok ? '<span>·</span>' : ''}${tok ? `<span>${tok} tokens</span>` : ''}</div>` : '';
  return `<div class="card ${a.status} ${a.focusable ? '' : 'nofocus'}" data-act="focus" data-key="${esc(a.focusKey)}" data-ok="${a.focusable ? 1 : 0}"
      title="${esc(a.where || '')}${a.focusable ? ' · click to open its terminal tab' : ''}">
    <div class="band"><span>${label}</span><span>${dur(a.since)}</span></div>
    <div class="body">
      <div class="title">${ticketHtml(a.ticket)}<span>${esc(title)}</span></div>
      ${a.prompt && a.prompt !== title ? `<div class="prompt">${esc(a.prompt)}</div>` : ''}
      <div class="meta"><span class="chip host">${esc(a.hostName)}</span><span class="chip">${a.kind === 'codex' ? 'Codex' : 'Claude'}${a.app ? ' app' : ''}</span>${a.repo ? `<span class="repo">${esc(a.repo)}</span>` : ''}</div>
      ${ctx}
    </div>
  </div>`;
}

function renderBoard() {
  const agents = agentsOf(S);
  const board = $('board');
  const down = S.hosts.filter((h) => h.enabled && h.error && !h.ok);
  const banner = down.length ? `<div class="banner">Can't reach ${down.map((h) => `<b>${esc(h.name)}</b>`).join(', ')}: ${esc(down[0].error)} <a href="#" data-act="settings" data-pane="pastures">Check machines…</a></div>` : '';
  if (!agents.length) {
    board.innerHTML = `${banner}<div class="empty"><div class="pic">🐶</div><b>No agents running.</b><div>Start Claude Code or Codex on a watched machine<br>and it will appear here.</div></div>`;
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
      native({ type: 'notify', title: `${a.title || 'An agent'} is waiting`, body: `${a.hostName} · ${a.kind === 'codex' ? 'Codex' : 'Claude'}${a.prompt ? ` — ${a.prompt}` : ''}`, id: a.key, focusKey: a.focusable ? a.focusKey : '' });
    }
  } else if (al.notify && 'Notification' in window && Notification.permission === 'granted') {
    for (const a of fresh.slice(0, 3)) {
      const n2 = new Notification(`${a.title || 'An agent'} is waiting`, { body: `${a.hostName} · ${a.kind === 'codex' ? 'Codex' : 'Claude'}${a.prompt ? ` — ${a.prompt}` : ''}`, tag: a.key });
      n2.onclick = () => { window.focus(); if (a.focusable) focusAgent(a.focusKey); n2.close(); };
    }
  }
}

async function focusAgent(key) {
  try {
    const r = await api('/api/focus', { key });
    if (!r.ok) toast(r.error || 'Could not open the tab', true);
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- PR sidebar
function prItem(p) {
  let rv;
  if (p.reviewers.length) {
    const first = Math.min(...p.reviewers.map((r) => r.since));
    rv = `<div class="rv"><span class="ico">👀</span><div><div class="who">${esc(p.reviewers.map((r) => r.name).join(', '))} ${p.reviewers.length > 1 ? 'are' : 'is'} reviewing</div>
      <div class="sub">since ${clock(first)}</div></div></div>`;
  } else {
    rv = `<div class="rv none"><span class="ico" style="opacity:.5">👀</span><div>No one yet · posted ${agoMs(p.postedAt)}</div></div>`;
  }
  const replies = p.link ? `<div class="replies">${p.replies ? `<b>${p.replies} ${p.replies === 1 ? 'reply' : 'replies'}</b>` : ''}<a href="${esc(p.link)}" target="_blank" rel="noopener">Open in Slack ↗</a></div>` : '';
  return `<div class="pr"><a href="${esc(p.url)}" target="_blank" rel="noopener" title="Open on GitHub">
    <div class="pr-top"><span class="ci ${p.ci || ''}"></span><span>${esc(p.repo)} #${p.number}</span><span class="who">${p.yours ? 'you' : esc(p.author || '')}</span></div>
    <div class="pr-title">${esc(p.title)}</div>${rv}</a>${replies}</div>`;
}

function renderPrs() {
  const show = S.settings.board.showPrs;
  $('prside').style.display = show ? '' : 'none';
  if (!show) return;
  const sl = S.slack;
  $('prChannel').textContent = sl.channel ? `#${sl.channel}` : 'PR reviews';
  const box = $('prs');
  if (!sl.connected || !sl.channel) {
    $('prCount').textContent = '0';
    box.innerHTML = `<div class="side-empty">${sl.connected ? 'Pick the Slack channel where your team posts pull requests.' : 'See who is reviewing which pull request, straight from your team’s Slack channel.'}
      <button class="btn solid" data-act="settings" data-pane="slack">${sl.connected ? 'Pick a channel…' : 'Connect Slack…'}</button></div>`;
    return;
  }
  const all = sl.prs.filter((p) => !p.draft);
  const isOpen = (p) => !p.reviewers.length;
  const counts = { all: all.length, open: all.filter(isOpen).length, yours: all.filter((p) => p.yours).length };
  for (const b of $('prFilter').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.f === UI.prFilter);
    b.querySelector('span').textContent = counts[b.dataset.f];
  }
  $('prCount').textContent = counts.all;
  const list = (UI.prFilter === 'open' ? all.filter(isOpen) : UI.prFilter === 'yours' ? all.filter((p) => p.yours) : all)
    .slice().sort((a, b) => b.postedAt - a.postedAt);
  let html = '';
  if (sl.error) html += `<div class="sec" style="color:#F7A2A5;font-weight:500;letter-spacing:0">${esc(sl.error)}</div>`;
  html += list.length ? list.map(prItem).join('') : `<div class="side-empty">${sl.at ? 'Nothing here.' : '<span><span class="spin"></span> Reading the channel…</span>'}</div>`;
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

// ---------------------------------------------------------------- settings building blocks
const toggle = (key) => `<button class="toggle ${get(cfg, key) ? 'on' : ''}" data-act="toggle" data-key="${key}" aria-pressed="${!!get(cfg, key)}"></button>`;
const select = (key, opts, type = 'string') => `<select class="field" data-set="${key}" data-type="${type}">${opts.map(([v, l]) =>
  `<option value="${esc(v)}" ${String(get(cfg, key)) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const field = (key, ph = '', extra = '') => `<input class="field" data-set="${key}" value="${esc(get(cfg, key))}" placeholder="${esc(ph)}" ${extra}>`;
const row = (label, sub, ctl, cls = '') => `<div class="row ${cls}"><div class="lbl"><div>${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${ctl ? `<div class="ctl">${ctl}</div>` : ''}</div>`;
const group = (title, rows) => `<div>${title ? `<div class="group-title">${title}</div>` : ''}<div class="group">${rows.join('')}</div></div>`;
const busy = (on, label) => (on ? `<span class="spin"></span>` : label);

// ---------------------------------------------------------------- pane: machines
function hostSub(h) {
  const s = S?.hosts.find((x) => x.id === h.id);
  const t = UI.hostTest[h.id];
  if (t) return t.busy ? '<span class="spin"></span> Testing…' : `<span class="${t.ok ? 'ok' : 'err'}">${esc(t.text)}</span>`;
  if (!h.enabled) return h.type === 'ssh' ? `SSH · <code>${esc(h.ssh)}</code> · paused` : 'Paused';
  const where = h.type === 'ssh' ? `SSH · <code>${esc(h.ssh)}</code>` : 'This computer';
  if (!s || (!s.ok && !s.error)) return `${where} · connecting…`;
  if (!s.ok) return `<span class="err">${esc(s.error)}</span>`;
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
      ${t && !t.busy ? `<div class="sub ${t.ok ? 'ok' : 'err'}">${esc(t.text)}</div>` : ''}
      <div class="note">The machine needs SSH key login (no password prompt) and <code>python3</code>. Sheepdog runs a small read-only script there over SSH; nothing is installed.</div>
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
    ${group('Hold back', [
      row('Only alert after', 'Skip quick back-and-forth', select('alerts.alertAfterSeconds', [[0, 'Right away'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes']], 'number')),
      row('Quiet hours', `${esc(q.start)} – ${esc(q.end)} · board still updates`, `<input class="field" type="time" data-set="alerts.quietHours.start" value="${esc(q.start)}"><input class="field" type="time" data-set="alerts.quietHours.end" value="${esc(q.end)}">${toggle('alerts.quietHours.enabled')}`),
    ])}`;
}

function paneBoard() {
  return `<div class="pane-head">Board</div>
    ${group('Layout', [
      row('Density', 'Compact hides the prompt and the machine line', select('board.density', [['auto', 'Automatic (compact above 10 agents)'], ['comfortable', 'Comfortable'], ['compact', 'Compact']])),
      row('PR review sidebar', 'From your Slack review channel; hidden below 640px', toggle('board.showPrs')),
    ])}`;
}

function paneTickets() {
  return `<div class="pane-head">Tickets</div>
    ${group('Ticket IDs', [
      row('Pattern', 'Regular expression, found in titles, prompts, branches and folders', field('tickets.pattern', '', 'class="field mono" style="width:220px" spellcheck="false"')),
      row('Link template', 'Makes the ticket on each card clickable. <code>{id}</code> is replaced by the ticket.', field('tickets.link', 'https://example.atlassian.net/browse/{id}', 'style="width:300px" spellcheck="false"')),
    ])}`;
}

// ---------------------------------------------------------------- pane: terminal
const TERM = { cmux: null, iterm: null, installed: null };
function paneTerminal() {
  const inst = TERM.installed;
  const r = (app, name) => {
    const st = TERM[app];
    const ctl = !inst ? '' : !inst[app] ? '<span class="sub">Not installed</span>'
      : st === 'busy' ? '<span class="spin"></span>' : st === 'ok' ? '<span class="status-ok">✓ Allowed</span>'
      : `<button class="btn ${st === 'err' ? 'solid' : 'primary'}" data-act="term-allow" data-app="${app}">${st === 'err' ? 'Try again' : 'Allow…'}</button>`;
    return row(name, 'Automation access, to switch to an agent’s tab', ctl);
  };
  return `<div class="pane-head">Terminal</div>
    <div class="note">When you click an agent, Sheepdog switches your terminal to its tab. macOS asks you once per app. Sheepdog only reads tab titles and selects tabs; it never types into or reads your sessions.</div>
    ${group('Jump to tab', [r('cmux', 'cmux'), r('iterm', 'iTerm2')])}
    ${group('cmux socket password', [row('Password', 'Only if cmux runs its control socket in password mode', `<input class="field" id="cmuxPw" type="password" placeholder="${cfg.terminal.cmuxPassword.set ? '••••••• saved' : 'not set'}" autocomplete="off"><button class="btn solid" data-act="cmux-pw">Save</button>`)])}`;
}

function paneAdvanced() {
  return `<div class="pane-head">Advanced</div>
    ${group('Setup', [
      row('Run setup again', 'Re-detect agents, machines and connections', '<button class="btn primary" data-act="wizard">Run setup…</button>'),
      row('Reset all settings', 'Forgets machines, GitHub and Slack connections', '<button class="btn danger" data-act="reset">Reset…</button>'),
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
  if (!s.connected) {
    return `${group('Connect Slack', [`<div class="row col" style="gap:12px">
      <ol class="steps">
        <li><b>Create the Sheepdog app</b> in your workspace. The button opens Slack with everything filled in: pick your workspace, then <b>Create</b>.</li>
        <li>Click <b>Install to Workspace</b> and <b>Allow</b>.</li>
        <li>Under <b>OAuth &amp; Permissions</b>, copy the <b>User OAuth Token</b> (starts with <code>xoxp-</code>) and paste it here.</li>
      </ol>
      <div><a class="btn primary" href="${esc(s.manifestUrl)}" target="_blank" rel="noopener">Create Slack app ↗</a></div>
      <div style="display:flex;gap:6px"><input class="field wide mono" id="slToken" type="password" placeholder="xoxp-…" autocomplete="off"><button class="btn solid" data-act="sl-token">${busy(SL.busy === 'token', 'Connect')}</button></div>
      ${err}
      <div class="note">Sheepdog only reads messages and reactions in the one channel you pick, and member names. The token stays on this computer. Workspace admins may need to approve new apps.</div>
    </div>`])}`;
  }
  const chan = s.channelId ? `#${esc(s.channelName)}` : 'None picked';
  const chanSub = !s.channelId ? 'Pick the channel where your team posts pull requests' : s.error ? `<span class="err">${esc(s.error)}</span>` : `${s.prCount} open PR${s.prCount === 1 ? '' : 's'} found`;
  return `${group('Workspace', [`<div class="row"><span class="dot"></span><div class="lbl"><div><b>${esc(s.team)}</b></div>
      <div class="sub">${s.kind === 'user' ? `Connected as ${esc(s.user)}` : 'Bot token: invite @Sheepdog to the review channel'}</div></div>
      <div class="ctl"><button class="btn solid" data-act="sl-disconnect">Disconnect</button></div></div>`])}
    ${group('Review channel', [row(chan, chanSub, ''), `<div class="row col"><input class="field wide" id="slChan" data-search="sl" placeholder="Search channels" value="${esc(SL.query)}" autocomplete="off">${err}</div>
      <div class="suggest" id="slSuggest">${slSuggestHtml()}</div>`])}
    ${inWizard ? '' : group('Reactions', [
      row('Reviewing', 'Someone has started reviewing (emoji name)', field('slack.reviewing', 'eyes', 'class="field mono" style="width:170px"')),
      row('Approved', 'Removes the PR from the sidebar (emoji name)', field('slack.approved', 'white_check_mark', 'class="field mono" style="width:170px"')),
    ])}
    ${s.kind === 'bot' ? group('You', [row('Your Slack member ID', 'So Sheepdog knows which PRs are yours: Slack profile › ⋮ › Copy member ID', field('slack.userId', 'U0123ABCD', 'class="field mono" style="width:140px"'))]) : ''}
    ${inWizard ? '' : group('History', [row('Look back', 'Older posts leave the sidebar', select('slack.lookbackDays', [[3, '3 days'], [7, '1 week'], [14, '2 weeks'], [30, '30 days']], 'number'))])}`;
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
  ['pastures', 'Machines', '🐑'], ['alerts', 'Alerts', '🔔'], ['board', 'Board', '▦'], ['slack', 'Slack', '#'],
  ['github', 'GitHub', '⎇'], ['tickets', 'Tickets', '⌗'], ['terminal', 'Terminal', '>_'], ['advanced', 'Advanced', '⚙︎'],
];
function renderSettings() {
  const dot = (id) => {
    if (id === 'slack') return `<span class="st" style="background:${S?.slack.connected ? (S.slack.error ? 'var(--red)' : 'var(--green)') : 'transparent'}"></span>`;
    if (id === 'github') return `<span class="st" style="background:${S?.github.connected ? (S.github.error ? 'var(--red)' : 'var(--green)') : 'transparent'}"></span>`;
    return '';
  };
  const body = {
    pastures: panePastures, alerts: paneAlerts, board: paneBoard, tickets: paneTickets, terminal: paneTerminal, advanced: paneAdvanced,
    github: () => `<div class="pane-head">GitHub</div><div class="note">Used for the Branches view and for the live state of pull requests in the sidebar.</div>${githubBody(false)}`,
    slack: () => `<div class="pane-head">Slack</div><div class="note">The PR review sidebar reads one Slack channel. 👀 means someone is reviewing; ✅ approved PRs drop off.</div>${slackBody(false)}`,
  }[UI.pane]();
  $('prefs').innerHTML = `<nav><div class="navt">SHEEPDOG SETTINGS</div>${PANES.map(([id, name, g]) =>
    `<button class="${UI.pane === id ? 'on' : ''}" data-act="pane" data-pane="${id}"><span class="g">${g}</span>${name}${dot(id)}</button>`).join('')}</nav>
    <div class="pane">${body.replace('<div class="pane-head">', '<div class="pane-head">').replace(/(<div class="pane-head">[^<]*)/, '$1<button class="btn solid" data-act="close">Done</button>')}</div>`;
}

function openPane(pane) {
  UI.pane = pane;
  if (pane === 'github') loadGh();
  if (pane === 'slack') loadSl();
  if (pane === 'pastures' && !UI.sshHosts) api('/api/ssh-hosts').then((h) => { UI.sshHosts = h; rerender(); }, () => {});
  if (pane === 'terminal' && !TERM.installed) api('/api/detect').then((d) => { TERM.installed = d.terminals; rerender(); }, () => {});
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
      <div class="wiz-p" style="max-width:380px">Sheepdog watches Claude Code and Codex on this computer and your other machines, and tells you the moment one is waiting for you.</div>`;
  } else if (step === 'mac') {
    const d = WZ.detect;
    const local = d?.local;
    body = `<div style="display:flex;gap:12px;align-items:center"><span style="font-size:32px">🐶</span><div><div class="wiz-h">Sniffing this computer…</div><div class="wiz-p">Looking for Claude Code and Codex in your terminals.</div></div></div>
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
        <div class="lbl"><div class="mono">${esc(h)}</div><div class="sub ${r && !r.busy ? (r.ok ? 'ok' : 'err') : ''}">${r ? (r.busy ? '<span class="spin"></span> Testing…' : esc(r.ok ? `Connected · ${r.summary}` : r.error)) : 'Not checked'}</div></div>
        <button class="btn solid" data-act="wz-host-test" data-ssh="${esc(h)}">Test</button></div>`;
    });
    body = `<div><div class="wiz-h">Other pastures</div><div class="wiz-p">Machines from <code>~/.ssh/config</code>. Pick the ones running agents. They need key-based SSH and <code>python3</code>.</div></div>
      ${rows.length ? group('', rows) : '<div class="note">No hosts in ~/.ssh/config.</div>'}
      <div style="display:flex;gap:6px"><input class="field wide mono" id="wzHost" placeholder="Another machine: alias or user@host" autocomplete="off" spellcheck="false"><button class="btn solid" data-act="wz-host-add">Add</button></div>
      <div class="note">You can skip this and add machines later in Settings › Machines.</div>`;
  } else if (step === 'terminal') {
    if (!TERM.installed && WZ.detect) TERM.installed = WZ.detect.terminals;
    body = `<div><div class="wiz-h">Let Sheepdog jump to the right tab</div><div class="wiz-p">When you click an agent, Sheepdog switches your terminal to its tab. macOS asks you to allow this once per app. Sheepdog only reads tab titles and selects tabs. It never types into or reads your sessions.</div></div>
      ${paneTerminal().replace(/^[\s\S]*?(<div><div class="group-title">Jump to tab)/, '$1').replace(/<div><div class="group-title">cmux socket[\s\S]*$/, '')}
      <div class="note">Change later in System Settings › Privacy &amp; Security › Automation.</div>`;
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
function closeAll() { for (const id of ['branchesScrim', 'settingsScrim', 'wizardScrim']) $(id).hidden = true; }

// ---------------------------------------------------------------- actions
const actions = {
  settings: (el) => openSettings(el.dataset.pane),
  pane: (el) => { openPane(el.dataset.pane); renderSettings(); },
  close: () => { closeAll(); if (WZ.step !== undefined && !cfg?.setupComplete) setConfig({ setupComplete: true }); },
  branches: () => { closeAll(); $('branchesScrim').hidden = false; renderBranches(); },
  wizard: () => openWizard(),
  focus: (el) => {
    if (el.dataset.ok !== '1' || !el.dataset.key) { toast('No terminal tab found for this agent', true); return; }
    focusAgent(el.dataset.key);
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
      UI.hostTest[id] = { ok: r.ok, text: r.ok ? `Connected in ${r.ms} ms · ${r.summary}` : r.error };
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
      if (!r.ok) { UI.hostTest.__new = { ok: false, text: `Couldn’t connect: ${r.error}` }; rerender(); return; }
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
      toast(`Connected to ${r.team}`);
      await loadSl();
      searchChannels('');
    } catch (e) { SL.err = e.message; }
    SL.busy = ''; rerender();
  },
  'sl-disconnect': async () => {
    if (!confirm('Disconnect Slack?')) return;
    await api('/api/slack/disconnect', {}); SL.channels = null; loadSl(); poll(true);
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
  searchTimer = setTimeout(() => (kind === 'gh' ? searchRepos(el.value.trim()) : searchChannels(el.value.trim())), 250);
});
document.addEventListener('focusin', (e) => {
  const kind = e.target.dataset?.search;
  if (kind === 'gh' && !GH.suggestions) searchRepos(e.target.value.trim());
  if (kind === 'sl' && !SL.channels) searchChannels(e.target.value.trim());
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  if (e.key === 'Escape' && $('wizardScrim').hidden) closeAll();
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    const map = { ghToken: 'gh-token', ghRepo: 'gh-repo-add', slToken: 'sl-token', newHost: 'host-add', wzHost: 'wz-host-add', ghBranches: 'gh-branches', cmuxPw: 'cmux-pw' };
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
    if (!$('branchesScrim').hidden) renderBranches();
    if (!$('settingsScrim').hidden && UI.pane === 'pastures' && !$('prefs').contains(document.activeElement)) renderSettings();
  } catch {
    $('hosts').innerHTML = `<div class="host"><span class="dot down"></span>${NATIVE ? 'Sheepdog’s server stopped. Use the menu bar icon to restart it.' : 'Sheepdog isn’t running. Start it with <code>npm start</code>.'}</div>`;
  }
  if (!once) setTimeout(poll, 2000);
}

// Routes the Mac app (and links) can open: #settings, #settings/<pane>, #setup, #branches
function route_(r) {
  r = String(r || '').replace(/^#/, '');
  if (!r) return;
  const [what, pane] = r.split('/');
  if (what === 'settings') openSettings(PANES.some(([id]) => id === pane) ? pane : undefined);
  else if (what === 'setup') openWizard();
  else if (what === 'branches') actions.branches();
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
