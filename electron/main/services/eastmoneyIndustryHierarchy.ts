/**
 * 申万一级行业映射 —— 东方财富板块代码白名单
 *
 * 数据来源：基于探针脚本 scripts/probe-industry-levels.mjs 与 probe-bk12-full.mjs 的实测分析
 * 校对参考：申万行业分类标准（2021 版）+ dpyt.cc 大盘云图
 *
 * 背景：
 *   东方财富 push2 的 m:90+t:2 接口返回 ~496 个板块，混合多层级（一级/二级/三级/四级）。
 *   接口本身不暴露任何层级标识字段（f124 全部=1777361985 无效），名字罗马后缀 Ⅱ/Ⅲ 仅
 *   覆盖一小部分。唯一可靠的过滤方式是按板块代码硬编码白名单。
 *
 * 实测层级分布：
 *   - BK01xx → 31 个地区板块（北京/广东/上海...）
 *   - BK04xx → 32 个板块，其中 10 个为申万一级，22 个为申万二级（电力/通信设备/...）
 *   - BK05/07/09/10/12-16 → 申万二级及以下层级混合
 *   - BK12xx → 97 个板块，其中 19 个为申万一级，78 个为申万二级（白酒Ⅱ/IT 服务Ⅱ/...）
 *
 * 申万一级共 31 个行业，分布在 4 个 BK 段：
 *   BK04 段 10 个 + BK12 段 19 个 + BK07 段 1 个 + BK10 段 1 个
 *
 * !!! 申万一级分类标准多年不变，本表无需频繁更新 !!!
 * 如未来申万官方修订分类，需重新运行探针脚本核对并手工更新本表。
 */

export interface ShenwanL1Industry {
  /** 东方财富板块代码（如 BK1283） */
  code: string
  /** 申万一级行业名称（与东财 f14 字段一致） */
  name: string
}

/**
 * 申万 31 个一级行业，按 BK 代码升序排列
 */
export const SHENWAN_L1_INDUSTRIES: readonly ShenwanL1Industry[] = [
  // BK04 段（10 个）
  { code: 'BK0427', name: '公用事业' },
  { code: 'BK0433', name: '农林牧渔' },
  { code: 'BK0436', name: '纺织服饰' },
  { code: 'BK0437', name: '煤炭' },
  { code: 'BK0438', name: '食品饮料' },
  { code: 'BK0456', name: '家用电器' },
  { code: 'BK0464', name: '石油石化' },
  { code: 'BK0478', name: '有色金属' },
  { code: 'BK0479', name: '钢铁' },
  { code: 'BK0486', name: '传媒' },
  // BK07 段（1 个）
  { code: 'BK0728', name: '环保' },
  // BK10 段（1 个）
  { code: 'BK1035', name: '美容护理' },
  // BK12 段（19 个）
  { code: 'BK1200', name: '电力设备' },
  { code: 'BK1201', name: '电子' },
  { code: 'BK1202', name: '房地产' },
  { code: 'BK1203', name: '非银金融' },
  { code: 'BK1204', name: '国防军工' },
  { code: 'BK1205', name: '机械设备' },
  { code: 'BK1206', name: '基础化工' },
  { code: 'BK1207', name: '计算机' },
  { code: 'BK1208', name: '建筑材料' },
  { code: 'BK1209', name: '建筑装饰' },
  { code: 'BK1210', name: '交通运输' },
  { code: 'BK1211', name: '汽车' },
  { code: 'BK1212', name: '轻工制造' },
  { code: 'BK1213', name: '商贸零售' },
  { code: 'BK1214', name: '社会服务' },
  { code: 'BK1215', name: '通信' },
  { code: 'BK1216', name: '医药生物' },
  { code: 'BK1217', name: '综合' },
  { code: 'BK1283', name: '银行' }
] as const

/**
 * 申万一级行业代码集合（O(1) 查询，用于 provider 过滤）
 */
export const SHENWAN_L1_CODE_SET: ReadonlySet<string> = new Set(
  SHENWAN_L1_INDUSTRIES.map(item => item.code)
)

/**
 * 申万一级行业名称 → BK 代码（用于 L2→L1 名字映射的二次查表）
 */
export const SHENWAN_L1_NAME_TO_CODE: ReadonlyMap<string, string> = new Map(
  SHENWAN_L1_INDUSTRIES.map(item => [item.name, item.code])
)

