// The MCP server every agent connects to (stdio). Forwards tool calls to the Crewterm hub.
// Environment: CREWTERM_URL, CREWTERM_TOKEN, CREWTERM_AGENT
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const { CREWTERM_URL, CREWTERM_TOKEN, CREWTERM_AGENT } = process.env;
if (!CREWTERM_URL || !CREWTERM_TOKEN || !CREWTERM_AGENT) {
  console.error('CREWTERM_URL, CREWTERM_TOKEN and CREWTERM_AGENT must be set.');
  process.exit(1);
}

async function hub(method, path, body) {
  const res = await fetch(CREWTERM_URL + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-crewterm-token': CREWTERM_TOKEN,
      'x-crewterm-agent': encodeURIComponent(CREWTERM_AGENT),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const text = t => ({ content: [{ type: 'text', text: t }] });
const json = v => text(JSON.stringify(v, null, 2));

function tool(name, description, inputSchema, fn) {
  server.registerTool(name, { description, inputSchema }, async args => {
    try {
      return await fn(args ?? {});
    } catch (e) {
      return { ...text(`Error: ${e.message}`), isError: true };
    }
  });
}

const server = new McpServer({ name: 'crewterm', version: '0.1.0' });

tool('team_members', 'Lists the other agents on the team with their roles and status.', {}, async () =>
  json(await hub('GET', '/members')));

tool('send_message',
  'Sends a message to a teammate. to: an agent name, "all" to broadcast to everyone, or "user" for the human user.',
  { to: z.string(), text: z.string() },
  async ({ to, text: t }) => {
    const m = await hub('POST', '/messages', { to, text: t });
    return text(`Sent (#${m.id}).`);
  });

tool('check_inbox', 'Returns your unread messages and marks them as read.', {}, async () => {
  const unread = await hub('GET', '/inbox');
  if (!unread.length) return text('No new messages.');
  return text(unread.map(m => `[#${m.id}] ${m.from} → ${m.to}: ${m.text}`).join('\n\n'));
});

tool('list_tasks', 'Lists every task on the shared task board.', {}, async () =>
  json(await hub('GET', '/tasks')));

tool('add_task',
  'Adds a task to the board. Optionally set "assignee" to an agent name; they are notified automatically.',
  { title: z.string(), description: z.string().optional(), assignee: z.string().optional() },
  async a => json(await hub('POST', '/tasks', a)));

tool('claim_task', 'Claims an open task so others know you are working on it.', { id: z.number().int() }, async ({ id }) =>
  json(await hub('POST', `/tasks/${id}/claim`)));

tool('complete_task', 'Marks a task as done. Use "note" to briefly describe what you did.',
  { id: z.number().int(), note: z.string().optional() },
  async ({ id, note }) => json(await hub('POST', `/tasks/${id}/complete`, { note })));

await server.connect(new StdioServerTransport());
