const symbols = { point: '●', settlement: '▦', landmark: '◆', water: '◈' };
const byId = id => document.getElementById(id);

function containsPoint(points, [x, y]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function button(label, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.onclick = action;
  return element;
}

export function createChannelMap({ request, encodeImage, openChat, showDetails }) {
  const root = byId('channel-map');
  const viewport = byId('map-viewport');
  const stage = byId('map-stage');
  const background = byId('map-background');
  const canvas = byId('map-regions');
  const markers = byId('map-points');
  const details = byId('map-details');
  const menu = byId('map-menu');
  const locations = byId('map-locations');
  const file = byId('map-background-file');
  const status = byId('map-status');
  const finish = byId('map-finish');
  const cancel = byId('map-cancel');
  let conversation = null;
  let channels = [];
  let state = null;
  let selected = null;
  let draft = null;
  let placement = null;
  let drawing = null;
  let dirty = false;
  let menuTarget;
  let revision = 0;
  let saving = false;
  let zoom = 1;
  let pan = [0, 0];
  let dragging = null;
  let featureDrag = null;
  const pendingMoves = new Map();
  let suppressClick = false;

  const route = id => 'conversations/' + id + '/map';
  const getItem = id => state?.items.find(item => item.id === id);
  function pointAt(event, clamp = false) {
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const point = [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height];
    if (clamp) return point.map(value => Math.max(0, Math.min(1, value)));
    return point.every(value => value >= 0 && value <= 1) ? point : null;
  }

  const shownPoints = item => featureDrag && featureDrag.item.id === item.id ? featureDrag.points
    : pendingMoves.get(item.id) ?? item.points;

  function paint() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    const polygon = (points, color, provisional, current) => {
      if (!points.length) return;
      ctx.beginPath();
      points.forEach(([x, y], index) => index ? ctx.lineTo(x * width, y * height) : ctx.moveTo(x * width, y * height));
      if (!provisional) ctx.closePath();
      ctx.lineWidth = (current ? 3 : 2) / zoom;
      ctx.strokeStyle = color;
      ctx.setLineDash(provisional ? [6 / zoom, 4 / zoom] : []);
      ctx.fillStyle = color + (current ? '56' : '33');
      if (points.length >= 3) ctx.fill();
      ctx.stroke();
      if (provisional) for (const [x, y] of points) {
        ctx.beginPath();
        ctx.arc(x * width, y * height, 4 / zoom, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    };
    for (const item of state?.items || []) {
      if (item.kind === 'region') {
        polygon(shownPoints(item), item.color, false, item.id === selected);
      }
    }
    if (draft?.kind === 'region') polygon(draft.points, draft.color, false, true);
    if (drawing) polygon(drawing, '#ffca78', true, true);
  }

  function layout() {
    if (root.hidden || !viewport.clientWidth || !viewport.clientHeight) return;
    const aspect = state?.background && background.naturalWidth ? background.naturalWidth / background.naturalHeight : 16 / 9;
    const width = Math.max(1, Math.min(viewport.clientWidth - 24, (viewport.clientHeight - 24) * aspect));
    stage.style.width = width + 'px';
    stage.style.height = width / aspect + 'px';
    stage.style.transform = 'translate(-50%, -50%) translate(' + pan[0] + 'px,' + pan[1] + 'px) scale(' + zoom + ')';
    stage.style.setProperty('--marker-scale', String(1 / zoom));
    paint();
  }
  new ResizeObserver(layout).observe(viewport);
  background.onload = layout;
  background.onerror = () => { status.textContent = 'Could not load the map image.'; };

  function position(marker, [x, y]) {
    marker.style.left = x * 100 + '%';
    marker.style.top = y * 100 + '%';
  }

  function renderItems() {
    const items = state?.items || [];
    if (locations.length !== items.length + 1 || items.some((item, index) => {
      const option = locations.options[index + 1];
      return option.value !== String(item.id) || option.text !== item.title;
    })) {
      locations.replaceChildren(new Option('Map locations', ''), ...items.map(item => new Option(item.title, item.id)));
    }
    locations.value = selected ?? '';
    const points = (draft ? [...items, draft] : items).filter(item => item.kind !== 'region');
    const existing = new Map([...markers.children].map(marker => [marker.dataset.renderKey, marker]));
    const elements = points.map(item => {
      const key = String(item.id ?? 'draft');
      const marker = existing.get(key) || button('', null);
      marker.dataset.renderKey = key;
      marker.textContent = item.kind === 'label' ? item.title : symbols[item.symbol];
      marker.onclick = () => {
        if (!placement && !drawing && item.id) select(item.id);
      };
      marker.className = 'map-marker map-' + item.kind;
      marker.classList.toggle('map-selected', item.id === selected || item === draft);
      marker.classList.toggle('map-draggable', Boolean(item.id && item.editable));
      marker.dataset.mapItem = item.id ?? '';
      position(marker, shownPoints(item)[0]);
      marker.style.setProperty('--marker-color', item.color);
      marker.title = item.title;
      marker.setAttribute('aria-label', item.title);
      return marker;
    });
    const area = getItem(selected);
    if (area?.kind === 'region' && area.editable) {
      elements.push(...shownPoints(area).map((point, index) => {
        const key = area.id + ':' + index;
        const handle = existing.get(key) || button('', null);
        handle.dataset.renderKey = key;
        handle.className = 'map-marker map-corner map-draggable';
        handle.dataset.mapItem = area.id;
        handle.dataset.mapCorner = index;
        handle.setAttribute('aria-label', 'Drag corner ' + (index + 1));
        handle.style.setProperty('--marker-color', area.color);
        position(handle, point);
        return handle;
      }));
    }
    const retained = new Set(elements);
    for (const marker of existing.values()) if (!retained.has(marker)) marker.remove();
    for (const marker of elements) if (marker.parentElement !== markers) markers.append(marker);
    updateControls();
    layout();
  }

  function updateControls() {
    const inProgress = Boolean(placement || drawing);
    byId('map-tools').hidden = !state?.canCreate;
    byId('map-empty').hidden = !state || Boolean(state.background || state.items.length || draft || inProgress);
    byId('map-add-background').hidden = !state?.canManage;
    byId('map-add-background').disabled = saving;
    locations.disabled = !state?.items.length;
    finish.hidden = !drawing;
    finish.disabled = (drawing?.length || 0) < 3;
    cancel.hidden = !inProgress;
    viewport.toggleAttribute('data-placing', inProgress);
  }

  function renderDetails() {
    const item = draft || getItem(selected);
    details.hidden = !item;
    showDetails(Boolean(item));
    details.replaceChildren();
    if (!item) return;
    const title = document.createElement('h2');
    title.textContent = draft ? 'New ' + item.kind : item.title;
    const close = button('×', () => select(null));
    close.setAttribute('aria-label', 'Close map details');
    const header = document.createElement('header');
    header.append(title, close);
    details.append(header);
    if (item.image) {
      const image = document.createElement('img');
      image.className = 'map-detail-image';
      image.src = item.image;
      image.alt = item.title;
      details.append(image);
    }
    if (item.description) {
      const description = document.createElement('p');
      description.className = 'map-description';
      description.textContent = item.description;
      details.append(description);
    }
    const linked = channels.filter(channel => item.links.includes(channel.conversationId));
    if (linked.length) {
      const travel = document.createElement('div');
      travel.className = 'map-linked-chats';
      const destination = document.createElement('select');
      if (linked.length > 1) {
        destination.setAttribute('aria-label', 'Travel destination');
        destination.append(...linked.map(channel => new Option(channel.name, channel.conversationId)));
        travel.append(destination);
      }
      const go = button('Travel To', () => openChat(linked.length === 1 ? linked[0].conversationId : Number(destination.value)));
      if (linked.length === 1) go.title = linked[0].name;
      travel.append(go);
      details.append(travel);
    }
    if (!item.editable) return;
    const form = document.createElement('form');
    form.className = 'map-details-form';
    form.innerHTML = `
      <label>Name <input name="title" maxlength="80" required></label>
      <label>Description <textarea name="description" maxlength="2500" rows="4"></textarea></label>
      <label>Color <input name="color" type="color"></label>
      <label data-pin-options>Symbol <select name="symbol">
        <option value="point">Point</option><option value="settlement">Settlement</option>
        <option value="landmark">Landmark</option><option value="water">Water</option>
      </select></label>
      <fieldset class="map-link-picker"><legend>Linked chats</legend><div></div></fieldset>
      <label>Image <input name="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
      <label class="map-checkbox" data-map-remove-image><input name="removeImage" type="checkbox"> Remove image</label>
      <div class="map-detail-actions"><button type="submit">Save</button></div>
      <p class="map-detail-status" role="status"></p>`;
    form.elements.title.value = item.title;
    form.elements.description.value = item.description;
    form.elements.color.value = item.color;
    form.elements.symbol.value = item.symbol;
    form.querySelector('[data-pin-options]').hidden = item.kind !== 'pin';
    form.querySelector('[data-map-remove-image]').hidden = !item.image;
    const linkList = form.querySelector('.map-link-picker div');
    for (const channel of channels) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'links';
      checkbox.value = channel.conversationId;
      checkbox.checked = item.links.includes(channel.conversationId);
      label.append(checkbox, channel.name);
      linkList.append(label);
    }
    if (!channels.length) linkList.textContent = 'No other chats are available.';
    const resultStatus = form.querySelector('[role=status]');
    form.oninput = () => { dirty = true; };
    form.onsubmit = async event => {
      event.preventDefault();
      const data = new FormData(form);
      const image = form.elements.image.files[0];
      await save({
        action: item.id ? 'update' : 'create', id: item.id, kind: item.kind, points: item.id ? undefined : item.points,
        title: data.get('title'), description: data.get('description'), color: data.get('color'),
        symbol: data.get('symbol'), links: data.getAll('links').map(Number),
        image: data.has('removeImage') ? '' : undefined,
      }, image, resultStatus);
    };
    if (item.id) form.querySelector('.map-detail-actions').append(button('Delete', () => {
      void save({ action: 'delete', id: item.id }, null, resultStatus);
    }));
    details.append(form);
  }

  function select(id) {
    selected = id;
    draft = null;
    dirty = false;
    drawing = placement = null;
    renderItems();
    renderDetails();
  }
  locations.onchange = () => select(Number(locations.value) || null);

  async function refresh() {
    if (!conversation) return;
    const target = conversation;
    const ticket = ++revision;
    try {
      const next = await request(route(target));
      if (revision !== ticket || target !== conversation) return;
      state = next;
      const url = state.background;
      background.hidden = !url;
      if (url && background.getAttribute('src') !== url) background.src = url;
      else if (!url) background.removeAttribute('src');
      if (selected && !getItem(selected)) select(null);
      else {
        if (!featureDrag) renderItems();
        if (!dirty && !featureDrag) renderDetails();
      }
    } catch (error) {
      if (conversation === target && revision === ticket) status.textContent = error.message;
    }
  }

  async function save(data, image, destination = status) {
    if (!conversation || saving) return;
    const target = conversation;
    saving = true;
    destination.textContent = '';
    try {
      if (image) data.image = await encodeImage(image);
      if (target !== conversation) return;
      const result = await request(route(target), data);
      if (target !== conversation) return;
      dirty = false;
      draft = null;
      if (result.itemId) selected = result.itemId;
      if (data.action === 'delete') selected = null;
      await refresh();
    } catch (error) {
      if (target === conversation) destination.textContent = error.message;
    } finally {
      saving = false;
    }
  }

  function createDraft(kind, points) {
    selected = null;
    draft = { kind, points, color: '#d774bf', title: kind === 'pin' ? 'New pin' : '', description: '', symbol: 'point', links: [], editable: true };
    dirty = true;
    placement = drawing = null;
    status.textContent = '';
    renderItems();
    renderDetails();
    const title = details.querySelector('input[name="title"]');
    title?.focus();
    title?.select();
  }

  function finishPlacement() {
    if (drawing?.length >= 3) createDraft('region', drawing);
  }

  finish.onclick = finishPlacement;
  cancel.onclick = () => {
    placement = drawing = null;
    status.textContent = '';
    renderItems();
  };

  function menuAt(x, y, point = null, item = null) {
    if (!state || (!item && !state.canCreate)) return;
    menuTarget = { point, item };
    for (const action of menu.querySelectorAll('[data-map-action]')) {
      const value = action.dataset.mapAction;
      action.hidden = value === 'details' ? !item : item ? true : value === 'background' ? !state.canManage
        : value === 'remove-background' ? !state.canManage || !state.background : !state.canCreate;
    }
    menu.hidePopover();
    menu.showPopover();
    menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth)) + 'px';
    menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight)) + 'px';
    menu.querySelector('button:not([hidden])')?.focus();
  }

  byId('map-tools').onclick = event => {
    const bounds = event.currentTarget.getBoundingClientRect();
    menuAt(bounds.left, bounds.bottom);
  };
  byId('map-add-background').onclick = () => file.click();
  menu.onclick = event => {
    const action = event.target.closest('[data-map-action]')?.dataset.mapAction;
    if (!action || !menuTarget) return;
    const { item, point } = menuTarget;
    menu.hidePopover();
    if (action === 'details') return select(item.id);
    if (action === 'background') return file.click();
    if (action === 'remove-background') return void save({ action: 'background', image: '' });
    if (action === 'region') {
      drawing = point ? [point] : [];
      placement = null;
      status.textContent = 'Click each corner, then choose Finish region.';
    } else if (point) {
      createDraft(action, [point]);
    } else {
      drawing = null;
      placement = action;
      status.textContent = 'Click the map to place the ' + action + '.';
    }
    renderItems();
  };
  file.onchange = () => {
    const image = file.files[0];
    file.value = '';
    if (image) void save({ action: 'background' }, image);
  };

  viewport.ondragover = event => {
    if (state?.canManage && event.dataTransfer.types.includes('Files')) event.preventDefault();
  };
  viewport.ondrop = event => {
    if (!state?.canManage || !event.dataTransfer.files.length) return;
    event.preventDefault();
    void save({ action: 'background' }, event.dataTransfer.files[0]);
  };

  function regionAt(point) {
    return state?.items.findLast(item => item.kind === 'region' && containsPoint(item.points, point));
  }
  viewport.oncontextmenu = event => {
    const point = pointAt(event);
    if (drawing || placement) {
      event.preventDefault();
      return;
    }
    const item = getItem(Number(event.target.closest('[data-map-item]')?.dataset.mapItem)) || (point && regionAt(point));
    if (!item && !state?.canCreate) return;
    event.preventDefault();
    menuAt(event.clientX, event.clientY, point, item);
  };
  viewport.onclick = event => {
    const point = pointAt(event);
    if (!point || event.altKey || (!placement && !drawing && event.target.closest('button'))) return;
    if (placement) createDraft(placement, [point]);
    else if (drawing) {
      if (drawing.length < 64) drawing.push(point);
      updateControls();
      paint();
    } else {
      const item = regionAt(point);
      if (item) select(item.id);
    }
  };
  viewport.onkeydown = event => {
    if (event.key === 'Escape' && (placement || drawing)) cancel.click();
    if (event.key === 'Enter' && drawing) finishPlacement();
  };

  function setZoom(value) {
    zoom = Math.max(1, Math.min(4, value));
    if (zoom === 1) pan = [0, 0];
    layout();
  }
  byId('map-zoom-in').onclick = () => setZoom(zoom * 1.35);
  byId('map-zoom-out').onclick = () => setZoom(zoom / 1.35);
  byId('map-reset').onclick = () => setZoom(1);
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  viewport.addEventListener('click', event => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  viewport.onpointerdown = event => {
    const marker = event.target.closest('.map-draggable');
    const item = marker && getItem(Number(marker.dataset.mapItem));
    if (event.button === 0 && !event.altKey && item?.editable && !placement && !drawing && !saving && !pendingMoves.has(item.id)) {
      featureDrag = {
        item, marker, index: Number(marker.dataset.mapCorner ?? 0), points: [...item.points],
        pointer: event.pointerId, start: [event.clientX, event.clientY], moved: false,
      };
      return;
    }
    if (zoom === 1 || (event.button !== 1 && !(event.button === 0 && event.altKey))) return;
    event.preventDefault();
    dragging = { x: event.clientX, y: event.clientY };
    viewport.setPointerCapture(event.pointerId);
  };
  viewport.onpointermove = event => {
    const drag = featureDrag;
    if (drag && drag.pointer === event.pointerId) {
      const [x, y] = drag.start;
      if (!drag.moved && Math.hypot(event.clientX - x, event.clientY - y) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        viewport.setPointerCapture(event.pointerId);
      }
      const point = pointAt(event, true);
      if (point) {
        drag.points[drag.index] = point;
        position(drag.marker, point);
        paint();
      }
      return;
    }
    if (!dragging) return;
    const maxX = (viewport.clientWidth + stage.clientWidth * zoom) / 2 - 40;
    const maxY = (viewport.clientHeight + stage.clientHeight * zoom) / 2 - 40;
    pan = [Math.max(-maxX, Math.min(maxX, pan[0] + event.clientX - dragging.x)),
      Math.max(-maxY, Math.min(maxY, pan[1] + event.clientY - dragging.y))];
    dragging = { x: event.clientX, y: event.clientY };
    layout();
  };
  viewport.onpointerup = event => {
    const drag = featureDrag;
    if (!drag || drag.pointer !== event.pointerId) return;
    featureDrag = null;
    if (!drag.moved) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    void commitGeometry(drag);
  };
  viewport.onpointerleave = () => {
    if (featureDrag && !featureDrag.moved) featureDrag = null;
  };
  viewport.onpointercancel = viewport.onlostpointercapture = () => {
    dragging = null;
    if (featureDrag) {
      featureDrag = null;
      renderItems();
    }
  };

  async function commitGeometry(drag) {
    const target = conversation;
    if (!target) return;
    const { id } = drag.item;
    pendingMoves.set(id, drag.points);
    status.textContent = '';
    try {
      await request(route(target), { action: 'move', id, points: drag.points });
    } catch (error) {
      if (conversation === target) status.textContent = error.message;
    } finally {
      pendingMoves.delete(id);
      if (conversation === target) await refresh();
    }
  }

  return {
    show(id, available) {
      root.hidden = false;
      channels = available.filter(channel => channel.conversationId !== id);
      if (conversation === id) return;
      conversation = id;
      featureDrag = null;
      state = null;
      status.textContent = '';
      background.hidden = true;
      background.removeAttribute('src');
      setZoom(1);
      select(null);
      void refresh();
    },
    hide() {
      root.hidden = true;
      menu.hidePopover();
      if (conversation !== null) {
        conversation = null;
        featureDrag = null;
        state = null;
        select(null);
      }
    },
    refresh,
  };
}

