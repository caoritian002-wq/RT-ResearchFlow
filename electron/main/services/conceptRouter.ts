/**
 * FR-153: 题材数据源路由层
 *
 * 统一封装 KPL（开盘啦）/ THS（同花顺）/ DC（东方财富）三种数据源的题材查询接口，
 * 对外屏蔽各数据源的字段语义差异：
 *   - KPL  kpl_concept_members：con_code=股票代码（反直觉！），ts_code=概念代码
 *   - THS  ths_concept_members：ts_code=股票代码（标准），con_code=概念代码
 *   - DC   dc_concept_members： ts_code=股票代码（标准），theme_code=题材代码
 *
 * 路由函数统一返回 ConceptEntry / MemberEntry，屏蔽各源语义差异。
 */

import type Database from 'better-sqlite3'
import { getConceptsByStock, getMembersByConcept } from '../database/kplConceptMembersRepository'
import { getThsConceptsByStock, getThsMembersByConcept } from '../database/thsConceptMembersRepository'
import { getDcConceptsByStock, getDcMembersByTheme } from '../database/dcConceptMembersRepository'
import { getLimitListByDate } from '../database/limitListDailyRepository'
import { getLimitUpToday } from './sharedRtKCache'

export type ConceptSource = 'kpl' | 'ths' | 'dc'

/** 查询「某股属于哪些概念」的统一返回类型 */
export interface ConceptEntry {
  conceptCode: string   // 概念/题材代码
  conceptName: string   // 概念/题材名称
}

/** 查询「某概念包含哪些成员股」的统一返回类型 */
export interface MemberEntry {
  stockCode: string      // 股票代码（含交易所后缀，如 '600036.SH'）
  stockName: string      // 股票名称
  hotNum: number | null  // 热度（仅 KPL 有，其余为 null）
}

/**
 * 北京时间 YYYYMMDD（用于 DC 日期参数的默认值）
 */
