// Statistics from history files (no network, temp config dir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'sheepdog-hist-'));
process.env.SHEEPDOG_CONFIG_DIR = dir;
const h = await import('../server/history.mjs');

const today = new Date(); today.setHours(10, 0, 0, 0);
const T = today.getTime();
const min = 60e3;

const host = (agents, at = T) => new Map([['local', { ok: true, at, host: 'mac', now: at / 1000, agents }]]);
const agent = (o) => ({ kind: 'claude', sessionId: 's1', pid: 1, repo: 'web', ticket: 'ABC-1', model: 'claude-x', ...o });

test('samples add up to agent time, tokens, tickets and parallelism', () => {
  // 10 minutes: s1 working the whole time (tokens 1000 -> 1900), s2 working for the first 4
  for (let i = 0; i < 10; i++) {
    const t = T + i * min;
    const agents = [agent({ state: 'working', tokens: 1000 + i * 100, stateSince: T / 1000 })];
    if (i < 4) agents.push(agent({ sessionId: 's2', pid: 2, repo: 'api', ticket: null, kind: 'codex', model: null, state: 'working', tokens: 50 }));
    else if (i < 6) agents.push(agent({ sessionId: 's2', pid: 2, repo: 'api', ticket: null, kind: 'codex', model: null, state: 'waiting', tokens: 50, stateSince: (T + 4 * min) / 1000 }));
    h.sample(host(agents, t), t);
  }
  // headless runs and sub-agents are ignored
  h.sample(host([agent({ sessionId: 'x', headless: true, state: 'working', tokens: 1e9 }), agent({ sessionId: 'y', parent: 1, state: 'working', tokens: 1e9 })], T + 11 * min), T + 11 * min);

  const s = h.stats(1, T + 20 * min);
  assert.equal(s.samples, 10);
  assert.equal(s.work, 14 * 60, '10 + 4 working minutes');
  assert.equal(s.wait, 2 * 60, 's2 waited 2 minutes');
  assert.equal(s.tokens, 1900 + 50, 'first sighting counts fully, then only growth');
  assert.equal(s.agents, 2);
  assert.equal(s.peak, 2);
  assert.equal(s.parallel, 1.4);
  assert.equal(s.series[10].work, 14 * 60, 'all in the 10:00 hour');
  assert.deepEqual(s.tickets.map((x) => [x.name, x.work]), [['ABC-1', 600]]);
  assert.deepEqual(s.repos.map((x) => x.name), ['web', 'api']);
  assert.deepEqual(s.models.map((x) => x.name), ['claude-x', 'Codex']);
});

test('answering a waiting agent records how long it waited', () => {
  const t0 = T + 30 * min;
  h.observe(host([agent({ sessionId: 'r1', state: 'waiting', stateSince: t0 / 1000, title: 'Fix login' })], t0), t0);
  h.observe(host([agent({ sessionId: 'r1', state: 'working', stateSince: (t0 + 90e3) / 1000, title: 'Fix login' })], t0 + 95e3), t0 + 95e3);
  // a 2-hour wait means you were away: not part of the median
  const t1 = T + 40 * min;
  h.observe(host([agent({ sessionId: 'r2', state: 'waiting', stateSince: (t1 - 7200e3) / 1000 })], t1), t1);
  h.observe(host([agent({ sessionId: 'r2', state: 'working', stateSince: t1 / 1000 })], t1 + 1000), t1 + 1000);
  const s = h.stats(1, T + 50 * min);
  assert.equal(s.responses.count, 1);
  assert.equal(s.responses.median, 90);
  assert.equal(s.responses.away, 1);
  assert.equal(s.responses.longest[0].title, 'Fix login');
});

