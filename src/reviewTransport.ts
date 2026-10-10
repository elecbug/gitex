import { randomUUID } from 'node:crypto';
import { Git, GitError, GitResult } from './git';

export const REMOTE_REF = 'refs/heads/gitex-comments';
export interface ReviewEndpoint { readonly url: string }

/** Git transport only. Local review transactions and publication policy live above this boundary. */
export class ReviewTransport {
  constructor(private readonly git: Git) {}

  async endpoint(remote: string, direction: 'fetch' | 'push'): Promise<ReviewEndpoint> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote)) { throw new Error('Choose a valid Git remote name with GiTex: Connect Repository.'); }
    const urls = (await this.git.text(['remote', 'get-url', ...(direction === 'push' ? ['--push', '--all'] : []), remote])).split('\n');
    if (urls.length !== 1 || !urls[0]) { throw new Error('GiTex requires one push URL per remote. Configure a separate remote for each destination.'); }
    return Object.freeze({ url: urls[0] });
  }

  /** Keep the fetched immutable tip reachable until validation and local merge finish. */
  async snapshot<T>(endpoint: ReviewEndpoint, receive: (tip: string | null) => Promise<T>): Promise<T> {
    const advertised = await this.git.run(['ls-remote', '--exit-code', '--heads', '--', endpoint.url, REMOTE_REF]);
    if (advertised.code === 2) { return receive(null); }
    if (advertised.code !== 0) { throw new GitError(advertised, 'ls-remote'); }
    const tracking = `refs/gitex/transfers/${randomUUID()}`;
    try {
      await this.git.text(['fetch', '--no-tags', '--no-write-fetch-head', '--', endpoint.url, `${REMOTE_REF}:${tracking}`]);
      const tip = await this.git.ref(tracking);
      if (!tip) { throw new Error('The fetched GiTex metadata tip is unavailable. Try Sync Comments again.'); }
      return await receive(tip);
    } finally { await this.git.text(['update-ref', '-d', tracking]); }
  }

  push(endpoint: ReviewEndpoint, tip: string): Promise<GitResult> {
    return this.git.run(['push', '--porcelain', '--', endpoint.url, `${tip}:${REMOTE_REF}`]);
  }
}
