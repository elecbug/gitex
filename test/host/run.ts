import { runTests } from '@vscode/test-electron';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:net';
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
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { server.close(); reject(new Error('No test port available')); return; }
        server.close(() => resolve(address.port));
      });
    });
    await runTests({
      version: process.env.GITEX_VSCODE_VERSION ?? '1.90.2',
      extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
      extensionTestsPath: path.join(__dirname, 'suite'),
      extensionTestsEnv: { GITEX_CDP_PORT: String(port) },
      launchArgs: [workspace, '--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--disable-extensions',
        `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
        '--skip-welcome', '--skip-release-notes', '--user-data-dir', path.join(temp, 'user-data'), '--extensions-dir', path.join(temp, 'extensions')]
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
