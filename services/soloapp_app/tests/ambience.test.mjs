import assert from 'node:assert/strict';
import test from 'node:test';
import { NatureAudio } from '../public/client/audio.js';
import { REACTOR_MAP, PHYSICAL_MAP, ROOM_MAP } from '../public/shared/room.js';

class Param {
  constructor(value = 0) {
    this.value = value;
  }
  setTargetAtTime(value, time, ramp) {
    this.value = value;
    this.ramp = ramp;
    assert(Number.isFinite(time));
    assert(ramp > 0);
  }
}
class Node {
  connect(target) {
    this.target = target;
  }
  disconnect() {}
}
class AudioContext {
  constructor() {
    this.currentTime = 1;
    this.destination = {};
    this.sources = [];
    this.state = 'suspended';
  }
  createGain() {
    return Object.assign(new Node(), { gain: new Param(1) });
  }
  createBiquadFilter() {
    return Object.assign(new Node(), { frequency: new Param() });
  }
  createBuffer(channels, length, sampleRate) {
    assert.equal(channels, 1);
    const data = new Float32Array(length);
    return {
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => data,
    };
  }
  createBufferSource() {
    const source = Object.assign(new Node(), {
      playbackRate: new Param(1),
      start() {
        this.started = true;
      },
    });
    this.sources.push(source);
    return source;
  }
  async resume() {
    this.state = 'running';
  }
}
globalThis.window = { AudioContext };

async function fixture(muted = false) {
  let shoreReads = 0;
  const sound = new NatureAudio({
    shoreDistance() {
      shoreReads++;
      return 0;
    },
  });
  if (muted) sound.toggle();
  await sound.start();
  const player = {
    worldMap: 'planet',
    speed: 3,
    position: { length: () => 40, asArray: () => [0, 40, 0] },
  };
  return { sound, player, shoreReads: () => shoreReads };
}

test('planet -> control room -> physical room -> planet selects the right ambience', async () => {
  const { sound, player, shoreReads } = await fixture();
  sound.update(player, false);
  assert.equal(sound.natureGain.gain.value, 1);
  assert.equal(sound.hum.gain.gain.value, 0);
  assert.equal(sound.layers[0].gain.gain.value, 0.04);
  const reads = shoreReads();
  for (const map of [REACTOR_MAP, PHYSICAL_MAP]) {
    player.worldMap = map;
    player.position = {
      length() {
        throw Error('Room must not sample planet water');
      },
    };
    sound.update(player, false);
    assert.equal(
      sound.natureGain.gain.value,
      0,
      'wind and other nature layers fade out',
    );
    assert.equal(sound.hum.gain.gain.value, 0.03);
    assert.equal(sound.hum.source.target.target, sound.master);
    assert.equal(shoreReads(), reads);
  }
  player.worldMap = 'planet';
  player.position = { length: () => 40, asArray: () => [0, 40, 0] };
  sound.update(player, false);
  assert.equal(sound.natureGain.gain.value, 1);
  assert.equal(sound.hum.gain.gain.value, 0);
  assert.equal(sound.layers[0].gain.gain.value, 0.04);
  assert.equal(sound.context.sources.length, 5, 'transitions reuse the loops');
});

test('starting audio directly in either reactor room works; white room stays silent', async () => {
  for (const map of [REACTOR_MAP, PHYSICAL_MAP]) {
    const { sound, player } = await fixture();
    player.worldMap = map;
    sound.update(player, false);
    assert.equal(sound.hum.gain.gain.value, 0.03);
    assert.equal(sound.natureGain.gain.value, 0);
    player.worldMap = ROOM_MAP;
    sound.update(player, false);
    assert.equal(sound.natureGain.gain.value, 0);
    assert.equal(sound.hum.gain.gain.value, 0);
  }
});

test('entering from underwater silences an existing splash without muffling the hum', async () => {
  const { sound, player } = await fixture();
  player.position.length = () => 20;
  sound.update(player, true);
  const splash = sound.context.sources.at(-1);
  assert.equal(sound.context.sources.length, 6);
  assert.equal(splash.target.target, sound.filter);
  assert.equal(sound.filter.target, sound.natureGain);
  assert.equal(sound.filter.frequency.value, 700);
  player.worldMap = REACTOR_MAP;
  sound.update(player, false);
  assert.equal(sound.natureGain.gain.value, 0);
  assert.equal(sound.hum.gain.target, sound.master);
  assert.equal(sound.wasWet, false);
});

test('global mute covers hum, nature and announcements, including before audio unlock', async () => {
  const { sound, player } = await fixture(true);
  const master = sound.master;
  assert.equal(master.gain.value, 0);
  player.worldMap = REACTOR_MAP;
  sound.update(player, false);
  assert.equal(master.gain.value, 0);
  assert.equal(sound.natureGain.target, master);
  assert.equal(sound.hum.gain.target, master);
  sound.toggle();
  assert.equal(master.gain.value, 1);
  sound.toggle();
  assert.equal(master.gain.value, 0);
  await sound.start();
  assert.equal(sound.master, master, 'shared announcement output is preserved');
  assert.equal(sound.context.sources.length, 5);
});

test('quiet hum is a continuous 50 Hz harmonic signal, not wind or silence', async () => {
  const { sound } = await fixture();
  const buffer = sound.hum.source.buffer;
  const samples = buffer.getChannelData(0);
  assert.equal(buffer.duration, 2);
  assert.equal(sound.hum.source.loop, true);
  assert.equal(sound.hum.source.started, true);
  assert.equal(samples[0], 0);
  assert(Math.abs(samples.at(-1) - samples[0]) < 0.025, 'no loop seam click');
  let square = 0,
    peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    assert(Number.isFinite(sample));
    square += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (i >= 441) assert(Math.abs(sample - samples[i - 441]) < 1e-6);
  }
  const rms = Math.sqrt(square / samples.length) * 0.03;
  assert(rms > 0.005 && rms < 0.015, 'low-level background, below speech');
  assert(peak * 0.03 < 0.03);
});
