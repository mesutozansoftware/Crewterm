const $ = s => document.querySelector(s);
const panes = new Map(); // agent name -> { el, term, fit, exited }
let state = { agents: [], messages: [], tasks: [] };

const THEME = {
  background: '#0b0d11', foreground: '#e6edf3', cursor: '#d97757',
  selectionBackground: '#2f3b4d',
};

function showToast(message, kind = 'error') {
  const t = $('#toast');
  t.textContent = message;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (t.hidden = true), kind === 'error' ? 8000 : 4000);
}
const showError = message => showToast(message, 'error');

async function call(fn, ...args) {
  const r = await fn(...args);
  if (!r.ok) { showError(r.error); throw new Error(r.error); }
  return r.data;
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const clock = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const KINDS = { claude: 'Claude Code', codex: 'Codex', custom: 'Custom' };
const who = n => (n === 'user' ? 'You' : n === 'all' ? 'Everyone' : n);

// ---- terminal panes ----

function createPane(agent) {
  $('#empty').hidden = true;
  const pane = el('div', 'pane');
  const header = el('div', 'pane-header');
  const branch = el('span', 'badge branch');
  branch.hidden = true;
  const merge = el('button', 'secondary', 'Merge');
  merge.hidden = true;
  merge.onclick = async () => {
    merge.disabled = true;
    try {
      const r = await call(crewterm.mergeAgent, agent.name);
      showToast(r.message, r.merged ? 'success' : 'info');
    } catch { /* already shown */ } finally {
      merge.disabled = false;
    }
  };
  header.append(el('span', 'dot'), el('span', 'name', agent.name), el('span', 'badge', KINDS[agent.kind] ?? agent.kind),
    branch, el('span', 'role', agent.role ?? ''));
  const close = el('button', 'secondary', 'Close');
  header.append(merge, close);
  const box = el('div', 'terminal');
  pane.append(header, box);
  $('#panes').append(pane);

  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 13,
    theme: THEME, cursorBlink: true, scrollback: 5000, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(box);
  fit.fit();
  term.onData(data => crewterm.ptyWrite(agent.name, data));
  term.onResize(({ cols, rows }) => crewterm.ptyResize(agent.name, cols, rows));
  new ResizeObserver(() => { try { fit.fit(); } catch {} }).observe(box);

  const entry = {
    el: pane, term, fit, exited: false,
    setBranch(name) {
      if (!name) return;
      branch.textContent = '⎇ ' + name;
      branch.title = `Works on branch ${name} in its own git worktree`;
      merge.title = `Merge ${name} into the project's current branch`;
      branch.hidden = merge.hidden = false;
    },
  };
  close.onclick = () => {
    if (entry.exited) removePane(agent.name);
    else crewterm.stopAgent(agent.name);
  };
  panes.set(agent.name, entry);
  return { cols: term.cols, rows: term.rows };
}

function removePane(name) {
  const p = panes.get(name);
  if (!p) return;
  p.term.dispose();
  p.el.remove();
  panes.delete(name);
  if (!panes.size) $('#empty').hidden = false;
}

crewterm.onPtyData(({ name, data }) => panes.get(name)?.term.write(data));
crewterm.onPtyExit(({ name }) => {
  const p = panes.get(name);
  if (!p) return;
  p.exited = true;
  p.el.classList.add('exited');
  p.term.write('\r\n\x1b[90m[agent exited — press "Close" to remove this pane]\x1b[0m\r\n');
});

async function startAgent(agent) {
  const size = createPane(agent);
  try {
    const r = await call(crewterm.startAgent, { ...agent, ...size });
    panes.get(agent.name)?.setBranch(r?.branch);
  } catch (e) {
    removePane(agent.name);
    throw e;
  }
}

// ---- side panel ----

function fillOptions(select, extra) {
  const prev = select.value;
  select.replaceChildren(...extra.map(([v, t]) => new Option(t, v)),
    ...state.agents.map(a => new Option(a.name, a.name)));
  if ([...select.options].some(o => o.value === prev)) select.value = prev;
}

function render() {
  fillOptions($('#messageTo'), [['all', 'Everyone']]);
  fillOptions($('#taskAssignee'), [['', 'Unassigned (first to claim it)']]);

  const ml = $('#messageList');
  const atBottom = ml.scrollHeight - ml.scrollTop - ml.clientHeight < 40;
  ml.replaceChildren(...(state.messages.length ? state.messages.map(m => {
    const li = el('li', 'message' + (m.from === 'user' ? ' from-user' : m.to === 'user' ? ' to-user' : ''));
    const meta = el('div', 'meta');
    meta.append(el('b', null, who(m.from)), el('span', null, '→'), el('b', null, who(m.to)),
      el('span', null, '· ' + clock(m.time)));
    li.append(meta, el('div', 'body', m.text));
    return li;
  }) : [el('li', 'empty', 'No messages yet.')]));
  if (atBottom) ml.scrollTop = ml.scrollHeight;

  const STATUS = { open: 'Open', in_progress: 'In progress', done: 'Done' };
  $('#taskList').replaceChildren(...(state.tasks.length ? [...state.tasks].reverse().map(t => {
    const li = el('li', 'task ' + t.status);
    const meta = el('div', 'meta');
    meta.append(el('span', null, `#${t.id} · ${STATUS[t.status]}`), el('span', null, t.assignee ?? '—'));
    li.append(meta, el('div', 'title', t.title));
    if (t.description) li.append(el('div', 'note', t.description));
    if (t.note) li.append(el('div', 'note', '✓ ' + t.note));
    return li;
  }) : [el('li', 'empty', 'The task board is empty.')]));
}

crewterm.onState(s => { state = s; render(); });

document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button, .tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $('#' + b.dataset.tab).classList.add('active');
});

