import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
  },
  fmt: {
    singleQuote: true,
    ignorePatterns: ['.dev/', '.references/', 'dist/', 'docs/', 'pnpm-lock.yaml'],
  },
});
