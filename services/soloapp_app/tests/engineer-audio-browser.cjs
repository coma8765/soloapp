const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
  try {
    const page = await browser.newPage({ permissions: ['microphone'] });
    await page.route('**/engineer-audio-test', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><button>start</button>',
      }),
    );
    await page.goto('http://127.0.0.1:4193/engineer-audio-test');
    const result = await page.evaluate(async () => {
      const { VoiceChat } = await import('/client/voice.js');
      const { encodeWav } = await import('/client/speech-audio.js');
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const check = (condition, message) => {
        if (!condition) throw Error(message);
      };
      const wait = async (predicate, label) => {
        for (let i = 0; i < 100; i++) {
          if (predicate()) return;
          await delay(100);
        }
        throw Error('Timeout ' + label);
      };
      const a = new VoiceChat(),
        b = new VoiceChat();
      await a.npc.unlock();
      await b.npc.unlock();
      // Outside an unentered room proximity can be undefined. This must not
      // throw from the voice-change callback and strand microphone startup.
      a.npc.setAudience(undefined, new Set(), null, 1);
      check(
        a.npc.local.gain.value === 0,
        'Unentered room keeps finite silent gain',
      );
      const context = new AudioContext();
      await context.resume();
      const mic = context.createMediaStreamDestination(),
        osc = context.createOscillator();
      osc.frequency.value = 220;
      osc.connect(mic);
      osc.start();
      a.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const pcA = new RTCPeerConnection({ iceServers: [] }),
        pcB = new RTCPeerConnection({ iceServers: [] });
      const pendingA = [],
        pendingB = [];
      pcA.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        if (pcB.remoteDescription) void pcB.addIceCandidate(candidate);
        else pendingB.push(candidate);
      };
      pcB.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        if (pcA.remoteDescription) void pcA.addIceCandidate(candidate);
        else pendingA.push(candidate);
      };
      a.attach(2, pcA, true);
      b.attach(1, pcB, false);
      await a.peers.get(2).updates;
      await pcA.setLocalDescription(await pcA.createOffer());
      await pcB.setRemoteDescription(pcA.localDescription);
      for (const c of pendingB) await pcB.addIceCandidate(c);
      await b.prepareAnswer(1);
      await pcB.setLocalDescription(await pcB.createAnswer());
      await pcA.setRemoteDescription(pcB.localDescription);
      for (const c of pendingA) await pcA.addIceCandidate(c);
      try {
        await wait(
          () =>
            pcA.connectionState === 'connected' &&
            pcB.connectionState === 'connected',
          'RTC',
        );
      } catch (e) {
        throw Error(
          e.message +
            ' ' +
            JSON.stringify({
              a: pcA.connectionState,
              b: pcB.connectionState,
              iceA: pcA.iceConnectionState,
              iceB: pcB.iceConnectionState,
              sdp: pcA.localDescription.sdp,
            }),
        );
      }
      await wait(() => b.npc.receivers.has(1), 'NPC receiver');
      check(
        pcA.getTransceivers().length === 2 &&
          pcB.getTransceivers().length === 2,
        'Exactly microphone + NPC slots',
      );
      const microphoneSender = a.peers.get(2).sender,
        microphoneId = microphoneSender.track.id;
      const incoming = b.npc.receivers.get(1),
        analyzer = context.createAnalyser();
      analyzer.fftSize = 2048;
      context
        .createMediaStreamSource(incoming.audio.srcObject)
        .connect(analyzer);
      const rms = () => {
        const data = new Float32Array(analyzer.fftSize);
        analyzer.getFloatTimeDomainData(data);
        return Math.sqrt(data.reduce((s, x) => s + x * x, 0) / data.length);
      };
      a.npc.setAudience(true, new Set([2]), 1, 1);
      b.npc.setAudience(true, new Set([1]), 1, 2);
      const pcm = Float32Array.from(
        { length: 8 * 16000 },
        (_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / 16000),
      );
      const wav = new Uint8Array(encodeWav(pcm));
      let raw = '';
      for (const x of wav) raw += String.fromCharCode(x);
      const playback = a.npc.playWav(btoa(raw));
      await wait(() => rms() > 0.02, 'Audible server WAV over RTC');
      const nearRms = rms();
      check(incoming.audio.muted === false, 'Nearby receiver unmuted');
      b.npc.setAudience(false, new Set([1]), 1, 2);
      check(incoming.audio.muted, 'Far receiver mutes immediately');
      a.npc.setAudience(true, new Set(), 1, 1);
      await delay(500);
      const farRms = rms();
      check(
        farRms < 0.002,
        'Sender stops transmitting sound to far peer: ' + farRms,
      );
      b.npc.setAudience(true, new Set([1]), 1, 2);
      a.npc.setAudience(true, new Set([2]), 1, 1);
      await wait(() => rms() > 0.02, 'Returning receiver hears ongoing answer');
      b.muted = true;
      b.npc.updateGains();
      check(incoming.audio.muted, 'Voice-chat mute affects engineer');
      check(
        microphoneSender.track.id === microphoneId &&
          microphoneSender.track.readyState === 'live',
        'NPC playback preserves microphone',
      );
      const stats = [...(await pcB.getStats())]
        .filter((s) => s.type === 'inbound-rtp' && s.kind === 'audio')
        .map((s) => ({ bytes: s.bytesReceived, packets: s.packetsReceived }));
      a.npc.stop();
      await playback;
      await delay(400);
      check(rms() < 0.002, 'Cancellation silences the shared track');
      const outputTrack = a.peers.get(2).npcSender.track;
      a.remove(2);
      check(
        outputTrack.readyState === 'ended',
        'Leaving peer releases relay resources',
      );
      pcA.close();
      pcB.close();
      a.disconnect();
      b.disconnect();
      osc.stop();
      await context.close();
      return { nearRms, farRms, stats };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