function getBjTodayYmd(): string {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/**
 * 按股票代码查询该股所属概念列表（路由版）
 *
 * @param db        数据库实例
 * @param stockCode 股票代码（含交易所后缀，如 '600036.SH'）
 * @param source    题材数据源
 * @param tradeDate 交易日 YYYYMMDD（仅 DC 使用，默认当日）
 */
export function getConceptsByStockRouted(
  db: Database.Database,
  stockCode: string,
  source: ConceptSource,
  tradeDate?: string
): ConceptEntry[] {
  let result: ConceptEntry[]
  switch (source) {
    case 'kpl': {
      // KPL 语义反直觉：con_code=股票代码，ts_code=概念代码，name=概念名称
      const rows = getConceptsByStock(db, stockCode)
      // 按概念名去重：同一概念名称可能对应多条记录（重复行或多次写入），去重后避免重复显示
      const seenKplNames = new Set<string>()
      result = rows
        .map(r => ({ conceptCode: r.tsCode, conceptName: r.name ?? '' }))
        .filter(r => r.conceptName !== '' && !seenKplNames.has(r.conceptName) && (seenKplNames.add(r.conceptName), true))
      break
    }
    case 'ths': {
      // THS 标准语义：ts_code=股票代码，con_code=概念代码，conName=概念名称
      const rows = getThsConceptsByStock(db, stockCode)
      // 按概念名去重：THS 索引粒度极细，同一名称可能对应多个 con_code，去重后避免重复显示
      const seenNames = new Set<string>()
      result = rows
        .map(r => ({ conceptCode: r.conCode, conceptName: r.conName ?? '' }))
        .filter(r => r.conceptName !== '' && !seenNames.has(r.conceptName) && (seenNames.add(r.conceptName), true))
      break
    }
    case 'dc': {
      const date = tradeDate ?? getBjTodayYmd()
      const rows = getDcConceptsByStock(db, stockCode, date)
      result = rows.map(r => ({ conceptCode: r.themeCode, conceptName: r.themeName ?? '无题材' }))
      break
    }
  }
  return result
}

/**
 * 按概念代码查询该概念的成员股列表（路由版）
 *
 * @param db          数据库实例
 * @param conceptCode 概念/题材代码
 * @param source      题材数据源
 * @param tradeDate   交易日 YYYYMMDD（仅 DC 使用，默认当日）
 */
export function getMembersByConceptRouted(
  db: Database.Database,
  conceptCode: string,
  source: ConceptSource,
  tradeDate?: string
): MemberEntry[] {
  switch (source) {
    case 'kpl': {
      // KPL 语义反直觉：ts_code=概念代码（查询参数），con_code=股票代码，con_name=股票名称
      const rows = getMembersByConcept(db, conceptCode)
      return rows.map(r => ({ stockCode: r.conCode, stockName: r.conName ?? '', hotNum: r.hotNum }))
    }
    case 'ths': {
      // THS 标准语义：con_code=概念代码（查询参数），ts_code=股票代码，conName=概念名称（这里作为成员信息暂无股票名）
      const rows = getThsMembersByConcept(db, conceptCode)
      // THS 成员表无股票名称字段，用 stockCode 代替
      return rows.map(r => ({ stockCode: r.tsCode, stockName: '', hotNum: null }))
    }
    case 'dc': {
      const date = tradeDate ?? getBjTodayYmd()
      const rows = getDcMembersByTheme(db, conceptCode, date)
      return rows.map(r => ({ stockCode: r.tsCode, stockName: r.name ?? '', hotNum: null }))
    }
  }
}

/**
 * 计算各概念当日涨停数（本地计算，替代 getThemeZtNumByDate）
 *
 * 逻辑：
 *   - 盘后（limit_list_daily 有数据）：读 getLimitListByDate，过滤 limit='U' 的涨停股
 *   - 盘中（limit_list_daily 无数据）：读 getLimitUpToday 的实时 rt_k 缓存
 * 对每只涨停股调 getConceptsByStockRouted，反查所属概念，按**概念名称**聚合涨停数。
 * 返回值 key 为题材名称（与 getThemeZtNumByDate 保持一致，供服务层直接替换）。
 *
 * @param db        数据库实例
 * @param tradeDate 交易日 YYYYMMDD
 * @param source    题材数据源
 * @returns         Map<conceptName, 涨停股数量>
 */
export function computeThemeZtNumLocal(
  db: Database.Database,
  tradeDate: string,
  source: ConceptSource
): Map<string, number> {
  const ztNumMap = new Map<string, number>()

  // 优先从 limit_list_daily 读（盘后数据最完整）
  const allRows = getLimitListByDate(db, tradeDate)
  let limitUpCodes: string[]

  if (allRows.length > 0) {
    limitUpCodes = allRows.filter(r => r.limit === 'U').map(r => r.tsCode)
  } else {
    // 盘中降级：从 sharedRtKCache 取实时涨停股列表
    const rtLimitUp = getLimitUpToday()
    limitUpCodes = rtLimitUp.map(e => e.tsCode)
  }

  console.log(
    `[conceptRouter] computeThemeZtNumLocal(tradeDate=${tradeDate}, source=${source})`,
    `limitUpCodes.length=${limitUpCodes.length},`,
    `fromDB=${allRows.length > 0}`
  )

  for (const stockCode of limitUpCodes) {
    const concepts = getConceptsByStockRouted(db, stockCode, source, tradeDate)
    for (const c of concepts) {
      // 按题材名称聚合（与 getThemeZtNumByDate 接口一致，服务层 .get(conceptName) 无需修改）
      ztNumMap.set(c.conceptName, (ztNumMap.get(c.conceptName) ?? 0) + 1)
    }
  }

  console.log(
    `[conceptRouter] computeThemeZtNumLocal done: ${ztNumMap.size} concepts,`,
    `top3: ${[...ztNumMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}:${v}`).join(', ')}`
  )

  return ztNumMap
}
