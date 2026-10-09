import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { chromium, Frame } from 'playwright-core';
import { Git } from '../../src/git';
import { ReviewStore, REMOTE_REF } from '../../src/store';

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function reviewTests(app: any, store: ReviewStore, thread: vscode.CommentThread): Promise<void> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.GITEX_CDP_PORT}`);
  const config = vscode.workspace.getConfiguration('gitex', vscode.workspace.workspaceFolders![0].uri);
  assert.equal(config.get('autoPullOnInteraction'), true);
  const native = thread.comments[0] as any;
  const id = native.commentId;
  const original = (await store.threads())[0].comments[0].body;
  await vscode.commands.executeCommand('gitex.editComment', native);
  assert.equal(native.mode, vscode.CommentMode.Editing);
  native.body = 'Edited from the inline widget';
  await vscode.commands.executeCommand('gitex.saveComment', native);
  assert.equal((await store.threads())[0].comments[0].body, 'Edited from the inline widget');
  assert.equal(native.mode, vscode.CommentMode.Preview);
  assert.match(native.label, /Edited/);
  await vscode.commands.executeCommand('gitex.commentHistory', native);
  const history = vscode.window.activeTextEditor!.document.getText();
  assert.ok(history.includes(original));
  assert.ok(history.includes('Edited from the inline widget'));
  const reply = thread.comments[1] as any;
  await vscode.commands.executeCommand('gitex.editComment', reply);
  reply.body = 'Canceled reply edit';
  await vscode.commands.executeCommand('gitex.cancelEdit', reply);
  assert.equal((await store.threads())[0].comments[1].body, 'Inline reply');
  await store.sync();

  const bare = await store.git.text(['remote', 'get-url', 'origin']);
  const peerPath = path.join(path.dirname(store.root), 'peer');
  await new Git(path.dirname(store.root)).text(['clone', bare, peerPath]);
  const peer = new ReviewStore(peerPath);
  await peer.git.text(['config', 'user.name', 'Remote Reviewer']);
  await peer.git.text(['config', 'user.email', 'remote@example.test']);
  await peer.pull();
  const repository = app.getChildren()[0].repository;
  const rootComment = async (source: ReviewStore) => (await source.threads()).find(review => review.id === id)!.comments[0];
  const remoteEdit = async (body: string) => {
    const current = await rootComment(peer);
    await peer.edit(id, id, body, current.revisions.at(-1)!.id);
    await peer.sync();
  };
  await vscode.commands.executeCommand('gitex.editComment', native);
  native.body = 'My unsaved draft';
  await remoteEdit('Changed while editing');
  await app.autoPull(repository);
  assert.equal(native.body, 'My unsaved draft');
  assert.equal(native.mode, vscode.CommentMode.Editing);
  await assert.rejects(app.saveComment(native), /changed while you were editing/);
  assert.equal(native.mode, vscode.CommentMode.Preview);
  assert.equal((await rootComment(store)).body, 'Changed while editing');

  // Several events from one gesture share the in-flight fetch rather than queueing network requests.
  const realPull = repository.store.pull.bind(repository.store);
  let fetches = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  repository.store.pull = async (remote: string) => { fetches++; await barrier; return realPull(remote); };
  const first = app.autoPull(repository);
  const second = app.autoPull(repository);
  release();
  await Promise.all([first, second]);
  assert.equal(fetches, 1);
  repository.store.pull = async (remote: string) => { fetches++; return realPull(remote); };

  await config.update('autoPullOnInteraction', false, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.commands.executeCommand('gitex.reviewThread', app.getChildren()[0]);
  let frame: Frame | undefined;
  await until(async () => {
    for (const page of browser.contexts()[0].pages()) {
      for (const candidate of page.frames()) {
        if (await candidate.locator('#comments').count().catch(() => 0)) { frame = candidate; return true; }
      }
    }
    return false;
  }, 'GiTex review webview');
  const view = frame!;
  await until(async () => await view.locator('#comments > details').count() > 0, 'rendered review');
  assert.equal(await view.locator('#comments textarea').first().inputValue(), 'My unsaved draft', 'rejected inline saves must keep a usable draft');
  await view.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  const summary = view.locator('#comments > details > summary').first();
  const stopped = fetches;
  await summary.click();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(fetches, stopped, 'disabled interaction fetching must not access the remote');
  await remoteEdit('Fetched by expanding a comment');
  const remoteTip = await new Git(bare).ref(REMOTE_REF);
  await config.update('autoPullOnInteraction', true, vscode.ConfigurationTarget.WorkspaceFolder);
  await summary.click();
  await until(async () => (await rootComment(store)).body === 'Fetched by expanding a comment', 'fetch on expansion');
  assert.equal(await new Git(bare).ref(REMOTE_REF), remoteTip, 'interacting must not push');
  await until(async () => (await view.locator('.body').first().textContent()) === 'Fetched by expanding a comment', 'latest body');
  const beforeClick = fetches;
  await view.locator('.body').first().click();
  await until(async () => fetches > beforeClick, 'fetch on body click');
  await Promise.all([...app.pulls.values()]);

  const firstComment = view.locator('#comments > details').first();
  await firstComment.getByRole('button', { name: 'Edit', exact: true }).click();
  const draft = firstComment.locator('textarea');
  await draft.fill('Panel draft survives remote changes');
  await Promise.all([...app.pulls.values()]);
  await remoteEdit('New remote panel version');
  await view.locator('h1').click();
  await until(async () => (await view.locator('.body').first().textContent()) === 'New remote panel version', 'panel refresh');
  assert.equal(await draft.inputValue(), 'Panel draft survives remote changes');
  await firstComment.getByRole('button', { name: 'Save edit locally' }).click();
  await until(async () => (await view.locator('#error').textContent())!.includes('changed while'), 'stale edit feedback');
  assert.equal(await draft.inputValue(), 'Panel draft survives remote changes');
  await firstComment.getByRole('button', { name: 'Cancel', exact: true }).click();
  await firstComment.getByRole('button', { name: 'Edit', exact: true }).click();
  await draft.fill('Saved through the review panel');
  await firstComment.getByRole('button', { name: 'Save edit locally' }).click();
  await until(async () => (await rootComment(store)).body === 'Saved through the review panel', 'panel edit save');
  const historyToggle = firstComment.locator('details > summary');
  await historyToggle.click();
  await until(async () => (await firstComment.locator('pre').allTextContents()).includes(original), 'original history entry');
  assert.ok((await firstComment.locator('pre').allTextContents()).includes('Saved through the review panel'));

  await Promise.all([...app.pulls.values()]);
  await config.update('autoPullOnInteraction', false, vscode.ConfigurationTarget.WorkspaceFolder);
  await peer.reply(id, 'Visible after manual fetch'); await peer.sync();
  const disabledCount = fetches;
  await view.locator('h1').click();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(fetches, disabledCount);
  assert.ok(!(await store.threads())[0].comments.some(comment => comment.body === 'Visible after manual fetch'));
  await vscode.commands.executeCommand('gitex.pull');
  assert.ok((await store.threads())[0].comments.some(comment => comment.body === 'Visible after manual fetch'));

  await config.update('remote', 'nonexistent', vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update('autoPullOnInteraction', true, vscode.ConfigurationTarget.WorkspaceFolder);
  await view.locator('h1').click();
  await until(async () => (await view.locator('#status').textContent())!.includes('Remote fetch failed'), 'offline feedback');
  assert.ok((await rootComment(store)).revisions.some(revision => revision.body === 'Saved through the review panel'));
  await config.update('remote', 'origin', vscode.ConfigurationTarget.WorkspaceFolder);
  for (const panel of app.panels.values()) { panel.dispose(); }
  await browser.close();
  repository.store.pull = realPull;
  console.log('GiTex review tests: native editing, history, stale drafts, actual webview clicks/expansion, no push, disabled fetch, and offline preservation passed.');
}
