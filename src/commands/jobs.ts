import type { Command } from 'commander';
import type { Client, Envelope } from '../client.js';
import { requireKey, run, type Context, type ContextOverrides } from '../context.js';
import { UsageError, emit } from '../output.js';

export interface JobProgress {
  total: number;
  completed: number;
  failed: number;
  percent: number;
}

/** What GET /v1/jobs/:jobId returns. Only the fields the CLI reads are typed; the rest passes through. */
export interface Job {
  jobId: string;
  status: string;
  progress?: JobProgress;
  [field: string]: unknown;
}

export type JobsOverrides = ContextOverrides & {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  stdin?: NodeJS.ReadableStream;
};

const TERMINAL = new Set(['succeeded', 'partial', 'failed']);

/** `failed` is terminal too: the API never charges for failed targets, so it is an answer, not an error. */
export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export const DEFAULT_MAX_WAIT_SECONDS = 600;
const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 10_000;

export function parseMaxWait(value: string): number {
  const seconds = value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError(`--max-wait takes a number of seconds, not "${value}".`);
  return seconds * 1000;
}

export function pollLine(job: Job): string {
  return `job ${job.jobId} · ${job.status} · ${job.progress?.completed ?? 0}/${job.progress?.total ?? 0}`;
}

export interface WaitOptions {
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  onPoll?: (job: Job) => void;
  now?: () => number;
}

export interface WaitResult {
  envelope: Envelope<Job>;
  /** The budget ran out first; `envelope` is the last poll, still in flight. */
  timedOut: boolean;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls one job until it is terminal or the budget is spent. The delay doubles
 * from one second to a ten-second ceiling, and the last sleep is clamped so the
 * budget is honoured to the millisecond rather than overshot by a whole delay.
 */
export async function waitForJob(client: Client, jobId: string, options: WaitOptions = {}): Promise<WaitResult> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_SECONDS * 1000;
  const started = now();
  let delay = FIRST_DELAY_MS;

  for (;;) {
    const envelope = await client.get<Job>(jobPath(jobId));
    options.onPoll?.(envelope.data);
    if (isTerminal(envelope.data.status)) return { envelope, timedOut: false };

    const remaining = maxWaitMs - (now() - started);
    if (remaining <= 0) return { envelope, timedOut: true };
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

export function jobPath(jobId: string): string {
  return `/v1/jobs/${encodeURIComponent(jobId)}`;
}

export interface FollowOptions {
  maxWaitMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Waits on a job, narrating each poll on stderr, then prints the last job seen. Shared by `batch --wait` and `jobs get --wait`. */
export async function followJob(ctx: Context, jobId: string, options: FollowOptions): Promise<void> {
  const { envelope, timedOut } = await waitForJob(ctx.client, jobId, {
    ...options,
    onPoll: (job) => {
      if (!ctx.output.quiet) ctx.streams.stderr(`${pollLine(job)}\n`);
    },
  });
  if (timedOut) {
    ctx.streams.stderr(
      `job ${jobId} is still ${envelope.data.status} after ${options.maxWaitMs / 1000} s. Run \`truescrape jobs get ${jobId} --wait\` to keep waiting.\n`,
    );
  }
  emit(envelope, ctx.output, ctx.streams);
}

interface GetOpts {
  wait?: boolean;
  maxWait: string;
}

export function register(program: Command, overrides: JobsOverrides = {}): void {
  const jobs = program.command('jobs').description('Async jobs started by `truescrape batch`: show one, wait on it, or list them');

  jobs
    .command('get')
    .description('Show a job and, with --wait, its results once it finishes')
    .argument('<jobId>', 'The id `truescrape batch` printed')
    .option('--wait', 'Poll until the job reaches a terminal status')
    .option('--max-wait <seconds>', 'With --wait: stop polling after this long and print the last status', String(DEFAULT_MAX_WAIT_SECONDS))
    .action(async function (this: Command, jobId: string, opts: GetOpts) {
      await run(
        this,
        async (ctx) => {
          requireKey(ctx);
          const maxWaitMs = parseMaxWait(opts.maxWait);
          if (opts.wait) return followJob(ctx, jobId, { maxWaitMs, sleep: overrides.sleep, now: overrides.now });
          emit(await ctx.client.get<Job>(jobPath(jobId)), ctx.output, ctx.streams);
        },
        overrides,
      );
    });

  jobs
    .command('list')
    .description('List your jobs')
    .action(async function (this: Command) {
      await run(
        this,
        async (ctx) => {
          requireKey(ctx);
          emit(await ctx.client.get('/v1/jobs'), ctx.output, ctx.streams);
        },
        overrides,
      );
    });
}
