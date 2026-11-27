// GitHub as the review source: one PR from the GraphQL API -> a sidebar item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SHEEPDOG_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'sheepdog-ghr-'));
const { toItem } = await import('../server/reviews-github.mjs');

const pr = (o = {}) => ({
  repo: 'web', number: 7, title: 'ABC-1 Fix login', url: 'https://github.com/acme/web/pull/7', isDraft: false,
  createdAt: '2026-01-05T09:00:00Z', body: 'Fixes https://acme.atlassian.net/browse/ABC-1', reviewDecision: 'REVIEW_REQUIRED',
  author: { login: 'bob', name: 'Bob Builder' }, comments: { totalCount: 2 },
  timelineItems: { nodes: [] }, reviewRequests: { nodes: [] }, reviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...o,
});
const review = (login, state, at) => ({ state, submittedAt: at, author: { login, name: login.toUpperCase() } });

test('an open PR nobody has looked at', () => {
  const it = toItem(pr({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'carol', name: 'Carol' } }, { requestedReviewer: { __typename: 'Team', name: 'web-team' } }] } }), 'carol');
  assert.equal(it.status, 'open');
  assert.equal(it.postedAt, Date.parse('2026-01-05T09:00:00Z'));
  assert.deepEqual(it.asked, ['@web-team'], 'you are flagged as forYou, not listed');
  assert.equal(it.forYou, true);
  assert.equal(it.yours, false);
  assert.equal(it.ci, 'ok');
  assert.deepEqual(it.by, ['gh:bob', 'Bob Builder']);
  assert.equal(it.ticketLinks[0].id, 'ABC-1');
});

test('reviews: first review starts it, the latest decisive review counts, the author and drafts are ignored', () => {
  const it = toItem(pr({
    timelineItems: { nodes: [{ createdAt: '2026-01-05T10:00:00Z' }] }, // marked ready for review later
    reviews: { nodes: [
      review('bob', 'COMMENTED', '2026-01-05T10:05:00Z'), // the author answering
      review('carol', 'COMMENTED', '2026-01-05T10:30:00Z'),
      review('carol', 'CHANGES_REQUESTED', '2026-01-05T11:00:00Z'),
      review('dan', 'APPROVED', '2026-01-05T11:30:00Z'),
      review('erin', 'PENDING', null),
    ] },
    reviewDecision: 'CHANGES_REQUESTED',
  }), 'bob');
  assert.equal(it.yours, true);
  assert.equal(it.postedAt, Date.parse('2026-01-05T10:00:00Z'));
  assert.deepEqual(it.reviewers.map((r) => [r.id, r.since]), [['gh:carol', Date.parse('2026-01-05T10:30:00Z')], ['gh:dan', Date.parse('2026-01-05T11:30:00Z')]]);
  assert.deepEqual(it.approvers.map((r) => r.id), ['gh:dan']);
  assert.equal(it.status, 'open', 'changes requested keeps it open');
  assert.equal(it.changes, true);
});

test('approved: by review decision, or by an approval on repos that need no reviews', () => {
  assert.equal(toItem(pr({ reviewDecision: 'APPROVED' }), '').status, 'approved');
  assert.equal(toItem(pr({ reviewDecision: null, reviews: { nodes: [review('dan', 'APPROVED', '2026-01-05T11:30:00Z')] } }), '').status, 'approved');
  // approved, then the same person asked for changes: not approved
  assert.equal(toItem(pr({ reviewDecision: null, reviews: { nodes: [review('dan', 'APPROVED', '2026-01-05T11:30:00Z'), review('dan', 'CHANGES_REQUESTED', '2026-01-05T12:00:00Z')] } }), '').status, 'open');
});
