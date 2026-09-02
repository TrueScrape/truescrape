import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bundledCatalogue, findEndpoint, platformsOf, readCachedCatalogue, resolveEndpoint } from './catalogue.js';

const fixture = readFileSync(new URL('../test/fixtures/openapi.json', import.meta.url), 'utf8');

function fakeFetch(body: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

describe('bundled catalogue', () => {
  it('is populated and indexable by platform and action', () => {
    const catalogue = bundledCatalogue();
    expect(catalogue.endpoints.length).toBeGreaterThan(0);
    expect(findEndpoint(catalogue, 'youtube', 'channel')).toBeDefined();
    expect(platformsOf(catalogue).find((p) => p.name === 'youtube')?.count).toBeGreaterThan(0);
  });
});

describe('resolveEndpoint', () => {
  it('answers from the bundle without touching the network', async () => {
    const fetchImpl = fakeFetch('{}', 500);
    const dir = mkdtempSync(join(tmpdir(), 'ts-cat-'));
    const found = await resolveEndpoint('youtube', 'channel', { baseUrl: 'https://x', cachePath: join(dir, 'c.json'), fetchImpl });
    expect(found?.path).toBe('/v1/youtube/channel');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes exactly once for an unknown action, then serves the cache', async () => {
    // A spec with one endpoint the bundle does not know.
    const spec = JSON.parse(fixture) as { paths: Record<string, unknown> };
    spec.paths['/v1/youtube/brand-new'] = {
      get: { operationId: 'youtube_brandNew', summary: 'New', tags: ['youtube'], 'x-credit-cost': 1, parameters: [] },
    };
    const fetchImpl = fakeFetch(JSON.stringify(spec));
    const dir = mkdtempSync(join(tmpdir(), 'ts-cat-'));
    const options = { baseUrl: 'https://x', cachePath: join(dir, 'c.json'), fetchImpl };

    const first = await resolveEndpoint('youtube', 'brand-new', options);
    expect(first?.name).toBe('youtube.brandNew');
    const second = await resolveEndpoint('youtube', 'brand-new', options);
    expect(second?.name).toBe('youtube.brandNew');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores a cache older than its max age', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-cat-'));
    const path = join(dir, 'c.json');
    writeFileSync(path, JSON.stringify({ generatedAt: '', source: '', endpoints: [] }));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(path, old, old);
    expect(readCachedCatalogue(path)).toBeNull();
    expect(readCachedCatalogue(path, 7 * 24 * 60 * 60 * 1000)).not.toBeNull();
  });

  it('surfaces a failed refresh as an error naming the URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-cat-'));
    await expect(
      resolveEndpoint('nope', 'nothing', { baseUrl: 'https://x/', cachePath: join(dir, 'c.json'), fetchImpl: fakeFetch('', 503) }),
    ).rejects.toThrow('https://x/openapi.json: HTTP 503');
  });
});
