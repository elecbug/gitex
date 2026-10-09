# GiTex

English | [한국어](README.kr.md)

A VS Code extension for sharing line comments on LaTeX papers through Git. Use it alongside your existing editing, compilation, and PDF preview setup, including LaTeX Workshop.

## Features

- Open or clone a Git repository, or apply one directly to the current folder when no existing paths conflict.
- Discover repositories recursively under workspace folders and switch comments and sync targets with the selected source file.
- Select or add a remote for sharing comments.
- Comment on one or more lines in `.tex`, `.bib`, `.sty`, `.cls`, and `.ltx` files.
- Reply to comments and resolve or reopen threads with checkboxes in Explorer and the review panel. Resolved threads stay in Explorer and are hidden in the paper editor.
- Edit comments and replies while preserving the original text and every edit in history.
- Automatically pull and push comments once after creating a comment, replying, or saving an edit; enabled by default and configurable.
- Browse threads in **GiTex Comments** in the Explorer and VS Code's **Comments** panel.
- Follow passages through small text edits, whitespace changes, line rewrapping, and movement using text similarity and surrounding context.
- Renew tracking references only with strong evidence, keep a fixed identity to limit drift, and preserve previous references in history.
- Manually move a thread to selected source lines, including another file in the same repository, with a complete move history.
- Reuse one review tab when switching threads, preserving unsaved edits and replies while the tab stays open.
- Save one preceding and following sentence, estimate missing passages as **Uncertain**, and keep untraceable comments **Outdated** in Explorer.
- Keep separate shared and local tracking references, updating local context as you edit and recording an explicit document-end boundary for final passages.
- Save comments offline and synchronize reviews from multiple users through a central bare repository.

Use VS Code's **Source Control** for paper commits, push/pull, and merges. **Sync Comments** and automatic sync after saving both receive and publish review data. They leave your working files, current branch, and staging area unchanged.

## Architecture and collaboration flow

Each collaborator edits a local working copy in VS Code. A shared Git remote stores both the paper and its review history, with separate branches for each. The diagram shows User A writing the paper and User B reviewing it; both users can perform either role.

![GiTex architecture: two VS Code users exchange LaTeX documents through the Main Branch and review comments through the GiTex Branch in a shared bare Git repository.](docs/images/architecture.png)

Green boxes (**Edited Data**) identify data edited by the depicted user. Blue boxes (**Synced Data**) identify data received through Git from the other collaborator.

| Diagram component | Role in GiTex |
| --- | --- |
| **Git Bare Repository** | The shared remote, hosted as a bare repository or on a Git hosting service such as GitHub. Each user has a local working copy. |
| **Main Branch** | The paper's regular branch, such as `main`, containing LaTeX sources, bibliography files, and figures. Paper commits, pulls, pushes, and merges use ordinary Git or VS Code Source Control. |
| **GiTex Branch** | The reserved remote branch `gitex-comments` (`refs/heads/gitex-comments`). It stores immutable events for comments, replies, edits, location changes, and resolved states. Local review history lives in `refs/gitex/comments`. |

The collaboration cycle in the diagram works as follows:

1. **Write and share the paper.** User A edits the LaTeX document locally, commits it, and pushes the paper branch.
2. **Review the shared text.** User B pulls the paper changes and adds a GiTex comment to the relevant passage, such as the typo on line 14.
3. **Share review events.** Saving the comment first records it locally. With automatic sync enabled, GiTex then fetches and combines remote review events and pushes the combined history to `gitex-comments` in the background.
4. **Revise and repeat.** User A uses the **Sync Comments** button in Explorer's **GiTex Comments** view to receive shared reviews, checks the anchored passages, and revises the paper. Replies, edits, and resolved states remain in review history while paper revisions continue through the regular branch.

