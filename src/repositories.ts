import * as path from 'node:path';
import { readdir } from 'node:fs/promises';
import { Git } from './git';

export function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Ask Git so .git files (worktrees/submodules), bare repositories and invalid boundaries are respected. */
export async function findRepository(directory: string): Promise<string | undefined> {
  const result = await new Git(directory).run(['rev-parse', '--show-toplevel']).catch(error => {
    if (error.code === 'ENOENT') { return undefined; }
    throw error;
  });
  if (!result) { return undefined; }
  return result.code === 0 ? path.resolve(result.stdout.toString('utf8').trimEnd()) : undefined;
}

export function repositoryContaining(roots: Iterable<string>, file: string): string | undefined {
  return [...roots].filter(root => within(root, file)).sort((a, b) => b.length - a.length)[0];
}

/** Scan once per workspace change/explicit refresh, never once per keystroke. */
export async function discoverRepositories(folders: readonly string[]): Promise<string[]> {
  const roots = new Set<string>();
  const seen = new Set<string>();
  const queue = [...folders];
  // Opening a subfolder of a working tree remains supported, without scanning its siblings.
  for (const folder of folders) {
    const root = await findRepository(folder);
    if (root) { roots.add(root); }
  }
  while (queue.length) {
    // Limit concurrent directory reads and Git processes, including on remote filesystems.
    const batch = queue.splice(0, 8).filter(directory => {
      if (seen.has(directory)) { return false; }
      seen.add(directory); return true;
    });
    await Promise.all(batch.map(async directory => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) { return []; }
        throw error;
      });
      const names = new Set(entries.map(entry => entry.name));
      if (names.has('HEAD') && names.has('objects') && names.has('refs')) {
        const bare = await new Git(directory).run(['rev-parse', '--is-bare-repository']);
        if (bare.code === 0 && bare.stdout.toString('utf8').trim() === 'true') { return; }
      }
      if (names.has('.git')) {
        const root = await findRepository(directory);
        if (root) { roots.add(root); }
      }
      for (const entry of entries) {
        // Do not follow directory symlinks, Git internals or incomplete repository imports.
        if (entry.isDirectory() && entry.name !== '.git' && !entry.name.startsWith('.gitex-import-')) {
          queue.push(path.join(directory, entry.name));
        }
      }
    }));
  }
  return [...roots].sort();
}
