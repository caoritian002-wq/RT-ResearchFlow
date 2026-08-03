/**
 * FR-173: 产业链节点代表股
 *
 * 少而准的高置信股票映射，用于资讯归因后的龙头候选排序。
 */

export interface DefaultSupplyChainStock {
  chainGroup: string
  concept: string
  tsCode: string
  stockName: string
  leaderScore: number
  reason: string
}

export const DEFAULT_SUPPLY_CHAIN_STOCKS: DefaultSupplyChainStock[] = [
  { chainGroup: 'AI算力产业链', concept: 'AI芯片', tsCode: '688256.SH', stockName: '寒武纪', leaderScore: 94, reason: '国产 AI 芯片代表公司' },
  { chainGroup: 'AI算力产业链', concept: 'GPU', tsCode: '688041.SH', stockName: '海光信息', leaderScore: 90, reason: '国产高性能处理器核心标的' },
  { chainGroup: 'AI算力产业链', concept: '服务器', tsCode: '000977.SZ', stockName: '浪潮信息', leaderScore: 94, reason: 'AI 服务器核心供应商' },
  { chainGroup: 'AI算力产业链', concept: '服务器', tsCode: '603019.SH', stockName: '中科曙光', leaderScore: 88, reason: '服务器和算力基础设施核心公司' },
  { chainGroup: 'AI算力产业链', concept: '服务器', tsCode: '601138.SH', stockName: '工业富联', leaderScore: 88, reason: 'AI 服务器制造链重要公司' },
  { chainGroup: 'AI算力产业链', concept: '光模块', tsCode: '300308.SZ', stockName: '中际旭创', leaderScore: 96, reason: '高速光模块龙头' },
  { chainGroup: 'AI算力产业链', concept: '光模块', tsCode: '300502.SZ', stockName: '新易盛', leaderScore: 94, reason: '高速光模块核心标的' },
  { chainGroup: 'AI算力产业链', concept: '光模块', tsCode: '300394.SZ', stockName: '天孚通信', leaderScore: 90, reason: '光器件核心供应商' },
  { chainGroup: 'AI算力产业链', concept: 'IDC', tsCode: '600845.SH', stockName: '宝信软件', leaderScore: 82, reason: 'IDC 与工业软件核心公司' },
  { chainGroup: 'AI算力产业链', concept: 'IDC', tsCode: '603881.SH', stockName: '数据港', leaderScore: 78, reason: '数据中心运营商' },
  { chainGroup: 'AI算力产业链', concept: '液冷', tsCode: '002837.SZ', stockName: '英维克', leaderScore: 84, reason: '数据中心温控和液冷核心公司' },

  { chainGroup: '半导体产业链', concept: '半导体设备', tsCode: '002371.SZ', stockName: '北方华创', leaderScore: 96, reason: '半导体设备平台型龙头' },
  { chainGroup: '半导体产业链', concept: '半导体设备', tsCode: '688012.SH', stockName: '中微公司', leaderScore: 94, reason: '刻蚀设备核心公司' },
  { chainGroup: '半导体产业链', concept: '半导体设备', tsCode: '688072.SH', stockName: '拓荆科技', leaderScore: 88, reason: '薄膜沉积设备核心公司' },
  { chainGroup: '半导体产业链', concept: '半导体材料', tsCode: '688126.SH', stockName: '沪硅产业', leaderScore: 84, reason: '半导体硅片代表公司' },
  { chainGroup: '半导体产业链', concept: '光刻胶', tsCode: '603650.SH', stockName: '彤程新材', leaderScore: 80, reason: '光刻胶材料核心标的' },
  { chainGroup: '半导体产业链', concept: '芯片设计', tsCode: '301269.SZ', stockName: '华大九天', leaderScore: 86, reason: '国产 EDA 核心公司' },
  { chainGroup: '半导体产业链', concept: '封测', tsCode: '600584.SH', stockName: '长电科技', leaderScore: 90, reason: '封测龙头' },
  { chainGroup: '半导体产业链', concept: '封测', tsCode: '002156.SZ', stockName: '通富微电', leaderScore: 84, reason: '先进封装核心公司' },

  { chainGroup: '锂电产业链', concept: '锂矿', tsCode: '002466.SZ', stockName: '天齐锂业', leaderScore: 90, reason: '锂资源核心标的' },
  { chainGroup: '锂电产业链', concept: '碳酸锂', tsCode: '002460.SZ', stockName: '赣锋锂业', leaderScore: 90, reason: '锂盐和锂资源核心公司' },
  { chainGroup: '锂电产业链', concept: '正极材料', tsCode: '300073.SZ', stockName: '当升科技', leaderScore: 82, reason: '正极材料代表公司' },
  { chainGroup: '锂电产业链', concept: '电解液', tsCode: '002709.SZ', stockName: '天赐材料', leaderScore: 86, reason: '电解液龙头' },
  { chainGroup: '锂电产业链', concept: '隔膜', tsCode: '002812.SZ', stockName: '恩捷股份', leaderScore: 86, reason: '锂电隔膜龙头' },
  { chainGroup: '锂电产业链', concept: '动力电池', tsCode: '300750.SZ', stockName: '宁德时代', leaderScore: 98, reason: '动力电池全球龙头' },
  { chainGroup: '锂电产业链', concept: '动力电池', tsCode: '300014.SZ', stockName: '亿纬锂能', leaderScore: 86, reason: '动力和储能电池核心公司' },
  { chainGroup: '锂电产业链', concept: '新能源汽车', tsCode: '002594.SZ', stockName: '比亚迪', leaderScore: 96, reason: '新能源车整车与电池一体化龙头' },

  { chainGroup: '光伏产业链', concept: '多晶硅', tsCode: '600438.SH', stockName: '通威股份', leaderScore: 90, reason: '硅料和电池片龙头' },
  { chainGroup: '光伏产业链', concept: '硅片', tsCode: '002129.SZ', stockName: 'TCL中环', leaderScore: 86, reason: '硅片核心公司' },
  { chainGroup: '光伏产业链', concept: '光伏组件', tsCode: '601012.SH', stockName: '隆基绿能', leaderScore: 92, reason: '光伏组件和硅片龙头' },
  { chainGroup: '光伏产业链', concept: '光伏组件', tsCode: '002459.SZ', stockName: '晶澳科技', leaderScore: 86, reason: '一体化组件核心公司' },
  { chainGroup: '光伏产业链', concept: '逆变器', tsCode: '300274.SZ', stockName: '阳光电源', leaderScore: 96, reason: '光伏逆变器和储能龙头' },
  { chainGroup: '光伏产业链', concept: '逆变器', tsCode: '300763.SZ', stockName: '锦浪科技', leaderScore: 82, reason: '组串式逆变器核心公司' },

  { chainGroup: '储能产业链', concept: '储能系统', tsCode: '300274.SZ', stockName: '阳光电源', leaderScore: 96, reason: '储能系统集成龙头' },
  { chainGroup: '储能产业链', concept: '储能系统', tsCode: '300750.SZ', stockName: '宁德时代', leaderScore: 94, reason: '储能电池核心供应商' },
  { chainGroup: '储能产业链', concept: 'PCS', tsCode: '300693.SZ', stockName: '盛弘股份', leaderScore: 82, reason: '储能变流器核心标的' },
  { chainGroup: '储能产业链', concept: 'PCS', tsCode: '002335.SZ', stockName: '科华数据', leaderScore: 78, reason: '数据中心电源和储能系统公司' },
  { chainGroup: '储能产业链', concept: 'BMS', tsCode: '688063.SH', stockName: '派能科技', leaderScore: 80, reason: '户储和储能电池代表公司' },

  { chainGroup: '军工电子产业链', concept: '特种芯片', tsCode: '002049.SZ', stockName: '紫光国微', leaderScore: 90, reason: '特种集成电路核心公司' },
  { chainGroup: '军工电子产业链', concept: '特种芯片', tsCode: '000733.SZ', stockName: '振华科技', leaderScore: 86, reason: '军工电子元器件核心标的' },
  { chainGroup: '军工电子产业链', concept: '雷达', tsCode: '300474.SZ', stockName: '景嘉微', leaderScore: 82, reason: '军工图形和特种芯片代表公司' },
  { chainGroup: '军工电子产业链', concept: 'PCB', tsCode: '002463.SZ', stockName: '沪电股份', leaderScore: 84, reason: '高端 PCB 核心公司' },
  { chainGroup: '军工电子产业链', concept: '航电', tsCode: '600879.SH', stockName: '航天电子', leaderScore: 82, reason: '航天电子系统核心公司' },
]