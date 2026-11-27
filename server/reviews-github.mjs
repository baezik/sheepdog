// GitHub as the review sidebar's source, for teams without a Slack review channel: the open pull requests in
// the repositories picked in Settings › GitHub. GitHub knows exactly when each review was submitted, so
// review times (Stats, Today, Leaderboards) are exact and the same for everyone.
//   a review requested, nobody started -> waiting for a reviewer (names shown as "asked")
//   any submitted review               -> reviewing, since that review
//   approved (GitHub's review decision, or an approval on repos that don't require reviews) -> leaves the list
// The sidebar items have the same shape as the Slack ones (one "post" per PR), so the board treats both alike.
import { getConfig, getState, saveStateSoon } from './config.mjs';
import { graphql, github, norm } from './github.mjs';
import { recordPr } from './history.mjs';
import { linksIn } from './tickets.mjs';
import { prEvent } from './slack.mjs';
import { log } from './util.mjs';

export const ghReviews = { ok: false, at: 0, prs: [], error: null, ticketLinks: [] };

const PR_FIELDS = `number title url isDraft createdAt body reviewDecision
  author { login ... on User { name } }
  comments { totalCount }
  timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) { nodes { ... on ReadyForReviewEvent { createdAt } } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login name } ... on Team { name } } } }
  reviews(first: 60) { nodes { state submittedAt author { login ... on User { name } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

/** Open PRs of the given repos ("owner/name"), raw from GitHub. */
async function fetchOpenPrs(repos) {
  const out = [];
  for (let i = 0; i < repos.length; i += 10) {
    const chunk = repos.slice(i, i + 10);
    const vars = {}, defs = [];
    const parts = chunk.map((full, k) => {
      const [owner, name] = full.split('/');
      vars[`o${k}`] = owner; vars[`n${k}`] = name;
      defs.push(`$o${k}: String!`, `$n${k}: String!`);
      return `r${k}: repository(owner: $o${k}, name: $n${k}) { name pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } } }`;
    });
    const d = await graphql(`query(${defs.join(', ')}) { ${parts.join('\n')} }`, vars);
    chunk.forEach((_, k) => { const r = d?.[`r${k}`]; for (const pr of r?.pullRequests?.nodes || []) out.push({ ...pr, repo: r.name }); });
  }
  return out;
}

const ms = (iso) => (iso ? Date.parse(iso) : null);
const nameOf = (a) => a?.name || a?.login || 'someone';

/** One PR from GitHub -> a sidebar item, plus who reviewed / approved it and when. Exported for tests. */
export function toItem(pr, viewer) {
  const author = pr.author?.login || null;
  const me = (viewer || '').toLowerCase();
  // reviews in the order they were submitted; drafts of a review (PENDING) aren't submitted yet
  const done = (pr.reviews?.nodes || []).filter((r) => r.submittedAt && r.author?.login && r.author.login !== author && r.state !== 'PENDING')
    .sort((a, b) => ms(a.submittedAt) - ms(b.submittedAt));
  const reviewers = new Map(); // login -> { id, name, since: first review }
  const latest = new Map(); // login -> latest review that approved or asked for changes
  for (const r of done) {
    const login = r.author.login;
    if (!reviewers.has(login)) reviewers.set(login, { id: `gh:${login}`, name: nameOf(r.author), since: ms(r.submittedAt) });
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') latest.set(login, r);
  }
  const approvers = [...latest].filter(([, r]) => r.state === 'APPROVED')
    .map(([login, r]) => ({ id: `gh:${login}`, name: nameOf(r.author), since: ms(r.submittedAt) }));
  const asked = (pr.reviewRequests?.nodes || []).map((n) => n.requestedReviewer).filter(Boolean);
  const approved = pr.reviewDecision === 'APPROVED' || (approvers.length > 0 && pr.reviewDecision !== 'CHANGES_REQUESTED');
  const ready = ms(pr.timelineItems?.nodes?.[0]?.createdAt);
  return {
    url: pr.url, link: pr.url, ts: pr.url, repo: pr.repo, number: pr.number, title: pr.title,
    status: approved ? 'approved' : 'open', draft: !!pr.isDraft,
    author: author || 'someone', poster: nameOf(pr.author), by: author ? [`gh:${author}`, nameOf(pr.author)] : null,
    yours: !!(me && author && author.toLowerCase() === me),
    postedAt: ready || ms(pr.createdAt), // a draft counts from when it was marked ready for review
    ci: norm(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    reviewers: [...reviewers.values()], approvers,
    // who is asked to review and hasn't yet (you are left out here and flagged as forYou)
    asked: asked.filter((r) => !(r.__typename === 'User' && r.login?.toLowerCase() === me)).map((r) => (r.__typename === 'Team' ? `@${r.name}` : nameOf(r))),
    forYou: !!me && asked.some((r) => r.__typename === 'User' && r.login?.toLowerCase() === me),
    changes: pr.reviewDecision === 'CHANGES_REQUESTED',
    replies: pr.comments?.totalCount || 0,
    ticketLinks: linksIn(pr.body).slice(0, 5),
  };
}

const hours = (x) => { const h = x / 3600e3; return h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h)} h`; };
const listNames = (xs) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export async function refreshGithubReviews() {
  const c = getConfig();
  if (c.github.auth === 'none' || !c.github.repos.length) { Object.assign(ghReviews, { ok: false, prs: [], error: null }); return; }
  try {
    const viewer = github.viewer || c.github.login;
    const items = (await fetchOpenPrs(c.github.repos)).map((pr) => toItem(pr, viewer));
    const st = getState();
    st.ghPrSeen ||= {};
    st.ghPrHistory ||= {};
    const al = c.alerts;
    const now = Date.now();
    const live = new Set();
    for (const it of items) {
      live.add(it.url);
      if (it.draft) continue;
      recordPr({ url: it.url, repo: it.repo, number: it.number, title: it.title, author: it.author, yours: it.yours, postedAt: it.postedAt,
        reviewAt: it.reviewers.length ? Math.min(...it.reviewers.map((r) => r.since)) : null,
        approvedAt: it.status === 'approved' ? Math.min(...it.approvers.map((a) => a.since), now) : null,
        reviewers: it.reviewers.map((r) => r.name), approvers: it.approvers.map((r) => r.name), done: false, by: it.by,
        rv: it.reviewers.map((r) => [r.id, r.since, r.name, 0]), ap: it.approvers.map((a) => [a.id, a.since, a.name, 0]) }, st.ghPrHistory, now);

      // alerts, on changes since the last look (the first sighting only sets the baseline)
      const was = st.ghPrSeen[it.url];
      const what = `${it.repo} #${it.number} · ${it.title}`;
      const approved = it.status === 'approved';
      const nudgeMs = (al.prNudgeHours || 0) * 3600e3;
      const overdue = !!nudgeMs && !it.yours && !approved && !it.reviewers.length && now - it.postedAt > nudgeMs;
      if (was) {
        const fresh = it.reviewers.filter((r) => !was.r.includes(r.id));
        if (it.yours && fresh.length && !approved && al.prReview) prEvent('review', `${listNames(fresh.map((r) => r.name))} started reviewing your PR`, what, it.url);
        if (it.yours && approved && !was.a && al.prApproved) prEvent('approved', `${it.approvers.length ? listNames(it.approvers.map((r) => r.name)) : 'Someone'} approved your PR`, what, it.url);
        if (it.forYou && !was.f && al.prRequested) prEvent('request', `${it.poster} asked you to review`, what, it.url);
        if (overdue && !was.n) prEvent('nudge', `No reviewer for ${hours(now - it.postedAt)}`, `${it.poster}: ${what}`, it.url);
      }
      st.ghPrSeen[it.url] = { r: [...new Set([...(was?.r || []), ...it.reviewers.map((r) => r.id)])], a: approved, f: it.forYou, n: !!(was?.n || overdue) };
    }
    for (const memo of [st.ghPrSeen, st.ghPrHistory]) for (const u of Object.keys(memo)) if (!live.has(u)) delete memo[u];
    saveStateSoon();
    const prs = items.filter((it) => it.status === 'open' && !it.draft).sort((a, b) => b.postedAt - a.postedAt);
    Object.assign(ghReviews, { ok: true, at: Date.now(), prs, error: null, ticketLinks: items.flatMap((it) => it.ticketLinks).slice(0, 300) });
  } catch (e) {
    Object.assign(ghReviews, { ok: false, error: e.message });
    log('github reviews:', e.message);
  }
}
