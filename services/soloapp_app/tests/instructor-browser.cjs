// Run against the local static server on port 4193; requires Playwright and Chrome.
// Test transport deliberately avoids ICE/TURN dependencies; it does not validate WebRTC connectivity.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext();
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    const errors = [];
    for (const page of pages) {
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => {
        window.spoken = [];
        Object.defineProperty(window, 'speechSynthesis', {
          value: {
            getVoices: () => [],
            speak(u) {
              window.spoken.push(u.text);
              window.currentSpeech = u;
              u.onstart?.();
            },
            cancel() {
              window.currentSpeech = null;
            },
          },
        });
      });
      await page.goto('http://127.0.0.1:4193/?reactor-test=1');
      await page.waitForFunction(
        () => window.planetApp?.reactor.instructor.session,
        {},
        { timeout: 90000 },
      );
    }
    const [a, b] = pages;
    for (const [index, page] of pages.entries())
      await page.exposeFunction('deliverControl', async (raw) => {
        await pages[1 - index].evaluate(
          (raw) => window.testChannel?.onmessage?.({ data: raw }),
          raw,
        );
      });
    for (const [index, page] of pages.entries())
      await page.evaluate((index) => {
        const app = planetApp;
        // Keep narration tests away from the worker proximity route.
        app.player.position.set(0, 0, 0);
        app.network.id = index + 1;
        app.reactor.instructor.session.reset();
        app.reactor.instructor.stop();
        app.reactor.instructor.session.readyAt = performance.now() + 100000;
        const peer = index === 0 ? 2 : 1;
        app.network.peers.set(peer, { pc: { close() {} } });
        window.testChannel = {
          label: 'control-v1',
          readyState: 'open',
          bufferedAmount: 0,
          send(raw) {
            void window.deliverControl(raw);
          },
        };
        app.network.bindPeer(peer, testChannel);
      }, index);
    for (const page of pages) await page.evaluate(() => testChannel.onopen());
    for (const page of pages)
      await page.waitForFunction(() => planetApp.network.remotes.size === 1);
    await a.evaluate(() => {
      const i = planetApp.reactor.instructor;
      i.session.readyAt = 0;
      i.tick();
    });
    await b.waitForFunction(
      () => planetApp.reactor.instructor.session.state?.kind === 'intro',
    );
    assert.equal(
      await a.evaluate(
        () => planetApp.reactor.instructor.session.state.session,
      ),
      await b.evaluate(
        () => planetApp.reactor.instructor.session.state.session,
      ),
    );
    const before = await b.evaluate(() => spoken.length);
    await b.waitForTimeout(2200);
    assert.equal(
      await b.evaluate(() => spoken.length),
      before,
      'heartbeat must not repeat audio',
    );
    // Accepted local command traverses the real Network handlers on a test transport.
    await b.evaluate(() => planetApp.reactor.commitAction('lamp-test'));
    await a.waitForFunction(() =>
      planetApp.reactor.instructor.session.state.text.includes('проверка ламп'),
    );
    await b.waitForFunction(() =>
      planetApp.reactor.instructor.session.state.text.includes('проверка ламп'),
    );
    // One participant starts talking; both stop the instructor before its comment.
    await b.evaluate(() => {
      const i = planetApp.reactor.instructor;
      i.session.voice(2, true);
      i.send({ kind: 'voice', active: true });
    });
    await a.waitForFunction(
      () => planetApp.reactor.instructor.session.state.kind === 'listening',
    );
    await b.waitForFunction(
      () => planetApp.reactor.instructor.session.state.kind === 'listening',
    );
    assert.equal(await a.evaluate(() => currentSpeech), null);
    await b.evaluate(() => {
      const i = planetApp.reactor.instructor;
      i.session.voice(2, false);
      i.send({ kind: 'voice', active: false });
    });
    await a.waitForFunction(
      () => planetApp.reactor.instructor.session.state.kind === 'intro',
    );
    await b.waitForFunction(
      () => planetApp.reactor.instructor.session.state.kind === 'intro',
    );
    // Leaving the elected participant hands the current cursor to participant 2.
    const cursor = await b.evaluate(
      () => planetApp.reactor.instructor.session.state.index,
    );
    await a.evaluate(() => {
      planetApp.reactor.cooldown = 0;
      planetApp.reactor.leave();
      planetApp.network.broadcastControl(
        planetApp.player.state(++planetApp.network.sequence),
      );
    });
    await b.waitForFunction(() => planetApp.reactor.teamLeader() === 2);
    await b.evaluate(() => {
      const i = planetApp.reactor.instructor;
      i.session.readyAt = 0;
      i.tick();
      i.session.finished(i.session.state.revision);
    });
    await b.waitForFunction(
      () => planetApp.reactor.instructor.session.state.kind === 'intro',
    );
    assert.equal(
      await b.evaluate(() => planetApp.reactor.instructor.session.state.index),
      cursor + 1,
    );
    assert.equal(
      await a.evaluate(() => planetApp.reactor.instructor.panel.hidden),
      true,
    );
    // Re-enter a populated room: request snapshot, do not start the introduction again.
    await a.evaluate(() => {
      planetApp.reactor.cooldown = 0;
      planetApp.reactor.enter();
      planetApp.network.broadcastControl(
        planetApp.player.state(++planetApp.network.sequence),
      );
      planetApp.reactor.instructor.send({ kind: 'request' });
    });
    await a.waitForFunction(
      () => planetApp.reactor.instructor.session.state?.kind === 'intro',
    );
    assert.equal(
      await a.evaluate(
        () => planetApp.reactor.instructor.session.state.session,
      ),
      await b.evaluate(
        () => planetApp.reactor.instructor.session.state.session,
      ),
    );
    // Browser denial and physical/desktop mute controls.
    await a.evaluate(() => {
      const i = planetApp.reactor.instructor;
      i.present(i.session.state);
      currentSpeech.onerror?.({ error: 'not-allowed' });
    });
    assert.equal(
      await a.evaluate(() => planetApp.reactor.instructor.playbackBlocked),
      true,
    );
    await a.locator('#reactor-instructor button').click();
    assert.equal(
      await a.evaluate(() => planetApp.reactor.instructor.playbackBlocked),
      false,
    );
    await a.evaluate(() =>
      planetApp.reactor.activatePhysical(planetApp.reactor.instructor.screen),
    );
    assert.equal(
      await a.evaluate(() => planetApp.reactor.instructor.enabled),
      false,
    );
    // Shift announcement takes local audio priority, then the sentence resumes.
    await a.evaluate(() => {
      const i = planetApp.reactor.instructor;
      i.toggle();
      i.setAnnouncementActive(true);
      if (currentSpeech !== null)
        throw Error('Instructor overlaps shift announcement');
      i.setAnnouncementActive(false);
      if (!currentSpeech)
        throw Error('Instructor did not resume after announcement');
    });
    // Old server-history records and duplicates do not produce new comments.
    assert.equal(
      await a.evaluate(() => {
        const i = planetApp.reactor.instructor;
        i.session.pending = null;
        i.commandRevision = 100;
        i.serverControl({ revision: 100 }, 'old', 'test');
        return i.session.pending;
      }),
      null,
    );
    await a.evaluate(async () => {
      window.testAudio = new AudioContext();
      await testAudio.resume();
      const destination = testAudio.createMediaStreamDestination();
      window.testOscillator = testAudio.createOscillator();
      testOscillator.connect(destination);
      testOscillator.start();
      planetApp.network.voice.stream = destination.stream;
    });
    await a.waitForFunction(
      () => planetApp.reactor.instructor.session.state.kind === 'listening',
    );
    await a.evaluate(() => {
      testOscillator.stop();
      planetApp.network.voice.stream.getTracks()[0].enabled = false;
    });
    await a.waitForFunction(
      () => planetApp.reactor.instructor.session.state.kind === 'intro',
    );
    assert.equal(
      await a.evaluate(
        () => planetApp.network.voice.stream.getTracks()[0].readyState,
      ),
      'live',
    );
    await a.evaluate(async () => {
      planetApp.network.voice.stream = null;
      await testAudio.close();
    });
    assert.deepEqual(errors, []);
    console.log(
      'PASS: two-tab Network handlers with test transport, shared narration, control reaction, voice interruption, handoff, re-entry, audio unlock, physical mute, history filtering; no page errors',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
