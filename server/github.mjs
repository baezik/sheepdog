// GitHub: who the user is, last merge per tracked repo/branch, and live state of PRs posted in Slack.
// Three ways to connect:
//   gh     – reuse the GitHub CLI login (`gh auth token`), nothing stored by Sheepdog
//   token  – a pasted personal access token (classic: repo, read:org; fine-grained: Contents,
//            Pull requests, Deployments, Commit statuses read-only)
//   device – "Sign in with GitHub" (OAuth device flow); needs an OAuth app client id
import { getConfig, updateConfig } from './config.mjs';
import { run, log } from './util.mjs';

const API = 'https://api.github.com';
export const DEVICE_CLIENT_ID = process.env.SHEEPDOG_GITHUB_CLIENT_ID || '';
export const github = { ok: false, at: 0, viewer: null, branches: [], error: null };

let ghCliToken = null;
async function ghCli() {
  if (ghCliToken) return ghCliToken;
  ghCliToken = (await run('gh', ['auth', 'token'], { timeout: 8000 })).trim();
  return ghCliToken;
}

export async function ghInstalled() {
  try {
    await run('gh', ['--version'], { timeout: 5000 });
    try { await run('gh', ['auth', 'status'], { timeout: 8000 }); return { installed: true, loggedIn: true }; }
    catch { return { installed: true, loggedIn: false }; }
  } catch { return { installed: false, loggedIn: false }; }
}

async function token() {
  const g = getConfig().github;
  if (g.auth === 'gh') return ghCli();
  if (g.auth === 'token' || g.auth === 'device') return g.token || null;
  return null;
}

async function request(pathOrUrl, { method = 'GET', body, tok } = {}) {
  const t = tok || (await token());
  if (!t) throw new Error('GitHub is not connected');
  const res = await fetch(pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl, {
    method,
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json', 'User-Agent': 'sheepdog', 'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) { ghCliToken = null; throw new Error('GitHub rejected the token (401). Connect again.'); }
    throw new Error(data.message ? `GitHub: ${data.message}` : `GitHub HTTP ${res.status}`);
  }
  return { data, headers: res.headers };
}

async function graphql(query, variables = {}, tok) {
  const { data } = await request('/graphql', { method: 'POST', body: { query, variables }, tok });
  if (data.errors?.length && !data.data) throw new Error(`GitHub: ${data.errors[0].message}`);
  return data.data;
}

/** Check a token (or the current connection) and return who it belongs to. */
export async function whoAmI(tok) {
  const { data, headers } = await request('/user', { tok });
  return { login: data.login, name: data.name, scopes: headers.get('x-oauth-scopes') || '' };
}

export async function connectWithToken(tok) {
  tok = String(tok || '').trim();
  if (!/^[A-Za-z0-9_]{20,255}$/.test(tok)) throw new Error('That does not look like a GitHub token');
  const me = await whoAmI(tok);
  updateConfig((c) => { c.github.auth = 'token'; c.github.token = tok; c.github.login = me.login; });
  return me;
}

export async function connectWithGhCli() {
  ghCliToken = null;
  const tok = await ghCli().catch(() => { throw new Error('GitHub CLI is not logged in. Run `gh auth login` first.'); });
  const me = await whoAmI(tok);
  updateConfig((c) => { c.github.auth = 'gh'; c.github.token = ''; c.github.login = me.login; });
  return me;
}

export function disconnect() {
  ghCliToken = null;
  updateConfig((c) => { c.github.auth = 'none'; c.github.token = ''; c.github.login = ''; });
  Object.assign(github, { ok: false, viewer: null, branches: [], error: null });
}

// ---------------------------------------------------------------- device flow
let device = null; // { deviceCode, userCode, uri, interval, expires, status, error }
const clientId = () => getConfig().github.clientId || DEVICE_CLIENT_ID;

