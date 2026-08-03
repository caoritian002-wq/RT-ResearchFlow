import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '.agents/**',
      '.claude/**',
      '.continue/**',
      '.trae/**',
      'dist/**',
      'node_modules/**',
      'out/**',
      'release/**',
      'skills/**',
      'src/out/**',
      'test-results/**',
      'targetPic/**',
      '*.config.js',
      'scripts/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...eslint.configs.recommended,
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },
  {
    files: ['electron/**/*.{ts,tsx}', 'electron.vite.config.ts', 'vitest.config.ts', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-constant-binary-expression': 'error',
      'no-debugger': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: globals.browser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    rules: {
      'no-constant-binary-expression': 'error',
      'no-debugger': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'valid-typeof': 'error',
    },
  },
)
