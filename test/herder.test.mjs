// Herder's chat loop against a fake Anthropic API on localhost: tool calls run, the reply comes back, the
// conversation is only ever appended to, and lines starting with a ticket are recognised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SHEEPDOG_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'sheepdog-herder-'));
const requests = [];
const replies = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(replies.shift()));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;

const { updateConfig } = await import('../server/config.mjs');
const herder = await import('../server/herder.mjs');
updateConfig((c) => { c.herder.key = ['sk', 'ant', 'test0000000000000000000000'].join('-'); });
herder.useAgents(() => [
  { id: 'ABC-1', key: 'local:11', agent_no: 1, ticket: 'ABC-1', title: 'Fix login', machine: 'mac', kind: 'claude', state: 'your_turn', minutes_in_state: 3, can_read_chat: false },
  { id: 'agent 7', key: 'vm:33', agent_no: 7, ticket: null, title: 'Scratch work', machine: 'vm', kind: 'claude', state: 'working', minutes_in_state: 1, can_read_chat: false },
  { id: 'ABC-2', key: 'vm:22', agent_no: 2, ticket: 'ABC-2', title: 'Add export', machine: 'vm', kind: 'codex', state: 'working', minutes_in_state: 9, can_read_chat: false },
]);

const msg = (content, stop_reason) => ({ id: `msg_${replies.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 } });

test('a question runs tools, then answers', async () => {
  replies.push(
    msg([{ type: 'tool_use', id: 'tu1', name: 'list_agents', input: {} }, { type: 'tool_use', id: 'tu2', name: 'read_agent', input: { agent: 'ABC-1' } }], 'tool_use'),
    msg([{ type: 'text', text: 'ABC-1 is waiting on you.' }], 'end_turn'),
  );
  const st = await herder.chat('Who needs me?');
  assert.equal(st.log.at(-1).text, 'ABC-1 is waiting on you.');
  assert.equal(requests.length, 2);
  const [first, second] = requests;
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.equal(first.body.fallbacks, 'default');
  assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.deepEqual(first.body.tools.map((t) => t.name), ['list_agents', 'read_agent', 'list_prs', 'send_to_agent']);
  // the second request carries the first in full: question, assistant tool calls, both results
  assert.equal(second.body.messages.length, 3);
  const results = second.body.messages[2].content;
  assert.equal(results.length, 2, 'parallel tool results come back in one user message');
  assert.match(results[0].content, /"ticket":"ABC-1"/);
  assert.ok(!results[0].content.includes('local:11'), 'internal keys are not shown to the model');
  assert.match(results[1].content, /can't reach|isn't in a cmux tab/i);
});

test('the next question appends to the same conversation', async () => {
  replies.push(msg([{ type: 'text', text: 'Nothing else.' }], 'end_turn'));
  await herder.chat('Anything else?');
  const last = requests.at(-1).body.messages;
  assert.equal(last.length, 5, 'question 1, tool calls, results, answer 1, question 2');
  assert.equal(last[3].role, 'assistant');
  assert.equal(last[4].content, 'Anything else?');
});

test('an unknown ticket or plain text is not a direct message; a known one needs text', async () => {
  assert.equal(await herder.direct('what is going on'), null);
  assert.equal(await herder.direct('XYZ-9 hello'), null);
  await assert.rejects(herder.direct('ABC-1'), /What should ABC-1 be told/);
  await assert.rejects(herder.direct('ABC-1 run the tests'), /cmux tab/); // known, but not reachable here
  await assert.rejects(herder.direct('1 run the tests'), /Can't type into ABC-1/); // bare number: agent 1
  await assert.rejects(herder.direct('agent 7 run the tests'), /Can't type into agent 7/);
  await assert.rejects(herder.direct('#7 run the tests'), /agent 7/);
  await assert.rejects(herder.direct('agent 7'), /What should agent 7 be told/);
});

test('an OpenAI-compatible gateway: tool calls as functions, results as tool messages', async () => {
  updateConfig((c) => Object.assign(c.herder, { provider: 'openai', baseUrl: `${process.env.ANTHROPIC_BASE_URL}/v1/`, model: 'gpt-x', wire: 'chat' }));
  herder.reset();
  const choice = (message, finish_reason) => ({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message, finish_reason }] });
  replies.push(
    choice({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_agents', arguments: '{}' } }] }, 'tool_calls'),
    choice({ role: 'assistant', content: 'Two agents: ABC-1 waits on you.' }, 'stop'),
  );
  const n = requests.length;
  const st = await herder.chat('Status?');
  assert.equal(st.log.at(-1).text, 'Two agents: ABC-1 waits on you.');
  const [a, b] = requests.slice(n);
  assert.equal(a.url, '/v1/chat/completions');
  assert.match(a.headers.authorization, /^Bearer sk-ant-test/);
  assert.equal(a.body.model, 'gpt-x');
  assert.equal(a.body.messages[0].role, 'system');
  assert.equal(a.body.tools[0].type, 'function');
  assert.equal(a.body.tools[0].function.name, 'list_agents');
  const msgs = b.body.messages;
  assert.equal(msgs.at(-2).tool_calls[0].id, 'call_1');
  assert.equal(msgs.at(-1).role, 'tool');
  assert.equal(msgs.at(-1).tool_call_id, 'call_1');
  assert.match(msgs.at(-1).content, /ABC-2/);
  assert.match(msgs.at(-1).content, /"agent_no":7/);
});

test('the Responses API: function calls and their outputs, reasoning passed back', async () => {
  updateConfig((c) => { c.herder.wire = 'responses'; });
  herder.reset();
  replies.push(
    { id: 'r1', object: 'response', status: 'completed', output: [
      { id: 'rs_1', type: 'reasoning', encrypted_content: 'xyz', summary: [] },
      { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'list_prs', arguments: '{}', status: 'completed' },
    ] },
    { id: 'r2', object: 'response', status: 'completed', output: [
      { id: 'm_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'No PRs waiting.' }] },
    ] },
  );
  const n = requests.length;
  const st = await herder.chat('Any PRs?');
  assert.equal(st.log.at(-1).text, 'No PRs waiting.');
  const [a, b] = requests.slice(n);
  assert.equal(a.url, '/v1/responses');
  assert.equal(a.body.store, false);
  assert.equal(a.body.tools[0].name, 'list_agents');
  assert.equal(a.body.input[0].content, 'Any PRs?');
  const input = b.body.input;
  assert.equal(input[1].type, 'reasoning');
  assert.equal(input[1].encrypted_content, 'xyz');
  assert.equal(input[2].type, 'function_call');
  assert.equal(input[2].status, undefined, 'output-only fields are dropped');
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call_9', output: '[]' });
});

test('the gateway lists its models', async () => {
  replies.push({ object: 'list', data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] });
  assert.deepEqual(await herder.listModels(), ['gpt-a', 'gpt-b']);
});

test('an agent that starts waiting gets one post, marked answered when it moves on', () => {
  herder.reset();
  const a = { id: 'ABC-1', key: 'local:11', ticket: 'ABC-1', title: 'Fix login', machine: 'mac', kind: 'claude', state: 'your_turn' };
  herder.observe([a]);
  herder.observe([a]); // still waiting: no second post
  let log = herder.state().log;
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].wait.ticket, log[0].wait.done], ['ABC-1', false]);
  herder.observe([{ ...a, state: 'idle' }]); // waited a long time: still not answered
  assert.equal(herder.state().log[0].wait.done, false);
  herder.observe([{ ...a, state: 'working' }]);
  log = herder.state().log;
  assert.equal(log[0].wait.done, true);
  herder.observe([a]); // waiting again later: a new post
  assert.equal(herder.state().log.length, 2);
});

test('gist: the last paragraph that asks something', () => {
  const q = 'Ran the tests.\n\nAll 15 passed.\n\nShould I keep the number change in this ticket, or split it out?\n\nWorked for 2m';
  assert.equal(herder.gist(q), 'Should I keep the number change in this ticket, or split it out?');
  assert.equal(herder.gist('Done. Build is green.'), 'Done. Build is green.');
  assert.ok(herder.gist('x'.repeat(500)).length <= 240);
});

test.after(() => server.close());
