import { createHash } from 'node:crypto';
import { Git } from './git';

export interface SnapshotPublication {
  tip: string;
  destinationKey: string;
  snapshots: { hash: string; bytes: number; committed: boolean }[];
  bytes: number;
}
export type PublicationGuard = (publication: SnapshotPublication) => Promise<void>;

/** Inspect every outgoing tree: deleting a snapshot at the tip does not remove it from Git history. */
export async function inspectPublication(git: Git, tip: string, remoteTip: string | null, destination: string): Promise<SnapshotPublication> {
  const objectIds = async (ref: string | null) => new Set(ref ? (await git.text(['rev-list', '--objects', ref])).split('\n').map(line => line.split(' ')[0]) : []);
  const remoteObjects = await objectIds(remoteTip);
  const paperObjects = await objectIds(await git.ref('HEAD'));
  const revisions = [tip, ...(remoteTip ? ['--not', remoteTip] : [])];
  const trees = new Set((await git.text(['log', '--format=%T', ...revisions])).split('\n').filter(Boolean));
  const snapshots = new Map<string, { hash: string; bytes: number; committed: boolean }>();
  for (const tree of trees) {
    const records = (await git.text(['ls-tree', '-r', '-l', '-z', tree, '--', 'documents'])).split('\0').filter(Boolean);
    for (const record of records) {
      const match = /^100644 blob ([a-f0-9]+)\s+(\d+)\tdocuments\/([a-f0-9]{64})\.txt$/.exec(record);
      if (!match || remoteObjects.has(match[1]) || snapshots.has(match[1])) { continue; }
      let committed = paperObjects.has(match[1]);
      // GiTex stores LF snapshots even when the paper's committed blob uses CRLF.
      if (!committed) {
        const content = await git.run(['cat-file', 'blob', match[1]]);
        if (content.code !== 0) { throw new Error('Unable to inspect the outgoing document snapshot.'); }
        const crlf = await git.text(['hash-object', '--stdin'], content.stdout.toString('utf8').replace(/\n/g, '\r\n'));
        committed = paperObjects.has(crlf);
      }
      snapshots.set(match[1], { hash: match[3], bytes: Number(match[2]), committed });
    }
  }
  const records = [...snapshots.values()];
  return { tip, destinationKey: createHash('sha256').update(destination).digest('hex'), snapshots: records,
    bytes: records.reduce((sum, snapshot) => sum + snapshot.bytes, 0) };
}