The diagram's **“Sync comments on refresh”** means that a user explicitly refreshes shared reviews from the **GiTex Comments** view in Explorer. Its **Sync Comments** toolbar button receives remote reviews and publishes local review events. The separate **Refresh Comments** button reloads local data; **Fetch Comments** is also available as a command to receive remote reviews without publishing.

Automatic sync runs once after saving a comment, reply, edit, or manual location move. See [Automatic sync after saving](#automatic-sync-after-saving) for the setting and exact triggers. The dotted review-request arrow represents coordination between collaborators, rather than a built-in notification or approval service.

## Installation and usage

You need VS Code 1.90 or later, Git, and a local paper repository. Compiling LaTeX also requires your usual LaTeX extension and TeX distribution.

1. Run **Extensions: Install from VSIX…** from the VS Code Command Palette and select `gitex-0.11.0.vsix`.
2. Open your local paper repository or a parent folder containing several repositories, then select a paper file. To clone a repository, run **GiTex: Clone Repository**. To use the folder already open in VS Code, run **GiTex: Apply Repository to Current Folder**.
3. Configure your Git author name and email if you have not already done so:

   ```sh
   git config user.name "Your Name"
   git config user.email "you@example.com"
   ```

4. GiTex uses `origin` by default. Run **GiTex: Connect Repository** to choose another remote or add one.
5. Select lines in a paper file and press **Ctrl+Shift+/** (**Cmd+Shift+/** on macOS) to enter a comment. With no selection, the comment applies to the current line. You can also use **GiTex: Add Line Comment** in the editor context menu or the comment button in the editor gutter. Empty or whitespace-only lines have no new-comment gutter button, and an entirely blank selection is rejected before the input opens. Select at least one line containing text.
6. Saving a comment, reply, or edit automatically syncs reviews in the background. Use **GiTex: Fetch Comments** to receive reviews without publishing, or **GiTex: Sync Comments** to receive and publish manually.
7. Commit and synchronize changes to the paper itself through Source Control.

Expanded inline threads also have a **Sync** button beside **Reply**. It performs the same pull + push as Explorer's **Sync Comments**, synchronizing all saved review events in that thread's repository, even when automatic sync is disabled. To protect unsent replies, this button is enabled only while the reply field is empty; you can use Explorer's **Sync Comments** while drafting a reply.

You can comment on unsaved edits as long as the file already exists on disk. If a collaborator has not received the commented passage yet, its thread appears as Uncertain or Outdated, with the original excerpt available. Initial selections cover whole source lines; tracking can retain a narrower logical range within those lines.

The shortcut applies when the text editor has focus in an editable local `.tex`, `.bib`, `.sty`, `.cls`, or `.ltx` file. To customize it, search for `GiTex: Add Line Comment` in VS Code's Keyboard Shortcuts.

Network authentication uses Git's SSH agent or HTTPS credential helper. Check that `git ls-remote origin` succeeds in a terminal in the same environment. You need permission to read and write the remote `gitex-comments` branch.

## Selecting a repository by file

GiTex searches every local workspace folder recursively, including nested repositories. The workspace folder itself does not need to be a Git repository. For example, opening `papers/` is enough to work with both `papers/project-a/main.tex` and `papers/group/project-b/main.tex`; select a file to use its repository. The nearest enclosing Git working tree wins, so a submodule or nested repository keeps its own review data. Worktrees with a `.git` file are also recognized.

**GiTex Comments** lists all threads in the selected file's repository, including resolved and outdated threads. Its heading identifies the repository. Inline comments, the status count, **Connect Repository**, **Fetch Comments**, and **Sync Comments** follow the same selection. Selecting a file outside a workspace Git working tree clears the comment list. Moving focus into Explorer or the review tab retains the source selection; opening GiTex history retains the corresponding repository.

The existing review tab keeps the thread you opened, with its repository shown above the comments. Selecting another thread reuses that tab. Drafts and pending saves stay bound to their original repository when you switch files, and switching alone never fetches or pushes comments. Settings such as `gitex.remote` and `gitex.autoSyncOnSave` are inherited from the containing workspace folder; nested repositories in that folder share those settings.

Discovery skips Git internals, bare repository storage, temporary GiTex imports, and directory symlinks. It does not stop at the first repository. Opening a repository subfolder still recognizes its enclosing repository without scanning outside the opened folder. Scans are cached during editing; file switches check ownership with Git, and workspace or `.git` changes trigger another scan. Use **GiTex: Refresh Comments** to rescan manually if an external clone or removal is missed by filesystem notifications.

## Editing comments and viewing history

Use **Edit Comment** on an inline comment or reply, change its text, then select **Save Edit**. **Cancel Edit** discards the draft. The thread displays the latest saved text with an **Edited** label. **View Edit History** opens a read-only document containing the original text, every revision, and the editor and timestamp for each version.

If an inline save fails, GiTex opens the review panel with your unsaved draft so you can recover it even though VS Code has closed the inline input.

Click a thread in **GiTex Comments**, or choose **Open GiTex Review** from an inline thread, to open the review panel. Selecting another thread replaces the content of the same tab; switching back restores its unsaved edit/reply drafts and expanded sections while the tab remains open. It supports editing, replies, and expandable **History** sections. **Open source** returns to the associated passage; **Open saved excerpt** opens the saved text when the location is outdated. Comment deletion is not provided.

Edits are saved locally as new immutable events, then automatically synchronized when enabled. **Sync Comments** is also available manually. If a remote change arrives while you are editing, your draft stays intact. Saving against an outdated version is rejected: review the history, then cancel and edit the latest version. Concurrent edits created offline are both retained in history; logical clock and event ID determine which version is displayed. All collaborators should upgrade to GiTex 0.2.0 or later before sharing edits, because earlier versions cannot read edit events. Existing comments remain readable in 0.11.0. Upgrade all collaborators to 0.5.0 before sharing manual moves; earlier versions cannot read move events.

## Review panel layout

The review panel follows VS Code's light, dark, and high-contrast themes and adapts to narrow editor splits. The top card shows the repository, source path, current line range, and attachment status. **Saved reference** expands the passage used for tracking; it is a saved snapshot, so it may differ from a passage matched after recent edits. Source navigation, manual movement, and the **Resolved** checkbox sit together beneath it.

Each comment shows its author, timestamp, and edited marker. Edit history and tracking history open on demand, with the newest entries first and the current version marked. On wider panels, manual moves show the previous and new references side by side. Switching threads preserves drafts, expanded sections, and scroll position while the tab stays open.

Use **Ctrl+Enter** (**Cmd+Enter** on macOS) inside a reply or edit field to save, or use its save button. Empty replies are disabled; **Saving…** prevents duplicate submissions while the local save is pending. The sync indicator distinguishes automatic sync on save, manual sync, and sync failures. Expand it for details. Opening or expanding these controls does not access the remote.

## Resolve and reopen

Check **Resolved** in the review panel, or the checkbox beside a thread in **GiTex Comments**, to hide that thread from the LaTeX editor. It remains in Explorer with its history and can still be reviewed. Uncheck it to show the editor comment again when its passage can be located. Inline **Resolve Thread** and **Reopen Thread** commands use the same state.

Resolving a thread with an unsaved inline edit keeps the draft recoverable in the review panel. The old `gitex.showResolved` setting is deprecated and no longer filters either view: resolved threads always stay in Explorer and never show inline. A resolve/reopen change is saved locally and shared on the next comment save or manual **Sync Comments**, preserving the save-only automatic-sync rule.

## Tracking through text edits

See [Anchor tracking design and implementation](docs/anchor-tracking.md) for the matching algorithm, saved/local references, estimates, display rules, and compatibility details.

New tracking references save the selected lines and one preceding and one following sentence in the optional `sentenceContext` field. Sentences can span multiple lines; whitespace and CRLF are normalized. Context does not require final punctuation: a nearby paragraph or file boundary also ends a valid excerpt, so `랄랄루` after a selected `헬로` is retained. A fragment clipped by the 64-line search window is still excluded. Short excerpts can estimate a missing passage when an exact, unambiguous pair of surrounding contexts survives; a short fragment alone remains insufficient. Blank lines are skipped to find the next available sentence within 64 lines on each side. Named LaTeX headings such as `\section*{작은 생각}` can also supply context; stars, optional short titles, nested formatting, and trailing labels are supported. Heading comparisons use their titles, not the shared command syntax. Bare structural commands such as `\begin`/`\end` and LaTeX comments are excluded. Extraction skips oversized blocks and stores at most 4,096 characters per context. Unavailable context stays empty. The existing `before`/`after` fields still retain up to three lines each.

GiTex 0.9.0 keeps two references:

| Reference | When it changes | Where it lives |
| --- | --- | --- |
| **Saved reference** | Creating a comment, saving a reply/edit eligible for reference renewal, or manually moving the thread. | Immutable Git review events, shared with collaborators and retained in **Tracking history**. |
| **Local context** | Editing the source while the Attached passage also meets the stricter renewal rules below. It captures the logical passage and surrounding context. | VS Code workspace storage for this local repository; never pushed through Git. Unsaved source changes update session memory only. Saving the source persists the last reliable reference for later sessions. |

Tracking checks both references. Local context can recover a passage or estimate its location after the shared text or surroundings no longer match; these results show **Local context** in the review panel, Explorer, and inline caption. When shared and local references point to disjoint positions, GiTex retains both as **Uncertain** candidates instead of hiding the thread as Outdated. Both positions are marked as **Saved reference candidate** or **Local context candidate**. Overlapping estimates remain a single result; the stronger result wins, with recent local spacing breaking ties. **Uncertain** and **Outdated** results never replace the last reliable local reference. A new shared reference, including a manual move, invalidates local hints based on the previous revision. Expand **Saved reference** and **Local context** in the review panel to compare them. Local context is a replaceable hint, not an additional shared history entry; source editing does not create review events or trigger sync.

Final passages also store an optional `afterBoundary`: **End of document** for `\end{document}`, or **End of file** when no document terminator is present. Blank lines, comments, and closing environment/label lines can precede that boundary. Text after `\end{document}` is excluded from following-sentence context. If the passage disappears, a distinctive preceding context plus the nearby saved end boundary can produce **Uncertain**, even without a following sentence. The end boundary alone is insufficient, and a saved document terminator must still be present.

GiTex tries exact text, then whitespace-normalized and similar text, then surrounding context alone. For ordinary passages, attachment requires at least 74% text similarity with supporting context, or 86% without it. Short passages use stricter thresholds. These are text comparisons, not semantic matching.

**Attached does not automatically authorize a reference update.** Since 0.11.0, creation or the last explicit manual move establishes a fixed identity. Every local or shared renewal compares directly with that identity, even after repeated comment saves or restarts. Exact normalized identity matches may refresh context. Otherwise, renewal requires at least 90% similarity to the fixed identity; changed text also needs at least 90% similarity to the previous reference and distinctive, unchanged context on both sides, or preceding context plus a saved end boundary. An unchanged previous reference can refresh context if it still passes the identity check. Short identities permit exact renewal only. A weaker attachment remains visible and comments still save, while the reference stays unchanged. Use **Move to editor selection** to confirm a substantial rewrite and establish a new identity.

When a longer candidate adds text after the original passage, GiTex aligns the entire reference with the corresponding prefix and excludes the appended suffix from similarity. Insertions, deletions, and substitutions within that prefix still count as edits. The endpoint follows the alignment rather than a fixed character count; suffix-only lines are excluded from the attached range. The physical **Source Range** remains line-based, while the **Logical Anchor Range** preserves the owned text and its optional UTF-16 columns. When `A` becomes `A′ + B` on one line, an eligible renewal stores only `A′`, excluding `B` from both local and shared reference text. Same-line suffix text can become following context. Ambiguous copies still require distinguishing context. The same prefix comparison helps match distinctive prose context; short context and LaTeX headings retain their stricter rules.

| Tracking result | Meaning | Display |
| --- | --- | --- |
| **Attached** | The original passage is found exactly or with sufficient similarity. | Normal inline comment; approximate matches show **Similar text**. |
| **Uncertain** | The passage cannot be matched, but a context pair, a saved end boundary with preceding context, or one unique identifying context with saved spacing provides an estimated location. | A muted marker on an existing candidate line, or an unnumbered virtual row for a missing line. Diverging saved/local candidates are both shown; Explorer retains one thread. |
| **Outdated** | Neither identity nor location can be determined reliably. | Listed in Explorer without a source marker. |

Context-only tracking first looks for a unique ordered pair with a small intervening gap. Short contexts require exact text matches (allowing terminal punctuation changes); stronger contexts also tolerate small edits and rewrapping. A preceding heading plus short following prose can be enough. Blank lines do not count as intervening prose, and saved relative spacing helps place the marker within the estimated interval. When one side disappears, one unique identifying context can retain a lower-confidence estimate if its distance from the passage was saved. Repeated LaTeX structures, heading-only pairs, reversed or distant context pairs, and ambiguous candidates remain unresolved. A saved end boundary can also support identifying preceding context. The returned `confidence` is a heuristic score, not a calibrated probability. `Uncertain` and its estimated line are computed from the current document; they are never saved as permanent thread states.

Hover over the dashed marker to see the saved reference and open the review tab. The review tab labels the estimated location, expands **Saved reference**, and offers **Open estimated location**. **Surrounding sentences** and **Tracking history** show the saved context. To confirm a new target, select its source lines and use **Move to editor selection**; this records a manual move with the old and new references. Resolved threads remain hidden in the source editor in every tracking state.

Saving an edit or reply renews the shared reference only when the Attached passage passes the stricter renewal policy. The snapshot includes the logical text and bounds, physical source lines, surrounding sentences, end boundary, and document hash, including eligible unsaved source edits. Opening a comment, typing in the paper, resolving, or canceling an edit does not rewrite the shared reference. Weaker attachments, **Uncertain**, and **Outdated** keep the previous reference while allowing comment edits and replies to save. An estimated location becomes a new shared reference only through an explicit move or a later eligible comment save.

The optional `logicalRange` field and fixed identity reconstructed from existing events require no migration. Existing snapshots remain unchanged. Older clients can read the event format but do not enforce logical bounds or drift protection; use **GiTex 0.11.0 or later** across collaborators. If a previous version already expanded or drifted a reference, confirm the intended target with a manual move.

Existing review events need no migration. Legacy anchors continue using their saved three-line context, including conservative context-only estimates when that context is sufficient. Opening or syncing old reviews never rewrites their history. Their next eligible comment save or manual move adds sentence context while preserving the old reference. The event format stays at version 1, and older clients can read the optional field but do not display the new tracking state; use GiTex 0.8.0 or later for this behavior.

Starting in 0.8.1, empty sentence fields from 0.8.0 also fall back to available saved line context, including named headings. Context that was never saved cannot be reconstructed from the current document; save a comment while attached or manually reconnect it to capture the improved context.

Version 0.9.0 also recognizes a document terminator already present in legacy saved line context without rewriting that event. Older data lacking a saved boundary remains valid; a reliable attached match can establish local context, and the next eligible comment save or manual move can add the boundary to the shared reference. The event format remains version 1. Older clients can read the optional boundary field, but local tracking and end-boundary estimates require 0.9.0 or later.

The review panel's **Tracking history** shows the original passage and later reference snapshots with authors and timestamps. Each snapshot is part of the same immutable event as the saved edit/reply and is shared with comments. Concurrent updates preserve both snapshots and choose the current one deterministically. A failed or stale comment save cannot change its reference.

In 0.9.1, previously empty sentence fields can gain unpunctuated context in **Local context** when the passage is reliably attached. Existing **Saved reference** snapshots and history stay unchanged; save an eligible comment/reply or move it manually to renew the shared reference.

Version 0.9.2 favors **Uncertain** whenever usable localization evidence remains. LaTeX line wrapping still combines `랄랄루` and `랄랄라.` into `랄랄루 랄랄라.`; an older saved `랄랄루` can match the beginning of that extended context. Removing a commented `헬로` between a unique heading and this following text therefore keeps an estimated marker. Estimates never become new shared or local reference snapshots automatically.

Version 0.10.1 shows missing-line estimates as **Uncertain · Estimated passage** rows above the following source line using [VS Code CodeLens](https://code.visualstudio.com/api/language-extensions/programmatic-language-features#codelens---show-actionable-context-information-within-source-code). These rows preview the saved passage, have no source line number, and do not modify the file, line count, dirty state, Git history, or LaTeX output. Existing blank or replacement lines still use ordinary candidate markers. Keep VS Code's `editor.codeLens` enabled to see virtual rows; the inline review remains available if it is disabled. At the physical end of a file without a following line, the CodeLens sits above the last line and explicitly says **After final line**; the comment widget sits below that line.

If saved and local references disagree, both markers open the same review tab and share one comment, draft, and history. The review lists both candidates with **Open saved candidate** and **Open local candidate** navigation. Exploring them never confirms either location or renews an anchor. Use **Move to editor selection** to confirm the intended passage and record the move; resolving hides both markers and reopening restores them. The candidates and virtual rows are derived from the current document, so existing review data needs no migration.

## Move a comment manually

1. Select the destination lines in a visible `.tex`, `.bib`, `.sty`, `.cls`, or `.ltx` editor. With no selection, GiTex uses the cursor line. The file must exist on disk; unsaved edits in it are supported.
2. Open the thread in **GiTex Comments**, then click **Move to editor selection** in the review panel. You can also select **GiTex: Move Comment to Selection** from the thread's Explorer context menu or inline thread toolbar.
3. Alternatively, run **GiTex: Move Comment to Selection** from the Command Palette or the editor context menu and choose the thread to move.

The entire thread, including its replies, moves to the chosen range. You can reattach **Uncertain** or **Outdated** threads or move between source files in the same repository. Its ID, comment text, edit history, and resolved state stay intact. Resolved threads remain hidden in the paper editor after moving. Save or cancel an inline comment edit before moving; review-panel drafts are retained.

Every successful move is a separate immutable event, including repeated moves to the same destination. **Tracking history** labels it **Manual move** and shows the previous tracking reference and new file, line range, source text, author, and timestamp. The new location becomes the matching reference for subsequent automatic tracking. Location moves are comment edits for synchronization purposes: they trigger one background pull + push when `gitex.autoSyncOnSave` is enabled, and remain local when disabled.

If the destination text or known comment location changes during selection, the move is rejected so you can select it again. Concurrent offline moves retain both before/after records and choose a current location deterministically. Automatic tracking snapshots from a previous manual location are kept in history without moving the comment back. **Current reference** identifies the active location, which can differ from the final history entry.

All collaborators must use **GiTex 0.5.0 or later** before sharing manual moves. Existing comments and tracking history continue to work without migration.

## Automatic sync after saving

`gitex.autoSyncOnSave` defaults to `true`. A successful new comment, reply, edit, or manual location move triggers one background **pull + push** of review data, after the local save is displayed. Opening, clicking, expanding, focusing, viewing history, starting or canceling an edit, and resolving/reopening a thread do not trigger network requests. **Refresh Comments** only reloads local data. There is no polling.

A sync also publishes previously saved local review events, including resolve/reopen changes. The paper branch, working files, and staging area are unaffected. Concurrent remote edits remain in history; an outdated draft is rejected if a newer revision has already been received locally. Otherwise, edits made before receiving a remote revision are combined as concurrent edits during sync.

If the network fails, the comment stays saved locally. The review panel and status bar indicate pending synchronization, and GiTex Output records the error. The next successful save or **Sync Comments** can retry.

Disable automatic sync in **GiTex: Auto Sync On Save**, or add:

```json
{
  "gitex.autoSyncOnSave": false
}
```

**GiTex: Fetch Comments** and **GiTex: Sync Comments** remain available regardless of this setting. The old `gitex.autoPullOnInteraction` setting is deprecated: interactions never fetch now. An explicit old `false` value keeps automatic sync disabled until you explicitly set `gitex.autoSyncOnSave`.

## Apply a repository to the current folder

Open the destination folder, then run **GiTex: Apply Repository to Current Folder** and enter an SSH/HTTPS URL or local bare repository path. In a multi-folder workspace, GiTex uses the active editor's folder or asks you to select one. Relative local paths are resolved from that folder.

GiTex creates `.git` directly in the folder, checks out the remote default branch's latest fetched commit, and configures `origin` and branch tracking. It does not create an extra project subfolder. Afterwards, use Source Control for paper changes and **Fetch Comments** to receive existing reviews.

The remote is checked in a temporary checkout before applying it. Unrelated existing files are retained as local files; shared directories are allowed when their contents do not overlap. Any existing file at an incoming path blocks the operation, even if its contents match. File/directory conflicts, symlink ancestors, an existing `.git`, a folder inside another Git repository, or unsaved editor files also block it. Save or move conflicting content first; this command never merges or overwrites it.

This command currently requires a default paper branch with a commit and regular files. For repositories with symlinks or submodules, use **Clone Repository**. Import requires a filesystem supporting hard links; exclusive file creation prevents overwriting a file created during import. Failed application rolls back its additions while retaining files changed concurrently by the user.

## Try it with two users

Run this example in a new local directory:

```sh
git init --bare --initial-branch=main paper.git
git clone paper.git alice
cd alice
git config user.name Alice
git config user.email alice@example.test
printf '\\documentclass{article}\n\\begin{document}\nHello, GiTex.\n\\end{document}\n' > main.tex
git add main.tex
git commit -m "Initial paper"
git push -u origin main
cd ..
git clone paper.git bob
git -C bob config user.name Bob
git -C bob config user.email bob@example.test
```

Open `alice` and `bob` in separate VS Code windows with GiTex installed. Alice creates a comment and runs Sync Comments. Bob runs Sync Comments to see it. Replies written offline by both users are preserved when they synchronize. For remote use, expose `paper.git` through SSH or another Git transport.

## Storage and concurrent updates

| Location | Purpose |
| --- | --- |
| Regular paper branches | Paper files such as `.tex`, `.bib`, and figures |
| Local `refs/gitex/comments` | Local review history, including comments not yet shared |
| Remote `refs/heads/gitex-comments` | Shared review history; reserved for GiTex |

Thread creation, replies, edits, manual moves, and state changes are immutable events with UUIDs. Synchronization combines local and remote events, then performs a normal push. If another user publishes first, GiTex fetches, combines the events, and retries without force pushing. Updates from multiple windows sharing a local repository check the previous Git ref value to prevent overwriting one another.

Concurrent resolve and reopen events are ordered by logical clock and event ID to produce a consistent final state. Both events remain in the history. Author information comes from Git configuration; GiTex does not provide separate user authentication or signature verification.

Each comment records the base commit, local document hash, file path, line range, original passage, surrounding context, and an end boundary when applicable. The base commit is HEAD at creation time. When there are uncommitted edits, the passage may differ from the file in that commit. Matching uses the latest shared reference and a separate local reference in VS Code workspace storage. If the passage cannot be attached reliably, GiTex retains the saved excerpt and may show a context-only estimate; the original remains available in Tracking history.

Review history includes excerpts and author email addresses. Backing up only the paper branches does not include unpublished local comments: use Sync Comments to share them or back up the entire Git repository. Do not merge `gitex-comments` into a paper branch or use it as an editing branch.

## Development and verification

Use Node.js 22 or later and npm. The Makefile commands below also require GNU Make. The extension has no runtime npm dependencies.

```sh
make install
make package
```

Run these commands from the project root to generate a VSIX for the current version, such as `gitex-0.11.0.vsix`. Run `make` or `make help` to list the available targets.

| Make command | Action |
| --- | --- |
| `make install` | Install development dependencies with `npm ci`; run on initial setup and after dependency changes |
| `make build` | Compile TypeScript with `npm run compile` |
| `make watch` | Recompile on file changes with `npm run watch`; stop with Ctrl+C |
| `make test` | Compile and run core tests with `npm test` |
| `make test-extension` | Run tests in VS Code with `npm run test:extension` |
| `make package` | Compile and create a VSIX with `npm run package` |
| `make clean` | Remove `out/` and root-level `gitex-*.vsix` files; retain dependencies and the VS Code test cache |

Make delegates to the existing npm scripts. You can run the npm commands in the table directly if Make is unavailable.

Open this project in VS Code and press **F5 → Run GiTex Extension** to launch a separate Extension Development Host. Open your paper repository in that window.

```sh
make test
make test-extension
```

`make test-extension` uses the official test tools to download VS Code 1.90.2 and run the extension with a temporary repository and profile. On Linux CI, provide an X server or use `xvfb-run -a make test-extension`. Use `GITEX_VSCODE_VERSION=stable make test-extension` to run against the current stable release. `make package` downloads the official `vsce` tool and produces a VSIX; it does not publish to the Marketplace.

Core tests cover concurrent pushes and edits, complete edit history, outdated drafts, pull without publishing, local updates from multiple windows, offline persistence, server rejection, metadata branch collisions, working tree and index preservation, and moved, edited, rewrapped, deleted, or repeated passages, plus concurrent tracking-reference updates and manual moves with complete before/after history. Extension host tests also use Playwright against the test instance's local debugging port to verify actual review-panel clicks, expansion, editing, resolved visibility, replacement of the shared review tab, draft preservation, tracking-reference renewal, manual cross-file relocation, save-only automatic pull/push, disabled settings, and unsaved-file protection during repository import. Repository tests cover path conflicts, concurrent file creation, rollback, and preserving unrelated files.

Discovery tests cover deep and nested repositories, overlapping workspace folders, worktree/submodule `.git` files, and skipped metadata, bare storage, temporary imports, and symlink cycles. Extension tests verify automatic switching from the active editor, repository-specific sync, retained drafts, and detection after repository creation/removal.

## Current scope

- Reviews sync automatically after saving by default, or through manual commands. Live collaborative typing and automatic server notifications are not implemented.
- Comments appear on LaTeX source. PDF annotations, semantic sentence analysis, and LaTeX compilation checks are not implemented.
- Renamed files are not migrated automatically; use Move Comment to Selection to reattach their threads. Edits with insufficient similarity or ambiguous matches require manual review.
- Comment deletion and fine-grained permissions are not implemented. Users with repository write access can share edits, replies, and thread state changes. Original authorship and the editor of each revision are recorded separately.
- Multiple workspace folders, recursively discovered nested repositories, worktrees, and submodules are supported. The selected file chooses the repository; bare storage has no editable working tree.
- This prototype combines events in memory and caps the combined output of each Git command at 32 MiB. Large-history optimization is future work.
- Paper merges use existing Git features. Server-side merge approval and execution are not implemented.

Underlying APIs: [VS Code Comments API](https://code.visualstudio.com/api/references/vscode-api#CommentController), [Git update-ref](https://git-scm.com/docs/git-update-ref), [VSIX packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
