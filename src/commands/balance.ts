import type { Command } from 'commander';
import { requireKey, run, type ContextOverrides } from '../context.js';
import { emit } from '../output.js';

export function register(program: Command, overrides: ContextOverrides = {}): void {
  program
    .command('balance')
    .description('Show the credit balance for the current key')
    .action(async function (this: Command) {
      await run(
        this,
        async (ctx) => {
          requireKey(ctx);
          emit(await ctx.client.get('/v1/account/credit-balance'), ctx.output, ctx.streams);
        },
        overrides,
      );
    });
}
