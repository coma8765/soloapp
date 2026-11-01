import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  SHIFT_INTERVAL_MS as interval,
  ShiftSchedule,
  ShiftClock,
  clockFace,
} from '../public/client/shift-clock.js';

const boundary = Date.UTC(2026, 10, 1, 10, 10);

test('announces once at every real ten-minute boundary, independent of frames', () => {
  const schedule = new ShiftSchedule(boundary - 1);
  assert.equal(schedule.poll(boundary - 1, true), false);
  assert.equal(schedule.poll(boundary, true), true);
  for (let i = 0; i < 100; i++)
    assert.equal(schedule.poll(boundary + i, true), false);
  assert.equal(schedule.poll(boundary + interval, true), true);
});

test('late frames get a small grace period, missed intervals never form a backlog', () => {
  const schedule = new ShiftSchedule(boundary - 1);
  schedule.poll(boundary - 1, true);
  assert.equal(schedule.poll(boundary + 1600, true), true);
  assert.equal(schedule.poll(boundary + 4 * interval + 7000, true), false);
  assert.equal(schedule.poll(boundary + 5 * interval, true), true);
});

test('joining, unmuting, unlocking audio and returning from another room do not replay', () => {
  const schedule = new ShiftSchedule(boundary - 1);
  assert.equal(schedule.poll(boundary + 100, true), false);
  schedule.poll(boundary + interval - 1, false);
  assert.equal(schedule.poll(boundary + interval, true), false);
  assert.equal(schedule.poll(boundary + 2 * interval, false), false);
  assert.equal(schedule.poll(boundary + 2 * interval + 100, true), false);
  assert.equal(schedule.poll(boundary + 3 * interval, true), true);
});

test('clock correction backwards cannot repeat an already observed shift', () => {
  const schedule = new ShiftSchedule(boundary - 1);
  schedule.poll(boundary - 1, true);
  assert.equal(schedule.poll(boundary, true), true);
  assert.equal(schedule.poll(boundary - interval, true), false);
  assert.equal(schedule.poll(boundary, true), false);
  assert.equal(schedule.poll(boundary + interval, true), true);
});

test('clock shows local civil time, date, timezone and countdown across midnight', () => {
  const midnight = new Date(2026, 10, 2, 0, 0, 0).getTime();
  assert.equal(clockFace(midnight - 1000).time, '23:59:59');
  assert.equal(clockFace(midnight - 1000).date, '01.11.2026');
  assert.equal(clockFace(midnight).time, '00:00:00');
  assert.equal(clockFace(midnight).date, '02.11.2026');
  assert.match(clockFace(midnight).zone, /^UTC[+−]\d{2}:\d{2}$/);
  assert.equal(clockFace(boundary - 1).next, '00:01');
  assert.equal(clockFace(boundary).next, '10:00');
});

function fixture() {
  const textures = [];
  globalThis.window = {
    BABYLON: {
      MeshBuilder: {
        CreatePlane: () => ({
          position: { set() {} },
          rotation: {},
          dispose() {},
        }),
      },
      DynamicTexture: class {
        constructor() {
          this.draws = [];
          textures.push(this);
        }
        getContext() {
          return {
            fillRect() {},
            strokeRect() {},
            fillText: (text) => this.draws.push(text),
          };
        }
        update() {}
      },
      StandardMaterial: class {},
      Color3: { White() {} },
    },
  };
  const room = {
    active: true,
    root: { name: 'control', isEnabled: () => true },
    scene: { onDisposeObservable: { addOnce() {} } },
  };
  const sources = [];
  const sound = {
    muted: false,
    master: {},
    context: {
      state: 'running',
      decodeAudioData: async () => ({ duration: 1 }),
      createBufferSource() {
        const source = {
          started: false,
          stopped: false,
          connect(target) {
            assert.equal(target, sound.master);
          },
          disconnect() {},
          start() {
            this.started = true;
          },
          stop() {
            this.stopped = true;
          },
        };
        sources.push(source);
        return source;
      },
    },
  };
  const clock = new ShiftClock(room, sound);
  clock.schedule = new ShiftSchedule(boundary - 1);
  clock.buffer = {};
  return { clock, room, sound, sources, textures };
}

test('one shared announcer survives room switches; both 3D clocks use real time', () => {
  const { clock, room, sources, textures } = fixture();
  clock.update(boundary - 1);
  clock.update(boundary);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].started, true);
  room.root.isEnabled = () => false;
  room.physicalRoom = { root: { name: 'physical', isEnabled: () => true } };
  clock.update(boundary + 1000);
  assert.equal(sources.length, 1, 'no duplicate on room switch');
  assert.equal(textures.length, 2);
  assert(textures[0].draws.includes(clockFace(boundary).time));
  assert(textures[1].draws.includes(clockFace(boundary + 1000).time));
  clock.update(boundary + interval);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].stopped, true);
  clock.dispose();
  assert.equal(sources[1].stopped, true);
});

test('mute, hidden app, leaving reactor and suspended audio stop playback', () => {
  for (const [index, disable] of [
    ({ sound }) => {
      sound.muted = true;
    },
    ({ room }) => {
      room.active = false;
    },
    ({ sound }) => {
      sound.context.state = 'suspended';
    },
    () => {},
  ].entries()) {
    const f = fixture();
    f.clock.update(boundary - 1);
    f.clock.update(boundary);
    disable(f);
    f.clock.update(boundary + 1, index !== 3);
    assert.equal(f.sources[0].stopped, true);
    f.clock.update(boundary + interval, index !== 3);
    assert.equal(f.sources.length, 1);
  }
});

test('no queued announcement before the recording is decoded', () => {
  const { clock, sources } = fixture();
  clock.buffer = null;
  clock.update(boundary - 1);
  clock.update(boundary);
  clock.buffer = {};
  clock.update(boundary + 100);
  assert.equal(sources.length, 0);
  clock.update(boundary + interval);
  assert.equal(sources.length, 1);
});

test('recording is loaded once; failed loading can retry on another interaction', async (t) => {
  const { clock } = fixture();
  clock.buffer = null;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert(url.pathname.endsWith('/assets/new-shift.wav'));
    return { ok: calls > 1, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  t.mock.method(console, 'warn', () => {});
  await clock.prepareAudio();
  assert(clock.audioError);
  const loading = clock.prepareAudio();
  assert.equal(
    clock.prepareAudio(),
    loading,
    'concurrent unlocks share loading',
  );
  await loading;
  assert.equal(clock.audioError, '');
  assert.equal(clock.buffer.duration, 1);
  await clock.prepareAudio();
  assert.equal(calls, 2);
});

test('bundled recording has nonempty mono PCM speech, not a silent placeholder', () => {
  const wav = readFileSync(
    new URL('../public/assets/new-shift.wav', import.meta.url),
  );
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let duration = 0,
    peak = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (tag === 'fmt ') {
      assert.equal(wav.readUInt16LE(start), 1);
      assert.equal(wav.readUInt16LE(start + 2), 1);
      assert.equal(wav.readUInt32LE(start + 4), 22050);
      assert.equal(wav.readUInt16LE(start + 14), 16);
    }
    if (tag === 'data') {
      duration = size / 44100;
      for (let i = start; i < start + size; i += 2)
        peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    }
    offset = start + size + (size % 2);
  }
  assert(duration > 0.5 && duration < 5);
  assert(peak > 1000);
});
