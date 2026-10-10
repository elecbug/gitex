# Stability validation for GiTex 0.15.4

Validation covers separate local-write and network queues, explicit publication policy, and the commit-scoped event architecture with inheritance frozen at first publication. The 0.15.4 update adds a read-only Earlier unresolved view for excluded ancestor threads, alongside regression coverage for false attachments and source-snapshot disclosure. It does not add automatic cross-version discussion merging or destructive archive pruning.

## Evidence and remaining limits

Observed VS Code edit ranges and edits reconstructed from two document snapshots are different evidence. Reconstructed tracking compares forward and reverse alignments; disagreement retains `Uncertain`, prevents reference renewal and survives checkpoint inheritance. Agreeing alignments are a conservative check, not proof that only one edit history exists. Whole-file replacements are reconstructed even when delivered as an editor change.

Separate-event cut/paste pairing requires identifying text, uniqueness before deletion and after insertion, and a single eligible deletion group. Short/repetitive strings and bare LaTeX environment markers cannot pair across separate events. A uniquely paired deletion and insertion in one observed event can move a short selection. These are heuristics: the stable VS Code API does not expose clipboard identity, and coincidental insertion of long unique text remains possible. Manual reconnection is the explicit confirmation path.

Snapshot publication is consent-gated at both automatic and manual extension entry points. A first push needs acknowledgment; automatic sharing of uncommitted snapshots is disabled by default. Inspection includes ancestors, so deleting a sensitive snapshot from the current tree cannot hide it from the disclosure. Consent pins the immutable metadata tip and destination; concurrent local writes remain for the next push. This is an extension safeguard, not a Git server access-control mechanism.

## Regression matrix

Run `make test` and `make test-extension` (the latter opens an isolated VS Code instance). Tests create temporary source and bare repositories; they do not push the project repository.

| Area | Scenarios | Required outcome |
| --- | --- | --- |
| Observed edits | Selected text, boundary insertion, split fragments, Unicode, undo/redo | Preserve the selected identity and exclude appended/inserted prose |
| Cut/paste | Short `is`, repeated prose, LaTeX environment markers, one-event moves in either direction, eligible longer containers | No separate-event relocation for weak targets; preserve confirmed batch coordinates |
| Reconstructed edits | Repeated passage deletion, whole-file replacement, external move, ordinary prefix insertion | Ambiguous results stay uncertain; unambiguous results disclose reconstructed evidence |
| Uncertainty lifetime | Reply/save, later edits, restart, new paper commit, explicit move | Uncertain geometry never becomes a new reference without confirmation |
| Paper versions | Two users at different commits, detached HEAD, both-parent merge, amend and actual rebase | Current-commit views remain isolated; explicit recovery retains earlier history |
| Late reviews | New ancestor root and reply after descendant publication; later descendants; resolve/reopen; future or nearer resolved versions | Show excluded open threads as Earlier unresolved with their source hash and read-only actions; no source decorations or inherited copy; keep current discussion unchanged |
| Concurrent review writes | Same-author conflicts, independent comments/replies, rejected push and retry | Preserve all immutable events and require acknowledgment of competing edit heads |
| Snapshot sharing | First automatic push, cancel/approve dialog, uncommitted default, changed destination | Local comments survive; no unapproved push |
| Snapshot ancestry | Private blob absent at tip but present in a parent | Include that blob in the publication report |
| Concurrent approval and transport | The same store saves while approval, discovery, fetch or push is held | Save completes before release; publish only the inspected immutable tip |
| Transport destination | Separate fetch/push URLs, alias changes during approval, concurrent temporary refs | Merge the actual destination; keep approval pinned; isolate and clean receive refs |
| Sync feedback | Save during slow push, receive-only fetch, subsequent sync | Show remaining local work until publication succeeds |
| Required policy | Call the production store without a publication policy | Reject before network access or local mutation |
| Compatibility | Archives 1, 2 and 3 migrated to 4 | Preserve logical events and IDs; tracking/events remain version 1 |

VS Code 1.90 refuses modal dialogs in extension-test mode. The sharing test injects only the dialog response, verifies the disclosure text and exercises real inspection, cancellation, settings and Git publication. Other Review interactions are clicked with Playwright. A separate standalone VS Code 1.90.2 run with custom dialogs also rendered the real disclosure, verified that Cancel did not create a remote comments branch, and verified that Share This Push published successfully. Platform-native operating-system dialog layouts were not exercised.

The core regression suite now includes **174 tests**, including excluded-review resolution and source-version isolation. The VS Code **1.90.2** extension-host suite also covers the Earlier unresolved UI and explicit reconnection.

The automated matrix is a regression boundary, not a substitute for two-person usability testing. Release candidates should also be exercised with separate VS Code windows, real network latency, an offline reviewer who returns after publication, and repeated paper-version switching. Do not interpret synthetic tests as proof of all Git host/transport behavior.

## Reproducing the storage measurement

From the project root, with Node.js 22 or later:

```sh
npm run compile
node scripts/measure-snapshots.cjs 100
```

The script creates a temporary Git repository, commits a 65,534-byte synthetic LaTeX document, creates a review, and edits that review against 100 distinct source snapshots. Each source revision changes a six-digit revision marker outside the selected passage. It measures unique snapshot bytes and Git `pack-objects` output, then removes the temporary repository. No project refs or remote repositories are changed.

One run on 2026-10-10 produced:

| Metric | Result |
| --- | ---: |
| Initial document | 65,534 bytes |
| Source/comment edits | 100 |
| Distinct snapshots, including the original | 101 |
| Logical snapshot bytes | 6,618,934 bytes (6.31 MiB) |
| Packed snapshot blobs only | 47,200 bytes (46.09 KiB) |
| Packed initial metadata archive | 11,908 bytes |
| Packed complete metadata history after edits | 193,303 bytes (188.77 KiB) |
| Snapshots absent from the paper's committed history | 100 |
| Full first-publication inspection | 1,258 ms |

Pack output includes Git object overhead but not pack-index files, loose-object filesystem allocation or repository administration files. Complete metadata measurements include comments, checkpoints, trees and metadata commits. UUIDs/timestamps and Git versions can slightly change the output. The synthetic document is repetitive and its edits are small: rewritten or less compressible documents can cost considerably more. Logical storage grows with each distinct snapshot; packing reduces bytes without deleting old source. Inspection time depends on archive history, document size, machine and Git configuration.

Archive compatibility requires GiTex **0.15.0 or later** (read 1–3, write 4). Use **0.15.2 or later** across collaborators for the tracking and sharing safeguards described here.

The rationale and ownership boundaries for the 0.15.2 changes are in [Architecture review](architecture-review.md).
