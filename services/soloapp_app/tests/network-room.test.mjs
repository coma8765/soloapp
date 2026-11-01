import assert from 'node:assert/strict';
import test from 'node:test';
import { REACTOR_MAP, PHYSICAL_MAP } from '../public/shared/room.js';
import { VoiceChat } from '../public/client/voice.js';

class Vector {
  constructor(values) {
    this.values = [...values];
  }
  copyFrom(other) {
    this.values = [...other.values];
  }
  static FromArray(values) {
    return new Vector(values);
  }
  static Lerp(a, b, amount) {
    return new Vector(a.values.map((v, i) => v + (b.values[i] - v) * amount));
  }
  static Slerp(a, b, amount) {
    return Vector.Lerp(a, b, amount);
  }
}
globalThis.window = {
  BABYLON: {
    Vector3: Vector,
    Quaternion: Vector,
    Effect: { ShadersStore: {} },
  },
};
const { Network } = await import('../public/client/network.js');

function setup(id, map) {
  const player = {
    worldMap: map,
    position: [0, 0, 4],
    state(sequence) {
      return {
        type: 'state',
        sequence,
        map: this.worldMap,
        position: [...this.position],
        rotation: [0, 0, 0, 1],
        pitch: 0,
        speed: 1,
        avatarId: 'male',
      };
    },
  };
  const network = new Network(
    {},
    player,
    {},
    { actors: new Map(), updateActor() {} },
    {},
    () => {},
  );
  network.id = id;
  network.worldProtocol = 2;
  network.socket = { readyState: WebSocket.OPEN, send() {} };
  return network;
}
function remote(network, id) {
  const node = {
    position: new Vector([0, 36, 0]),
    rotationQuaternion: new Vector([0, 0, 0, 1]),
    dispose() {},
    setEnabled(value) {
      this.enabled = value;
    },
  };
  const value = {
    node,
    avatarId: 'male',
    sequence: -1,
    last: 0,
    state: network.player.state(0),
    target: node.position,
    rotation: node.rotationQuaternion,
    avatar: {
      update(_dt, _speed, _pitch, visible) {
        node.setEnabled(visible);
      },
    },
  };
  network.remotes.set(id, value);
  return value;
}

test('two clients exchange room poses over WSS with no working peer data channels', () => {
  const a = setup(1, REACTOR_MAP),
    b = setup(2, REACTOR_MAP);
  const seenA = remote(b, 1),
    seenB = remote(a, 2);
  a.socket.send = (raw) => {
    const state = JSON.parse(raw);
    if (state.type === 'state')
      b.message({ type: 'player_state', from: 1, state });
  };
  b.socket.send = (raw) => {
    const state = JSON.parse(raw);
    if (state.type === 'state')
      a.message({ type: 'player_state', from: 2, state });
  };
  const tick = (client) => {
    client.lastSend = -Infinity;
    client.update(0.1);
  };
  a.player.position = [2, 0, 4];
  tick(a);
  tick(b);
  assert.deepEqual(seenA.target.values, [2, 0, 4]);
  assert(seenA.node.enabled && seenB.node.enabled);
  const old = a.player.state(a.sequence);
  a.player.worldMap = PHYSICAL_MAP;
  a.player.position = [-3, 0, 7];
  tick(a);
  tick(b);
  assert.equal(seenA.node.enabled, false);
  assert.deepEqual(
    seenA.node.position.values,
    [-3, 0, 7],
    'room transition snaps instead of interpolating across maps',
  );
  b.player.worldMap = PHYSICAL_MAP;
  tick(b);
  tick(a);
  assert(seenA.node.enabled && seenB.node.enabled);
  b.message({ type: 'player_state', from: 1, state: old });
  assert.equal(
    seenA.state.map,
    PHYSICAL_MAP,
    'stale planet/room echoes cannot rewind presence',
  );
});

test('invalid remote room coordinates are discarded', () => {
  const n = setup(1, REACTOR_MAP),
    seen = remote(n, 2);
  n.apply(2, { ...n.player.state(1), position: [100, 0, 0] });
  assert.equal(seen.sequence, -1);
});

test('welcome preserves configured TURN and explains failed direct voice connections', () => {
  const n = setup(1, REACTOR_MAP);
  n.voice = new VoiceChat();
  const welcome = (iceServers) => ({
    type: 'welcome',
    id: 1,
    peers: [],
    world_protocol: 2,
    rtc_config: { iceServers },
  });
  n.message(welcome([]));
  n.voice.peers.set(2, { pc: { connectionState: 'failed' } });
  assert.match(n.voice.status, /сервер ретрансляции не настроен/);
  const servers = [
    {
      urls: ['turns:relay.example.test:5349'],
      username: 'synthetic',
      credential: 'synthetic',
    },
  ];
  n.message(welcome(servers));
  assert.deepEqual(n.rtcConfig.iceServers, servers);
  assert(n.voice.relayConfigured);
  assert.doesNotMatch(n.voice.status, /сервер ретрансляции не настроен/);
});

test('room pose updates preserve the active voice connection and microphone', () => {
  const n = setup(1, REACTOR_MAP);
  n.voice = new VoiceChat();
  let stopped = false;
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          stopped = true;
        },
      },
    ],
  };
  n.voice.stream = stream;
  const peer = { pc: { connectionState: 'connected' } };
  n.voice.peers.set(2, peer);
  for (const map of [REACTOR_MAP, PHYSICAL_MAP, REACTOR_MAP]) {
    n.player.worldMap = map;
    n.lastSend = -Infinity;
    n.update(0.1);
    assert.equal(n.voice.stream, stream);
    assert.equal(n.voice.peers.get(2), peer);
  }
  assert.equal(stopped, false);
});

test('only server participant messages set labels and telemetry probes report actual engine FPS', () => {
  const n = setup(1, REACTOR_MAP);
  n.scene.getEngine = () => ({ getFps: () => 72 });
  const sent = [];
  n.socket.send = (raw) => sent.push(JSON.parse(raw));
  const seen = remote(n, 2);
  seen.avatar.setLabel = (label) => {
    seen.label = label;
  };
  n.message({
    type: 'participants',
    admin: true,
    players: [
      { id: 1, email: 'a@gmail.com', ping: 10, fps: 72 },
      { id: 2, email: 'peer@example.test', ping: 20, fps: 60 },
    ],
  });
  assert.equal(seen.label, 'peer@example.test');
  assert.equal(n.participantName(2), 'peer@example.test');
  n.message({ type: 'telemetry_probe', nonce: 'server-challenge' });
  assert.deepEqual(sent.pop(), {
    type: 'telemetry_reply',
    nonce: 'server-challenge',
    fps: 72,
  });
  n.message({ type: 'left', id: 2 });
  assert.equal(n.participants.players.has(2), false);
  n.fish.reset = () => {};
  n.clearPeers();
  assert.equal(n.participants.admin, false);
  assert.equal(n.participants.players.size, 0);
});
