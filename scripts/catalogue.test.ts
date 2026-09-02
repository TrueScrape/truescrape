import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCatalogue, type OpenApiDoc } from '../src/catalogue-build.js';
import { renderReadmeBlock, renderSkillBlock, replaceBlock } from './catalogue.js';

const spec = JSON.parse(readFileSync(new URL('../test/fixtures/openapi.json', import.meta.url), 'utf8')) as OpenApiDoc;
const catalogue = buildCatalogue(spec, 'fixture', new Date('2026-09-03T12:00:00Z'));

describe('generated blocks', () => {
  it('replaces only what sits between the markers', () => {
    const text = 'before\n<!-- catalogue:start -->\nold\n<!-- catalogue:end -->\nafter\n';
    expect(replaceBlock(text, 'new')).toBe('before\n<!-- catalogue:start -->\nnew\n<!-- catalogue:end -->\nafter\n');
  });

  it('refuses a file without markers rather than appending', () => {
    expect(() => replaceBlock('no markers here', 'x')).toThrow(/Markers/);
  });

  it('puts the live counts and the date in the README block', () => {
    const block = renderReadmeBlock(catalogue);
    const platforms = new Set(catalogue.endpoints.map((e) => e.platform)).size;
    expect(block).toContain(`**${catalogue.endpoints.length} endpoints across ${platforms} platforms**`);
    expect(block).toContain('2026-09-03');
    expect(block).toMatch(/youtube \(\d+\)/);
  });

  it('lists every endpoint path and CLI command in the skill block', () => {
    const block = renderSkillBlock(catalogue);
    for (const e of catalogue.endpoints) {
      expect(block).toContain(`\`GET ${e.path}\``);
      expect(block).toContain(`truescrape ${e.platform} ${e.action}`);
    }
    expect(block).toContain('### youtube (');
    expect(block).toContain('(experimental)');
  });
});
