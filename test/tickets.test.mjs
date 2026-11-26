// Ticket setup suggestion: prefix from PR titles, tracker link from links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest, linkTemplate, linksIn } from '../server/tickets.mjs';

test('Jira and Linear links become templates', () => {
  assert.deepEqual(linkTemplate('https://acme.atlassian.net/browse/ABC-12'), { template: 'https://acme.atlassian.net/browse/{id}', id: 'ABC-12' });
  assert.deepEqual(linkTemplate('https://jira.acme.io/jira/browse/OPS-7?focusedCommentId=1'), { template: 'https://jira.acme.io/jira/browse/{id}', id: 'OPS-7' });
  assert.deepEqual(linkTemplate('https://linear.app/acme/issue/ENG-42/fix-login'), { template: 'https://linear.app/acme/issue/{id}', id: 'ENG-42' });
  assert.equal(linkTemplate('https://github.com/acme/web/pull/12'), null);
  assert.equal(linksIn('See <https://acme.atlassian.net/browse/ABC-9|ABC-9> and https://example.com').length, 1);
});

test('the team prefix wins; standards and one-offs are ignored', () => {
  const titles = ['ABC-1: Login', 'ABC-2 fix UTF-8 names', 'feat(ABC-3): export', 'Bump SHA-256 lib', 'OPS-1 deploy', 'ABC-4 and ABC-5 together', 'ISO-8601 dates'];
  const s = suggest(titles, [{ template: 'https://acme.atlassian.net/browse/{id}', id: 'ABC-2' }, { template: 'https://other/browse/{id}', id: 'ZZZ-1' }]);
  assert.deepEqual(s.prefixes, ['ABC']);
  assert.equal(s.pattern, '\\bABC-\\d+\\b');
  assert.equal(s.link, 'https://acme.atlassian.net/browse/{id}', 'only links for the chosen prefix count');
  assert.ok(new RegExp(s.pattern).test('ABC-123') && !new RegExp(s.pattern).test('UTF-8'));
});

test('two boards: both prefixes; too little data: no suggestion', () => {
  const two = suggest(['RV-1', 'RV-2', 'RV-3', 'RV-4', 'OPS-1', 'OPS-2', 'OPS-3']);
  assert.equal(two.pattern, '\\b(?:RV|OPS)-\\d+\\b');
  assert.equal(two.link, '');
  assert.equal(suggest(['RV-1 x', 'no ticket here']), null);
});
