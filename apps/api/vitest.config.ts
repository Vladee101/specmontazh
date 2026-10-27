import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // все файлы работают с одной тестовой БД — по очереди
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
