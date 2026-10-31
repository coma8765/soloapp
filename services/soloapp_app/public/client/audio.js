import { smooth, WATER_RADIUS } from '../shared/world.js';
export class NatureAudio {
  constructor(terrain) {
    this.terrain = terrain;
    this.muted = false;
    this.layers = [];
    this.shore = 30;
    this.nextShore = 0;
    this.wasWet = false;
    this.ready = false;
  }
  async start() {
    if (!this.context) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      this.context = new C();
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.filter = this.context.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 16000;
      this.filter.connect(this.master);
      for (const kind of ['wind', 'water', 'grass', 'wading']) {
        const source = this.context.createBufferSource(),
          gain = this.context.createGain();
        source.buffer = this.makeSound(kind, 8);
        source.loop = true;
        source.loopStart = 0.25;
        source.connect(gain);
        gain.connect(this.filter);
        gain.gain.value = 0;
        source.start();
        this.layers.push({ source, gain });
      }
    }
    await this.context.resume();
    this.ready = true;
  }
  makeSound(kind, seconds) {
    const rate = 22050,
      buffer = this.context.createBuffer(1, rate * seconds, rate),
      data = buffer.getChannelData(0);
    let low = 0,
      slow = 0,
      seed = 38491;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = seed / 2147483648 - 1,
        t = i / rate;
      low += (noise - low) * 0.12;
      slow += (noise - slow) * 0.018;
      let v = 0;
      if (kind === 'wind')
        v =
          (low * 0.7 + slow * 1.8) *
          (0.65 +
            0.2 * Math.sin((2 * Math.PI * t) / seconds) +
            0.15 * Math.sin((2 * Math.PI * t * 3) / seconds));
      if (kind === 'water')
        v =
          low *
            (0.3 +
              0.45 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t * 4) / seconds))) +
          slow * 0.7;
      if (kind === 'grass')
        v =
          (low * 0.9 + (noise - low) * 0.12) *
          (0.8 +
            0.12 * Math.sin((2 * Math.PI * t * 5) / seconds) +
            0.08 * Math.sin((2 * Math.PI * t * 11) / seconds));
      if (kind === 'wading') {
        v =
          slow *
            1.8 *
            (0.65 + 0.2 * Math.sin((2 * Math.PI * t * 5) / seconds)) +
          low * 0.16;
        for (let b = 0; b < 4; b++) {
          const a = (t + b * 0.173) % (1 / (1.5 + b * 0.625));
          v +=
            Math.sin(
              2 *
                Math.PI *
                ((190 + b * 95) * a + (70 * (1 - Math.exp(-a * 8))) / 8),
            ) *
            (1 - Math.exp(-a * 60)) *
            Math.exp(-a * 12) *
            0.13;
        }
      }
      if (kind === 'splash')
        v =
          (low * 1.5 +
            noise * 0.12 +
            Math.sin(2 * Math.PI * (210 * t + 95 * t * t)) *
              Math.exp(-t * 9) *
              0.14) *
          Math.min(1, t * 100) *
          Math.pow(Math.max(0, 1 - t / seconds), 2);
      data[i] = Math.max(-1, Math.min(1, v));
    }
    if (kind !== 'splash') {
      const n = rate * 0.25;
      for (let i = 0; i < n; i++) {
        const a = i / (n - 1);
        data[data.length - n + i] =
          data[data.length - n + i] * (1 - a) + data[i] * a;
      }
    }
    return buffer;
  }
  toggle() {
    this.muted = !this.muted;
    if (this.master)
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : 1,
        this.context.currentTime,
        0.05,
      );
  }
  update(player, underwater) {
    if (!this.ready) return;
    const ctx = this.context,
      t = ctx.currentTime;
    if (player.worldMap === 'white-room') {
      for (const layer of this.layers)
        layer.gain.gain.setTargetAtTime(0, t, 0.18);
      this.wasWet = false;
      return;
    }
    const wet = player.position.length() < WATER_RADIUS - 0.08;
    if (performance.now() > this.nextShore) {
      this.shore = this.terrain.shoreDistance(player.position.asArray());
      this.nextShore = performance.now() + 250;
    }
    const moving = Math.min(1, player.speed / 5.5),
      near = 1 - smooth(0, 24, this.shore),
      gains = [
        underwater ? 0.01 : 0.04,
        0.09 * near * near,
        moving * (wet ? 0 : 0.24),
        moving * (wet ? 0.3 : 0),
      ];
    this.layers.forEach((l, i) =>
      l.gain.gain.setTargetAtTime(gains[i], t, 0.18),
    );
    this.layers[1].source.playbackRate.setTargetAtTime(
      underwater ? 0.65 : 1,
      t,
      0.2,
    );
    this.layers[3].source.playbackRate.setTargetAtTime(
      underwater ? 0.68 : 1,
      t,
      0.2,
    );
    this.filter.frequency.setTargetAtTime(underwater ? 700 : 16000, t, 0.3);
    if (wet !== this.wasWet && !this.muted) {
      const s = ctx.createBufferSource(),
        g = ctx.createGain();
      s.buffer = this.makeSound('splash', 0.9);
      s.connect(g);
      g.gain.value = 0.23;
      g.connect(this.filter);
      s.start();
      s.onended = () => {
        s.disconnect();
        g.disconnect();
      };
    }
    this.wasWet = wet;
  }
}
