// Slack sidebar logic against canned Slack and GitHub API responses (no network).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'sheepdog-test-'));
process.env.SHEEPDOG_CONFIG_DIR = dir;
writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  github: { auth: 'token', token: 'ghp_testtokentesttokentesttoken', login: 'alice' },
  slack: { token: 'xoxp-1-test', team: 'Acme', teamUrl: 'https://acme.slack.com/', userId: 'UALICE', channelId: 'C123', channelName: 'pr-reviews' },
}));

const now = Date.now() / 1000;
const msg = (o) => ({ type: 'message', ts: (now - (o.ago || 60)).toFixed(6), ...o });
const SLACK = {
  'conversations.history': {
    ok: true, has_more: false, messages: [
      // posted by me, someone reviewing, poster's own eyes must not count
      msg({ user: 'UALICE', text: 'Please review <https://github.com/acme/web/pull/12|#12 Fix login>', reactions: [{ name: 'eyes', users: ['UALICE', 'UBOB'], count: 2 }], reply_count: 3, ago: 600 }),
      // posted by a bot app, approved, author on GitHub is me
      msg({ subtype: 'bot_message', bot_profile: { name: 'PR Bot' }, text: '', attachments: [{ title_link: 'https://github.com/acme/api/pull/7' }], reactions: [{ name: 'white_check_mark', users: ['UCAROL'] }], ago: 1200 }),
      // someone else's, nobody reacted
      msg({ user: 'UBOB', text: 'https://github.com/acme/web/pull/15', ago: 300 }),
      // merged on GitHub -> must disappear
      msg({ user: 'UBOB', text: 'https://github.com/acme/web/pull/9', ago: 5000 }),
      // not a PR
      msg({ user: 'UBOB', text: 'lunch?' }),
      // channel join noise
      msg({ subtype: 'channel_join', user: 'UBOB', text: 'https://github.com/acme/web/pull/99' }),
      // older re-post of #12 -> newest post wins
      msg({ user: 'UBOB', text: 'https://github.com/acme/web/pull/12', ago: 9000 }),
    ],
  },
  'users.info': (p) => ({ ok: true, user: { id: p.get('user'), profile: { display_name: { UALICE: 'Alice', UBOB: 'Bob', UCAROL: 'Carol' }[p.get('user')] } } }),
  'conversations.list': { ok: true, channels: [
    { id: 'C1', name: 'random', is_member: true, num_members: 40 },
    { id: 'C123', name: 'pr-reviews', is_member: true, num_members: 9 },
    { id: 'G9', name: 'secret-reviews', is_private: true, is_member: false, num_members: 3 },
  ] },
  'auth.test': { ok: true, team: 'Acme', url: 'https://acme.slack.com/', user: 'alice', user_id: 'UALICE' },
};
const PRS = {
  'web/12': { state: 'OPEN', merged: false, isDraft: false, title: 'Fix login', author: { login: 'alice' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } },
  'api/7': { state: 'OPEN', merged: false, isDraft: false, title: 'Add rate limit', author: { login: 'alice' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } },
  'web/15': { state: 'OPEN', merged: false, isDraft: false, title: 'Dark mode', author: { login: 'bob' }, commits: { nodes: [] } },
  'web/9': { state: 'MERGED', merged: true, isDraft: false, title: 'Old', author: { login: 'bob' }, commits: { nodes: [] } },
};

before(() => {
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    if (url.startsWith('https://slack.com/api/')) {
      const method = url.split('/api/')[1];
      const p = new URLSearchParams(opts.body);
      const r = SLACK[method];
      const body = typeof r === 'function' ? r(p) : r || { ok: false, error: 'unknown_method' };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url === 'https://api.github.com/graphql') {
      const { variables } = JSON.parse(opts.body);
      const data = {};
      for (const k of Object.keys(variables).filter((x) => x.startsWith('o'))) {
        const i = k.slice(1);
        const pr = PRS[`${variables[`n${i}`]}/${variables[`p${i}`]}`];
        data[`x${i}`] = pr ? { pullRequest: { ...pr, url: '' } } : null;
      }
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});

test('builds the PR sidebar from channel history', async () => {
  const { github } = await import('../server/github.mjs');
  github.viewer = 'alice';
  const sl = await import('../server/slack.mjs');
  await sl.refreshSlack();
  assert.equal(sl.slack.error, null);
  const byNum = Object.fromEntries(sl.slack.prs.map((p) => [`${p.repo}/${p.number}`, p]));
  assert.deepEqual(Object.keys(byNum).sort(), ['web/12', 'web/15'], 'approved PR, merged PR, non-PR and join messages are dropped');

  const p12 = byNum['web/12'];
  assert.equal(p12.yours, true);
  assert.equal(p12.title, 'Fix login');
  assert.equal(p12.ci, 'ok');
  assert.equal(p12.replies, 3);
  assert.deepEqual(p12.reviewers.map((r) => r.name), ['Bob'], "poster's own 👀 is ignored");
  assert.ok(p12.reviewers[0].since > 0);
  assert.match(p12.link, /^https:\/\/acme\.slack\.com\/archives\/C123\/p\d+$/);

  const p15 = byNum['web/15'];
  assert.equal(p15.yours, false);
  assert.equal(p15.author, 'bob');
  assert.equal(p15.reviewers.length + p15.approvers.length, 0);

  // newest first
  assert.deepEqual(sl.slack.prs.map((p) => p.number), [15, 12]);
});

test('"since" for a reaction is remembered between polls', async () => {
  const sl = await import('../server/slack.mjs');
  await sl.refreshSlack();
  const first = sl.slack.prs.find((p) => p.number === 12).reviewers[0].since;
  await new Promise((r) => setTimeout(r, 20));
  await sl.refreshSlack();
  assert.equal(sl.slack.prs.find((p) => p.number === 12).reviewers[0].since, first);
});

test('channel picker lists members first and filters by name', async () => {
  const sl = await import('../server/slack.mjs');
  const all = await sl.listChannels('');
  assert.deepEqual(all.map((c) => c.name), ['pr-reviews', 'random', 'secret-reviews']);
  const hits = await sl.listChannels('#review');
  assert.deepEqual(hits.map((c) => c.id), ['C123', 'G9']);
});

test('connect checks the token format before calling Slack', async () => {
  const sl = await import('../server/slack.mjs');
  await assert.rejects(sl.connect('not-a-token'), /xoxp-/);
  const r = await sl.connect('xoxp-1234567890-abcdef');
  assert.equal(r.team, 'Acme');
  assert.equal(r.kind, 'user');
});

test('manifest link carries the read-only scopes', async () => {
  const sl = await import('../server/slack.mjs');
  const m = JSON.parse(decodeURIComponent(sl.manifestUrl().split('manifest_json=')[1]));
  assert.deepEqual(m.oauth_config.scopes.user.sort(), ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'reactions:read', 'users:read']);
});

