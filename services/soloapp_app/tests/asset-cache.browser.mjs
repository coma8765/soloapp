import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';

const { chromium } = await import(
  process.env.SOLOAPP_PLAYWRIGHT_MODULE || 'playwright'
);
const publicRoot = resolve(
  fileURLToPath(new URL('../public/', import.meta.url)),
);
const requests = new Map();
let fixture = 'old';
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  requests.set(pathname, (requests.get(pathname) || 0) + 1);
  if (pathname === '/blank') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<canvas id="world"></canvas><script src="/vendor/babylon.js"></script><script src="/vendor/babylonjs.loaders.min.js"></script>',
    );
    return;
  }
  if (pathname === '/assets/cache-fixture.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ value: fixture }));
    return;
  }
  const name = pathname.replace(/^\/web\/releases\/[a-f0-9]{40}\//, '/');
  const file = resolve(publicRoot, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(publicRoot + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
        '.glb': 'model/gltf-binary',
      }[extname(file)] || 'application/octet-stream',
    );
    // The application cache is tested independently from the HTTP cache.
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.SOLOAPP_BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  const prefix = `/web/releases/${'a'.repeat(40)}`;
  const load = async () => {
    await page.goto(base + '/blank');
    await page.evaluate(async (prefix) => {
      window.assetModule = await import(prefix + '/client/asset-cache.js');
      const url = new URL(prefix + '/assets/lakes.json', location.href);
      const responses = await Promise.all([
        assetModule.fetchAsset(url),
        assetModule.fetchAsset(url),
      ]);
      const maps = await Promise.all(responses.map((r) => r.json()));
      if (!maps.every((map) => map.lakes.length > 0))
        throw Error('Missing lake data');
    }, prefix);
  };
  await load();
  assert.equal(requests.get(prefix + '/assets/lakes.json'), 1);
  await load();
  assert.equal(
    requests.get(prefix + '/assets/lakes.json'),
    1,
    'page reload uses persistent bytes',
  );
  await context.setOffline(true);
  assert(
    await page.evaluate(
      async (prefix) =>
        (
          await (
            await assetModule.fetchAsset(
              new URL(prefix + '/assets/lakes.json', location.href),
            )
          ).json()
        ).lakes.length > 0,
      prefix,
    ),
  );
  await context.setOffline(false);
  const next = `/web/releases/${'b'.repeat(40)}`;
  await page.evaluate(async (prefix) => {
    const mod = await import(prefix + '/client/asset-cache.js');
    await mod.fetchAsset(new URL(prefix + '/assets/lakes.json', location.href));
  }, next);
  assert.equal(
    requests.get(next + '/assets/lakes.json'),
    1,
    'new release downloads new URL',
  );
  const dev = () =>
    page.evaluate(async () => {
      const mod = await import('/client/asset-cache.js');
      return (
        await (
          await mod.fetchAsset(
            new URL('/assets/cache-fixture.json', location.href),
          )
        ).json()
      ).value;
    });
  assert.equal(await dev(), 'old');
  fixture = 'new';
  assert.equal(
    await dev(),
    'new',
    'development asset changes are visible immediately',
  );
  const models = [
    'avatar/player.glb',
    'professor/professor-einstein.glb',
    'marine/clownfish.glb',
  ];
  const results = await page.evaluate(
    async ({ prefix, models }) => {
      const engine = new BABYLON.Engine(document.getElementById('world'), true);
      const scene = new BABYLON.Scene(engine);
      const result = [];
      for (const model of models) {
        const url = new URL(prefix + '/assets/' + model, location.href).href;
        const first = await assetModule.loadAssetContainer(url, scene);
        const second = await assetModule.loadAssetContainer(url, scene);
        result.push({
          model,
          meshes: first.meshes.length,
          distinct: first !== second,
          textures: first.textures.every((texture) => texture.isReady()),
        });
        first.dispose();
        second.dispose();
      }
      engine.dispose();
      return result;
    },
    { prefix, models },
  );
  for (const result of results) {
    assert(
      result.meshes > 0 && result.distinct && result.textures,
      JSON.stringify(result),
    );
    assert.equal(requests.get(prefix + '/assets/' + result.model), 1);
  }
  await page.goto(base + '/');
  await page.waitForFunction(() => !!window.planetApp, undefined, {
    timeout: 60000,
  });
  assert(
    await page.evaluate(async () => {
      const avatarReady = await planetApp.player.avatar.ready;
      return avatarReady && document.getElementById('fatal').hidden;
    }),
  );
  console.log(
    JSON.stringify({
      persistentReload: true,
      offlineAssetHit: true,
      releaseIsolation: true,
      developmentUpdate: true,
      models: results,
      appBoot: true,
    }),
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
