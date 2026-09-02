import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageError, type Streams } from '../output.js';
import { buildProgram } from '../program.js';
import type { CatalogueParam } from '../catalogue.js';
import { parseParams, parseTargets, register } from './batch.js';
import type { Job } from './jobs.js';

type Call = { url: string; init: RequestInit };

function sequence(responses: Response[]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${String(url)}`);
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data, meta: { creditsCharged: 0 } }), { status, headers: { 'content-type': 'application/json' } });

/** Everything the API puts in the 202 must reach stdout, not just the id. */
const ACCEPTED = {
  jobId: 'job_1',
  status: 'queued',
  endpoint: 'youtube.channelVideos',
  targets: 2,
  pollUrl: 'https://api.example/v1/jobs/job_1',
  estimatedCredits: 2,
};
const accepted = () => ok(ACCEPTED, 202);

const job = (status: string, completed = 0, total = 2): Job => ({
  jobId: 'job_1',
  status,
  progress: { total, completed, failed: 0, percent: total ? Math.round((completed / total) * 100) : 0 },
});

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

const dir = () => mkdtempSync(join(tmpdir(), 'ts-batch-'));

function targetsFile(text: string): string {
  const path = join(dir(), 'targets.json');
  writeFileSync(path, text);
  return path;
}

const TWO = [{ handle: '@first' }, { handle: '@second' }];

interface ExecOptions {
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  stdin?: NodeJS.ReadableStream;
  env?: Record<string, string | undefined>;
}

async function exec(argv: string[], options: ExecOptions) {
  const streams = capture();
  const env = options.env ?? { TRUESCRAPE_API_KEY: 'k', TRUESCRAPE_BASE_URL: 'https://api.example' };
  const program = buildProgram([
    (p) =>
      register(p, {
        env,
        configFile: join(dir(), 'config.json'),
        streams,
        isTTY: false,
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
        now: options.now,
        stdin: options.stdin,
      }),
  ]);
  program.exitOverride();
  await program.parseAsync(['node', 'truescrape', ...argv]);
  return { code: process.exitCode ?? 0, out: streams.out.join(''), err: streams.err.join('') };
}

const body = (call: Call | undefined) => JSON.parse(String(call?.init.body)) as Record<string, unknown>;

afterEach(() => {
  process.exitCode = undefined;
});

describe('parseTargets', () => {
  it('reads a JSON array of objects', () => {
    expect(parseTargets(JSON.stringify(TWO))).toEqual(TWO);
    expect(parseTargets(JSON.stringify(TWO, null, 2))).toEqual(TWO);
  });

  it('reads one JSON object per line, ignoring blank lines and CRLF', () => {
    expect(parseTargets('{"handle":"@first"}\n{"handle":"@second"}\n')).toEqual(TWO);
    expect(parseTargets('\n{"handle":"@first"}\r\n\r\n  {"handle":"@second"}  \n\n')).toEqual(TWO);
  });

  it('accepts a single object as a one-target list', () => {
    expect(parseTargets('{"handle":"@first"}')).toEqual([{ handle: '@first' }]);
  });

  it('rejects empty input and an empty array', () => {
    expect(() => parseTargets('')).toThrow(UsageError);
    expect(() => parseTargets('  \n ')).toThrow(UsageError);
    expect(() => parseTargets('[]')).toThrow(UsageError);
  });

  it('rejects anything that is not objects, naming the offending line', () => {
    expect(() => parseTargets('42')).toThrow(UsageError);
    expect(() => parseTargets('"@first"')).toThrow(UsageError);
    expect(() => parseTargets('[{"handle":"@first"}, "@second"]')).toThrow(UsageError);
    expect(() => parseTargets('{"handle":"@first"}\nnot json\n')).toThrow(/line 2/i);
    expect(() => parseTargets('{"handle":"@first"}\n[1,2]\n')).toThrow(/line 2/i);
  });
});

describe('parseParams', () => {
  const PARAMS: CatalogueParam[] = [
    { name: 'handle', flag: 'handle', type: 'string', required: true },
    { name: 'cache_max_age', flag: 'cache-max-age', type: 'string', required: false },
    { name: 'include_raw', flag: 'include-raw', type: 'boolean', required: false },
    { name: 'limit', flag: 'limit', type: 'number', required: false },
    { name: 'tab', flag: 'tab', type: 'string', required: false, enum: ['videos', 'shorts'] },
  ];

  it('splits on the first = and coerces by the catalogue type', () => {
    expect(parseParams(['cache_max_age=7d', 'include_raw=true', 'limit=25', 'tab=shorts'], PARAMS)).toEqual({
      cache_max_age: '7d',
      include_raw: true,
      limit: 25,
      tab: 'shorts',
    });
    expect(parseParams(['handle=a=b'], PARAMS)).toEqual({ handle: 'a=b' });
    expect(parseParams(['include_raw=false'], PARAMS)).toEqual({ include_raw: false });
  });

  it('accepts the flag spelling and sends the API name', () => {
    expect(parseParams(['cache-max-age=1h', 'include-raw=true'], PARAMS)).toEqual({ cache_max_age: '1h', include_raw: true });
  });

  it('returns an empty object for no values', () => {
    expect(parseParams([], PARAMS)).toEqual({});
  });

  it('rejects a value with no =', () => {
    expect(() => parseParams(['cache_max_age'], PARAMS)).toThrow(UsageError);
    expect(() => parseParams(['cache_max_age'], PARAMS)).toThrow(/key=value/);
  });

  it('rejects an unknown key, naming the valid ones', () => {
    expect(() => parseParams(['max_age=7d'], PARAMS)).toThrow(UsageError);
    expect(() => parseParams(['max_age=7d'], PARAMS)).toThrow(/cache_max_age/);
  });

  it('rejects a value the type or enum cannot take', () => {
    expect(() => parseParams(['include_raw=yes'], PARAMS)).toThrow(UsageError);
    expect(() => parseParams(['limit=many'], PARAMS)).toThrow(UsageError);
    expect(() => parseParams(['tab=lives'], PARAMS)).toThrow(/videos, shorts/);
  });
});

describe('batch', () => {
  it('is a usage error naming `truescrape list` for an unknown endpoint, with no request', async () => {
    const { fetchImpl } = sequence([]);
    const r = await exec(['batch', 'youtube', 'no-such-action', '--targets', targetsFile(JSON.stringify(TWO))], { fetchImpl });
    expect(r.code).toBe(2);
    expect(r.err).toContain('truescrape list');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a usage error for an endpoint that is not batchable', async () => {
    const { fetchImpl } = sequence([]);
    const r = await exec(['batch', 'github', 'trending-developers', '--targets', targetsFile(JSON.stringify(TWO))], { fetchImpl });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/batch/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a usage error with no request when there is no key', async () => {
    const { fetchImpl } = sequence([]);
    const r = await exec(['batch', 'youtube', 'channel-videos', '--targets', targetsFile(JSON.stringify(TWO))], { fetchImpl, env: {} });
    expect(r.code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a usage error naming the file when --targets cannot be read', async () => {
    const { fetchImpl } = sequence([]);
    const missing = join(dir(), 'nope.json');
    const r = await exec(['batch', 'youtube', 'channel-videos', '--targets', missing], { fetchImpl });
    expect(r.code).toBe(2);
    expect(r.err).toContain('nope.json');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the registry name, the targets and the webhook, and prints the accepted job', async () => {
    const { fetchImpl, calls } = sequence([accepted()]);

    const r = await exec(
      ['batch', 'youtube', 'channel-videos', '--targets', targetsFile(JSON.stringify(TWO)), '--webhook', 'https://hooks.example/done'],
      { fetchImpl },
    );

    expect(r.code).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('https://api.example/v1/jobs/batch');
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(body(calls[0])).toEqual({ endpoint: 'youtube.channelVideos', targets: TWO, webhook_url: 'https://hooks.example/done' });
    expect(JSON.parse(r.out)).toEqual(ACCEPTED);
    expect(r.err).toContain('truescrape jobs get job_1 --wait');
  });

  it('sends --param values as params, typed by the catalogue, and omits params when none are given', async () => {
    const { fetchImpl, calls } = sequence([accepted(), accepted()]);
    const file = targetsFile(JSON.stringify(TWO));

    const r = await exec(
      ['batch', 'youtube', 'channel-videos', '--targets', file, '--param', 'cache_max_age=7d', '--param', 'include-raw=true', '--param', 'tab=shorts'],
      { fetchImpl },
    );
    expect(r.code).toBe(0);
    expect(body(calls[0])).toEqual({
      endpoint: 'youtube.channelVideos',
      targets: TWO,
      params: { cache_max_age: '7d', include_raw: true, tab: 'shorts' },
    });

    await exec(['batch', 'youtube', 'channel-videos', '--targets', file], { fetchImpl });
    expect(body(calls[1])).toEqual({ endpoint: 'youtube.channelVideos', targets: TWO });
  });

  it('is a usage error for a --param with no =, with no request', async () => {
    const { fetchImpl } = sequence([]);
    const r = await exec(['batch', 'youtube', 'channel-videos', '--targets', targetsFile(JSON.stringify(TWO)), '--param', 'cache_max_age'], { fetchImpl });
    expect(r.code).toBe(2);
    expect(r.err).toContain('key=value');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a usage error naming the valid params for an unknown --param key, with no request', async () => {
    const { fetchImpl } = sequence([]);
    const r = await exec(['batch', 'youtube', 'channel-videos', '--targets', targetsFile(JSON.stringify(TWO)), '--param', 'max_age=7d'], { fetchImpl });
    expect(r.code).toBe(2);
    expect(r.err).toContain('max_age');
    expect(r.err).toContain('cache_max_age');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('leaves webhook_url out of the body when --webhook is not given', async () => {
    const { fetchImpl, calls } = sequence([accepted()]);
    await exec(['batch', 'youtube', 'channel-videos', '--targets', targetsFile('{"handle":"@first"}\n{"handle":"@second"}\n')], { fetchImpl });
    expect(body(calls[0])).toEqual({ endpoint: 'youtube.channelVideos', targets: TWO });
  });

  it('reads targets from stdin when --targets is -', async () => {
    const { fetchImpl, calls } = sequence([accepted()]);
    const stdin = Readable.from(['{"handle":"@first"}\n', '{"handle":"@second"}\n']);

    const r = await exec(['batch', 'youtube', 'channel-videos', '--targets', '-'], { fetchImpl, stdin });

    expect(r.code).toBe(0);
    expect(body(calls[0])?.targets).toEqual(TWO);
  });

  it('with --wait polls to a terminal status with the injected sleep and prints only the final job', async () => {
    const { fetchImpl, calls } = sequence([accepted(), ok(job('queued')), ok(job('running', 1)), ok(job('succeeded', 2))]);
    const sleep = vi.fn(async (_ms: number) => {});

    const r = await exec(['batch', 'youtube', 'channel-videos', '--targets', targetsFile(JSON.stringify(TWO)), '--wait'], { fetchImpl, sleep });

    expect(r.code).toBe(0);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example/v1/jobs/batch',
      'https://api.example/v1/jobs/job_1',
      'https://api.example/v1/jobs/job_1',
      'https://api.example/v1/jobs/job_1',
    ]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect(r.out.trim().split('\n').length).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'succeeded', progress: { completed: 2, total: 2 } });
    expect(r.err).toContain('job job_1 · queued · 0/2\n');
    expect(r.err).toContain('job job_1 · succeeded · 2/2\n');
  });

  it('exits 0 on a job that ends failed, because nothing was charged and the job is the answer', async () => {
    const { fetchImpl } = sequence([accepted(), ok(job('running')), ok(job('failed'))]);
    const r = await exec(['batch', 'youtube', 'channel-videos', '--targets', targetsFile(JSON.stringify(TWO)), '--wait'], { fetchImpl, sleep: async () => {} });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'failed' });
  });

  it('stops at --max-wait, prints the last poll and how to resume, and exits 0', async () => {
    const { fetchImpl, calls } = sequence([accepted(), ok(job('queued')), ok(job('running')), ok(job('running', 1)), ok(job('succeeded', 2))]);
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });

    const r = await exec(['batch', 'youtube', 'channel-videos', '--targets', targetsFile(JSON.stringify(TWO)), '--wait', '--max-wait', '2'], {
      fetchImpl,
      sleep,
      now: () => clock,
    });

    expect(r.code).toBe(0);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example/v1/jobs/batch',
      'https://api.example/v1/jobs/job_1',
      'https://api.example/v1/jobs/job_1',
      'https://api.example/v1/jobs/job_1',
    ]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 1000]);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'running' });
    expect(r.err).toContain('truescrape jobs get job_1 --wait');
  });
});
