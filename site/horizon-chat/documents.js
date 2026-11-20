import { apiUrl } from './platform.js';
import { advertiseChunk, peerChunk, peerEnabled } from './attachment-peers.js';
const $ = id => document.getElementById(id);
const formatSize = bytes => bytes < 1024 ? bytes + ' B'
  : bytes < 1_048_576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1_048_576).toFixed(1) + ' MB';

export async function readChunk(url, offset, limit, signal, clientDecodes = false) {
  const target = url + '?offset=' + offset + (clientDecodes ? '&encoding=gzip' : '');
  const timeout = ms => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  let response;
  if (clientDecodes && peerEnabled(limit)) {
    const cached = await fetch(target, { headers: { 'X-Horizon-Cache-Only': '1' }, signal: timeout(1500) }).catch(() => null);
    if (cached?.ok) response = cached;
    else {
      const direct = await peerChunk(url, offset, limit, signal);
      if (direct) response = new Response(direct);
    }
  }
  response ??= await fetch(target, { signal: timeout(8000) });
  if (!response.ok) throw new Error('Could not load this file.');
  const chunk = clientDecodes
    ? await new Response(response.body.pipeThrough(new DecompressionStream('gzip'), { signal })).arrayBuffer()
    : await response.arrayBuffer();
  if (!chunk.byteLength || offset + chunk.byteLength > limit) throw new Error('Incomplete file response.');
  if (clientDecodes) advertiseChunk(url, offset);
  return chunk;
}

const pauseBetweenChunks = () => new Promise(resolve => setTimeout(resolve, 69));

