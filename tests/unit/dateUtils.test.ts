import { describe, it, expect } from 'vitest'
import { utcToBjDate, parsePublishedDate, formatBjDateTime } from '../../electron/main/utils/dateUtils'

describe('utcToBjDate', () => {
  it('converts UTC midnight to previous BJ date (UTC+8)', () => {
    // 2024-01-01 00:00 UTC = 2024-01-01 08:00 BJ
    const utc = Date.UTC(2024, 0, 1, 0, 0, 0)
    expect(utcToBjDate(utc)).toBe('2024-01-01')
  })

  it('day boundary: 2023-12-31 23:00 UTC → 2024-01-01 07:00 BJ', () => {
    const utc = Date.UTC(2023, 11, 31, 23, 0, 0)
    expect(utcToBjDate(utc)).toBe('2024-01-01')
  })

  it('2023-12-31 15:59 UTC → 2023-12-31 23:59 BJ', () => {
    const utc = Date.UTC(2023, 11, 31, 15, 59, 0)
    expect(utcToBjDate(utc)).toBe('2023-12-31')
  })

  it('2023-12-31 16:00 UTC → 2024-01-01 00:00 BJ', () => {
    const utc = Date.UTC(2023, 11, 31, 16, 0, 0)
    expect(utcToBjDate(utc)).toBe('2024-01-01')
  })

  it('returns YYYY-MM-DD format', () => {
    const utc = Date.UTC(2024, 1, 5, 10, 0, 0)
    expect(utcToBjDate(utc)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('parsePublishedDate', () => {
  it('parses ISO date strings', () => {
    const result = parsePublishedDate('2024-01-15T08:30:00Z')
    expect(result).not.toBeNull()
    expect(typeof result).toBe('number')
  })

  it('parses Date objects', () => {
    const d = new Date('2024-06-01')
    expect(parsePublishedDate(d)).toBe(d.getTime())
  })

  it('returns null for null/undefined', () => {
    expect(parsePublishedDate(null)).toBeNull()
    expect(parsePublishedDate(undefined)).toBeNull()
    expect(parsePublishedDate('')).toBeNull()
  })

  it('returns null for invalid date strings', () => {
    expect(parsePublishedDate('not-a-date')).toBeNull()
  })
})

describe('formatBjDateTime', () => {
  it('returns HH:MM format', () => {
    const utc = Date.UTC(2024, 0, 1, 2, 30, 0) // 10:30 BJ
    const result = formatBjDateTime(utc)
    expect(result).toBe('2024-01-01 10:30')
  })
})
