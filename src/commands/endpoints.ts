import { InvalidArgumentError, Option, type Command } from 'commander';
import { bundledCatalogue, resolveEndpoint, type CatalogueEndpoint, type CatalogueParam } from '../catalogue.js';
import type { Envelope, QueryValue } from '../client.js';
import { requireKey, run, type Context, type ContextOverrides } from '../context.js';
import { EXIT, UsageError, emit, listOf, paint } from '../output.js';

const DEFAULT_MAX_PAGES = 10;
/** A miss is usually a typo; nobody should wait on a slow catalogue fetch to learn that. */
const REFRESH_TIMEOUT_MS = 5000;

/** One `<platform> <action>` command per catalogue endpoint, plus the fallback for endpoints newer than the bundle. */
export function register(program: Command, overrides?: ContextOverrides): void {
  for (const endpoint of bundledCatalogue().endpoints) {
    registerEndpoint(platformCommand(program, endpoint.platform, overrides), endpoint, overrides);
  }
  attachFallback(program, undefined, overrides);
}

function platformCommand(program: Command, platform: string, overrides?: ContextOverrides): Command {
  const existing = program.commands.find((c) => c.name() === platform);
  if (existing) return existing;
  const created = program.command(platform).description(`${platform} endpoints`);
  attachFallback(created, platform, overrides);
  return created;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describe(endpoint: CatalogueEndpoint): string {
  const lines = [endpoint.summary];
  if (endpoint.description) lines.push(endpoint.description);
  lines.push(`Costs ${plural(endpoint.credits, 'credit')}.`);
  lines.push(...endpoint.constraints);
  if (endpoint.experimental) lines.push('(experimental)');
  return lines.join('\n');
}

/** Same rule commander applies to `--cache-max-age` → `cacheMaxAge`. */
function attributeOf(param: CatalogueParam): string {
  return param.flag.split('-').map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))).join('');
}

function hasParam(endpoint: CatalogueEndpoint, name: string): boolean {
  return endpoint.params.some((p) => p.name === name);
}

function addParamOptions(cmd: Command, param: CatalogueParam): void {
  const description = param.description ?? '';
  if (param.type === 'boolean') {
    cmd.addOption(new Option(`--${param.flag}`, description));
    cmd.addOption(new Option(`--no-${param.flag}`, `Send ${param.name}=false`));
    return;
  }
  const option = new Option(`--${param.flag} <value>`, description);
  if (param.enum) {
    const values = param.enum;
    // choices() validates but exits 1; a wrong value is the caller's mistake, so it exits 2 like every other usage error.
    option.choices(values).argParser((value: string) => {
      if (values.includes(value)) return value;
      const err = new InvalidArgumentError(`Allowed choices are ${values.join(', ')}.`);
      err.exitCode = EXIT.usage;
      throw err;
    });
  }
  if (param.default !== undefined) option.default(param.default);
  cmd.addOption(option);
}

export function registerEndpoint(parent: Command, endpoint: CatalogueEndpoint, overrides?: ContextOverrides): Command {
  const cmd = parent
    .command(endpoint.action)
    .summary(endpoint.experimental ? `${endpoint.summary} (experimental)` : endpoint.summary)
    .description(describe(endpoint));
  for (const param of endpoint.params) addParamOptions(cmd, param);

  const all = new Option('--all', 'Follow the cursor and merge every page into one result');
  const maxPages = new Option('--max-pages <n>', 'Stop --all after this many pages').default(DEFAULT_MAX_PAGES);
  if (!hasParam(endpoint, 'cursor')) {
    all.hideHelp();
    maxPages.hideHelp();
  }
  cmd.addOption(all).addOption(maxPages);

  cmd.action(async function (this: Command) {
    await run(this, (ctx) => callEndpoint(ctx, this, endpoint), overrides);
  });
  return cmd;
}

/** Only what the caller typed; a commander default is display, not intent, and the API applies its own. */
function setOptions(cmd: Command): Record<string, unknown> {
  return Object.fromEntries(Object.entries(cmd.opts()).filter(([key]) => cmd.getOptionValueSource(key) !== 'default'));
}

/** Query keyed by API param name, from commander's camel-cased option values. Unset flags are skipped. */
export function queryFromOptions(endpoint: CatalogueEndpoint, opts: Record<string, unknown>): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  const missing: string[] = [];
  for (const param of endpoint.params) {
    const value = opts[attributeOf(param)];
    if (value === undefined) {
      if (param.required) missing.push(`--${param.flag}`);
      continue;
    }
    if (param.type === 'number') {
      const n = Number(value);
      if (typeof value !== 'number' && (String(value).trim() === '' || !Number.isFinite(n))) {
        throw new UsageError(`--${param.flag} must be a number, got "${String(value)}".`);
      }
      query[param.name] = n;
    } else if (param.type === 'boolean') {
      query[param.name] = Boolean(value);
    } else {
      query[param.name] = String(value);
    }
  }
  if (missing.length) {
    throw new UsageError(
      `Missing required ${missing.length === 1 ? 'option' : 'options'} ${missing.join(', ')}. Run \`truescrape ${endpoint.platform} ${endpoint.action} --help\` for details.`,
    );
  }
  return query;
}

