// Tests per-agent worktrees and merging against a real temporary git repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isGitRepo, ensureWorktree, mergeAgent, worktreeDir } from '../src/worktree.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewterm-wt-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const commitAll = (dir, msg) => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); };

// not a repo / no commits yet
assert.equal(await isGitRepo(tmp), false);
git(repo, 'init', '-q', '-b', 'main');
assert.equal(await isGitRepo(repo), true);
await assert.rejects(ensureWorktree(repo, 'dev'), /no commits yet/);

write(repo, 'app.txt', 'title: hello\n');
commitAll(repo, 'init');

// each agent gets its own worktree and branch
const dev = await ensureWorktree(repo, 'dev');
const qa = await ensureWorktree(repo, 'qa');
assert.equal(dev.branch, 'crewterm/dev');
assert.equal(dev.base, 'main');
assert.equal(dev.cwd, worktreeDir(repo, 'dev'));
assert.equal(git(dev.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'crewterm/dev');
assert.equal(git(qa.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'crewterm/qa');

// worktrees stay out of the user's git status, and .gitignore is untouched
assert.equal(git(repo, 'status', '--porcelain'), '');
assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);

// reusing an existing worktree works (e.g. restarting an agent)
assert.equal((await ensureWorktree(repo, 'dev')).path, dev.path);

// nothing to merge yet
assert.equal((await mergeAgent(repo, 'dev')).merged, false);

// uncommitted work is refused
write(dev.path, 'app.txt', 'title: from dev\n');
await assert.rejects(mergeAgent(repo, 'dev'), /uncommitted changes/);

// committed work merges into main
commitAll(dev.path, 'dev change');
const r = await mergeAgent(repo, 'dev');
assert.equal(r.merged, true);
assert.equal(r.target, 'main');
assert.equal(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'title: from dev\n');

// a conflicting change from another agent is aborted cleanly
write(qa.path, 'app.txt', 'title: from qa\n');
commitAll(qa.path, 'qa change');
await assert.rejects(mergeAgent(repo, 'qa'), /Merge conflict/);
assert.equal(git(repo, 'status', '--porcelain'), '', 'project must not be left half-merged');
assert.equal(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'title: from dev\n');

// after qa catches up with main and resolves the conflict, the merge succeeds
try { git(qa.path, 'merge', 'main'); } catch { /* conflict expected */ }
write(qa.path, 'app.txt', 'title: from dev and qa\n');
commitAll(qa.path, 'resolve');
assert.equal((await mergeAgent(repo, 'qa')).merged, true);
assert.equal(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'title: from dev and qa\n');

// a project folder that is a subfolder of the repo maps to the same subfolder in the worktree
fs.mkdirSync(path.join(repo, 'web'));
write(path.join(repo, 'web'), 'index.html', '<h1>hi</h1>');
commitAll(repo, 'add web');
const sub = await ensureWorktree(path.join(repo, 'web'), 'frontend');
assert.ok(fs.existsSync(path.join(sub.cwd, 'index.html')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ All worktree tests passed');
