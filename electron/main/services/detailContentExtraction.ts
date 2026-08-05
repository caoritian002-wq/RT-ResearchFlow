import * as cheerio from 'cheerio'

export interface ExtractedDetailContent {
  content: string
  matchedSelector: string
}

interface ScriptVideoReference {
  elementId: string
  sourceUrl: string
  coverUrl?: string
}

function resolveHttpUrl(rawValue: string | undefined, baseUrl: string): string | null {
  const value = rawValue?.trim()
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return null
  try {
    const resolved = new URL(value, baseUrl)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : null
  } catch {
    return null
  }
}

function normalizeSrcset(srcset: string | undefined, baseUrl: string): string | null {
  const value = srcset?.trim()
  if (!value) return null

  const normalized = value
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return ''
      const [urlPart, ...descriptorParts] = trimmed.split(/\s+/)
      const resolved = resolveHttpUrl(urlPart, baseUrl)
      return resolved ? [resolved, ...descriptorParts].join(' ') : ''
    })
    .filter(Boolean)
    .join(', ')

  return normalized || null
}

function readQuotedConfigValue(script: string, key: string): string | undefined {
  const match = script.match(new RegExp(`["']${key}["']\\s*:\\s*(["'])(.*?)\\1`, 's'))
  return match?.[2]?.replace(/\\\//g, '/')
}

function extractScriptVideoReferences(pageHtml: string, baseUrl: string): ScriptVideoReference[] {
  const $ = cheerio.load(pageHtml)
  const references: ScriptVideoReference[] = []

  $('script:not([src])').each((_index, element) => {
    const script = $(element).html() ?? ''
    if (!/new\s+Aliplayer\s*\(/.test(script)) return

    const elementId = readQuotedConfigValue(script, 'id')
    const sourceUrl = resolveHttpUrl(readQuotedConfigValue(script, 'source'), baseUrl)
    const coverUrl = resolveHttpUrl(readQuotedConfigValue(script, 'cover'), baseUrl) ?? undefined
    if (!elementId || !sourceUrl) return
    references.push({ elementId, sourceUrl, coverUrl })
  })

  return references
}

function videoMimeType(sourceUrl: string): string | undefined {
  const pathname = new URL(sourceUrl).pathname.toLowerCase()
  if (pathname.endsWith('.mp4')) return 'video/mp4'
  if (pathname.endsWith('.webm')) return 'video/webm'
  if (pathname.endsWith('.ogg') || pathname.endsWith('.ogv')) return 'video/ogg'
  return undefined
}

function injectScriptVideoReferences(
  $: ReturnType<typeof cheerio.load>,
  pageHtml: string,
  baseUrl: string,
): void {
  for (const reference of extractScriptVideoReferences(pageHtml, baseUrl)) {
    const placeholder = $('[id]').filter((_index, element) => $(element).attr('id') === reference.elementId).first()
    if (placeholder.length === 0) continue

    const playerContainer = placeholder.closest('.vertical-player')
    playerContainer.children('.poster, .vertical-player-cover, .img-mask, .big-play-btn, .social-btns').remove()

    const figure = $('<figure class="detail-video-reference"></figure>')
    const video = $('<video controls preload="metadata" playsinline></video>')
    if (reference.coverUrl) video.attr('poster', reference.coverUrl)

    const source = $('<source>')
      .attr('src', reference.sourceUrl)
    const mimeType = videoMimeType(reference.sourceUrl)
    if (mimeType) source.attr('type', mimeType)
    video.append(source)

    const sourceLink = $('<a></a>')
      .attr({
        href: reference.sourceUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
      })
      .text('打开视频原始地址')

    figure.append(video)
    figure.append($('<figcaption></figcaption>').append(sourceLink))

    const wrapper = placeholder.parent().hasClass('vertical-video-player-wrapper')
      ? placeholder.parent()
      : placeholder
    wrapper.replaceWith(figure)
  }
}

export function normalizeDetailContentHtml(content: string, baseUrl: string): string {
  const $ = cheerio.load(content)
  $('script, style, noscript').remove()

  $('img').each((_index, image) => {
    const element = $(image)
    const resolvedSrc = resolveHttpUrl(
      element.attr('src')
        ?? element.attr('data-src')
        ?? element.attr('data-original')
        ?? element.attr('data-lazy-src')
        ?? element.attr('data-url'),
      baseUrl,
    )
    if (resolvedSrc) element.attr('src', resolvedSrc)
    else element.removeAttr('src')

    const resolvedSrcset = normalizeSrcset(element.attr('srcset') ?? element.attr('data-srcset'), baseUrl)
    if (resolvedSrcset) element.attr('srcset', resolvedSrcset)
    else element.removeAttr('srcset')

    element.attr('referrerpolicy', 'no-referrer')
    element.attr('loading', 'lazy')
    element.attr('decoding', 'async')
  })

  $('video').each((_index, video) => {
    const element = $(video)
    const source = resolveHttpUrl(element.attr('src'), baseUrl)
    const poster = resolveHttpUrl(element.attr('poster'), baseUrl)
    if (source) element.attr('src', source)
    else element.removeAttr('src')
    if (poster) element.attr('poster', poster)
    else element.removeAttr('poster')
    element.attr('controls', '')
    element.attr('preload', 'metadata')
    element.attr('playsinline', '')
  })

  $('source').each((_index, source) => {
    const element = $(source)
    const resolved = resolveHttpUrl(element.attr('src'), baseUrl)
    if (resolved) element.attr('src', resolved)
    else element.remove()
  })

  return $('body').html()?.trim() ?? ''
}

export function extractDetailContent(
  pageHtml: string,
  detailSelector: string,
  baseUrl: string,
): ExtractedDetailContent | null {
  const page = cheerio.load(pageHtml)
  const selectors = detailSelector.split('|').map((selector) => selector.trim()).filter(Boolean)

  for (const selector of selectors) {
    let rawContent: string | null
    try {
      rawContent = page(selector).first().html()
    } catch {
      continue
    }
    if (!rawContent?.trim()) continue

    const fragment = cheerio.load(rawContent)
    injectScriptVideoReferences(fragment, pageHtml, baseUrl)
    const content = normalizeDetailContentHtml(fragment('body').html() ?? '', baseUrl)
    if (content) return { content, matchedSelector: selector }
  }

  return null
}

export function detailContentToText(content: string): string | null {
  const $ = cheerio.load(content)
  const text = $('body').text().replace(/\s+/g, ' ').trim()
  return text || null
}
