import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { Git } from '../../src/git';
import { ReviewStore } from '../../src/store';
import { reviewTests } from './review';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('gitex-local.gitex');
  assert.ok(extension, 'the development extension must be discoverable');
  const app = await extension.activate();
  assert.ok(extension.isActive);
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const store = new ReviewStore(root);
  assert.ok((await vscode.commands.getCommands()).includes('gitex.applyRepository'));
  const target = path.join(path.dirname(root), 'apply-target');
  await mkdir(target);
  await writeFile(path.join(target, 'notes.tex'), 'Local notes');
  const targetFolder = { uri: vscode.Uri.file(target), name: 'apply-target', index: 1 };
  const bare = await store.git.text(['remote', 'get-url', 'origin']);
  const notes = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(target, 'notes.tex')));
  const notesEditor = await vscode.window.showTextDocument(notes);
  await notesEditor.edit(edit => edit.insert(new vscode.Position(0, 0), 'Unsaved '));
  await assert.rejects(app.applyRepository(bare, targetFolder), /unsaved files/);
  assert.deepEqual(await readdir(target), ['notes.tex']);
  await notes.save();
  await app.applyRepository(bare, targetFolder);
  assert.equal(await new Git(target).ref('HEAD'), await store.head());
  assert.equal(await readFile(path.join(target, 'notes.tex'), 'utf8'), 'Unsaved Local notes');
  const repository = [...app.repositories.values()][0] as any;
  const realSync = repository.store.sync.bind(repository.store);
  let automaticSyncs = 0;
  repository.store.sync = async (remote: string) => { automaticSyncs++; return realSync(remote); };
  const settle = async () => { await Promise.all([...app.syncs.values()]); };
  const head = await store.head();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'main.tex')));
  let editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(2, 0, 2, 18);
  await vscode.commands.executeCommand('gitex.addComment', '실제 편집기에서 작성한 주석');
  await settle(); assert.equal(automaticSyncs, 1);
  let threads = await store.threads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].anchor.startLine, 2);
  assert.equal(app.getChildren().length, 1);
  assert.equal(app.getChildren()[0].location.kind, 'attached');

  // Exercise the same CommentReply payload used by VS Code's inline reply widget.
  const native = [...app.nativeThreads.values()][0] as vscode.CommentThread;
  assert.equal(native.comments.length, 1);
  assert.equal(native.contextValue, 'gitex-open');
  await vscode.commands.executeCommand('gitex.reply', { thread: native, text: 'Inline reply' });
  await settle(); assert.equal(automaticSyncs, 2);
  assert.equal((await store.threads())[0].comments.length, 2);
  await vscode.commands.executeCommand('gitex.resolve', native);
  assert.equal((await store.threads())[0].resolved, true);
  await vscode.commands.executeCommand('gitex.reopen', native);
  assert.equal((await store.threads())[0].resolved, false);
  assert.equal(automaticSyncs, 2, 'resolve/reopen do not trigger save-only auto sync');

  const gutterThread = app.controller.createCommentThread(document.uri, new vscode.Range(0, 0, 1, 0), []);
  await vscode.commands.executeCommand('gitex.reply', { thread: gutterThread, text: 'New thread from the editor gutter' });
  await settle(); assert.equal(automaticSyncs, 3);
  repository.store.sync = realSync;
  threads = await store.threads();
  assert.equal(threads.length, 2);
  assert.equal(threads[1].anchor.endLine, 1, 'Comment API ranges include the last line even at column zero');
  assert.equal(gutterThread.comments.length, 1);

  await reviewTests(app, store, native);
  editor = await vscode.window.showTextDocument(document);

  await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '% inserted paragraph\n'));
  await vscode.commands.executeCommand('gitex.refresh');
  assert.equal(app.getChildren()[0].location.startLine, 3);
  assert.equal(native.range!.start.line, 3);
  await editor.edit(edit => edit.replace(new vscode.Range(3, 0, 3, document.lineAt(3).text.length), 'The result has changed.'));
  await vscode.commands.executeCommand('gitex.refresh');
  assert.equal(app.getChildren()[0].location.kind, 'outdated');
  await vscode.commands.executeCommand('gitex.openThread', app.getChildren()[0]);
  assert.equal(vscode.window.activeTextEditor!.document.uri.scheme, 'gitex-original');
  assert.match(vscode.window.activeTextEditor!.document.getText(), /A reviewed result\./);

  await vscode.commands.executeCommand('gitex.sync');
  const published = await store.git.text(['ls-remote', '--heads', 'origin', 'refs/heads/gitex-comments']);
  assert.match(published, /refs\/heads\/gitex-comments/);
  assert.equal(await store.head(), head);
  assert.equal(document.isDirty, true, 'sync must preserve unsaved editor changes');
  console.log('GiTex extension host: applying repositories, unsaved-file protection, save-only sync, editing, history, drafts, and anchoring passed.');
}
