import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceChat } from '../public/client/voice.js';

globalThis.window = { BABYLON: { Effect: { ShadersStore: {} } } };
globalThis.location = new URL('https://voice.example.test/');
const { Network } = await import('../public/client/network.js');

class Socket {
  static OPEN = 1;
  readyState = 1;
  close() {}
  send() {}
}
function setup(t) {
  const WebSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => {
    globalThis.WebSocket = WebSocket;
  });
  const scheduled = [];
  t.mock.method(globalThis, 'setTimeout', (callback) =>
    scheduled.push(callback),
  );
  const voice = new VoiceChat();
  const auth = {
    token: 'synthetic',
    expiresAt: Date.now() + 60000,
    clear() {
      this.token = null;
    },
  };
  const network = new Network(
    {},
    {},
    { reset() {} },
    { actors: new Map() },
    auth,
    () => {},
    voice,
  );
  network.connect();
  const welcome = () =>
    network.message({ type: 'welcome', id: 1, peers: [], world_protocol: 2 });
  welcome();
  const track = {
    readyState: 'live',
    enabled: true,
    stops: 0,
    stop() {
      this.stops++;
      this.readyState = 'ended';
    },
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  voice.stream = stream;
  return { voice, network, track, stream, scheduled, welcome };
}

test('rolling restart keeps capture through socket close and the scheduled reconnect', async (t) => {
  const { voice, network, track, stream, scheduled, welcome } = setup(t);
  for (let rollout = 0; rollout < 3; rollout++) {
    network.socket.onclose({ code: 1006, reason: '' });
    assert.equal(
      track.stops,
      0,
      'transport loss must not stop an enabled microphone',
    );
    assert.equal(voice.stream, stream);
    scheduled.shift()();
    assert.equal(voice.stream, stream, 'connect must preserve capture too');
    welcome();
    const sent = [];
    const pc = {
      signalingState: 'stable',
      addTransceiver: () => ({
        sender: { replaceTrack: async (value) => sent.push(value) },
      }),
      addEventListener() {},
      getReceivers: () => [],
    };
    voice.attach(2, pc, true);
    await voice.peers.get(2).updates;
    assert.equal(
      sent[0],
      track,
      'the replacement peer must receive the existing microphone',
    );
    voice.remove(2);
  }
  network.disconnect();
  assert.equal(track.stops, 1, 'explicit departure releases capture');
});

test('muting while reconnecting stays muted after the server returns', (t) => {
  const { voice, network, track, scheduled, welcome } = setup(t);
  network.socket.onclose({ code: 1006, reason: '' });
  voice.stop();
  scheduled.shift()();
  welcome();
  assert.equal(track.stops, 1);
  assert.equal(voice.enabled, false);
});

test('expired or rejected authentication stops capture and does not reconnect', (t) => {
  const { voice, network, track, scheduled } = setup(t);
  network.socket.onclose({ code: 1008, reason: 'Unauthorized' });
  assert.equal(track.stops, 1);
  assert.equal(voice.enabled, false);
  assert.equal(scheduled.length, 0);
});

test('logout during reconnect cancels the pending reconnect and stops capture', (t) => {
  const { voice, network, track, scheduled } = setup(t);
  network.socket.onclose({ code: 1006, reason: '' });
  network.disconnect();
  const generation = network.generation;
  scheduled.shift()();
  assert.equal(network.generation, generation);
  assert.equal(track.stops, 1);
  assert.equal(voice.enabled, false);
});
