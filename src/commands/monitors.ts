import type { Command } from 'commander';
import type { Envelope } from '../client.js';
import { requireKey, run, type Context, type ContextOverrides } from '../context.js';
import { EXIT, UsageError, emit, paint } from '../output.js';

interface Item {
  url: string;
  title?: string | null;
  text?: string | null;
  authorHandle?: string | null;
  publishedAt?: string | null;
  platform: string;
  source?: string;
  baseline?: boolean;
}

interface Source {
  platform: string;
  outcome: string;
  code?: string;
  credits: number;
  checked?: number;
  matched?: number;
  newCount?: number;
}

interface Found {
  term: string;
  items: Item[];
  sources: Source[];
  skipped?: { platform: string; reason: string }[];
  creditsCharged: number;
}

interface Checked {
  monitorId: string;
  isBaseline: boolean;
  creditsCharged: number;
  newItems: Item[];
  sources: Source[];
  notes?: string[];
}

interface Created {
  monitorId: string;
  term: string;
  skipped?: { platform: string; reason: string }[];
  creditsPerCheck: number;
  checksPerDay: number;
  schedule: string;
  spendNote?: string;
}

interface Listed {
  monitorId: string;
  term: string;
  state: string;
  endedReason?: string | null;
  creditsPerCheck: number;
  checksPerDay: number;
  creditsSpent: number;
  lastCheckedAt: string | null;
  agent?: string | null;
  sources?: { platform: string; state: string }[];
}

interface Page {
  items: Item[];
  nextCursor: string | null;
}

interface JsonOpt {
  json?: boolean;
}

interface CreateOpts extends JsonOpt {
  platforms?: string;
  search: boolean;
  accounts?: string;
  manual?: boolean;
  interval?: string;
  webhook?: string;
  stopAt?: string;
  maxCredits?: string;
  agent?: string;
}

const credits = (n: number) => `${n} credit${n === 1 ? '' : 's'}`;
const sources = (n: number) => `${n} source${n === 1 ? '' : 's'}`;

const answered = (s: Source) => s.outcome === 'ok' || s.outcome === 'empty';

/** Scraped text reaches a terminal here, unlike the JSON path, so nothing in it may move the cursor. */
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

function itemLines(items: Item[], label: (i: Item) => string = (i) => i.platform): string[] {
  return items.flatMap((i) => {
    const said = clean(i.title || i.text || '').slice(0, 120);
    const meta = [i.authorHandle && `@${clean(i.authorHandle)}`, i.publishedAt].filter(Boolean).join(', ');
    return [`[${label(i)}] ${said}${meta ? ` (${meta})` : ''}`, `  ${i.url}`];
  });
}

/** The one place a source's outcome becomes words, so a failure cannot read as an empty result anywhere. */
function outcomeText(s: Source, whenOk: string): string {
  const code = s.code ? ` (${s.code})` : '';
  switch (s.outcome) {
    case 'ok':
      return `${whenOk}, ${credits(s.credits)}`;
    case 'empty':
      return 'had nothing, 0 credits';
    case 'timeout':
      return `ran out of time and was not checked${code}, 0 credits`;
    case 'unpaid':
      return `not checked, refused for credit${code}, 0 credits`;
    case 'failed':
      return `could not be checked${code}, 0 credits`;
    default:
      return `${s.outcome}${code}, ${credits(s.credits)}`;
  }
}

const couldNotCheck = (list: Source[]) => {
  const n = list.filter((s) => !answered(s)).length;
  return n ? `${sources(n)} could not be checked, so there may be more.` : '';
};

/** Stdout carries the words, or the data when anything asked for data; the charge always goes to stderr. */
function respond(ctx: Context, opts: JsonOpt, envelope: Envelope, words: string, charged = 0): void {
  const billing = `${credits(charged)} charged`;
  const { json } = opts;
  const { format, envelope: wrapped, output, pretty, quiet, color } = ctx.output;
  if (json || format !== 'json' || wrapped || output || pretty) return emit(envelope, ctx.output, ctx.streams, billing);
  ctx.streams.stdout(`${words}\n`);
  if (!quiet) ctx.streams.stderr(`${paint(billing, color, 'dim')}\n`);
}

const csv = (raw: string) => [...new Set(raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean))];

export function parseAccounts(raw: string): { platform: string; handle: string }[] {
  return raw.split(',').map((entry) => {
    // First colon only: a handle can be a URL.
    const at = entry.indexOf(':');
    const platform = entry.slice(0, Math.max(at, 0)).trim().toLowerCase();
    const handle = entry.slice(at + 1).trim();
    if (!platform || !handle) throw new UsageError(`--accounts takes platform:handle pairs, such as youtube:@acme,bluesky:acme.com. "${entry}" is not one.`);
    return { platform, handle };
  });
}

function positiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} takes a whole number above zero, not "${value}".`);
  return n;
}

function createBody(term: string, opts: CreateOpts): Record<string, unknown> {
  if (opts.platforms !== undefined && !opts.search) throw new UsageError('Pass --platforms or --no-search, not both: one names where to search and the other turns searching off.');
  if (opts.manual && opts.interval !== undefined) throw new UsageError('Pass --manual or --interval, not both: a manual monitor has no schedule, so it checks only when you run `monitors check`.');
  return {
    term,
    ...(opts.platforms !== undefined ? { platforms: csv(opts.platforms) } : {}),
    ...(opts.search ? {} : { platforms: [] }),
    ...(opts.accounts !== undefined ? { accounts: parseAccounts(opts.accounts) } : {}),
    ...(opts.manual ? { schedule: 'manual' } : {}),
    ...(opts.interval !== undefined ? { interval_seconds: positiveInt('--interval', opts.interval) } : {}),
    ...(opts.webhook !== undefined ? { webhook_url: opts.webhook } : {}),
    ...(opts.stopAt !== undefined ? { stop_at: opts.stopAt } : {}),
    ...(opts.maxCredits !== undefined ? { max_credits: positiveInt('--max-credits', opts.maxCredits) } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
  };
}

function foundWords(found: Found): string {
  const headline = found.items.length
    ? `${found.items.length} mention${found.items.length === 1 ? '' : 's'} of "${clean(found.term)}".`
    : 'No mentions in the sources checked.';
  const caveat = couldNotCheck(found.sources);
  return [
    caveat ? `${headline} ${caveat}` : headline,
    ...itemLines(found.items),
    'Sources:',
    ...found.sources.map((s) => `  ${s.platform}: ${outcomeText(s, `${s.matched ?? 0} of ${s.checked ?? 0} results mention it`)}`),
    ...(found.skipped ?? []).map((s) => `  ${s.platform}: skipped. ${s.reason}`),
  ].join('\n');
}

function checkedWords(data: Checked): string {
  const n = data.newItems.length;
  let headline: string;
  if (!data.sources.some(answered)) headline = 'No source answered, so this says nothing about what is new.';
  else if (data.isBaseline) headline = `First check of ${data.monitorId}: this is the baseline, so nothing can be new yet.`;
  else {
    const caveat = couldNotCheck(data.sources);
    headline = `${n ? `${n} new since the last check.` : 'Nothing new since the last check.'}${caveat ? ` ${caveat}` : ''}`;
  }
  return [
    headline,
    ...itemLines(data.newItems, (i) => [i.platform, i.source].filter(Boolean).join(', ')),
    'Sources:',
    ...data.sources.map((s) => `  ${s.platform}: ${outcomeText(s, `${s.newCount ?? 0} new`)}`),
    ...(data.notes ?? []),
  ].join('\n');
}

function createdWords(m: Created): string {
  const cadence = m.schedule === 'manual' ? 'checks only when you run `monitors check`' : `${m.checksPerDay} checks a day`;
  return [
    `Monitor ${m.monitorId} created for "${clean(m.term)}": up to ${credits(m.creditsPerCheck)} per check, ${cadence}.`,
    ...(m.spendNote ? [m.spendNote] : []),
    ...(m.skipped ?? []).map((s) => `${s.platform}: skipped. ${s.reason}`),
  ].join('\n');
}

function listedWords(list: Listed[]): string {
  if (!list.length) return 'No monitors.';
  return list
    .flatMap((m) => [
      [
        `${m.monitorId} "${clean(m.term)}"`,
        m.endedReason ? `${m.state} (${m.endedReason})` : m.state,
        `${credits(m.creditsPerCheck)} per check`,
        `${m.checksPerDay} checks a day`,
        `${credits(m.creditsSpent)} spent`,
        `last checked ${m.lastCheckedAt ?? 'never'}`,
        ...(m.agent ? [`created by ${clean(m.agent)}`] : []),
      ].join(' · '),
      ...(m.sources ?? []).filter((s) => s.state === 'paused_unpaid').map((s) => `  ${s.platform}: ${s.state}`),
    ])
    .join('\n');
}

function pageWords(page: Page, unread: boolean): string {
  if (!page.items.length && !page.nextCursor) return unread ? 'Nothing unread.' : 'Nothing stored yet.';
  return [
    ...itemLines(page.items, (i) => [i.platform, i.source, i.baseline ? 'baseline' : ''].filter(Boolean).join(', ')),
    ...(page.nextCursor ? [unread ? 'More unread: run this again.' : `More: rerun with --cursor ${page.nextCursor}`] : []),
  ].join('\n');
}

export function register(program: Command, overrides: ContextOverrides = {}): void {
  const action = (command: Command, body: (ctx: Context) => Promise<void>) =>
    run(
      command,
      async (ctx) => {
        requireKey(ctx);
        await body(ctx);
      },
      overrides,
    );

  program
    .command('mentions')
    .description('Find who is mentioning a name right now, across public sources')
    .command('find')
    .description('Search each source once. 1 credit per source that answers; failed and empty sources are free; nothing is stored')
    .argument('<term>', 'The name to look for')
    .option('--platforms <list>', 'Only these sources, e.g. reddit,bluesky. Default: all of them')
    .option('--json', 'Print the response data as JSON')
    .action(async function (this: Command, term: string, opts: JsonOpt & { platforms?: string }) {
      await action(this, async (ctx) => {
        const envelope = await ctx.client.get<Found>('/v1/mentions', { term, platforms: opts.platforms === undefined ? undefined : csv(opts.platforms).join(',') });
        respond(ctx, opts, envelope, foundWords(envelope.data), envelope.data.creditsCharged);
      });
    });

  const monitors = program.command('monitors').description('Keep watching a name or accounts: create, check, read what is new, delete');

  monitors
    .command('create')
    .description('Create a monitor. Creating is free; each check charges every source that answers')
    .argument('<term>', 'The name it watches for, which also labels the monitor')
    .option('--platforms <list>', 'Search only these sources for the term, e.g. reddit,bluesky. Default: all of them')
    .option('--no-search', 'Do not search for the term; follow --accounts only')
    .option('--accounts <list>', 'Accounts to follow, as platform:handle pairs, e.g. youtube:@acme,bluesky:acme.com')
    .option('--manual', 'No schedule: it checks only when you run `monitors check`')
    .option('--interval <seconds>', 'Seconds between scheduled checks')
    .option('--webhook <url>', 'Also deliver new items to this URL')
    .option('--stop-at <iso>', 'End a scheduled monitor at this time')
    .option('--max-credits <n>', 'End a scheduled monitor once it has charged this much')
    .option('--agent <name>', 'The agent creating it, such as claude-code. An agent must send this')
    .option('--json', 'Print the response data as JSON')
    .action(async function (this: Command, term: string, opts: CreateOpts) {
      await action(this, async (ctx) => {
        const envelope = await ctx.client.post<Created>('/v1/monitors', createBody(term, opts));
        respond(ctx, opts, envelope, createdWords(envelope.data));
      });
    });

  monitors
    .command('list')
    .description('List your monitors with their state, cost and spend')
    .option('--json', 'Print the response data as JSON')
    .action(async function (this: Command, opts: JsonOpt) {
      await action(this, async (ctx) => {
        const envelope = await ctx.client.get<Listed[]>('/v1/monitors');
        respond(ctx, opts, envelope, listedWords(envelope.data));
      });
    });

  monitors
    .command('delete')
    .description('Delete a monitor, which stops its checks')
    .argument('<id>', 'The monitor id')
    .option('--json', 'Print the response data as JSON')
    .action(async function (this: Command, id: string, opts: JsonOpt) {
      await action(this, async (ctx) => {
        const envelope = await ctx.client.delete(`/v1/monitors/${encodeURIComponent(id)}`);
        respond(ctx, opts, envelope, `Deleted ${clean(id)}.`);
      });
    });

  monitors
    .command('check')
    .description('Check every source now and report what is new. Charges each source that answers; failed, empty and cached answers are free')
    .argument('<id>', 'The monitor id')
    .option('--json', 'Print the response data as JSON')
    .action(async function (this: Command, id: string, opts: JsonOpt) {
      await action(this, async (ctx) => {
        const envelope = await ctx.client.post<Checked>(`/v1/monitors/${encodeURIComponent(id)}/check`, {});
        respond(ctx, opts, envelope, checkedWords(envelope.data), envelope.data.creditsCharged);
        // The API answers 200 here, but a script must not take "no source answered" for "nothing new".
        if (!envelope.data.sources.some(answered)) process.exitCode = EXIT.api;
      });
    });

  monitors
    .command('updates')
    .description('Read what monitors have stored. Reading is free')
    .option('--monitor <id>', 'Only this monitor')
    .option('--unread', 'Only what this API key has not read yet, and mark it read')
    .option('--query <text>', 'Search the stored text')
    .option('--cursor <cursor>', 'The next page, from the previous answer')
    .option('--json', 'Print the response data as JSON')
    .action(async function (this: Command, opts: JsonOpt & { monitor?: string; unread?: boolean; query?: string; cursor?: string }) {
      await action(this, async (ctx) => {
        const envelope = await ctx.client.get<Page>('/v1/monitors/mentions', {
          monitor: opts.monitor,
          unread_only: opts.unread ? 'true' : undefined,
          query: opts.query,
          cursor: opts.cursor,
        });
        // A search does not advance the read position, so only a plain --unread pages by running again.
        respond(ctx, opts, envelope, pageWords(envelope.data, Boolean(opts.unread && !opts.query)));
      });
    });
}
