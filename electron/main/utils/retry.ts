/**
 * Generic retry utility with exponential back-off.
 * FR-074: Tushare API calls retry up to 3 times with delays 1s / 3s / 5s.
 */

interface RetryOptions {
  maxAttempts?: number
  delays?: number[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const delays = options.delays ?? [1000, 3000, 5000]

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`[withRetry] Attempt ${attempt} failed: ${errMsg}`)
      if (attempt < maxAttempts) {
        const delay = delays[attempt - 1] ?? delays[delays.length - 1]
        await sleep(delay)
      }
    }
  }
  throw lastError
}
