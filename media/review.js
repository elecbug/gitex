/* Runs only inside the GiTex webview. Shared comment text is always rendered with textContent. */
(() => {
  const vscode = acquireVsCodeApi();
  const comments = document.getElementById('comments');
  const error = document.getElementById('error');
  const nodes = new Map();
  const pending = new Map();
  let sequence = 0;
  let interactionQueued = false;
  function interact() {
    if (interactionQueued) return;
    interactionQueued = true;
    queueMicrotask(() => { interactionQueued = false; vscode.postMessage({ type: 'interaction' }); });
  }
  document.addEventListener('click', interact);
  document.addEventListener('focusin', interact);
  function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (parent) parent.append(node);
    return node;
  }
  function submit(payload, controls, onSaved) {
    const requestId = String(++sequence);
    error.textContent = '';
    controls.forEach(control => { control.disabled = true; });
    pending.set(requestId, success => {
      controls.forEach(control => { control.disabled = false; });
      if (success) onSaved();
    });
    vscode.postMessage({ ...payload, requestId });
  }
  function createNode(comment) {
    const details = element('details', undefined, comments);
    details.open = true;
    const summary = element('summary', '', details);
    const body = element('p', '', details);
    body.className = 'body';
    const edit = element('button', 'Edit', details);
    const form = element('form', undefined, details);
    form.hidden = true;
    const label = element('label', 'Edit comment', form);
    const textarea = element('textarea', undefined, form);
    textarea.rows = 4; textarea.required = true; textarea.maxLength = 100000;
    textarea.id = `edit-${comment.id}`; label.htmlFor = textarea.id;
    const save = element('button', 'Save edit locally', form);
    save.type = 'submit';
    const cancel = element('button', 'Cancel', form);
    cancel.type = 'button';
    const changed = element('p', '', form);
    changed.setAttribute('role', 'status');
    const history = element('details', undefined, details);
    const historySummary = element('summary', 'History', history);
    const revisions = element('div', undefined, history);
    const node = { details, summary, body, edit, form, textarea, historySummary, revisions, changed, current: comment, basedOn: undefined, signature: '' };
    edit.onclick = () => {
      node.basedOn = node.current.revisions.at(-1).id;
      textarea.value = node.current.body;
      changed.textContent = '';
      form.hidden = false; edit.hidden = true;
      textarea.focus();
    };
    const close = () => { form.hidden = true; edit.hidden = false; node.basedOn = undefined; };
    cancel.onclick = close;
    form.onsubmit = event => {
      event.preventDefault();
      if (!textarea.value.trim()) return;
      submit({ type: 'edit', commentId: comment.id, basedOn: node.basedOn, body: textarea.value }, [textarea, save, cancel], close);
    };
    return node;
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'render') {
      document.getElementById('location').textContent = message.location;
      document.getElementById('status').textContent = message.status;
      for (const comment of message.review.comments) {
        let node = nodes.get(comment.id);
        if (!node) { node = createNode(comment); nodes.set(comment.id, node); }
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
    } else if (message.type === 'draft') {
      const node = nodes.get(message.commentId);
      if (!node) return;
      node.basedOn = message.basedOn;
      node.textarea.value = message.body;
      node.form.hidden = false; node.edit.hidden = true; node.details.open = true;
      node.changed.textContent = 'Your unsaved inline edit was preserved here. Review history before saving.';
      node.textarea.focus();
    } else if (message.type === 'saved' || message.type === 'error') {
      const complete = pending.get(message.requestId);
      if (complete) { pending.delete(message.requestId); complete(message.type === 'saved'); }
      if (message.type === 'error') error.textContent = message.message;
    }
  });
  document.getElementById('source').onclick = () => vscode.postMessage({ type: 'source' });
  document.getElementById('reply-form').onsubmit = event => {
    event.preventDefault();
    const textarea = document.getElementById('reply');
    if (!textarea.value.trim()) return;
    const button = event.currentTarget.querySelector('button');
    submit({ type: 'reply', body: textarea.value }, [textarea, button], () => { textarea.value = ''; });
  };
  vscode.postMessage({ type: 'ready' });
})();
