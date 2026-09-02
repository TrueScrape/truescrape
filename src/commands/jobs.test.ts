import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '../client.js';
import { UsageError, type Streams } from '../output.js';
import { buildProgram } from '../program.js';
import { isTerminal, parseMaxWait, pollLine, register, waitForJob, type Job } from './jobs.js';

type Call = { url: string; init: RequestInit };

/** Answers requests from a fixed queue; a request past the end is a test failure, not a hang. */
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

const job = (status: string, completed = 0, total = 2): Job => ({
  jobId: 'job_1',
  status,
  endpoint: 'youtube.channelVideos',
  platform: 'youtube',
  progress: { total, completed, failed: 0, percent: total ? Math.round((completed / total) * 100) : 0 },
  creditsCharged: 0,
  error: null,
});

function capture(): Streams & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
}

const tmpConfig = () => join(mkdtempSync(join(tmpdir(), 'ts-jobs-')), 'config.json');

interface ExecOptions {
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

async function exec(argv: string[], options: ExecOptions) {
  const streams = capture();
  const env = options.env ?? { TRUESCRAPE_API_KEY: 'k', TRUESCRAPE_BASE_URL: 'https://api.example' };
  const program = buildProgram([
    (p) => register(p, { env, configFile: tmpConfig(), streams, isTTY: false, fetchImpl: options.fetchImpl, sleep: options.sleep, now: options.now }),
  ]);
  program.exitOverride();
  await program.parseAsync(['node', 'truescrape', ...argv]);
  return { code: process.exitCode ?? 0, out: streams.out.join(''), err: streams.err.join('') };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('isTerminal', () => {
  it('treats succeeded, partial and failed as done and queued or running as in flight', () => {
    for (const s of ['succeeded', 'partial', 'failed']) expect(isTerminal(s)).toBe(true);
    for (const s of ['queued', 'running']) expect(isTerminal(s)).toBe(false);
  });
});

describe('parseMaxWait', () => {
  it('reads seconds and returns milliseconds', () => {
    expect(parseMaxWait('600')).toBe(600_000);
    expect(parseMaxWait('0')).toBe(0);
    expect(parseMaxWait('1.5')).toBe(1500);
  });

  it('rejects anything that is not a non-negative number', () => {
    expect(() => parseMaxWait('soon')).toThrow(UsageError);
    expect(() => parseMaxWait('-1')).toThrow(UsageError);
    expect(() => parseMaxWait('')).toThrow(UsageError);
  });
});

describe('pollLine', () => {
  it('is id, status and progress on one line', () => {
    expect(pollLine(job('running', 1, 3))).toBe('job job_1 · running · 1/3');
  });
});

describe('waitForJob', () => {
  it('polls until terminal, doubling the delay from one second and capping at ten', async () => {
    const { fetchImpl, calls } = sequence([
      ok(job('queued')),
      ok(job('running')),
      ok(job('running', 1)),
      ok(job('running', 1)),
      ok(job('running', 1)),
      ok(job('running', 1)),
      ok(job('succeeded', 2)),
    ]);
    const sleep = vi.fn(async (_ms: number) => {});
    const onPoll = vi.fn();
    const client = new Client({ baseUrl: 'https://api.example', apiKey: 'k', fetchImpl });

    const result = await waitForJob(client, 'job_1', { sleep, onPoll });

    expect(result.timedOut).toBe(false);
    expect(result.envelope.data.status).toBe('succeeded');
    expect(calls.map((c) => c.url)).toEqual(Array<string>(7).fill('https://api.example/v1/jobs/job_1'));
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(onPoll).toHaveBeenCalledTimes(7);
    expect(onPoll.mock.calls[0]?.[0]).toMatchObject({ status: 'queued' });
  });

  it('stops at the wait budget, never sleeping past it, and says so', async () => {
    const { fetchImpl, calls } = sequence([ok(job('queued')), ok(job('running')), ok(job('running', 1)), ok(job('succeeded', 2))]);
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const client = new Client({ baseUrl: 'https://api.example', apiKey: 'k', fetchImpl });

    const result = await waitForJob(client, 'job_1', { sleep, now: () => clock, maxWaitMs: 2500 });

    expect(result.timedOut).toBe(true);
    expect(result.envelope.data.status).toBe('running');
    expect(calls.length).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 1500]);
  });
});

describe('jobs get', () => {
  it('fetches the job once and prints it', async () => {
    const { fetchImpl, calls } = sequence([ok(job('running', 1))]);
    const sleep = vi.fn(async (_ms: number) => {});

    const r = await exec(['jobs', 'get', 'job_1'], { fetchImpl, sleep });

    expect(r.code).toBe(0);
    expect(calls[0]?.url).toBe('https://api.example/v1/jobs/job_1');
    expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(JSON.parse(r.out)).toMatchObject({ jobId: 'job_1', status: 'running' });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('with --wait polls queued, running, succeeded with the injected sleep and prints the final job', async () => {
    const { fetchImpl, calls } = sequence([ok(job('queued')), ok(job('running', 1)), ok(job('succeeded', 2))]);
    const sleep = vi.fn(async (_ms: number) => {});

    const r = await exec(['jobs', 'get', 'job_1', '--wait'], { fetchImpl, sleep });

    expect(r.code).toBe(0);
    expect(calls.length).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect(r.out.trim().split('\n').length).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'succeeded', progress: { completed: 2, total: 2 } });
    expect(r.err).toContain('job job_1 · queued · 0/2\n');
    expect(r.err).toContain('job job_1 · running · 1/2\n');
    expect(r.err).toContain('job job_1 · succeeded · 2/2\n');
  });

  it('treats a failed job as an answer: exit 0 and the job printed', async () => {
    const { fetchImpl } = sequence([ok(job('running')), ok({ ...job('failed'), error: { code: 'upstream_unavailable' } })]);

    const r = await exec(['jobs', 'get', 'job_1', '--wait'], { fetchImpl, sleep: async () => {} });

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'failed', error: { code: 'upstream_unavailable' } });
  });

  it('stops polling at --max-wait, prints the last status and how to resume, and still exits 0', async () => {
    const { fetchImpl, calls } = sequence([ok(job('queued')), ok(job('running')), ok(job('running', 1)), ok(job('succeeded', 2))]);
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });

    const r = await exec(['jobs', 'get', 'job_1', '--wait', '--max-wait', '3'], { fetchImpl, sleep, now: () => clock });

    expect(r.code).toBe(0);
    expect(calls.length).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'running', progress: { completed: 1 } });
    expect(r.err).toMatch(/still running/);
    expect(r.err).toContain('truescrape jobs get job_1 --wait');
  });

  it('is a usage error with no request when there is no key', async () => {
    const { fetchImpl } = sequence([]);
    const r = await exec(['jobs', 'get', 'job_1'], { fetchImpl, env: {} });
    expect(r.code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('jobs list', () => {
  it('prints the list envelope', async () => {
    const { fetchImpl, calls } = sequence([ok({ jobs: [job('succeeded', 2), job('queued')] })]);

    const r = await exec(['jobs', 'list'], { fetchImpl });

    expect(r.code).toBe(0);
    expect(calls[0]?.url).toBe('https://api.example/v1/jobs');
    expect(calls[0]?.init.method).toBe('GET');
    expect(JSON.parse(r.out).jobs).toHaveLength(2);
  });
});
