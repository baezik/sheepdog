import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'sheepdog-cfg-'));
process.env.SHEEPDOG_CONFIG_DIR = dir;
const cfg = await import('../server/config.mjs');
const { parseRepo } = await import('../server/github.mjs');
const { validSshTarget } = await import('../server/hosts.mjs');

test('defaults are generic', () => {
  const c = cfg.getConfig();
  assert.equal(c.setupComplete, false);
  assert.deepEqual(c.github.repos, []);
  assert.equal(c.slack.channelId, '');
  assert.equal(c.hosts.length, 1);
});

test('patch validates keys and values', () => {
  cfg.patchConfig({ 'alerts.sound': 'Ding', idleMinutes: 15, 'tickets.pattern': 'ABC-\\d+' });
  assert.equal(cfg.getConfig().alerts.sound, 'Ding');
  assert.throws(() => cfg.patchConfig({ 'github.token': 'x' }), /cannot be changed/);
  assert.throws(() => cfg.patchConfig({ 'alerts.sound': 'Moo' }), /Invalid/);
  assert.throws(() => cfg.patchConfig({ 'tickets.pattern': '(' }), /Invalid/);
  assert.throws(() => cfg.patchConfig({ 'alerts.quietHours.start': '25:00' }), /Invalid/);
  cfg.patchConfig({ 'slack.reviewing': ':eyes:' });
  assert.equal(cfg.getConfig().slack.reviewing, 'eyes');
  cfg.patchConfig({ 'slack.reviewing': ' :eyes: , mag,eyes  hourglass' });
  assert.equal(cfg.getConfig().slack.reviewing, 'eyes,mag,hourglass', 'comma/space separated, colons and duplicates dropped');
  assert.throws(() => cfg.patchConfig({ 'slack.approved': 'white_check_mark, not an emoji!' }), /Invalid/);
  assert.throws(() => cfg.patchConfig({ 'slack.approved': ' , ' }), /Invalid/);
});

test('secrets never reach the browser and the file is private', () => {
  cfg.updateConfig((c) => { c.github.token = 'ghp_secretsecretsecret1234'; c.slack.token = 'xoxp-secret-9999'; });
  const pub = JSON.stringify(cfg.publicConfig());
  assert.ok(!pub.includes('secret'));
  assert.deepEqual(cfg.publicConfig().slack.token, { set: true, hint: '…9999' });
  assert.equal(statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
});

test('repo input forms', () => {
  assert.equal(parseRepo('acme/web'), 'acme/web');
  assert.equal(parseRepo('https://github.com/acme/web.git'), 'acme/web');
  assert.equal(parseRepo('https://github.com/acme/web/'), 'acme/web');
  assert.equal(parseRepo('git@github.com:acme/web.git'), 'acme/web');
  assert.equal(parseRepo('https://gitlab.com/acme/web'), null);
  assert.equal(parseRepo('acme'), null);
});

test('ssh targets cannot smuggle options', () => {
  assert.ok(validSshTarget('build-box'));
  assert.ok(validSshTarget('me@10.0.0.5'));
  assert.ok(!validSshTarget('-oProxyCommand=touch /tmp/x'));
  assert.ok(!validSshTarget('host; rm -rf ~'));
  assert.ok(!validSshTarget(''));
});
