/**
 * FR-171: 内置产业链传导边数据
 * 每条边描述「上游概念」→「下游概念」的传导关系，按产业链组归类。
 *
 * 格式：{ upstreamConcept, downstreamConcept, relationLabel, chainGroup, sortOrder }
 * sortOrder 控制组内排列，值越小越靠前（代表越上游）。
 */

export interface DefaultEdge {
  upstreamConcept: string
  downstreamConcept: string
  relationLabel: string
  chainGroup: string
  sortOrder: number
}

export const DEFAULT_SUPPLY_CHAIN_EDGES: DefaultEdge[] = [
  // ──────────── 新能源（锂电产业链） ────────────
  { upstreamConcept: '锂矿',       downstreamConcept: '碳酸锂',     relationLabel: '提炼', chainGroup: '锂电产业链', sortOrder: 1 },
  { upstreamConcept: '锂矿',       downstreamConcept: '氢氧化锂',   relationLabel: '提炼', chainGroup: '锂电产业链', sortOrder: 2 },
  { upstreamConcept: '碳酸锂',     downstreamConcept: '正极材料',   relationLabel: '制备', chainGroup: '锂电产业链', sortOrder: 3 },
  { upstreamConcept: '氢氧化锂',   downstreamConcept: '正极材料',   relationLabel: '制备', chainGroup: '锂电产业链', sortOrder: 4 },
  { upstreamConcept: '正极材料',   downstreamConcept: '动力电池',   relationLabel: '组装', chainGroup: '锂电产业链', sortOrder: 5 },
  { upstreamConcept: '负极材料',   downstreamConcept: '动力电池',   relationLabel: '组装', chainGroup: '锂电产业链', sortOrder: 6 },
  { upstreamConcept: '电解液',     downstreamConcept: '动力电池',   relationLabel: '注液', chainGroup: '锂电产业链', sortOrder: 7 },
  { upstreamConcept: '隔膜',       downstreamConcept: '动力电池',   relationLabel: '内置', chainGroup: '锂电产业链', sortOrder: 8 },
  { upstreamConcept: '动力电池',   downstreamConcept: '新能源汽车', relationLabel: '装配', chainGroup: '锂电产业链', sortOrder: 9 },
  { upstreamConcept: '动力电池',   downstreamConcept: '储能',       relationLabel: '应用', chainGroup: '锂电产业链', sortOrder: 10 },
  { upstreamConcept: '新能源汽车', downstreamConcept: '充电桩',     relationLabel: '配套', chainGroup: '锂电产业链', sortOrder: 11 },

  // ──────────── 光伏产业链 ────────────
  { upstreamConcept: '工业硅',     downstreamConcept: '多晶硅',     relationLabel: '提纯', chainGroup: '光伏产业链', sortOrder: 1 },
  { upstreamConcept: '多晶硅',     downstreamConcept: '硅片',       relationLabel: '切割', chainGroup: '光伏产业链', sortOrder: 2 },
  { upstreamConcept: '硅片',       downstreamConcept: '光伏电池片', relationLabel: '加工', chainGroup: '光伏产业链', sortOrder: 3 },
  { upstreamConcept: '光伏电池片', downstreamConcept: '光伏组件',   relationLabel: '封装', chainGroup: '光伏产业链', sortOrder: 4 },
  { upstreamConcept: '光伏组件',   downstreamConcept: '光伏电站',   relationLabel: '安装', chainGroup: '光伏产业链', sortOrder: 5 },
  { upstreamConcept: '光伏电站',   downstreamConcept: '储能',       relationLabel: '配套', chainGroup: '光伏产业链', sortOrder: 6 },
  { upstreamConcept: '逆变器',     downstreamConcept: '光伏电站',   relationLabel: '并网', chainGroup: '光伏产业链', sortOrder: 7 },

  // ──────────── 半导体产业链 ────────────
  { upstreamConcept: '半导体设备', downstreamConcept: '晶圆代工',   relationLabel: '支撑', chainGroup: '半导体产业链', sortOrder: 1 },
  { upstreamConcept: '半导体材料', downstreamConcept: '晶圆代工',   relationLabel: '供材', chainGroup: '半导体产业链', sortOrder: 2 },
  { upstreamConcept: '芯片设计',   downstreamConcept: '晶圆代工',   relationLabel: '流片', chainGroup: '半导体产业链', sortOrder: 3 },
  { upstreamConcept: '晶圆代工',   downstreamConcept: '封测',       relationLabel: '封装', chainGroup: '半导体产业链', sortOrder: 4 },
  { upstreamConcept: '封测',       downstreamConcept: '消费电子',   relationLabel: '供货', chainGroup: '半导体产业链', sortOrder: 5 },
  { upstreamConcept: '封测',       downstreamConcept: '汽车芯片',   relationLabel: '供货', chainGroup: '半导体产业链', sortOrder: 6 },
  { upstreamConcept: '封测',       downstreamConcept: '工控',       relationLabel: '供货', chainGroup: '半导体产业链', sortOrder: 7 },
  { upstreamConcept: '芯片设计',   downstreamConcept: '消费电子',   relationLabel: '供货', chainGroup: '半导体产业链', sortOrder: 8 },
  { upstreamConcept: '芯片设计',   downstreamConcept: '汽车芯片',   relationLabel: '供货', chainGroup: '半导体产业链', sortOrder: 9 },
  { upstreamConcept: '光刻胶',     downstreamConcept: '半导体材料', relationLabel: '归属', chainGroup: '半导体产业链', sortOrder: 10 },

  // ──────────── AI 算力产业链 ────────────
  { upstreamConcept: 'AI芯片',     downstreamConcept: '服务器',     relationLabel: '装配', chainGroup: 'AI算力产业链', sortOrder: 1 },
  { upstreamConcept: 'GPU',        downstreamConcept: '服务器',     relationLabel: '装配', chainGroup: 'AI算力产业链', sortOrder: 2 },
  { upstreamConcept: '服务器',     downstreamConcept: 'IDC',        relationLabel: '部署', chainGroup: 'AI算力产业链', sortOrder: 3 },
  { upstreamConcept: 'IDC',        downstreamConcept: '大模型',     relationLabel: '提供算力', chainGroup: 'AI算力产业链', sortOrder: 4 },
  { upstreamConcept: '大模型',     downstreamConcept: 'AI应用',     relationLabel: 'API调用', chainGroup: 'AI算力产业链', sortOrder: 5 },
  { upstreamConcept: '液冷',       downstreamConcept: 'IDC',        relationLabel: '散热配套', chainGroup: 'AI算力产业链', sortOrder: 6 },
  { upstreamConcept: '光模块',     downstreamConcept: '服务器',     relationLabel: '互联', chainGroup: 'AI算力产业链', sortOrder: 7 },

  // ──────────── 消费电子产业链 ────────────
  { upstreamConcept: 'SoC芯片',    downstreamConcept: '智能手机',   relationLabel: '装配', chainGroup: '消费电子产业链', sortOrder: 1 },
  { upstreamConcept: 'DRAM',       downstreamConcept: '智能手机',   relationLabel: '内存', chainGroup: '消费电子产业链', sortOrder: 2 },
  { upstreamConcept: 'NAND闪存',   downstreamConcept: '智能手机',   relationLabel: '存储', chainGroup: '消费电子产业链', sortOrder: 3 },
  { upstreamConcept: '面板',       downstreamConcept: '智能手机',   relationLabel: '显示', chainGroup: '消费电子产业链', sortOrder: 4 },
  { upstreamConcept: '摄像头模组', downstreamConcept: '智能手机',   relationLabel: '组装', chainGroup: '消费电子产业链', sortOrder: 5 },
  { upstreamConcept: '智能手机',   downstreamConcept: '手机零售',   relationLabel: '销售', chainGroup: '消费电子产业链', sortOrder: 6 },
  { upstreamConcept: 'SoC芯片',    downstreamConcept: '可穿戴设备', relationLabel: '装配', chainGroup: '消费电子产业链', sortOrder: 7 },
  { upstreamConcept: 'OLED',       downstreamConcept: '可穿戴设备', relationLabel: '显示', chainGroup: '消费电子产业链', sortOrder: 8 },
  { upstreamConcept: '可穿戴设备', downstreamConcept: 'AI应用',     relationLabel: '数据入口', chainGroup: '消费电子产业链', sortOrder: 9 },

  // ──────────── 储能产业链 ────────────
  { upstreamConcept: '动力电池',   downstreamConcept: '储能系统',   relationLabel: '供应', chainGroup: '储能产业链', sortOrder: 1 },
  { upstreamConcept: '储能系统',   downstreamConcept: '光伏电站',   relationLabel: '配储', chainGroup: '储能产业链', sortOrder: 2 },
  { upstreamConcept: '储能系统',   downstreamConcept: '风电',       relationLabel: '配储', chainGroup: '储能产业链', sortOrder: 3 },
  { upstreamConcept: '储能',       downstreamConcept: '电网',       relationLabel: '调峰', chainGroup: '储能产业链', sortOrder: 4 },
  { upstreamConcept: 'BMS',        downstreamConcept: '储能系统',   relationLabel: '管理', chainGroup: '储能产业链', sortOrder: 5 },
  { upstreamConcept: 'PCS',        downstreamConcept: '储能系统',   relationLabel: '变流', chainGroup: '储能产业链', sortOrder: 6 },

  // ──────────── 医药 CXO 产业链 ────────────
  { upstreamConcept: '原料药',     downstreamConcept: 'API中间体',  relationLabel: '合成', chainGroup: 'CXO产业链', sortOrder: 1 },
  { upstreamConcept: 'API中间体',  downstreamConcept: 'CDMO',       relationLabel: '委托生产', chainGroup: 'CXO产业链', sortOrder: 2 },
  { upstreamConcept: 'CRO',        downstreamConcept: 'CDMO',       relationLabel: '研发转化', chainGroup: 'CXO产业链', sortOrder: 3 },
  { upstreamConcept: 'CDMO',       downstreamConcept: '制剂',       relationLabel: '工艺', chainGroup: 'CXO产业链', sortOrder: 4 },
  { upstreamConcept: '制剂',       downstreamConcept: '医药流通',   relationLabel: '配送', chainGroup: 'CXO产业链', sortOrder: 5 },
  { upstreamConcept: '医药流通',   downstreamConcept: '医院',       relationLabel: '供货', chainGroup: 'CXO产业链', sortOrder: 6 },

  // ──────────── 军工电子产业链 ────────────
  { upstreamConcept: '特种芯片',   downstreamConcept: '雷达',       relationLabel: '核心器件', chainGroup: '军工电子产业链', sortOrder: 1 },
  { upstreamConcept: '传感器',     downstreamConcept: '雷达',       relationLabel: '探测', chainGroup: '军工电子产业链', sortOrder: 2 },
  { upstreamConcept: 'PCB',        downstreamConcept: '雷达',       relationLabel: '基板', chainGroup: '军工电子产业链', sortOrder: 3 },
  { upstreamConcept: '雷达',       downstreamConcept: '导弹',       relationLabel: '制导', chainGroup: '军工电子产业链', sortOrder: 4 },
  { upstreamConcept: '特种芯片',   downstreamConcept: '航电',       relationLabel: '控制', chainGroup: '军工电子产业链', sortOrder: 5 },
  { upstreamConcept: '航电',       downstreamConcept: '军机',       relationLabel: '系统', chainGroup: '军工电子产业链', sortOrder: 6 },
  { upstreamConcept: '军机',       downstreamConcept: '航空航天',   relationLabel: '归属', chainGroup: '军工电子产业链', sortOrder: 7 },

  // ──────────── 上游资源（煤化钢纺） ────────────
  { upstreamConcept: '煤炭',       downstreamConcept: '焦炭',       relationLabel: '炼制', chainGroup: '资源化工产业链', sortOrder: 1 },
  { upstreamConcept: '焦炭',       downstreamConcept: '钢铁',       relationLabel: '冶炼', chainGroup: '资源化工产业链', sortOrder: 2 },
  { upstreamConcept: '钢铁',       downstreamConcept: '工程机械',   relationLabel: '原材料', chainGroup: '资源化工产业链', sortOrder: 3 },
  { upstreamConcept: '石油',       downstreamConcept: '化工',       relationLabel: '裂解', chainGroup: '资源化工产业链', sortOrder: 4 },
  { upstreamConcept: '化工',       downstreamConcept: '化学纤维',   relationLabel: '合成', chainGroup: '资源化工产业链', sortOrder: 5 },
  { upstreamConcept: '化学纤维',   downstreamConcept: '纺织服饰',   relationLabel: '制造', chainGroup: '资源化工产业链', sortOrder: 6 },
]
