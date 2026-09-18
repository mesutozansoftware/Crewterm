// Hub: a tiny local HTTP server that stores the team's messages and tasks.
// It only listens on 127.0.0.1 and requires a random token on every request.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const BROADCAST = 'all';
export const HUMAN = 'user';

export class Hub extends EventEmitter {
  constructor() {
    super();
    this.token = crypto.randomBytes(24).toString('hex');
    this.agents = new Map(); // name -> { name, kind, role, status }
    this.messages = [];
    this.tasks = [];
    this.lastRead = new Map(); // agent name -> id of the last message it read
    this.lastId = 0;
    this.stateFile = null;
  }

  // ---- state ----

  snapshot() {
    return {
      agents: [...this.agents.values()],
      messages: this.messages,
      tasks: this.tasks,
    };
  }

  changed() {
    this.emit('change', this.snapshot());
    this.save();
  }

  openProject(dir) {
    this.stateFile = path.join(dir, '.crewterm', 'state.json');
    this.messages = [];
    this.tasks = [];
    this.lastRead.clear();
    this.lastId = 0;
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.messages = data.messages ?? [];
      this.tasks = data.tasks ?? [];
      this.lastRead = new Map(Object.entries(data.lastRead ?? {}));
      this.lastId = data.lastId ?? 0;
    } catch {
      // first run: nothing saved yet
    }
    this.changed();
  }

  save() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({
        messages: this.messages,
        tasks: this.tasks,
        lastRead: Object.fromEntries(this.lastRead),
        lastId: this.lastId,
      }, null, 2));
    } catch (e) {
      console.error('could not save state:', e.message);
    }
  }

  // ---- agents ----

  addAgent(agent) {
    this.agents.set(agent.name, { ...agent, status: 'running' });
    this.changed();
  }

  removeAgent(name) {
    this.agents.delete(name);
    this.changed();
  }

  // ---- messages ----

  sendMessage(from, to, text) {
    if (!text?.trim()) throw new Error('Message cannot be empty.');
    if (to !== BROADCAST && to !== HUMAN && !this.agents.has(to)) {
      const names = [...this.agents.keys()].join(', ') || '(none)';
      throw new Error(`No team member named "${to}". Members: ${names}, plus "${BROADCAST}" and "${HUMAN}".`);
    }
    const message = { id: ++this.lastId, from, to, text: text.trim(), time: new Date().toISOString() };
    this.messages.push(message);
    this.emit('message', message);
    this.changed();
    return message;
  }

  inbox(agent) {
    const last = Number(this.lastRead.get(agent) ?? 0);
    const unread = this.messages.filter(m =>
      m.id > last && m.from !== agent && (m.to === agent || m.to === BROADCAST));
    this.lastRead.set(agent, this.lastId);
    this.save();
    return unread;
  }

  // ---- tasks ----

  addTask(createdBy, title, description = '', assignee = null) {
    if (!title?.trim()) throw new Error('Task title cannot be empty.');
    const task = {
      id: this.tasks.length ? Math.max(...this.tasks.map(t => t.id)) + 1 : 1,
      title: title.trim(), description, createdBy, assignee,
      status: assignee ? 'in_progress' : 'open',
      note: '', time: new Date().toISOString(),
    };
    this.tasks.push(task);
    if (assignee && assignee !== createdBy && this.agents.has(assignee)) {
      this.sendMessage(createdBy, assignee, `I assigned task #${task.id} to you: ${task.title}`);
    }
    this.changed();
    return task;
  }

  findTask(id) {
    const t = this.tasks.find(t => t.id === Number(id));
    if (!t) throw new Error(`There is no task #${id}.`);
    return t;
  }

  claimTask(agent, id) {
    const t = this.findTask(id);
    if (t.status === 'done') throw new Error(`Task #${id} is already done.`);
    if (t.assignee && t.assignee !== agent) throw new Error(`Task #${id} is already claimed by ${t.assignee}.`);
    t.assignee = agent;
    t.status = 'in_progress';
    this.changed();
    return t;
  }

  completeTask(agent, id, note = '') {
    const t = this.findTask(id);
    t.status = 'done';
    t.assignee = t.assignee ?? agent;
    t.note = note;
    this.changed();
    return t;
  }

  // ---- HTTP ----

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise(resolve => {
      this.server.listen(0, '127.0.0.1', () => {
        this.url = `http://127.0.0.1:${this.server.address().port}`;
        resolve(this.url);
      });
    });
  }

  async handle(req, res) {
    const reply = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    if (req.headers['x-crewterm-token'] !== this.token) return reply(401, { error: 'unauthorized' });

    const url = new URL(req.url, 'http://x');
    const agent = decodeURIComponent(req.headers['x-crewterm-agent'] || 'unknown');
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      try { body = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { error: 'invalid JSON' }); }
    }

    try {
      const p = url.pathname;
      let m;
      if (req.method === 'GET' && p === '/members') return reply(200, [...this.agents.values()]);
      if (req.method === 'POST' && p === '/messages') return reply(200, this.sendMessage(agent, body.to, body.text));
      if (req.method === 'GET' && p === '/inbox') return reply(200, this.inbox(agent));
      if (req.method === 'GET' && p === '/tasks') return reply(200, this.tasks);
      if (req.method === 'POST' && p === '/tasks') return reply(200, this.addTask(agent, body.title, body.description, body.assignee));
      if (req.method === 'POST' && (m = p.match(/^\/tasks\/(\d+)\/claim$/))) return reply(200, this.claimTask(agent, m[1]));
      if (req.method === 'POST' && (m = p.match(/^\/tasks\/(\d+)\/complete$/))) return reply(200, this.completeTask(agent, m[1], body.note));
      return reply(404, { error: 'not found' });
    } catch (e) {
      return reply(400, { error: e.message });
    }
  }
}
