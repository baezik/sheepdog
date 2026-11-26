// History for the statistics window. Stays on this computer: ~/.config/sheepdog/history/<YYYY-MM-DD>.jsonl
// (local dates), one JSON object per line, files older than KEEP_DAYS are deleted.
//
//   {"t":ms,"e":"s","a":[[key, state, tokens, kind, host, repo, ticket, model], ...]}
//       a sample, once a minute: what every agent is doing. state: w working, t waiting on you, i idle
//   {"t":ms,"e":"r","k":key,"w":seconds,"kind","host","repo","ticket","title"}
//       you answered an agent that had waited w seconds
//   {"t":ms,"e":"pr","url","repo","number","title","author","yours","postedAt","reviewAt","approvedAt","reviewers","approvers","done",
//    "by":[slackId,name],"rv":[[slackId,ms,name]...],"ap":[[slackId,ms,name]...]}
//       a PR's review timeline changed (the newest line per url wins). PRs are also kept in memory (prIndex)
//       so the Today strip and Leaderboards never re-read the files.
//
// Time is counted only while Sheepdog runs: each sample stands for one minute.
import path from 'node:path';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { CONFIG_DIR, getConfig } from './config.mjs';
import { log } from './util.mjs';

export const HISTORY_DIR = path.join(CONFIG_DIR, 'history');
export const SAMPLE_SECONDS = 60;
const KEEP_DAYS = 90;
const DAY = 86400e3;

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function append(entry) {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(HISTORY_DIR, `${dayKey(entry.t)}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (e) { log('history:', e.message); }
}

export function prune(now = Date.now()) {
  const oldest = dayKey(now - KEEP_DAYS * DAY);
  try {
    for (const f of readdirSync(HISTORY_DIR)) if (/^\d{4}-\d\d-\d\d\.jsonl$/.test(f) && f.slice(0, 10) < oldest) rmSync(path.join(HISTORY_DIR, f));
  } catch {}
}

export function clear() {
  try { rmSync(HISTORY_DIR, { recursive: true, force: true }); } catch {}
  statsCache.clear();
  todayCache = null;
  yesterdayCache = null;
  prIndex = new Map();
}

// ---------------------------------------------------------------- recording
const visible = (a) => !a.headless && !a.parent; // sub-agents and headless runs never wait on you
const agentKey = (hostId, a) => `${hostId}:${a.sessionId || a.pid}`;

/** One sample of every agent on every reachable host. Called once a minute. */
export function sample(hosts, now = Date.now()) {
  const idleAfter = getConfig().idleMinutes * 60;
  const rows = [];
  for (const [hostId, h] of hosts) {
    if (!h.ok || now - h.at > 3 * SAMPLE_SECONDS * 1000) continue;
    const nowSec = h.now || now / 1000;
    for (const a of h.agents || []) {
      if (!visible(a)) continue;
      const since = a.stateSince || a.lastActivity || a.started || nowSec;
      const st = a.state === 'working' ? 'w' : nowSec - since >= idleAfter ? 'i' : 't';
      rows.push([agentKey(hostId, a), st, a.tokens ?? null, a.kind, h.host || hostId, a.repo || null, a.ticket || null, a.model || null]);
    }
  }
  if (rows.length) append({ t: now, e: 's', a: rows });
}

const lastState = new Map(); // key -> { state, since (s) }
/** After every poll: notice agents you just answered (waiting -> working) and log how long they waited. */
export function observe(hosts, now = Date.now()) {
  const alive = new Set();
  for (const [hostId, h] of hosts) {
    if (!h.ok) { for (const k of lastState.keys()) if (k.startsWith(`${hostId}:`)) alive.add(k); continue; } // keep through blips
    for (const a of h.agents || []) {
      if (!visible(a) || !(a.sessionId || a.pid)) continue;
      const key = agentKey(hostId, a);
      alive.add(key);
      const since = a.stateSince || now / 1000;
      const prev = lastState.get(key);
      if (prev && prev.state === 'waiting' && a.state === 'working') {
        const wait = Math.round((a.stateSince || now / 1000) - prev.since);
        if (wait > 0 && wait < 7 * 86400) {
          append({ t: now, e: 'r', k: key, w: wait, kind: a.kind, host: h.host || hostId, repo: a.repo || null, ticket: a.ticket || null,
            title: (a.title || a.prompt || '').slice(0, 80) || null });
        }
      }
      if (!prev || prev.state !== a.state) lastState.set(key, { state: a.state, since });
    }
  }
  for (const k of lastState.keys()) if (!alive.has(k)) lastState.delete(k);
}

/** A PR's review timeline, written only when it changes. `memo` (url -> signature) lives in state.json. */
export function recordPr(pr, memo, now = Date.now()) {
  const sig = JSON.stringify([2, pr.reviewAt, pr.approvedAt, pr.rv, pr.ap, pr.done, pr.title, pr.by]);
  if (memo[pr.url] === sig) return false;
  memo[pr.url] = sig;
  const entry = { t: now, e: 'pr', ...pr };
  append(entry);
  prIndex?.set(pr.url, entry);
  return true;
}

// every PR's newest timeline, loaded from the files once
let prIndex = null;
function prs() {
  if (prIndex) return prIndex;
  prIndex = new Map();
  let files = [];
  try { files = readdirSync(HISTORY_DIR).filter((f) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort(); } catch {}
  for (const f of files) {
    let text = '';
    try { text = readFileSync(path.join(HISTORY_DIR, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"e":"pr"')) continue;
      try { const e = JSON.parse(line); prIndex.set(e.url, e); } catch {}
    }
  }
  return prIndex;
}

// ---------------------------------------------------------------- statistics
function readDays(from, to) {
  const out = [];
  // step by calendar day, not 24h, so daylight saving changes don't skip or repeat a day
  for (const day = new Date(startOfDay(from)); day.getTime() <= to; day.setDate(day.getDate() + 1)) {
    let text = '';
    try { text = readFileSync(path.join(HISTORY_DIR, `${dayKey(day.getTime())}.jsonl`), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const bump = (m, k, field, v) => {
  if (k == null) return;
  const o = m.get(k) || { name: k, work: 0, tokens: 0, agents: new Set() };
  o[field] += v;
  m.set(k, o);
  return o;
};
const top = (m, n = 8) => [...m.values()].map((o) => ({ name: o.name, work: o.work, tokens: o.tokens, agents: o.agents.size }))
  .filter((o) => o.work || o.tokens).sort((a, b) => b.work - a.work || b.tokens - a.tokens).slice(0, n);

const statsCache = new Map();
/** Statistics for the last `days` calendar days (1 = today), computed from the history files. */
export function stats(days = 7, now = Date.now()) {
  days = [1, 7, 30].includes(days) ? days : 7;
  const hit = statsCache.get(days);
  if (hit && now - hit.at < 30e3) return hit.value;
  const from = startOfDay(now) - (days - 1) * DAY;
  // one extra day so session tokens that started before the range aren't counted again
  const entries = readDays(from - DAY, now);
  const idleAfter = getConfig().idleMinutes * 60;

  const buckets = days === 1 ? 24 : days;
  const series = Array.from({ length: buckets }, (_, i) => {
    const at = days === 1 ? from + i * 3600e3 : new Date(from).setDate(new Date(from).getDate() + i);
    return { at, work: 0, wait: 0, tokens: 0 };
  });
  const bucketOf = (t) => (days === 1 ? Math.floor((t - from) / 3600e3) : Math.round((startOfDay(t) - from) / DAY));
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0)); // [weekday Mon=0][hour] working seconds
  const tickets = new Map(), repos = new Map(), models = new Map();
  const lastTok = new Map();
  const agents = new Set();
  let work = 0, wait = 0, samples = 0, busySamples = 0, parallelSum = 0, peak = 0, tokens = 0, first = null;
  const responses = [];

  for (const e of entries) {
    const inRange = e.t >= from;
    if (e.e === 's') {
      let working = 0;
      for (const [key, st, tok, kind, , repo, ticket, model] of e.a) {
        let dTok = 0;
        if (tok != null) {
          const prev = lastTok.get(key);
          dTok = prev == null ? tok : Math.max(0, tok - prev);
          lastTok.set(key, tok);
        }
        if (!inRange) continue;
        agents.add(key);
        const b = series[bucketOf(e.t)];
        if (st === 'w') {
          working++;
          work += SAMPLE_SECONDS;
          if (b) b.work += SAMPLE_SECONDS;
          const d = new Date(e.t);
          heat[(d.getDay() + 6) % 7][d.getHours()] += SAMPLE_SECONDS;
        } else if (st === 't') {
          wait += SAMPLE_SECONDS;
          if (b) b.wait += SAMPLE_SECONDS;
        }
        tokens += dTok;
        if (b) b.tokens += dTok;
        const label = kind === 'codex' ? 'Codex' : 'Claude';
        for (const [m, k] of [[tickets, ticket], [repos, repo], [models, model || label]]) {
          const o = bump(m, k, 'tokens', dTok);
          if (o) { if (st === 'w') o.work += SAMPLE_SECONDS; o.agents.add(key); }
        }
      }
      if (!inRange) continue;
      first ??= e.t;
      samples++;
      if (working) { busySamples++; parallelSum += working; peak = Math.max(peak, working); }
    } else if (e.e === 'r' && inRange) {
      responses.push(e);
    }
  }

  // waits longer than the idle threshold mean you were away, not slow
  const answered = responses.filter((r) => r.w < idleAfter);
  const waits = answered.map((r) => r.w);
  const longest = [...answered].sort((a, b) => b.w - a.w).slice(0, 5)
    .map((r) => ({ at: r.t, wait: r.w, title: r.title, repo: r.repo, ticket: r.ticket, kind: r.kind, host: r.host }));

  const posted = [...prs().values()].filter((p) => p.postedAt >= from);
  const toReview = posted.filter((p) => p.reviewAt).map((p) => Math.max(0, (p.reviewAt - p.postedAt) / 1000));
  const toApprove = posted.filter((p) => p.approvedAt).map((p) => Math.max(0, (p.approvedAt - p.postedAt) / 1000));
  const yours = posted.filter((p) => p.yours);
  const people = new Map();
  for (const p of posted) {
    for (const n of new Set(p.reviewers || [])) { const o = people.get(n) || { name: n, reviewed: 0, approved: 0 }; o.reviewed++; people.set(n, o); }
    for (const n of new Set(p.approvers || [])) { const o = people.get(n) || { name: n, reviewed: 0, approved: 0 }; o.approved++; people.set(n, o); }
  }

  const value = {
    days, from, to: now, first, samples,
    work, wait, tokens, agents: agents.size,
    parallel: busySamples ? Math.round((10 * parallelSum) / busySamples) / 10 : 0, peak,
    series, heat,
    tickets: top(tickets), repos: top(repos), models: top(models, 6),
    responses: { count: waits.length, median: median(waits), p90: quantile(waits, 0.9), away: responses.length - answered.length, longest },
    prs: {
      posted: posted.length, reviewed: toReview.length, approved: toApprove.length,
      toReview: median(toReview), toApprove: median(toApprove),
      yours: yours.length, yoursToReview: median(yours.filter((p) => p.reviewAt).map((p) => (p.reviewAt - p.postedAt) / 1000)),
      people: [...people.values()].sort((a, b) => b.reviewed + b.approved - (a.reviewed + a.approved) || a.name.localeCompare(b.name)).slice(0, 8),
    },
  };
  statsCache.set(days, { at: now, value });
  return value;
}

// ---------------------------------------------------------------- today strip
const dayStart = (ms, back = 0) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - back); return d.getTime(); };
const weekStart = (ms) => { const d = new Date(dayStart(ms)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }; // Monday
const isWeekend = (ms) => [0, 6].includes(new Date(ms).getDay());
const within = (t, a, b) => t != null && t >= a && t < b;

let todayCache = null;
let yesterdayCache = null;
/** The numbers in the strip at the top of the board. `me` is your Slack member id ('' if unknown). */
export function today(me = '', now = Date.now()) {
  if (todayCache && todayCache.me === me && now - todayCache.at < 60e3) return todayCache.value;
  const t0 = dayStart(now), y0 = dayStart(now, 1), w0 = weekStart(now), tomorrow = dayStart(now, -1);
  const all = [...prs().values()];
  const mine = all.filter((p) => p.yours);
  const count = (list, a, b) => list.filter((p) => within(p.postedAt, a, b)).length;

  // reviews you gave: PRs (not yours) where you reacted 👀 or ✅ in the period
  const given = (a, b) => {
    let eyes = 0, approved = 0, prsTouched = 0;
    if (!me) return null;
    for (const p of all) {
      if (p.yours) continue;
      const r = (p.rv || []).some(([id, at]) => id === me && within(at, a, b));
      const ok = (p.ap || []).some(([id, at]) => id === me && within(at, a, b));
      eyes += r; approved += ok; prsTouched += r || ok;
    }
    return { total: prsTouched, eyes, approved };
  };

  // streak: workdays in a row with at least one PR of yours posted (today counts once it happens;
  // weekends neither count nor break it)
  const days = new Set(mine.map((p) => dayKey(p.postedAt)));
  let streak = 0;
  for (let back = days.has(dayKey(now)) ? 0 : 1; back < 120; back++) {
    const d = dayStart(now, back);
    if (isWeekend(d)) continue;
    if (!days.has(dayKey(d))) break;
    streak++;
  }

  const s1 = stats(1, now); // reads only today's file
  if (yesterdayCache?.day !== dayKey(y0)) { // yesterday can't change: work it out once a day
    const y = stats(7, now).series.at(-2) || {};
    yesterdayCache = { day: dayKey(y0), work: y.work || 0, wait: y.wait || 0 };
  }
  const yesterday = yesterdayCache;
  const value = {
    prs: { today: count(mine, t0, tomorrow), yesterday: count(mine, y0, t0), week: count(mine, w0, tomorrow) },
    reviews: { today: given(t0, tomorrow), yesterday: given(y0, t0) },
    reply: { median: s1.responses.count >= 3 ? s1.responses.median : null, count: s1.responses.count },
    waited: { today: s1.wait, yesterday: yesterday.wait },
    agent: { today: s1.work, yesterday: yesterday.work, samples: s1.samples },
    streak,
    team: { today: count(all, t0, tomorrow), yesterday: count(all, y0, t0) },
  };
  todayCache = { at: now, me, value };
  return value;
}

// ---------------------------------------------------------------- leaderboards
/** Rankings from the review channel over the last `days` calendar days. */
export function leaderboard(days = 7, me = '', now = Date.now()) {
  days = [1, 7, 30].includes(days) ? days : 7;
  const from = dayStart(now, days - 1);
  const people = new Map();
  const person = (id, name) => {
    if (!id) return null;
    const o = people.get(id) || { id, name: name || id, posted: 0, reviewed: 0, approved: 0, pickups: [] };
    if (name && o.name === id) o.name = name;
    people.set(id, o);
    return o;
  };
  for (const p of prs().values()) {
    if (within(p.postedAt, from, now + 1)) {
      const o = p.by ? person(p.by[0], p.by[1]) : person(`gh:${p.author}`, p.author);
      if (o) o.posted++;
    }
    const touched = new Map(); // id -> person, so 👀 + ✅ on one PR counts as one review
    for (const [id, at, name, est] of p.rv || []) {
      if (!within(at, from, now + 1)) continue;
      const o = person(id, name);
      touched.set(id, o);
      if (!est && p.postedAt && at >= p.postedAt) o.pickups.push((at - p.postedAt) / 1000);
    }
    for (const [id, at, name] of p.ap || []) {
      if (!within(at, from, now + 1)) continue;
      const o = person(id, name);
      o.approved++;
      touched.set(id, o);
    }
    for (const o of touched.values()) o.reviewed++;
  }
  const list = [...people.values()];
  const board = (key, value, { asc = false, min = 1 } = {}) => {
    const ranked = list.map((o) => ({ id: o.id, name: o.name, value: value(o), you: o.id === me }))
      .filter((r) => r.value != null && r.value >= (asc ? 0 : min))
      .sort((a, b) => (asc ? a.value - b.value : b.value - a.value) || a.name.localeCompare(b.name));
    ranked.forEach((r, i) => { r.rank = i && ranked[i - 1].value === r.value ? ranked[i - 1].rank : i + 1; });
    return { key, rows: ranked.slice(0, 10), you: ranked.find((r) => r.you) || null, total: ranked.length };
  };
  return {
    days, from, to: now, me: !!me,
    boards: [
      board('reviewed', (o) => o.reviewed),
      board('posted', (o) => o.posted),
      board('approved', (o) => o.approved),
      board('pickup', (o) => (o.pickups.length >= 2 ? median(o.pickups) : null), { asc: true }),
    ],
  };
}
