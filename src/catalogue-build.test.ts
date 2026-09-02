import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalogue, buildParam, cleanDescription, platformAndAction, type OpenApiDoc } from './catalogue-build.js';

const spec = JSON.parse(readFileSync(new URL('../test/fixtures/openapi.json', import.meta.url), 'utf8')) as OpenApiDoc;
const catalogue = buildCatalogue(spec, 'fixture', new Date('2026-09-03T00:00:00Z'));

const operationCount = Object.values(spec.paths).reduce((n, methods) => n + Object.keys(methods).length, 0);

describe('catalogue from the OpenAPI fixture', () => {
  it('maps every operation to exactly one platform/action pair', () => {
    expect(catalogue.endpoints).toHaveLength(operationCount);
    const keys = catalogue.endpoints.map((e) => `${e.platform} ${e.action}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('derives actions for the paths with no action segment', () => {
    const byPath = new Map(catalogue.endpoints.map((e) => [e.path, e]));
    for (const path of ['/v1/komi', '/v1/linkbio', '/v1/linkme', '/v1/linktree', '/v1/pillar']) {
      const e = byPath.get(path);
      expect(e, path).toBeDefined();
      expect(e?.action).toBe('page');
      expect(e?.platform).toBe(path.slice('/v1/'.length));
    }
    const inference = byPath.get('/v1/detect-age-gender');
    expect(inference).toMatchObject({ platform: 'inference', action: 'age-gender', name: 'inference.ageGender' });
  });

  it('joins nested path segments and keeps hyphenated platforms', () => {
    const replies = catalogue.endpoints.find((e) => e.path === '/v1/reddit/post/comment/replies');
    expect(replies).toMatchObject({ platform: 'reddit', action: 'post-comment-replies' });
    expect(catalogue.endpoints.some((e) => e.platform === 'apple-music')).toBe(true);
  });

  it('uses the registry name from the operationId', () => {
    const videos = catalogue.endpoints.find((e) => e.path === '/v1/youtube/channel-videos');
    expect(videos?.name).toBe('youtube.channelVideos');
  });

  it('turns every query param into a flag with its type, enum, default and description', () => {
    const videos = catalogue.endpoints.find((e) => e.path === '/v1/youtube/channel-videos');
    const tab = videos?.params.find((p) => p.name === 'tab');
    expect(tab).toMatchObject({ flag: 'tab', type: 'string', required: false, default: 'videos' });
    expect(tab?.enum).toEqual(['videos', 'shorts', 'streams']);
    const handle = videos?.params.find((p) => p.name === 'handle');
    expect(handle).toMatchObject({ required: true, description: expect.stringContaining('Handle') });
    expect(videos?.params.find((p) => p.name === 'cache_max_age')?.flag).toBe('cache-max-age');
    expect(videos?.params.find((p) => p.name === 'include_raw')?.type).toBe('boolean');
  });

  it('reads a description from either the parameter or its schema', () => {
    expect(buildParam({ name: 'a', description: 'top' }).description).toBe('top');
    expect(buildParam({ name: 'a', schema: { type: 'string', description: 'nested' } }).description).toBe('nested');
    expect(buildParam({ name: 'a', description: 'top', schema: { description: 'nested' } }).description).toBe('top');
  });

  it('never carries the billing boilerplate in a description', () => {
    for (const e of catalogue.endpoints) {
      expect(e.description, e.path).not.toMatch(/\*\*Cost:\*\*|Cache hits cost 0|Failed and empty|\*\*Required:\*\*/);
    }
    expect(
      cleanDescription('Recent uploads.\n**Cost:** 1 credit per live request.\n**Cache hits cost 0 credits.**\nFailed and empty responses are never charged.'),
    ).toBe('Recent uploads.');
  });

  it('carries cost, flags and cross-field constraints', () => {
    const ad = catalogue.endpoints.find((e) => e.credits > 1);
    expect(ad).toBeDefined();
    const constrained = catalogue.endpoints.find((e) => e.constraints.length > 0);
    expect(constrained?.constraints[0]).toMatch(/\w/);
    expect(catalogue.endpoints.every((e) => typeof e.cacheable === 'boolean' && typeof e.batchable === 'boolean')).toBe(true);
  });

  it('refuses an operation with no tag rather than guessing', () => {
    expect(() => platformAndAction('/v1/x', { operationId: 'x_y' })).toThrow(/no tag/);
  });
});
