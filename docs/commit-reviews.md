# Commit-scoped reviews and synchronization

GiTex 0.15.2 attaches a review view to a **paper commit hash**. The current checkout selects the discussion, location and resolution state to display. Updating reviews never requires the latest paper commit, and GiTex does not compare the checkout with a remote paper branch. An older checkout or detached HEAD can continue reviewing its own version.

`paperCommit` is the repository commit ID. `documentHash` is a separate SHA-256 hash of the LF-normalized annotated file, used to verify exact range coordinates. Identical file contents in different commits do not implicitly combine their discussions.

## Supported collaboration workflow

The supported workflow has one active source author and multiple concurrent reviewers. Reviewers share the same paper commit and independently sync comments and replies. The author collects those reviews before creating the next paper version. Source authorship can be handed over after committing and synchronizing; GiTex does not enforce an author lock.

Finish sharing and collecting the previous version's intended reviews before the next version's **first review publication**. This refers to the metadata push, not the paper push. Since `gitex.autoSyncOnCommit` can publish after a new local commit, the simple operating rule is to collect H1 feedback before creating H2. No fetch can collect another reviewer's unpublished local work, so closing a review round requires participant coordination. Late ancestor updates remain visible without reopening published inheritance.

Comments on unsaved or uncommitted source remain supported without a clean-commit requirement; recipients may wait in **Pending document** until the referenced version is available. The complete scope and handoff procedure are in [Supported collaboration model](collaboration-model.md).

## Display authority and copies

A checkpoint contains the paper hash, an explicit set of immutable review events, their fingerprint, selected comment revisions, resolution state and tracking outcome. An attached checkpoint also contains the reference and its fragment/insertion offsets. Replaying only the selected events reconstructs that version's discussion. Concurrent records **within one paper version** union their events; records from other paper commits remain in history.

For example:

1. A has comments R1 and R2.
2. Creating B copies the applicable state of R1 and R2 to B and tracks their ranges through the source changes.
3. Editing R1 on B changes B's view. A still shows its own R1 revision.
4. Synchronizing while checked out at A updates A's reviews without requesting B's source.

Thread and comment IDs remain stable across these copies. Their event sets and locations are versioned; the entire discussion body is not duplicated into every checkpoint. The Review header and Explorer identify the selected commit. **Paper commit history** retains earlier snapshots. Inline and webview drafts are scoped to the paper commit.

A review known only on another commit remains **Pending document** outside the source editor. Users can open that particular paper version to inspect it, or explicitly reconnect it with **Move to editor selection**. Neither seeing that review nor syncing requires advancing to the latest remote paper. Dirty buffers retain their last clean paper commit until reconciled with disk.

## Inheritance and first publication

On observing a paper commit, GiTex follows every parent, stopping at the nearest recorded view on each ancestry path. A merge therefore inherits the review event sets of both parent branches. Conflicting body edits remain visible in history; concurrent moves and resolve/reopen operations follow logical-clock/event-ID order, with older automatic references unable to undo an explicit move.

The initial checkpoint is provisional. Before its first publication, synchronization receives remote reviews and fills in any newly received parent-version discussion. This prevents a checkpoint made with stale local metadata from permanently omitting an already shared reply. Local edits on the new version are retained in that union. Committed geometry is preserved when only discussion changes.

A publication record also freezes the inherited thread membership, including an empty discussion. New comments later added to an older version do not appear in an already published copy or its descendants; a published parent with no such thread is an authoritative absence. Comments explicitly created on the new version and manual reconnections remain possible. Concurrent initial publications union their memberships.

Explorer and Review disclose ancestor comment/reply/edit/state updates absent from the selected version, with their paper hashes and event count. A wholly excluded thread is labeled **Not inherited**; it remains outside the editor. An existing current thread can display **Earlier updates** without altering its current discussion. **Paper commit history** shows the earlier records. Switching to that hash or explicitly reconnecting is deliberate; an extra paper pull does not retroactively reopen published inheritance. Amend/rebase siblings are not mislabeled as late ancestor updates.

