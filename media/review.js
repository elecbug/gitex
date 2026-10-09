/* Runs only inside the GiTex webview. Shared text is rendered with textContent. */
(() => {
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('thread');
  const error = document.getElementById('error');
  const views = new Map();
  const pending = new Map();
  const shortcut = /Mac/i.test(navigator.platform) ? 'Cmd+Enter' : 'Ctrl+Enter';
  let activeKey;
  let sequence = 0;

  function element(tag, text, parent, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    if (parent) parent.append(node);
    return node;
  }
  function icon(kind, parent) {
    const paths = {
      source: 'M6 3H3v10h10v-3M9 3h4v4M7 9l6-6',
      move: 'M8 1v14M1 8h14M5 4l3-3 3 3M5 12l3 3 3-3M4 5L1 8l3 3M12 5l3 3-3 3',
      edit: 'M10 2l4 4M2 14l4-1 8-8-3-3-8 8-1 4z',
      history: 'M2 3v4h4M2 7a6 6 0 1 1 1 5M8 4v4l3 2'
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(svg.namespaceURI, 'path');
    line.setAttribute('d', paths[kind]); svg.append(line); parent.append(svg);
  }
  function button(text, parent, className = '', symbol) {
    const node = element('button', undefined, parent, className); node.type = 'button';
    if (symbol) icon(symbol, node);
    element('span', text, node, 'button-label');
    return node;
  }
  function range(anchor) {
    return anchor.startLine === anchor.endLine ? 'Line ' + (anchor.startLine + 1) :
      'Lines ' + (anchor.startLine + 1) + '–' + (anchor.endLine + 1);
  }
  function submit(view, payload, controls, onSaved, onFailed = () => {}, busyButton, busyLabel = 'Saving…') {
    const requestId = String(++sequence);
    view.error = '';
    if (view.key === activeKey) error.textContent = '';
    const caption = busyButton?.querySelector('.button-label');
    const previous = caption?.textContent;
    if (caption) caption.textContent = busyLabel;
    controls.forEach(control => { control.disabled = true; });
    pending.set(requestId, success => {
      controls.forEach(control => { control.disabled = false; });
      if (caption) caption.textContent = previous;
      if (success) onSaved(); else onFailed();
    });
    vscode.postMessage({ ...payload, key: view.key, requestId });
  }
  function wireComposer(view, form, textarea, save, extraControls, payload, onSaved) {
    const feedback = element('p', '', form, 'form-feedback'); feedback.setAttribute('role', 'status');
    const validate = () => { save.disabled = form.dataset.pending === 'true' || !textarea.value.trim(); };
    textarea.addEventListener('input', () => { feedback.textContent = ''; validate(); });
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && !event.isComposing) {
        event.preventDefault();
        if (!event.repeat && !save.disabled) form.requestSubmit();
      }
    });
    form.onsubmit = event => {
      event.preventDefault();
      if (save.disabled || !textarea.value.trim()) return;
      form.dataset.pending = 'true'; form.setAttribute('aria-busy', 'true'); feedback.textContent = '';
      const finish = () => { form.dataset.pending = 'false'; form.removeAttribute('aria-busy'); validate(); };
      submit(view, payload(), [textarea, save, ...extraControls], () => {
        onSaved(); finish(); feedback.textContent = 'Saved locally';
      }, finish, save);
    };
    validate();
    return validate;
  }
  function formActions(form) {
    const actions = element('div', undefined, form, 'form-actions');
    const buttons = element('div', undefined, actions, 'action-buttons');
    const hint = element('span', undefined, actions, 'keyboard-hint');
    element('kbd', shortcut, hint); hint.append(document.createTextNode(' to save'));
    return buttons;
  }
  function createView(key) {
    const root = element('section');
    const contextCard = element('section', undefined, root, 'context-card');
    contextCard.setAttribute('aria-label', 'Review location');
    const heading = element('div', undefined, contextCard, 'context-heading');
    const repository = element('p', '', heading, 'repository'); repository.id = 'repository';
    const locationRow = element('div', undefined, heading, 'location-row');
    const location = element('h1', '', locationRow); location.id = 'location';
    const match = element('span', '', locationRow, 'badge'); match.id = 'match-state';
    const lines = element('p', '', heading, 'line-range');
    const contextNote = element('p', '', contextCard, 'context-note'); contextNote.hidden = true;
    const passage = element('details', undefined, contextCard, 'passage'); passage.open = true;
    const passageSummary = element('summary', 'Saved reference', passage);
    const excerpt = element('pre', '', element('div', undefined, passage, 'passage-content'));
    const surroundings = element('details', undefined, passage, 'surroundings');
    const surroundingsLabel = element('summary', 'Surrounding sentences', surroundings);
    const surroundingsBody = element('div', undefined, surroundings);
    const tools = element('div', undefined, contextCard, 'thread-tools');
    const source = button('Open source', tools, 'secondary', 'source'); source.id = 'source';
    const move = button('Move to editor selection', tools, 'quiet', 'move');
    move.title = 'Select destination lines in a LaTeX editor first. The whole thread moves and its history is preserved.';
    const label = element('label', undefined, tools, 'resolved-toggle');
    const resolved = element('input', undefined, label);
    resolved.type = 'checkbox'; resolved.id = 'resolved';
    label.append(document.createTextNode('Resolved'));
    const resolvedNote = element('p', 'Resolved threads stay in Explorer and are hidden in the source editor.', contextCard, 'resolved-note');
    resolvedNote.hidden = true;
    const discussion = element('div', undefined, root, 'section-heading');
    const discussionHeading = element('h2', 'Discussion', discussion);
    const count = element('span', '', discussionHeading, 'comment-count');
    const syncInfo = element('details', undefined, discussion, 'sync-info');
    const syncSummary = element('summary', undefined, syncInfo);
    element('span', undefined, syncSummary, 'sync-dot');
    const syncLabel = element('span', '', syncSummary);
    const status = element('p', '', syncInfo); status.id = 'status'; status.setAttribute('role', 'status');
    const comments = element('div', undefined, root); comments.id = 'comments';
    const form = element('form', undefined, root, 'composer'); form.id = 'reply-form';
    const replyLabel = element('label', 'Add a reply', form, 'reply-heading'); replyLabel.htmlFor = 'reply';
    const reply = element('textarea', undefined, form);
    reply.id = 'reply'; reply.rows = 3; reply.required = true; reply.maxLength = 100000;
    reply.placeholder = 'Share feedback or suggest a change…';
    const save = button('Save reply', formActions(form)); save.type = 'submit';
    const tracking = element('details', undefined, root, 'tracking'); tracking.id = 'tracking-history';
    const trackingSummary = element('summary', undefined, tracking);
    icon('history', trackingSummary);
    const trackingLabel = element('span', 'Tracking history', trackingSummary);
    const trackingEntries = element('div', undefined, tracking, 'revision-list');
    const view = { key, root, repository, location, match, lines, contextNote, excerpt, passage, passageSummary, source,
      surroundings, surroundingsLabel, surroundingsBody,
      count, syncInfo, syncLabel, status, comments, resolved, resolvedNote, savedResolved: false, nodes: new Map(), error: '',
      trackingLabel, trackingEntries, trackingSignature: '', scroll: 0 };
    source.onclick = () => vscode.postMessage({ type: 'source', key: view.key });
    move.onclick = () => submit(view, { type: 'move' }, [move], () => {}, () => {}, move, 'Moving…');
    resolved.onchange = () => submit(view, { type: 'resolve', resolved: resolved.checked }, [resolved],
      () => { resolved.checked = view.savedResolved; }, () => { resolved.checked = view.savedResolved; });
    wireComposer(view, form, reply, save, [], () => ({ type: 'reply', body: reply.value }), () => { reply.value = ''; });
    return view;
  }
  function createNode(view, comment) {
    const details = element('details', undefined, view.comments, 'comment-card'); details.open = true;
    const summary = element('summary', undefined, details);
    const avatar = element('span', '', summary, 'avatar'); avatar.setAttribute('aria-hidden', 'true');
    const meta = element('div', undefined, summary, 'comment-meta');
    const author = element('span', undefined, meta, 'author');
    const name = element('span', '', author, 'author-name');
    const edited = element('span', 'Edited', author, 'edited'); edited.hidden = true;
    const timestamp = element('time', '', meta, 'timestamp');
    const body = element('p', '', details, 'body');
    const actions = element('div', undefined, details, 'comment-actions');
    const edit = button('Edit', actions, 'quiet', 'edit');
    const form = element('form', undefined, details, 'edit-form'); form.hidden = true;
    const label = element('label', 'Edit comment', form);
    const textarea = element('textarea', undefined, form);
    textarea.rows = 4; textarea.required = true; textarea.maxLength = 100000;
    textarea.id = 'edit-' + comment.id; label.htmlFor = textarea.id;
    const buttons = formActions(form);
    const save = button('Save edit', buttons); save.type = 'submit';
    const cancel = button('Cancel', buttons, 'secondary');
    const changed = element('p', '', form, 'draft-warning'); changed.setAttribute('role', 'status');
    const history = element('details', undefined, details, 'history');
    const historySummary = element('summary', 'History', history);
    const revisions = element('div', undefined, history, 'revision-list');
    const node = { details, name, avatar, edited, timestamp, body, edit, form, textarea, historySummary, revisions, changed,
      current: comment, basedOn: undefined, signature: '', validate: () => {} };
    edit.onclick = () => {
      node.basedOn = node.current.revisions.at(-1).id;
      textarea.value = node.current.body; changed.textContent = '';
      form.hidden = false; edit.hidden = true; node.validate(); textarea.focus();
    };
    const close = () => {
      form.hidden = true; edit.hidden = false; node.basedOn = undefined;
      if (view.key === activeKey) edit.focus({ preventScroll: true });
    };
    cancel.onclick = close;
    node.validate = wireComposer(view, form, textarea, save, [cancel],
      () => ({ type: 'edit', commentId: comment.id, basedOn: node.basedOn, body: textarea.value }), close);
    return node;
  }
  function historyEntry(parent, title, current, currentLabel, author, at) {
    const entry = element('article', undefined, parent, 'history-entry');
    entry.dataset.current = String(current);
    const heading = element('div', undefined, entry, 'entry-heading');
    element('h3', title, heading);
    if (current) element('span', currentLabel, heading, 'badge').dataset.tone = 'accent';
    element('p', author.name + ' · ' + new Date(at).toLocaleString(), entry, 'entry-meta');
    return entry;
  }
  function reference(parent, label, anchor) {
    element('p', label + ': ' + anchor.path + ':' + (anchor.startLine + 1) + '–' + (anchor.endLine + 1), parent, 'reference-label');
    element('pre', anchor.selected.join('\n'), parent);
    const context = element('details', undefined, parent, 'surroundings');
    element('summary', anchor.sentenceContext ? 'Surrounding sentences' : 'Saved line context (legacy)', context);
    renderSurroundings(context, anchor);
  }
  function renderSurroundings(parent, anchor) {
    const saved = anchor.sentenceContext || { before: anchor.before.join('\n'), after: anchor.after.join('\n') };
    for (const [side, label] of [['before', 'Preceding sentence'], ['after', 'Following sentence']]) {
      element('p', anchor.sentenceContext ? label : (side === 'before' ? 'Preceding lines' : 'Following lines'), parent, 'reference-label');
      element('pre', saved[side] || '(Not available in this saved reference)', parent);
    }
  }
  function renderContext(view, review, context) {
    view.repository.textContent = context.repository;
    view.location.textContent = review.anchor.path;
    const attached = context.location.kind === 'attached';
    const uncertain = context.location.kind === 'uncertain';
    view.root.dataset.location = context.location.kind;
    view.lines.textContent = uncertain ? 'Estimated location · Line ' + (context.location.estimatedLine + 1) :
      (attached ? '' : 'Saved reference · ') + range(attached ? context.location : review.anchor);
    view.match.textContent = uncertain ? 'Uncertain' : !attached ? 'Outdated' : context.location.similarity === undefined ? 'Attached' :
      'Similar text · ' + Math.round(context.location.similarity * 100) + '%';
    view.match.dataset.tone = uncertain ? 'uncertain' : !attached ? 'warning' : 'accent';
    view.contextNote.hidden = attached;
    view.contextNote.textContent = attached ? '' : context.location.reason + ' Select source lines and use Move to editor selection to reattach.';
    view.passageSummary.textContent = 'Saved reference · ' + range(review.anchor);
    view.excerpt.textContent = review.anchor.selected.join('\n');
    if (uncertain && view.lastLocation !== 'uncertain') view.passage.open = true;
    view.lastLocation = context.location.kind;
    view.surroundingsLabel.textContent = review.anchor.sentenceContext ? 'Surrounding sentences' : 'Saved line context (legacy)';
    view.surroundingsBody.replaceChildren();
    renderSurroundings(view.surroundingsBody, review.anchor);
    view.source.querySelector('.button-label').textContent = uncertain ? 'Open estimated location' : attached ? 'Open source' : 'Open saved excerpt';
    view.count.textContent = review.comments.length + (review.comments.length === 1 ? ' comment' : ' comments');
    view.syncInfo.dataset.state = context.sync;
    view.syncLabel.textContent = context.sync === 'failed' ? 'Sync pending' : context.sync === 'automatic' ? 'Auto sync on save' : 'Manual sync';
    view.status.textContent = context.status;
    if (context.sync === 'failed') view.syncInfo.open = true;
    view.savedResolved = review.resolved;
    view.resolved.checked = review.resolved;
    view.resolvedNote.hidden = !review.resolved;
    const state = document.getElementById('thread-state');
    state.hidden = false; state.textContent = review.resolved ? 'Resolved' : 'Open';
    state.dataset.tone = review.resolved ? 'resolved' : 'accent';
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'render') {
      let view = views.get(message.key);
      if (!view) { view = createView(message.key); views.set(message.key, view); }
      const switching = activeKey !== message.key;
      if (switching) {
        const previous = views.get(activeKey);
        if (previous) previous.scroll = window.scrollY;
        activeKey = message.key;
        container.replaceChildren(view.root);
        error.textContent = view.error;
      }
      renderContext(view, message.review, message.context);
      for (const comment of message.review.comments) {
        let node = view.nodes.get(comment.id);
        if (!node) { node = createNode(view, comment); view.nodes.set(comment.id, node); }
        node.current = comment;
        const latest = comment.revisions.at(-1);
        node.name.textContent = comment.author.name;
        node.avatar.textContent = comment.author.name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] || '').join('').toUpperCase();
        node.edited.hidden = comment.revisions.length < 2;
        node.edited.title = 'Last edited by ' + latest.author.name + ' · ' + new Date(latest.at).toLocaleString();
        node.timestamp.dateTime = comment.at; node.timestamp.title = new Date(comment.at).toLocaleString();
        node.timestamp.textContent = new Date(comment.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        node.body.textContent = comment.body;
        node.changed.textContent = node.basedOn && node.basedOn !== latest.id ? 'This comment has changed. Your draft is preserved. Review history before saving.' : '';
        const signature = comment.revisions.map(revision => revision.id).join(',');
        if (signature !== node.signature) {
          node.signature = signature;
          node.historySummary.textContent = 'History · ' + comment.revisions.length + (comment.revisions.length === 1 ? ' version' : ' versions');
          node.revisions.replaceChildren();
          [...comment.revisions].reverse().forEach((revision, reversedIndex) => {
            const index = comment.revisions.length - reversedIndex - 1;
            const entry = historyEntry(node.revisions, index === 0 ? 'Original' : 'Edit ' + index,
              revision.id === latest.id, 'Current', revision.author, revision.at);
            element('pre', revision.body, entry);
          });
        }
      }
      const anchors = message.review.anchorHistory;
      const signature = message.review.anchorRevision + ':' + anchors.map(entry => entry.id).join(',');
      if (signature !== view.trackingSignature) {
        view.trackingSignature = signature;
        view.trackingEntries.replaceChildren();
        view.trackingLabel.textContent = 'Tracking history · ' + anchors.length + (anchors.length === 1 ? ' reference' : ' references');
        [...anchors].reverse().forEach((entry, reversedIndex) => {
          const index = anchors.length - reversedIndex - 1;
          const article = historyEntry(view.trackingEntries, entry.kind === 'move' ? 'Manual move' : index === 0 ? 'Original passage' : 'Updated passage',
            entry.id === message.review.anchorRevision, 'Current reference', entry.author, entry.at);
          const comparison = element('div', undefined, article, entry.from ? 'move-comparison' : '');
          if (entry.from) reference(element('div', undefined, comparison), 'Previous reference', entry.from);
          reference(element('div', undefined, comparison), entry.kind === 'move' ? 'Moved to' : 'Reference', entry.anchor);
        });
      }
      if (switching) window.scrollTo(0, view.scroll);
    } else if (message.type === 'draft') {
      const node = views.get(message.key)?.nodes.get(message.commentId);
      if (!node) return;
      node.basedOn = message.basedOn; node.textarea.value = message.body;
      node.form.hidden = false; node.edit.hidden = true; node.details.open = true; node.validate();
      node.changed.textContent = 'Your unsaved inline edit was preserved here. Review history before saving.';
      if (message.key === activeKey) node.textarea.focus();
    } else if (message.type === 'saved' || message.type === 'error') {
      const complete = pending.get(message.requestId);
      if (complete) { pending.delete(message.requestId); complete(message.type === 'saved'); }
      if (message.type === 'error') {
        const view = views.get(message.key);
        if (view) view.error = message.message;
        if (message.key === activeKey) { error.textContent = message.message; error.scrollIntoView({ block: 'nearest' }); }
      }
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
