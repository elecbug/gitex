# GiTex Anchor Tracking

This document describes GiTex 0.13.0. Active tracking follows editor edits from a known document version. It does not repeatedly search for a similar sentence or promote a fuzzy match into a new reference.

## 1. Selecting a target

A nonempty editor selection owns exactly the dragged text, including partial first and last lines. GiTex does not expand it to a whole line or infer linguistic sentence boundaries. With a cursor and no selection, the target is the entire current line. Creation, native gutter comments, and manual moves use the same conversion.

Positions use zero-based UTF-16 columns, as VS Code does; ends are exclusive. A selection ending at column zero of the next line excludes that line. CRLF is normalized to LF in document snapshots and offset calculations. Reversed selections work identically. Whitespace-only targets are rejected before the command opens its input. Blank lines offer no new-comment gutter button.

`startLine` and `endLine` identify the physical source lines. Optional `logicalRange` columns bound the actual owned text. Inline thread ranges and source navigation use those columns. Older references without columns retain their original whole-line meaning.

## 2. Three distinct records

| Record | Purpose | Lifetime |
| --- | --- | --- |
| Original selection | Records what the author originally selected. | Creation or the last explicit manual move establishes `identityAnchor`. Automatic editor tracking never replaces it. Earlier identities remain in tracking history. |
| Shared reference | Describes the current leading fragment and all surviving fragments against an exact document snapshot. | Captured on creation, manual moves, and comment/reply/edit saves while attached; stored in immutable review events. |
| Local edit state | Maintains ranges, deleted positions, recent cut information, and undo checkpoints. | Changes with editor operations. Saved document state is persisted in VS Code workspace storage; unsaved changes and undo checkpoints remain in memory. |

The review panel shows **Saved reference**, **Original selection**, and **Tracking history** separately. Source edits do not create comment events or trigger comment synchronization. A comment save can publish an updated reference without replacing the original identity.

Legacy surrounding sentences, nearby source lines, and end boundaries remain available as historical information. They do not decide where the active editor tracker attaches a comment.

## 3. Applying editor operations

`EditTracking` consumes `onDidChangeTextDocument` changes. The event's ranges address the document before the batch. GiTex normalizes newline offsets and applies independent changes in descending source order.

| Operation | Range behavior |
| --- | --- |
| Insert or delete before a fragment | Shift both endpoints by the edit's length delta. |
| Insert at its start | Move the start forward; the prepended text is outside the target. |
| Insert at its end | Keep the existing end; appended text is outside the target. |
| Replace text wholly inside a fragment | Follow the replacement using the editor's range. The original selection remains recorded. |
| Insert whitespace or a line break inside | Keep one continuous, potentially multi-line range. |
| Insert other text inside | Split into leading and trailing fragments, excluding the inserted text. |
| Delete part of a fragment | Retain surviving fragments and the removed part's position. |
| Remove the entire target | Keep an `Uncertain` marker at the deletion position while retaining the saved excerpt. |

Fragments retain their original order, rather than being sorted by their current document offsets. The first surviving fragment containing text receives the inline comment. When `A–B` becomes `A–C` and `C–B`, `A–C` is displayed and the original `A–B` remains available. Saving a reply preserves the other surviving fragments and the separately tracked inserted regions as well.

Insertion at the end prevents `A` from absorbing an appended sentence `B`. This is a boundary rule derived from the operation, not a sentence-similarity threshold. A deliberate replacement of the entire selected range is an edit to that target and may update its text; **Original selection** continues to show what was there before.

## 4. Cut, paste, undo, and redo

A deletion records the exact deleted text and each affected fragment's offset inside it. A later insertion of that exact text in the same source document restores those fragments at the pasted location. Cutting a larger container, such as a LaTeX command around the selected text, retains the inner selection's relative offset. A single event containing both deletion and insertion is supported in either direction. A copied passage does not move a still-attached comment.

VS Code's stable change API does not identify clipboard transactions. Pairing therefore uses the most recent matching deletion in the current editing session. Saving the source and subsequent edits do not expire a live cut record. The cut record is consumed when matched; it is not a fuzzy text search. Clipboard pairing is session-local. A manual move remains the way to relocate a thread across files or confirm a destination when the edit sequence cannot establish it.

Up to 32 recent document checkpoints retain fragment state for undo and redo. Restoring a checkpoint restores splits and cut state as well as endpoints. After restart, the last saved document, fragment ranges, and inserted regions are restored; the in-memory undo and clipboard records are not persisted.

A cut remains `uncertain` while its editing session is alive, including after saving. An exact paste updates its position and returns it to `attached`. Closing the last text tab for that source file ends the session; another open tab for the same file keeps it alive. If the saved document has no surviving target, ending that session finalizes it as `outdated`. Restarting VS Code also restores a saved, wholly removed target as `outdated`. It stays in Explorer and Review without an editor marker. A later paste in a new session does not silently revive an expired cut; use a manual move to reconnect. Partially removed targets with surviving fragments remain attached. Local session status does not create or synchronize a comment event.

## 5. File reloads and edits made elsewhere