test('token cleanup and diagnosis', async () => {
  const { cleanToken, tokenProblem } = await import('../server/slack.mjs');
  // a fake token, assembled at runtime so secret scanners don't mistake it for a real one
  const t = ['xoxp', '1234567890', '1234567890', '1234567890123', 'abcdef0123456789'.repeat(2)].join('-');
  assert.equal(cleanToken(` "${t}"\n`), t);
  assert.equal(cleanToken(`Bearer ${t}`), t);
  assert.equal(cleanToken(`xoxp-123​4567890-abc`), 'xoxp-1234567890-abc');
  assert.equal(tokenProblem(t), null);
  assert.equal(tokenProblem('xoxe.xoxp-1-' + 'A'.repeat(40)), null);
  assert.equal(tokenProblem('xoxb-1-' + 'a'.repeat(20)), null);
  assert.match(tokenProblem('xapp-1-A0-123-abc'), /app-level/);
  assert.match(tokenProblem('0123456789abcdef0123456789abcdef'), /Secret/);
  assert.match(tokenProblem('1234567890.1234567890'), /Client ID/);
  assert.match(tokenProblem('hello'), /isn’t a Slack token/);
});

test('PR alerts: review started, approved, and a nudge, each once', async () => {
  const sl = await import('../server/slack.mjs');
  const { updateConfig } = await import('../server/config.mjs');
  updateConfig((c) => { c.alerts.prNudgeHours = 0.05; }); // 3 minutes, so #15 (posted 5 min ago) is overdue
  await sl.refreshSlack(); // earlier tests already set the baseline; this one only adds the nudge
  const hist = SLACK['conversations.history'].messages;
  const p12 = hist.find((m) => m.text.includes('pull/12|'));
  p12.reactions = [{ name: 'eyes', users: ['UALICE', 'UBOB', 'UCAROL'], count: 3 }];
  await sl.refreshSlack();
  p12.reactions.push({ name: 'white_check_mark', users: ['UBOB'], count: 1 });
  await sl.refreshSlack();
  await sl.refreshSlack(); // nothing new
  const kinds = sl.prEvents.map((e) => e.kind);
  assert.deepEqual(kinds, ['nudge', 'review', 'approved']);
  const [nudge, review, approved] = sl.prEvents;
  assert.match(nudge.body, /web #15/);
  assert.equal(review.title, 'Carol started reviewing your PR');
  assert.equal(approved.title, 'Bob approved your PR');
  assert.equal(approved.url, 'https://github.com/acme/web/pull/12');
  assert.ok(!sl.slack.prs.some((p) => p.number === 12), 'approved PR left the sidebar');
});

test('team bot: bot-only manifest, switching revokes the personal token, pick yourself', async () => {
  const sl = await import('../server/slack.mjs');
  const { getConfig, updateConfig } = await import('../server/config.mjs');
  const bot = JSON.parse(decodeURIComponent(sl.manifestUrl('bot').split('manifest_json=')[1]));
  assert.equal(bot.oauth_config.scopes.user, undefined, 'the team bot app asks for no user scopes');
  assert.deepEqual(bot.oauth_config.scopes.bot.sort(), ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'reactions:read', 'users:read']);

  const revoked = [];
  SLACK['auth.revoke'] = (p) => { revoked.push(p); return { ok: true, revoked: true }; };
  SLACK['users.list'] = { ok: true, members: [
    { id: 'UALICE', name: 'alice', real_name: 'Alice Doe', profile: { display_name: 'Alice' } },
    { id: 'UBOB', name: 'bob', real_name: 'Bob Roe', profile: { display_name: 'Bob' } },
    { id: 'UDAN', name: 'dan', real_name: 'Dan Not-in-channel', profile: { display_name: 'Dan' } },
    { id: 'UBOT', name: 'sheepdog', is_bot: true, profile: {} },
    { id: 'UGONE', name: 'gone', deleted: true, profile: {} },
  ] };
  SLACK['conversations.members'] = { ok: true, members: ['UALICE', 'UBOB', 'UBOT'] };

  updateConfig((c) => { c.slack.token = 'xoxp-1-personal'; c.slack.userId = 'UALICE'; c.slack.user = 'Alice'; });
  const r = await sl.connect('xoxb-1-' + 'b'.repeat(20));
  assert.equal(r.kind, 'bot');
  assert.equal(revoked.length, 1, 'the replaced personal token was revoked');
  assert.equal(getConfig().slack.userId, 'UALICE', 'switching keeps who you are');
  assert.equal(getConfig().slack.user, 'Alice');

  const people = await sl.listMembers('');
  assert.deepEqual(people.map((u) => u.id), ['UALICE', 'UBOB'], 'only real people in the review channel');
  assert.deepEqual((await sl.listMembers('roe')).map((u) => u.name), ['Bob']);
  await sl.setMe('UBOB');
  assert.equal(getConfig().slack.userId, 'UBOB');
  await assert.rejects(sl.setMe('nope'), /Invalid/);

  await sl.disconnect();
  assert.equal(revoked.length, 1, 'a shared bot token is never revoked');
  assert.equal(getConfig().slack.token, '');
});

