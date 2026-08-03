import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'cheerio'

const MEBIBYTE = 1024 * 1024
const RENDERER_ENTRY_BUDGET_BYTES = 4.5 * MEBIBYTE
const ASYNC_CHUNK_LIMIT = 10

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = resolve(projectRoot, 'out')
const rendererRoot = resolve(outputRoot, 'renderer')
const rendererHtmlPath = resolve(rendererRoot, 'index.html')
const reportPath = resolve(outputRoot, 'build-size-report.json')

function toPosixPath(value) {
  return value.replaceAll('\\', '/')
}

function formatMebibytes(bytes) {
  return `${(bytes / MEBIBYTE).toFixed(2)} MiB`
}

async function readAsset(relativePath, root = rendererRoot) {
  const normalizedPath = relativePath.replace(/^\.\//, '')
  const absolutePath = resolve(root, normalizedPath)
  const fileStat = await stat(absolutePath)
  return {
    path: toPosixPath(normalizedPath),
    bytes: fileStat.size,
  }
}

async function listRendererChunks(entryPath) {
  const assetsDirectory = resolve(rendererRoot, 'assets')
  const assets = await readdir(assetsDirectory, { withFileTypes: true })
  const chunks = await Promise.all(
    assets
      .filter((asset) => asset.isFile() && asset.name.endsWith('.js'))
      .map((asset) => readAsset(`assets/${asset.name}`)),
  )

  return chunks
    .filter((chunk) => chunk.path !== entryPath)
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, ASYNC_CHUNK_LIMIT)
}

async function createReport() {
  const html = await readFile(rendererHtmlPath, 'utf8')
  const $ = load(html)
  const entrySource = $('script[type="module"][src]').first().attr('src')
  if (!entrySource) {
    throw new Error('Renderer module entry was not found in out/renderer/index.html')
  }

  const rendererEntry = await readAsset(entrySource)
  const mainEntry = await readAsset('index.js', resolve(outputRoot, 'main'))
  const preloadEntry = await readAsset('index.js', resolve(outputRoot, 'preload'))
  const largestAsyncChunks = await listRendererChunks(rendererEntry.path)

  return {
    generatedAt: new Date().toISOString(),
    budgets: {
      rendererEntryBytes: RENDERER_ENTRY_BUDGET_BYTES,
    },
    entries: {
      renderer: rendererEntry,
      main: { ...mainEntry, path: `main/${mainEntry.path}` },
      preload: { ...preloadEntry, path: `preload/${preloadEntry.path}` },
    },
    largestAsyncChunks,
  }
}

function printReport(report) {
  console.log('\nBuild size report')
  console.log(`  renderer entry  ${formatMebibytes(report.entries.renderer.bytes)}  ${report.entries.renderer.path}`)
  console.log(`  main entry      ${formatMebibytes(report.entries.main.bytes)}  ${report.entries.main.path}`)
  console.log(`  preload entry   ${formatMebibytes(report.entries.preload.bytes)}  ${report.entries.preload.path}`)
  console.log('  largest async renderer chunks')
  for (const chunk of report.largestAsyncChunks) {
    console.log(`    ${formatMebibytes(chunk.bytes).padStart(9)}  ${chunk.path}`)
  }
  console.log(`  report          ${toPosixPath(reportPath)}`)
}

const report = await createReport()
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
printReport(report)

if (report.entries.renderer.bytes > report.budgets.rendererEntryBytes) {
  console.error(
    `Renderer entry ${formatMebibytes(report.entries.renderer.bytes)} exceeds the ${formatMebibytes(report.budgets.rendererEntryBytes)} budget.`,
  )
  process.exitCode = 1
}
