// Static server :4193. Synthetic microphone and HTTP dependencies; real VAD,
// recorder, room, captions and Network handlers. Actual RTC is tested separately
// in engineer-audio-browser.cjs.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const pages = await Promise.all([browser.newPage(), browser.newPage()]);
    const errors = [],
      requests = [0, 0];
    const pcm = Buffer.alloc(44 + 16000 * 2 * 2);
    pcm.write('RIFF');
    pcm.writeUInt32LE(pcm.length - 8, 4);
    pcm.write('WAVEfmt ', 8);
    pcm.writeUInt32LE(16, 16);
    pcm.writeUInt16LE(1, 20);
    pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(16000, 24);
    pcm.writeUInt32LE(32000, 28);
    pcm.writeUInt16LE(2, 32);
    pcm.writeUInt16LE(16, 34);
    pcm.write('data', 36);
    pcm.writeUInt32LE(pcm.length - 44, 40);
    for (let i = 0; i < 32000; i++)
      pcm.writeInt16LE(
        Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 16000)),
        44 + i * 2,
      );
    for (const [index, page] of pages.entries()) {
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/speech/health', (r) =>
        r.fulfill({ json: { status: 'ok' } }),
      );
      await page.route('**/engineer/respond', async (route) => {
        requests[index]++;
        assert.equal(
          route.request().headers().authorization,
          'Bearer test-engineer',
        );
        assert(route.request().postDataBuffer().length <= 256044);
        await route.fulfill({
          json: {
            transcript: 'Для чего нужны стержни СУЗ?',
            answer: 'Стержни поглощают нейтроны.',
            audio_base64: pcm.toString('base64'),
            audio_mime: 'audio/wav',
          },
        });
      });
      await page.addInitScript(() => {
        window.spoken = [];
        Object.defineProperty(window, 'speechSynthesis', {
          value: {
            getVoices: () => [],
            speak(u) {
              spoken.push(u.text);
              u.onstart?.();
            },
            cancel() {},
          },
        });
      });
      await page.goto(
        (process.env.SOLOAPP_BASE_URL || 'http://127.0.0.1:4193') +
          '/?reactor-test=1',
      );
      await page.waitForFunction(
        () => window.planetApp?.engineer,
        {},
        { timeout: 90000 },
      );
      await page.exposeFunction('deliverEngineer', (raw) =>
        pages[1 - index].evaluate(
          (raw) => window.testChannel?.onmessage?.({ data: raw }),
          raw,
        ),
      );
      await page.evaluate((index) => {
        const app = planetApp;
        app.network.id = index + 1;
        app.engineer.getToken = () => 'test-engineer';
        app.engineer.recorder.getToken = () => 'test-engineer';
        app.player.position.set(3.95, 0, 6.5);
        app.reactor.instructor.stop();
        app.reactor.instructor.session.readyAt = performance.now() + 100000;
        const peer = index === 0 ? 2 : 1;
        app.network.peers.set(peer, { pc: { close() {} } });
        window.testChannel = {
          label: 'control-v1',
          readyState: 'open',
          bufferedAmount: 0,
          send(raw) {
            void deliverEngineer(raw);
          },
        };
        app.network.bindPeer(peer, testChannel);
      }, index);
    }
    for (const page of pages) await page.evaluate(() => testChannel.onopen());
    for (const page of pages)
      await page.waitForFunction(() => planetApp.network.remotes.size === 1);
    const [a, b] = pages;
    await a.evaluate(async () => {
      window.audioTest = new AudioContext();
      await audioTest.resume();
      const destination = audioTest.createMediaStreamDestination();
      window.inputGain = audioTest.createGain();
      inputGain.gain.value = 0;
      window.osc = audioTest.createOscillator();
      osc.connect(inputGain).connect(destination);
      osc.start();
      planetApp.network.voice.stream = destination.stream;
      await planetApp.network.voice.npc.unlock();
      planetApp.engineer.update();
      await planetApp.engineer.recorder.connection;
    });
    await a.waitForFunction(() => planetApp.engineer.recorder.enabled);
    await a.evaluate(() => (inputGain.gain.value = 0.1));
    await b.waitForFunction(() => planetApp.engineer.owner === 1);
    await a.waitForTimeout(450);
    await a.evaluate(() => (inputGain.gain.value = 0));
    await b.waitForFunction(
      () => planetApp.engineer.session.turns.get(1)?.stage === 'answer',
    );
    await a.waitForFunction(
      () =>
        planetApp.network.voice.npc.source &&
        planetApp.reactor.instructor.avatar.speaking,
    );
    assert.equal(
      await b.evaluate(() => planetApp.reactor.instructor.subtitle.textContent),
      'Стержни поглощают нейтроны.',
    );
    assert.equal(
      await b.evaluate(() => planetApp.engineer.claim()),
      false,
      'A second participant cannot interrupt the answer',
    );
    assert.equal(
      await a.evaluate(
        () => planetApp.network.voice.stream.getTracks()[0].readyState,
      ),
      'live',
    );
    assert.equal(
      await a.evaluate(() => spoken.includes('Стержни поглощают нейтроны.')),
      false,
      'Backend answer must not use browser TTS',
    );
    await a.waitForFunction(() => planetApp.engineer.localTurn === null);
    await b.waitForFunction(() => planetApp.engineer.owner === null);
    assert.equal(
      await a.evaluate(() => planetApp.reactor.instructor.avatar.speaking),
      false,
      'completed WAV answer closes the mouth',
    );
    assert.deepEqual(requests, [1, 0]);
    // Moving away mid-utterance cancels recording and releases the shared turn.
    await a.evaluate(() => (inputGain.gain.value = 0.1));
    await b.waitForFunction(() => planetApp.engineer.owner === 1);
    await a.evaluate(() => {
      planetApp.player.position.set(0, 0, 0);
      planetApp.engineer.update();
      inputGain.gain.value = 0;
    });
    await b.waitForFunction(() => planetApp.engineer.owner === null);
    await a.waitForTimeout(1200);
    assert.deepEqual(requests, [1, 0]);
    assert.equal(
      await a.evaluate(
        () => planetApp.network.voice.stream.getTracks()[0].readyState,
      ),
      'live',
    );
    await a.evaluate(async () => {
      osc.stop();
      planetApp.network.voice.stream = null;
      await audioTest.close();
    });
    assert.deepEqual(errors, []);
    console.log(
      'PASS: proximity, borrowed mic, real VAD, shared answer/caption, exclusive turn, no browser TTS and leave cancellation',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
