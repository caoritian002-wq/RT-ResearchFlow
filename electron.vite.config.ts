import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve('electron/main/index.ts')
      },
      rollupOptions: {
        // Electron and the native addon remain external. pdf-parse also stays external
        // so its packaged runtime/worker assets resolve from the production dependency.
        external: ['electron', 'better-sqlite3', 'pdf-parse']
      }
    },
    resolve: {
      alias: {
        '@main': resolve('electron/main'),
        '@preload': resolve('electron/preload')
      }
    }
  },
  preload: {
    build: {
      lib: {
        entry: resolve('electron/preload/index.ts')
      },
      rollupOptions: {
        external: ['electron']
      }
    },
    resolve: {
      alias: {
        '@preload': resolve('electron/preload')
      }
    }
  },
  renderer: {
    root: resolve('src'),
    build: {
      rollupOptions: {
        input: resolve('src/index.html')
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src')
      }
    },
    plugins: [react()]
  }
})
