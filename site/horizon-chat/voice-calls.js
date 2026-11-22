const heartbeatMs = 12_000;
const inviteMs = 35_000;

export function setupVoiceCalls({ call, view, navigate }) {
  const $ = name => view.querySelector('[data-voice="' + name + '"]');
  const start = document.getElementById('voice-start');
  start.title = 'People in the call may see your IP address.';
  let scope, local, pending, invitation, enabled;
  let accountEpoch = 0;
  let invitationTimer;

  const settings = document.getElementById('voice-settings');
  const prefs = { input: '', output: '', outputVolume: 90, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('horizon.voice') || '{}')); } catch {}
  settings.querySelector('[data-voice-output]').hidden = !HTMLMediaElement.prototype.setSinkId;

  async function devices() {
    const available = await navigator.mediaDevices.enumerateDevices();
    for (const [key, kind] of [['input', 'audioinput'], ['output', 'audiooutput']]) {
      const field = settings.querySelector('[data-voice-pref="' + key + '"]');
      field.replaceChildren(new Option('System default', ''));
      for (const device of available.filter(item => item.kind === kind && item.deviceId && item.deviceId !== 'default')) {
        field.add(new Option(device.label || (key === 'input' ? 'Microphone ' : 'Speaker ') + field.length, device.deviceId));
      }
      field.value = prefs[key];
      if (field.selectedIndex < 0) field.selectedIndex = 0;
    }
  }

  for (const field of settings.querySelectorAll('[data-voice-pref]')) {
    const key = field.dataset.voicePref;
    if (field.type === 'checkbox') field.checked = prefs[key];
    else field.value = prefs[key];
    field.onchange = () => {
      prefs[key] = field.type === 'checkbox' ? field.checked : field.type === 'range' ? field.valueAsNumber : field.value;
      try { localStorage.setItem('horizon.voice', JSON.stringify(prefs)); } catch {}
      if (!local) return;
      if (key === 'input') status('Rejoin to use the selected microphone.');
      else if (key === 'output' || key === 'outputVolume') {
        for (const { audio } of local.links.values()) {
          audio.volume = prefs.outputVolume / 100;
          if (key === 'output' && audio.setSinkId) void audio.setSinkId(prefs.output).catch(() => status('This output device is unavailable.'));
        }
      } else {
        for (const track of local.stream.getAudioTracks()) void track.applyConstraints({
          channelCount: 1, echoCancellation: prefs.echoCancellation, noiseSuppression: prefs.noiseSuppression, autoGainControl: prefs.autoGainControl,
        }).catch(() => status('This microphone does not support that setting.'));
      }
    };
  }
  settings.addEventListener('toggle', () => { if (settings.open) void devices().catch(() => {}); });
  navigator.mediaDevices?.addEventListener('devicechange', () => { if (enabled) void devices().catch(() => {}); });

  async function collectStats() {
    const active = local;
    if (!active) return;
    const lines = await Promise.all([...active.links.values()].map(async link => {
      if (link.pc.signalingState === 'closed') return link.name + ' | Disconnected';
      const reports = await link.pc.getStats();
      const all = [...reports.values()];
      const transport = all.find(item => item.type === 'transport' && item.selectedCandidatePairId);
      const pair = reports.get(transport?.selectedCandidatePairId);
      link.relayed = pair && [pair.localCandidateId, pair.remoteCandidateId].some(id => reports.get(id)?.candidateType === 'relay');
      const input = all.find(item => item.type === 'inbound-rtp' && item.kind === 'audio');
      const output = all.find(item => item.type === 'outbound-rtp' && item.kind === 'audio');
      link.speaking = (input?.audioLevel ?? 0) > 0.03;
      const kbps = link.previous && output ? Math.max(0, (output.bytesSent - link.previous.bytesSent) * 8 /
        Math.max(1, output.timestamp - link.previous.timestamp)).toFixed(1) : '-';
      link.previous = output;
      const ms = value => Number.isFinite(value) ? Math.round(value * 1000) + ' ms' : '-';
      const packets = input && input.packetsReceived + input.packetsLost;
      const loss = packets > 0 ? (100 * Math.max(0, input.packetsLost) / packets).toFixed(1) + '%' : '-';
      return [link.name, link.pc.connectionState, pair ? (link.relayed ? 'Relay' : 'Direct') : 'No path yet',
        'RTT ' + ms(pair?.currentRoundTripTime), 'loss ' + loss, 'send ' + kbps + ' Kbps',
        'jitter ' + ms(input?.jitter)].join(' | ');
    })).catch(() => []);
    if (local !== active) return;
    $('stats').textContent = lines.join('\n');
    connectionStatus(active);
  }

  function render() {
    start.hidden = !enabled || !scope;
    settings.hidden = !enabled;
    $('debug').hidden = !local;
    if (scope) start.textContent = scope.direct ? 'Start call' : 'Join voice';
    start.disabled = Boolean(local || pending);
    view.hidden = !(local || pending || invitation || $('status').textContent);
    $('incoming').hidden = !invitation;
    $('controls').hidden = !local;
    $('dismiss').hidden = Boolean(local || pending || invitation);
    $('cancel').hidden = !pending;
    $('privacy').hidden = !invitation && !local && !pending;
    $('title').textContent = local?.scope.name ?? pending?.scope.name ??
      (invitation ? 'Call from ' + invitation.from : 'Voice');
    $('mute').textContent = local?.muted ? 'Unmute' : 'Mute';
    $('deafen').textContent = local?.deafened ? 'Undeafen' : 'Deafen';
    $('mute').setAttribute('aria-pressed', String(Boolean(local?.muted)));
    $('deafen').setAttribute('aria-pressed', String(Boolean(local?.deafened)));
    const members = local ? [...local.links.values()].map(link => {
      const item = document.createElement('li');
      item.textContent = link.name + (link.speaking && !local.deafened ? ' (speaking)' : '');
      return item;
    }) : [];
    $('roster').replaceChildren(...members);
  }

  function status(text = '') {
    $('status').textContent = text;
    render();
  }

  function clearInvitation() {
    invitation = null;
    clearTimeout(invitationTimer);
  }

  function dispose(link) {
    clearTimeout(link.retryTimer);
    link.pc.close();
    link.audio.remove();
  }

  function leave(message, notify) {
    pending = null;
    const active = local;
    local = null;
    if (active) {
      clearTimeout(active.timer);
      clearTimeout(active.unanswered);
      clearInterval(active.statsTimer);
      for (const track of active.stream.getTracks()) track.stop();
      for (const link of active.links.values()) dispose(link);
      if (notify) void request(active, 'leave').catch(() => {});
    }
    status(message);
  }

  function request(active, action, data = {}) {
    return call('voice/' + action, { conversation: active.scope.id, id: active.id, ...data });
  }

  function connectionStatus(active) {
    if (local !== active) return;
    const links = [...active.links.values()];
    const failed = links.filter(link => link.failed).length;
    const connected = links.filter(link => link.pc.connectionState === 'connected').length;
    const blockedAudio = links.some(link => link.needsPlayback);
    $('play').hidden = !blockedAudio;
    status(active.offlineSince ? 'Reconnecting to Horizon…' : blockedAudio ? 'Press Enable audio to hear the call.'
      : failed ? 'A direct connection failed. Leave and rejoin to retry.'
      : connected ? 'Connected to ' + connected + ' of ' + links.length + (links.some(link => link.relayed) ? ' · Relay' : ' · Direct')
      : links.length ? 'Connecting directlyâ€¦'
      : active.scope.direct ? 'Ringingâ€¦' : 'Waiting for others to join');
  }

  function preferOpus(sdp) {
    const opus = /^a=rtpmap:(\d+) opus\/48000\/2\r?$/mi.exec(sdp);
    if (!opus) return sdp;
    const fmtp = new RegExp('^a=fmtp:' + opus[1] + ' ([^\r\n]*)', 'm');
    return sdp.replace(fmtp, (_, values) => 'a=fmtp:' + opus[1] + ' ' +
      [...values.split(';').filter(value => !/^(?:usedtx|stereo|sprop-stereo)=/.test(value.trim())),
        'usedtx=1', 'stereo=0', 'sprop-stereo=0'].join(';'));
  }

  async function signal(active, link, type, restart = false) {
    const desc = type === 'offer' ? await link.pc.createOffer({ iceRestart: restart }) : await link.pc.createAnswer();
    await link.pc.setLocalDescription({ type, sdp: preferOpus(desc.sdp) });
    if (local === active && active.links.get(link.id) === link) {
      await request(active, 'signal', { target: link.id, type, sdp: link.pc.localDescription.sdp });
    }
  }

  async function refreshIce(active) {
    if (!active.ice.expiresAt || active.ice.expiresAt - Date.now() > 90_000) return;
    active.refreshingIce ??= request(active, 'ice').then(({ ice }) => {
      active.ice = ice;
      for (const link of active.links.values()) {
        if (link.pc.signalingState === 'closed') continue;
        link.pc.setConfiguration(iceConfig(active));
        if (link.relayed && active.id < link.id && link.pc.signalingState === 'stable') {
          void signal(active, link, 'offer', true).catch(() => {});
        }
      }
    }).finally(() => { active.refreshingIce = null; });
    await active.refreshingIce;
  }

  function scheduleRecovery(active, link) {
    if (link.retryTimer || local !== active || !['failed', 'disconnected'].includes(link.pc.iceConnectionState)) return;
    link.retryTimer = setTimeout(async () => {
      link.retryTimer = null;
      if (local !== active || !['failed', 'disconnected'].includes(link.pc.iceConnectionState)) return;
      if (link.retries++ >= 3) {
        dispose(link);
        link.failed = true;
        connectionStatus(active);
        return;
      }
      try {
        await refreshIce(active);
        if (active.id < link.id) {
          if (link.pc.signalingState === 'have-local-offer') await link.pc.setLocalDescription({ type: 'rollback' });
          await signal(active, link, 'offer', true);
        } else {
          await request(active, 'signal', { target: link.id, type: 'restart' });
        }
      } catch {}
      scheduleRecovery(active, link);
    }, 2500 * 2 ** link.retries);
  }

  const iceConfig = active => ({ iceTransportPolicy: 'all', iceServers: active.ice.iceServers });

  function startLink(active, peer) {
    const pc = new RTCPeerConnection(iceConfig(active));
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = active.deafened;
    audio.volume = prefs.outputVolume / 100;
    if (audio.setSinkId && prefs.output) void audio.setSinkId(prefs.output).catch(() => {});
    view.append(audio);
    const link = { ...peer, pc, audio, failed: false, needsPlayback: false, retries: 0, candidates: [], incoming: Promise.resolve() };
    active.links.set(peer.id, link);
    for (const track of active.stream.getAudioTracks()) {
      const sender = pc.addTrack(track, active.stream);
      const transceiver = pc.getTransceivers().find(item => item.sender === sender);
      const opus = window.RTCRtpSender?.getCapabilities('audio')?.codecs.filter(codec => codec.mimeType.toLowerCase() === 'audio/opus');
      if (opus?.length) transceiver?.setCodecPreferences?.(opus);
      const parameters = sender.getParameters();
      if (parameters.encodings?.length) {
        parameters.encodings[0].maxBitrate = active.ice.bitrate;
        void sender.setParameters(parameters).catch(() => {});
      }
    }
    pc.onicecandidate = event => {
      if (!event.candidate || local !== active) return;
      void request(active, 'signal', { target: link.id, type: 'candidate', candidate: event.candidate.toJSON() }).catch(() => {});
    };
    pc.ontrack = event => {
      if (event.track.kind !== 'audio') return;
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      void audio.play().catch(() => { link.needsPlayback = true; connectionStatus(active); });
    };
    pc.onconnectionstatechange = () => connectionStatus(active);
    pc.oniceconnectionstatechange = () => {
      if (['connected', 'completed'].includes(pc.iceConnectionState)) {
        clearTimeout(link.retryTimer);
        link.retryTimer = null;
        link.retries = 0;
      } else scheduleRecovery(active, link);
      connectionStatus(active);
    };
    if (active.id < peer.id) {
      void signal(active, link, 'offer').catch(() => { link.failed = true; connectionStatus(active); });
    }
  }

  function candidateMatches(link, candidate) {
    return link.pc.remoteDescription && (!candidate.usernameFragment ||
      link.pc.remoteDescription.sdp.includes('a=ice-ufrag:' + candidate.usernameFragment + '\r\n'));
  }

  async function receive(active, link, message) {
    if (local !== active || link.pc.signalingState === 'closed') return;
    if (message.type === 'candidate') {
      if (candidateMatches(link, message.candidate)) await link.pc.addIceCandidate(message.candidate);
      else if (link.candidates.length < 64) link.candidates.push(message.candidate);
      return;
    }
    if (message.type === 'restart') {
      if (active.id < link.id && link.pc.signalingState === 'stable') {
        await refreshIce(active);
        await signal(active, link, 'offer', true);
      }
      return;
    }
    if (message.type === 'offer' && active.id < link.id) return;
    if (message.type === 'answer' && link.pc.signalingState !== 'have-local-offer') return;
    await link.pc.setRemoteDescription({ type: message.type, sdp: message.sdp });
    for (const candidate of link.candidates.splice(0)) {
      if (candidateMatches(link, candidate)) await link.pc.addIceCandidate(candidate).catch(() => {});
    }
    if (message.type === 'offer') await signal(active, link, 'answer');
  }

  function updatePeers(active, peers) {
    for (const [id, link] of active.links) {
      if (peers.some(peer => peer.id === id)) continue;
      active.links.delete(id);
      dispose(link);
    }
    for (const peer of peers) if (!active.links.has(peer.id)) startLink(active, peer);
    if (peers.length) {
      clearTimeout(active.unanswered);
      active.joinedPeer = true;
    } else if (active.scope.direct && active.joinedPeer) {
      leave('The other person left the call.', true);
      return;
    }
    connectionStatus(active);
  }

  async function poll(active) {
    if (local !== active) return;
    if (active.polling) { active.woken = true; return; }
    clearTimeout(active.timer);
    active.polling = true;
    let delay = heartbeatMs;
    try {
      const result = await request(active, 'poll');
      if (local !== active) return;
      active.offlineSince = null;
      updatePeers(active, result.peers);
      for (const message of result.signals) {
        const link = active.links.get(message.from);
        if (link) link.incoming = link.incoming.then(() => receive(active, link, message)).catch(() => {});
      }
      void refreshIce(active).catch(() => {});
    } catch (error) {
      if (local !== active) return;
      active.offlineSince ??= Date.now();
      if ([401, 403, 404, 410].includes(error.status) || Date.now() - active.offlineSince > 40_000) {
        leave(error.message || 'The call disconnected.', false);
      } else {
        status('Reconnecting to Horizon…');
        delay = 2500;
      }
    } finally {
      active.polling = false;
      if (local === active) {
        active.timer = setTimeout(() => void poll(active), active.woken ? 0 : delay);
        active.woken = false;
      }
    }
  }

  async function join(target, invite) {
    if (local || pending) return;
    clearInvitation();
    const epoch = accountEpoch;
    const attempt = { scope: target };
    pending = attempt;
    status('Opening microphoneâ€¦');
    let stream;
    let started;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: prefs.echoCancellation, noiseSuppression: prefs.noiseSuppression,
        autoGainControl: prefs.autoGainControl, ...(prefs.input && { deviceId: { exact: prefs.input } }),
      }, video: false });
      if (pending !== attempt) return;
      const result = await request(attempt, 'join', { client: crypto.randomUUID(), invite });
      started = { id: result.id, scope: target };
      if (pending !== attempt) return;
      pending = null;
      local = { ...started, stream, ice: result.ice, links: new Map(), muted: false, deafened: false };
      const active = local;
      for (const track of stream.getAudioTracks()) track.onended = () => {
        if (local === active) leave('Your microphone disconnected. Select a microphone and rejoin.', true);
      };
      void devices().catch(() => {});
      local.statsTimer = setInterval(collectStats, 1000);
      if (target.direct && !result.peers.length) {
        local.unanswered = setTimeout(() => leave('No answer.', true), inviteMs);
      }
      updatePeers(local, result.peers);
      void poll(local);
    } catch (error) {
      if (pending === attempt || local?.scope === target) {
        leave(error.name === 'NotAllowedError' ? 'Microphone access was denied.' :
          error.name === 'NotFoundError' || error.name === 'OverconstrainedError' ? 'No microphone is available. Check your voice settings.' :
          error.name === 'NotReadableError' ? 'The microphone is unavailable or in use.' :
          error.message || 'Could not start voice.', Boolean(local));
      }
    } finally {
      if (local?.stream !== stream) {
        for (const track of stream?.getTracks() || []) track.stop();
        if (started && epoch === accountEpoch) void request(started, 'leave').catch(() => {});
      }
    }
  }

  window.addEventListener('pagehide', () => leave('', true));
  start.onclick = () => { if (scope) void join(scope); };
  $('accept').onclick = () => {
    if (!invitation) return;
    const incoming = invitation;
    void join({ id: incoming.conversation, name: incoming.from, direct: true }, incoming.id);
    navigate(incoming.conversation);
  };
  $('decline').onclick = () => {
    const incoming = invitation;
    clearInvitation();
    status();
    if (incoming) void call('voice/decline', { conversation: incoming.conversation, id: incoming.id }).catch(() => {});
  };
  $('leave').onclick = () => leave('', true);
  $('dismiss').onclick = () => status();
  $('cancel').onclick = () => leave('', true);
  $('mute').onclick = () => {
    if (!local) return;
    local.muted = !local.muted;
    for (const track of local.stream.getAudioTracks()) track.enabled = !local.muted;
    render();
  };
  $('deafen').onclick = () => {
    if (!local) return;
    local.deafened = !local.deafened;
    for (const link of local.links.values()) link.audio.muted = local.deafened;
    render();
  };
  $('play').onclick = async () => {
    if (!local) return;
    const active = local;
    for (const link of active.links.values()) {
      if (!link.needsPlayback) continue;
      link.needsPlayback = !(await link.audio.play().then(() => true, () => false));
    }
    connectionStatus(active);
  };

  return {
    account(account) {
      const epoch = ++accountEpoch;
      clearInvitation();
      enabled = false;
      scope = null;
      leave('', false);
      if (!account || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return;
      void call('voice/config', {}).then(() => {
        if (epoch === accountEpoch) { enabled = true; render(); }
      }).catch(() => {});
    },
    wake() { if (local) void poll(local); },
    scope(next) { scope = next; render(); },
    invite(event) {
      if (!enabled || local || pending || invitation) return;
      try { invitation = JSON.parse(event.data); } catch { return; }
      if (!invitation?.id || !Number.isSafeInteger(invitation.conversation) || typeof invitation.from !== 'string') {
        invitation = null;
        return;
      }
      status();
      invitationTimer = setTimeout(() => { clearInvitation(); status(); }, inviteMs);
    },
  };
}
