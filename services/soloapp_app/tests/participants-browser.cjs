// Local UI fixture; authorization is tested separately by participants-integration.py.
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
    const base = process.env.PARTICIPANTS_TEST_URL || 'http://127.0.0.1:4199';
    assert.equal(new URL(base).hostname, '127.0.0.1');
    await page.goto(base + '/?reactor-test=1');
    await page.waitForFunction(
      () => window.planetApp?.network,
      {},
      { timeout: 90000 },
    );
    const roster = {
      type: 'participants',
      admin: true,
      players: Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        email: i === 0 ? 'a@gmail.com' : `participant${i}@example.test`,
        ping: 12 + i * 18,
        fps: 90 - i * 7,
      })),
    };
    await page.evaluate((roster) => {
      document.body.classList.remove('auth-required');
      const n = planetApp.network;
      n.id = 1;
      n.email = 'a@gmail.com';
      n.message(roster);
    }, roster);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('#participant-metrics tbody tr').length === 8,
    );
    assert(await page.locator('#participant-metrics').isVisible());
    assert.equal(
      await page
        .locator('#participant-metrics tbody tr:first-child td:first-child')
        .textContent(),
      'a@gmail.com',
    );
    assert.equal(
      await page
        .locator('#participant-metrics tbody tr:last-child td:last-child')
        .textContent(),
      '41',
    );
    const hud = await page.evaluate(() => planetApp.xr.hudText());
    assert(hud.includes('participant7@example.test'));
    assert.equal(hud.split('\n').length, 9);
    assert.equal(
      await page.evaluate(() => planetApp.reactor.actorLabel(2)),
      'participant1@example.test',
    );
    await page.screenshot({ path: '/tmp/soloapp-admin-metrics-desktop.png' });
    for (const mode of [
      'in-physical-system',
      'at-journal',
      'touch-device playing',
    ]) {
      await page.evaluate(
        (mode) => document.body.classList.add(...mode.split(' ')),
        mode,
      );
      assert(await page.locator('#participant-metrics').isVisible(), mode);
      await page.evaluate(
        (mode) => document.body.classList.remove(...mode.split(' ')),
        mode,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate((roster) => {
      planetApp.network.message(roster);
      document.body.classList.add('touch-device', 'playing');
    }, roster);
    await page.waitForTimeout(600); // Let the resized Babylon canvas settle.
    await page.screenshot({ path: '/tmp/soloapp-admin-metrics-mobile.png' });
    const box = await page.locator('#participant-metrics').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 390);
    await page.evaluate(
      (roster) => planetApp.network.message({ ...roster, admin: false }),
      roster,
    );
    await page.waitForFunction(
      () => document.querySelector('#participant-metrics').hidden,
    );
    assert.equal(
      await page.locator('#participant-metrics tbody tr').count(),
      0,
    );
    await page.evaluate((roster) => {
      planetApp.network.message(roster);
      planetApp.network.disconnect();
    }, roster);
    await page.waitForFunction(
      () => document.querySelector('#participant-metrics').hidden,
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: actual Babylon UI, eight emails/metrics, VR HUD text, reactor/journal/mobile visibility, regular account and logout cleanup',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