A file reload or formatter can report one broad replacement. If it surrounds a tracked fragment, GiTex decomposes that replacement into an exact character edit script. Reopening a document also replays an exact diff from its last known local state. This handles changes made while the editor was closed without searching for an approximately matching passage.

The diff uses bounded Myers alignment after stripping a common prefix and suffix. It is capped at 1,024 edit-distance steps and two million work units. If the bound is exceeded, the changed block is treated as an unproven replacement; unaffected ranges outside it still shift normally. Identical repeated text and edits made outside the observed editor cannot reveal the user's original clipboard intent. Use manual reconnection when an exact diff cannot recover that intent.

## 6. Comments arriving before the paper

A new reference includes `tracking: { version: 1, fragments, insertions? }`. Fragment and insertion offsets address the LF-normalized source snapshot identified by `documentHash`. The metadata archive stores that **whole annotated source document**, including unsaved edits, once at `documents/<documentHash>.txt`. Multiple threads and replies can share the same blob. Figures and unrelated files are not included.

Receiving the snapshot as review metadata does not count as receiving the paper into the working copy. Before starting tracking for an unfamiliar reference, GiTex requires one of:

1. A locally observed range for that reference, including a comment staged before opening its input box or starting its Git write.
2. A current editor document with the exact snapshot hash.
3. The snapshot's file content in the current paper branch's Git history, followed by exact edit replay to the working document.

The history check is limited to the reference's file path. Fetching a remote paper commit without advancing the current paper branch is insufficient. LF and CRLF Git blobs are supported.

| State | Meaning | UI |
| --- | --- | --- |
| `attached` | The tracked range has a surviving fragment. | Inline comment on the leading fragment, with every surviving fragment shaded. |
| `uncertain` | The observed target was removed. | A marker at its retained edit position, with the saved excerpt available. |
| `outdated` | The target is wholly removed in the saved document and its editing session has ended. | Explorer and Review only; no source marker or shading. |
| `pending` | This working copy has not established the reference's document version, or its file is unavailable. | **Pending document** in Explorer and Review; no inline thread. Instructions say to pull the paper through Source Control. |

A removed line may use an unnumbered CodeLens row; a source file is never changed merely to display a marker. Resolved threads remain hidden in the source editor in every state.

`Pending document` is recomputed, not saved as a permanent thread state. Pulling or opening the required paper version makes the comment eligible to attach. Comment replies and edits can still be saved while pending, but they cannot retarget the reference. **Sync Comments** continues to synchronize review metadata only; it does not pull the paper branch.

## 7. Storage, compatibility, and validation

The archive marker advances to format **2** when document snapshots are first stored. Individual immutable review events retain event version 1 and add optional tracking data. Creation, replies, edits, manual moves, and resolved state still merge by immutable event ID. Concurrent snapshot archives union their document blobs as well as their events. Git writes never modify the paper's HEAD, index, or working files.

GiTex reads existing format-1 archives without rewriting history. For an older reference, an exact current-document hash or the original file at `baseCommit` can establish the initial state. An old reference created against an uncommitted document may have no recoverable full snapshot. It remains pending until the original document is available or the user selects a target and uses **Move to editor selection**. Legacy local hints derived from similarity are not used as proof of continuity.

All collaborators must upgrade to **GiTex 0.12.0 or later** before sharing format-2 archives. Earlier clients reject the new archive rather than silently dropping document snapshots. Snapshots are part of shared review history: saving a comment on unsaved source text shares that annotated document version when comments synchronize.

## 8. Persistent source shading and clicks

Unresolved targets have a persistent pale-yellow background on every surviving original fragment, even when the inline comment is collapsed. Text inserted between fragments uses pale blue and a dashed outline. Insertions have their own ranges; GiTex does not label an arbitrary gap between moved fragments as inserted prose. Subsequent edits, cut/paste of the whole container, undo/redo, local persistence, and shared reference saves retain that distinction.

A mouse click inside either shade opens the thread in the reusable Review tab and expands its native inline thread. Source-editor focus is retained so clicking does not interrupt typing. Drag selections, keyboard movement, and programmatic selection changes do not trigger opening. Overlapping threads offer a chooser. Hover text identifies original versus inserted text and includes an explicit **Open comment** link.

Resolved, pending, and outdated threads have no source shading. Theme colors are configurable through `workbench.colorCustomizations` using `gitex.commentBackground`, `gitex.commentBorder`, `gitex.insertedBackground`, and `gitex.insertedBorder`. Light, dark, and high-contrast defaults are provided; solid versus dashed outlines and hover labels supplement color.

Insertion ranges are optional for compatibility with 0.12.0 references and local state. Old references retain their known fragment bounds; unknown historical gaps are not relabeled by guessing. Use 0.13.0 across collaborators to retain insertion provenance when saving updated references. The archive remains format 2 and the tracking data remains version 1.

Tests cover exact and reversed selection, cursor fallback, blank rejection, Unicode offsets, boundary edits, fragment splitting, wrapped lines, cut containers, copy behavior, batch moves, undo/redo, persistence, staged saves, exact diff reconstruction, concurrent archives, delayed paper delivery, real native gutter input, pending UI, recovery after pulling the paper, bright shading in three themes, both highlight click targets, focus preservation, save-then-paste, multiple tabs, and Outdated after the final tab closes.
