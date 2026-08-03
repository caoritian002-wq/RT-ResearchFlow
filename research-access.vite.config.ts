import { builtinModules } from 'module'
import { resolve } from 'path'
import { defineConfig } from 'vite'

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'out/research-access',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve('electron/mcp/index.ts'),
      formats: ['cjs'],
      fileName: () => 'research-mcp.cjs',
    },
    rollupOptions: {
      external: (id) => nodeBuiltins.has(id),
    },
  },
})
