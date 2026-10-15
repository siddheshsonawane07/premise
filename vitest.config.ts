import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // One test file at a time: FalkorDB v4.22.0 segfaulted twice under several processes creating
    // constraints and querying at once (2026-10-15). The server serialises schema work itself.
    fileParallelism: false,
  },
});
