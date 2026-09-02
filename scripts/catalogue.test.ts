import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalogue, type OpenApiDoc } from '../src/catalogue-build.js';
import { check, renderReadmeBlock, renderSkillBlock, replaceBlock, verifyMcpJson } from './catalogue.js';

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

  it('check passes a consistent tree offline and names what is stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-check-'));
    mkdirSync(join(root, 'test/fixtures'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'skills/truescrape'), { recursive: true });
    writeFileSync(join(root, 'test/fixtures/openapi.json'), JSON.stringify(spec));
    writeFileSync(join(root, 'src/catalogue.json'), JSON.stringify(catalogue));
    const empty = '<!-- catalogue:start -->\n<!-- catalogue:end -->\n';
    writeFileSync(join(root, 'README.md'), `# x\n${replaceBlock(empty, renderReadmeBlock(catalogue))}`);
    writeFileSync(join(root, 'skills/truescrape/SKILL.md'), replaceBlock(empty, renderSkillBlock(catalogue)));
    expect(check(root)).toEqual([]);

    writeFileSync(join(root, 'README.md'), '# x\n<!-- catalogue:start -->\nold\n<!-- catalogue:end -->\n');
    expect(check(root)).toEqual(['README.md generated block is stale; run pnpm catalogue']);

    const fewer = { ...catalogue, endpoints: catalogue.endpoints.slice(1) };
    writeFileSync(join(root, 'src/catalogue.json'), JSON.stringify(fewer));
    expect(check(root)[0]).toBe('src/catalogue.json is stale; run pnpm catalogue');
  });

  it('verifies .mcp.json against discovery, rehosted onto the base URL', () => {
    const discovery = { endpoint: 'http://localhost:3000/mcp', authentication: { in: 'header', name: 'x-api-key' } };
    const good = JSON.stringify({ mcpServers: { truescrape: { url: 'https://api.example/mcp', headers: { 'x-api-key': '${TRUESCRAPE_API_KEY}' } } } });
    expect(verifyMcpJson(good, discovery, 'https://api.example')).toBeNull();
    const wrongUrl = good.replace('https://api.example/mcp', 'https://api.example/v2/mcp');
    expect(verifyMcpJson(wrongUrl, discovery, 'https://api.example')).toMatch(/discovery says https:\/\/api.example\/mcp/);
    const wrongHeader = good.replace('x-api-key', 'authorization');
    expect(verifyMcpJson(wrongHeader, discovery, 'https://api.example')).toMatch(/wants x-api-key/);
    expect(verifyMcpJson('{}', discovery, 'https://api.example')).toMatch(/no mcpServers.truescrape/);
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
