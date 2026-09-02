import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundledCatalogue } from '../src/catalogue.js';
import { buildProgram } from '../src/program.js';

const skill = readFileSync(new URL('../skills/truescrape/SKILL.md', import.meta.url), 'utf8');
const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** Routes that are real but are not scraper endpoints, so they never appear in the catalogue. */
const HTTP_ONLY = [
  '/v1/jobs',
  '/v1/jobs/batch',
  '/v1/jobs/{jobId}',
  '/v1/subscriptions',
  '/v1/account/credit-balance',
  '/v1/account/usage-forecast',
  '/v1/account/most-used-routes',
];

function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  expect(match, 'frontmatter block').toBeTruthy();
  const out: Record<string, string> = {};
  let key = '';
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1] ?? '';
      out[key] = kv[2] ?? '';
    } else if (key) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

const pathsIn = (text: string): string[] => [...new Set([...text.matchAll(/\/v1\/[a-z0-9\-{}/]+/gi)].map((m) => m[0].replace(/[.,)`]+$/, '')))];

describe('the skill stays true to the API', () => {
  const catalogue = bundledCatalogue();
  const known = new Set([...catalogue.endpoints.map((e) => e.path), ...HTTP_ONLY]);

  it('has the frontmatter the installers require', () => {
    const fm = frontmatter(skill);
    expect(fm.name).toBe('truescrape');
    expect(fm.description?.length ?? 0).toBeGreaterThan(40);
    expect(fm.description?.length ?? 0).toBeLessThan(1024);
    expect(fm.description).toMatch(/^>?-?\s*Use when/i);
  });

  it('names only paths that exist, in prose and in the generated block', () => {
    // A trailing slash is a family reference ("the /v1/google/ad-library/ endpoints"); it is fine if any real path lives under it.
    const exists = (p: string) => known.has(p) || (p.endsWith('/') && [...known].some((k) => k.startsWith(p)));
    const unknown = pathsIn(skill).filter((p) => !exists(p));
    expect(unknown).toEqual([]);
  });

  it('carries the generated catalogue block, populated', () => {
    const block = /<!-- catalogue:start -->([\s\S]*?)<!-- catalogue:end -->/.exec(skill)?.[1] ?? '';
    expect(block.length).toBeGreaterThan(1000);
    for (const e of catalogue.endpoints) expect(block, e.path).toContain(`\`GET ${e.path}\``);
  });

  it('mentions only the two public environment variables', () => {
    for (const text of [skill, agents, readme]) {
      const names = new Set([...text.matchAll(/TRUESCRAPE_[A-Z_]+/g)].map((m) => m[0]));
      expect([...names].sort()).toEqual([...names].filter((n) => n === 'TRUESCRAPE_API_KEY' || n === 'TRUESCRAPE_BASE_URL').sort());
    }
  });
});

describe('AGENTS.md and README name commands that exist', () => {
  it('every `truescrape <command>` they mention is registered', () => {
    const program = buildProgram();
    const registered = new Set(program.commands.map((c) => c.name()));
    const platforms = new Set(bundledCatalogue().endpoints.map((e) => e.platform));
    // Same line only: "truescrape" at the end of a sentence followed by a new paragraph is not a command.
    const mentioned = new Set([...`${agents}\n${readme}`.matchAll(/(?:^|[`\s])truescrape[ \t]+([a-z][a-z0-9-]*)(?=[\s`.,)]|$)/gm)].map((m) => m[1] ?? ''));
    const missing = [...mentioned].filter((n) => !registered.has(n) && !platforms.has(n));
    expect(missing).toEqual([]);
  });
});