/**
 * 申万官方二级行业 → 一级行业映射（按名字，源自申万 2021 版分类标准）
 *
 * 设计说明：
 *   - key 为东方财富 f14 字段返回的二级板块中文名（含罗马 Ⅱ 后缀）
 *   - value 为对应的申万一级行业**中文名**（不是 BK 代码，避免 BK 代码偶发变更）
 *   - 共 132 个二级行业，覆盖申万 31 个一级
 *
 * 用途：
 *   provider 解析东财全量板块时，对非 L1 板块按 f14 名字查表归属到对应 L1
 *
 * 维护策略：
 *   - 申万分类标准多年稳定，本表无需频繁更新
 *   - 如东财命名变化（如新增罗马 Ⅲ 后缀变体），可在此表追加同名条目共享同一 L1
 *   - 三级板块（罗马 Ⅲ 后缀）暂不入表，未来如需嵌套三级再扩展
 */
export const SHENWAN_L2_TO_L1_NAME: Readonly<Record<string, string>> = {
  // 电子（6）
  半导体: '电子',
  元件: '电子',
  光学光电子: '电子',
  消费电子: '电子',
  电子化学品Ⅱ: '电子',
  其他电子Ⅱ: '电子',
  // 银行（1）
  银行Ⅱ: '银行',
  // 非银金融（3）
  证券Ⅱ: '非银金融',
  保险Ⅱ: '非银金融',
  多元金融: '非银金融',
  // 房地产（2）
  房地产开发: '房地产',
  房地产服务: '房地产',
  // 交通运输（4）
  物流: '交通运输',
  铁路公路: '交通运输',
  航运港口: '交通运输',
  航空机场: '交通运输',
  // 公用事业（2）
  电力: '公用事业',
  燃气Ⅱ: '公用事业',
  // 环保（2）
  环境治理: '环保',
  环保设备Ⅱ: '环保',
  // 建筑材料（3）
  水泥: '建筑材料',
  玻璃玻纤: '建筑材料',
  装修建材: '建筑材料',
  // 建筑装饰（5）
  房屋建设Ⅱ: '建筑装饰',
  装修装饰Ⅱ: '建筑装饰',
  基础建设: '建筑装饰',
  专业工程: '建筑装饰',
  工程咨询服务Ⅱ: '建筑装饰',
  // 钢铁（3）
  普钢: '钢铁',
  特钢Ⅱ: '钢铁',
  冶钢原料: '钢铁',
  // 有色金属（5）
  工业金属: '有色金属',
  贵金属: '有色金属',
  小金属: '有色金属',
  能源金属: '有色金属',
  金属新材料: '有色金属',
  // 基础化工（7）
  化学原料: '基础化工',
  化学制品: '基础化工',
  化学纤维: '基础化工',
  塑料: '基础化工',
  橡胶: '基础化工',
  农化制品: '基础化工',
  非金属材料Ⅱ: '基础化工',
  // 石油石化（3）
  油气开采Ⅱ: '石油石化',
  油服工程: '石油石化',
  炼化及贸易: '石油石化',
  // 煤炭（2）
  煤炭开采: '煤炭',
  焦炭Ⅱ: '煤炭',
  // 机械设备（5）
  通用设备: '机械设备',
  专用设备: '机械设备',
  自动化设备: '机械设备',
  工程机械: '机械设备',
  轨交设备Ⅱ: '机械设备',
  // 电力设备（6）
  电池: '电力设备',
  电网设备: '电力设备',
  光伏设备: '电力设备',
  风电设备: '电力设备',
  电机Ⅱ: '电力设备',
  其他电源设备Ⅱ: '电力设备',
  // 国防军工（5）
  航天装备Ⅱ: '国防军工',
  航空装备Ⅱ: '国防军工',
  地面兵装Ⅱ: '国防军工',
  航海装备Ⅱ: '国防军工',
  军工电子Ⅱ: '国防军工',
  // 汽车（5）
  乘用车: '汽车',
  商用车: '汽车',
  汽车零部件: '汽车',
  汽车服务: '汽车',
  摩托车及其他: '汽车',
  // 计算机（3）
  计算机设备: '计算机',
  IT服务Ⅱ: '计算机',
  软件开发: '计算机',
  // 家用电器（7）
  白色家电: '家用电器',
  黑色家电: '家用电器',
  小家电: '家用电器',
  厨卫电器: '家用电器',
  其他家电Ⅱ: '家用电器',
  家电零部件Ⅱ: '家用电器',
  照明设备Ⅱ: '家用电器',
  // 轻工制造（4）
  造纸: '轻工制造',
  包装印刷: '轻工制造',
  家居用品: '轻工制造',
  文娱用品: '轻工制造',
  // 纺织服饰（3）
  纺织制造: '纺织服饰',
  服装家纺: '纺织服饰',
  饰品: '纺织服饰',
  // 通信（2）
  通信设备: '通信',
  通信服务: '通信',
  // 传媒（6）
  游戏Ⅱ: '传媒',
  广告营销: '传媒',
  影视院线: '传媒',
  出版: '传媒',
  数字媒体: '传媒',
  电视广播Ⅱ: '传媒',
  // 农林牧渔（8）
  种植业: '农林牧渔',
  养殖业: '农林牧渔',
  渔业: '农林牧渔',
  林业Ⅱ: '农林牧渔',
  动物保健Ⅱ: '农林牧渔',
  农产品加工: '农林牧渔',
  饲料: '农林牧渔',
  农业综合Ⅱ: '农林牧渔',
  // 食品饮料（6）
  白酒Ⅱ: '食品饮料',
  非白酒: '食品饮料',
  饮料乳品: '食品饮料',
  食品加工: '食品饮料',
  调味发酵品Ⅱ: '食品饮料',
  休闲食品: '食品饮料',
  // 医药生物（6）
  化学制药: '医药生物',
  生物制品: '医药生物',
  医药商业: '医药生物',
  中药Ⅱ: '医药生物',
  医疗器械: '医药生物',
  医疗服务: '医药生物',
  // 社会服务（5）
  教育: '社会服务',
  酒店餐饮: '社会服务',
  旅游及景区: '社会服务',
  体育Ⅱ: '社会服务',
  专业服务: '社会服务',
  // 商贸零售（5）
  一般零售: '商贸零售',
  贸易Ⅱ: '商贸零售',
  专业连锁Ⅱ: '商贸零售',
  互联网电商: '商贸零售',
  旅游零售Ⅱ: '商贸零售',
  // 美容护理（3）
  化妆品: '美容护理',
  医疗美容: '美容护理',
  个护用品: '美容护理',
  // 综合（1）
  综合Ⅱ: '综合'
}

