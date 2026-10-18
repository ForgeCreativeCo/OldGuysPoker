// Live voice chat: a WebRTC audio mesh between everyone at a table who joined
// voice. The server only relays signaling; audio flows peer to peer.
// The newcomer always makes the offers, so two peers never offer at once.

export class Voice {
  constructor(socket, { onSpeaking, onChange }) {
    this.socket = socket;
    this.onSpeaking = onSpeaking;
    this.onChange = onChange;
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.peers = new Map();   // socketId -> { pc, playerId, audio, pending: [] }
    this.meta = new Map();    // socketId -> playerId
    this.levels = new Map();  // key -> analyser
    this.stream = null;
    this.muted = false;
    this.myId = null;

    socket.on('voice:peers', (list) => list.forEach((p) => { this.meta.set(p.id, p.playerId); this.connect(p.id, true); }));
    socket.on('voice:peer-joined', (p) => this.meta.set(p.id, p.playerId));
    socket.on('voice:signal', ({ from, data }) => this.onSignal(from, data));
    socket.on('voice:peer-left', (id) => this.drop(id));
  }

  get active() { return !!this.stream; }
  get count() { return this.active ? this.peers.size + 1 : 0; }

  async join(myId) {
    if (this.stream) return;
    this.myId = myId;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.ctx = new AudioContext();
    this.watch('me', this.stream);
    this.socket.emit('voice:join');
    this.levelTimer = setInterval(() => this.pollLevels(), 120);
    this.onChange();
  }

  leave() {
    if (!this.stream) return;
    this.socket.emit('voice:leave');
    for (const id of [...this.peers.keys()]) this.drop(id, true);
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    clearInterval(this.levelTimer);
    this.levels.clear();
    this.ctx && this.ctx.close();
    this.ctx = null;
    this.onSpeaking(new Set());
    this.onChange();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.stream) this.stream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    this.onChange();
  }

  connect(id, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { pc, pending: [], audio: null };
    this.peers.set(id, peer);
    this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream));

    pc.onicecandidate = (e) => { if (e.candidate) this.signal(id, { candidate: e.candidate }); };
    pc.ontrack = (e) => {
      if (peer.audio) return;
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = e.streams[0];
      document.getElementById('audio-sink').appendChild(audio);
      audio.play().catch(() => {});
      peer.audio = audio;
      this.watch(id, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.drop(id);
    };

    if (initiator) {
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.signal(id, { sdp: pc.localDescription }))
        .catch((e) => console.warn('voice offer failed', e));
    }
    this.onChange();
    return peer;
  }

  async onSignal(from, data) {
    if (!this.stream) return;
    const peer = this.peers.get(from) || this.connect(from, false);
    const { pc } = peer;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.signal(from, { sdp: pc.localDescription });
        }
        for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c);
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else peer.pending.push(data.candidate);
      }
    } catch (e) {
      console.warn('voice signal error', e);
    }
  }

  signal(to, data) { this.socket.emit('voice:signal', { to, data }); }

  drop(id, quiet) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
    this.peers.delete(id);
    this.levels.delete(id);
    if (!quiet) this.onChange();
  }

  watch(key, stream) {
    if (!this.ctx) return;
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    this.levels.set(key, { an, buf: new Uint8Array(an.fftSize) });
  }

  pollLevels() {
    const speaking = new Set();
    for (const [key, { an, buf }] of this.levels) {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      if (rms > 6) {
        if (key === 'me') { if (!this.muted) speaking.add(this.myId); }
        else speaking.add(this.meta.get(key));
      }
    }
    this.onSpeaking(speaking);
  }
}
