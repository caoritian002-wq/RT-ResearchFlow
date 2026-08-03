import { createHash } from 'crypto'

/**
 * Compute SHA-256 hash of a string. Used for exact deduplication.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Compute a 64-bit SimHash of a text using bigram tokenization.
 * Returns a 16-char hex string representing the 64-bit fingerprint.
 */
export function simhash(text: string): string {
  const bigrams = extractBigrams(normalizeText(text))
  const v = new Array(64).fill(0)

  for (const bigram of bigrams) {
    const h = sha256(bigram)
    // Use first 64 bits of SHA-256
    for (let i = 0; i < 64; i++) {
      const byteIdx = Math.floor(i / 8)
      const bitIdx = 7 - (i % 8)
      const bit = (parseInt(h[byteIdx * 2] + h[byteIdx * 2 + 1], 16) >> bitIdx) & 1
      v[i] += bit === 1 ? 1 : -1
    }
  }

  let result = 0n
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) {
      result |= 1n << BigInt(63 - i)
    }
  }

  return result.toString(16).padStart(16, '0')
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\u4e00-\u9fff\u3000-\u303fa-z0-9]/g, '')
}

function extractBigrams(text: string): string[] {
  const bigrams: string[] = []
  for (let i = 0; i < text.length - 1; i++) {
    bigrams.push(text[i] + text[i + 1])
  }
  return bigrams
}

/**
 * Compute Hamming distance between two 64-bit hex SimHash values.
 */
export function hammingDistance(a: string, b: string): number {
  const aBig = BigInt('0x' + a)
  const bBig = BigInt('0x' + b)
  let xor = aBig ^ bBig
  let count = 0
  while (xor > 0n) {
    xor &= xor - 1n
    count++
  }
  return count
}
