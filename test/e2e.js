// Runs two agents against the hub through the real MCP server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Hub } from '../src/hub.js';

const SERVER = path.join(import.meta.dirname, '..', 'mcp', 'server.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewterm-test-'));

const hub = new Hub();
await hub.start();
hub.openProject(dir);
hub.addAgent({ name: 'agent1', kind: 'claude', role: 'architect' });
hub.addAgent({ name: 'agent2', kind: 'codex', role: 'developer' });

const notified = [];
hub.on('message', m => notified.push(m.to));

async function connect(name) {
  const c = new Client({ name, version: '0' });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: [SERVER],
    env: { ...process.env, CREWTERM_URL: hub.url, CREWTERM_TOKEN: hub.token, CREWTERM_AGENT: name },
  }));
  return c;
}
const out = r => r.content[0].text;
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });

const a1 = await connect('agent1');
const a2 = await connect('agent2');

const tools = (await a1.listTools()).tools.map(t => t.name).sort();
assert.deepEqual(tools, ['add_task', 'check_inbox', 'claim_task', 'complete_task', 'list_tasks', 'send_message', 'team_members']);

assert.match(out(await call(a1, 'team_members')), /agent2/);

await call(a1, 'send_message', { to: 'agent2', text: 'Hi, can you build the login page?' });
assert.match(out(await call(a2, 'check_inbox')), /agent1 → agent2: Hi/);
assert.equal(out(await call(a2, 'check_inbox')), 'No new messages.', 'read messages must not come back');
assert.equal(out(await call(a1, 'check_inbox')), 'No new messages.', 'own messages must not show up');

const missing = await call(a1, 'send_message', { to: 'nobody', text: 'x' });
assert.equal(missing.isError, true);

const task = JSON.parse(out(await call(a1, 'add_task', { title: 'Login page', assignee: 'agent2' })));
assert.equal(task.status, 'in_progress');
assert.match(out(await call(a2, 'check_inbox')), /assigned task #1/);
assert.equal((await call(a1, 'claim_task', { id: task.id })).isError, true, "cannot claim someone else's task");
const done = JSON.parse(out(await call(a2, 'complete_task', { id: task.id, note: 'added login.html' })));
assert.equal(done.status, 'done');

await call(a2, 'send_message', { to: 'all', text: 'Done!' });
assert.match(out(await call(a1, 'check_inbox')), /Done!/);
assert.deepEqual(notified, ['agent2', 'agent2', 'all']);

// requests without the token are rejected
const unauthorized = await fetch(hub.url + '/members');
assert.equal(unauthorized.status, 401);

// state is written to disk and can be reloaded
const reloaded = new Hub();
reloaded.openProject(dir);
assert.equal(reloaded.tasks.length, 1);
assert.equal(reloaded.messages.length, 3);

await a1.close();
await a2.close();
hub.server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('✓ All end-to-end tests passed');