export async function deviceStart() {
  const id = clientId();
  if (!id) throw new Error('Sign-in with GitHub needs an OAuth app client ID (Settings › GitHub). Use the GitHub CLI or a token instead.');
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: id, scope: 'repo read:org' }), signal: AbortSignal.timeout(15000),
  });
  const d = await res.json();
  if (!d.device_code) throw new Error(`GitHub: ${d.error_description || d.error || 'device flow failed'}`);
  device = { deviceCode: d.device_code, userCode: d.user_code, uri: d.verification_uri, interval: d.interval || 5,
    expires: Date.now() + d.expires_in * 1000, status: 'pending' };
  pollDevice();
  return { userCode: device.userCode, uri: device.uri, expiresIn: d.expires_in };
}

async function pollDevice() {
  const me = device;
  while (me === device && me.status === 'pending') {
    await new Promise((r) => setTimeout(r, me.interval * 1000));
    if (me !== device) return;
    if (Date.now() > me.expires) { me.status = 'expired'; return; }
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId(), device_code: me.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await res.json();
      if (d.access_token) {
        const who = await whoAmI(d.access_token);
        updateConfig((c) => { c.github.auth = 'device'; c.github.token = d.access_token; c.github.login = who.login; });
        me.status = 'done'; me.login = who.login;
        refreshGithub();
        return;
      }
      if (d.error === 'slow_down') me.interval += 5;
      else if (d.error && d.error !== 'authorization_pending') { me.status = 'error'; me.error = d.error_description || d.error; }
    } catch (e) { log('device poll:', e.message); }
  }
}

export const deviceStatus = () => (device ? { status: device.status, login: device.login, error: device.error, userCode: device.userCode, uri: device.uri } : { status: 'none' });
export const deviceCancel = () => { if (device) device.status = 'cancelled'; device = null; };

