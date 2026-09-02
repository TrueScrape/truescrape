import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  minify: false,
  sourcemap: false,
  // The catalogue JSON is inlined into the bundle so `npx truescrape --help`
  // works with no network and nothing to locate on disk at runtime.
  banner: { js: '#!/usr/bin/env node' },
});