export function createDocumentReader(highlight) {
  const reader = $('document-reader');
  const status = $('document-status');
  const more = $('document-more');
  const all = $('document-all');
  const copy = $('document-copy');
  const download = $('document-download');
  const image = $('document-image');
  let active;
  const mediaCache = new Map();
  const mediaUrls = new Set();
  const previews = new WeakMap();
  let loadingMedia = 0;
  const mediaQueue = [];
  function runMedia(task) {
    return new Promise((resolve, reject) => {
      mediaQueue.push({ task, resolve, reject });
      drainMedia();
    });
  }
  function drainMedia() {
    while (loadingMedia < 2 && mediaQueue.length) {
      const { task, resolve, reject } = mediaQueue.shift();
      loadingMedia++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => { loadingMedia--; drainMedia(); });
    }
  }
  const observer = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting && target.isConnected) continue;
      observer.unobserve(target);
      if (target.isConnected) void previews.get(target)?.();
    }
  }, { rootMargin: '120px' });

  function update(view) {
    const done = view.offset === view.file.bytes;
    more.disabled = all.disabled = view.busy || done;
    copy.disabled = view.busy || !view.offset;
    download.disabled = view.busy;
    copy.textContent = done ? 'Copy file text' : 'Copy loaded text';
    status.textContent = done ? 'Full file loaded' : !view.offset && !view.busy && view.file.mime
      ? formatSize(view.file.bytes) : 'Loaded ' + formatSize(view.offset) + ' of ' + formatSize(view.file.bytes);
  }

  function paint(view) {
    if (view !== active) return;
    if (view.file.mime) {
      if (view.file.mime.startsWith('image/') && view.offset === view.file.bytes && !view.imageUrl) {
        view.imageUrl = URL.createObjectURL(new Blob(view.chunks, { type: view.file.mime }));
        image.src = view.imageUrl;
        image.hidden = false;
      }
      return;
    }
    const code = document.createElement('code');
    code.id = 'document-content';
    code.textContent = view.text;
    $('document-content').replaceWith(code);
    if (view.offset <= 65_536) highlight(code, view.file.language);
  }

  async function load(view, full) {
    if (!view || view.busy) return false;
    if (view.offset === view.file.bytes) return true;
    view.busy = true;
    update(view);
    let failure = '';
    try {
      do {
        const chunk = await readChunk(view.url, view.offset, view.file.bytes, view.controller.signal);
        view.chunks.push(chunk);
        view.offset += chunk.byteLength;
        if (!view.file.mime) view.text += view.decoder.decode(chunk, { stream: view.offset < view.file.bytes });
        if (view === active) update(view);
        if (full && view.offset < view.file.bytes) await pauseBetweenChunks();
      } while (full && !view.controller.signal.aborted && view.offset < view.file.bytes);
      return view === active;
    } catch (error) {
      failure = error.message;
      return false;
    } finally {
      view.busy = false;
      if (view === active) {
        paint(view);
        update(view);
        if (failure) status.textContent = failure;
      }
    }
  }

  function close() {
    active?.controller.abort();
    if (active?.imageUrl) URL.revokeObjectURL(active.imageUrl);
    image.removeAttribute('src');
    image.hidden = true;
    active = undefined;
    reader.close();
  }

  function open(file, url, full = false) {
    if (active) close();
    active = {
      file, url, offset: 0, text: '', chunks: [],
      decoder: new TextDecoder(), controller: new AbortController(), busy: false,
    };
    $('document-title').textContent = file.name;
    image.alt = file.name;
    const pre = reader.querySelector('pre');
    pre.hidden = Boolean(file.mime);
    pre.scrollTop = 0;
    more.hidden = all.hidden = copy.hidden = Boolean(file.mime);
    paint(active);
    if (!reader.open) reader.showModal();
    update(active);
    if (!file.mime || file.mime.startsWith('image/')) void load(active, full || Boolean(file.mime));
  }

  reader.addEventListener('close', () => { if (!reader.open) close(); });
  more.onclick = () => load(active, false);
  all.onclick = () => load(active, true);
  copy.onclick = async () => {
    const view = active;
    try {
      await navigator.clipboard.writeText(view.text);
      if (view === active) status.textContent = 'Copied.';
    } catch {
      if (view === active) status.textContent = 'Could not copy the file text.';
    }
  };
  download.onclick = async () => {
    const view = active;
    if (!await load(view, true) || view !== active) return;
    const url = URL.createObjectURL(new Blob(view.chunks, { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = view.file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  function codePreview(file, endpoint) {
    const card = document.createElement('div');
    card.className = 'msgbody code-preview';
    const block = document.createElement('div');
    block.className = 'code-wrap';
    const header = document.createElement('div');
    header.className = 'code-head';
    const language = document.createElement('span');
    language.textContent = file.language === 'plaintext' ? 'Plain text' : file.language;
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'copy-code';
    all.textContent = 'View all';
    const url = endpoint + '/document';
    header.append(language, all);
    const pre = document.createElement('pre');
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', 'Code preview');
    const code = document.createElement('code');
    code.textContent = 'Loading preview…';
    pre.append(code);
    block.append(header, pre);
    card.append(block);
    let firstChunk;
    let fullText;
    let expanded = false;
    const first = () => {
      if (!firstChunk) {
        firstChunk = readChunk(url, 0, file.bytes, undefined, true).catch(error => {
          firstChunk = null;
          throw error;
        });
      }
      return firstChunk;
    };
    function paintCode(source) {
      const output = document.createElement('code');
      output.textContent = source;
      pre.replaceChildren(output);
      highlight(output, file.language);
    }
    async function showPreview() {
      try {
        const chunk = await first();
        if (!expanded) paintCode(new TextDecoder().decode(chunk, { stream: chunk.byteLength < file.bytes }));
      } catch (error) {
        if (!expanded) paintCode(error.message);
      }
    }
    all.setAttribute('aria-expanded', 'false');
    all.onclick = async () => {
      if (expanded) {
        expanded = false;
        card.classList.remove('code-expanded');
        all.textContent = 'View all';
        all.setAttribute('aria-expanded', 'false');
        await showPreview();
        return;
      }
      all.disabled = true;
      all.textContent = 'Loading…';
      try {
        if (fullText === undefined) {
          const decoder = new TextDecoder();
          const initial = await first();
          let offset = initial.byteLength;
          const parts = [decoder.decode(initial, { stream: offset < file.bytes })];
          while (offset < file.bytes) {
            await pauseBetweenChunks();
            if (!card.isConnected) return;
            const part = await readChunk(url, offset, file.bytes, undefined, true);
            offset += part.byteLength;
            parts.push(decoder.decode(part, { stream: offset < file.bytes }));
          }
          fullText = parts.join('');
        }
        expanded = true;
        card.classList.add('code-expanded');
        pre.scrollTop = pre.scrollLeft = 0;
        all.setAttribute('aria-expanded', 'true');
        paintCode(fullText);
      } catch (error) {
        paintCode(error.message);
      } finally {
        all.disabled = false;
        all.textContent = expanded ? 'Collapse' : 'View all';
      }
    };
    previews.set(card, showPreview);
    observer.observe(card);
    return card;
  }

  function mediaUrl(file, endpoint) {
    const key = endpoint + ':' + (file.thumbnailRevision || '') + ':' + file.bytes;
    const cached = mediaCache.get(key);
    if (cached) return cached.promise;
    const controller = new AbortController();
    const entry = { controller, url: null };
    entry.promise = runMedia(async () => {
      const parts = [];
      let offset = 0;
      while (offset < file.bytes) {
        controller.signal.throwIfAborted();
        const part = await readChunk(endpoint + '/document', offset, file.bytes, controller.signal, typeof DecompressionStream !== 'undefined');
        parts.push(part);
        offset += part.byteLength;
        if (offset < file.bytes) await pauseBetweenChunks();
      }
      controller.signal.throwIfAborted();
      entry.url = URL.createObjectURL(new Blob(parts, { type: file.mime }));
      mediaUrls.add(entry.url);
      return entry.url;
    }).catch(error => {
      if (mediaCache.get(key) === entry) mediaCache.delete(key);
      throw error;
    });
    mediaCache.set(key, entry);
    if (mediaCache.size > 12) {
      const completed = [...mediaCache.entries()].find(([, item]) => item.url);
      if (completed) mediaCache.delete(completed[0]);
    }
    return entry.promise;
  }

  function thumbnailUrl(file, endpoint) {
    return endpoint + '/thumbnail' + (file.thumbnailRevision ? '?v=' + file.thumbnailRevision : '');
  }

  function mediaCard(file, endpoint) {
    const video = file.mime.startsWith('video/');
    const card = document.createElement('div');
    card.className = 'media-attachment ' + (video ? 'video-attachment' : 'audio-attachment');
    const controls = document.createElement('div');
    controls.className = 'media-start';
    const kind = video ? 'video' : 'audio';
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'media-play';
    play.textContent = '▶';
    play.setAttribute('aria-label', 'Play ' + kind);
    if (video && file.thumbnail) {
      const frame = document.createElement('img');
      frame.src = thumbnailUrl(file, endpoint);
      frame.alt = '';
      frame.loading = 'lazy';
      frame.onerror = () => frame.remove();
      controls.append(frame);
    }
    controls.append(play);
    if (!video) {
      const track = document.createElement('span');
      track.className = 'audio-track';
      track.setAttribute('aria-hidden', 'true');
      controls.append(track);
    }
    const media = document.createElement(kind);
    media.controls = true;
    media.preload = 'none';
    media.hidden = true;
    if (video) media.playsInline = true;
    const feedback = document.createElement('span');
    feedback.className = 'media-feedback';
    feedback.setAttribute('role', 'status');
    media.onerror = () => {
      feedback.textContent = 'This browser could not play the ' + kind + '.';
    };
    play.onclick = async () => {
      play.disabled = true;
      feedback.textContent = 'Loading ' + kind + '…';
      try {
        media.src = await mediaUrl(file, endpoint);
        if (!card.isConnected) return;
        media.hidden = false;
        controls.hidden = true;
        feedback.textContent = '';
        await media.play();
      } catch (error) {
        feedback.textContent = media.error ? 'This browser could not play the ' + kind + '.'
          : media.hidden ? error.message : 'Press play to start.';
      } finally {
        play.disabled = false;
      }
    };
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Download';
    download.className = 'media-download';
    download.onclick = async () => {
      download.disabled = true;
      try {
        const url = await mediaUrl(file, endpoint);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        link.click();
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        download.disabled = false;
      }
    };
    if (document.documentElement.dataset.avLoading !== 'compact') {
      previews.set(card, async () => {
        feedback.textContent = 'Loading ' + kind + '�';
        try {
          const url = await mediaUrl(file, endpoint);
          if (!card.isConnected || document.documentElement.dataset.avLoading === 'compact') return;
          media.src = url;
          media.preload = 'metadata';
          media.hidden = false;
          controls.hidden = true;
          feedback.textContent = '';
        } catch { feedback.textContent = 'Press play to load this file.'; }
      });
      observer.observe(card);
    }
    card.append(controls, media, feedback, download);
    return card;
  }


  async function officeText(buffer,ext){
    const data=new Uint8Array(buffer),v=new DataView(buffer);let end=data.length-22;
    if(end<0)throw Error('Invalid document.');
    while(end>=Math.max(0,data.length-65557)&&v.getUint32(end,true)!==0x06054b50)end--;
    if(end<0||end<data.length-65557)throw Error('Invalid document package.');
    let pos=v.getUint32(end+16,true),count=v.getUint16(end+10,true);
    if(count>3000)throw Error('Document package is too large.');
    while(count--){
      if(pos+46>data.length||v.getUint32(pos,true)!==0x02014b50)throw Error('Invalid document package.');
      const flags=v.getUint16(pos+8,true),method=v.getUint16(pos+10,true),packed=v.getUint32(pos+20,true),size=v.getUint32(pos+24,true),len=v.getUint16(pos+28,true),local=v.getUint32(pos+42,true);
      const name=new TextDecoder().decode(data.subarray(pos+46,pos+46+len));pos+=46+len+v.getUint16(pos+30,true)+v.getUint16(pos+32,true);
      if(name!==(ext==='odt'?'content.xml':'word/document.xml'))continue;
      if(flags&1||![0,8].includes(method)||size>8000000||packed>8000000||local+30>data.length||v.getUint32(local,true)!==0x04034b50)throw Error('Encrypted or oversized document.');
      const start=local+30+v.getUint16(local+26,true)+v.getUint16(local+28,true);if(start+packed>data.length)throw Error('Incomplete document.');
      let stream=new Blob([data.subarray(start,start+packed)]).stream();if(method===8)stream=stream.pipeThrough(new DecompressionStream('deflate-raw'));
      const reader=stream.getReader(),chunks=[];let total=0;
      try{while(true){const p=await reader.read();if(p.done)break;total+=p.value.length;if(total>8000000)throw Error('Document text is too large.');chunks.push(p.value);}}finally{await reader.cancel().catch(()=>{});}
      const text=await new Blob(chunks).text();if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Unsafe document XML.');
      const xml=new DOMParser().parseFromString(text,'application/xml');if(xml.querySelector('parsererror'))throw Error('Invalid document XML.');
      return [...xml.getElementsByTagName('*')].filter(n=>['p','h'].includes(n.localName)).slice(0,3000).map(n=>n.textContent).filter(t=>t.trim()).join('\n\n').slice(0,500000);
    }throw Error('No document text was found.');
  }
  function officeCard(file,endpoint){
    const card=document.createElement('article');card.className='document-preview';
    const header=document.createElement('header'),name=document.createElement('strong'),expand=document.createElement('button'),download=document.createElement('button'),content=document.createElement('div');
    name.textContent=file.name;expand.type=download.type='button';expand.textContent='Expand';download.textContent='Download';header.append(name,expand,download);content.className='office-document';content.textContent='Loading document preview...';let loaded=false;
    async function show(){if(loaded)return;loaded=true;try{const url=await mediaUrl(file,endpoint);if(!card.isConnected)return;if(/\.pdf$/i.test(file.name)){const frame=document.createElement('iframe');frame.title=file.name;frame.src=url;frame.referrerPolicy='no-referrer';content.replaceChildren(frame);}else{const text=await officeText(await(await fetch(url)).arrayBuffer(),file.name.split('.').at(-1).toLowerCase());if(card.isConnected)content.textContent=text||'No text in this document.';}}catch(error){content.textContent=error.message+' Download the original file to view it.';loaded=false;}}
    expand.onclick=()=>{card.classList.toggle('document-preview-expanded');expand.textContent=card.classList.contains('document-preview-expanded')?'Collapse':'Expand';void show();};
    download.onclick=async()=>{download.disabled=true;try{const link=document.createElement('a');link.href=await mediaUrl(file,endpoint);link.download=file.name;link.click();}catch(error){content.textContent=error.message;}finally{download.disabled=false;}};
    card.append(header,content);if(document.documentElement.dataset.documentLoading!=='compact'){previews.set(card,show);observer.observe(card);}else content.textContent='Click Expand to load the document preview.';return card;
  }
  return {
    reset() {
      close();
      observer.disconnect();
      for (const entry of mediaCache.values()) {
        entry.controller.abort();
        if (entry.url) URL.revokeObjectURL(entry.url);
      }
      mediaCache.clear();
      for (const url of mediaUrls) URL.revokeObjectURL(url);
      mediaUrls.clear();
    },
    render(file, conversationId, messageId) {
      const endpoint = apiUrl('conversations/' + conversationId + '/messages/' + messageId);
      if (/\.(odt|docx|pdf)$/i.test(file.name)) return officeCard(file,endpoint);
      if (!file.mime) return codePreview(file, endpoint);
      if (/^(audio|video)\//.test(file.mime)) return mediaCard(file, endpoint);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'document-card';if(file.mime?.startsWith('image/'))button.dataset.mediaKind='image';
      const name = document.createElement('strong');
      name.textContent = file.name;
      const size = document.createElement('span');
      size.textContent = formatSize(file.bytes);
      const detail = document.createElement('span');
      detail.className = 'document-card-details';
      detail.append(name, size);
      if (file.thumbnail) {
        button.setAttribute('aria-label', 'Open image');
        button.classList.add('image-attachment');
        const preview = document.createElement('img');
        preview.src = thumbnailUrl(file, endpoint);
        preview.alt = '';
        preview.loading = 'lazy';
        preview.addEventListener('error', () => {
          preview.remove();
          button.classList.remove('image-attachment');
          button.append('Open image');
        }, { once: true });
        button.append(preview);
      } else if (file.mime?.startsWith('image/')) {
        button.textContent = 'Open image';
      } else button.append(detail);
      if(file.mime?.startsWith('image/') && document.documentElement.dataset.imageView!=='compact')button.classList.add('expanded-media');
      if (file.mime?.startsWith('image/') && document.documentElement.dataset.imageLoading !== 'compact') {
        let preview = button.querySelector('img');
        if (!preview) {
          preview = document.createElement('img');
          preview.alt = file.name;
          button.replaceChildren(preview);
        }
        previews.set(button, async () => {
          button.setAttribute('aria-busy', 'true');
          try {
            const url = await mediaUrl(file, endpoint);
            if (!button.isConnected || document.documentElement.dataset.imageLoading === 'compact') return;
            const decoded = new Image();
            decoded.src = url;
            await decoded.decode();
            if (button.isConnected) preview.src = url;
          } catch { button.title = 'Click to open or retry loading this image.'; }
          finally { button.removeAttribute('aria-busy'); }
        });
        observer.observe(button);
      }
      button.onclick = () => open(file, endpoint + '/document');
      return button;
    },
  };
}
