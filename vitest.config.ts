import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
    // Live tests need TRUESCRAPE_API_KEY and network; opt in with TRUESCRAPE_LIVE=1.
    exclude: ['**/node_modules/**', '**/dist/**', ...(process.env.TRUESCRAPE_LIVE ? [] : ['test/live/**'])],
  },
});
