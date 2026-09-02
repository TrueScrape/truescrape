import type { Command } from 'commander';
import { Client, type RequestInfo } from './client.js';
import { cachePath, configPath, resolveSettings, type Settings } from './config.js';
import { UsageError, processStreams, reportError, type Format, type OutputOptions, type Streams } from './output.js';

export interface GlobalOpts {
  apiKey?: string;
  baseUrl?: string;
  format?: Format;
  pretty?: boolean;
  envelope?: boolean;
  output?: string;
  quiet?: boolean;
  color?: boolean;
  verbose?: boolean;
}

export interface Context {
  settings: Settings;
  client: Client;
  output: OutputOptions;
  streams: Streams;
  /** stdout is a terminal: pick human formats and prose errors. */
  isTTY: boolean;
  env: Record<string, string | undefined>;
  configFile: string;
  cacheFile: string;
}

export interface ContextOverrides {
  env?: Record<string, string | undefined>;
  configFile?: string;
  cacheFile?: string;
  streams?: Streams;
  isTTY?: boolean;
  fetchImpl?: typeof fetch;
}

/** Global flags apply wherever they appear; commander merges the parents' options for us. */
export function globalOpts(command: Command): GlobalOpts {
  return command.optsWithGlobals() as GlobalOpts;
}

export function createContext(command: Command, overrides: ContextOverrides = {}): Context {
  const opts = globalOpts(command);
  const env = overrides.env ?? process.env;
  const configFile = overrides.configFile ?? configPath(env);
  const cacheFile = overrides.cacheFile ?? cachePath(env);
  const streams = overrides.streams ?? processStreams;
  const isTTY = overrides.isTTY ?? Boolean(process.stdout.isTTY);

  const settings = resolveSettings({ flagKey: opts.apiKey, flagBaseUrl: opts.baseUrl, env, configFile });
  const color = opts.color !== false && !env.NO_COLOR && Boolean(process.stderr.isTTY);

  const onRequest = opts.verbose
    ? (info: RequestInfo) => streams.stderr(`${info.method} ${info.url} → ${info.status ?? 'no response'} · ${info.durationMs} ms\n`)
    : undefined;

  const client = new Client({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, fetchImpl: overrides.fetchImpl, onRequest });

  const output: OutputOptions = {
    format: opts.format ?? 'json',
    pretty: Boolean(opts.pretty),
    envelope: Boolean(opts.envelope),
    output: opts.output,
    quiet: Boolean(opts.quiet),
    color,
  };

  return { settings, client, output, streams, isTTY, env, configFile, cacheFile };
}

export const NO_KEY_MESSAGE =
  'No API key. Run `truescrape auth login`, set TRUESCRAPE_API_KEY, or pass --api-key. Keys are at https://truescrape.com/dashboard.';

export function requireKey(ctx: Context): string {
  if (!ctx.settings.apiKey) throw new UsageError(NO_KEY_MESSAGE);
  return ctx.settings.apiKey;
}

/**
 * Runs one command action: builds the context, reports any failure on stderr
 * with the right exit code, and returns that code. Every action goes through
 * here so no command invents its own error handling.
 */
export async function run(command: Command, action: (ctx: Context) => Promise<void>, overrides: ContextOverrides = {}): Promise<number> {
  const ctx = createContext(command, overrides);
  try {
    await action(ctx);
    return 0;
  } catch (err) {
    const code = reportError(err, Boolean(process.stderr.isTTY), ctx.streams, ctx.output.color);
    process.exitCode = code;
    return code;
  }
}
