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
      await page.goto(
        (process.env.SOLOAPP_BASE_URL || 'http://127.0.0.1:4193') +
          '/?reactor-test=1',
      );
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
    // Sample seeded random paths against actual furniture, excluding NPCs and floor.
    const collisions = await a.evaluate(async () => {
      const { workerPose, WORKER_LEG_MS } =
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
      for (let time = 0; time < WORKER_LEG_MS * 8; time += 1000) {
        const p = workerPose(
          Math.floor(time / WORKER_LEG_MS) % 7,
          time,
          r.workers.navigation,
        );
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
      'random routes must clear furniture with body radius',
    );
    await b.evaluate(() => {
      planetApp.reactor.workers.proximity.nextReply = Infinity;
      planetApp.reactor.instructor.finishWorkerReply();
      window.spoken = [];
    });
    const contacts = await a.evaluate(async () => {
      const { workerDestination } = await import('/client/worker-patrol.js');
      const { REACTOR_MAP, PHYSICAL_MAP } = await import('/shared/room.js');
      const r = planetApp.reactor,
        p = r.player,
        workers = r.workers;
      p.scene.getEngine().stopRenderLoop();
      const actor = workers.workers[0];
      let time = workers.clock.now();
      workers.clock.now = () => time;
      const reset = () => {
        workers.workers.forEach((w, i) => {
          w.avatar.root.position.set(i ? -8 + i * 1.3 : 0, 0, i ? 6 : 0);
          w.path = [];
          w.replanAt = Infinity;
          w.goalKey = workerDestination(i, time, workers.navigation).key;
        });
        workers.lastTime = time;
        workers.initialized = true;
      };
      p.inputEnabled = true;
      const approaches = [];
      for (const mode of ['gamepad', 'touch', 'xr']) {
        reset();
        p.position.set(0, 0, 3);
        p.forward.set(0, 0, -1);
        p.xr = mode === 'xr';
        p.gamepadMove = mode === 'gamepad' ? { x: 0, y: 1 } : null;
        p.touchMove = mode === 'touch' ? { x: 0, y: 1 } : null;
        for (let i = 0; i < 8; i++)
          p.update(0.5, mode === 'xr' ? p.forward.clone() : null);
        approaches.push({
          mode,
          z: p.position.z,
          distance: BABYLON.Vector3.Distance(
            p.position,
            actor.avatar.root.position,
          ),
        });
      }
      p.xr = false;
      p.gamepadMove = p.touchMove = null;
      reset();
      p.position.set(0, 0, 2);
      actor.path = [{ x: 0, z: 4 }];
      let closest = Infinity;
      for (let i = 0; i < 100; i++) {
        time += 50;
        workers.update(0.05);
        closest = Math.min(
          closest,
          BABYLON.Vector3.Distance(p.position, actor.avatar.root.position),
        );
      }
      const workerStopped = actor.avatar.root.position.z;
      const participantStayed = p.position.asArray();
      p.position.set(4, 0, 2);
      for (let i = 0; i < 40; i++) {
        time += 50;
        workers.update(0.05);
      }
      const resumed = actor.avatar.root.position.z > workerStopped + 0.5;
      reset();
      p.position.set(4, 0, 2);
      actor.path = [{ x: 0, z: 4 }];
      const remote = {
        state: { map: REACTOR_MAP },
        node: { position: new BABYLON.Vector3(0, 0, 2) },
      };
      planetApp.network.remotes.set(999, remote);
      for (let i = 0; i < 100; i++) {
        time += 50;
        workers.update(0.05);
      }
      const remoteDistance = BABYLON.Vector3.Distance(
        remote.node.position,
        actor.avatar.root.position,
      );
      remote.state.map = PHYSICAL_MAP;
      const stopped = actor.avatar.root.position.z;
      for (let i = 0; i < 40; i++) {
        time += 50;
        workers.update(0.05);
      }
      const otherMapIgnored = actor.avatar.root.position.z > stopped + 0.5;
      planetApp.network.remotes.delete(999);
      r.physicalView = true;
      const noGhosts = p.roomPeople().length === 0;
      r.physicalView = false;
      reset();
      return {
        approaches,
        closest,
        workerStopped,
        participantStayed,
        resumed,
        remoteDistance,
        otherMapIgnored,
        noGhosts,
      };
    });
    contacts.approaches.forEach((p) =>
      assert(p.distance >= 0.6999 && p.z > 0 && p.z < 0.71, JSON.stringify(p)),
    );
    assert(
      contacts.closest >= 0.6999 && contacts.workerStopped < 1.31,
      JSON.stringify(contacts),
    );
    assert.deepEqual(contacts.participantStayed, [0, 0, 2]);
    assert(
      contacts.resumed &&
        contacts.remoteDistance >= 0.6999 &&
        contacts.otherMapIgnored &&
        contacts.noGhosts,
      JSON.stringify(contacts),
    );

    const roaming = await a.evaluate(() => {
      const r = planetApp.reactor,
        w = r.workers;
      let time = Date.UTC(2026, 10, 1, 12);
      w.clock.now = () => time;
      r.player.position.set(0, 0, 3);
      w.initialized = false;
      r.instructor.enabled = false;
      w.update(0);
      const starts = w.workers.map((worker) =>
        worker.avatar.root.position.clone(),
      );
      const travelled = starts.map(() => 0);
      let minimum = Infinity,
        furnitureHits = 0;
      for (let frame = 0; frame < 650; frame++) {
        const before = w.workers.map((worker) =>
          worker.avatar.root.position.clone(),
        );
        time += 100;
        w.update(0.1);
        w.workers.forEach((worker, i) => {
          const p = worker.avatar.root.position;
          travelled[i] += BABYLON.Vector3.Distance(before[i], p);
          for (const person of [
            r.player.position,
            ...w.workers.slice(i + 1).map((v) => v.avatar.root.position),
          ])
            minimum = Math.min(minimum, BABYLON.Vector3.Distance(p, person));
          for (const mesh of w.furniture) {
            const { minimumWorld: lo, maximumWorld: hi } =
              mesh.getBoundingInfo().boundingBox;
            if (p.x > lo.x && p.x < hi.x && p.z > lo.z && p.z < hi.z)
              furnitureHits++;
          }
        });
      }
      r.instructor.enabled = true;
      // Restore a clear, isolated approach position for the existing speech checks.
      w.workers.forEach((worker, i) =>
        worker.avatar.root.position.set(i ? -8 + i * 1.3 : 0, 0, i ? 6 : 0),
      );
      return { minimum, furnitureHits, travelled };
    });
    assert(
      roaming.minimum >= 0.6999 && roaming.furnitureHits === 0,
      JSON.stringify(roaming),
    );
    assert(
      roaming.travelled.every((d) => d > 1),
      JSON.stringify(roaming),
    );

    const approach = await a.evaluate(() => {
      const r = planetApp.reactor;
      r.instructor.stop();
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
      'PASS: seven models, random navigation, shared clock, furniture clearance, mutual participant/worker collisions, remote peers, map isolation, proximity and speech priorities',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
