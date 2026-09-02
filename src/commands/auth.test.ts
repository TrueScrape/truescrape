import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig, writeConfig } from '../config.js';
import { type Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { readStdinLine, register, type AuthOverrides } from './auth.js';

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

const ok = (creditBalance: number) => json({ success: true, data: { creditBalance, creditsSpentToday: 0 } });
const rejected = () => json({ success: false, error: { code: 'invalid_api_key', message: 'Unrecognised key.' } }, 401);

function exitOverrideAll(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) exitOverrideAll(sub);
}

async function cli(argv: string[], overrides: AuthOverrides): Promise<void> {
  const program = buildProgram([(p) => register(p, overrides)]);
  exitOverrideAll(program);
  await program.parseAsync(['node', 'truescrape', ...argv]);
}

const tmpConfig = () => join(mkdtempSync(join(tmpdir(), 'ts-auth-')), 'config.json');
const sentKey = (call: Call | undefined) => (call?.init.headers as Record<string, string> | undefined)?.['x-api-key'];
const parse = (streams: { out: string[] }) => JSON.parse(streams.out.join('')) as Record<string, unknown>;

afterEach(() => {
  process.exitCode = undefined;
});

describe('auth login', () => {
  it('validates the flag key against the API and stores it only after a 200', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    let existedDuringCheck: boolean | undefined;
    const { fetchImpl, calls } = stub(() => {
      existedDuringCheck = existsSync(configFile);
      return ok(42);
    });

    await cli(['auth', 'login', '--api-key', 'k_live'], { env: {}, configFile, streams, fetchImpl, isTTY: false });

    expect(calls[0]?.url).toBe('https://api.truescrape.com/v1/account/credit-balance');
    expect(sentKey(calls[0])).toBe('k_live');
    expect(existedDuringCheck).toBe(false);
    expect(readConfig(configFile)).toEqual({ apiKey: 'k_live' });
    expect(parse(streams)).toEqual({ saved: configFile, creditBalance: 42 });
    expect(streams.err.join('')).toContain(`Saved to ${configFile}. Balance: 42 credits.`);
    expect(process.exitCode).toBeUndefined();
  });

  it('stores nothing on a 401 and exits 1 with the API code, never a credits code', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    const { fetchImpl } = stub(rejected);

    await cli(['auth', 'login', '--api-key', 'k_bad'], { env: {}, configFile, streams, fetchImpl, isTTY: false });

    expect(existsSync(configFile)).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(streams.out).toEqual([]);
    const err = streams.err.join('');
    expect(err).toContain('invalid_api_key');
    expect(err).not.toMatch(/credit/i);
    expect(err).not.toContain('k_bad');
  });

  it('reads one trimmed line from stdin when stdout is not a terminal', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    const { fetchImpl, calls } = stub(() => ok(1));
    const prompt = vi.fn();

    await cli(['auth', 'login'], { env: {}, configFile, streams, fetchImpl, isTTY: false, readLine: async () => '  k_piped  ', prompt });

    expect(prompt).not.toHaveBeenCalled();
    expect(sentKey(calls[0])).toBe('k_piped');
    expect(readConfig(configFile)).toEqual({ apiKey: 'k_piped' });
  });

  it('prompts when stdout is a terminal, and a cancelled prompt is a usage error', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    const { fetchImpl, calls } = stub(() => ok(1));
    const readLine = vi.fn();

    await cli(['auth', 'login'], { env: {}, configFile, streams, fetchImpl, isTTY: true, prompt: async () => 'k_typed', readLine });
    expect(readLine).not.toHaveBeenCalled();
    expect(sentKey(calls[0])).toBe('k_typed');
    expect(readConfig(configFile)).toEqual({ apiKey: 'k_typed' });

    const cancelled = tmpConfig();
    const quiet = capture();
    await cli(['auth', 'login'], { env: {}, configFile: cancelled, streams: quiet, fetchImpl, isTTY: true, prompt: async () => null });
    expect(process.exitCode).toBe(2);
    expect(quiet.err.join('')).toContain('Cancelled');
    expect(existsSync(cancelled)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('rejects an empty key before touching the network', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    const { fetchImpl, calls } = stub(() => ok(1));

    await cli(['auth', 'login'], { env: {}, configFile, streams, fetchImpl, isTTY: false, readLine: async () => '\n' });

    expect(process.exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(existsSync(configFile)).toBe(false);
  });

  it('preserves a stored base URL and validates against it', async () => {
    const configFile = tmpConfig();
    writeConfig(configFile, { baseUrl: 'https://stored' });
    const streams = capture();
    const { fetchImpl, calls } = stub(() => ok(3));

    await cli(['auth', 'login', '--api-key', 'k_new'], { env: {}, configFile, streams, fetchImpl, isTTY: false });

    expect(calls[0]?.url).toBe('https://stored/v1/account/credit-balance');
    expect(readConfig(configFile)).toEqual({ baseUrl: 'https://stored', apiKey: 'k_new' });
  });
});

