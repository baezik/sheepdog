// Slack: the PR review sidebar. Reads one channel the user picks, finds messages that link a GitHub
// PR, and turns reactions into review state:
//   :eyes: (configurable)             -> someone is reviewing (name + since when Sheepdog first saw it)
//   :white_check_mark: (configurable) -> approved
// Changes to your PRs (review started, approved) and teammates' PRs waiting too long become alerts
// (prEvents), and every PR's review timeline goes to the statistics history.
// Thread replies link back to Slack. PRs leave the list once approved (✅ or GitHub approval), when
// GitHub says they are merged or closed (if connected), or when the message is older than the lookback window.
//
// Connecting, two ways:
//  - own app: the user creates a Slack app from our manifest (one click), installs it and pastes the
//    *User OAuth Token* (xoxp-). It reads any channel the user is in, without inviting a bot.
//  - team bot: one person sets the app up and shares its *Bot User OAuth Token* (xoxb-) with the team;
//    the bot is invited to the review channel. A bot token doesn't say who the person is, so they pick
//    themselves from the channel's members (setMe), which is how "Yours" and PR alerts find their PRs.
import { getConfig, updateConfig, getState, saveStateSoon } from './config.mjs';
import { prDetails, github } from './github.mjs';
import { recordPr } from './history.mjs';
import { log, sleep } from './util.mjs';

export const SCOPES = ['channels:history', 'groups:history', 'channels:read', 'groups:read', 'reactions:read', 'users:read'];
export const MANIFEST = {
  display_information: { name: 'Sheepdog', description: 'Shows PR review status from a Slack channel in Sheepdog.', background_color: '#1e1f23' },
  oauth_config: { scopes: { user: SCOPES, bot: SCOPES } },
  features: { bot_user: { display_name: 'Sheepdog', always_online: false } },
  settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
};
// For a team sharing one bot: no user scopes at all, so installing it never creates a token that can
// read the installer's own channels. The bot reads messages only in channels it is invited to.
export const MANIFEST_BOT = {
  ...MANIFEST,
  display_information: { ...MANIFEST.display_information, description: 'Shows PR review status from your review channel in Sheepdog. Read-only; reads only channels it is invited to.' },
  oauth_config: { scopes: { bot: SCOPES } },
};
export const manifestUrl = (kind = 'user') => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(kind === 'bot' ? MANIFEST_BOT : MANIFEST))}`;

export const slack = { ok: false, at: 0, prs: [], error: null };

// PR alerts for the board to show as notifications: someone started reviewing / approved your PR, or a
// teammate's PR has waited too long for a reviewer. Newest last; the page shows the ones it hasn't seen.
export const prEvents = [];
let lastEventId = 0;
function prEvent(kind, title, body, url) {
  const id = Math.max(Date.now(), lastEventId + 1);
  lastEventId = id;
  prEvents.push({ id, kind, title, body, url });
  if (prEvents.length > 30) prEvents.shift();
}
const hours = (ms) => { const h = ms / 3600e3; return h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h)} h`; };
const listNames = (xs) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const users = new Map(); // id -> { name, at }

async function api(method, params = {}, tok) {
  const t = tok || getConfig().slack.token;
  if (!t) throw new Error('Slack is not connected');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) { await sleep(Number(res.headers.get('retry-after') || 5) * 1000); continue; }
    const d = await res.json();
    if (!d.ok) {
      const hints = {
        invalid_auth: 'Slack rejected the token. Connect again.',
        not_authed: 'Slack rejected the token. Connect again.',
        token_revoked: 'The Slack token was revoked. Connect again.',
        missing_scope: `The Slack app is missing a permission (${d.needed || 'see manifest'}). Reinstall it from the manifest.`,
        not_in_channel: 'The Sheepdog bot isn’t in that channel yet. In Slack, type /invite @Sheepdog in the channel, then try again.',
        channel_not_found: 'Channel not found, or Sheepdog can’t see it.',
      };
      throw new Error(hints[d.error] || `Slack: ${d.error}`);
    }
    return d;
  }
  throw new Error('Slack is rate limiting Sheepdog; try again in a minute');
}