/**
 * 二级板块名称 → 一级板块 BK 代码（直接映射，O(1) 查询）
 *
 * 由 SHENWAN_L2_TO_L1_NAME 与 SHENWAN_L1_NAME_TO_CODE 派生而来。
 * 未在表中的二级板块视为「孤儿」，provider 解析时会跳过并计数告警。
 */
export const SHENWAN_L2_NAME_TO_L1_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(SHENWAN_L2_TO_L1_NAME)
    .map(([l2Name, l1Name]) => {
      const l1Code = SHENWAN_L1_NAME_TO_CODE.get(l1Name)
      return l1Code ? ([l2Name, l1Code] as const) : null
    })
    .filter((entry): entry is readonly [string, string] => entry !== null)
)

/**
 * 东方财富板块层级映射（L1 申万一级 ↔ L2 申万二级）
 *
 * 自动生成于 2026-04-28T08:20:11.800Z
 * 生成脚本：scripts/generate-industry-hierarchy.mjs
 *
 * 反推方法：拉取每个 L1/L2 板块的成分股，按重叠率 ≥80% 判定归属
 *
 * L1 总数：32，L2 总数：42，已映射 L2：4
 * 孤儿 L2（未匹配到 L1）：38
 *
 * !!! 切勿手动编辑，重新运行脚本以更新 !!!
 */

export interface IndustryHierarchyEntry {
  /** 二级板块代码 */
  code: string
  /** 二级板块名称 */
  name: string
  /** 与 L1 的成分股重叠率（0–1） */
  overlap: number
}

/** L1 板块代码（BK04xx）→ L2 板块列表 */
export const L1_TO_L2: Record<string, IndustryHierarchyEntry[]> = {
  // 有色金属
  BK0478: [
    { code: 'BK1015', name: "能源金属", overlap: 0.909 },
  ],
  // 公用事业
  BK0427: [
    { code: 'BK1028', name: "燃气Ⅱ", overlap: 0.875 },
  ],
  // 传媒
  BK0486: [
    { code: 'BK1046', name: "游戏Ⅱ", overlap: 0.92 },
  ],
  // 纺织服饰
  BK0436: [
    { code: 'BK0734', name: "饰品", overlap: 0.889 },
  ],
}

