/* Runs only inside the GiTex webview. Shared text is rendered with textContent. */
(() => {
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('thread');
  const error = document.getElementById('error');
  const views = new Map();
  const pending = new Map();
  let activeKey;
  let sequence = 0;
  function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (parent) parent.append(node);
    return node;
  }
  function submit(view, payload, controls, onSaved, onFailed = () => {}) {
    const requestId = String(++sequence);
    view.error = '';
    if (view.key === activeKey) error.textContent = '';
    controls.forEach(control => { control.disabled = true; });
    pending.set(requestId, success => {
      controls.forEach(control => { control.disabled = false; });
      if (success) onSaved(); else onFailed();
    });
    vscode.postMessage({ ...payload, key: view.key, requestId });
  }
  function createView(key) {
    const root = element('section');
    const label = element('label', undefined, root);
    label.className = 'resolved-toggle';
    const resolved = element('input', undefined, label);
    resolved.type = 'checkbox'; resolved.id = 'resolved';
    label.append(document.createTextNode(' Resolved'));
    const move = element('button', 'Move to editor selection', root);
    move.title = 'Select destination lines in a LaTeX editor first. The whole thread moves and its history is preserved.';
    const comments = element('main', undefined, root); comments.id = 'comments';
    const form = element('form', undefined, root); form.id = 'reply-form';
    const replyLabel = element('label', 'Reply', form); replyLabel.htmlFor = 'reply';
    const reply = element('textarea', undefined, form);
    reply.id = 'reply'; reply.rows = 3; reply.required = true; reply.maxLength = 100000;
    const save = element('button', 'Save reply', form); save.type = 'submit';
    const tracking = element('details', undefined, root); tracking.id = 'tracking-history';
    const trackingSummary = element('summary', 'Tracking history', tracking);
    const trackingEntries = element('div', undefined, tracking);
    const view = { key, root, comments, resolved, savedResolved: false, nodes: new Map(), error: '', trackingSummary, trackingEntries, trackingSignature: '' };
    move.onclick = () => submit(view, { type: 'move' }, [move], () => {});
    resolved.onchange = () => submit(view, { type: 'resolve', resolved: resolved.checked }, [resolved],
      () => { resolved.checked = view.savedResolved; }, () => { resolved.checked = view.savedResolved; });
    form.onsubmit = event => {
      event.preventDefault();
      if (!reply.value.trim()) return;
      submit(view, { type: 'reply', body: reply.value }, [reply, save], () => { reply.value = ''; });
    };
    return view;
  }
  function createNode(view, comment) {
    const details = element('details', undefined, view.comments); details.open = true;
    const summary = element('summary', '', details);
    const body = element('p', '', details); body.className = 'body';
    const edit = element('button', 'Edit', details);
    const form = element('form', undefined, details); form.hidden = true;
    const label = element('label', 'Edit comment', form);
    const textarea = element('textarea', undefined, form);
    textarea.rows = 4; textarea.required = true; textarea.maxLength = 100000;
    textarea.id = `edit-${comment.id}`; label.htmlFor = textarea.id;
    const save = element('button', 'Save edit', form); save.type = 'submit';
    const cancel = element('button', 'Cancel', form); cancel.type = 'button';
    const changed = element('p', '', form); changed.setAttribute('role', 'status');
    const history = element('details', undefined, details);
    const historySummary = element('summary', 'History', history);
    const revisions = element('div', undefined, history);
    const node = { details, summary, body, edit, form, textarea, historySummary, revisions, changed, current: comment, basedOn: undefined, signature: '' };
    edit.onclick = () => {
      node.basedOn = node.current.revisions.at(-1).id;
      textarea.value = node.current.body; changed.textContent = '';
      form.hidden = false; edit.hidden = true; textarea.focus();
    };
    const close = () => { form.hidden = true; edit.hidden = false; node.basedOn = undefined; };
    cancel.onclick = close;
    form.onsubmit = event => {
      event.preventDefault();
      if (!textarea.value.trim()) return;
      submit(view, { type: 'edit', commentId: comment.id, basedOn: node.basedOn, body: textarea.value }, [textarea, save, cancel], close);
    };
    return node;
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'render') {
      let view = views.get(message.key);
      if (!view) { view = createView(message.key); views.set(message.key, view); }
      if (activeKey !== message.key) {
        activeKey = message.key;
        container.replaceChildren(view.root);
        error.textContent = view.error;
      }
      document.getElementById('location').textContent = message.location;
      document.getElementById('status').textContent = message.status;
      view.savedResolved = message.review.resolved;
      view.resolved.checked = message.review.resolved;
      for (const comment of message.review.comments) {
        let node = view.nodes.get(comment.id);
        if (!node) { node = createNode(view, comment); view.nodes.set(comment.id, node); }
        node.current = comment;
        const latest = comment.revisions.at(-1);
        node.summary.textContent = `${comment.author.name}${comment.revisions.length > 1 ? ' · Edited' : ''}`;
        node.body.textContent = comment.body;
        node.changed.textContent = node.basedOn && node.basedOn !== latest.id ? 'This comment has changed. Your draft is preserved. Review history before saving.' : '';
        const signature = comment.revisions.map(revision => revision.id).join(',');
        if (signature !== node.signature) {
          node.signature = signature;
          node.historySummary.textContent = `History (${comment.revisions.length} versions)`;
          node.revisions.replaceChildren();
          comment.revisions.forEach((revision, index) => {
            const entry = element('article', undefined, node.revisions);
            element('h3', `${index === 0 ? 'Original' : 'Edit ' + index}${revision.id === latest.id ? ' · Current' : ''}`, entry);
            element('p', `${revision.author.name} · ${new Date(revision.at).toLocaleString()}`, entry);
            element('pre', revision.body, entry);
          });
        }
      }
      const anchors = message.review.anchorHistory;
      const signature = message.review.anchorRevision + ':' + anchors.map(entry => entry.id).join(',');
      if (signature !== view.trackingSignature) {
        view.trackingSignature = signature;
        view.trackingEntries.replaceChildren();
        view.trackingSummary.textContent = `Tracking history (${anchors.length} versions)`;
        anchors.forEach((entry, index) => {
          const article = element('article', undefined, view.trackingEntries);
          element('h3', `${entry.kind === 'move' ? 'Manual move' : index === 0 ? 'Original passage' : 'Updated passage'}${entry.id === message.review.anchorRevision ? ' · Current reference' : ''}`, article);
          element('p', `${entry.author.name} · ${new Date(entry.at).toLocaleString()}`, article);
          if (entry.from) {
            element('p', `Previous reference: ${entry.from.path}:${entry.from.startLine + 1}–${entry.from.endLine + 1}`, article);
            element('pre', entry.from.selected.join('\n'), article);
          }
          element('p', `${entry.kind === 'move' ? 'Moved to' : 'Reference'}: ${entry.anchor.path}:${entry.anchor.startLine + 1}–${entry.anchor.endLine + 1}`, article);
          element('pre', entry.anchor.selected.join('\n'), article);
        });
      }
    } else if (message.type === 'draft') {
      const node = views.get(message.key)?.nodes.get(message.commentId);
      if (!node) return;
      node.basedOn = message.basedOn; node.textarea.value = message.body;
      node.form.hidden = false; node.edit.hidden = true; node.details.open = true;
      node.changed.textContent = 'Your unsaved inline edit was preserved here. Review history before saving.';
      if (message.key === activeKey) node.textarea.focus();
    } else if (message.type === 'saved' || message.type === 'error') {
      const complete = pending.get(message.requestId);
      if (complete) { pending.delete(message.requestId); complete(message.type === 'saved'); }
      if (message.type === 'error') {
        const view = views.get(message.key);
        if (view) view.error = message.message;
        if (message.key === activeKey) error.textContent = message.message;
      }
    }
  });
  document.getElementById('source').onclick = () => vscode.postMessage({ type: 'source', key: activeKey });
  vscode.postMessage({ type: 'ready' });
})();
