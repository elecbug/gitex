import { spawn } from 'node:child_process';

export interface GitResult { code: number; stdout: Buffer; stderr: string }
export function redact(value: string): string { return value.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@'); }
export class GitError extends Error {
  constructor(public readonly result: GitResult, operation: string) {
    super(`Git ${operation} failed: ${redact(result.stderr.trim() || `exit code ${result.code}`)}`);
  }
}

export class Git {
  constructor(readonly cwd: string) {}

  run(args: string[], input?: string | Buffer): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: this.cwd, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' }, stdio: 'pipe' });
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      let size = 0;
      let failure: Error | undefined;
      const timer = setTimeout(() => { failure = new Error('Git operation timed out. Check the connection and Git authentication.'); child.kill(); }, 60_000);
      const receive = (destination: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { failure = new Error('GiTex metadata exceeds the 32 MiB prototype limit.'); child.kill(); }
        else { destination.push(chunk); }
      };
      child.stdout.on('data', receive(output));
      child.stderr.on('data', receive(errors));
      child.stdin.on('error', () => { /* The exit status reports closed input pipes. */ });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (failure) { reject(failure); }
        else { resolve({ code: code ?? -1, stdout: Buffer.concat(output), stderr: Buffer.concat(errors).toString('utf8') }); }
      });
      child.stdin.end(input);
    });
  }

  async text(args: string[], input?: string | Buffer): Promise<string> {
    const result = await this.run(args, input);
    if (result.code !== 0) { throw new GitError(result, args[0]); }
    return result.stdout.toString('utf8').trimEnd();
  }

  async ref(name: string): Promise<string | null> {
    const result = await this.run(['rev-parse', '--verify', '--quiet', name]);
    if (result.code === 1) { return null; }
    if (result.code !== 0) { throw new GitError(result, 'rev-parse'); }
    return result.stdout.toString('utf8').trim();
  }
}
