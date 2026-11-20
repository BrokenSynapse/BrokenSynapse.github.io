export function createForumView({ history, request, identity, onSelect, onError, canDelete, canEdit, messageMenu, renderMessage, richEditor }) {
  const root = document.createElement('section'); root.id = 'forum-view'; root.hidden = true; history.before(root);
  let drawSignature = '', detailSignature = '';
  const postRows = new Map();
  let conversation = null, postId = null, posts = [], current = null, canSend = false, requestId = 0, hasMore = false;
  const make = (tag, className, text) => { const node = document.createElement(tag); node.className = className || ''; if (text !== undefined) node.textContent = text; return node; };
  function button(label, action, className) { const node = make('button', className, label); node.type = 'button'; node.onclick = action; return node; }
  function votes(post) {
    const group = make('div', 'forum-votes');
    group.dataset.voteSignature = JSON.stringify([post.rating,post.vote,canSend]);
    for (const [value, label, symbol] of [[1, 'Upvote', '▲'], [-1, 'Downvote', '▼']]) {
      const action = button(symbol, async event => {
        event.stopPropagation(); if (action.disabled) return; action.disabled = true;
        try { const response = await request('conversations/' + conversation + '/forum/' + post.id + '/vote', { value: post.vote === value ? 0 : value });
          if (current?.id === response.post.id) current = response.post;
          await refresh();
        } catch (error) { onError(error); action.disabled = !canSend; }
      });
      action.title = label; action.setAttribute('aria-label', label + ' ' + post.title); action.setAttribute('aria-pressed', String(post.vote === value)); action.disabled = !canSend;
      group.append(action); if (value === 1) group.append(make('span', 'forum-rating', String(post.rating)));
    }
    return group;
  }
  function menu(node, post) {
    if (!canDelete(post) && !canEdit(post)) return;
    node.oncontextmenu = event => { event.preventDefault(); messageMenu(conversation, post, event.clientX, event.clientY, node, canSend && canEdit(post) ? () => openEdit(post) : null); };
  }
  function draw() {
    if (!composePanel.hidden) return;
    const signature = JSON.stringify([conversation,postId,current,posts,canSend]);
    if (signature === drawSignature) return;
    drawSignature = signature;
    if (postId && current) {
      const { vote, rating, comments, ...content } = current;
      const detail = JSON.stringify([conversation,postId,content,canSend]);
      if (detail === detailSignature && root.querySelector('.forum-post-heading')) {
        const group = root.querySelector('.forum-votes');
        if (group?.dataset.voteSignature !== JSON.stringify([current.rating,current.vote,canSend])) group?.replaceWith(votes(current));
        return;
      }
      detailSignature = detail;
    } else detailSignature = '';
    const nodes = [];
    if (postId && current) {
      nodes.push(button('← All posts', () => select(null), 'forum-back'));
      const heading = make('div', 'forum-post-heading');
      const content = make('div'); const title = make('div', 'forum-detail-title'); title.append(renderMessage(current, conversation)); content.append(title, make('p', 'forum-meta', current.displayName + ' · ' + new Date(current.sent).toLocaleDateString()));
      if (canSend && canEdit(current)) content.append(button('Edit post', () => compose(current), 'forum-edit-post'));
      const body = make('div', 'forum-body'); body.append(richEditor.render(current.body || '', current.bodyFormat)); content.append(body);
      heading.append(votes(current), content); menu(heading, current);
      nodes.push(heading, make('h3', 'forum-discussion-label', 'Conversation'));
      root.classList.add('forum-detail');
    } else {
      root.classList.remove('forum-detail');
      const header = make('header', 'forum-heading'); header.append(make('h2', '', 'Forum posts'), make('span', 'forum-meta', 'Highest rated first'));
      if (canSend) header.append(button('New post', compose, 'forum-new-post')); nodes.push(header);
      for (const post of posts) {
        const { vote, rating, comments, ...fields } = post;
        const signature = JSON.stringify([fields,canSend,canEdit(post),canDelete(post)]);
        const cached = postRows.get(post.id);
        if (cached?.signature === signature) {
          const group = cached.row.querySelector('.forum-votes');
          if (group.dataset.voteSignature !== JSON.stringify([rating,vote,canSend])) group.replaceWith(votes(post));
          const meta = cached.row.querySelector('.forum-meta');
          const text = post.displayName + ' · ' + comments + (comments === 1 ? ' reply' : ' replies');
          if (meta.textContent !== text) meta.textContent = text;
          nodes.push(cached.row); continue;
        }
        const row = make('article', 'forum-post-card'); row.dataset.postId = post.id;
        const open = button(post.title || 'Untitled post', () => select(post.id), 'forum-post-title');
        open.replaceChildren(renderMessage(post, conversation));
        const content = make('div'); content.append(open, make('p', 'forum-meta', post.displayName + ' · ' + post.comments + (post.comments === 1 ? ' reply' : ' replies')));
        row.append(votes(post), content); menu(row, post); postRows.set(post.id,{signature,row}); nodes.push(row);
      }
      if (!posts.length) nodes.push(make('p', 'forum-empty', 'Start a conversation with the first post.'));
      if (hasMore) nodes.push(button('Load more posts', () => void refresh(true), 'forum-load-more'));
    }
    const retained = new Set(nodes);
    for (const node of [...root.children]) if (!retained.has(node)) node.remove();
    let cursor = root.firstElementChild;
    for (const node of nodes) { if (node === cursor) cursor = cursor.nextElementSibling; else root.insertBefore(node,cursor); }
  }
  async function openEdit(post) {
    try { const thread=conversation;const result=await request('conversations/'+thread+'/forum/'+post.id);if(conversation===thread)compose(result.post); } catch(error) {onError(error);}
  }
  async function select(id) {
    drawSignature = detailSignature = ''; postId = id; current = null; requestId++; root.replaceChildren();
    await onSelect();
  }
  async function refresh(more = false) {
    if (!conversation || root.hidden) return;
    const thread = conversation, selected = postId, version = ++requestId;
    try {
      const result = await request('conversations/' + thread + '/forum' + (selected ? '/' + selected : '?offset=' + (more ? posts.length : 0)));
      if (thread !== conversation || selected !== postId || version !== requestId) return;
      if (selected) current = result.post;
      else { posts = more ? [...posts, ...result.posts] : result.posts; hasMore = result.hasMore; }
      draw();
    } catch (error) {
      if (thread !== conversation || version !== requestId) return;
      if (selected) { postId = null; current = null; onSelect(); }
      onError(error);
    }
  }
  const composePanel = document.createElement('section'); composePanel.className = 'forum-compose-inline'; composePanel.hidden = true; composePanel.setAttribute('aria-label','Edit forum post');
  composePanel.innerHTML = `<div class="forum-compose-form"><h2>New forum post</h2><label>Title<input name="title" maxlength="200" required></label><p>Description</p><div class="forum-body-editor"></div><p role="status"></p><footer><button type="button">Cancel</button><button type="button" class="forum-save">Create post</button></footer></div>`;
  root.after(composePanel); const form = composePanel.querySelector('.forum-compose-form');
  const titleField = form.querySelector('[name=title]');
  const saveButton = form.querySelector('.forum-save');
  function closeCompose() {
    richEditor.unmount(); composePanel.hidden = true; root.hidden = false; drawSignature = ''; history.hidden = !postId; draw();
  }
  form.querySelector('[type="button"]').onclick = closeCompose;
  let editingId = null;
  function compose(post) { editingId = post?.id || null; titleField.value = ''; 
    form.querySelector('h2').textContent = editingId ? 'Edit forum post' : 'New forum post';
    saveButton.textContent = editingId ? 'Save post' : 'Create post';
    if (editingId) titleField.value = post.title; form.querySelector('[role="status"]').textContent = ''; composePanel.hidden = false; root.hidden = true; history.hidden = true; richEditor.mount(form.querySelector('.forum-body-editor'), post?.body || '', post?.bodyFormat, () => saveButton.click()); }
  saveButton.onclick = async event => {
    event.preventDefault(); if (!titleField.reportValidity()) return; const submit = saveButton; submit.disabled = true;
    const thread = conversation;
    try {
      const description = richEditor.message();
      if (editingId) await request('conversations/' + thread + '/forum/' + editingId, { title: titleField.value.trim(), body: description.body, bodyFormat: description.format });
      else await request('conversations/' + thread + '/messages', { ...identity(), body: titleField.value.trim(), forumBody: description.body, forumFormat: description.format });
      if (thread === conversation) { closeCompose(); await refresh(); }
    } catch (error) { form.querySelector('[role="status"]').textContent = error.message; }
    finally { submit.disabled = false; }
  };
  return {
    get postId() { return postId; },
    get composing() { return !composePanel.hidden; },
    cancelCompose: closeCompose,
    show(channel) { root.hidden = !composePanel.hidden; canSend = channel.canSend !== false; if (conversation !== channel.conversationId) { postRows.clear(); conversation = channel.conversationId; postId = null; current = null; posts = []; void refresh(); } else if (current || !postId) draw(); },
    hide() { postRows.clear(); drawSignature = detailSignature = ''; richEditor.unmount(); root.hidden = true; conversation = null; postId = null; current = null; requestId++; composePanel.hidden = true; },
    refreshMedia(selector){if(!root.querySelector(selector))return;postRows.clear();drawSignature=detailSignature='';draw();},
    refresh,
  };
}
