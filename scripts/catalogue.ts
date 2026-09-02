/**
 * Regenerates src/catalogue.json from the live OpenAPI document and rewrites
 * the generated blocks in README.md and the skill.
 *
 * The snapshot is rewritten only when the endpoints actually changed, so a
 * no-op run leaves the tree clean and CI's currency check stays meaningful.
 *
 * Usage: pnpm catalogue            (TRUESCRAPE_BASE_URL overrides the API)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCatalogue, type Catalogue, type OpenApiDoc } from '../src/catalogue-build.js';

export const DEFAULT_BASE_URL = 'https://api.truescrape.com';
const START = '<!-- catalogue:start -->';
const END = '<!-- catalogue:end -->';

export function replaceBlock(text: string, body: string): string {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < 0 || end < start) throw new Error(`Markers ${START} … ${END} not found`);
  return `${text.slice(0, start + START.length)}\n${body.trim()}\n${text.slice(end)}`;
}

function counts(catalogue: Catalogue): { endpoints: number; platforms: number } {
  return { endpoints: catalogue.endpoints.length, platforms: new Set(catalogue.endpoints.map((e) => e.platform)).size };
}

/** README: the headline numbers and the platform list, nothing an agent needs to parse. */
export function renderReadmeBlock(catalogue: Catalogue): string {
  const { endpoints, platforms } = counts(catalogue);
  const byPlatform = new Map<string, number>();
  for (const e of catalogue.endpoints) byPlatform.set(e.platform, (byPlatform.get(e.platform) ?? 0) + 1);
  const list = [...byPlatform.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} (${n})`)
    .join(' · ');
  return [
    `**${endpoints} endpoints across ${platforms} platforms**, generated from the live API on ${catalogue.generatedAt.slice(0, 10)}.`,
    '',
    list,
  ].join('\n');
}

/** Skill: every endpoint with its cost, grouped by platform, so an agent can pick one without another round trip. */
export function renderSkillBlock(catalogue: Catalogue): string {
  const { endpoints, platforms } = counts(catalogue);
  const lines = [`${endpoints} endpoints across ${platforms} platforms, generated from the live API on ${catalogue.generatedAt.slice(0, 10)}.`, ''];
  const groups = new Map<string, Catalogue['endpoints']>();
  for (const e of catalogue.endpoints) groups.set(e.platform, [...(groups.get(e.platform) ?? []), e]);
  for (const [platform, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${platform} (${list.length})`, '', '| Endpoint | CLI | Credits | What it returns |', '|---|---|---|---|');
    for (const e of list) {
      const required = e.params.filter((p) => p.required).map((p) => `--${p.flag}`).join(' ');
      const flag = e.experimental ? ' (experimental)' : '';
      lines.push(`| \`GET ${e.path}\` | \`truescrape ${e.platform} ${e.action}${required ? ' ' + required : ''}\` | ${e.credits} | ${e.summary}${flag} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function sameEndpoints(a: Catalogue | null, b: Catalogue): boolean {
  return a !== null && JSON.stringify(a.endpoints) === JSON.stringify(b.endpoints);
}

export async function main(root = process.cwd()): Promise<void> {
  const baseUrl = (process.env.TRUESCRAPE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/openapi.json`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  const spec = (await response.json()) as OpenApiDoc;

  const snapshotPath = resolve(root, 'src/catalogue.json');
  const existing = existsSync(snapshotPath) ? (JSON.parse(readFileSync(snapshotPath, 'utf8')) as Catalogue) : null;
  const fresh = buildCatalogue(spec, url, new Date());
  const catalogue = sameEndpoints(existing, fresh) ? (existing as Catalogue) : fresh;

  if (catalogue !== existing) {
    writeFileSync(snapshotPath, `${JSON.stringify(catalogue, null, 2)}\n`);
    console.error(`catalogue: ${catalogue.endpoints.length} endpoints written to src/catalogue.json`);
  } else {
    console.error(`catalogue: unchanged (${catalogue.endpoints.length} endpoints)`);
  }

  for (const [file, render] of [
    ['README.md', renderReadmeBlock],
    ['skills/truescrape/SKILL.md', renderSkillBlock],
  ] as const) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    const after = replaceBlock(before, render(catalogue));
    if (after !== before) {
      writeFileSync(path, after);
      console.error(`catalogue: updated ${file}`);
    }
  }
}

if (process.argv[1] && /catalogue\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
