import type { Command } from 'commander';
import { bundledCatalogue, endpointsFor, platformsOf } from '../catalogue.js';
import { run, type ContextOverrides } from '../context.js';
import { UsageError, formatData } from '../output.js';

export interface PlatformRow {
  platform: string;
  endpoints: number;
}

export interface EndpointRow {
  action: string;
  credits: number;
  summary: string;
  experimental: boolean;
}

export function platformRows(): PlatformRow[] {
  return platformsOf(bundledCatalogue()).map((p) => ({ platform: p.name, endpoints: p.count }));
}

export function endpointRows(platform: string): EndpointRow[] {
  const endpoints = endpointsFor(bundledCatalogue(), platform);
  if (!endpoints.length) throw new UsageError(`Unknown platform "${platform}". Run \`truescrape list\` to see what exists.`);
  return endpoints.map((e) => ({ action: e.action, credits: e.credits, summary: e.summary, experimental: e.experimental }));
}

/** `truescrape list [platform]`: the bundled catalogue, no key and no network. */
export function register(program: Command, overrides?: ContextOverrides): void {
  program
    .command('list')
    .description('Platforms in the catalogue, or every endpoint of one platform')
    .argument('[platform]', 'Show the endpoints of this platform')
    .option('--json', 'Print JSON even on a terminal')
    .action(async function (this: Command, platform: string | undefined, opts: { json?: boolean }) {
      await run(
        this,
        async (ctx) => {
          const rows = platform ? endpointRows(platform) : platformRows();
          const format = opts.json || !ctx.isTTY ? 'json' : 'table';
          ctx.streams.stdout(`${formatData(rows, format, ctx.output.pretty)}\n`);
        },
        overrides,
      );
    });
}
