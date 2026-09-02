import { isCancel, password } from '@clack/prompts';
import type { Command } from 'commander';
import { ApiError, Client } from '../client.js';
import { readConfig, writeConfig } from '../config.js';
import { run, type Context, type ContextOverrides } from '../context.js';
import { UsageError, emit } from '../output.js';

const BALANCE_PATH = '/v1/account/credit-balance';

/** Only `creditBalance` is relied on; the rest is passed through as reported. */
export interface CreditBalance {
  creditBalance: number;
  [key: string]: unknown;
}

export interface AuthOverrides extends ContextOverrides {
  /** The key typed at the prompt, or null when the person cancelled. */
  prompt?: () => Promise<string | null>;
  /** One line from stdin, for a piped key. */
  readLine?: () => Promise<string>;
}

async function promptForKey(): Promise<string | null> {
  const value = await password({ message: 'API key' });
  return isCancel(value) ? null : value;
}

/** First line only, so a trailing newline from `echo` never becomes part of the key. */
export async function readStdinLine(stdin: NodeJS.ReadableStream = process.stdin): Promise<string> {
  let text = '';
  for await (const chunk of stdin) {
    text += String(chunk);
    const newline = text.indexOf('\n');
    if (newline !== -1) return text.slice(0, newline).trim();
  }
  return text.trim();
}

/**
 * The global --api-key wins; otherwise a person is prompted and a pipe is
 * read. TRUESCRAPE_API_KEY is deliberately ignored: storing whatever the
 * shell happens to export would be a surprise, not a login.
 */
export async function resolveLoginKey(ctx: Context, overrides: AuthOverrides = {}): Promise<string> {
  let key: string | null;
  if (ctx.settings.keySource === 'flag' && ctx.settings.apiKey) key = ctx.settings.apiKey;
  else if (ctx.isTTY) key = await (overrides.prompt ?? promptForKey)();
  else key = await (overrides.readLine ?? readStdinLine)();

  if (key === null) throw new UsageError('Cancelled');
  key = key.trim();
  if (!key) throw new UsageError('No API key given. Pass --api-key, or pipe the key on stdin.');
  return key;
}

export function register(program: Command, overrides: AuthOverrides = {}): void {
  const auth = program.command('auth').description('Store, check or remove the API key');

  auth
    .command('login')
    .description(
      'Validate an API key and store it. Uses --api-key when given; otherwise asks for the key in a terminal, or reads one line from stdin in a pipe',
    )
    .action(async function (this: Command) {
      await run(
        this,
        async (ctx) => {
          const apiKey = await resolveLoginKey(ctx, overrides);
          // Built for the candidate key, not the resolved one: a stale stored key must not be what gets validated.
          const client = new Client({ baseUrl: ctx.settings.baseUrl, apiKey, fetchImpl: overrides.fetchImpl });
          const { data } = await client.get<CreditBalance>(BALANCE_PATH);

          writeConfig(ctx.configFile, { ...readConfig(ctx.configFile), apiKey });
          ctx.streams.stderr(`Saved to ${ctx.configFile}. Balance: ${data.creditBalance} credits.\n`);
          emit({ data: { saved: ctx.configFile, creditBalance: data.creditBalance }, status: 200 }, { ...ctx.output, quiet: true }, ctx.streams);
        },
        overrides,
      );
    });

  auth
    .command('status')
    .description('Show where the key and base URL come from, and the balance the key can see. Never prints the key')
    .action(async function (this: Command) {
      await run(
        this,
        async (ctx) => {
          const { keySource, baseUrl, baseUrlSource, apiKey } = ctx.settings;
          const report: Record<string, unknown> = { keySource, configFile: ctx.configFile, baseUrl, baseUrlSource, balance: null };
          if (apiKey) {
            try {
              report.balance = (await ctx.client.get<CreditBalance>(BALANCE_PATH)).data;
            } catch (err) {
              // A refused key is the answer this command exists to give; anything else is still a failure.
              if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) throw err;
              report.keyRejected = err.code;
            }
          }
          emit({ data: report, status: 200 }, { ...ctx.output, quiet: true }, ctx.streams);
        },
        overrides,
      );
    });

  auth
    .command('logout')
    .description('Remove the stored API key; other settings stay')
    .action(async function (this: Command) {
      await run(
        this,
        async (ctx) => {
          const { apiKey, ...rest } = readConfig(ctx.configFile);
          const removed = apiKey !== undefined;
          if (removed) writeConfig(ctx.configFile, rest);
          if (ctx.env.TRUESCRAPE_API_KEY) ctx.streams.stderr('TRUESCRAPE_API_KEY is still set in this shell and will keep authenticating requests.\n');
          emit({ data: { removed, configFile: ctx.configFile }, status: 200 }, { ...ctx.output, quiet: true }, ctx.streams);
        },
        overrides,
      );
    });
}
