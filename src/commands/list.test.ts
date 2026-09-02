import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledCatalogue, endpointsFor, platformsOf } from '../catalogue.js';
import type { Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { register } from './list.js';

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

async function exec(argv: string[], isTTY = false) {
  const streams = capture();
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const configFile = join(mkdtempSync(join(tmpdir(), 'ts-list-')), 'config.json');
  const program = buildProgram([(p) => register(p, { env: {}, configFile, streams, fetchImpl, isTTY })]);
  program.exitOverride().configureOutput({ writeOut: (s) => streams.err.push(s), writeErr: (s) => streams.err.push(s) });
  await program.parseAsync(['node', 'truescrape', ...argv]);
  return { code: process.exitCode ?? 0, stdout: streams.out.join(''), stderr: streams.err.join(''), fetchImpl };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('list', () => {
  it('prints one JSON row per platform when piped, needing no key and no network', async () => {
    const { code, stdout, stderr, fetchImpl } = await exec(['list']);
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stderr).toBe('');
    const rows = JSON.parse(stdout) as { platform: string; endpoints: number }[];
    expect(rows).toEqual(platformsOf(bundledCatalogue()).map((p) => ({ platform: p.name, endpoints: p.count })));
  });

  it('prints one row per endpoint of a platform', async () => {
    const { code, stdout } = await exec(['list', 'youtube']);
    expect(code).toBe(0);
    const rows = JSON.parse(stdout) as { action: string; credits: number; summary: string; experimental: boolean }[];
    const expected = endpointsFor(bundledCatalogue(), 'youtube');
    expect(rows).toHaveLength(expected.length);
    expect(rows[0]).toEqual({
      action: expected[0]!.action,
      credits: expected[0]!.credits,
      summary: expected[0]!.summary,
      experimental: expected[0]!.experimental,
    });
  });

  it('draws a table on a terminal and JSON under --json', async () => {
    const table = await exec(['list'], true);
    expect(table.stdout).toMatch(/platform/);
    expect(table.stdout).toMatch(/[│┌]/);
    expect(() => JSON.parse(table.stdout)).toThrow();
    const forced = await exec(['list', '--json'], true);
    expect(JSON.parse(forced.stdout)).toBeInstanceOf(Array);
  });

  it('is a usage error for a platform it does not know', async () => {
    const { code, stdout, stderr } = await exec(['list', 'myspace']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/myspace/);
    expect(stderr).toMatch(/truescrape list/);
  });
});
