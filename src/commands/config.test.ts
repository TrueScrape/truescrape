import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig, writeConfig } from '../config.js';
import type { ContextOverrides } from '../context.js';
import { type Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { CONFIG_KEYS, mask, register } from './config.js';

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

function exitOverrideAll(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) exitOverrideAll(sub);
}

const noFetch = (async () => {
  throw new Error('config commands must not touch the network');
}) as unknown as typeof fetch;

async function cli(argv: string[], overrides: ContextOverrides): Promise<Streams & { out: string[]; err: string[] }> {
  const streams = capture();
  const program = buildProgram([(p) => register(p, { fetchImpl: noFetch, isTTY: false, streams, ...overrides })]);
  exitOverrideAll(program);
  await program.parseAsync(['node', 'truescrape', ...argv]);
  return streams;
}

const tmpConfig = () => join(mkdtempSync(join(tmpdir(), 'ts-cfg-cmd-')), 'config.json');
const parse = (streams: { out: string[] }) => JSON.parse(streams.out.join('')) as unknown;

afterEach(() => {
  process.exitCode = undefined;
});

describe('config set and get', () => {
  it('stores the key but only ever prints back that it is set', async () => {
    const configFile = tmpConfig();

    const set = await cli(['config', 'set', 'apiKey', 'secret-key-123'], { env: {}, configFile });
    expect(readConfig(configFile)).toEqual({ apiKey: 'secret-key-123' });
    expect(parse(set)).toEqual({ apiKey: '(set)', configFile });

    const get = await cli(['config', 'get', 'apiKey'], { env: {}, configFile });
    expect(get.out.join('')).toBe('"(set)"\n');
    expect(set.out.join('') + set.err.join('') + get.out.join('') + get.err.join('')).not.toContain('secret-key-123');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports an unset key as such', async () => {
    const get = await cli(['config', 'get', 'apiKey'], { env: {}, configFile: tmpConfig() });
    expect(get.out.join('')).toBe('"(not set)"\n');
  });

  it('sets the base URL without disturbing the key, and prints it back in the clear', async () => {
    const configFile = tmpConfig();
    writeConfig(configFile, { apiKey: 'k' });

    const set = await cli(['config', 'set', 'baseUrl', 'https://example.test/'], { env: {}, configFile });
    expect(readConfig(configFile)).toEqual({ apiKey: 'k', baseUrl: 'https://example.test/' });
    expect(parse(set)).toEqual({ baseUrl: 'https://example.test/', configFile });

    const get = await cli(['config', 'get', 'baseUrl'], { env: {}, configFile });
    expect(get.out.join('')).toBe('"https://example.test/"\n');

    const empty = await cli(['config', 'get', 'baseUrl'], { env: {}, configFile: tmpConfig() });
    expect(empty.out.join('')).toBe('null\n');
  });

  it('refuses a base URL that is not http or https', async () => {
    const configFile = tmpConfig();
    const streams = await cli(['config', 'set', 'baseUrl', 'api.example.test'], { env: {}, configFile });
    expect(process.exitCode).toBe(2);
    expect(readConfig(configFile)).toEqual({});
    expect(streams.out).toEqual([]);
  });

  it('warns when an environment variable will shadow what was just stored', async () => {
    const streams = await cli(['config', 'set', 'apiKey', 'k'], { env: { TRUESCRAPE_API_KEY: 'other' }, configFile: tmpConfig() });
    expect(streams.err.join('')).toContain('TRUESCRAPE_API_KEY');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('config list', () => {
  it('masks the key and shows the file', async () => {
    const configFile = tmpConfig();
    writeConfig(configFile, { apiKey: 'secret-key-123', baseUrl: 'https://stored' });
    const full = await cli(['config', 'list'], { env: {}, configFile });
    expect(parse(full)).toEqual({ apiKey: '(set)', baseUrl: 'https://stored', configFile });
    expect(full.out.join('')).not.toContain('secret-key-123');

    const empty = tmpConfig();
    const none = await cli(['config', 'list'], { env: {}, configFile: empty });
    expect(parse(none)).toEqual({ apiKey: '(not set)', baseUrl: null, configFile: empty });
  });
});

describe('unknown keys', () => {
  it('exit 2 and name the keys that exist', async () => {
    const configFile = tmpConfig();
    for (const argv of [['config', 'get', 'token'], ['config', 'set', 'token', 'x']]) {
      process.exitCode = undefined;
      const streams = await cli(argv, { env: {}, configFile });
      expect(process.exitCode).toBe(2);
      expect(streams.out).toEqual([]);
      const err = streams.err.join('');
      for (const key of CONFIG_KEYS) expect(err).toContain(key);
    }
    expect(readConfig(configFile)).toEqual({});
  });
});

describe('mask', () => {
  it('never returns the key itself', () => {
    expect(mask({ apiKey: 'secret-key-123', baseUrl: 'https://x' })).toEqual({ apiKey: '(set)', baseUrl: 'https://x' });
    expect(mask({})).toEqual({ apiKey: '(not set)', baseUrl: null });
  });
});
