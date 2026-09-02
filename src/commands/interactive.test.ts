import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledCatalogue, findEndpoint } from '../catalogue.js';
import type { Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { commandLine, register, type Prompter } from './interactive.js';

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

/** Answers are consumed in order; a missing answer counts as a cancel. */
function scripted(answers: (string | boolean | undefined)[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = () => answers.shift();
  return {
    asked,
    select: async <T extends string>(message: string) => (asked.push(message), next() as T | undefined),
    text: async (message) => (asked.push(message), next() as string | undefined),
    confirm: async (message) => (asked.push(message), next() as boolean | undefined),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const configFile = () => join(mkdtempSync(join(tmpdir(), 'ts-int-')), 'config.json');

async function runBare(prompter: Prompter | undefined, fetchImpl: typeof fetch, isTTY: boolean, streams = capture()) {
  const program = buildProgram([(p) => register(p, { env: { TRUESCRAPE_API_KEY: 'k' }, configFile: configFile(), streams, fetchImpl, isTTY, prompter })]);
  program.exitOverride();
  await program.parseAsync(['node', 'truescrape']);
  return streams;
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('bare truescrape', () => {
  it('prints help and exits 2 when stdout is not a terminal', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const streams = await runBare(undefined, fetchImpl, false);
    expect(process.exitCode).toBe(2);
    expect(streams.out).toEqual([]);
    expect(streams.err.join('')).toContain('Usage:');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('walks platform, endpoint and required params, then runs the call', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return json({ success: true, data: { items: [{ id: 1 }] }, meta: { creditsCharged: 1 } });
    }) as unknown as typeof fetch;

    const videos = findEndpoint(bundledCatalogue(), 'youtube', 'channel-videos');
    expect(videos).toBeDefined();
    const prompter = scripted(['youtube', 'channel-videos', '@mkbhd', false]);
    const streams = await runBare(prompter, fetchImpl, true);

    expect(process.exitCode).toBeUndefined();
    expect(calls[0]).toBe('https://api.truescrape.com/v1/youtube/channel-videos?handle=%40mkbhd');
    expect(streams.out).toEqual(['{"items":[{"id":1}]}\n']);
    expect(streams.err.join('')).toContain('truescrape youtube channel-videos --handle "@mkbhd"');
    expect(prompter.asked[0]).toBe('Platform');
    expect(prompter.asked[1]).toBe('Endpoint');
  });

  it('asks optional params on request and sends enums and booleans correctly', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (calls.push(String(url)), json({ success: true, data: [] }))) as unknown as typeof fetch;
    const videos = findEndpoint(bundledCatalogue(), 'youtube', 'channel-videos')!;
    const optional = videos.params.filter((p) => !p.required);
    // handle, then "yes" to optional, then one answer per optional param in catalogue order.
    const answers: (string | boolean | undefined)[] = ['youtube', 'channel-videos', '@x', true];
    for (const p of optional) answers.push(p.enum ? p.enum[1]! : p.type === 'boolean' ? true : p.name === 'cache_max_age' ? '7d' : '');
    await runBare(scripted(answers), fetchImpl, true);

    const url = new URL(calls[0]!);
    expect(url.searchParams.get('handle')).toBe('@x');
    expect(url.searchParams.get('tab')).toBe('shorts');
    expect(url.searchParams.get('cache_max_age')).toBe('7d');
    expect(url.searchParams.get('include_raw')).toBe('true');
  });

  it('treats a cancel as a usage error and makes no request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await runBare(scripted(['youtube', undefined]), fetchImpl, true);
    expect(process.exitCode).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses without a key before asking anything', async () => {
    const prompter = scripted(['youtube']);
    const streams = capture();
    const program = buildProgram([(p) => register(p, { env: {}, configFile: configFile(), streams, isTTY: true, prompter })]);
    program.exitOverride();
    await program.parseAsync(['node', 'truescrape']);
    expect(process.exitCode).toBe(2);
    expect(prompter.asked).toEqual([]);
  });
});

describe('commandLine', () => {
  it('renders the equivalent one-liner', () => {
    const videos = findEndpoint(bundledCatalogue(), 'youtube', 'channel-videos')!;
    expect(commandLine(videos, { handle: '@mkbhd', tab: 'shorts', include_raw: false })).toBe('truescrape youtube channel-videos --handle "@mkbhd" --tab "shorts" --no-include-raw');
  });
});
