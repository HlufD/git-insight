import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/git/**', 'src/stats/**', 'src/cache/**', 'src/history/**'],
      reporter: ['text', 'html'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
