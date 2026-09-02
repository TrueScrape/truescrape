import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../config.js';
import type { ContextOverrides } from '../context.js';
import { type Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { register } from './balance.js';

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

type Call = { url: string; init: RequestInit };

function stub(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function exitOverrideAll(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) exitOverrideAll(sub);
}

async function cli(argv: string[], overrides: ContextOverrides): Promise<void> {
  const program = buildProgram([(p) => register(p, overrides)]);
  exitOverrideAll(program);
  await program.parseAsync(['node', 'truescrape', ...argv]);
}

const tmpConfig = () => join(mkdtempSync(join(tmpdir(), 'ts-bal-')), 'config.json');

afterEach(() => {
  process.exitCode = undefined;
});

describe('balance', () => {
  it('prints the balance data on stdout and the billing line on stderr', async () => {
    const configFile = tmpConfig();
    writeConfig(configFile, { apiKey: 'k' });
    const streams = capture();
    const { fetchImpl, calls } = stub(() => json({ success: true, data: { creditBalance: 12, creditsSpentToday: 3 } }));

    await cli(['balance'], { env: {}, configFile, streams, fetchImpl, isTTY: false });

    expect(calls[0]?.url).toBe('https://api.truescrape.com/v1/account/credit-balance');
    expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(streams.out.join('')).toBe('{"creditBalance":12,"creditsSpentToday":3}\n');
    expect(streams.err.join('')).toMatch(/0 credits/);
    expect(process.exitCode).toBeUndefined();
  });

  it('is silent on stderr under --quiet', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    const { fetchImpl } = stub(() => json({ success: true, data: { creditBalance: 1 } }));

    await cli(['balance', '--quiet'], { env: { TRUESCRAPE_API_KEY: 'k' }, configFile, streams, fetchImpl, isTTY: false });

    expect(streams.out.join('')).toBe('{"creditBalance":1}\n');
    expect(streams.err).toEqual([]);
  });

  it('is a usage error with no key, before any request', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    const { fetchImpl, calls } = stub(() => json({ success: true, data: {} }));

    await cli(['balance'], { env: {}, configFile, streams, fetchImpl, isTTY: false });

    expect(process.exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(streams.out).toEqual([]);
    expect(streams.err.join('')).toContain('auth login');
  });

  it('passes an API error through with exit 1', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    const { fetchImpl } = stub(() => json({ success: false, error: { code: 'invalid_api_key', message: 'Unrecognised key.' } }, 401));

    await cli(['balance'], { env: { TRUESCRAPE_API_KEY: 'k' }, configFile, streams, fetchImpl, isTTY: false });

    expect(process.exitCode).toBe(1);
    expect(streams.out).toEqual([]);
    expect(streams.err.join('')).toContain('invalid_api_key');
  });
});