/** 未能匹配到 L1 的 L2 板块（重叠率 < 80%，仅用于调试） */
export const ORPHAN_L2: Array<{ code: string; name: string; bestL1: string | null; bestOverlap: number }> = [
  { code: 'BK1036', name: "半导体", bestL1: null, bestOverlap: 0 },
  { code: 'BK1033', name: "电池", bestL1: null, bestOverlap: 0 },
  { code: 'BK1037', name: "消费电子", bestL1: null, bestOverlap: 0 },
  { code: 'BK0736', name: "通信服务", bestL1: null, bestOverlap: 0 },
  { code: 'BK0545', name: "通用设备", bestL1: "BK0458 仪器仪表", bestOverlap: 0.27 },
  { code: 'BK0538', name: "化学制品", bestL1: null, bestOverlap: 0 },
  { code: 'BK0910', name: "专用设备", bestL1: null, bestOverlap: 0 },
  { code: 'BK0737', name: "软件开发", bestL1: null, bestOverlap: 0 },
  { code: 'BK1031', name: "光伏设备", bestL1: null, bestOverlap: 0 },
  { code: 'BK0735', name: "计算机设备", bestL1: null, bestOverlap: 0 },
  { code: 'BK1038', name: "光学光电子", bestL1: null, bestOverlap: 0 },
  { code: 'BK1041', name: "医疗器械", bestL1: null, bestOverlap: 0 },
  { code: 'BK0731', name: "农化制品", bestL1: null, bestOverlap: 0 },
  { code: 'BK1027', name: "小金属", bestL1: "BK0478 有色金属", bestOverlap: 0.56 },
  { code: 'BK0727', name: "医疗服务", bestL1: null, bestOverlap: 0 },
  { code: 'BK0728', name: "环保", bestL1: null, bestOverlap: 0 },
  { code: 'BK1044', name: "生物制品", bestL1: null, bestOverlap: 0 },
  { code: 'BK1019', name: "化学原料", bestL1: null, bestOverlap: 0 },
  { code: 'BK0739', name: "工程机械", bestL1: null, bestOverlap: 0 },
  { code: 'BK1040', name: "中药Ⅱ", bestL1: null, bestOverlap: 0 },
  { code: 'BK1034', name: "其他电源设备Ⅱ", bestL1: null, bestOverlap: 0 },
  { code: 'BK0732', name: "贵金属", bestL1: "BK0478 有色金属", bestOverlap: 0.538 },
  { code: 'BK1039', name: "电子化学品Ⅱ", bestL1: null, bestOverlap: 0 },
  { code: 'BK0738', name: "多元金融", bestL1: null, bestOverlap: 0 },
  { code: 'BK1032', name: "风电设备", bestL1: null, bestOverlap: 0 },
  { code: 'BK0546', name: "玻璃玻纤", bestL1: null, bestOverlap: 0 },
  { code: 'BK1042', name: "医药商业", bestL1: null, bestOverlap: 0 },
  { code: 'BK1035', name: "美容护理", bestL1: null, bestOverlap: 0 },
  { code: 'BK1030', name: "电机Ⅱ", bestL1: null, bestOverlap: 0 },
  { code: 'BK1043', name: "专业服务", bestL1: null, bestOverlap: 0 },
  { code: 'BK0726', name: "工程咨询服务Ⅱ", bestL1: null, bestOverlap: 0 },
  { code: 'BK0539', name: "综合Ⅱ", bestL1: null, bestOverlap: 0 },
  { code: 'BK1018', name: "橡胶", bestL1: null, bestOverlap: 0 },
  { code: 'BK0725', name: "装修装饰Ⅱ", bestL1: null, bestOverlap: 0 },
  { code: 'BK1020', name: "非金属材料Ⅱ", bestL1: null, bestOverlap: 0 },
  { code: 'BK0740', name: "教育", bestL1: null, bestOverlap: 0 },
  { code: 'BK1045', name: "房地产服务", bestL1: null, bestOverlap: 0 },
  { code: 'BK1016', name: "汽车服务", bestL1: null, bestOverlap: 0 },
]

/** L2 板块代码 → L1 板块代码（反向索引） */
export const L2_TO_L1: Record<string, string> = {
  BK1015: 'BK0478',
  BK1046: 'BK0486',
  BK1028: 'BK0427',
  BK0734: 'BK0436',
}
