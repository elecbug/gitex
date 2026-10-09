import { lstat, readdir, mkdir, mkdtemp, link, rmdir, unlink, rm, realpath } from 'node:fs/promises';
import { Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Git } from './git';
import { validPath } from './model';

async function stat(file: string): Promise<Stats | undefined> {
  try { return await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
}

export async function checkImportTarget(root: string): Promise<void> {
  if (!(await lstat(root)).isDirectory()) { throw new Error('Open a regular local folder to apply a repository.'); }
  if (await stat(path.join(root, '.git'))) { throw new Error('This folder already contains .git. Open it as a repository instead.'); }
  const existing = await new Git(root).run(['rev-parse', '--git-dir']);
  if (existing.code === 0) { throw new Error('This folder is already in a Git repository. Choose a folder outside existing repositories.'); }
}

interface Entry { relative: string; directory: boolean }
interface Created { file: string; source?: string; identity: Stats }
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** Import a staged checkout without replacing any existing file or following existing symlinks. */
export async function importRepository(folder: string, address: string, beforeApply: () => void | Promise<void> = () => undefined): Promise<void> {
  address = address.trim();
  if (!address || address.startsWith('-') || /[\r\n\0]/.test(address)) { throw new Error('Enter a valid Git repository address.'); }
  await checkImportTarget(folder);
  const root = await realpath(folder);
  // Staging here keeps atomic, exclusive hard links on the same filesystem as the destination.
  const temporary = await mkdtemp(path.join(root, '.gitex-import-'));
  const stage = path.join(temporary, 'checkout');
  const created: Created[] = [];
  const directories = new Map<string, Stats>([[root, await lstat(root)]]);
  try {
    const git = new Git(root);
    await git.text(['-c', `core.hooksPath=${os.devNull}`, 'clone', '--no-hardlinks', '--no-checkout', '--template=', '--', address, stage]);
    const checkout = new Git(stage);
    const head = await checkout.ref('HEAD');
    if (!head) { throw new Error('The remote must have a default branch with at least one commit. No repository was applied.'); }
    const branch = await checkout.text(['symbolic-ref', '--short', 'HEAD']);
    if (branch === 'gitex-comments') { throw new Error('The remote default branch must be a paper branch, not gitex-comments.'); }
    const tree = await checkout.text(['ls-tree', '-rz', '--full-tree', 'HEAD']);
    for (const entry of tree.split('\0').filter(Boolean)) {
      const match = /^(\d+) \w+ [a-f0-9]+\t([\s\S]+)$/.exec(entry);
      if (!match || !validPath(match[2]) || !['100644', '100755'].includes(match[1])) {
        throw new Error('Apply Repository supports regular files only. For symlinks, submodules, or unsupported paths, use Clone Repository.');
      }
      if (match[2].split('/')[0] === path.basename(temporary)) { throw new Error('A remote path conflicts with the temporary import folder. Retry the command.'); }
    }
    await checkout.text(['-c', `core.hooksPath=${os.devNull}`, 'reset', '--hard', 'HEAD']);
    const entries: Entry[] = [];
    async function walk(relative: string): Promise<void> {
      const source = path.join(stage, relative);
      const info = await lstat(source);
      if (!info.isDirectory() && !info.isFile()) { throw new Error(`Unsupported checkout path: ${relative}`); }
      entries.push({ relative, directory: info.isDirectory() });
      if (info.isDirectory()) {
        for (const child of (await readdir(source)).sort()) { await walk(path.join(relative, child)); }
      }
    }
    // Files first, metadata last. HEAD is installed last so Git does not see a partial repository.
    for (const name of (await readdir(stage)).filter(name => name !== '.git').sort()) { await walk(name); }
    await walk('.git');
    const headIndex = entries.findIndex(entry => entry.relative === path.join('.git', 'HEAD'));
    entries.push(...entries.splice(headIndex, 1));

    async function preflight(): Promise<void> {
      await checkImportTarget(root);
      for (const entry of entries) {
        const file = path.join(root, entry.relative);
        const info = await stat(file);
        if (!info) { continue; }
        if (!entry.directory || !info.isDirectory() || entry.relative === '.git') {
          throw new Error(`Existing path conflicts with the repository: ${entry.relative}. Move it out of the folder before applying.`);
        }
        directories.set(file, info);
      }
    }
    await preflight();
    await beforeApply();
    await preflight();
    async function verifyParents(file: string): Promise<void> {
      let parent = path.dirname(file);
      while (true) {
        const expected = directories.get(parent);
        const current = await stat(parent);
        if (!expected || !current?.isDirectory() || !sameFile(expected, current)) {
          throw new Error('The folder changed during import. Retry after other file operations finish.');
        }
        if (parent === root) { break; }
        parent = path.dirname(parent);
      }
    }
    for (const entry of entries) {
      const file = path.join(root, entry.relative);
      await verifyParents(file);
      if (entry.directory && directories.has(file)) {
        const current = await stat(file);
        if (!current?.isDirectory() || !sameFile(directories.get(file)!, current)) { throw new Error(`Folder changed during import: ${entry.relative}`); }
        continue;
      }
      if (entry.directory) {
        await mkdir(file); // Exclusive: even a new empty directory is a conflicting concurrent write.
        const identity = await lstat(file);
        directories.set(file, identity);
        created.push({ file, identity });
      } else {
        const source = path.join(stage, entry.relative);
        const identity = await lstat(source);
        await link(source, file); // Atomic creation; EEXIST never overwrites the destination.
        created.push({ file, source, identity });
      }
    }
  } catch (error) {
    let retained = false;
    for (const entry of created.reverse()) {
      try {
        const current = await stat(entry.file);
        if (!current) { continue; }
        if (!sameFile(current, entry.identity)) { retained = true; continue; }
        if (entry.source) {
          // A concurrent edit belongs to the user, even if it changed one of our newly created files.
          if (current.size !== entry.identity.size || current.mtimeMs !== entry.identity.mtimeMs) { retained = true; continue; }
          await unlink(entry.file);
        } else { await rmdir(entry.file); }
      } catch { retained = true; }
    }
    if (retained) { throw new Error(`${error instanceof Error ? error.message : String(error)} Some files changed during import and were retained; inspect the folder before retrying.`); }
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
