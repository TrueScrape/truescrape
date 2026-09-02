/**
 * Live smoke test against the real API. Opt in with:
 *
 *   TRUESCRAPE_LIVE=1 TRUESCRAPE_API_KEY=... pnpm test
 *
 * Each check spends at most one credit and asserts only what a customer
 * would: the call succeeds, the shapes hold, and the bridge sees the same
 * tool count discovery advertises.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Client } from '../../src/client.js';
import { resolveSettings } from '../../src/config.js';
import type { Streams } from '../../src/output.js';
import { buildProgram } from '../../src/program.js';

const settings = resolveSettings();
const key = settings.apiKey;
const run = key ? describe : describe.skip;

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

run('live API', () => {
  it('balance returns a numeric creditBalance', async () => {
    const client = new Client({ baseUrl: settings.baseUrl, apiKey: key });
    const result = await client.get<{ creditBalance: number }>('/v1/account/credit-balance');
    expect(typeof result.data.creditBalance).toBe('number');
  });

  it('a scraper endpoint answers with the envelope and a billing line', async () => {
    const client = new Client({ baseUrl: settings.baseUrl, apiKey: key });
    const result = await client.get<Record<string, unknown>>('/v1/youtube/channel', { handle: '@mkbhd', cache_max_age: '7d' });
    expect(result.data).toBeTruthy();
    expect(result.meta?.creditsCharged).toBeGreaterThanOrEqual(0);
  });

  it('the stdio bridge sees the tool count discovery advertises', async () => {
    const client = new Client({ baseUrl: settings.baseUrl, apiKey: key });
    const discovery = (await (await client.raw('GET', '/.well-known/mcp')).json()) as { tools: number };

    const { runBridge } = await import('../../src/commands/mcp.js');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c.toString()));

    const streams = capture();
    const program = buildProgram([]);
    program.parse(['node', 'truescrape']);
    const { createContext } = await import('../../src/context.js');
    const ctx = createContext(program, { streams, isTTY: false });

    const done = runBridge(ctx, stdin, stdout);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    stdin.end();
    await done;

    const lines = chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: { tools?: unknown[] } });
    const list = lines.find((l) => l.id === 2);
    expect(list?.result?.tools?.length).toBe(discovery.tools);
  });
});
