/**
 * FR-173: 产业链别名归因规则
 *
 * 将资讯中的自然语言表达映射到本地产业链组和核心节点，避免只靠节点名完全匹配。
 */

export type SupplyChainEventType =
  | 'policy'
  | 'price'
  | 'supply_demand'
  | 'order'
  | 'tech'
  | 'export_control'
  | 'earnings'
  | 'market'
  | 'other'

export type SupplyChainDirection = 'positive' | 'negative' | 'neutral' | 'mixed'

export interface SupplyChainAliasRule {
  keywords: string[]
  chainGroup: string
  concepts: string[]
  eventType?: SupplyChainEventType
  direction?: SupplyChainDirection
  reason: string
}

export const DEFAULT_SUPPLY_CHAIN_ALIASES: SupplyChainAliasRule[] = [
  {
    keywords: ['算力', 'AI算力', '智算', '智算中心', '数据中心', '云计算', '英伟达产业链', '英伟达', 'NVIDIA', '大模型训练', '算力租赁'],
    chainGroup: 'AI算力产业链',
    concepts: ['GPU', 'AI芯片', '服务器', 'IDC', '光模块', '液冷', '大模型'],
    eventType: 'supply_demand',
    direction: 'positive',
    reason: '文本涉及算力需求、数据中心或英伟达产业链，优先归因到 AI 算力核心环节。',
  },
  {
    keywords: ['半导体国产替代', '先进制程', '晶圆厂扩产', '晶圆代工', '芯片国产化', '光刻胶', 'EDA', '封测', '半导体设备', '半导体材料'],
    chainGroup: '半导体产业链',
    concepts: ['半导体设备', '半导体材料', '芯片设计', '晶圆代工', '封测', '光刻胶'],
    eventType: 'policy',
    direction: 'positive',
    reason: '文本涉及国产替代、晶圆扩产或关键材料设备，归因到半导体设备/材料/设计/制造链条。',
  },
  {
    keywords: ['新能源车', '电动车', '动力电池', '电池涨价', '锂价', '锂矿', '碳酸锂', '电池材料', '锂电池', '固态电池'],
    chainGroup: '锂电产业链',
    concepts: ['锂矿', '碳酸锂', '正极材料', '电解液', '隔膜', '动力电池', '新能源汽车'],
    eventType: 'price',
    direction: 'mixed',
    reason: '文本涉及锂资源、电池材料或新能源车需求，归因到锂电产业链及上下游材料环节。',
  },
  {
    keywords: ['光伏', '硅料', '工业硅', '多晶硅', '硅片', '电池片', '光伏组件', '组件招标', '逆变器', '装机', '光伏电站'],
    chainGroup: '光伏产业链',
    concepts: ['工业硅', '多晶硅', '硅片', '光伏电池片', '光伏组件', '逆变器', '光伏电站'],
    eventType: 'supply_demand',
    direction: 'mixed',
    reason: '文本涉及光伏装机、招标或硅料组件价格，归因到光伏制造与电站应用链条。',
  },
  {
    keywords: ['储能', '新型储能', '工商业储能', '大储', '户储', '虚拟电厂', '电网调峰', 'PCS', 'BMS', '储能系统'],
    chainGroup: '储能产业链',
    concepts: ['动力电池', '储能系统', 'PCS', 'BMS', '电网'],
    eventType: 'policy',
    direction: 'positive',
    reason: '文本涉及新型储能、电网调峰或储能系统，归因到储能电池、变流和系统集成环节。',
  },
  {
    keywords: ['军工', '低空经济', '无人机', '雷达', '导弹', '航空发动机', '航电', '军工电子', '卫星互联网', '商业航天'],
    chainGroup: '军工电子产业链',
    concepts: ['特种芯片', '传感器', 'PCB', '雷达', '导弹', '航电', '航空航天'],
    eventType: 'policy',
    direction: 'positive',
    reason: '文本涉及军工电子、低空经济或商业航天，归因到特种芯片、雷达航电和整机系统环节。',
  },
  {
    keywords: ['CXO', 'CRO', 'CDMO', '创新药', '医药外包', '原料药', 'API', '药明', '临床试验', '医药研发'],
    chainGroup: 'CXO产业链',
    concepts: ['原料药', 'API中间体', 'CRO', 'CDMO', '制剂'],
    eventType: 'policy',
    direction: 'mixed',
    reason: '文本涉及医药研发外包、创新药或原料药，归因到 CXO 研发生产链条。',
  },
  {
    keywords: ['消费电子', 'AI手机', '苹果产业链', '华为产业链', '折叠屏', '可穿戴', 'MR', 'AR', 'VR', 'OLED', '摄像头模组'],
    chainGroup: '消费电子产业链',
    concepts: ['SoC芯片', '智能手机', 'OLED', '面板', '摄像头模组', '可穿戴设备', 'AI应用'],
    eventType: 'tech',
    direction: 'positive',
    reason: '文本涉及消费电子新品、AI 手机或可穿戴设备，归因到芯片、显示、模组和终端整机环节。',
  },
  {
    keywords: ['煤炭', '焦炭', '钢铁', '铁矿', '石油', '化工品', '化纤', '纺织', '工程机械', '资源品涨价'],
    chainGroup: '资源化工产业链',
    concepts: ['煤炭', '焦炭', '钢铁', '石油', '化工', '化学纤维', '工程机械'],
    eventType: 'price',
    direction: 'mixed',
    reason: '文本涉及资源品价格或上游工业品需求，归因到煤钢化工及下游制造链条。',
  },
]