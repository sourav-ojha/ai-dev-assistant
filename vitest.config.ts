import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000, // Docker tests may be slow
    hookTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
    // Run infra tests sequentially — they use real Docker/Git/SQLite
    sequence: {
      concurrent: false,
    },
  },
});
