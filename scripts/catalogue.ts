/**
 * Keeps the endpoint catalogue and everything generated from it current.
 *
 *   pnpm catalogue          fetch the live API: refresh test/fixtures/openapi.json,
 *                           src/catalogue.json and the generated blocks in README.md
 *                           and the skill; also verify .mcp.json against discovery.
 *   pnpm catalogue --check  no network: rebuild from the committed fixture and fail
 *                           if the snapshot or a generated block is stale. CI runs this.
 *
 * The snapshot keeps its `generatedAt` while the endpoints are unchanged, so a
 * no-op run leaves the tree clean and the daily drift job only opens a pull
 * request when something really moved.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCatalogue, type Catalogue, type OpenApiDoc } from '../src/catalogue-build.js';

export const DEFAULT_BASE_URL = 'https://api.truescrape.com';
const START = '<!-- catalogue:start -->';
const END = '<!-- catalogue:end -->';

export const FIXTURE = 'test/fixtures/openapi.json';
export const SNAPSHOT = 'src/catalogue.json';
export const BLOCKS: readonly [file: string, render: (c: Catalogue) => string][] = [
  ['README.md', renderReadmeBlock],
  ['skills/truescrape/SKILL.md', renderSkillBlock],
];

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

function readSnapshot(root: string): Catalogue | null {
  const path = resolve(root, SNAPSHOT);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Catalogue) : null;
}

/** The catalogue the committed fixture produces, keeping the snapshot's timestamp when nothing moved. */
export function catalogueFromFixture(root: string, source = 'fixture', now = new Date()): Catalogue {
  const spec = JSON.parse(readFileSync(resolve(root, FIXTURE), 'utf8')) as OpenApiDoc;
  const existing = readSnapshot(root);
  const fresh = buildCatalogue(spec, existing?.source ?? source, now);
  return sameEndpoints(existing, fresh) ? (existing as Catalogue) : fresh;
}

/** Problems that would make CI fail: a stale snapshot or a stale generated block. Never touches the network. */
export function check(root: string): string[] {
  const problems: string[] = [];
  if (!existsSync(resolve(root, FIXTURE))) return [`${FIXTURE} is missing; run pnpm catalogue`];
  const catalogue = catalogueFromFixture(root);
  const existing = readSnapshot(root);
  if (!existing || !sameEndpoints(existing, catalogue)) problems.push(`${SNAPSHOT} is stale; run pnpm catalogue`);

  for (const [file, render] of BLOCKS) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (replaceBlock(text, render(catalogue)) !== text) problems.push(`${file} generated block is stale; run pnpm catalogue`);
  }
  return problems;
}

interface Discovery {
  endpoint: string;
  authentication: { in: string; name: string };
}

/** The plugin's .mcp.json cannot do discovery, so the daily job checks it against discovery instead. */
export function verifyMcpJson(text: string, discovery: Discovery, baseUrl: string): string | null {
  const parsed = JSON.parse(text) as { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> };
  const entry = parsed.mcpServers?.truescrape;
  if (!entry) return '.mcp.json has no mcpServers.truescrape entry';

  let expectedUrl: string;
  try {
    expectedUrl = `${baseUrl.replace(/\/$/, '')}${new URL(discovery.endpoint).pathname}`;
  } catch {
    expectedUrl = discovery.endpoint;
  }
  if (entry.url !== expectedUrl) return `.mcp.json url is ${entry.url}; discovery says ${expectedUrl}`;

  const headers = Object.keys(entry.headers ?? {}).map((h) => h.toLowerCase());
  if (!headers.includes(discovery.authentication.name.toLowerCase())) {
    return `.mcp.json sends ${headers.join(', ') || 'no headers'}; discovery wants ${discovery.authentication.name}`;
  }
  return null;
}

async function fetchJson<T>(url: string): Promise<{ text: string; json: T }> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  const text = await response.text();
  return { text, json: JSON.parse(text) as T };
}

/** Fetch mode: refresh the fixture from the live API, then regenerate everything from it. */
export async function refresh(root: string): Promise<void> {
  const baseUrl = (process.env.TRUESCRAPE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const specUrl = `${baseUrl}/openapi.json`;
  const { text } = await fetchJson<OpenApiDoc>(specUrl);

  const fixturePath = resolve(root, FIXTURE);
  const pretty = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  if (!existsSync(fixturePath) || readFileSync(fixturePath, 'utf8') !== pretty) {
    writeFileSync(fixturePath, pretty);
    console.error(`catalogue: ${FIXTURE} refreshed from ${specUrl}`);
  }

  const mcpPath = resolve(root, '.mcp.json');
  if (existsSync(mcpPath)) {
    const { json: discovery } = await fetchJson<Discovery>(`${baseUrl}/.well-known/mcp`);
    const problem = verifyMcpJson(readFileSync(mcpPath, 'utf8'), discovery, baseUrl);
    if (problem) throw new Error(problem);
  }

  const existing = readSnapshot(root);
  const catalogue = catalogueFromFixture(root, specUrl);
  if (catalogue !== existing) {
    writeFileSync(resolve(root, SNAPSHOT), `${JSON.stringify(catalogue, null, 2)}\n`);
    console.error(`catalogue: ${catalogue.endpoints.length} endpoints written to ${SNAPSHOT}`);
  } else {
    console.error(`catalogue: unchanged (${catalogue.endpoints.length} endpoints)`);
  }

  for (const [file, render] of BLOCKS) {
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

export async function main(argv = process.argv.slice(2), root = process.cwd()): Promise<number> {
  if (argv.includes('--check')) {
    const problems = check(root);
    for (const p of problems) console.error(`catalogue: ${p}`);
    if (!problems.length) console.error('catalogue: snapshot and generated blocks are current.');
    return problems.length ? 1 : 0;
  }
  await refresh(root);
  return 0;
}

if (process.argv[1] && /catalogue\.(ts|js)$/.test(process.argv[1])) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
