import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'emulator/**/*.test.ts'],
    environment: 'node',
  },
});
