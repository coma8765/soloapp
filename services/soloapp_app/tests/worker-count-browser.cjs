// Real Babylon room; local UI/door fixture. Auth and two replicas are tested by
// participants-integration.py. Accelerate walking without changing its timestep.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:4199/?reactor-test=1');
    await page.waitForFunction(
      () => window.planetApp?.network,
      {},
      { timeout: 90000 },
    );
    await page.evaluate(async () => {
      const { network: n, reactor: r } = planetApp;
      document.body.classList.remove('auth-required');
      await r.workers.ready;
      n.id = 1;
      n.message({
        type: 'participants',
        admin: true,
        players: [{ id: 1, email: 'a@gmail.com', ping: 10, fps: 60 }],
      });
      n.message({
        type: 'workers_state',
        storage: 'postgresql',
        revision: 1,
        count: 7,
      });
      window.workerRequests = [];
      n.send = (m) => {
        if (m.type !== 'workers_set') return true;
        workerRequests.push(m);
        n.message({
          type: 'workers_state',
          storage: 'postgresql',
          revision: m.revision + 1,
          count: m.count,
        });
        setTimeout(
          () =>
            n.message({
              type: 'workers_ack',
              requestId: m.requestId,
              accepted: true,
            }),
          0,
        );
        return true;
      };
    });
    await page.waitForFunction(
      () => !document.querySelector('#worker-controls button').disabled,
    );
    assert.equal(await page.locator('#worker-controls button').count(), 10);
    await page.getByRole('button', { name: 'Учёных: 1', exact: true }).click();
    await page.waitForFunction(
      () =>
        planetApp.reactor.workers.sync.count === 1 &&
        !planetApp.reactor.workers.sync.pending,
    );
    await page.waitForFunction(
      () => !document.querySelectorAll('#worker-controls button')[9].disabled,
    );
    const reduced = await page.evaluate(() => {
      const r = planetApp.reactor,
        w = r.workers;
      window.workerRenderLoops = [...r.scene.getEngine()._activeRenderLoops];
      r.scene.getEngine().stopRenderLoop();
      r.player.position.set(-8, 0, 8);
      w.proximity.nextReply = Infinity;
      let time = w.clock.now();
      w.clock.now = () => time;
      w.lastTime = time;
      const removed = [];
      const remove = w.remove.bind(w);
      w.remove = (worker) => {
        removed.push(worker.avatar.root.position.asArray());
        remove(worker);
      };
      for (const worker of w.workers) {
        worker.originalUpdate = worker.avatar.update;
        worker.avatar.update = () => {};
      }
      for (let i = 0; i < 5000 && w.workers.length > 1; i++) {
        time += 100;
        r.door.update(0.1);
        w.update(0.1);
      }
      window.workerTestTime = time;
      return {
        count: w.workers.length,
        removed,
        remaining: w.workers.map((v) => ({
          index: v.index,
          p: v.avatar.root.position.asArray(),
          path: v.path.map((p) => ({ x: p.x, z: p.z })),
        })),
      };
    });
    assert.equal(reduced.count, 1, JSON.stringify(reduced));
    assert.equal(reduced.removed.length, 6);
    for (const p of reduced.removed)
      assert(
        Math.abs(p[0]) < 0.1 && p[2] > 11.2,
        'despawn only beyond common door',
      );
    const increased = await page.evaluate(() => {
      const r = planetApp.reactor,
        w = r.workers;
      let time = workerTestTime;
      w.clock.now = () => time;
      const created = [],
        create = w.create.bind(w);
      w.create = (index) => {
        const worker = create(index);
        worker.originalUpdate = worker.avatar.update;
        worker.avatar.update = () => {};
        return worker;
      };
      const known = new Set(w.workers);
      // Exercise the actual tenth button while the render loop is paused.
      document.querySelectorAll('#worker-controls button')[9].click();
      // A participant occupying the doorway blocks arrivals until they move.
      r.player.position.set(0, 0, r.exitPortal.position.z);
      for (let i = 0; i < 100; i++) {
        time += 100;
        r.door.update(0.1);
        w.update(0.1);
      }
      const blockedCount = w.workers.length;
      r.player.position.set(-8, 0, 8);
      for (
        let i = 0;
        i < 5000 &&
        (w.workers.length < 10 || w.workers.some((v) => v.entering));
        i++
      ) {
        time += 100;
        r.door.update(0.1);
        w.update(0.1);
        for (const worker of w.workers)
          if (!known.has(worker)) {
            known.add(worker);
            created.push(worker.avatar.root.position.asArray());
          }
      }
      window.workerTestTime = time;
      return {
        count: w.workers.length,
        blockedCount,
        created,
        entering: w.workers.filter((v) => v.entering).length,
        positions: w.workers.map((v) => v.avatar.root.position.asArray()),
        ids: w.workers.map((v) => v.index),
      };
    });
    assert.equal(increased.blockedCount, 1);
    assert.equal(increased.count, 10, JSON.stringify(increased));
    assert.equal(increased.entering, 0, JSON.stringify(increased));
    assert.equal(new Set(increased.ids).size, 10);
    assert.equal(increased.created.length, 9);
    for (const p of increased.created)
      assert(Math.abs(p[0]) < 0.1 && p[2] > 11.2, 'spawn at common door');
    const reversed = await page.evaluate(() => {
      const r = planetApp.reactor,
        w = r.workers,
        n = planetApp.network;
      let time = workerTestTime;
      w.clock.now = () => time;
      n.message({
        type: 'workers_state',
        storage: 'postgresql',
        revision: 10,
        count: 1,
      });
      for (let i = 0; i < 60; i++) {
        time += 100;
        r.door.update(0.1);
        w.update(0.1);
      }
      n.message({
        type: 'workers_state',
        storage: 'postgresql',
        revision: 11,
        count: 10,
      });
      for (let i = 0; i < 3000; i++) {
        time += 100;
        r.door.update(0.1);
        w.update(0.1);
        if (
          w.workers.length === 10 &&
          w.workers.every((v) => !v.entering && !v.leaving)
        )
          break;
      }
      return {
        count: w.workers.length,
        unique: new Set(w.workers.map((v) => v.index)).size,
        settled: w.workers.every((v) => !v.entering && !v.leaving),
      };
    });
    assert.deepEqual(reversed, { count: 10, unique: 10, settled: true });
    await page.evaluate(async () => {
      const r = planetApp.reactor,
        w = r.workers;
      await Promise.all(w.workers.map((v) => v.avatar.ready));
      for (const worker of w.workers)
        worker.avatar.update = worker.originalUpdate;
      r.player.position.set(0, 0, 8);
      workerRenderLoops.forEach((fn) => r.scene.getEngine().runRenderLoop(fn));
    });
    await page.waitForFunction(
      () =>
        document
          .querySelectorAll('#worker-controls button')[9]
          .getAttribute('aria-pressed') === 'true',
    );
    await page.screenshot({ path: '/tmp/soloapp-worker-count.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await page.locator('#worker-controls').boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= 390);
    // Buttons may never submit on account change, even before the next HUD tick.
    assert(
      await page.evaluate(() => {
        const n = planetApp.network;
        n.message({ type: 'participants', admin: false, players: [] });
        const before = workerRequests.length;
        document.querySelectorAll('#worker-controls button')[2].click();
        return workerRequests.length === before;
      }),
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: ten admin buttons; 7 → 1 → 10 through shared doorway; unique workers; mobile bounds; account change',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