describe('readStdinLine', () => {
  it('returns the first line, trimmed, and ignores the rest of the pipe', async () => {
    expect(await readStdinLine(Readable.from(['  k_first \nk_second\n']))).toBe('k_first');
    expect(await readStdinLine(Readable.from(['k_only']))).toBe('k_only');
    expect(await readStdinLine(Readable.from([]))).toBe('');
  });
});

describe('auth status', () => {
  it('reports where the key and base URL came from, plus the balance, without ever printing the key', async () => {
    const configFile = tmpConfig();
    writeConfig(configFile, { apiKey: 'secret-key-123', baseUrl: 'https://stored' });
    const streams = capture();
    const { fetchImpl, calls } = stub(() => ok(7));

    await cli(['auth', 'status'], { env: {}, configFile, streams, fetchImpl, isTTY: false });

    expect(sentKey(calls[0])).toBe('secret-key-123');
    expect(parse(streams)).toEqual({
      keySource: 'config',
      configFile,
      baseUrl: 'https://stored',
      baseUrlSource: 'config',
      balance: { creditBalance: 7, creditsSpentToday: 0 },
    });
    expect(streams.out.join('') + streams.err.join('')).not.toContain('secret-key-123');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a rejected key as data and still exits 0', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    const { fetchImpl } = stub(rejected);

    await cli(['auth', 'status'], { env: { TRUESCRAPE_API_KEY: 'secret-env-key' }, configFile, streams, fetchImpl, isTTY: false });

    expect(parse(streams)).toMatchObject({ keySource: 'env', balance: null, keyRejected: 'invalid_api_key' });
    expect(streams.out.join('') + streams.err.join('')).not.toContain('secret-env-key');
    expect(process.exitCode).toBeUndefined();
  });

  it('skips the network when there is no key', async () => {
    const configFile = tmpConfig();
    const streams = capture();
    const { fetchImpl, calls } = stub(() => ok(0));

    await cli(['auth', 'status'], { env: {}, configFile, streams, fetchImpl, isTTY: false });

    expect(calls).toEqual([]);
    expect(parse(streams)).toMatchObject({ keySource: 'none', balance: null, baseUrlSource: 'default' });
    expect(parse(streams)).not.toHaveProperty('keyRejected');
  });
});

describe('auth logout', () => {
  it('removes only the key and says whether there was one', async () => {
    const configFile = tmpConfig();
    writeConfig(configFile, { apiKey: 'k', baseUrl: 'https://stored' });
    const streams = capture();
    const { fetchImpl, calls } = stub(() => ok(0));

    await cli(['auth', 'logout'], { env: {}, configFile, streams, fetchImpl, isTTY: false });
    expect(readConfig(configFile)).toEqual({ baseUrl: 'https://stored' });
    expect(parse(streams)).toEqual({ removed: true, configFile });

    const again = capture();
    await cli(['auth', 'logout'], { env: {}, configFile, streams: again, fetchImpl, isTTY: false });
    expect(readConfig(configFile)).toEqual({ baseUrl: 'https://stored' });
    expect(parse(again)).toEqual({ removed: false, configFile });
    expect(calls).toEqual([]);
  });
});
