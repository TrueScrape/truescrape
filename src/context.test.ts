import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';
import { writeConfig } from './config.js';
import { NO_KEY_MESSAGE, createContext, requireKey, run } from './context.js';
import { UsageError, type Streams } from './output.js';
import { buildProgram } from './program.js';

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

/** A program with one probe subcommand that hands its Command back. */
function probe(argv: string[]): Promise<Command> {
  return new Promise((resolve) => {
    const program = buildProgram([
      (p) => {
        p.command('probe').action(function (this: Command) {
          resolve(this);
        });
      },
    ]);
    program.exitOverride();
    program.parse(['node', 'truescrape', ...argv]);
  });
}

const tmpConfig = () => join(mkdtempSync(join(tmpdir(), 'ts-ctx-')), 'config.json');

afterEach(() => {
  process.exitCode = undefined;
});

describe('createContext', () => {
  it('reads global flags placed before or after the subcommand', async () => {
    const before = createContext(await probe(['--format', 'csv', '--pretty', 'probe']), { env: {}, configFile: tmpConfig() });
    expect(before.output).toMatchObject({ format: 'csv', pretty: true });
    const after = createContext(await probe(['probe', '--quiet', '--envelope', '--output', 'x.json']), { env: {}, configFile: tmpConfig() });
    expect(after.output).toMatchObject({ quiet: true, envelope: true, output: 'x.json' });
  });

  it('resolves the key by precedence and builds a client on the resolved base URL', async () => {
    const configFile = tmpConfig();
    writeConfig(configFile, { apiKey: 'stored', baseUrl: 'https://stored' });
    const fromFile = createContext(await probe(['probe']), { env: {}, configFile });
    expect(fromFile.settings).toMatchObject({ apiKey: 'stored', keySource: 'config' });
    expect(fromFile.client.baseUrl).toBe('https://stored');

    const fromFlag = createContext(await probe(['probe', '--api-key', 'flag', '--base-url', 'https://flag/']), { env: { TRUESCRAPE_API_KEY: 'env' }, configFile });
    expect(fromFlag.settings).toMatchObject({ apiKey: 'flag', keySource: 'flag' });
    expect(fromFlag.client.baseUrl).toBe('https://flag');
  });

  it('turns colour off under --no-color and NO_COLOR', async () => {
    expect(createContext(await probe(['probe', '--no-color']), { env: {}, configFile: tmpConfig() }).output.color).toBe(false);
    expect(createContext(await probe(['probe']), { env: { NO_COLOR: '1' }, configFile: tmpConfig() }).output.color).toBe(false);
  });
});

describe('requireKey', () => {
  it('is a usage error naming the three ways to set a key', async () => {
    const ctx = createContext(await probe(['probe']), { env: {}, configFile: tmpConfig() });
    expect(() => requireKey(ctx)).toThrow(UsageError);
    expect(() => requireKey(ctx)).toThrow(NO_KEY_MESSAGE);
    expect(NO_KEY_MESSAGE).toMatch(/auth login/);
    expect(NO_KEY_MESSAGE).toMatch(/TRUESCRAPE_API_KEY/);
    expect(NO_KEY_MESSAGE).toMatch(/--api-key/);
  });
});

describe('run', () => {
  it('returns 0 and leaves the exit code alone on success', async () => {
    const streams = capture();
    const code = await run(await probe(['probe']), async () => {}, { env: {}, configFile: tmpConfig(), streams });
    expect(code).toBe(0);
    expect(process.exitCode).toBeUndefined();
  });

  it('reports an API error on stderr with exit 1, a usage error with exit 2', async () => {
    const streams = capture();
    const cmd = await probe(['probe']);
    expect(await run(cmd, async () => { throw new ApiError('invalid_api_key', 401, 'bad'); }, { env: {}, configFile: tmpConfig(), streams })).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(await run(cmd, async () => { throw new UsageError('missing --handle'); }, { env: {}, configFile: tmpConfig(), streams })).toBe(2);
    expect(streams.out).toEqual([]);
    expect(streams.err.length).toBe(2);
  });

  it('never lets an error escape the action', async () => {
    const streams = capture();
    const spy = vi.fn(async () => { throw new Error('boom'); });
    await expect(run(await probe(['probe']), spy, { env: {}, configFile: tmpConfig(), streams })).resolves.toBe(1);
  });
});
