import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import { Hub, BROADCAST, HUMAN } from './hub.js';
import { isGitRepo, ensureWorktree, mergeAgent } from './worktree.js';

const ROOT = path.join(import.meta.dirname, '..');
const MCP_SERVER = path.join(ROOT, 'mcp', 'server.js');
const ICON = path.join(import.meta.dirname, 'ui', 'icon.png');

app.setName('Crewterm');

const hub = new Hub();
const terminals = new Map(); // agent name -> { pty, name, notify }
const notifyTimers = new Map();
let win = null;
let projectDir = null;

const IS_WIN = process.platform === 'win32';
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX shell quoting
const psq = s => `'${String(s).replace(/'/g, `''`)}'`;     // PowerShell quoting
// On Windows, npm CLIs are .cmd shims that mangle newlines and double quotes in arguments.
const argSafe = s => (IS_WIN ? s.replace(/\s*\n\s*/g, ' ').replace(/"/g, "'") : s);
const toCommand = argv => (IS_WIN
  ? `& ${argv.map(psq).join(' ')}`
  : argv.map(shq).join(' '));
const send = (channel, data) => win?.webContents.send(channel, data);

// Team rules appended to every agent's instructions.
function teamInstructions(agent) {
  const others = [...hub.agents.values()].filter(a => a.name !== agent.name)
    .map(a => `${a.name} (${a.role || a.kind})`).join(', ') || 'nobody yet';
  return [
    `You are the agent "${agent.name}", working on the same project together with a team of AI agents.`,
    `Your role: ${agent.role || 'general developer'}.`,
    `Your current teammates: ${others}. Use the team_members tool for the up-to-date list.`,
    `Communicate through the "crewterm" MCP tools: send_message, check_inbox, list_tasks, add_task, claim_task, complete_task.`,
    `Rules:`,
    `- When a line starting with "[crewterm]" appears in your terminal, call check_inbox right away and act on the messages.`,
    `- Before starting work, look at the board with list_tasks. Claim a task with claim_task before working on it.`,
    `- Message the owner before changing files that belong to a task someone else has claimed.`,
    `- When you finish a task, mark it with complete_task and send a short message to whoever needs to know.`,
    `- To ask the human user something or report to them, use send_message with to="${HUMAN}".`,
    ...(agent.branch ? [
      `Git:`,
      `- You work in your own git worktree on the branch "${agent.branch}", so your edits never collide with your teammates'.`,
      `- Commit your work with clear messages whenever you finish a task. Only committed work can be merged.`,
      `- The human merges branches into "${agent.base}" from the Crewterm window. Do not merge other agents' branches yourself unless asked.`,
      `- To review a teammate's work, run "git diff ${agent.base}...crewterm/<name>" or "git log crewterm/<name>"; team_members shows everyone's branch.`,
      `- When you are told a branch was merged into "${agent.base}", run "git merge ${agent.base}" to stay up to date.`,
    ] : []),
  ].join('\n');
}

function mcpEnv(agent) {
  return {
    ELECTRON_RUN_AS_NODE: '1',
    CREWTERM_URL: hub.url,
    CREWTERM_TOKEN: hub.token,
    CREWTERM_AGENT: agent.name,
  };
}

// Builds the shell command that launches the agent, depending on its kind.
function agentCommand(agent) {
  const env = mcpEnv(agent);
  const instructions = teamInstructions(agent);

  if (agent.kind === 'claude') {
    const dir = path.join(app.getPath('userData'), 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${agent.name.replace(/[^\w-]/g, '_')}.mcp.json`);
    fs.writeFileSync(file, JSON.stringify({
      mcpServers: { crewterm: { command: process.execPath, args: [MCP_SERVER], env } },
    }, null, 2), { mode: 0o600 });
    return toCommand(['claude', '--mcp-config', file, '--allowedTools=mcp__crewterm',
      '--append-system-prompt', argSafe(instructions)]);
  }

  if (agent.kind === 'codex') {
    // TOML literal strings ('...') need no escaping, so Windows paths and shims pass them through intact.
    const lit = s => `'${s}'`;
    const envToml = '{' + Object.entries(env).map(([k, v]) => `${k}=${lit(v)}`).join(',') + '}';
    return toCommand([
      'codex',
      '-c', `mcp_servers.crewterm.command=${lit(process.execPath)}`,
      '-c', `mcp_servers.crewterm.args=[${lit(MCP_SERVER)}]`,
      '-c', `mcp_servers.crewterm.env=${envToml}`,
      // The crewterm tools only touch the local hub, so don't ask before every message.
      '-c', `mcp_servers.crewterm.default_tools_approval_mode=${lit('approve')}`,
      argSafe(`${instructions}\n\nFor now, just use team_members to meet the team, briefly say you are ready, and wait for a task.`),
    ]);
  }

  return agent.command; // custom command
}

const starting = new Set(); // names reserved while a worktree is being created

async function startAgent(agent) {
  if (!projectDir) throw new Error('Choose a project folder first.');
  if (!agent.name?.trim() || !/^[\p{L}\p{N}_-]+$/u.test(agent.name)) {
    throw new Error('Agent names may only contain letters, digits, - and _.');
  }
  if (terminals.has(agent.name) || starting.has(agent.name) || agent.name === BROADCAST || agent.name === HUMAN) {
    throw new Error(`The name "${agent.name}" is reserved or already in use.`);
  }
  if (agent.kind === 'custom' && !agent.command?.trim()) throw new Error('Custom command cannot be empty.');

  let cwd = projectDir;
  starting.add(agent.name);
  try {
    if (agent.worktree !== false && await isGitRepo(projectDir)) {
      const wt = await ensureWorktree(projectDir, agent.name);
      Object.assign(agent, { branch: wt.branch, base: wt.base });
      cwd = wt.cwd;
    } else {
      agent.branch = null;
    }
  } finally {
    starting.delete(agent.name);
  }

  hub.addAgent({ name: agent.name, kind: agent.kind, role: agent.role ?? '', branch: agent.branch, workdir: cwd });

  const command = agentCommand(agent);
  let env, shell, args;
  if (IS_WIN) {
    // Windows has no login shell to rebuild PATH, so keep the environment minus other agents' variables.
    env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_RUN_AS_NODE)/.test(k)));
    Object.assign(env, mcpEnv(agent));
    delete env.ELECTRON_RUN_AS_NODE;
    shell = 'powershell.exe';
    args = ['-NoLogo', '-NoExit', '-Command', command]; // -NoExit keeps the pane usable after the agent exits
  } else {
    // Start from a clean environment like Terminal.app; PATH etc. come from the user's shell config.
    // This way nothing leaks in when Crewterm itself is launched from inside another agent.
    env = { TERM: 'xterm-256color', COLORTERM: 'truecolor', ...mcpEnv(agent) };
    for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'PATH']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    delete env.ELECTRON_RUN_AS_NODE;
    shell = process.env.SHELL || '/bin/zsh';
    // Drop into an interactive shell after the agent exits so the pane stays usable.
    args = ['-l', '-i', '-c', `${command}; exec ${shq(shell)} -l`];
  }

  const p = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: agent.cols ?? 100,
    rows: agent.rows ?? 30,
    cwd,
    env,
  });
  terminals.set(agent.name, { pty: p, name: agent.name, notify: agent.notify !== false });
  p.onData(data => send('pty-data', { name: agent.name, data }));
  p.onExit(() => {
    terminals.delete(agent.name);
    hub.removeAgent(agent.name);
    send('pty-exit', { name: agent.name });
  });
  return { branch: agent.branch };
}

// Merges an agent's branch into the project's current branch and tells the crew about it.
async function mergeAgentBranch(name) {
  if (!projectDir) throw new Error('Choose a project folder first.');
  const result = await mergeAgent(projectDir, name);
  if (result.merged && terminals.size) {
    hub.sendMessage(HUMAN, BROADCAST,
      `${result.message} Run "git merge ${result.target}" in your worktree to pick up the changes.`);
  }
  return result;
}

// Types a "[crewterm]" notice into an agent's terminal when it receives a message.
// Messages arriving in quick succession are batched into one notice.
function notify(name, from) {
  const t = terminals.get(name);
  if (!t?.notify) return;
  clearTimeout(notifyTimers.get(name));
  notifyTimers.set(name, setTimeout(() => {
    t.pty.write(`[crewterm] ${from} sent you a message. Read it with check_inbox.`);
    setTimeout(() => t.pty.write('\r'), 200);
  }, 800));
}

hub.on('message', m => {
  if (m.to === HUMAN) return;
  const recipients = m.to === BROADCAST ? [...terminals.keys()].filter(a => a !== m.from) : [m.to];
  for (const r of recipients) notify(r, m.from);
});
hub.on('change', state => send('state', state));

// ---- IPC ----

const safe = fn => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; }
  catch (e) { return { ok: false, error: e.message }; }
};

ipcMain.handle('choose-project', safe(async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return projectDir;
  if (terminals.size) throw new Error('Stop the running agents before switching projects.');
  projectDir = r.filePaths[0];
  hub.openProject(projectDir);
  return projectDir;
}));
ipcMain.handle('start-agent', safe(agent => startAgent(agent)));
ipcMain.handle('merge-agent', safe(name => mergeAgentBranch(name)));
ipcMain.handle('stop-agent', safe(name => terminals.get(name)?.pty.kill()));
ipcMain.handle('user-message', safe(({ to, text }) => hub.sendMessage(HUMAN, to, text)));
ipcMain.handle('add-task', safe(({ title, assignee }) => hub.addTask(HUMAN, title, '', assignee || null)));
ipcMain.handle('get-state', safe(() => ({ ...hub.snapshot(), projectDir })));
ipcMain.on('pty-write', (_e, { name, data }) => terminals.get(name)?.pty.write(data));
ipcMain.on('pty-resize', (_e, { name, cols, rows }) => {
  try { terminals.get(name)?.pty.resize(cols, rows); } catch { /* may have exited */ }
});

app.whenReady().then(async () => {
  // Packaged builds get their icon from the bundle; in development set the Dock icon by hand.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(ICON);
  await hub.start();
  // A project folder can be passed directly: `npm start -- ~/my-project`
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find(a => !a.startsWith('-'));
  if (arg && fs.statSync(arg, { throwIfNoEntry: false })?.isDirectory()) {
    projectDir = path.resolve(arg);
    hub.openProject(projectDir);
  }
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 600,
    title: 'Crewterm',
    icon: ICON,
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(import.meta.dirname, 'ui', 'index.html'));
});

app.on('window-all-closed', () => {
  for (const t of terminals.values()) t.pty.kill();
  app.quit();
});
