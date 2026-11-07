// Live synthetic RTP test. Requires @roamhq/wrtc + ws in NODE_PATH and a trusted
// NODE_EXTRA_CA_CERTS for the LAN origin. No microphone or speaker is opened.
// WS_URL_A/B optionally pin clients to separate loopback pod port-forwards.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url);
const rtc = require('@roamhq/wrtc');
const WS = require('ws');
const base = process.env.SOLOAPP_BASE_URL;
assert(base, 'SOLOAPP_BASE_URL is required');
const { RTCAudioSource, RTCAudioSink } = rtc.nonstandard;
globalThis.window = { BABYLON: { Effect: { ShadersStore: {} } } };
globalThis.MediaStream = rtc.MediaStream;
globalThis.RTCPeerConnection = rtc.RTCPeerConnection;
globalThis.document = {
  body: { append() {} },
  createElement() {
    return {
      setAttribute() {},
      pause() {},
      remove() {},
      play() {
        return Promise.resolve();
      },
    };
  },
};
globalThis.WebSocket = class extends WS {
  constructor(url) {
    super(url, { origin: base });
  }
};
const { Network } = await import('../public/client/network.js');
const { VoiceChat } = await import('../public/client/voice.js');
const clients = [],
  sinks = [],
  timers = [],
  tokens = [];
const energy = [0, 0];
async function api(path, body, token) {
  const response = await fetch(`${base}/api/v1/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function until(predicate, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < end, label);
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function audible(label) {
  energy.fill(0);
  await until(
    () =>
      clients.every((n) =>
        [...n.peers.values()].some((p) => p.pc.connectionState === 'connected'),
      ),
    `${label}: ICE connection`,
  );
  for (const [i, n] of clients.entries()) {
    await until(
      () => n.voice.peers.get(clients[1 - i].id)?.audio?.srcObject,
      `${label}: microphone receiver`,
    );
    const peer = n.voice.peers.get(clients[1 - i].id);
    const sink = new RTCAudioSink(peer.audio.srcObject.getAudioTracks()[0]);
    sink.ondata = ({ samples }) => {
      for (const value of samples) energy[i] += Math.abs(value);
    };
    sinks.push(sink);
  }
  await until(
    () => energy.every((x) => x > 100000),
    `${label}: non-silent audio in both directions`,
  );
  console.log(JSON.stringify({ phase: label, bidirectional_audio: true }));
  for (const sink of sinks.splice(0)) sink.stop();
}
try {
  for (let i = 0; i < 2; i++) {
    const credentials = {
      username: `voice_wire_${randomBytes(8).toString('hex')}`,
      password: randomBytes(24).toString('hex'),
    };
    await api('register', credentials);
    const session = await api('login', credentials);
    tokens.push(session.access_token);
    const voice = new VoiceChat();
    const n = new Network(
      { getEngine: () => ({ getFps: () => 60 }) },
      {
        state: (sequence) => ({
          type: 'state',
          sequence,
          map: 'planet',
          position: [0, 36, 0],
          rotation: [0, 0, 0, 1],
          pitch: 0,
        }),
      },
      { reset() {}, snapshot() {} },
      { actors: new Map() },
      {
        token: session.access_token,
        expiresAt: Date.now() + 300000,
        clear() {},
      },
      () => {
        throw Error('Unexpected authentication failure');
      },
      voice,
    );
    // Scene rendering is irrelevant; only the two synthetic accounts exchange audio.
    n.apply = () => {};
    const add = n.addPeer.bind(n);
    n.addPeer = (id) => {
      if (clients.some((other) => other !== n && other.id === id)) add(id);
    };
    const message = n.message.bind(n);
    n.message = (value) => {
      message(value);
      if (value.type === 'welcome')
        setImmediate(() => {
          for (const a of clients)
            for (const b of clients)
              if (a !== b && a.id && b.id) a.addPeer(b.id);
        });
    };
    const connect = n.connect.bind(n);
    const url =
      process.env[i === 0 ? 'WS_URL_A' : 'WS_URL_B'] ||
      base.replace(/^http/, 'ws');
    n.connect = (options) => {
      globalThis.location = new URL(url.replace(/^ws/, 'http'));
      connect(options);
    };
    clients.push(n);
    n.connect();
    await until(() => n.id, 'welcome');
    const source = new RTCAudioSource(),
      track = source.createTrack();
    voice.stream = new rtc.MediaStream([track]);
    for (const peer of voice.peers.values()) voice.replace(peer, track);
    timers.push(
      setInterval(
        () =>
          source.onData({
            samples: Int16Array.from({ length: 480 }, (_, sample) =>
              Math.round(3000 * Math.sin(sample * 0.1)),
            ),
            sampleRate: 48000,
            bitsPerSample: 16,
            channelCount: 1,
            numberOfFrames: 480,
          }),
        10,
      ),
    );
  }
  await audible('before reconnect');
  for (let attempt = 1; attempt <= 2; attempt++) {
    const n = clients[(attempt - 1) % 2],
      oldId = n.id,
      stream = n.voice.stream;
    n.socket.terminate();
    await until(() => n.id && n.id !== oldId, 'automatic reconnect');
    assert.equal(
      n.voice.stream,
      stream,
      'rollout must preserve the microphone stream',
    );
    assert.equal(stream.getAudioTracks()[0].readyState, 'live');
    await audible(`after reconnect ${attempt}`);
  }
} finally {
  timers.forEach(clearInterval);
  sinks.forEach((sink) => sink.stop());
  clients.forEach((n) => n.disconnect());
  for (const token of tokens) await api('logout', null, token);
}
// Native libwebrtc can retain worker handles briefly after all peers are closed.
setTimeout(() => process.exit(0), 200);
