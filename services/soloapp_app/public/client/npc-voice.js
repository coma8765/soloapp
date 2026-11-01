// A separate audio transceiver in the existing voice-chat peer connection.
// Backend WAV -> Web Audio -> MediaStream -> WebRTC; never speechSynthesis and
// never fed back into the microphone/worklet used for recognition.
export class NpcVoice {
  constructor(voice) {
    this.voice = voice;
    this.outputs = new Map();
    this.receivers = new Map();
    this.audience = new Set();
    this.near = false;
    this.owner = null;
    this.localId = 0;
    this.generation = 0;
  }
  ensureContext() {
    if (this.context?.state === 'closed') this.context = null;
    if (this.context) return this.context;
    const context = (this.context = new AudioContext());
    this.bus = context.createGain();
    this.local = context.createGain();
    this.local.gain.value = 0;
    this.bus.connect(this.local).connect(context.destination);
    return context;
  }
  async unlock() {
    try {
      await this.ensureContext().resume();
    } catch {
      /* Retry on the next gesture. */
    }
    for (const peer of this.receivers.values()) this.voice.play(peer);
  }
  attachReceiver(id, track) {
    this.removeReceiver(id);
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.hidden = true;
    audio.muted = true;
    audio.srcObject = new MediaStream([track]);
    document.body.append(audio);
    const peer = { audio, blocked: false };
    this.receivers.set(id, peer);
    track.onunmute = () => {
      if (this.receivers.get(id) === peer) this.voice.play(peer);
    };
    this.updateGains();
    this.voice.play(peer);
  }
  async connectSender(id, sender) {
    if (!sender || !this.context) return;
    let output = this.outputs.get(id);
    if (!output) {
      const destination = this.context.createMediaStreamDestination();
      const gate = this.context.createGain();
      gate.gain.value = 0;
      this.bus.connect(gate).connect(destination);
      output = { destination, gate, sender: null };
      this.outputs.set(id, output);
    }
    if (output.sender !== sender) {
      await sender.replaceTrack(output.destination.stream.getAudioTracks()[0]);
      output.sender = sender;
    }
    this.updateGains();
  }
  setAudience(near, ids, owner, localId) {
    this.near = near;
    this.audience = ids;
    this.owner = owner;
    this.localId = localId;
    this.updateGains();
  }
  updateGains() {
    if (this.local)
      this.local.gain.value = Number(
        this.near && !this.voice.muted && this.owner === this.localId,
      );
    for (const [id, output] of this.outputs)
      output.gate.gain.value = Number(
        this.owner === this.localId && this.audience.has(id),
      );
    for (const [id, peer] of this.receivers)
      peer.audio.muted = this.voice.muted || !this.near || this.owner !== id;
  }
  async playWav(base64, signal) {
    this.stop();
    const generation = this.generation;
    if (!base64 || base64.length > 6 * 1024 * 1024)
      throw Error('Некорректная серверная озвучка');
    const context = this.ensureContext();
    await context.resume();
    if (context.state !== 'running')
      throw Error('Нажмите «Включить звук», чтобы услышать инженера.');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const buffer = await context.decodeAudioData(bytes.buffer);
    if (generation !== this.generation || signal?.aborted) return;
    if (!buffer.duration || buffer.duration > 45)
      throw Error('Ответ инженера слишком длинный');
    await Promise.all(
      [...this.voice.peers].map(([id, peer]) =>
        this.connectSender(id, peer.npcSender),
      ),
    );
    if (generation !== this.generation || signal?.aborted) return;
    this.updateGains();
    await new Promise((resolve) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.bus);
      this.source = source;
      const abort = () => this.stop();
      this.finish = () => {
        source.disconnect();
        signal?.removeEventListener('abort', abort);
        if (this.source === source) {
          this.source = null;
          this.finish = null;
        }
        resolve();
      };
      source.onended = this.finish;
      signal?.addEventListener('abort', abort, { once: true });
      source.start();
    });
  }
  stop() {
    this.generation++;
    const source = this.source,
      finish = this.finish;
    this.source = this.finish = null;
    if (source) {
      source.onended = null;
      source.stop();
    }
    finish?.();
  }
  removeReceiver(id) {
    const peer = this.receivers.get(id);
    if (peer) {
      for (const track of peer.audio.srcObject?.getTracks() || [])
        track.onunmute = null;
      peer.audio.pause();
      peer.audio.srcObject = null;
      peer.audio.remove();
      this.receivers.delete(id);
    }
  }
  remove(id) {
    this.removeReceiver(id);
    const output = this.outputs.get(id);
    if (output) {
      this.bus?.disconnect(output.gate);
      output.gate.disconnect();
      output.destination.stream.getTracks().forEach((track) => track.stop());
      this.outputs.delete(id);
    }
  }
  dispose() {
    this.stop();
    for (const id of new Set([
      ...this.outputs.keys(),
      ...this.receivers.keys(),
    ]))
      this.remove(id);
    void this.context?.close().catch(() => {});
    this.context = this.bus = this.local = null;
  }
}
