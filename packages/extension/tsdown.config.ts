import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/extension.ts'],
  format: 'cjs',
  outDir: 'dist',
  platform: 'node',
  target: 'node20',
  deps: { neverBundle: ['vscode'] },
  dts: false,
  sourcemap: true,
});
