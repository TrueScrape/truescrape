import type { Command } from 'commander';
import { readConfig, writeConfig, type StoredConfig } from '../config.js';
import { run, type Context, type ContextOverrides } from '../context.js';
import { UsageError, emit } from '../output.js';

export const CONFIG_KEYS = ['apiKey', 'baseUrl'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** The environment variable that would shadow each stored value. */
const SHADOWED_BY: Record<ConfigKey, string> = { apiKey: 'TRUESCRAPE_API_KEY', baseUrl: 'TRUESCRAPE_BASE_URL' };

export function parseKey(key: string): ConfigKey {
  if ((CONFIG_KEYS as readonly string[]).includes(key)) return key as ConfigKey;
  throw new UsageError(`Unknown config key "${key}". Keys: ${CONFIG_KEYS.join(', ')}.`);
}

/** Nothing here ever prints the key back, not even the command that stored it. */
export function mask(config: StoredConfig): { apiKey: '(set)' | '(not set)'; baseUrl: string | null } {
  return { apiKey: config.apiKey ? '(set)' : '(not set)', baseUrl: config.baseUrl ?? null };
}

export function parseValue(key: ConfigKey, raw: string): string {
  const value = raw.trim();
  if (!value) throw new UsageError(`A value for ${key} is required.`);
  if (key === 'baseUrl') {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new UsageError(`baseUrl must be a full URL such as https://api.truescrape.com, got "${value}".`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError(`baseUrl must start with http:// or https://, got "${value}".`);
  }
  return value;
}

function show(ctx: Context, data: unknown): void {
  emit({ data, status: 200 }, { ...ctx.output, quiet: true }, ctx.streams);
}

export function register(program: Command, overrides: ContextOverrides = {}): void {
  const config = program.command('config').description(`Read or write the config file. Keys: ${CONFIG_KEYS.join(', ')}`);

  config
    .command('get')
    .argument('<key>', `one of ${CONFIG_KEYS.join(', ')}`)
    .description('Print one stored value; the API key shows only as (set) or (not set)')
    .action(async function (this: Command, key: string) {
      await run(this, async (ctx) => show(ctx, mask(readConfig(ctx.configFile))[parseKey(key)]), overrides);
    });

  config
    .command('set')
    .argument('<key>', `one of ${CONFIG_KEYS.join(', ')}`)
    .argument('<value>')
    .description('Store one value, leaving the other as it is')
    .action(async function (this: Command, key: string, value: string) {
      await run(
        this,
        async (ctx) => {
          const name = parseKey(key);
          const parsed = parseValue(name, value);
          const next = { ...readConfig(ctx.configFile), [name]: parsed };
          writeConfig(ctx.configFile, next);
          ctx.streams.stderr(`Saved to ${ctx.configFile}.\n`);
          if (ctx.env[SHADOWED_BY[name]]) ctx.streams.stderr(`${SHADOWED_BY[name]} is set and takes precedence over the stored ${name}.\n`);
          show(ctx, { [name]: mask(next)[name], configFile: ctx.configFile });
        },
        overrides,
      );
    });

  config
    .command('list')
    .description('Print every stored value, with the API key masked')
    .action(async function (this: Command) {
      await run(this, async (ctx) => show(ctx, { ...mask(readConfig(ctx.configFile)), configFile: ctx.configFile }), overrides);
    });
}