A non-provisional checkpoint found in the remote archive freezes that thread's inherited set for its paper version. Subsequent edits on that version still update its view, but later corrections on its parents do not flow into the published copy. A local finalization whose push failed is reconsidered on retry; merely writing it locally does not establish publication. This is an observation/publication boundary, not a reconstruction of wall-clock review state at the source commit's original timestamp.

Commit snapshots use `git show <commit>:<path>`, not the staging area or unsaved buffer. Exact editor hints can retain cut/paste locations when the hint's entire document hash, path and revision match the committed file. Missing files and wholly removed targets receive recorded outcomes; resolved threads are included too. `gitex.autoSyncOnCommit` schedules sharing after a newly observed commit independently of `gitex.autoSyncOnSave`.

## Authorship, files and concurrent edits

Each root comment and each reply has one file: `comments/<commentId>.json`. The file contains its creation event and all immutable edit revisions. The first event establishes the original author. Only that author's Git email, compared after trimming and case normalization, may edit its body through GiTex. Other collaborators can reply, move the thread and change its resolved state. Those operations have their own recorded authors.

Author-only editing reduces conflicts but cannot prevent the same author from editing on two devices. GiTex merges revision DAGs by immutable ID instead of applying Git's textual JSON merge:

- Independent comments and replies merge automatically.
- Concurrent edits retain both bodies. Logical-clock/event-ID order selects a deterministic preview, and **Concurrent edits** explicitly signals competing revision heads.
- The author can inspect History and save the intended text. That revision acknowledges every competing head visible when editing began. A draft that has not seen the current conflict cannot silently resolve it.
- Reusing an immutable ID with different content, malformed records, or an owner-protected edit with a different author aborts synchronization.

Git configuration is not authenticated identity: a repository writer can impersonate another email or change metadata directly. This is a collaboration rule enforced by the extension and data validation, not server authorization. Historical edits made before author-only editing remain readable with their original editor attribution.

## Automatic synchronization

A successful creation, reply, edit or manual move schedules one background sync when `gitex.autoSyncOnSave` is enabled. Both manual **Sync Comments** buttons use the same flow:

1. Resolve one push destination and fetch its `refs/heads/gitex-comments` into a unique temporary ref; validate it before merging.
2. Union immutable review events and deduplicated document snapshots with local work.
3. Complete unpublished copies for locally known paper commits, after receiving their parent reviews.
4. Inspect all outgoing metadata history and apply the snapshot-sharing policy below. Cancellation retains local work and already received remote reviews.
5. Push the approved metadata commit to the approved destination normally, never with force. Saves can continue during approval and network operations. A save made after the publication tip was captured is left for the next sync and shown as **Sync pending**.
6. If another writer wins the push race, receive and merge again, with at most four push attempts. Other Git/network/validation errors are reported, leaving local work available.

There is no manual-pull prerequisite and no paper freshness warning. The source branch, HEAD, working tree and index remain unchanged. Metadata transport can include the full archive, including other paper versions; the displayed view and edits are scoped to the selected version. There is no polling. Opening, clicking, expanding, starting an edit and resolving a thread do not initiate network requests.

**Fetch Comments** remains a receive-only action using the configured fetch URL; it does not clear an outstanding publication notice. Sync receives and publishes at the push URL, even when the two URLs differ. **Refresh Comments** reloads local data. Disabling both automatic settings leaves synchronization manual. Offline edits and failed pushes remain local for the next attempt.

## Snapshot sharing and size

Comments can reference a whole `.tex`, `.bib`, `.sty`, `.cls` or `.ltx` snapshot, including unsaved/uncommitted source outside the selected passage. Snapshots and author emails remain in the metadata Git history. Deleting a file at the metadata tip does not remove it from outgoing ancestry.

