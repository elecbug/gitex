import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { chromium, Frame } from 'playwright-core';
import { Git } from '../../src/git';
import { ReviewStore, REMOTE_REF } from '../reviewStore';
import { reviewAppearance } from './appearance';

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
  assert.equal(config.get('autoSyncOnSave'), true);
  const repository = app.getChildren()[0].repository;
  const settle = async () => { await Promise.all([...app.syncs.values()]); };
  await settle();
  const realSync = repository.store.sync.bind(repository.store);
  const realPull = repository.store.pull.bind(repository.store);
  let syncs = 0, pulls = 0;
  let hold: Promise<void> | undefined;
  repository.store.sync = async (...args: Parameters<ReviewStore['sync']>) => { syncs++; await hold; return realSync(...args); };
  repository.store.pull = async (remote: string) => { pulls++; return realPull(remote); };
  const native = thread.comments[0] as any;
  const id = native.commentId;
  const rootComment = async (source: ReviewStore) => (await source.threads()).find(review => review.id === id)!.comments[0];
  const original = (await rootComment(store)).body;

  await vscode.commands.executeCommand('gitex.editComment', native);
  assert.equal(syncs + pulls, 0, 'starting an edit must not access the remote');
  native.body = 'Edited from the inline widget';
  let release!: () => void;
  hold = new Promise<void>(resolve => { release = resolve; });
  await vscode.commands.executeCommand('gitex.saveComment', native);
  assert.equal((await rootComment(store)).body, 'Edited from the inline widget');
  assert.equal(native.mode, vscode.CommentMode.Preview, 'saving finishes while the network is still pending');
  assert.match(native.label, /Edited/);
  release(); await settle(); hold = undefined;
  assert.equal(syncs, 1, 'one sync per successful edit save');
  assert.equal(pulls, 0, 'no separate pre-save pull');
  await vscode.commands.executeCommand('gitex.commentHistory', native);
  const history = vscode.window.activeTextEditor!.document.getText();
  assert.ok(history.includes(original)); assert.ok(history.includes('Edited from the inline widget'));
  const reply = thread.comments[1] as any;
  await vscode.commands.executeCommand('gitex.editComment', reply);
  reply.body = 'Canceled reply edit';
  await vscode.commands.executeCommand('gitex.cancelEdit', reply);
  await vscode.commands.executeCommand('gitex.refresh');
  assert.equal((await store.threads())[0].comments[1].body, 'Inline reply');
  assert.equal(syncs, 1); assert.equal(pulls, 0);

  const bare = await store.git.text(['remote', 'get-url', 'origin']);
  const peerPath = path.join(path.dirname(store.root), 'peer');
  await new Git(path.dirname(store.root)).text(['clone', bare, peerPath]);
  const peer = new ReviewStore(peerPath);
  await peer.git.text(['config', 'user.name', 'Remote Reviewer']);
  await peer.git.text(['config', 'user.email', (await store.author()).email]);
  await peer.pull();
  assert.equal((await rootComment(peer)).body, 'Edited from the inline widget', 'save auto-pushes the edit');
  const remoteEdit = async (body: string) => {
    await peer.pull();
    const current = await rootComment(peer);
    await peer.edit(id, id, body, current.revisions.at(-1)!.id); await peer.sync();
  };
  await vscode.commands.executeCommand('gitex.editComment', native);
  native.body = 'My unsaved draft';
  await remoteEdit('Changed while editing');
  await vscode.commands.executeCommand('gitex.pull');
  assert.equal(native.body, 'My unsaved draft');
  await assert.rejects(app.saveComment(native), /changed while you were editing/);
  assert.equal(native.mode, vscode.CommentMode.Preview);
  assert.equal(syncs, 1, 'failed saves do not sync');

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
  await until(async () => (await view.locator('#comments textarea').first().inputValue()) === 'My unsaved draft', 'preserved inline draft');
  await view.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  assert.equal(await view.locator('#location').textContent(), 'main.tex');
  assert.equal(await view.locator('.passage-content > pre').textContent(), 'A reviewed result.');
  assert.equal(await view.locator('#match-state').textContent(), 'Attached');
  assert.equal(await view.getByRole('button', { name: 'Save reply', exact: true }).isDisabled(), true);
  await reviewAppearance(view);
  const originalItem = app.getChildren().find((item: any) => item.review.id === id);
  const otherItem = app.getChildren().find((item: any) => item.review.id !== id);
  const sharedPanel = app.panels.get(originalItem.key);
  const firstEdit = view.locator('#comments > details').first();
  await firstEdit.getByRole('button', { name: 'Edit', exact: true }).click();
  await firstEdit.locator('textarea').fill('Draft retained while viewing another thread');
  await view.locator('#reply').fill('Unsent reply retained across threads');
  await vscode.commands.executeCommand('gitex.reviewThread', otherItem);
  await until(async () => (await view.locator('.body').first().textContent()) === otherItem.review.comments[0].body, 'replacement review');
  assert.equal(app.panels.size, 1);
  assert.equal(app.panels.get(otherItem.key), sharedPanel, 'switching threads reuses the same webview panel');
  assert.equal(await view.locator('#reply').inputValue(), '');
  await vscode.commands.executeCommand('gitex.reviewThread', originalItem);
  await until(async () => (await view.locator('#reply').inputValue()) === 'Unsent reply retained across threads', 'restored reply draft');
  assert.equal(await firstEdit.locator('textarea').inputValue(), 'Draft retained while viewing another thread');
  await firstEdit.getByRole('button', { name: 'Cancel', exact: true }).click();
  await view.locator('#reply').fill('');

  const realReply = repository.store.reply.bind(repository.store);
  let releaseReply!: () => void;
  let replyStarted = false;
  const replyBarrier = new Promise<void>(resolve => { releaseReply = resolve; });
  repository.store.reply = async (...args: any[]) => { replyStarted = true; await replyBarrier; return realReply(...args); };
  await view.locator('#reply').fill('Saved to the original thread while switching');
  await view.locator('#reply').dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(replyStarted, false, 'IME composition must not submit a draft');
  await view.locator('#reply').press('Control+Enter');
  await until(async () => replyStarted, 'pending reply save');
  assert.equal(await view.getByRole('button', { name: 'Saving…', exact: true }).isDisabled(), true);
  assert.equal(await view.locator('#reply-form').getAttribute('aria-busy'), 'true');
  await vscode.commands.executeCommand('gitex.reviewThread', otherItem);
  await until(async () => (await view.locator('.body').first().textContent()) === otherItem.review.comments[0].body, 'switch while save is pending');
  await view.locator('#reply').fill('Draft in the other thread');
  releaseReply();
  await until(async () => (await store.threads()).find(review => review.id === id)!.comments.some(comment => comment.body === 'Saved to the original thread while switching'), 'save routed to original thread');
  await settle();
  assert.equal(await view.locator('#reply').inputValue(), 'Draft in the other thread', 'late completion must not clear another thread draft');
  assert.ok(!(await store.threads()).find(review => review.id === otherItem.review.id)!.comments.some(comment => comment.body === 'Saved to the original thread while switching'));
  await view.locator('#reply').fill('');
  await vscode.commands.executeCommand('gitex.reviewThread', originalItem);
  await until(async () => (await view.locator('.body').first().textContent()) === (await rootComment(store)).body, 'return to original thread');
  await until(async () => (await view.locator('#reply').inputValue()) === '', 'original reply completion');
  assert.equal(await view.getByRole('button', { name: 'Save reply', exact: true }).isDisabled(), true);
  repository.store.reply = realReply;

  const beforeResolve = { syncs, pulls };
  await view.getByRole('checkbox', { name: 'Resolved', exact: true }).check();
  await until(async () => !app.nativeThreads.has(originalItem.key), 'resolved widget removal');
  assert.ok(app.getChildren().some((item: any) => item.review.id === id && item.review.resolved));
  await config.update('showResolved', false, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('gitex.refresh');
  assert.ok(app.getChildren().some((item: any) => item.review.id === id), 'resolved threads remain in Explorer regardless of the legacy setting');
  await view.getByRole('checkbox', { name: 'Resolved', exact: true }).uncheck();
  await until(async () => app.nativeThreads.has(originalItem.key), 'reopened widget');
  await config.update('showResolved', undefined, vscode.ConfigurationTarget.Workspace);
  assert.deepEqual({ syncs, pulls }, beforeResolve, 'checkbox changes keep save-only network behavior');
  const summary = view.locator('#comments > details > summary').first();
  const noNetwork = { syncs, pulls };
  await remoteEdit('Remote change awaiting the next save');
  await summary.click(); await summary.click();
  await view.locator('.body').first().click();
  const firstComment = view.locator('#comments > details').first();
  await firstComment.locator('details > summary').click();
  await view.locator('#reply').focus();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual({ syncs, pulls }, noNetwork, 'click, expand, history, and focus must not contact the remote');
  assert.equal((await rootComment(store)).body, 'Changed while editing');

  await view.locator('#reply').fill('Reply saved through the panel');
  await view.getByRole('button', { name: 'Save reply', exact: true }).click();
  await until(async () => syncs === noNetwork.syncs + 1, 'one sync after reply');
  await settle();
  assert.equal(app.syncErrors.get(store.root), undefined, 'automatic sync merges remote comments before publishing');
  await peer.pull();
  assert.ok((await peer.threads())[0].comments.some(comment => comment.body === 'Reply saved through the panel'));
  assert.equal((await rootComment(store)).body, 'Remote change awaiting the next save', 'automatic sync applies remote changes');
  assert.equal(pulls, noNetwork.pulls);

  await firstComment.getByRole('button', { name: 'Edit', exact: true }).click();
  const draft = firstComment.locator('textarea');
  await draft.fill('Panel draft survives remote changes');
  await remoteEdit('New remote panel version');
  await vscode.commands.executeCommand('gitex.pull');
  await until(async () => (await view.locator('.body').first().textContent()) === 'New remote panel version', 'manual pull');
  assert.equal(await draft.inputValue(), 'Panel draft survives remote changes');
  const beforeFailedSave = syncs;
  await firstComment.getByRole('button', { name: 'Save edit', exact: true }).click();
  await until(async () => (await view.locator('#error').textContent())!.includes('changed while'), 'stale edit feedback');
  assert.equal(syncs, beforeFailedSave);
  assert.equal(await draft.inputValue(), 'Panel draft survives remote changes');
  await firstComment.getByRole('button', { name: 'Cancel', exact: true }).click();
  await firstComment.getByRole('button', { name: 'Edit', exact: true }).click();
  await draft.fill('Saved through the review panel');
  await firstComment.getByRole('button', { name: 'Save edit', exact: true }).click();
  await until(async () => syncs === beforeFailedSave + 1, 'panel edit sync'); await settle();
  await peer.pull(); assert.equal((await rootComment(peer)).body, 'Saved through the review panel');
  assert.ok((await firstComment.locator('pre').allTextContents()).includes(original));
  assert.ok((await firstComment.locator('pre').allTextContents()).includes('Saved through the review panel'));

  // Respect the previous disabled preference, with the new setting taking precedence.
  await config.update('autoPullOnInteraction', false, vscode.ConfigurationTarget.WorkspaceFolder);
  assert.equal(app.autoSyncEnabled(repository), false);
  await config.update('autoSyncOnSave', true, vscode.ConfigurationTarget.WorkspaceFolder);
  assert.equal(app.autoSyncEnabled(repository), true);
  await config.update('autoSyncOnSave', false, vscode.ConfigurationTarget.WorkspaceFolder);
  const disabled = { syncs, pulls };
  const tip = await new Git(bare).ref(REMOTE_REF);
  await vscode.commands.executeCommand('gitex.reply', { thread, text: 'Saved while auto sync is disabled' });
  await settle();
  assert.deepEqual({ syncs, pulls }, disabled);
  assert.equal(await new Git(bare).ref(REMOTE_REF), tip);
  await vscode.commands.executeCommand('gitex.sync'); await peer.pull();
  assert.ok((await peer.threads())[0].comments.some(comment => comment.body === 'Saved while auto sync is disabled'));
  await peer.reply(id, 'Visible after manual fetch'); await peer.sync();
  await vscode.commands.executeCommand('gitex.pull');
  assert.ok((await store.threads())[0].comments.some(comment => comment.body === 'Visible after manual fetch'));

  // A slow push must not block the next editor save or claim that save was shared.
  await vscode.commands.executeCommand('gitex.reply', { thread, text: 'Ready for the slow push' });
  const gitRun = repository.store.git.run.bind(repository.store.git);
  let pushing = false;
  let releasePush!: () => void;
  const held = new Promise<void>(resolve => { releasePush = resolve; });
  repository.store.git.run = async (args: string[], input?: string | Buffer) => {
    if (args[0] === 'push') { pushing = true; await held; }
    return gitRun(args, input);
  };
  const slowSync = app.sync(repository);
  try {
    await until(async () => pushing, 'push awaiting the remote');
    let saved = false;
    const save = vscode.commands.executeCommand('gitex.reply', { thread, text: 'Saved during the slow push' }).then(() => { saved = true; });
    await until(async () => saved, 'editor save must finish before the push is released'); await save;
  } finally {
    releasePush(); await slowSync;
    repository.store.git.run = gitRun;
  }
  await until(async () => (await view.locator('#status').textContent())!.includes('Newer comments remain saved locally'), 'pending publication feedback');
  await peer.pull();
  assert.ok(!(await peer.threads())[0].comments.some(comment => comment.body === 'Saved during the slow push'));
  await app.pull(repository);
  assert.match(app.syncErrors.get(repository.store.root), /Newer comments remain saved locally/);
  await app.sync(repository); await peer.pull();
  assert.ok((await peer.threads())[0].comments.some(comment => comment.body === 'Saved during the slow push'));
  assert.equal(app.syncErrors.has(repository.store.root), false);

  await config.update('remote', 'nonexistent', vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update('autoSyncOnSave', true, vscode.ConfigurationTarget.WorkspaceFolder);
  const beforeOffline = syncs;
  await vscode.commands.executeCommand('gitex.reply', { thread, text: 'Keep my offline reply' });
  await settle();
  assert.equal(syncs, beforeOffline + 1);
  assert.ok((await store.threads())[0].comments.some(comment => comment.body === 'Keep my offline reply'));
  await until(async () => (await view.locator('#status').textContent())!.includes('Auto sync failed'), 'offline feedback');
  await config.update('remote', 'origin', vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update('autoPullOnInteraction', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  await vscode.commands.executeCommand('gitex.sync');
  const freshNative = app.nativeThreads.get(originalItem.key).comments[0];
  await vscode.commands.executeCommand('gitex.editComment', freshNative);
  freshNative.body = 'Inline draft preserved when resolving';
  await view.getByRole('checkbox', { name: 'Resolved', exact: true }).check();
  await until(async () => !app.nativeThreads.has(originalItem.key), 'hide even when an inline draft exists');
  await vscode.commands.executeCommand('gitex.reviewThread', app.getChildren().find((item: any) => item.review.id === id));
  await until(async () => (await view.locator('#comments textarea').first().inputValue()) === 'Inline draft preserved when resolving', 'recover hidden inline draft');
  await view.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await view.getByRole('checkbox', { name: 'Resolved', exact: true }).uncheck();
  await until(async () => app.nativeThreads.has(originalItem.key), 'restore reopened inline widget');
  await peer.pull();
  const commonRevision = (await rootComment(store)).revisions.at(-1)!.id;
  await store.edit(id, id, 'Same author on device one', commonRevision);
  await peer.edit(id, id, 'Same author on device two', commonRevision);
  await store.sync(); await peer.sync(); await app.pull(repository);
  assert.equal((await rootComment(store)).conflictingRevisions.length, 2);
  await until(async () => (await firstComment.locator('.draft-warning').first().textContent())!.includes('Concurrent edits'), 'visible concurrent edit warning');
  await firstComment.getByRole('button', { name: 'Edit', exact: true }).click();
  await firstComment.locator('textarea').fill('Author reconciled both devices');
  await firstComment.getByRole('button', { name: 'Save edit', exact: true }).click();
  await until(async () => (await rootComment(store)).body === 'Author reconciled both devices', 'author resolves known conflict heads from Review');
  await settle(); assert.equal((await rootComment(store)).conflictingRevisions.length, 0);
  await peer.git.text(['config', 'user.email', 'other-author@example.test']);
  await peer.reply(id, 'Only this other author can edit'); await peer.sync(); await app.pull(repository);
  const foreign = (await store.threads()).find(review => review.id === id)!.comments.find(comment => comment.body === 'Only this other author can edit')!;
  const foreignNative = app.nativeThreads.get(originalItem.key).comments.find((comment: any) => comment.commentId === foreign.id);
  assert.equal(foreignNative.contextValue, 'gitex-comment');
  await assert.rejects(app.editComment(foreignNative), /Only the original author/);
  await until(async () => (await view.locator('.comment-card').filter({ hasText: 'Only this other author can edit' }).count()) === 1, 'other author comment in Review');
  assert.equal(await view.locator('.comment-card').filter({ hasText: 'Only this other author can edit' }).getByRole('button', { name: 'Edit', exact: true }).isVisible(), false);
  await assert.rejects(app.panelAction(app.getChildren().find((item: any) => item.review.id === id),
    { type: 'edit', commentId: foreign.id, basedOn: foreign.id, body: 'Attempted foreign edit', requestId: 'foreign-edit' }), /Only the original author/);
  await peer.git.text(['config', 'user.email', (await store.author()).email]);
  for (const panel of app.panels.values()) { panel.dispose(); }
  await browser.close();
  repository.store.sync = realSync; repository.store.pull = realPull;
  console.log('GiTex review tests: save-only background pull + push, no network on interaction, disabled setting, drafts, history, and offline recovery passed.');
}
