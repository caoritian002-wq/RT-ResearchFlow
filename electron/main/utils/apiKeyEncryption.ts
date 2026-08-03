import { safeStorage } from 'electron'

/**
 * Encrypts a plaintext API key using Electron's safeStorage (OS-level encryption).
 * Returns null if safeStorage is not available on this platform.
 */
export function encryptApiKey(plaintext: string): Buffer | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  return safeStorage.encryptString(plaintext)
}

/**
 * Decrypts an encrypted API key Buffer back to plaintext.
 * Returns null if decryption is unavailable or the buffer is null/empty.
 */
export function decryptApiKey(encrypted: Buffer | null): string | null {
  if (!encrypted || encrypted.length === 0) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}
