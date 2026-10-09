# GiTex

English | [한국어](README.kr.md)

A VS Code extension for sharing line comments on LaTeX papers through Git. Use it alongside your existing editing, compilation, and PDF preview setup, including LaTeX Workshop.

## Features

- Open or clone a Git repository, or apply one directly to the current folder when no existing paths conflict.
- Select or add a remote for sharing comments.
- Comment on one or more lines in `.tex`, `.bib`, `.sty`, `.cls`, and `.ltx` files.
- Reply to comments and resolve or reopen threads inside the editor.
- Edit comments and replies while preserving the original text and every edit in history.
- Automatically pull and push comments once after creating a comment, replying, or saving an edit; enabled by default and configurable.
- Browse threads in **GiTex Comments** in the Explorer and VS Code's **Comments** panel.
- Follow the original passage when edits move it to different line numbers.
- Preserve the original excerpt and mark comments **Outdated** when their passage changes or disappears.
- Save comments offline and synchronize reviews from multiple users through a central bare repository.

Use VS Code's **Source Control** for paper commits, push/pull, and merges. **Sync Comments** and automatic sync after saving both receive and publish review data. They leave your working files, current branch, and staging area unchanged.

## Installation and usage

You need VS Code 1.90 or later, Git, and a local paper repository. Compiling LaTeX also requires your usual LaTeX extension and TeX distribution.

1. Run **Extensions: Install from VSIX…** from the VS Code Command Palette and select `gitex-0.3.0.vsix`.
2. Open your local paper repository. To clone a repository, run **GiTex: Clone Repository**. To use the folder already open in VS Code, run **GiTex: Apply Repository to Current Folder**.
3. Configure your Git author name and email if you have not already done so:

   ```sh
   git config user.name "Your Name"
   git config user.email "you@example.com"
   ```

4. GiTex uses `origin` by default. Run **GiTex: Connect Repository** to choose another remote or add one.
5. Select lines in a paper file and press **Ctrl+Shift+/** (**Cmd+Shift+/** on macOS) to enter a comment. With no selection, the comment applies to the current line. You can also use **GiTex: Add Line Comment** in the editor context menu or the comment button in the editor gutter.
6. Saving a comment, reply, or edit automatically syncs reviews in the background. Use **GiTex: Fetch Comments** to receive reviews without publishing, or **GiTex: Sync Comments** to receive and publish manually.
7. Commit and synchronize changes to the paper itself through Source Control.

You can comment on unsaved edits as long as the file already exists on disk. If a collaborator has not received the commented passage yet, its thread appears as Outdated with the original excerpt available. Selections are stored as whole-line ranges.

The shortcut applies when the text editor has focus in an editable local `.tex`, `.bib`, `.sty`, `.cls`, or `.ltx` file. To customize it, search for `GiTex: Add Line Comment` in VS Code's Keyboard Shortcuts.

Network authentication uses Git's SSH agent or HTTPS credential helper. Check that `git ls-remote origin` succeeds in a terminal in the same environment. You need permission to read and write the remote `gitex-comments` branch.

## Editing comments and viewing history

Use **Edit Comment** on an inline comment or reply, change its text, then select **Save Edit**. **Cancel Edit** discards the draft. The thread displays the latest saved text with an **Edited** label. **View Edit History** opens a read-only document containing the original text, every revision, and the editor and timestamp for each version.

If an inline save fails, GiTex opens the review panel with your unsaved draft so you can recover it even though VS Code has closed the inline input.

Click a thread in **GiTex Comments**, or choose **Open GiTex Review** from an inline thread, to open the review panel. It supports editing, replies, and expandable **History** sections. **Open source / original excerpt** returns to the associated passage. Comment deletion is not provided.

Edits are saved locally as new immutable events, then automatically synchronized when enabled. **Sync Comments** is also available manually. If a remote change arrives while you are editing, your draft stays intact. Saving against an outdated version is rejected: review the history, then cancel and edit the latest version. Concurrent edits created offline are both retained in history; logical clock and event ID determine which version is displayed. All collaborators should upgrade to GiTex 0.2.0 or later before sharing edits, because earlier versions cannot read edit events. Existing comments remain readable in 0.3.0.

## Automatic sync after saving

`gitex.autoSyncOnSave` defaults to `true`. A successful new comment, reply, or edit save triggers one background **pull + push** of review data, after the local save is displayed. Opening, clicking, expanding, focusing, viewing history, starting or canceling an edit, and resolving/reopening a thread do not trigger network requests. **Refresh Comments** only reloads local data. There is no polling.

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

Thread creation, replies, edits, and state changes are immutable events with UUIDs. Synchronization combines local and remote events, then performs a normal push. If another user publishes first, GiTex fetches, combines the events, and retries without force pushing. Updates from multiple windows sharing a local repository check the previous Git ref value to prevent overwriting one another.

Concurrent resolve and reopen events are ordered by logical clock and event ID to produce a consistent final state. Both events remain in the history. Author information comes from Git configuration; GiTex does not provide separate user authentication or signature verification.

Each comment records the base commit, local document hash, file path, line range, original passage, and surrounding context. The base commit is HEAD at creation time. When there are uncommitted edits, the passage may differ from the file in that commit. If the original text changes, disappears, or matches multiple locations equally well, GiTex preserves the original excerpt instead of guessing a location.

Review history includes excerpts and author email addresses. Backing up only the paper branches does not include unpublished local comments: use Sync Comments to share them or back up the entire Git repository. Do not merge `gitex-comments` into a paper branch or use it as an editing branch.

## Development and verification

Use Node.js 22 or later and npm. The Makefile commands below also require GNU Make. The extension has no runtime npm dependencies.

```sh
make install
make package
```

Run these commands from the project root to generate a VSIX for the current version, such as `gitex-0.3.0.vsix`. Run `make` or `make help` to list the available targets.

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

Core tests cover concurrent pushes and edits, complete edit history, outdated drafts, pull without publishing, local updates from multiple windows, offline persistence, server rejection, metadata branch collisions, working tree and index preservation, and moved, deleted, or repeated passages. Extension host tests also use Playwright against the test instance's local debugging port to verify actual review-panel clicks, expansion, editing, draft preservation, save-only automatic pull/push, disabled settings, and unsaved-file protection during repository import. Repository tests cover path conflicts, concurrent file creation, rollback, and preserving unrelated files.

## Current scope

- Reviews sync automatically after saving by default, or through manual commands. Live collaborative typing and automatic server notifications are not implemented.
- Comments appear on LaTeX source. PDF annotations, semantic sentence analysis, and LaTeX compilation checks are not implemented.
- Renamed files produce Outdated comments rather than automatic migration to the new path. Edited passages also require manual review.
- Comment deletion and fine-grained permissions are not implemented. Users with repository write access can share edits, replies, and thread state changes. Original authorship and the editor of each revision are recorded separately.
- Multiple workspace folders are supported, using the Git repository discovered for each folder. Open nested repositories as separate workspace folders.
- This prototype combines events in memory and caps the combined output of each Git command at 32 MiB. Large-history optimization is future work.
- Paper merges use existing Git features. Server-side merge approval and execution are not implemented.

Underlying APIs: [VS Code Comments API](https://code.visualstudio.com/api/references/vscode-api#CommentController), [Git update-ref](https://git-scm.com/docs/git-update-ref), [VSIX packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
