import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Git } from '../src/git';
import { discoverRepositories, findRepository, repositoryContaining } from '../src/repositories';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gitex-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const init = async (relative: string, bare = false) => {
    const root = path.join(dir, relative);
    await mkdir(root, { recursive: true });
    const git = new Git(root);
    await git.text(['init', '--initial-branch=main', ...(bare ? ['--bare'] : [])]);
    return root;
  };
  return { dir, init };
}

test('recursively discovers siblings and nested repositories below a non-Git workspace', async t => {
  const { dir, init } = await fixture(t);
  const first = await init('papers/2026/one');
  const nested = await init('papers/2026/one/appendix');
  const second = await init('papers/two');
  assert.equal(await findRepository(dir), undefined);
  assert.deepEqual(await discoverRepositories([dir]), [first, nested, second].sort());
  assert.equal(repositoryContaining([first, second, nested], path.join(nested, 'main.tex')), nested);
  assert.equal(repositoryContaining([first], `${first}-unrelated/main.tex`), undefined);
});

test('recognizes worktree and submodule .git files and deduplicates overlapping folders', async t => {
  const { dir, init } = await fixture(t);
  const root = await init('paper');
  const git = new Git(root);
  await git.text(['-c', 'user.name=Tester', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial']);
  const worktree = path.join(dir, 'group', 'worktree');
  await git.text(['worktree', 'add', '-b', 'review', worktree]);
  await git.text(['-c', 'protocol.file.allow=always', 'submodule', 'add', root, 'submodule']);
  const submodule = path.join(root, 'submodule');
  assert.equal(await findRepository(worktree), worktree);
  assert.equal(await findRepository(submodule), submodule);
  assert.deepEqual(await discoverRepositories([dir, root, worktree]), [root, worktree, submodule].sort());
});

test('skips Git internals, bare storage, temporary imports and directory symlink cycles', async t => {
  const { dir, init } = await fixture(t);
  const root = await init('workspace/paper');
  await init('workspace/paper/.git/internal');
  const bare = await init('workspace/paper.git', true);
  await init('workspace/paper.git/objects/hidden');
  await init('workspace/.gitex-import-incomplete/clone');
  const external = await init('outside');
  const workspace = path.join(dir, 'workspace');
  await symlink(workspace, path.join(workspace, 'cycle'), 'dir');
  await symlink(external, path.join(workspace, 'linked'), 'dir');
  assert.equal(await findRepository(bare), undefined);
  assert.deepEqual(await discoverRepositories([workspace]), [root]);
});

test('supports opening a repository subfolder without scanning outside that folder', async t => {
  const { init } = await fixture(t);
  const root = await init('paper');
  await init('paper/sibling');
  const child = await init('paper/chapters/deep/child');
  const folder = path.join(root, 'chapters');
  assert.deepEqual(await discoverRepositories([folder]), [root, child].sort());
});

test('fresh scans detect creation and removal; invalid nested .git does not fall back to its parent', async t => {
  const { dir, init } = await fixture(t);
  const root = await init('paper');
  assert.deepEqual(await discoverRepositories([dir]), [root]);
  const child = await init('paper/new');
  assert.deepEqual(await discoverRepositories([dir]), [root, child].sort());
  await rm(path.join(child, '.git'), { recursive: true });
  assert.equal(await findRepository(child), root);
  assert.deepEqual(await discoverRepositories([dir]), [root]);
  await writeFile(path.join(child, '.git'), 'gitdir: missing\n');
  assert.equal(await findRepository(child), undefined);
  assert.deepEqual(await discoverRepositories([dir]), [root]);
});