function parseMaxPages(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--max-pages must be a whole number of at least 1, got "${String(value)}".`);
  return n;
}

async function callEndpoint(base: Context, cmd: Command, endpoint: CatalogueEndpoint): Promise<void> {
  requireKey(base);
  const opts = setOptions(cmd);
  const query = queryFromOptions(endpoint, opts);
  // `raw` is a sibling of `data` in the response; without the envelope the payload the caller asked for is dropped.
  const ctx = query.include_raw === true ? { ...base, output: { ...base.output, envelope: true } } : base;
  if (!opts.all) {
    emit(await ctx.client.get(endpoint.path, query), ctx.output, ctx.streams);
    return;
  }
  if (!hasParam(endpoint, 'cursor')) {
    throw new UsageError(
      hasParam(endpoint, 'page')
        ? `--all follows a cursor and this endpoint has none; page through it with --page instead.`
        : 'this endpoint does not paginate, so --all has nothing to follow.',
    );
  }
  await fetchAll(ctx, endpoint, query, parseMaxPages(opts.maxPages ?? DEFAULT_MAX_PAGES));
}

/** Appends the next page's list onto the first page's shape, whether that is a bare array or a wrapper object. */
export function mergePage(acc: unknown, page: unknown): unknown {
  const base = listOf(acc);
  const next = listOf(page);
  if (!base || !next) return acc;
  const list = [...base.list, ...next.list];
  return base.key === null ? list : { ...(acc as Record<string, unknown>), [base.key]: list };
}

function credits(page: Envelope): number {
  return page.meta?.creditsCharged ?? 0;
}

async function fetchAll(ctx: Context, endpoint: CatalogueEndpoint, query: Record<string, QueryValue>, maxPages: number): Promise<void> {
  const pageLine = (n: number, page: Envelope, total: number) => {
    if (ctx.output.quiet) return;
    ctx.streams.stderr(`${paint(`page ${n} · ${plural(credits(page), 'credit')} · total ${plural(total, 'credit')}`, ctx.output.color, 'dim')}\n`);
  };

  let page = await ctx.client.get(endpoint.path, query);
  // Decided after page 1 because the shape is only known then; nothing has been printed yet, so refusing here is clean.
  if (!listOf(page.data)) throw new UsageError('--all needs a list result and this endpoint returned a single object. Run it without --all.');
  let merged = page.data;
  let total = credits(page);
  let pages = 1;
  pageLine(pages, page, total);

  while (page.pagination?.hasMore && page.pagination.cursor && pages < maxPages) {
    let next: Envelope;
    try {
      next = await ctx.client.get(endpoint.path, { ...query, cursor: page.pagination.cursor });
    } catch (err) {
      // Pages already paid for are still worth having; the exit code says the run did not finish.
      emit({ ...page, data: merged }, ctx.output, ctx.streams);
      throw err;
    }
    page = next;
    merged = mergePage(merged, page.data);
    total += credits(page);
    pages += 1;
    pageLine(pages, page, total);
  }
  emit({ ...page, data: merged }, ctx.output, ctx.streams);
}

const pending = new WeakMap<Command, Promise<void>>();

/**
 * Commander fires `command:*` synchronously and ignores what the listener returns, so
 * `parseAsync` resolves before the live-catalogue lookup finishes. Await this after it.
 */
export function dynamicDispatch(program: Command): Promise<void> {
  return pending.get(program) ?? Promise.resolve();
}

function rootOf(command: Command): Command {
  let current = command;
  while (current.parent) current = current.parent;
  return current;
}

/** Runs for an operand no registered command matched; `platform` is set when the miss is one level down. */
function attachFallback(command: Command, platform: string | undefined, overrides?: ContextOverrides): void {
  command.on('command:*', (operands: string[]) => {
    const root = rootOf(command);
    const [p, a] = platform ? [platform, operands[0]] : [operands[0], operands[1]];
    const promise = dispatchDynamic(root, p, a, overrides);
    pending.set(root, promise);
    // The entry point does not await this promise; an unhandled rejection would crash with a stack trace.
    promise.catch((err: unknown) => {
      (overrides?.streams?.stderr ?? ((t: string) => process.stderr.write(t)))(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = process.exitCode || EXIT.api;
    });
  });
}

async function dispatchDynamic(root: Command, platform: string | undefined, action: string | undefined, overrides?: ContextOverrides): Promise<void> {
  const label = [platform, action].filter(Boolean).join(' ');
  const unknown = () => new UsageError(`Unknown command "${label}". Run \`truescrape list\` to see what exists.`);

  let endpoint: CatalogueEndpoint | undefined;
  const code = await run(
    root,
    async (ctx) => {
      if (!platform || !action) throw unknown();
      const base = overrides?.fetchImpl ?? fetch;
      const fetchImpl: typeof fetch = (input, init) => base(input, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
      try {
        endpoint = await resolveEndpoint(platform, action, { baseUrl: ctx.settings.baseUrl, cachePath: ctx.cacheFile, fetchImpl });
      } catch (err) {
        // Most misses are typos. An unreachable catalogue must not turn one into a network failure.
        ctx.streams.stderr(`Could not check the live catalogue: ${err instanceof Error ? err.message : String(err)}\n`);
        throw unknown();
      }
      if (!endpoint) throw unknown();
    },
    overrides,
  );
  if (code !== EXIT.ok || !endpoint) return;

  registerEndpoint(platformCommand(root, endpoint.platform, overrides), endpoint, overrides);
  // The full argv is needed so global flags survive the second parse; commander keeps it but does not type it.
  const { rawArgs } = root as unknown as { rawArgs: string[] };
  await root.parseAsync([...rawArgs]);
}
