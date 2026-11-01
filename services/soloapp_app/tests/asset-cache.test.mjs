import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetCache } from '../public/client/asset-cache.js';

const release = (id) => `https://planet.test/web/releases/${id.repeat(40)}/assets/`;
const root = release('a');
const body = (value, headers = {}) => new Response(value, { headers });
function storage() {
  const entries = new Map();
  const cache = {
    match: async (key) => entries.get(String(key))?.clone(),
    put: async (key, value) => { entries.set(String(key), value.clone()); },
    delete: async (key) => entries.delete(String(key)),
    keys: async () => [...entries.keys()],
  };
  return { entries, cache, open: async () => cache };
}
function setup(options = {}) {
  const store = storage();
  const calls = [];
  const config = {
    root,
    storage: () => store,
    fetcher: async (url, init) => { calls.push({ url, init }); return body('asset'); },
    ...options,
  };
  return { client: new AssetCache(config), config, store, calls };
}

test('immutable assets survive a new loader instance and retain independent bodies', async () => {
  const { client, config, calls } = setup();
  assert.equal(await (await client.fetch(root + 'world.json')).text(), 'asset');
  const nextPage = new AssetCache(config);
  assert.equal(await (await nextPage.fetch(root + 'world.json')).text(), 'asset');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, 'omit');
});

test('concurrent consumers download once and can all consume the response', async () => {
  const { client, calls } = setup();
  const responses = await Promise.all(Array.from({ length: 8 }, () => client.fetch(root + 'avatar.glb')));
  assert.deepEqual(await Promise.all(responses.map((r) => r.text())), Array(8).fill('asset'));
  assert.equal(calls.length, 1);
});

test('a new release never reads the previous release bytes', async () => {
  const { client, config, calls } = setup();
  await client.fetch(root + 'world.json');
  const updated = new AssetCache({ ...config, root: release('b') });
  await updated.fetch(release('b') + 'world.json');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].url, calls[1].url);
});

test('query versions are distinct, fragments do not cause duplicate downloads', async () => {
  const { client, calls } = setup();
  await client.fetch(root + 'world.json?v=1#first');
  await client.fetch(root + 'world.json?v=1#second');
  await client.fetch(root + 'world.json?v=2');
  assert.equal(calls.length, 2);
});

test('unversioned development assets revalidate and update; offline can use the last copy', async () => {
  let value = 'old';
  const calls = [];
  const { client } = setup({
    root: 'http://localhost:4173/assets/',
    fetcher: async (_url, init) => {
      calls.push(init);
      if (value === 'offline') throw Error('offline');
      return body(value);
    },
  });
  assert.equal(await (await client.fetch('world.json')).text(), 'old');
  value = 'new';
  assert.equal(await (await client.fetch('world.json')).text(), 'new');
  value = 'offline';
  assert.equal(await (await client.fetch('world.json')).text(), 'new');
  assert(calls.every((init) => init.cache === 'no-cache'));
});

test('API and foreign-origin requests bypass cache', async () => {
  const { client, store, calls } = setup();
  for (const url of ['https://planet.test/api/me', 'https://other.test/assets/a.glb']) {
    await client.fetch(url);
    await client.fetch(url);
  }
  assert.equal(calls.length, 4);
  assert.equal(store.entries.size, 0);
  assert(calls.every((call) => call.init === undefined));
});

test('denied CacheStorage does not prevent network loading', async () => {
  const { client, calls } = setup({ storage: () => { throw Error('denied'); } });
  assert.equal(await (await client.fetch('world.json')).text(), 'asset');
  assert.equal(calls.length, 1);
});

test('quota failures do not discard a successful download', async () => {
  const { client, store } = setup();
  store.cache.put = async () => { throw Error('quota'); };
  assert.equal(await (await client.fetch('world.json')).text(), 'asset');
});

test('network failures are retryable and do not poison concurrent loads', async () => {
  let calls = 0;
  const { client } = setup({ fetcher: async () => {
    if (++calls === 1) throw Error('offline');
    return body('recovered');
  } });
  const first = await Promise.allSettled([client.fetch('a.glb'), client.fetch('a.glb')]);
  assert(first.every((r) => r.status === 'rejected'));
  assert.equal(await (await client.fetch('a.glb')).text(), 'recovered');
  assert.equal(calls, 2);
});

test('HTTP errors, partial responses, HTML and private responses are not persisted', async () => {
  for (const response of [
    new Response('missing', { status: 404 }),
    new Response('unavailable', { status: 503 }),
    new Response('partial', { status: 206 }),
    body('<html>fallback</html>', { 'content-type': 'text/html' }),
    body('secret', { 'cache-control': 'private' }),
    body('temporary', { 'cache-control': 'no-store' }),
  ]) {
    const { client, store } = setup({ fetcher: async () => response.clone() });
    assert.equal((await client.fetch('a.glb')).status, response.status);
    assert.equal(store.entries.size, 0);
  }
});

test('fresh development no-store removes an older cache entry', async () => {
  let response = body('old');
  const { client, store } = setup({
    root: 'http://localhost/assets/', fetcher: async () => response.clone(),
  });
  await client.fetch('a.json');
  assert.equal(store.entries.size, 1);
  response = body('new', { 'cache-control': 'no-store' });
  await client.fetch('a.json');
  assert.equal(store.entries.size, 0);
});

test('concurrent writes enforce byte and entry budgets with FIFO eviction', async () => {
  const { client, store } = setup({ maxBytes: 10, maxEntries: 2 });
  await Promise.all(['a.glb', 'b.glb', 'c.glb'].map((url) => client.fetch(url)));
  assert.deepEqual([...store.entries.keys()], [root + 'b.glb', root + 'c.glb']);
  const sizes = [...store.entries.values()].map((r) => Number(r.headers.get('x-microplanet-cache-bytes')));
  assert.equal(sizes.reduce((a, b) => a + b, 0), 10);
});

test('oversized assets load but are not persisted', async () => {
  const { client, store } = setup({ maxBytes: 4 });
  assert.equal(await (await client.fetch('a.glb')).text(), 'asset');
  assert.equal(store.entries.size, 0);
});

test('an oversized development replacement cannot leave stale offline bytes', async () => {
  let value = 'old';
  const { client, store } = setup({
    root: 'http://localhost/assets/', maxBytes: 4,
    fetcher: async () => body(value),
  });
  await client.fetch('a.json');
  assert.equal(store.entries.size, 1);
  value = 'oversized replacement';
  assert.equal(await (await client.fetch('a.json')).text(), value);
  assert.equal(store.entries.size, 0);
});
