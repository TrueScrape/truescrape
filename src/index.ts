import { buildProgram } from './program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = process.exitCode || 1;
  });
