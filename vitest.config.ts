import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**/*'],
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['electron/**/*.ts', 'src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', '**/*.spec.ts', '**/*.test.ts']
    }
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'electron/main'),
      '@preload': resolve(__dirname, 'electron/preload'),
      '@renderer': resolve(__dirname, 'src')
    }
  }
})
