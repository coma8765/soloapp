// Only public assets use this cache; API calls and authentication stay on fetch.
const CACHE_NAME = 'microplanet-assets-v1';
const SIZE_HEADER = 'x-microplanet-cache-bytes';

export class AssetCache {
  constructor({
    root = new URL('../assets/', import.meta.url),
    storage = () => globalThis.caches,
    fetcher = (...args) => globalThis.fetch(...args),
    maxBytes = 128 * 1024 * 1024,
    maxEntries = 64,
  } = {}) {
    this.root = new URL(root);
    this.storage = storage;
    this.fetcher = fetcher;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.pending = new Map();
    this.writes = Promise.resolve();
  }

  async fetch(input) {
    const url = new URL(input, this.root);
    url.hash = '';
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== this.root.origin ||
      !url.pathname.startsWith(this.root.pathname)
    )
      return this.fetcher(url.href);
    let pending = this.pending.get(url.href);
    if (!pending) {
      pending = this.load(url);
      this.pending.set(url.href, pending);
    }
    try {
      // Every consumer owns its body, including simultaneous JSON/GLB loads.
      return (await pending).clone();
    } finally {
      if (this.pending.get(url.href) === pending) this.pending.delete(url.href);
    }
  }

  async load(url) {
    let cache, cached;
    try {
      cache = await this.storage()?.open(CACHE_NAME);
      cached = await cache?.match(url.href);
    } catch {
      // Private mode, storage eviction and quota errors must not break loading.
    }
    const immutable = /^\/web\/releases\/[0-9a-f]{40}\/assets\//.test(
      url.pathname,
    );
    if (immutable && cached) return cached;
    let response;
    try {
      response = await this.fetcher(url.href, {
        credentials: 'omit',
        cache: immutable ? 'default' : 'no-cache',
      });
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
    if (cache) {
      // Serialize writes/eviction so concurrent assets share one byte budget.
      this.writes = this.writes
        .then(() => this.remember(cache, url.href, response))
        .catch(() => {});
      await this.writes;
    }
    return response;
  }

  async remember(cache, url, response) {
    if (
      response.status !== 200 ||
      response.redirected ||
      /(?:no-store|private)/i.test(
        response.headers.get('cache-control') || '',
      ) ||
      /text\/html/i.test(response.headers.get('content-type') || '')
    ) {
      await cache.delete(url);
      return;
    }
    const blob = await response.clone().blob();
    if (blob.size > this.maxBytes || this.maxEntries < 1) {
      await cache.delete(url);
      return;
    }
    const headers = new Headers(response.headers);
    headers.set(SIZE_HEADER, String(blob.size));
    // fetch has already decoded compression; the cached body is the blob.
    headers.delete('content-encoding');
    headers.set('content-length', String(blob.size));
    await cache.delete(url);
    const entries = [];
    let bytes = blob.size;
    for (const key of await cache.keys()) {
      const entry = await cache.match(key);
      const size = Number(entry?.headers.get(SIZE_HEADER));
      if (
        !entry ||
        !Number.isFinite(size) ||
        size < 0 ||
        !entry.headers.has(SIZE_HEADER)
      ) {
        await cache.delete(key);
        continue;
      }
      entries.push({ key, size });
      bytes += size;
    }
    // FIFO across releases; old versions cannot accumulate without a bound.
    while (entries.length >= this.maxEntries || bytes > this.maxBytes) {
      const oldest = entries.shift();
      if (!oldest) break;
      await cache.delete(oldest.key);
      bytes -= oldest.size;
    }
    await cache.put(url, new Response(blob, { headers }));
  }
}

const assets = new AssetCache();
export const fetchAsset = (url) => assets.fetch(url);

export async function loadAssetContainer(url, scene) {
  const response = await fetchAsset(url);
  if (!response.ok)
    throw Error(`Asset unavailable (${response.status}): ${url}`);
  // Each scene owns its Babylon objects; only the downloaded bytes are shared.
  // The explicit root preserves relative resources in GLB files.
  return globalThis.BABYLON.LoadAssetContainerAsync(
    new Uint8Array(await response.arrayBuffer()),
    scene,
    { pluginExtension: '.glb', rootUrl: new URL('.', url).href },
  );
}
