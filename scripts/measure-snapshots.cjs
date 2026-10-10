// Run after npm run compile. All Git writes are confined to a disposable temporary repository.
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ReviewStore, LOCAL_REF } = require('../out/src/store');
const { createAnchor } = require('../out/src/anchor');
const { enableEditTracking } = require('../out/src/editTracking');
const { inspectPublication } = require('../out/src/snapshotPrivacy');

async function main() {
  const edits = Number(process.argv[2] ?? 100);
  if (!Number.isSafeInteger(edits) || edits < 1 || edits > 1000) throw new Error('Choose 1–1000 edits.');
  const root = await mkdtemp(path.join(tmpdir(), 'gitex-snapshot-size-'));
  try {
    const store = new ReviewStore(root), git = store.git;
    await git.text(['init', '--initial-branch=main']);
    await git.text(['config', 'user.name', 'Snapshot benchmark']);
    await git.text(['config', 'user.email', 'benchmark@example.invalid']);
    let content = '\\documentclass{article}\n\\begin{document}\nThe protocol reduces network latency.\n';
    for (let i = 0; content.length < 65500; i++) {
      const tag = createHash('sha256').update(String(i)).digest('hex').slice(0, 24);
      content += `Observation ${i}: reproducible measurement ${tag}; the protocol was evaluated under controlled conditions.\n`;
    }
    const document = version => content.slice(0, 65500) + `\n% revision ${String(version).padStart(6, '0')}\n\\end{document}\n`;
    await writeFile(path.join(root, 'main.tex'), document(0)); await git.text(['add', 'main.tex']);
    await git.text(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Benchmark source']);
    const head = await store.head();
    const anchor = text => enableEditTracking(createAnchor('main.tex', text, 2, 2, head), text);
    const id = await store.create(anchor(document(0)), 'Review 0', document(0));
    const initialTip = await git.ref(LOCAL_REF);
    const packed = async (args, input) => {
      const result = await git.run(['pack-objects', '--stdout', ...args], input);
      if (result.code) throw new Error(result.stderr);
      return result.stdout.length;
    };
    const initialArchivePackBytes = await packed(['--revs'], initialTip + '\n');
    for (let i = 1; i <= edits; i++) {
      const review = (await store.threads())[0], text = document(i);
      await store.edit(id, id, `Review ${i}`, review.comments[0].revisions.at(-1).id, anchor(text), review.anchorRevision, text);
    }
    const tip = await git.ref(LOCAL_REF);
    const records = (await git.text(['ls-tree', '-r', '-l', tip, '--', 'documents'])).split('\n').map(line => /^100644 blob ([a-f0-9]+)\s+(\d+)\t/.exec(line)).filter(Boolean);
    const unique = new Map(records.map(record => [record[1], Number(record[2])]));
    const started = performance.now();
    const publication = await inspectPublication(git, tip, null, 'benchmark');
    const inspectionMilliseconds = Math.round(performance.now() - started);
    console.log(JSON.stringify({ documentBytes: Buffer.byteLength(document(0)), edits,
      uniqueSnapshots: unique.size, logicalSnapshotBytes: [...unique.values()].reduce((a, b) => a + b, 0),
      snapshotOnlyPackBytes: await packed([], [...unique.keys()].join('\n') + '\n'),
      initialArchivePackBytes, finalArchivePackBytes: await packed(['--revs'], tip + '\n'),
      uncommittedSnapshots: publication.snapshots.filter(snapshot => !snapshot.committed).length,
      inspectionMilliseconds }, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
