import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { bundledCatalogue, findEndpoint, type CatalogueParam } from '../catalogue.js';
import { requireKey, run } from '../context.js';
import { UsageError, emit } from '../output.js';
import { DEFAULT_MAX_WAIT_SECONDS, followJob, parseMaxWait, type Job, type JobsOverrides } from './jobs.js';

/** One target is the parameter object one direct call would take. */
export type Target = Record<string, unknown>;

const SHAPE = 'Targets are a JSON array of parameter objects, or one object per line, like {"handle":"@name"}.';

function isTarget(value: unknown): value is Target {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A JSON array, a single object, or one object per line. The whole text is
 * tried first so a pretty-printed array spanning lines is not mistaken for
 * line-delimited input; line mode is the fallback when that fails to parse.
 */
export function parseTargets(text: string): Target[] {
  if (text.trim() === '') throw new UsageError(`No targets. ${SHAPE}`);

  let whole: unknown;
  let isOneDocument = true;
  try {
    whole = JSON.parse(text);
  } catch {
    isOneDocument = false;
  }

  if (isOneDocument) {
    if (isTarget(whole)) return [whole];
    if (!Array.isArray(whole)) throw new UsageError(SHAPE);
    if (whole.length === 0) throw new UsageError(`No targets: the array is empty. ${SHAPE}`);
    if (!whole.every(isTarget)) throw new UsageError(`Every target must be an object. ${SHAPE}`);
    return whole;
  }

  const targets: Target[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new UsageError(`Line ${index + 1} of the targets is not JSON: ${line}. ${SHAPE}`);
    }
    if (!isTarget(parsed)) throw new UsageError(`Line ${index + 1} of the targets is not an object: ${line}. ${SHAPE}`);
    targets.push(parsed);
  });
  return targets;
}

export type ParamValue = string | number | boolean;

function coerce(param: CatalogueParam, value: string): ParamValue {
  if (param.type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new UsageError(`--param ${param.name} takes true or false, not "${value}".`);
    return value === 'true';
  }
  if (param.type === 'number') {
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n)) throw new UsageError(`--param ${param.name} takes a number, not "${value}".`);
    return n;
  }
  if (param.enum && !param.enum.includes(value)) {
    throw new UsageError(`--param ${param.name} must be one of ${param.enum.join(', ')}, not "${value}".`);
  }
  return value;
}

/**
 * `--param key=value` pairs the API merges into every target. Validated and
 * typed here against the endpoint's catalogue params so a typo fails before
 * a job is queued, not after. Keys take the API name or the flag spelling.
 */
export function parseParams(values: string[], params: CatalogueParam[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq < 0) throw new UsageError(`--param takes key=value, not "${raw}".`);
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    const param = params.find((p) => p.name === key || p.flag === key);
    if (!param) throw new UsageError(`Unknown --param "${key}". This endpoint takes: ${params.map((p) => p.name).join(', ')}.`);
    out[param.name] = coerce(param, value);
  }
  return out;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readTargets(source: string, stdin: NodeJS.ReadableStream): Promise<string> {
  if (source === '-') return readStream(stdin);
  try {
    return readFileSync(source, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Cannot read --targets ${source}: ${reason}`);
  }
}

interface BatchOpts {
  targets: string;
  param: string[];
  webhook?: string;
  wait?: boolean;
  maxWait: string;
}

export function register(program: Command, overrides: JobsOverrides = {}): void {
  program
    .command('batch')
    .description('Run one endpoint over many targets as an async job')
    .argument('<platform>', 'Platform, as listed by `truescrape list`')
    .argument('<action>', 'Endpoint action, as listed by `truescrape list`')
    .requiredOption('--targets <file>', 'JSON array of parameter objects, or one object per line; `-` reads stdin')
    .option('--param <key=value>', 'Parameter applied to every target, such as cache_max_age=7d; repeatable', (value: string, all: string[]) => [...all, value], [] as string[])
    .option('--webhook <url>', 'URL the API calls when the job finishes')
    .option('--wait', 'Poll until the job finishes and print it with its results')
    .option('--max-wait <seconds>', 'With --wait: stop polling after this long and print the last status', String(DEFAULT_MAX_WAIT_SECONDS))
    .action(async function (this: Command, platform: string, action: string, opts: BatchOpts) {
      await run(
        this,
        async (ctx) => {
          requireKey(ctx);

          const endpoint = findEndpoint(bundledCatalogue(), platform, action);
          if (!endpoint) throw new UsageError(`Unknown endpoint "${platform} ${action}". Run \`truescrape list\` to see every platform and action.`);
          if (!endpoint.batchable) throw new UsageError(`${platform} ${action} cannot run as a batch; it takes one target per call.`);

          const maxWaitMs = parseMaxWait(opts.maxWait);
          const params = parseParams(opts.param, endpoint.params);
          const targets = parseTargets(await readTargets(opts.targets, overrides.stdin ?? process.stdin));

          const body = {
            endpoint: endpoint.name,
            targets,
            ...(Object.keys(params).length ? { params } : {}),
            ...(opts.webhook ? { webhook_url: opts.webhook } : {}),
          };
          const accepted = await ctx.client.post<Job>('/v1/jobs/batch', body);
          const jobId = accepted.data?.jobId;
          if (typeof jobId !== 'string' || jobId === '') throw new Error('The API accepted the batch but returned no jobId.');

          if (opts.wait) return followJob(ctx, jobId, { maxWaitMs, sleep: overrides.sleep, now: overrides.now });

          if (!ctx.output.quiet) ctx.streams.stderr(`job ${jobId} accepted. Follow it with \`truescrape jobs get ${jobId} --wait\`.\n`);
          emit(accepted, ctx.output, ctx.streams);
        },
        overrides,
      );
    });
}
