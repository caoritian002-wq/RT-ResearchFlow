import type { ResearchApiResponse, ResearchChangeCandidate } from './researchDiscussionTypes'

const PAGE_SIZE = 200

export async function loadAllResearchChangeCandidates(changeSetId: string): Promise<ResearchChangeCandidate[]> {
  const items: ResearchChangeCandidate[] = []
  let total = Number.POSITIVE_INFINITY
  let offset = 0
  while (offset < total) {
    const response = await window.api.industryResearch.listChangeCandidates({ changeSetId, offset, limit: PAGE_SIZE }) as ResearchApiResponse<{ items: ResearchChangeCandidate[]; total: number }>
    if (!response.ok || !response.data) throw new Error(response.message || response.error || '读取底层候选失败')
    items.push(...response.data.items)
    total = response.data.total
    if (response.data.items.length === 0) break
    offset += response.data.items.length
  }
  return items
}
