import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { ReviewThread } from './model';

export type ReviewAction = { type: 'interaction' | 'ready' | 'source' } |
  { type: 'edit'; commentId: string; body: string; basedOn: string; requestId: string } |
  { type: 'reply'; body: string; requestId: string };

/** A stable-API surface that can observe click, focus and expansion interactions. */
export class ReviewPanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  private readonly listeners: vscode.Disposable[] = [];
  private ready = false;
  private draft?: { commentId: string; body: string; basedOn: string };

  constructor(extensionUri: vscode.Uri, readonly key: string, onAction: (action: ReviewAction) => Promise<void>, onClose: () => void) {
    this.panel = vscode.window.createWebviewPanel('gitex.review', 'GiTex Review', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] });
    const nonce = randomBytes(16).toString('hex');
    const script = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.js'));
    const style = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'review.css'));
    this.panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource}; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${style}"></head>
      <body><h1>GiTex Review</h1><p id="location"></p><p id="status" role="status"></p>
      <button id="source">Open source / original excerpt</button><p id="error" role="alert"></p>
      <main id="comments"></main><form id="reply-form"><label for="reply">Reply</label>
      <textarea id="reply" rows="3" required maxlength="100000"></textarea><button type="submit">Save reply locally</button></form>
      <script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.listeners.push(this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!validAction(message)) { return; }
      try {
        if (message.type === 'ready') { this.ready = true; }
        await onAction(message);
        this.sendDraft();
        if ('requestId' in message) { await this.panel.webview.postMessage({ type: 'saved', requestId: message.requestId }); }
      } catch (error) {
        await this.panel.webview.postMessage({ type: 'error', requestId: 'requestId' in message ? message.requestId : undefined,
          message: error instanceof Error ? error.message : String(error) });
      }
    }), this.panel.onDidChangeViewState(event => {
      if (event.webviewPanel.active) { void onAction({ type: 'interaction' }).catch(() => undefined); }
    }), this.panel.onDidDispose(() => { this.listeners.forEach(listener => listener.dispose()); onClose(); }));
  }

  update(review: ReviewThread, location: string, status: string): void {
    void this.panel.webview.postMessage({ type: 'render', review, location, status });
  }

  preserveDraft(commentId: string, body: string, basedOn: string): void {
    this.draft = { commentId, body, basedOn };
    this.sendDraft();
  }

  private sendDraft(): void {
    if (!this.ready || !this.draft) { return; }
    void this.panel.webview.postMessage({ type: 'draft', ...this.draft });
    this.draft = undefined;
  }

  dispose(): void { this.panel.dispose(); }
}

function validAction(value: unknown): value is ReviewAction {
  if (!value || typeof value !== 'object') { return false; }
  const event = value as Record<string, unknown>;
  if (event.type === 'interaction' || event.type === 'ready' || event.type === 'source') { return true; }
  if (typeof event.body !== 'string' || !event.body.trim() || event.body.length > 100_000 || typeof event.requestId !== 'string') { return false; }
  return event.type === 'reply' || (event.type === 'edit' && typeof event.commentId === 'string' && typeof event.basedOn === 'string');
}
