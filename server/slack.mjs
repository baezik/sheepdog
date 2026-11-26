// Slack: the PR review sidebar. Reads one channel the user picks, finds messages that link a GitHub
// PR, and turns reactions into review state:
//   :eyes: (configurable)             -> someone is reviewing (name + since when Sheepdog first saw it)
//   :white_check_mark: (configurable) -> approved
// Thread replies link back to Slack. PRs leave the list once approved (✅ or GitHub approval), when
// GitHub says they are merged or closed (if connected), or when the message is older than the lookback window.
//
// Connecting: the user creates a Slack app from our manifest (one click), installs it to their
// workspace and pastes the *User OAuth Token* (xoxp-). A user token reads any channel the user is
// in, without inviting a bot. A bot token (xoxb-) also works once the bot is invited to the channel.
import { getConfig, updateConfig, getState, saveStateSoon } from './config.mjs';
import { prDetails, github } from './github.mjs';
import { log, sleep } from './util.mjs';

export const SCOPES = ['channels:history', 'groups:history', 'channels:read', 'groups:read', 'reactions:read', 'users:read'];
export const MANIFEST = {
  display_information: { name: 'Sheepdog', description: 'Shows PR review status from a Slack channel in Sheepdog.', background_color: '#1e1f23' },
  oauth_config: { scopes: { user: SCOPES, bot: ['channels:history', 'groups:history', 'channels:read', 'groups:read', 'reactions:read', 'users:read'] } },
  features: { bot_user: { display_name: 'Sheepdog', always_online: false } },
  settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
};
export const manifestUrl = () => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(MANIFEST))}`;

export const slack = { ok: false, at: 0, prs: [], error: null };
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
        not_in_channel: 'Sheepdog is not in that channel. Invite the Sheepdog app, or use a user token (xoxp-).',
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
  if (!tok) return 'Paste the User OAuth Token (starts with xoxp-).';
  // xoxp- user, xoxb- bot; xoxe.xoxp- / xoxe.xoxb- when the app has token rotation on
  if (/^(xoxe\.)?xox[bp]-[A-Za-z0-9-]{8,}$/.test(tok)) return null;
  const head = `It starts with “${tok.slice(0, 5)}…” (${tok.length} characters).`;
  if (tok.startsWith('xapp-')) return `That’s an app-level token. ${head} Use the User OAuth Token under OAuth & Permissions (xoxp-).`;
  if (tok.startsWith('xoxe-')) return `That’s a refresh token. ${head} Use the User OAuth Token under OAuth & Permissions (xoxp-).`;
  if (/^[a-f0-9]{32}$/i.test(tok)) return 'That looks like the Client Secret or Signing Secret from Basic Information. Use the User OAuth Token under OAuth & Permissions (xoxp-).';
  if (/^\d+\.\d+$/.test(tok)) return 'That looks like the Client ID. Use the User OAuth Token under OAuth & Permissions (xoxp-).';
  if (/^A[A-Z0-9]{8,}$/.test(tok)) return 'That looks like the App ID. Use the User OAuth Token under OAuth & Permissions (xoxp-).';
  if (/^xox[bp]-/.test(tok)) return `The token contains unexpected characters. ${head} Copy it again with the Copy button on OAuth & Permissions.`;
  return `That isn’t a Slack token. ${head} Use the User OAuth Token under OAuth & Permissions (xoxp-).`;
}

export async function connect(tok) {
  tok = cleanToken(tok);
  const bad = tokenProblem(tok);
  if (bad) throw new Error(bad);
  const me = await api('auth.test', {}, tok);
  const isUser = /^(xoxe\.)?xoxp-/.test(tok);
  let name = me.user;
  try { const u = await api('users.info', { user: me.user_id }, tok); name = u.user?.real_name || u.user?.profile?.display_name || me.user; } catch {}
  updateConfig((c) => {
    Object.assign(c.slack, { token: tok, team: me.team, teamUrl: me.url, user: isUser ? name : '', userId: isUser ? me.user_id : c.slack.userId });
  });
  return { team: me.team, user: isUser ? name : null, kind: isUser ? 'user' : 'bot' };
}

export function disconnect() {
  updateConfig((c) => { Object.assign(c.slack, { token: '', team: '', teamUrl: '', user: '', userId: '', channelId: '', channelName: '' }); });
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
    const prs = [];
    for (const it of byUrl.values()) {
      const d = details.get(it.url);
      if (d && (d.merged || d.state === 'CLOSED')) continue;
      // approved PRs (✅ in Slack or approved on GitHub) leave the sidebar
      if (it.approvers.length || d?.review === 'APPROVED') continue;
      const nameOf = async (list) => Promise.all(list.map(async (x) => ({ ...x, name: await userName(x.id) })));
      const [reviewers, approvers] = await Promise.all([nameOf(it.reviewers), nameOf(it.approvers)]);
      const posterName = it.poster ? await userName(it.poster) : it.posterName;
      const m = it.url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
      const author = d?.author || null;
      const yours = (s.userId && it.poster === s.userId) || (author && github.viewer && author.toLowerCase() === github.viewer.toLowerCase());
      // the poster's own 👀 doesn't count as a review
      prs.push({
        url: it.url, link: it.link, repo: d?.repo || m[1], number: d?.number || Number(m[2]),
        title: d?.title || it.text.replace(/<[^>]+>/g, '').trim().slice(0, 120) || it.url,
        author: author || posterName, yours: !!yours, postedAt: it.postedAt, ci: d?.ci || null, draft: !!d?.draft,
        reviewers: reviewers.filter((r) => r.id !== it.poster), approvers, replies: it.replies,
      });
    }
    prs.sort((a, b) => b.postedAt - a.postedAt);
    Object.assign(slack, { ok: true, at: Date.now(), prs, error: null });
  } catch (e) {
    Object.assign(slack, { ok: false, error: e.message });
    log('slack:', e.message);
  }
}
