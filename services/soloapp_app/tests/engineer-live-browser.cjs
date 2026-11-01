// Live LAN test: normal sign-in and microphone button, real VAD/Whisper/search/
// Ollama/TTS. Only microphone audio is synthetic; never calls engineer.update().
// SOLOAPP_BASE_URL=https://... TTS_TEST_URL=http://127.0.0.1:18179 NODE_PATH=... node ...
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const base = process.env.SOLOAPP_BASE_URL;
  const tts = process.env.TTS_TEST_URL;
  assert(base && tts, 'Set SOLOAPP_BASE_URL and a loopback TTS_TEST_URL');
  const questions = [
    'Для чего нужен парогенератор?',
    'Что такое розовый единорог?',
  ];
  const waves = [];
  for (const text of questions) {
    const response = await fetch(tts + '/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    assert(response.ok, 'TTS question fixture failed');
    waves.push(Buffer.from(await response.arrayBuffer()).toString('base64'));
  }
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true, // The installed LAN uses its own local CA.
      permissions: ['microphone'],
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack));
    await page.addInitScript(() => {
      window.engineerProbe = { spoken: [] };
      const speak = speechSynthesis.speak.bind(speechSynthesis);
      speechSynthesis.speak = (utterance) => {
        engineerProbe.spoken.push(utterance.text);
        speak(utterance);
      };
      const capture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        // The Chrome flag supplies a fake device, never the user's microphone.
        engineerProbe.stage = 'capture';
        const permission = await capture(constraints);
        permission.getTracks().forEach((track) => track.stop());
        const audio = new AudioContext();
        engineerProbe.stage = 'resume:' + audio.state;
        await audio.resume();
        engineerProbe.stage = 'ready';
        const destination = audio.createMediaStreamDestination();
        engineerProbe.feed = async (base64) => {
          const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const source = audio.createBufferSource();
          source.buffer = await audio.decodeAudioData(data.buffer);
          source.connect(destination);
          await new Promise((resolve) => {
            source.onended = resolve;
            source.start();
          });
          source.disconnect();
        };
        return destination.stream;
      };
    });
    await page.goto(base);
    await page.waitForFunction(
      () => window.planetApp?.engineer,
      {},
      { timeout: 90000 },
    );
    await page
      .locator('#auth-email')
      .fill(`engineer_${Date.now()}@example.test`);
    await page
      .locator('#auth-password')
      .fill(`Synthetic-test-${Date.now()}-voice`);
    await page.locator('#auth-submit').evaluate((button) => button.click());
    await page.waitForFunction(
      () => planetApp.network.id && planetApp.network.auth.token,
      {},
      { timeout: 30000 },
    );
    // Enable the microphone BEFORE entering the room and approaching the NPC.
    await page.locator('#microphone').evaluate((button) => button.click());
    await page
      .waitForFunction(() => planetApp.voice.enabled, {}, { timeout: 10000 })
      .catch(async (error) => {
        console.error(
          await page.evaluate(() => ({
            voice: {
              enabled: planetApp.voice.enabled,
              pending: planetApp.voice.pending,
              error: planetApp.voice.error,
              available: planetApp.voice.available,
              online: planetApp.voice.online,
              localAllowed: planetApp.voice.localAllowed,
            },
            buttonDisabled: document.getElementById('microphone').disabled,
            feed: !!engineerProbe.feed,
            stage: engineerProbe.stage,
            secure: isSecureContext,
          })),
        );
        console.error(errors);
        throw error;
      });
    await page.evaluate(() => {
      planetApp.reactor.enter();
      planetApp.player.position.set(0, 0, 0);
    });
    await page.waitForTimeout(500);
    assert.equal(
      await page.evaluate(() => planetApp.engineer.recorder.enabled),
      false,
    );
    await page.evaluate(() => planetApp.player.position.set(3.95, 0, 6.5));
    await page.waitForFunction(
      () => planetApp.engineer.recorder.enabled,
      {},
      { timeout: 10000 },
    );
    for (const [index, wave] of waves.entries()) {
      await page.waitForFunction(() => !planetApp.engineer.localTurn);
      const response = page.waitForResponse(
        (r) => r.url().endsWith('/engineer/respond'),
        { timeout: 190000 },
      );
      await page.evaluate((wave) => engineerProbe.feed(wave), wave);
      const http = await response;
      assert.equal(http.status(), 200);
      const answer = await http.json();
      assert.equal(answer.corpus, 'vver1200-research');
      assert(
        Buffer.from(answer.audio_base64, 'base64')
          .subarray(0, 4)
          .equals(Buffer.from('RIFF')),
      );
      if (index === 0) {
        assert(answer.sources.length > 0);
        assert.notEqual(
          answer.answer,
          'Будьте серъёзнее или задавайте более осознанные вопросы',
        );
      } else {
        assert.equal(answer.sources.length, 0);
        assert.equal(
          answer.answer,
          'Будьте серъёзнее или задавайте более осознанные вопросы',
        );
      }
      await page.waitForFunction(
        () => !!planetApp.voice.npc.source,
        {},
        { timeout: 10000 },
      );
      assert.equal(
        await page.evaluate(
          () => planetApp.reactor.instructor.subtitle.textContent,
        ),
        answer.answer,
      );
      const audible = await page.evaluate(async () => {
        const npc = planetApp.voice.npc;
        const analyser = npc.context.createAnalyser();
        npc.bus.connect(analyser);
        const values = new Float32Array(analyser.fftSize);
        let peak = 0;
        for (let n = 0; n < 40; n++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          analyser.getFloatTimeDomainData(values);
          peak = Math.max(
            peak,
            Math.sqrt(
              values.reduce((sum, v) => sum + v * v, 0) / values.length,
            ),
          );
        }
        npc.bus.disconnect(analyser);
        return peak > 0.001 && npc.local.gain.value > 0;
      });
      assert(
        audible,
        'Server WAV must actually play through the voice-chat NPC bus',
      );
      console.log(
        JSON.stringify({
          question: questions[index],
          transcript: answer.transcript,
          answer: answer.answer,
          sources: answer.sources.length,
          audible,
        }),
      );
      await page.waitForFunction(
        () => !planetApp.engineer.localTurn,
        {},
        { timeout: 50000 },
      );
    }
    assert.equal(
      await page.evaluate(() =>
        engineerProbe.spoken.some((text) =>
          text.includes('спасибо за сообщение'),
        ),
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: live sign-in, mic-before-approach, automatic capture, real answers/fallback and audible backend WAV',
    );
    await page.evaluate(async () => {
      planetApp.voice.stop();
      await planetApp.network.auth.logout();
    });
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