// ---------------------------------------------------------------- repos
/** "owner/name", "https://github.com/owner/name(.git)" or "git@github.com:owner/name.git" -> "owner/name" */
export function parseRepo(input) {
  const s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = s.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function validateRepo(input) {
  const full = parseRepo(input);
  if (!full) throw new Error('Use owner/repo or a GitHub URL');
  const { data } = await request(`/repos/${full}`);
  return { fullName: data.full_name, private: data.private, defaultBranch: data.default_branch };
}

/** Repos the user can see, most recently pushed first, filtered by a search string. */
export async function listRepos(q = '') {
  const { data } = await request('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
  const needle = String(q).toLowerCase();
  return data.filter((r) => !r.archived && r.full_name.toLowerCase().includes(needle)).slice(0, 30)
    .map((r) => ({ fullName: r.full_name, private: r.private, pushedAt: r.pushed_at }));
}

export function setRepos(list) {
  const clean = [...new Set(list.map(parseRepo).filter(Boolean))].slice(0, 30);
  updateConfig((c) => { c.github.repos = clean; });
  refreshGithub();
  return clean;
}

// ---------------------------------------------------------------- polling
const norm = (s) => {
  if (!s) return null;
  s = s.toUpperCase();
  if (s === 'SUCCESS') return 'ok';
  if (s === 'FAILURE' || s === 'ERROR') return 'fail';
  if (['PENDING', 'EXPECTED', 'IN_PROGRESS', 'QUEUED', 'WAITING'].includes(s)) return 'pending';
  return null;
};
const worst = (...xs) => (xs.includes('fail') ? 'fail' : xs.includes('pending') ? 'pending' : xs.includes('ok') ? 'ok' : null);
const COMMIT = `target { ... on Commit { committedDate messageHeadline statusCheckRollup { state }
  author { name user { login } } associatedPullRequests(first: 1) { nodes { number title url } } } }`;

async function fetchBranches() {
  const { repos, branches } = getConfig().github;
  if (!repos.length) return [];
  const vars = {};
  const defs = [];
  const parts = repos.map((full, i) => {
    const [owner, name] = full.split('/');
    vars[`o${i}`] = owner; vars[`n${i}`] = name;
    defs.push(`$o${i}: String!`, `$n${i}: String!`);
    const refs = branches.map((_, j) => `b${j}: ref(qualifiedName: $q${j}) { ${COMMIT} }`).join('\n');
    return `r${i}: repository(owner: $o${i}, name: $n${i}) { ${refs}
      deployments(first: 30, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { environment ref { name } latestStatus { state } } } }`;
  });
  branches.forEach((b, j) => { vars[`q${j}`] = `refs/heads/${b}`; defs.push(`$q${j}: String!`); });
  const d = await graphql(`query(${defs.join(', ')}) { ${parts.join('\n')} }`, vars);
  return repos.map((full, i) => {
    const r = d[`r${i}`];
    const row = { repo: full, name: full.split('/')[1], missing: !r, cells: {} };
    branches.forEach((b, j) => {
      const c = r?.[`b${j}`]?.target;
      if (!c) { row.cells[b] = null; return; }
      const dep = r.deployments.nodes.find((n) => n.ref?.name === b);
      const cell = { ci: norm(c.statusCheckRollup?.state), deploy: dep ? norm(dep.latestStatus?.state) : null, env: dep?.environment || null,
        at: c.committedDate, msg: c.messageHeadline, author: c.author?.user?.login || c.author?.name || null,
        pr: c.associatedPullRequests?.nodes?.[0] || null };
      cell.state = worst(cell.ci, cell.deploy) || 'none';
      row.cells[b] = cell;
    });
    return row;
  });
}

export async function refreshGithub() {
  const g = getConfig().github;
  if (g.auth === 'none') { Object.assign(github, { ok: false, viewer: null, branches: [], error: null }); return; }
  try {
    const viewer = g.login || (await whoAmI()).login;
    const branches = await fetchBranches();
    Object.assign(github, { ok: true, at: Date.now(), viewer, branches, error: null });
  } catch (e) {
    Object.assign(github, { ok: false, error: e.message });
    log('github:', e.message);
  }
}

/** Live state for PR URLs found in Slack: { url -> { state, merged, draft, author, title, ci, review, repo, number } } */
export async function prDetails(urls) {
  const out = new Map();
  if (getConfig().github.auth === 'none' || !urls.length) return out;
  const list = [];
  for (const url of new Set(urls)) {
    const m = url.match(/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/);
    if (m) list.push({ url, owner: m[1], name: m[2], number: Number(m[3]) });
  }
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    const vars = {};
    const defs = [];
    const parts = chunk.map((p, k) => {
      vars[`o${k}`] = p.owner; vars[`n${k}`] = p.name; vars[`p${k}`] = p.number;
      defs.push(`$o${k}: String!`, `$n${k}: String!`, `$p${k}: Int!`);
      return `x${k}: repository(owner: $o${k}, name: $n${k}) { pullRequest(number: $p${k}) {
        state merged isDraft title url reviewDecision author { login }
        reviews(states: APPROVED, first: 1) { totalCount }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }`;
    });
    try {
      const d = await graphql(`query(${defs.join(', ')}) { ${parts.join('\n')} }`, vars);
      chunk.forEach((p, k) => {
        const pr = d?.[`x${k}`]?.pullRequest;
        if (pr) out.set(p.url, { state: pr.state, merged: pr.merged, draft: pr.isDraft, title: pr.title, author: pr.author?.login,
          review: pr.reviewDecision,
          // reviewDecision stays empty on repos that don't require reviews, so also look for an approving review
          approved: pr.reviewDecision === 'APPROVED' || (pr.reviews?.totalCount > 0 && pr.reviewDecision !== 'CHANGES_REQUESTED'), ci: norm(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state), repo: p.name, number: p.number });
      });
    } catch (e) { log('github pr details:', e.message); }
  }
  return out;
}
