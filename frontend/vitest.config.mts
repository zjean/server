import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@sync-in-server\/backend\/(.*)$/, replacement: fileURLToPath(new URL('../backend/$1', import.meta.url)) },
      // Browser-only libs reachable from upstream's FilesService graph. See
      // src/testing/browser-lib-stub.ts for why.
      { find: /^plyr$/, replacement: fileURLToPath(new URL('./src/testing/browser-lib-stub.ts', import.meta.url)) }
    ]
  },
  esbuild: { target: 'es2022', tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } } },
  test: {
    root,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['src/test-setup.ts'],
    globals: false
  }
})