$('#messageForm').onsubmit = async e => {
  e.preventDefault();
  const text = $('#messageText').value.trim();
  if (!text) return;
  await call(crewterm.userMessage, { to: $('#messageTo').value, text });
  $('#messageText').value = '';
};
$('#messageText').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#messageForm').requestSubmit(); }
};

$('#taskForm').onsubmit = async e => {
  e.preventDefault();
  const title = $('#taskTitle').value.trim();
  if (!title) return;
  await call(crewterm.addTask, { title, assignee: $('#taskAssignee').value });
  $('#taskTitle').value = '';
};

// ---- top bar ----

$('#chooseProject').onclick = async () => {
  const dir = await call(crewterm.chooseProject);
  if (dir) $('#projectPath').textContent = dir;
};

const dialog = $('#agentDialog');
$('#openAddAgent').onclick = () => { $('#agentError').textContent = ''; dialog.showModal(); $('#agentName').focus(); };
$('#agentCancel').onclick = () => dialog.close();
$('#agentKind').onchange = () => { $('#commandField').hidden = $('#agentKind').value !== 'custom'; };
$('#agentForm').onsubmit = async e => {
  e.preventDefault();
  const agent = {
    name: $('#agentName').value.trim(), kind: $('#agentKind').value, role: $('#agentRole').value.trim(),
    command: $('#agentCommand').value.trim(), notify: $('#agentNotify').checked,
    worktree: $('#agentWorktree').checked,
  };
  try {
    await startAgent(agent);
    dialog.close();
    $('#agentForm').reset();
    $('#commandField').hidden = true;
  } catch (err) {
    $('#agentError').textContent = err.message;
  }
};

$('#quickTeam').onclick = async () => {
  try {
    await startAgent({ name: 'architect', kind: 'claude', role: 'Plans, splits the work into tasks, reviews incoming code' });
    await startAgent({ name: 'developer', kind: 'codex', role: 'Implements and tests the tasks assigned to it' });
  } catch { /* already shown */ }
};

call(crewterm.getState).then(s => {
  state = s;
  if (s.projectDir) $('#projectPath').textContent = s.projectDir;
  render();
});
