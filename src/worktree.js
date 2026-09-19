// Gives each agent its own git worktree and branch so agents can edit in parallel
// without overwriting each other, and merges their work back when asked.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const branchFor = name => `crewterm/${name}`;
export const worktreeDir = (project, name) => path.join(project, '.crewterm', 'worktrees', name);

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = (stderr || stdout || err.message).trim();
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export async function isGitRepo(dir) {
  try {
    return (await git(dir, 'rev-parse', '--is-inside-work-tree')) === 'true';
  } catch {
    return false;
  }
}

export async function currentBranch(dir) {
  return git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
}

// Keeps .crewterm/ (state + worktrees) out of the user's `git status` without touching their .gitignore.
async function excludeCrewtermDir(project) {
  const file = path.resolve(project, await git(project, 'rev-parse', '--git-path', 'info/exclude'));
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!current.split('\n').includes('.crewterm/')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}.crewterm/\n`);
  }
}

async function branchExists(project, branch) {
  try {
    await git(project, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

// Creates (or reuses) the agent's worktree. Returns { path, cwd, branch, base }.
// `cwd` is where the agent should start: the same subfolder of the repo as the project folder.
export async function ensureWorktree(project, name) {
  try {
    await git(project, 'rev-parse', '--verify', 'HEAD');
  } catch {
    throw new Error('The project has no commits yet. Make a first commit, or turn off "own git worktree" for this agent.');
  }
  await excludeCrewtermDir(project);

  const dir = worktreeDir(project, name);
  const branch = branchFor(name);
  const base = await currentBranch(project);
  const prefix = await git(project, 'rev-parse', '--show-prefix');
  const result = { path: dir, cwd: path.join(dir, prefix), branch, base };

  if (fs.existsSync(path.join(dir, '.git'))) return result; // reuse from an earlier session

  await git(project, 'worktree', 'prune');
  if (await branchExists(project, branch)) {
    await git(project, 'worktree', 'add', dir, branch);
  } else {
    await git(project, 'worktree', 'add', '-b', branch, dir);
  }
  return result;
}

// Merges the agent's branch into whatever branch the project folder has checked out.
// On conflicts the merge is aborted so the project is never left half-merged.
export async function mergeAgent(project, name) {
  const dir = worktreeDir(project, name);
  const branch = branchFor(name);
  if (!(await branchExists(project, branch))) throw new Error(`Branch ${branch} does not exist.`);

  if (fs.existsSync(dir) && (await git(dir, 'status', '--porcelain'))) {
    throw new Error(`${name} has uncommitted changes. Ask it to commit its work first.`);
  }
  const target = await currentBranch(project);
  const ahead = Number(await git(project, 'rev-list', '--count', `${target}..${branch}`));
  if (!ahead) return { target, branch, merged: false, message: `Nothing to merge: ${branch} has no new commits.` };

  try {
    await git(project, 'merge', '--no-ff', '--no-edit', '-m', `Merge ${branch} into ${target}`, branch);
  } catch (e) {
    await git(project, 'merge', '--abort').catch(() => {});
    const conflict = /conflict/i.test(e.message);
    throw new Error(conflict
      ? `Merge conflict between ${branch} and ${target}. Nothing was changed. Ask ${name} to run "git merge ${target}" in its worktree, resolve the conflicts, and commit.`
      : `Merge failed: ${e.message}`);
  }
  return { target, branch, merged: true, commits: ahead, message: `Merged ${ahead} commit(s) from ${branch} into ${target}.` };
}
