import { defineConfig } from 'vitest/config';

const coreSrcDir = new URL('../../packages/core/src', import.meta.url).pathname;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      // Resolve @apotheosis/core to its TS source so tests don't require a
      // prior `pnpm build` of the core package.
      '@apotheosis/core': coreSrcDir + '/index.ts',
    },
  },
});