Before the first push for a repository/destination, automatic sync keeps comments local and directs the user to **Sync Comments**. Manual sync displays a confirmation with new snapshot count, uncompressed bytes and count absent from the current paper history. Cancel sends nothing. Consent is tied to the local repository and hashed push URL; a changed destination requires fresh acknowledgment. Both manual buttons and automatic save/commit publication use this gate. Fetch remains available without publication.

`gitex.autoShareUncommittedSnapshots` defaults to **false**. After the first acknowledgment, committed-only automatic sync works normally; snapshots absent from the local HEAD history hold the entire push until manually approved. Enable the setting to allow automatic sharing of those snapshots after the initial acknowledgment. This does not require pulling a newer paper commit. A snapshot identical to a committed blob reachable from HEAD (including CRLF equivalents) counts as committed; unknown or rewritten intermediate drafts are conservatively treated as uncommitted. Merely committing a later version does not make older, different snapshots committed.

Inspection walks every outgoing metadata tree, deduplicates snapshot blobs and excludes objects already reachable at the remote metadata tip. The comparison uses metadata fetched from the actual push destination, including when fetch and push URLs differ. Multiple push URLs are refused: configure a separate remote per destination. The approved immutable tip and destination are pinned during the dialog; retries inspect the new merged batch again. The store requires an explicit `PublicationGuard` before any sync work. Production supplies the disclosure policy; temporary-repository tests explicitly supply their own policy. Missing policies fail closed.

Snapshots deduplicate by full content hash. Small source edits therefore add full logical snapshots; Git compression and delta packing can reduce physical storage, but do not erase historical source. Publication checks scan history and may take longer for large archives. See [Stability validation](stability-validation.md) for a reproducible size experiment and its limits. There is no automatic destructive pruning.

## Storage, validation and compatibility

| Location | Contents |
| --- | --- |
| `refs/gitex/comments` | Local metadata history |
| `refs/heads/gitex-comments` on the remote | Shared metadata history |
| `comments/<commentId>.json` | One root comment or reply and its immutable revisions |
| `events/<eventId>.json` | Thread moves, resolution changes and paper checkpoints |
| `papers/<publicationId>.json` | Immutable paper hash and inherited thread membership at first publication |
| `documents/<documentHash>.txt` | Deduplicated annotated file snapshots, including unsaved text when reviewed |

Archive format **4** reads formats 1–3 and migrates them on the next metadata write. Existing logical events and their IDs are preserved, including historical cross-author edits. All collaborators must upgrade to **0.15.0 or later** before writing this format. Older readers reject unsupported archives rather than dropping files. For the tracking and snapshot-safety policies documented here, use **0.15.2 or later** across collaborators.

Checkpoints can store `eventBase` plus `eventDelta` instead of repeating an inherited event-ID array. Decoding restores the event set before ordinary ancestry and fingerprint validation. Same-clock concurrent checkpoints never serve as each other's compact base. In-memory archives and projected threads are cached by immutable metadata tip, unchanged blobs are reused, and metadata reads are batched to bound individual Git responses. Very large single comment files/document snapshots still have the Git wrapper's 32 MiB response limit; compaction is not unlimited archive scaling.

Local ref writes use compare-and-swap, preserving changes from competing windows. A changed checkpoint geometry invalidates a stale location cache even when source text and substantive anchor revision are unchanged. Equivalent geometry preserves live editor tracking. An explicit move can recover a review after amend/rebase while retaining its old commit records; identical text alone does not silently migrate it to another commit.

## Verification

Core tests cover independent and competing edits, ownership, conflict acknowledgment, format migration, metadata push races, late parent replies, both-parent inheritance, older/detached paper versions, explicit recovery after amend, immutable source snapshots and paper/index preservation. VS Code tests cover author-only actions in both interfaces, preserved drafts, automatic publication, version switching, checkpoint geometry, cut/paste and pending document behavior.

The local writer queue, separate network queue, endpoint ownership and sync completion receipt are described in [Architecture review](architecture-review.md).
