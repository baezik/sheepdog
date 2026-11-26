// Ticket setup suggestions: works out a team's ticket prefix (e.g. ABC-123) from the PR titles in its review
// channel, and its tracker link (Jira / Linear) from links in Slack posts and PR descriptions, so nobody has to
// type a regex. Sheepdog only suggests; the person accepts it (Settings › Tickets, or the board banner).

// Prefixes that look like tickets but are standards, encodings or hashes.
const NOT_TICKETS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'MD', 'AES', 'RSA', 'CVE', 'GPT', 'COVID',
  'IPV', 'X', 'A', 'B', 'V', 'H', 'P', 'K', 'PR', 'ES', 'ECMA', 'WCAG', 'OAUTH', 'MP', 'BASE', 'WIN', 'NODE', 'CLAUDE', 'GEMINI']);
const KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;

/** { template, id } for a link to one ticket, or null: Jira (…/browse/ABC-1) and Linear (linear.app/team/issue/ABC-1/…). */
export function linkTemplate(url) {
  let m = String(url).match(/^(https?:\/\/[^\s/?#]+(?:\/[^\s?#]*?)?\/browse\/)([A-Z][A-Z0-9]{1,9}-\d+)\b/);
  if (m) return { template: `${m[1]}{id}`, id: m[2] };
  m = String(url).match(/^(https?:\/\/linear\.app\/[^\s/?#]+\/issue\/)([A-Z][A-Z0-9]{1,9}-\d+)\b/);
  if (m) return { template: `${m[1]}{id}`, id: m[2] };
  return null;
}

/** Ticket links found in some text (Slack wraps links as <url|label>). */
export function linksIn(text) {
  const out = [];
  for (const u of String(text || '').match(/https?:\/\/[^\s<>|"')\]]+/g) || []) {
    const t = linkTemplate(u);
    if (t) out.push(t);
  }
  return out;
}

/**
 * From PR titles (and the links seen), the pattern and link to suggest, or null if there isn't enough to go on.
 * A prefix needs 3+ PRs and a fair share of all ticket-looking keys; up to 3 prefixes (teams with several boards).
 */
export function suggest(titles, links = []) {
  const counts = new Map();
  let total = 0;
  for (const title of titles) {
    const seen = new Set();
    for (const [, prefix] of String(title || '').matchAll(KEY)) {
      if (NOT_TICKETS.has(prefix) || seen.has(prefix)) continue;
      seen.add(prefix);
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
      total++;
    }
  }
  const prefixes = [...counts].filter(([, n]) => n >= 3 && n / total >= 0.2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p);
  if (!prefixes.length) return null;
  const pattern = prefixes.length === 1 ? `\\b${prefixes[0]}-\\d+\\b` : `\\b(?:${prefixes.join('|')})-\\d+\\b`;
  // the tracker link used most for these prefixes
  const byTemplate = new Map();
  for (const l of links) if (prefixes.includes(l.id.split('-')[0])) byTemplate.set(l.template, (byTemplate.get(l.template) || 0) + 1);
  const link = [...byTemplate].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  return { pattern, link, prefixes, prs: prefixes.reduce((n, p) => n + counts.get(p), 0) };
}
