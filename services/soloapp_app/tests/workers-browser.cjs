// Local server :4193, Playwright + Chrome. Server timestamps and TTS are mocked;
// Babylon models, proximity and Network server-message handlers are real.
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
    const errors = [];
    for (const [index, page] of pages.entries()) {
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((index) => {
        const wall = Date.now.bind(Date);
        Date.now = () => wall() + index * 3600000;
        window.spoken = [];
        Object.defineProperty(window, 'speechSynthesis', {
          value: {
            getVoices: () => [],
            speak(u) {
              spoken.push(u.text);
              window.currentSpeech = u;
              u.onstart?.();
            },
            cancel() {
              window.currentSpeech = null;
            },
          },
        });
      }, index);
      await page.goto('http://127.0.0.1:4193/?reactor-test=1');
      await page.waitForFunction(
        () => window.planetApp?.reactor.workers,
        {},
        { timeout: 90000 },
      );
      assert.deepEqual(
        await page.evaluate(async () => planetApp.reactor.workers.ready),
        Array(7).fill(true),
      );
      await page.evaluate(async () => {
        const r = planetApp.reactor;
        r.player.position.set(0, 0, 0);
        await r.instructor.ready;
        window.spoken = [];
        r.instructor.stop();
        r.instructor.session.readyAt = performance.now() + 1000000;
        r.instructor.session.state = {
          kind: 'intro',
          text: 'Продолжаем вводное занятие.',
          revision: 1,
          index: 0,
          session: 'workers-test',
        };
        r.instructor.session.deadline = performance.now() + 1000000;
        r.instructor.present(r.instructor.session.state);
      });
      assert.equal(
        await page.evaluate(() => planetApp.reactor.instructor.nameLabel.name),
        'Главный инженер',
      );
      assert.deepEqual(
        await page.evaluate(() =>
          planetApp.reactor.workers.workers.map((w) => w.label.name),
        ),
        Array.from({ length: 7 }, (_, i) => `Работник ${i + 1}`),
      );
    }
    const [a, b] = pages;
    const stamp = Date.UTC(2026, 10, 1, 12);
    // Identical received DB timestamp: freeze the monotonic part for an exact
    // comparison, then explicitly advance one client's clock to test walking.
    for (const page of pages)
      await page.evaluate((stamp) => {
        const app = planetApp;
        app.reactor.workers.clock.monotonic = () => 1000;
        app.network.message({
          type: 'reactor_state',
          storage: 'postgresql',
          serverTime: stamp,
        });
        app.reactor.workers.update(0.016);
      }, stamp);
    const positions = (page) =>
      page.evaluate(() =>
        planetApp.reactor.workers.workers.map((w) =>
          w.avatar.root.position.asArray(),
        ),
      );
    assert.deepEqual(
      await positions(a),
      await positions(b),
      'late joiner with one-hour clock skew converges',
    );
    const before = await positions(a);
    await a.evaluate(() => {
      planetApp.reactor.workers.clock.monotonic = () => 4000;
      planetApp.reactor.workers.update(0.016);
    });
    assert.notDeepEqual(await positions(a), before);
    // Walk the whole loop against actual furniture mesh bounds, including
    // cabinets that are not player colliders. Exclude NPCs and ceiling/floor.
    const collisions = await a.evaluate(async () => {
      const { workerPose, WORKER_PERIOD } =
        await import('/client/worker-patrol.js');
      const r = planetApp.reactor;
      const furniture = r.root.getChildMeshes().filter((mesh) => {
        if (
          mesh.isDescendantOf(r.instructor.avatar.root) ||
          r.workers.workers.some((w) => mesh.isDescendantOf(w.avatar.root))
        )
          return false;
        mesh.computeWorldMatrix(true);
        const { minimumWorld: lo, maximumWorld: hi } =
          mesh.getBoundingInfo().boundingBox;
        return lo.y < 1.75 && hi.y > 0.15;
      });
      const hit = new Set();
      for (let time = 0; time < WORKER_PERIOD * 1000; time += 100) {
        const p = workerPose(0, time);
        for (const mesh of furniture) {
          const { minimumWorld: lo, maximumWorld: hi } =
            mesh.getBoundingInfo().boundingBox;
          if (
            p.x > lo.x - 0.3 &&
            p.x < hi.x + 0.3 &&
            p.z > lo.z - 0.3 &&
            p.z < hi.z + 0.3
          )
            hit.add(mesh.name);
        }
      }
      return [...hit];
    });
    assert.deepEqual(
      collisions,
      [],
      'route must clear furniture with body radius',
    );
    const approach = await a.evaluate(() => {
      const r = planetApp.reactor;
      r.player.position.copyFrom(r.workers.workers[0].avatar.root.position);
      r.workers.proximity.reset();
      r.workers.update(0.016);
      return {
        speech: currentSpeech?.text,
        bubble: r.workers.workers[0].bubble.isEnabled(),
      };
    });
    assert.deepEqual(approach, {
      speech: 'Извините, сейчас я занят',
      bubble: true,
    });
    await a.evaluate(() => currentSpeech.onend());
    assert.equal(
      await a.evaluate(() => currentSpeech?.text),
      'Продолжаем вводное занятие.',
    );
    const count = await a.evaluate(
      () => spoken.filter((s) => s === 'Извините, сейчас я занят').length,
    );
    await a.evaluate(() => {
      const r = planetApp.reactor;
      r.workers.proximity.nextReply = 0;
      r.workers.proximity.cooldowns.clear();
      r.workers.update(0.016);
    });
    assert.equal(
      await a.evaluate(
        () => spoken.filter((s) => s === 'Извините, сейчас я занят').length,
      ),
      count,
      'standing near worker must not repeat',
    );
    for (const mode of ['announcement', 'voice', 'muted', 'physical']) {
      await a.evaluate((mode) => {
        const r = planetApp.reactor,
          i = r.instructor;
        r.workers.proximity.reset();
        if (mode === 'announcement') i.setAnnouncementActive(true);
        if (mode === 'voice') i.session.voice(0, true);
        if (mode === 'muted') i.enabled = false;
        if (mode === 'physical') r.physicalView = true;
        r.workers.update(0.016);
      }, mode);
      assert.equal(
        await a.evaluate(
          () => spoken.filter((s) => s === 'Извините, сейчас я занят').length,
        ),
        count,
        mode,
      );
      await a.evaluate(() => {
        const r = planetApp.reactor;
        r.physicalView = false;
        r.instructor.enabled = true;
        r.instructor.session.voices.clear();
        r.instructor.setAnnouncementActive(false);
        r.workers.proximity.nextReply = Infinity;
      });
    }
    // An already speaking worker yields immediately, including the mute button.
    for (const mode of ['mute', 'announcement', 'listening']) {
      const result = await a.evaluate((mode) => {
        const i = planetApp.reactor.instructor;
        i.replyToVisitor('Извините, сейчас я занят');
        const started = currentSpeech?.text;
        if (mode === 'mute') i.toggle();
        if (mode === 'announcement') i.setAnnouncementActive(true);
        if (mode === 'listening')
          i.present({ kind: 'listening', text: 'Слушаю участника.' });
        const stopped = currentSpeech === null && !i.workerReply;
        i.enabled = true;
        i.setAnnouncementActive(false);
        return { started, stopped };
      }, mode);
      assert.deepEqual(
        result,
        { started: 'Извините, сейчас я занят', stopped: true },
        mode,
      );
    }
    // A local reply does not affect the other participant's narration.
    assert.equal(
      await b.evaluate(() => spoken.includes('Извините, сейчас я занят')),
      false,
    );
    await a.evaluate(() => {
      const r = planetApp.reactor;
      r.player.position.set(0, 0, 4.5);
      r.player.pitch = 0;
      r.player.camera.fov = 1.5;
      r.player.forward.set(0, 0, 1);
      r.player.update(0);
    });
    await a.waitForTimeout(1000);
    await a.screenshot({ path: '/tmp/soloapp-workers.png' });
    assert.deepEqual(errors, []);
    console.log(
      'PASS: seven models, labels, server clock synchronization, furniture clearance, proximity, speech priorities and resume',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
