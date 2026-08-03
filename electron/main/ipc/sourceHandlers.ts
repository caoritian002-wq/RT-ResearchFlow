import { ipcMain } from 'electron'
import {
  getAllSources,
  addCustomSource,
  toggleSourceEnabled,
  deleteCustomSource,
  updateSource,
  getSourceById
} from '../database/sourceRepository'
import { scrapeHtml } from '../services/scrapers/htmlScraper'
import { scrapeRss } from '../services/scrapers/rssScraper'
import { fetchHtml } from './detailHandlers'
import * as cheerio from 'cheerio'
import type { ParseStrategy, SourceCategory } from '../database/types'

export function registerSourceHandlers(): void {
  ipcMain.handle('sources:list', () => {
    return getAllSources()
  })

  ipcMain.handle(
    'sources:add',
    (
      _e,
      data: {
        nameCN: string
        nameEN: string
        url: string
        feedUrl?: string
        parseStrategy: ParseStrategy
        contentSelector?: string
        detailSelector?: string
        authorityWeight?: number
      }
    ) => {
      return addCustomSource(data)
    }
  )

  ipcMain.handle('sources:toggle', (_e, id: number, isEnabled: boolean) => {
    return toggleSourceEnabled(id, isEnabled)
  })

  ipcMain.handle('sources:test', async (_e, id: number) => {
    const source = getSourceById(id)
    if (!source) {
      return { ok: false, error: '来源未找到' }
    }

    if (source.parseStrategy === 'API') {
      return { ok: false, error: 'API 解析方式暂不支持测试' }
    }

    const result =
      source.parseStrategy === 'RSS' || source.parseStrategy === 'ATOM'
        ? await scrapeRss(source)
        : await scrapeHtml(source)

    const sampleArticles = (result.articles ?? []).slice(0, 5).map((article) => ({
      title: article.title,
      url: article.url
    }))

    const detailChecks: Array<{
      selector: string
      matched: boolean
      snippet?: string
      error?: string
    }> = []

    if (source.detailSelector && sampleArticles.length > 0) {
      const selectors = source.detailSelector.split('|').map((s) => s.trim()).filter(Boolean)
      try {
        const html = await fetchHtml(sampleArticles[0].url)
        const $ = cheerio.load(html)
        for (const selector of selectors) {
          const found = $(selector).html()
          detailChecks.push({
            selector,
            matched: Boolean(found && found.trim()),
            snippet: found ? String(found).slice(0, 240) : undefined
          })
          if (found && found.trim()) break
        }
      } catch (err) {
        detailChecks.push({
          selector: 'fetch',
          matched: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    return {
      ok: !result.error,
      error: result.error,
      sampleArticles,
      detailChecks,
      sourceId: source.id,
      sourceName: source.nameCN,
      strategy: source.parseStrategy
    }
  })

  ipcMain.handle('sources:delete', (_e, id: number) => {
    return deleteCustomSource(id)
  })

  ipcMain.handle(
    'sources:update',
    (
      _e,
      id: number,
      data: Partial<{
        nameCN: string
        nameEN: string
        url: string
        feedUrl: string | null
        category: SourceCategory
        authorityWeight: number
        isEnabled: boolean
        parseStrategy: ParseStrategy
        contentSelector: string | null
        financeSectionFilter: string | null
        detailSelector: string | null
      }>
    ) => {
      return updateSource(id, data)
    }
  )
}
