function normalizeStrongLabels(value: string): string {
  return value
    .replace(/(?<!\\)(\*\*[^*\r\n]+?[：:]\*\*)(?=[0-9A-Za-z\u3400-\u9fff])/g, '$1 ')
    .replace(/(?<![\\\w])(__[^_\r\n]+?[：:]__)(?=[0-9A-Za-z\u3400-\u9fff])/g, '$1 ')
}

function findUnescapedBacktick(value: string, from: number): number {
  for (let index = value.indexOf('`', from); index >= 0; index = value.indexOf('`', index + 1)) {
    let slashCount = 0
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashCount += 1
    if (slashCount % 2 === 0) return index
  }
  return -1
}

function normalizeOutsideInlineCode(line: string): string {
  let cursor = 0
  let output = ''
  while (cursor < line.length) {
    const opening = findUnescapedBacktick(line, cursor)
    if (opening < 0) return output + normalizeStrongLabels(line.slice(cursor))
    output += normalizeStrongLabels(line.slice(cursor, opening))
    let runLength = 1
    while (line[opening + runLength] === '`') runLength += 1
    const marker = '`'.repeat(runLength)
    const closing = line.indexOf(marker, opening + runLength)
    if (closing < 0) return output + line.slice(opening)
    output += line.slice(opening, closing + runLength)
    cursor = closing + runLength
  }
  return output
}

/** 修复模型常见的 `**标签：**正文`，不改动代码内容或持久化原文。 */
export function normalizeAIResponseMarkdown(source: string): string {
  let fence: { marker: '`' | '~'; length: number } | null = null
  return source.split(/\r?\n/).map((line) => {
    const fenceRun = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (fenceRun) {
      const marker = fenceRun[0] as '`' | '~'
      if (!fence) fence = { marker, length: fenceRun.length }
      else if (fence.marker === marker && fenceRun.length >= fence.length) fence = null
      return line
    }
    if (fence) return line
    return normalizeOutsideInlineCode(line)
  }).join('\n')
}
