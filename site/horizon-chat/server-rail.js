export function createServerRail({ root, request, renderServer, encodeImage, onError }) {
  let layout = [], servers = [], pending = 0, generation = 0, dragging = null;
  let queue = Promise.resolve();
  let renderedSignature = '', renderKey = '';
  const dialog = document.createElement('dialog');
  dialog.className = 'server-folder-editor';
  dialog.innerHTML = `<form method="dialog"><h2>Server folder</h2><label>Name<input name="folderName" maxlength="60" required></label><label>Folder image<input name="image" type="file" accept="image/*"></label><img class="folder-image-preview" alt="Folder preview" hidden><label class="folder-remove-image"><input name="removeImage" type="checkbox"> Remove image</label><p class="folder-editor-error" role="status"></p><footer><button type="button" class="folder-ungroup">Ungroup servers</button><button value="cancel" formnovalidate>Cancel</button><button type="submit" value="save">Save</button></footer></form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  let editing = null;
  function normalize() {
    const available = new Set(servers.map(s => s.id)), seen = new Set();
    const take = id => available.has(id) && !seen.has(id) && (seen.add(id), true);
    layout = layout.flatMap(entry => entry.serverId !== undefined
      ? take(entry.serverId) ? [entry] : []
      : [{ ...entry, servers: entry.servers.filter(take) }]).filter(entry => entry.serverId !== undefined || entry.servers.length);
    for (const server of servers) if (!seen.has(server.id)) layout.push({ serverId: server.id });
  }
  function persist() {
    const snapshot = structuredClone(layout), epoch = generation;
    pending++;
    queue = queue.catch(() => {}).then(() => epoch === generation ? request('server-layout', { layout: snapshot }) : null)
      .catch(onError).finally(() => { if (epoch === generation) pending--; });
  }
  function extract(source) {
    if (source.folderId) {
      const index = layout.findIndex(e => e.folderId === source.folderId);
      return index < 0 ? null : layout.splice(index, 1)[0];
    }
    for (let i = 0; i < layout.length; i++) {
      const entry = layout[i];
      if (entry.serverId === source.serverId) return layout.splice(i, 1)[0];
      if (entry.servers?.includes(source.serverId)) {
        entry.servers.splice(entry.servers.indexOf(source.serverId), 1);
        if (!entry.servers.length) layout.splice(i, 1);
        return { serverId: source.serverId };
      }
    }
    return null;
  }
  function move(target, edge = '') {
    if (!dragging || (target && (dragging.serverId === target.serverId && dragging.serverId !== undefined || dragging.folderId === target.folderId && dragging.folderId))) return;
    if (dragging.folderId && (!edge || target?.nested)) return;
    const item = extract(dragging);
    if (!item) return;
    if (!target) layout.push(item);
    else if (edge) {
      const parent = layout.find(e => e.servers?.includes(target.serverId));
      if (parent && item.serverId !== undefined) parent.servers.splice(parent.servers.indexOf(target.serverId) + (edge === 'after' ? 1 : 0), 0, item.serverId);
      else {
        const index = layout.findIndex(e => target.folderId ? e.folderId === target.folderId : e.serverId === target.serverId);
        layout.splice(index < 0 ? layout.length : index + (edge === 'after' ? 1 : 0), 0, item);
      }
    } else if (target.folderId) {
      const folder = layout.find(e => e.folderId === target.folderId);
      if (folder) { folder.servers.push(item.serverId); folder.open = true; }
      else layout.push(item);
    } else {
      const parent = layout.find(e => e.servers?.includes(target.serverId));
      if (parent) parent.servers.splice(parent.servers.indexOf(target.serverId) + 1, 0, item.serverId);
      else {
        const index = layout.findIndex(e => e.serverId === target.serverId);
        layout.splice(index, 1, { folderId: crypto.randomUUID(), name: 'Server folder', image: '', open: true, servers: [target.serverId, item.serverId] });
      }
    }
    dragging = null; normalize(); draw(); persist();
  }
  function draggable(node, item) {
    node.draggable = true;
    node.addEventListener('dragstart', event => {
      dragging = item; event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/x-horizon-server', JSON.stringify(item));
      node.classList.add('server-dragging');
    });
    node.addEventListener('dragend', () => { dragging = null; root.querySelectorAll('.server-drop-target,.server-dragging').forEach(n => n.classList.remove('server-drop-target', 'server-dragging')); });
  }
  function target(node, item, edge = '') {
    node.addEventListener('dragover', event => { if (!dragging || (dragging.folderId && (!edge || item?.nested))) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; node.classList.add('server-drop-target'); });
    node.addEventListener('dragleave', () => node.classList.remove('server-drop-target'));
    node.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); node.classList.remove('server-drop-target'); move(item, edge); });
  }
  function gap(item, edge) {
    const node = document.createElement('div'); node.className = 'server-drop-gap'; node.setAttribute('aria-hidden', 'true'); target(node, item, edge); return node;
  }
  function serverButton(id) {
    const server = servers.find(s => s.id === id); const node = renderServer(server);
    draggable(node, { serverId: id }); target(node, { serverId: id });
    node.title += ' · Drag to rearrange or group';
    return node;
  }
  function edit(folder) {
    editing = folder.folderId; form.reset(); form.elements.folderName.value = folder.name;
    const preview = form.querySelector('img'); preview.hidden = !folder.image; preview.src = folder.image || '';
    form.querySelector('[role="status"]').textContent = ''; dialog.showModal();
  }
  form.elements.image.onchange = () => {
    const file = form.elements.image.files[0];
    if (file) { const preview = form.querySelector('img'); const url = URL.createObjectURL(file); preview.onload = () => URL.revokeObjectURL(url); preview.src = url; preview.hidden = false; }
  };
  form.querySelector('.folder-ungroup').onclick = () => {
    const index = layout.findIndex(e => e.folderId === editing);
    if (index >= 0) layout.splice(index, 1, ...layout[index].servers.map(serverId => ({ serverId })));
    dialog.close(); draw(); persist();
  };
  form.onsubmit = async event => {
    if (event.submitter?.value !== 'save') return;
    event.preventDefault(); const folder = layout.find(e => e.folderId === editing); if (!folder) return dialog.close();
    try {
      const file = form.elements.image.files[0];
      const image = file ? await encodeImage(file, 'avatar') : form.elements.removeImage.checked ? '' : folder.image;
      folder.name = form.elements.folderName.value.trim() || 'Server folder'; folder.image = image;
      dialog.close(); draw(); persist();
    } catch (error) { form.querySelector('[role="status"]').textContent = error.message; }
  };
  function draw() {
    const signature = JSON.stringify([layout, servers, renderKey]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    const nodes = [];
    for (const item of layout) {
      nodes.push(gap(item, 'before'));
      if (item.serverId !== undefined) nodes.push(serverButton(item.serverId));
      else {
        const group = document.createElement('div'); group.className = 'server-folder'; group.dataset.folder = item.folderId;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'rail-control server-folder-toggle';
        button.title = item.name + ' · Right-click to customize'; button.setAttribute('aria-label', item.name); button.setAttribute('aria-expanded', String(item.open));
        if (item.image) { const img = document.createElement('img'); img.src = item.image; img.alt = ''; button.append(img); }
        else { const preview = document.createElement('span'); preview.className = 'folder-server-preview';
          for (const id of item.servers.slice(0, 4)) { const server = servers.find(s => s.id === id); const cell = document.createElement('span'); cell.textContent = server.name.slice(0, 2); preview.append(cell); }
          button.append(preview);
        }
        const arrow = document.createElement('span'); arrow.className = 'folder-chevron'; arrow.textContent = item.open ? '▾' : '▸'; button.append(arrow);
        button.onclick = () => { item.open = !item.open; draw(); persist(); };
        button.oncontextmenu = event => { event.preventDefault(); edit(item); };
        button.onkeydown = event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); edit(item); } };
        draggable(button, { folderId: item.folderId }); target(button, { folderId: item.folderId }); group.append(button);
        if (item.open) { const children = document.createElement('div'); children.className = 'server-folder-children'; for (const id of item.servers) children.append(gap({ serverId: id, nested: true }, 'before'), serverButton(id));
          children.append(gap({ serverId: item.servers.at(-1), nested: true }, 'after'));  group.append(children); }
        nodes.push(group);
      }
    }
    nodes.push(gap(null, 'after')); root.replaceChildren(...nodes);
  }
  return {
    update(nextServers, nextLayout, nextRenderKey = '') { renderKey = nextRenderKey; servers = nextServers; if (nextLayout && !pending) layout = nextLayout; normalize(); draw(); },
    reset() { renderedSignature = ''; generation++; pending = 0; layout = []; servers = []; dragging = null; dialog.close(); root.replaceChildren(); },
  };
}
