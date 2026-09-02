import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { bundledCatalogue, endpointsFor, platformsOf, type Catalogue, type CatalogueEndpoint, type CatalogueParam } from '../catalogue.js';
import { requireKey, run, type Context, type ContextOverrides } from '../context.js';
import type { QueryValue } from '../client.js';
import { UsageError, emit } from '../output.js';

/** The three prompts the walkthrough needs, so tests can script answers. */
export interface Prompter {
  select<T extends string>(message: string, options: { value: T; label: string; hint?: string }[]): Promise<T | undefined>;
  text(message: string, placeholder?: string): Promise<string | undefined>;
  confirm(message: string): Promise<boolean | undefined>;
}

export function clackPrompter(): Prompter {
  const unwrap = <T>(value: T | symbol): T | undefined => (clack.isCancel(value) ? undefined : (value as T));
  return {
    // clack's Option type is conditional on the value type and does not resolve for a generic T.
    select: async (message, options) => unwrap(await clack.select({ message, options: options as never })),
    text: async (message, placeholder) => unwrap(await clack.text({ message, placeholder })),
    confirm: async (message) => unwrap(await clack.confirm({ message, initialValue: false })),
  };
}

function cancelled(): never {
  throw new UsageError('Cancelled.');
}

async function askParam(prompter: Prompter, param: CatalogueParam): Promise<QueryValue> {
  const label = param.description ? `${param.name}: ${param.description}` : param.name;
  if (param.enum) {
    const answer = await prompter.select(label, param.enum.map((value) => ({ value, label: value })));
    return answer ?? cancelled();
  }
  if (param.type === 'boolean') {
    const answer = await prompter.confirm(label);
    return answer === undefined ? cancelled() : answer;
  }
  const answer = await prompter.text(label, param.default === undefined ? undefined : String(param.default));
  if (answer === undefined) cancelled();
  if (answer === '') return param.required ? cancelled() : undefined;
  if (param.type === 'number') {
    const n = Number(answer);
    if (Number.isNaN(n)) throw new UsageError(`${param.name} must be a number.`);
    return n;
  }
  return answer;
}

/** The equivalent one-liner, printed so the walkthrough teaches the command it ran. */
export function commandLine(endpoint: CatalogueEndpoint, query: Record<string, QueryValue>): string {
  const flags = endpoint.params
    .filter((p) => query[p.name] !== undefined)
    .map((p) => (p.type === 'boolean' ? (query[p.name] ? `--${p.flag}` : `--no-${p.flag}`) : `--${p.flag} ${JSON.stringify(String(query[p.name]))}`));
  return ['truescrape', endpoint.platform, endpoint.action, ...flags].join(' ');
}

export async function runInteractive(ctx: Context, prompter: Prompter, catalogue: Catalogue = bundledCatalogue()): Promise<void> {
  requireKey(ctx);

  const platform = await prompter.select(
    'Platform',
    platformsOf(catalogue).map((p) => ({ value: p.name, label: p.name, hint: `${p.count} endpoint${p.count === 1 ? '' : 's'}` })),
  );
  if (!platform) cancelled();

  const endpoints = endpointsFor(catalogue, platform);
  const action = await prompter.select(
    'Endpoint',
    endpoints.map((e) => ({ value: e.action, label: e.action, hint: `${e.credits} credit${e.credits === 1 ? '' : 's'} · ${e.summary}` })),
  );
  if (!action) cancelled();
  const endpoint = endpoints.find((e) => e.action === action);
  if (!endpoint) cancelled();

  for (const line of endpoint.constraints) ctx.streams.stderr(`${line}\n`);

  const query: Record<string, QueryValue> = {};
  const required = endpoint.params.filter((p) => p.required);
  const optional = endpoint.params.filter((p) => !p.required);
  for (const param of required) query[param.name] = await askParam(prompter, param);

  if (optional.length) {
    const more = await prompter.confirm(`Set optional parameters? (${optional.map((p) => p.name).join(', ')})`);
    if (more === undefined) cancelled();
    if (more) for (const param of optional) query[param.name] = await askParam(prompter, param);
  }

  ctx.streams.stderr(`${commandLine(endpoint, query)}\n`);
  const result = await ctx.client.get(endpoint.path, query);
  emit(result, ctx.output, ctx.streams);
}

/**
 * A bare `truescrape` on a terminal walks through platform, endpoint and
 * parameters. Anywhere else it prints help and exits 2, because an agent that
 * ran it with no arguments made a mistake and must not hang on a prompt.
 */
export function register(program: Command, overrides: ContextOverrides & { prompter?: Prompter } = {}): void {
  program.action(async function (this: Command) {
    await run(
      this,
      async (ctx) => {
        if (!ctx.isTTY && !overrides.prompter) {
          ctx.streams.stderr(`${program.helpInformation()}\n`);
          throw new UsageError('No command given. Run `truescrape list` or `truescrape <platform> <action> --help`.');
        }
        await runInteractive(ctx, overrides.prompter ?? clackPrompter());
      },
      overrides,
    );
  });
}