test('PR timelines: newest line per PR, medians and reviewers', () => {
  const memo = {};
  const base = { url: 'https://github.com/acme/web/pull/1', repo: 'web', number: 1, title: 'A', author: 'bob', yours: true, postedAt: T, reviewers: [], approvers: [], reviewAt: null, approvedAt: null, done: false };
  assert.equal(h.recordPr(base, memo, T), true);
  assert.equal(h.recordPr(base, memo, T + 1000), false, 'unchanged timelines are not written again');
  h.recordPr({ ...base, reviewers: ['Carol'], reviewAt: T + 30 * min }, memo, T + 30 * min);
  h.recordPr({ ...base, reviewers: ['Carol'], approvers: ['Dan'], reviewAt: T + 30 * min, approvedAt: T + 60 * min }, memo, T + 60 * min);
  h.recordPr({ ...base, url: 'https://github.com/acme/web/pull/2', number: 2, yours: false, reviewers: ['Carol'], reviewAt: T + 10 * min }, memo, T + 10 * min);
  const p = h.stats(1, T + 90 * min).prs;
  assert.equal(p.posted, 2);
  assert.equal(p.reviewed, 2);
  assert.equal(p.toReview, 20 * 60, 'median of 30 and 10 minutes');
  assert.equal(p.toApprove, 60 * 60);
  assert.equal(p.yoursToReview, 30 * 60);
  assert.deepEqual(p.people, [{ name: 'Carol', reviewed: 2, approved: 0 }, { name: 'Dan', reviewed: 0, approved: 1 }]);
});

test('old files are pruned and clear removes everything', () => {
  const old = T - 100 * 86400e3;
  h.append({ t: old, e: 's', a: [] });
  assert.ok(readdirSync(h.HISTORY_DIR).includes(`${h.dayKey(old)}.jsonl`));
  h.prune(T);
  assert.ok(!readdirSync(h.HISTORY_DIR).includes(`${h.dayKey(old)}.jsonl`));
  h.clear();
  assert.equal(h.stats(7, T + 1).samples, 0);
});

test('today strip: your PRs, reviews given, streak over workdays, team PRs', () => {
  h.clear();
  const memo = {};
  const now = T + 60 * min;
  // the last 3 workdays before today, skipping weekends
  const workdays = [];
  for (let back = 1; workdays.length < 3; back++) {
    const d = new Date(T); d.setDate(d.getDate() - back);
    if (![0, 6].includes(d.getDay())) workdays.push(d.getTime());
  }
  const pr = (n, o) => h.recordPr({ url: `https://github.com/acme/web/pull/${n}`, repo: 'web', number: n, title: `PR ${n}`, author: 'x', yours: false,
    postedAt: T, reviewers: [], approvers: [], reviewAt: null, approvedAt: null, done: false, by: ['UBOB', 'Bob'], rv: [], ap: [], ...o }, memo, now);
  pr(1, { yours: true, by: ['UME', 'Me'] });
  pr(2, { yours: true, by: ['UME', 'Me'], postedAt: T + 5 * min });
  pr(3, { yours: true, by: ['UME', 'Me'], postedAt: workdays[0] });
  pr(4, { yours: true, by: ['UME', 'Me'], postedAt: workdays[1] });
  // a gap on workdays[2] ends the streak there
  pr(5, { rv: [['UME', T + 10 * min, 'Me'], ['UCAROL', T + 20 * min, 'Carol']], ap: [['UME', T + 30 * min, 'Me']] });
  pr(6, { rv: [['UME', workdays[0], 'Me']] }); // yesterday-ish, not today
  const t = h.today('UME', now);
  assert.equal(t.prs.today, 2);
  assert.equal(t.streak, 3, 'today + 2 workdays before it');
  assert.deepEqual(t.reviews.today, { total: 1, eyes: 1, approved: 1 }, '👀 and ✅ on one PR is one review');
  assert.equal(t.team.today, 4);
  assert.equal(h.today('', now + 61e3).reviews.today, null, 'no identity, no review count');
});

test('leaderboards rank reviews, posts, approvals and pickup speed', () => {
  const lb = h.leaderboard(7, 'UME', T + 60 * min);
  const board = (k) => lb.boards.find((b) => b.key === k);
  assert.deepEqual(board('posted').rows.map((r) => [r.name, r.value, r.rank]), [['Me', 4, 1], ['Bob', 2, 2]]);
  assert.deepEqual(board('reviewed').rows.map((r) => [r.name, r.value]), [['Me', 2], ['Carol', 1]]);
  assert.equal(board('reviewed').you.rank, 1);
  assert.deepEqual(board('approved').rows.map((r) => r.name), ['Me']);
  assert.ok(board('pickup').rows.every((r) => r.value >= 0));
});
