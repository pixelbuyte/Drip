import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/lib/scoring/**'],
      exclude: ['src/lib/scoring/**/__tests__/**', 'src/lib/scoring/index.ts'],
      reporter: ['text'],
    },
  },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
});
