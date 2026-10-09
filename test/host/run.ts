import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Git } from '../../src/git';

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'gitex-host-'));
  try {
    const workspace = path.join(temp, 'paper');
    const bare = path.join(temp, 'paper.git');
    await mkdir(workspace);
    const git = new Git(workspace);
    await git.text(['init', '--bare', '--initial-branch=main', bare]);
    await git.text(['init', '--initial-branch=main']);
    await git.text(['config', 'user.name', 'Extension Tester']);
    await git.text(['config', 'user.email', 'tester@example.test']);
    await git.text(['remote', 'add', 'origin', bare]);
    await writeFile(path.join(workspace, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nA reviewed result.\n\\end{document}\n');
    await git.text(['add', 'main.tex']);
    await git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Test paper']);
    await git.text(['push', '-u', 'origin', 'main']);
    await runTests({
      version: process.env.GITEX_VSCODE_VERSION ?? '1.90.2',
      extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
      extensionTestsPath: path.join(__dirname, 'suite'),
      launchArgs: [workspace, '--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--disable-extensions',
        '--skip-welcome', '--skip-release-notes', '--user-data-dir', path.join(temp, 'user-data'), '--extensions-dir', path.join(temp, 'extensions')]
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
