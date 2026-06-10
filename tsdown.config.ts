import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  dts: false,
  format: ['esm'],
  clean: true,
  platform: 'node',
  // package.json `bin` points at dist/index.js; the package is ESM via "type": "module".
  fixedExtension: false,
})
