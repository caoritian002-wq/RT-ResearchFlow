import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { _electron as electron } from '@playwright/test'

const SAMPLE_COUNT = 5
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entryPath = resolve(projectRoot, 'out/main/index.js')
const outputPath = resolve(projectRoot, 'out/cold-start-report.json')
const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-cold-start-'))
const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env

async function measureLaunch() {
  const startedAt = performance.now()
  const app = await electron.launch({
    args: [entryPath, `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
  try {
    const window = await app.firstWindow()
    await window.getByTestId('decision-center-page').waitFor({ state: 'visible', timeout: 30_000 })
    return Math.round(performance.now() - startedAt)
  } finally {
    await app.close()
  }
}

function percentile(sortedValues, fraction) {
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * fraction) - 1)
  return sortedValues[Math.max(index, 0)]
}

try {
  console.log('Warming the reusable profile...')
  await measureLaunch()

  const samplesMs = []
  for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
    const durationMs = await measureLaunch()
    samplesMs.push(durationMs)
    console.log(`  sample ${sample}/${SAMPLE_COUNT}: ${durationMs} ms`)
  }

  const sortedSamples = [...samplesMs].sort((left, right) => left - right)
  const report = {
    generatedAt: new Date().toISOString(),
    measurement: 'electron.launch to decision-center-page visible',
    profileState: 'one warm-up followed by repeated launches against the same local profile',
    sampleCount: SAMPLE_COUNT,
    samplesMs,
    summaryMs: {
      min: sortedSamples[0],
      median: percentile(sortedSamples, 0.5),
      p95: percentile(sortedSamples, 0.95),
      max: sortedSamples.at(-1),
    },
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`Cold start report: ${outputPath}`)
} finally {
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
}