/** Strips what copy/paste drags along: whitespace, line breaks, quotes, zero-width characters, "Bearer ". */
export function cleanToken(tok) {
  return String(tok || '').replace(/[\s​-‍⁠﻿"'`‘’“”]/g, '').replace(/^Bearer/i, '');
}

/** null if the value looks like a usable Slack token, else a message saying what was pasted instead. */
export function tokenProblem(tok) {
  if (!tok) return 'Paste a Slack token: your User OAuth Token (xoxp-…) or your team’s Bot User OAuth Token (xoxb-…).';
  // xoxp- user, xoxb- bot; xoxe.xoxp- / xoxe.xoxb- when the app has token rotation on
  if (/^(xoxe\.)?xox[bp]-[A-Za-z0-9-]{8,}$/.test(tok)) return null;
  const head = `It starts with “${tok.slice(0, 5)}…” (${tok.length} characters).`;
  if (tok.startsWith('xapp-')) return `That’s an app-level token. ${head} Use the User OAuth Token (xoxp-) or Bot User OAuth Token (xoxb-) under OAuth & Permissions.`;
  if (tok.startsWith('xoxe-')) return `That’s a refresh token. ${head} Use the User OAuth Token (xoxp-) or Bot User OAuth Token (xoxb-) under OAuth & Permissions.`;
  if (/^[a-f0-9]{32}$/i.test(tok)) return 'That looks like the Client Secret or Signing Secret from Basic Information. Use the User OAuth Token (xoxp-) or Bot User OAuth Token (xoxb-) under OAuth & Permissions.';
  if (/^\d+\.\d+$/.test(tok)) return 'That looks like the Client ID. Use the User OAuth Token (xoxp-) or Bot User OAuth Token (xoxb-) under OAuth & Permissions.';
  if (/^A[A-Z0-9]{8,}$/.test(tok)) return 'That looks like the App ID. Use the User OAuth Token (xoxp-) or Bot User OAuth Token (xoxb-) under OAuth & Permissions.';
  if (/^xox[bp]-/.test(tok)) return `The token contains unexpected characters. ${head} Copy it again with the Copy button on OAuth & Permissions.`;
  return `That isn’t a Slack token. ${head} Use the User OAuth Token (xoxp-) or Bot User OAuth Token (xoxb-) under OAuth & Permissions.`;
}

export async function connect(tok) {
  tok = cleanToken(tok);
  const bad = tokenProblem(tok);
  if (bad) throw new Error(bad);
  const me = await api('auth.test', {}, tok);
  const isUser = /^(xoxe\.)?xoxp-/.test(tok);
  let name = me.user;
  try { const u = await api('users.info', { user: me.user_id }, tok); name = u.user?.real_name || u.user?.profile?.display_name || me.user; } catch {}
  // a personal token this one replaces is revoked once the new one is known to work
  const previous = getConfig().slack.token;
  if (previous && previous !== tok && /^(xoxe\.)?xoxp-/.test(previous)) {
    try { await api('auth.revoke', {}, previous); log('slack: revoked the replaced personal token'); } catch (e) { log('slack: revoke failed:', e.message); }
  }
  updateConfig((c) => {
    // a bot token doesn't say who you are: keep a previously known identity (switching from your own token)
    Object.assign(c.slack, { token: tok, team: me.team, teamUrl: me.url, user: isUser ? name : c.slack.userId ? c.slack.user : '', userId: isUser ? me.user_id : c.slack.userId });
  });
  return { team: me.team, user: isUser ? name : null, kind: isUser ? 'user' : 'bot' };
}

/** Forget the token. A personal token (xoxp-) is also revoked in Slack, so it can't be used anywhere
 *  any more; a shared bot token is never revoked, because the rest of the team still uses it. */
export async function disconnect({ keepIdentity = false } = {}) {
  const tok = getConfig().slack.token;
  if (/^(xoxe\.)?xoxp-/.test(tok)) {
    try { await api('auth.revoke', {}, tok); log('slack: revoked the personal token'); } catch (e) { log('slack: revoke failed:', e.message); }
  }
  updateConfig((c) => {
    Object.assign(c.slack, { token: '', team: '', teamUrl: '', channelId: '', channelName: '' });
    if (!keepIdentity) Object.assign(c.slack, { user: '', userId: '' });
  });
  Object.assign(slack, { ok: false, prs: [], error: null });
}

/** Channels the token can see (members first), for the channel picker. */
export async function listChannels(q = '') {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const d = await api('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, ...(cursor ? { cursor } : {}) });
    out.push(...d.channels);
    cursor = d.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  const needle = String(q).toLowerCase().replace(/^#/, '');
  return out.filter((c) => c.name.toLowerCase().includes(needle))
    .sort((a, b) => (b.is_member - a.is_member) || a.name.localeCompare(b.name))
    .slice(0, 50)
    .map((c) => ({ id: c.id, name: c.name, private: c.is_private, member: c.is_member, members: c.num_members }));
}

// ---------------------------------------------------------------- "who are you" (bot tokens)
let directory = null; // { at, users: [{ id, name, real }] }
async function allUsers() {
  if (directory && Date.now() - directory.at < 10 * 60e3) return directory.users;
  const list = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const d = await api('users.list', { limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const u of d.members || []) {
      if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
      list.push({ id: u.id, name: u.profile?.display_name || u.real_name || u.name, real: u.real_name || u.profile?.real_name || '' });
    }
    cursor = d.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  directory = { at: Date.now(), users: list };
  return list;
}

/** People to pick from (members of the review channel when there is one), matching q. */
export async function listMembers(q = '') {
  const s = getConfig().slack;
  const people = await allUsers();
  let inChannel = null;
  if (s.channelId) {
    try {
      inChannel = new Set();
      let cursor = '';
      for (let page = 0; page < 10; page++) {
        const d = await api('conversations.members', { channel: s.channelId, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const id of d.members || []) inChannel.add(id);
        cursor = d.response_metadata?.next_cursor;
        if (!cursor) break;
      }
    } catch { inChannel = null; }
  }
  const needle = String(q).toLowerCase().replace(/^@/, '').trim();
  return people
    .filter((u) => (!inChannel || inChannel.has(u.id)) && (!needle || `${u.name} ${u.real}`.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 20);
}

/** Bot tokens: remember which Slack member this person is. */
export async function setMe(id) {
  if (!/^[UW][A-Z0-9]{2,20}$/.test(id || '')) throw new Error('Invalid Slack member');
  const u = (await api('users.info', { user: id })).user;
  if (!u || u.deleted) throw new Error('That Slack member wasn’t found');
  const name = u.profile?.display_name || u.real_name || u.name;
  updateConfig((c) => { c.slack.userId = id; c.slack.user = name; });
  return { id, name };
}

async function userName(id) {
  if (!id) return null;
  const hit = users.get(id);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.name;
  try {
    const u = (await api('users.info', { user: id })).user;
    const name = u?.profile?.display_name || u?.real_name || u?.name || id;
    users.set(id, { name, at: Date.now() });
    return name;
  } catch { return hit?.name || id; }
}

const PR_RE = /https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+/g;

function prUrlsIn(msg) {
  // links can sit in text, attachments or blocks; Slack wraps them as <url|label>
  const text = JSON.stringify([msg.text, msg.attachments, msg.blocks]);
  return [...new Set((text.match(PR_RE) || []))];
}

const tsToMs = (ts) => Math.round(Number(ts) * 1000);

export async function refreshSlack() {
  const s = getConfig().slack;
  if (!s.token || !s.channelId) { Object.assign(slack, { ok: false, prs: [], error: s.token ? 'Pick a review channel' : null }); return; }
  try {
    const oldest = Date.now() / 1000 - s.lookbackDays * 86400;
    const msgs = [];
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      const d = await api('conversations.history', { channel: s.channelId, oldest, limit: 200, ...(cursor ? { cursor } : {}) });
      msgs.push(...d.messages);
      cursor = d.has_more ? d.response_metadata?.next_cursor : '';
      if (!cursor) break;
    }
    const st = getState();
    st.reactionSeen ||= {};
    const seen = st.reactionSeen;
    const now = Date.now();
    const items = [];
    for (const m of msgs) {
      if (m.subtype && !['bot_message', 'thread_broadcast'].includes(m.subtype)) continue;
      const urls = prUrlsIn(m);
      if (!urls.length) continue;
      const reactions = m.reactions || [];
      const users_ = (name) => reactions.find((r) => r.name === name || r.name.startsWith(`${name}::`))?.users || [];
      const reviewers = users_(s.reviewing);
      const approvers = users_(s.approved);
      const since = (who, kind) => {
        const k = `${m.ts}:${kind}:${who}`;
        if (!seen[k]) seen[k] = now;
        return seen[k];
      };
      items.push({
        ts: m.ts, url: urls[0], text: m.text, postedAt: tsToMs(m.ts), poster: m.user || null,
        posterName: m.user ? null : m.bot_profile?.name || m.username || 'app',
        reviewers: reviewers.map((u) => ({ id: u, since: since(u, 'r') })),
        approvers: approvers.map((u) => ({ id: u, since: since(u, 'a') })),
        replies: m.reply_count || 0,
        link: s.teamUrl ? `${s.teamUrl.replace(/\/$/, '')}/archives/${s.channelId}/p${m.ts.replace('.', '')}` : null,
      });
    }
    // forget reaction times for messages no longer in the window
    const live = new Set(items.map((i) => i.ts));
    for (const k of Object.keys(seen)) if (!live.has(k.split(':')[0])) delete seen[k];
    saveStateSoon();

    // newest message per PR wins (a PR re-posted later replaces the old post)
    const byUrl = new Map();
    for (const it of items.sort((a, b) => b.postedAt - a.postedAt)) if (!byUrl.has(it.url)) byUrl.set(it.url, it);
    const details = await prDetails([...byUrl.keys()]);
    const al = getConfig().alerts;
    st.prSeen ||= {};   // url -> { r: reviewer ids, a: approved, n: nudged }; alerts fire on changes only
    st.prHistory ||= {}; // url -> last timeline written to history
    st.ghApproved ||= {}; // url -> when Sheepdog first saw GitHub say "approved"
    const prs = [];
    const liveUrls = new Set();
    for (const it of byUrl.values()) {
      const d = details.get(it.url);
      liveUrls.add(it.url);
      const done = !!(d && (d.merged || d.state === 'CLOSED'));
      const nameOf = async (list) => Promise.all(list.map(async (x) => ({ ...x, name: await userName(x.id) })));
      const [reviewers0, approvers] = await Promise.all([nameOf(it.reviewers), nameOf(it.approvers)]);
      const reviewers = reviewers0.filter((r) => r.id !== it.poster); // the poster's own 👀 doesn't count as a review
      const posterName = it.poster ? await userName(it.poster) : it.posterName;
      const m = it.url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
      const author = d?.author || null;
      const yours = !!((s.userId && it.poster === s.userId) || (author && github.viewer && author.toLowerCase() === github.viewer.toLowerCase()));
      const repo = d?.repo || m[1], number = d?.number || Number(m[2]);
      const title = d?.title || it.text.replace(/<[^>]+>/g, '').trim().slice(0, 120) || it.url;
      if (d?.review === 'APPROVED') st.ghApproved[it.url] ||= now;
      const approvedAt = approvers.length ? Math.min(...approvers.map((a) => a.since)) : st.ghApproved[it.url] || null;
      const approved = !!approvedAt;

      recordPr({ url: it.url, repo, number, title, author: author || posterName, yours, postedAt: it.postedAt,
        reviewAt: reviewers.length ? Math.min(...reviewers.map((r) => r.since)) : null, approvedAt,
        reviewers: reviewers.map((r) => r.name), approvers: approvers.map((r) => r.name), done }, st.prHistory, now);

      // alerts: compare with what we saw last time (the first sighting only sets the baseline)
      const nudgeMs = (al.prNudgeHours || 0) * 3600e3;
      const overdue = !!nudgeMs && !yours && !approved && !reviewers.length && now - it.postedAt > nudgeMs;
      const was = st.prSeen[it.url];
      if (was && !done && !d?.draft) {
        const what = `${repo} #${number} · ${title}`;
        const fresh = reviewers.filter((r) => !was.r.includes(r.id));
        if (yours && fresh.length && !approved && al.prReview) prEvent('review', `${listNames(fresh.map((r) => r.name))} started reviewing your PR`, what, it.url);
        if (yours && approved && !was.a && al.prApproved) prEvent('approved', `${approvers.length ? listNames(approvers.map((r) => r.name)) : 'Someone'} approved your PR`, what, it.url);
        if (overdue && !was.n) prEvent('nudge', `No reviewer for ${hours(now - it.postedAt)}`, `${author || posterName}: ${what}`, it.url);
      }
      st.prSeen[it.url] = { r: [...new Set([...(was?.r || []), ...reviewers.map((r) => r.id)])], a: approved, n: !!(was?.n || overdue) };

      // approved, merged and closed PRs leave the sidebar
      if (done || approved) continue;
      prs.push({
        url: it.url, link: it.link, repo, number, title,
        author: author || posterName, yours, postedAt: it.postedAt, ci: d?.ci || null, draft: !!d?.draft,
        reviewers, approvers, replies: it.replies,
      });
    }
    for (const memo of [st.prSeen, st.prHistory, st.ghApproved]) for (const u of Object.keys(memo)) if (!liveUrls.has(u)) delete memo[u];
    saveStateSoon();
    prs.sort((a, b) => b.postedAt - a.postedAt);
    Object.assign(slack, { ok: true, at: Date.now(), prs, error: null });
  } catch (e) {
    Object.assign(slack, { ok: false, error: e.message });
    log('slack:', e.message);
  }
}
