import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(__dirname, '../..')
const SOURCE_ROOTS = [join(ROOT, 'src'), join(ROOT, 'electron')]
const IGNORED_DIRECTORIES = new Set(['node_modules', 'out', 'dist', 'coverage'])
const NATIVE_DIALOG_PATTERN = /(?:(?:window|globalThis|self)\s*\.\s*)?(?:alert|confirm|prompt)\s*\(|dialog\s*\.\s*show(?:MessageBox(?:Sync)?|ErrorBox)\s*\(/

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return IGNORED_DIRECTORIES.has(entry) ? [] : sourceFiles(path)
    return /\.(?:ts|tsx|js|jsx)$/.test(entry) ? [path] : []
  })
}

describe('项目内反馈契约', () => {
  it('业务代码不再调用浏览器或Electron原生消息框', () => {
    const violations = SOURCE_ROOTS
      .flatMap(sourceFiles)
      .filter((path) => NATIVE_DIALOG_PATTERN.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path))

    expect(violations).toEqual([])
  })
})