test('several emoji per state, including skin tones', async () => {
  const sl = await import('../server/slack.mjs');
  const { updateConfig } = await import('../server/config.mjs');
  updateConfig((c) => { c.slack.token = 'xoxp-1-test'; c.slack.channelId = 'C123'; c.slack.userId = 'UALICE'; c.slack.reviewing = 'eyes,mag'; c.slack.approved = 'white_check_mark,thumbsup'; });
  const p15 = SLACK['conversations.history'].messages.find((m) => m.text === 'https://github.com/acme/web/pull/15');
  p15.reactions = [{ name: 'mag', users: ['UALICE'] }, { name: 'eyes', users: ['UALICE', 'UCAROL'] }];
  await sl.refreshSlack();
  const pr = sl.slack.prs.find((p) => p.number === 15);
  assert.deepEqual(pr.reviewers.map((r) => r.name).sort(), ['Alice', 'Carol'], 'either emoji counts, each person once');
  p15.reactions.push({ name: 'thumbsup::skin-tone-3', users: ['UCAROL'] });
  await sl.refreshSlack();
  assert.ok(!sl.slack.prs.some((p) => p.number === 15), 'a 👍 with a skin tone approves it too');
});

test('a post with several PRs gives one card per PR; one ✅ does not approve them all', async () => {
  const sl = await import('../server/slack.mjs');
  const { updateConfig } = await import('../server/config.mjs');
  updateConfig((c) => { c.slack.token = 'xoxp-1-test'; c.slack.channelId = 'C123'; c.slack.userId = 'UALICE'; c.slack.reviewing = 'eyes'; c.slack.approved = 'white_check_mark'; });
  PRS['web/21'] = { state: 'OPEN', merged: false, isDraft: false, title: 'Part 1', author: { login: 'bob' }, commits: { nodes: [] } };
  PRS['web/22'] = { state: 'OPEN', merged: false, isDraft: false, title: 'Part 2', author: { login: 'bob' }, commits: { nodes: [] }, reviews: { totalCount: 1 } };
  PRS['api/23'] = { state: 'OPEN', merged: false, isDraft: false, title: 'Part 3', author: { login: 'bob' }, commits: { nodes: [] } };
  SLACK['conversations.history'].messages.push(msg({ user: 'UBOB', text: 'Three parts: <https://github.com/acme/web/pull/21> <https://github.com/acme/web/pull/22|#22> https://github.com/acme/api/pull/23',
    reactions: [{ name: 'eyes', users: ['UCAROL'] }, { name: 'white_check_mark', users: ['UCAROL'] }], reply_count: 2, ago: 120 }));
  await sl.refreshSlack();
  const nums = sl.slack.prs.map((p) => p.number);
  assert.ok(nums.includes(21) && nums.includes(23), 'every PR in the post is listed');
  assert.equal(sl.slack.prs.find((p) => p.number === 22).status, 'approved', 'approved on GitHub: still on the card, marked done');
  assert.equal(new Set(sl.slack.prs.filter((p) => [21, 22, 23].includes(p.number)).map((p) => p.ts)).size, 1, 'all three belong to one post');
  const p21 = sl.slack.prs.find((p) => p.number === 21);
  assert.deepEqual(p21.reviewers.map((r) => r.name), ['Carol'], 'the post’s 👀 shows on each of its PRs');
  assert.equal(p21.replies, 2);
});
