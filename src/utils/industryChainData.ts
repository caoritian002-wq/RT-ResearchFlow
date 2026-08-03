// src/utils/industryChainData.ts

export interface ChainNode {
  id: string;
  label: string;
  level: number; // 层级，从0开始
  stocks?: Array<{ tsCode: string; name: string }>; // 代表个股（3~6 只）
}

export interface ChainEdge {
  from: string;
  to: string;
}

export interface IndustryChain {
  id: string;
  name: string;
  description: string;
  keywords?: string[]; // AI 文本检测关键词
  nodes: ChainNode[];
  edges: ChainEdge[];
}

/**
 * 8 条核心产业链（细腻版）
 */
export const industryChains: IndustryChain[] = [
  // ──────────────────────────────────────
  // 1. 锂电产业链
  // ──────────────────────────────────────
  {
    id: "lithium_battery",
    name: "锂电产业链",
    description: "从上游资源到动力/储能电池及整车应用",
    keywords: ["锂电", "碳酸锂", "氢氧化锂", "正极材料", "负极材料", "电解液", "隔膜", "动力电池", "磷酸铁锂", "NCM", "宁德时代", "三元电池", "电芯", "PACK", "BMS"],
    nodes: [
      // level 0：矿产资源
      { id: "lb_u1", label: "锂矿", level: 0, stocks: [{ tsCode: "002466.SZ", name: "天齐锂业" }, { tsCode: "002460.SZ", name: "赣锋锂业" }, { tsCode: "002240.SZ", name: "盛新锂能" }] },
      { id: "lb_u2", label: "钴矿/镍矿", level: 0 },
      { id: "lb_u3", label: "石墨/磷矿", level: 0 },
      // level 1：基础化学品
      { id: "lb_m1", label: "碳酸锂/氢氧化锂", level: 1 },
      { id: "lb_m2", label: "硫酸钴/硫酸镍", level: 1 },
      { id: "lb_m3", label: "六氟磷酸锂/添加剂", level: 1 },
      // level 2：前驱体与溶剂
      { id: "lb_m4", label: "前驱体（三元/磷酸铁）", level: 2 },
      { id: "lb_m5", label: "有机溶剂/NMP", level: 2 },
      // level 3：核心材料
      { id: "lb_m6", label: "正极材料（LFP/NCM/LCO）", level: 3, stocks: [{ tsCode: "300769.SZ", name: "德方纳米" }, { tsCode: "603799.SH", name: "华友魈业" }, { tsCode: "688005.SH", name: "容百科技" }, { tsCode: "300073.SZ", name: "当升科技" }] },
      { id: "lb_m7", label: "负极材料（石墨/硜基）", level: 3, stocks: [{ tsCode: "603659.SH", name: "璞泰来" }, { tsCode: "600884.SH", name: "杉杉股份" }, { tsCode: "300890.SZ", name: "翔丰华" }] },
      { id: "lb_m8", label: "电解液", level: 3, stocks: [{ tsCode: "002709.SZ", name: "天赐材料" }, { tsCode: "300037.SZ", name: "新宙邦" }, { tsCode: "605028.SH", name: "石大胜华" }] },
      { id: "lb_m9", label: "隔膜（湿法/干法）", level: 3, stocks: [{ tsCode: "002812.SZ", name: "恩捷股份" }, { tsCode: "300568.SZ", name: "星源材质" }, { tsCode: "002080.SZ", name: "中材科技" }] },
      { id: "lb_m10", label: "结构件/极耳/铝塑膜", level: 3 },
      // level 4：电芯与电池
      { id: "lb_d1", label: "圆柱/方形/软包电芯", level: 4, stocks: [{ tsCode: "300750.SZ", name: "宁德时代" }, { tsCode: "300014.SZ", name: "亿纬锂能" }, { tsCode: "002074.SZ", name: "国轩高科" }] },
      { id: "lb_d2", label: "电池模组/PACK", level: 4 },
      { id: "lb_d3", label: "BMS/电池管理系统", level: 4 },
      { id: "lb_d4", label: "热管理系统", level: 4 },
      // level 5：终端应用
      { id: "lb_app1", label: "动力电池总成", level: 5, stocks: [{ tsCode: "300750.SZ", name: "宁德时代" }, { tsCode: "002594.SZ", name: "比亚迪" }, { tsCode: "300014.SZ", name: "亿纬锂能" }] },
      { id: "lb_app2", label: "储能电池系统", level: 5 },
      { id: "lb_app3", label: "小动力/消费电池", level: 5 },
      // level 6：下游场景
      { id: "lb_end1", label: "新能源整车", level: 6, stocks: [{ tsCode: "002594.SZ", name: "比亚迪" }, { tsCode: "601633.SH", name: "长城汽车" }, { tsCode: "600104.SH", name: "上汽集团" }] },
      { id: "lb_end2", label: "电网/工商业储能", level: 6 },
      { id: "lb_end3", label: "电动工具/两轮车", level: 6 },
    ],
    edges: [
      // 上游 → 基础化学品
      { from: "lb_u1", to: "lb_m1" },
      { from: "lb_u2", to: "lb_m2" },
      { from: "lb_u3", to: "lb_m6" }, // 石墨→负极
      { from: "lb_u3", to: "lb_m7" },
      // 基础化学品 → 前驱体/溶剂
      { from: "lb_m1", to: "lb_m4" },
      { from: "lb_m2", to: "lb_m4" },
      { from: "lb_m1", to: "lb_m8" },
      { from: "lb_m3", to: "lb_m8" },
      { from: "lb_m3", to: "lb_m5" },
      // 前驱体/溶剂 → 核心材料
      { from: "lb_m4", to: "lb_m6" },
      { from: "lb_m5", to: "lb_m8" },
      { from: "lb_m5", to: "lb_m9" },
      { from: "lb_m1", to: "lb_m7" },
      { from: "lb_u3", to: "lb_m7" },
      // 核心材料 → 电芯/电池
      { from: "lb_m6", to: "lb_d1" },
      { from: "lb_m7", to: "lb_d1" },
      { from: "lb_m8", to: "lb_d1" },
      { from: "lb_m9", to: "lb_d1" },
      { from: "lb_m10", to: "lb_d1" },
      { from: "lb_d1", to: "lb_d2" },
      { from: "lb_d2", to: "lb_app1" },
      { from: "lb_d2", to: "lb_app2" },
      { from: "lb_d2", to: "lb_app3" },
      { from: "lb_d3", to: "lb_d2" },
      { from: "lb_d4", to: "lb_d2" },
      // 终端 → 下游
      { from: "lb_app1", to: "lb_end1" },
      { from: "lb_app2", to: "lb_end2" },
      { from: "lb_app3", to: "lb_end3" },
    ],
  },

  // ──────────────────────────────────────
  // 2. 光伏产业链
  // ──────────────────────────────────────
  {
    id: "solar",
    name: "光伏产业链",
    description: "从硅料到光伏电站的完整传导",
    keywords: ["光伏", "多晶硅", "硅片", "电池片", "组件", "逆变器", "TOPCon", "HJT", "钙钛矿", "光伏电站", "EPC", "PERC", "双面组件", "银浆", "清洁能源", "风电", "新能源电站", "可再生能源", "绿电", "光伏风电"],
    nodes: [
      { id: "pv_u1", label: "工业硅", level: 0 },
      { id: "pv_u2", label: "高纯多晶硬（棒状/颗粒硬）", level: 1, stocks: [{ tsCode: "600438.SH", name: "通威股份" }, { tsCode: "688303.SH", name: "大全能源" }, { tsCode: "603260.SH", name: "合盛硬业" }] },
      { id: "pv_m1", label: "单晶硬片（N型/P型）", level: 2, stocks: [{ tsCode: "002129.SZ", name: "TCL中环" }, { tsCode: "601012.SH", name: "隆基绿能" }] },
      { id: "pv_m2", label: "金刚线/切割液", level: 2 },
      { id: "pv_m3", label: "太阳能电池片（PERC/TOPCon/HJT/BC）", level: 3, stocks: [{ tsCode: "600438.SH", name: "通威股份" }, { tsCode: "600732.SH", name: "爱旭股份" }, { tsCode: "002865.SZ", name: "鬧达股份" }] },
      { id: "pv_m4", label: "银浆/靶材/封装胶膜（EVA/POE）", level: 3 },
      { id: "pv_d1", label: "光伏组件/双面组件", level: 4, stocks: [{ tsCode: "601012.SH", name: "隆基绿能" }, { tsCode: "688223.SH", name: "晶科能源" }, { tsCode: "688599.SH", name: "天合光能" }, { tsCode: "002459.SZ", name: "晶澳科技" }] },
      { id: "pv_d2", label: "光伏玻璃/背板", level: 4 },
      { id: "pv_d3", label: "逆变器（组串/集中/微型）", level: 4, stocks: [{ tsCode: "300274.SZ", name: "阳光电源" }, { tsCode: "688390.SH", name: "固德威" }, { tsCode: "300763.SZ", name: "锦浪科技" }, { tsCode: "688032.SH", name: "禾迈股份" }] },
      { id: "pv_d4", label: "支架/跟踪系统", level: 4 },
      { id: "pv_sys1", label: "电站 EPC/BOS", level: 5 },
      { id: "pv_sys2", label: "户用/分布式系统", level: 5 },
      { id: "pv_end1", label: "集中式地面电站", level: 6 },
      { id: "pv_end2", label: "工商业/户用光伏", level: 6 },
      { id: "pv_end3", label: "光伏制氢/储能配套", level: 6 },
    ],
    edges: [
      { from: "pv_u1", to: "pv_u2" },
      { from: "pv_u2", to: "pv_m1" },
      { from: "pv_m1", to: "pv_m3" },
      { from: "pv_m2", to: "pv_m1" },
      { from: "pv_m4", to: "pv_m3" },
      { from: "pv_m3", to: "pv_d1" },
      { from: "pv_d2", to: "pv_d1" },
      { from: "pv_d1", to: "pv_sys1" },
      { from: "pv_d1", to: "pv_sys2" },
      { from: "pv_d3", to: "pv_sys1" },
      { from: "pv_d4", to: "pv_sys1" },
      { from: "pv_sys1", to: "pv_end1" },
      { from: "pv_sys2", to: "pv_end2" },
      { from: "pv_end1", to: "pv_end3" },
    ],
  },

  // ──────────────────────────────────────
  // 3. 半导体产业链
  // ──────────────────────────────────────
  {
    id: "semiconductor",
    name: "半导体产业链",
    description: "从设计工具到终端应用",
    keywords: ["半导体", "芯片", "晶圆", "EDA", "封测", "功率半导体", "光刻机", "刻蚀", "先进封装", "国产替代", "IGBT", "SiC", "存储", "MCU", "FPGA"],
    nodes: [
      { id: "sc_u1", label: "EDA 软件", level: 0 },
      { id: "sc_u2", label: "半导体 IP/架构", level: 0 },
      { id: "sc_u3", label: "硅片/衬底（Si/SiC/GaN）", level: 0 },
      { id: "sc_u4", label: "半导体设备（光刻/刻蚀/沉积/检测）", level: 0, stocks: [{ tsCode: "002371.SZ", name: "北方华创" }, { tsCode: "688012.SH", name: "中微公司" }, { tsCode: "688037.SH", name: "芟源微" }, { tsCode: "688120.SH", name: "华海清科" }] },
      { id: "sc_u5", label: "高纯化学品/光刻胶/特种气体", level: 0, stocks: [{ tsCode: "002409.SZ", name: "雅克科技" }, { tsCode: "688019.SH", name: "安集科技" }, { tsCode: "300236.SZ", name: "上海新阳" }] },
      { id: "sc_m1", label: "IC 设计（数字/模拟/射频）", level: 1, stocks: [{ tsCode: "603501.SH", name: "韦尔股份" }, { tsCode: "688008.SH", name: "濣起科技" }, { tsCode: "688256.SH", name: "寒武纪" }, { tsCode: "300782.SZ", name: "卓胜微" }] },
      { id: "sc_m2", label: "晶圆代工（成熟制程/先进制程）", level: 2, stocks: [{ tsCode: "688981.SH", name: "中芯国际" }, { tsCode: "688347.SH", name: "华虹公司" }] },
      { id: "sc_m3", label: "封测（先进封装/测试）", level: 3, stocks: [{ tsCode: "600584.SH", name: "长电科技" }, { tsCode: "002156.SZ", name: "通富微电" }, { tsCode: "002185.SZ", name: "华天科技" }] },
      { id: "sc_d1", label: "功率半导体（IGBT/MOSFET/SiC）", level: 3, stocks: [{ tsCode: "603290.SH", name: "斯达半导" }, { tsCode: "688187.SH", name: "时代电气" }, { tsCode: "605111.SH", name: "新洁能" }] },
      { id: "sc_d2", label: "存储/模拟/MCU", level: 3 },
      { id: "sc_d3", label: "传感器/CIS/射频前端", level: 3 },
      { id: "sc_app1", label: "消费电子/手机 SoC", level: 4 },
      { id: "sc_app2", label: "汽车电子/工控", level: 4 },
      { id: "sc_app3", label: "AI 芯片/FPGA/算力卡", level: 4 },
    ],
    edges: [
      { from: "sc_u1", to: "sc_m1" },
      { from: "sc_u2", to: "sc_m1" },
      { from: "sc_u3", to: "sc_m2" },
      { from: "sc_u4", to: "sc_m2" },
      { from: "sc_u5", to: "sc_m2" },
      { from: "sc_m1", to: "sc_m2" },
      { from: "sc_m2", to: "sc_m3" },
      { from: "sc_m2", to: "sc_d1" },
      { from: "sc_m2", to: "sc_d2" },
      { from: "sc_m2", to: "sc_d3" },
      { from: "sc_m3", to: "sc_app1" },
      { from: "sc_m3", to: "sc_app2" },
      { from: "sc_d1", to: "sc_app2" },
      { from: "sc_d2", to: "sc_app1" },
      { from: "sc_d3", to: "sc_app1" },
      { from: "sc_app1", to: "sc_app3" }, // 消费电子对AI芯片需求
    ],
  },

  // ──────────────────────────────────────
  // 4. AI 算力链
  // ──────────────────────────────────────
  {
    id: "ai_computing",
    name: "AI 算力链",
    description: "从底层算力到上层云服务",
    keywords: ["AI算力", "GPU", "大模型", "AI服务器", "光模块", "IDC", "数据中心", "云计算", "HBM", "液冷", "推理", "训练", "NPU", "自动驾驶", "机器人"],
    nodes: [
      { id: "ai_u1", label: "AI 训练芯片/GPU/TPU", level: 0, stocks: [{ tsCode: "688256.SH", name: "寒武纪" }, { tsCode: "688041.SH", name: "海光信息" }, { tsCode: "688047.SH", name: "龙芯中科" }] },
      { id: "ai_u2", label: "ASIC/NPU 定制芯片", level: 0 },
      { id: "ai_u3", label: "HBM 内存/先进封装", level: 0 },
      { id: "ai_m1", label: "AI 服务器（整机/液冷）", level: 1, stocks: [{ tsCode: "000977.SZ", name: "浪潮信息" }, { tsCode: "603019.SH", name: "中科曙光" }, { tsCode: "601138.SH", name: "工业富联" }] },
      { id: "ai_m2", label: "光模块（800G/1.6T）/高速连接器", level: 1, stocks: [{ tsCode: "300308.SZ", name: "中际旭创" }, { tsCode: "300394.SZ", name: "天孚通信" }, { tsCode: "300502.SZ", name: "新易盛" }, { tsCode: "000988.SZ", name: "华工科技" }] },
      { id: "ai_m3", label: "交换机/路由器/PCB 背板", level: 1 },
      { id: "ai_d1", label: "数据中心 IDC（AIDC）", level: 2, stocks: [{ tsCode: "300738.SZ", name: "奥飞数据" }, { tsCode: "603881.SH", name: "数据港" }, { tsCode: "300285.SZ", name: "北江金融" }] },
      { id: "ai_d2", label: "算力租赁/GPU Cloud", level: 2 },
      { id: "ai_s1", label: "云计算平台（IaaS/PaaS）", level: 3 },
      { id: "ai_s2", label: "大模型/MLOps 平台", level: 3 },
      { id: "ai_app1", label: "AI 应用（Copilot/Agent/搜索）", level: 4 },
      { id: "ai_app2", label: "自动驾驶/机器人", level: 4 },
    ],
    edges: [
      { from: "ai_u1", to: "ai_m1" },
      { from: "ai_u2", to: "ai_m1" },
      { from: "ai_u3", to: "ai_m1" },
      { from: "ai_m1", to: "ai_d1" },
      { from: "ai_m2", to: "ai_m3" },
      { from: "ai_m2", to: "ai_m1" },
      { from: "ai_m3", to: "ai_d1" },
      { from: "ai_d1", to: "ai_s1" },
      { from: "ai_d2", to: "ai_s1" },
      { from: "ai_s1", to: "ai_s2" },
      { from: "ai_s2", to: "ai_app1" },
      { from: "ai_s2", to: "ai_app2" },
    ],
  },

  // ──────────────────────────────────────
  // 5. 消费电子链
  // ──────────────────────────────────────
  {
    id: "consumer_electronics",
    name: "消费电子链",
    description: "从核心零部件到品牌终端",
    keywords: ["消费电子", "手机", "TWS耳机", "摄像头", "折叠屏", "OLED", "苹果产业链", "PCB", "FPC", "结构件", "ODM", "可穿戴", "XR", "平板", "空调", "家电", "制冷", "白色家电", "冰箱", "压缩机", "家用电器"],
    nodes: [
      { id: "ce_u1", label: "处理器 SoC/AP", level: 0 },
      { id: "ce_u2", label: "存储器（DRAM/NAND）", level: 0 },
      { id: "ce_u3", label: "射频/天线/连接器", level: 0 },
      { id: "ce_u4", label: "图像传感器/镜头模组", level: 0, stocks: [{ tsCode: "603501.SH", name: "韦尔股份" }, { tsCode: "002456.SZ", name: "欧菲光" }, { tsCode: "002036.SZ", name: "联创电子" }] },
      { id: "ce_u5", label: "声学/马达/传感器", level: 0 },
      { id: "ce_m1", label: "显示面板（OLED/LCD）", level: 1, stocks: [{ tsCode: "000725.SZ", name: "京东方A" }, { tsCode: "000100.SZ", name: "TCL科技" }, { tsCode: "002387.SZ", name: "维信诺" }] },
      { id: "ce_m2", label: "玻璃盖板/陶瓷外壳", level: 1 },
      { id: "ce_m3", label: "PCB/柔性电路 FPC", level: 1, stocks: [{ tsCode: "002938.SZ", name: "鹏鼎控股" }, { tsCode: "002384.SZ", name: "东山精密" }, { tsCode: "002600.SZ", name: "领益智造" }] },
      { id: "ce_m4", label: "精密结构件/中框/铰链", level: 1 },
      { id: "ce_d1", label: "整机 ODM/OEM 代工", level: 2, stocks: [{ tsCode: "002475.SZ", name: "立讯精密" }, { tsCode: "002241.SZ", name: "歌尔股份" }, { tsCode: "600745.SH", name: "闻泰科技" }] },
      { id: "ce_d2", label: "品牌整机（手机/PC/平板）", level: 3 },
      { id: "ce_d3", label: "可穿戴设备/TWS/XR", level: 3 },
      { id: "ce_app1", label: "消费电子品牌商", level: 4 },
    ],
    edges: [
      { from: "ce_u1", to: "ce_d1" },
      { from: "ce_u2", to: "ce_d1" },
      { from: "ce_u3", to: "ce_d1" },
      { from: "ce_u4", to: "ce_d1" },
      { from: "ce_u5", to: "ce_d1" },
      { from: "ce_m1", to: "ce_d1" },
      { from: "ce_m2", to: "ce_d1" },
      { from: "ce_m3", to: "ce_d1" },
      { from: "ce_m4", to: "ce_d1" },
      { from: "ce_d1", to: "ce_d2" },
      { from: "ce_d1", to: "ce_d3" },
      { from: "ce_d2", to: "ce_app1" },
      { from: "ce_d3", to: "ce_app1" },
    ],
  },

  // ──────────────────────────────────────
  // 6. 储能产业链
  // ──────────────────────────────────────
  {
    id: "energy_storage",
    name: "储能产业链",
    description: "从电芯材料到储能电站集成",
    keywords: ["储能", "BMS", "PCS", "EMS", "液冷储能", "钠电", "独立储能", "工商业储能", "户用储能", "大储", "储能集成", "磷酸铁锂储能", "电力调峰", "新能源消纳", "清洁能源配储", "峰谷"],
    nodes: [
      { id: "es_u1", label: "正极/负极/电解液（参见锂电）", level: 0 },
      { id: "es_u2", label: "IGBT/MOSFET 功率器件", level: 0 },
      { id: "es_u3", label: "BMS 芯片/主动均衡 IC", level: 0 },
      { id: "es_m1", label: "储能电芯（磷酸铁锂/钒电）", level: 1, stocks: [{ tsCode: "300750.SZ", name: "宁德时代" }, { tsCode: "300014.SZ", name: "亿纬锂能" }, { tsCode: "002594.SZ", name: "比亚迪" }] },
      { id: "es_m2", label: "电池 PACK/模组", level: 2 },
      { id: "es_m3", label: "PCS（储能变流器）", level: 2, stocks: [{ tsCode: "300274.SZ", name: "阳光电源" }, { tsCode: "300827.SZ", name: "上能电气" }, { tsCode: "002335.SZ", name: "科华数据" }] },
      { id: "es_m4", label: "EMS（能量管理系统）", level: 2 },
      { id: "es_m5", label: "温控系统（液冷/风冷）", level: 2 },
      { id: "es_d1", label: "储能系统集成（集装筱/机柜）", level: 3, stocks: [{ tsCode: "300274.SZ", name: "阳光电源" }, { tsCode: "300068.SZ", name: "南都电源" }, { tsCode: "601669.SH", name: "中国电建" }] },
      { id: "es_end1", label: "源网侧储能/独立储能", level: 4 },
      { id: "es_end2", label: "工商业储能/光储充", level: 4 },
      { id: "es_end3", label: "户用储能/便携储能", level: 4 },
    ],
    edges: [
      { from: "es_u1", to: "es_m1" },
      { from: "es_m1", to: "es_m2" },
      { from: "es_u2", to: "es_m3" },
      { from: "es_u3", to: "es_m2" },
      { from: "es_m2", to: "es_d1" },
      { from: "es_m3", to: "es_d1" },
      { from: "es_m4", to: "es_d1" },
      { from: "es_m5", to: "es_d1" },
      { from: "es_d1", to: "es_end1" },
      { from: "es_d1", to: "es_end2" },
      { from: "es_d1", to: "es_end3" },
    ],
  },

  // ──────────────────────────────────────
  // 7. 医药 CXO 链
  // ──────────────────────────────────────
  {
    id: "pharma_cxo",
    name: "医药 CXO 链",
    description: "从基础化工到制剂与医疗器械",
    keywords: ["CRO", "CDMO", "原料药", "中间体", "创新药", "仿制药", "药明康德", "临床前", "工艺开发", "制剂", "医疗器械", "IVD", "生物制剂", "API"],
    nodes: [
      { id: "ph_u1", label: "基础化工/石化原料", level: 0 },
      { id: "ph_u2", label: "中间体/原料药（API）", level: 1, stocks: [{ tsCode: "600521.SH", name: "华海药业" }, { tsCode: "000739.SZ", name: "普洛药业" }, { tsCode: "002256.SZ", name: "仙琺制药" }] },
      { id: "ph_u3", label: "起始物料/高级中间体", level: 1 },
      { id: "ph_m1", label: "CRO（药物发现/临床前）", level: 2, stocks: [{ tsCode: "603259.SH", name: "药明康德" }, { tsCode: "300347.SZ", name: "泰格医药" }, { tsCode: "603127.SH", name: "昭衡新药" }] },
      { id: "ph_m2", label: "CDMO（工艺开发/放大/生产）", level: 2, stocks: [{ tsCode: "603259.SH", name: "药明康德" }, { tsCode: "002821.SZ", name: "凯莱英" }, { tsCode: "300363.SZ", name: "博腾股份" }] },
      { id: "ph_m3", label: "制剂开发（仿制药/创新药）", level: 3 },
      { id: "ph_m4", label: "药用辅料/包材/给药装置", level: 3 },
      { id: "ph_d1", label: "化学制剂/生物制剂", level: 4, stocks: [{ tsCode: "600276.SH", name: "恒瑞医药" }, { tsCode: "600196.SH", name: "复星医药" }, { tsCode: "002294.SZ", name: "信立泰" }] },
      { id: "ph_d2", label: "医疗器械（影像/耗材/IVD）", level: 4 },
      { id: "ph_end1", label: "医药流通/零售", level: 5 },
      { id: "ph_end2", label: "医院/基层医疗", level: 6 },
    ],
    edges: [
      { from: "ph_u1", to: "ph_u2" },
      { from: "ph_u2", to: "ph_u3" },
      { from: "ph_u3", to: "ph_m1" },
      { from: "ph_u3", to: "ph_m2" },
      { from: "ph_m1", to: "ph_m2" },
      { from: "ph_m2", to: "ph_m3" },
      { from: "ph_m4", to: "ph_m3" },
      { from: "ph_m3", to: "ph_d1" },
      { from: "ph_m2", to: "ph_d2" },
      { from: "ph_d1", to: "ph_end1" },
      { from: "ph_d2", to: "ph_end1" },
      { from: "ph_end1", to: "ph_end2" },
    ],
  },

  // ──────────────────────────────────────
  // 8. 军工电子链
  // ──────────────────────────────────────
  {
    id: "military_electronics",
    name: "军工电子链",
    description: "特种基础器件到整机总装",
    keywords: ["军工", "军工电子", "雷达", "导弹", "国防", "航空", "无人机", "特种芯片", "军用传感器", "电子对抗", "火控", "制导", "军费"],
    nodes: [
      { id: "me_u1", label: "特种集成电路/FPGA", level: 0, stocks: [{ tsCode: "002049.SZ", name: "紫光国微" }, { tsCode: "688385.SH", name: "复旦微电" }, { tsCode: "600360.SH", name: "华微电子" }] },
      { id: "me_u2", label: "军用传感器/惯导/MEMS", level: 0 },
      { id: "me_u3", label: "军用连接器/线缆/PCB", level: 0 },
      { id: "me_u4", label: "特种电源/电池", level: 0 },
      { id: "me_m1", label: "嵌入式计算机/单板", level: 1 },
      { id: "me_m2", label: "雷达/电子对抗组件", level: 1, stocks: [{ tsCode: "600990.SH", name: "四创电子" }, { tsCode: "002413.SZ", name: "雷科防务" }] },
      { id: "me_m3", label: "通信模块/数据链", level: 1 },
      { id: "me_m4", label: "红外/光电/光学组件", level: 1 },
      { id: "me_d1", label: "雷达整机/火控系统", level: 2 },
      { id: "me_d2", label: "通信指挥系统", level: 2 },
      { id: "me_d3", label: "导航/制导系统", level: 2 },
      { id: "me_end1", label: "航空整机/无人机", level: 3, stocks: [{ tsCode: "600760.SH", name: "中航沈飞" }, { tsCode: "600038.SH", name: "中直股份" }, { tsCode: "688070.SH", name: "纵横股份" }] },
      { id: "me_end2", label: "导弹/弹药", level: 3, stocks: [{ tsCode: "000768.SZ", name: "中航西飞" }, { tsCode: "600501.SH", name: "航天长峰" }, { tsCode: "000547.SZ", name: "航天发展" }] },
      { id: "me_end3", label: "舰船/战车电子", level: 3 },
    ],
    edges: [
      { from: "me_u1", to: "me_m1" },
      { from: "me_u2", to: "me_m1" },
      { from: "me_u2", to: "me_m2" },
      { from: "me_u3", to: "me_m1" },
      { from: "me_u4", to: "me_m1" },
      { from: "me_m1", to: "me_m2" },
      { from: "me_m1", to: "me_m3" },
      { from: "me_m1", to: "me_m4" },
      { from: "me_m2", to: "me_d1" },
      { from: "me_m3", to: "me_d2" },
      { from: "me_m4", to: "me_d3" },
      { from: "me_d1", to: "me_end1" },
      { from: "me_d1", to: "me_end2" },
      { from: "me_d2", to: "me_end3" },
      { from: "me_d3", to: "me_end2" },
    ],
  },
];

/**
 * 辅助函数：将某条产业链转换为 Mermaid 流程图字符串
 */
export function chainToMermaid(chain: IndustryChain): string {
  const lines: string[] = ["flowchart LR"];

  // 按层级分组节点
  const levelGroups = new Map<number, ChainNode[]>();
  chain.nodes.forEach((n) => {
    const group = levelGroups.get(n.level) || [];
    group.push(n);
    levelGroups.set(n.level, group);
  });

  // 生成节点声明（按层放置于 subgraph）
  for (const [level, nodes] of levelGroups.entries()) {
    lines.push(`  subgraph L${level}["层${level}"]`);
    nodes.forEach((n) => {
      lines.push(`    ${n.id}["${n.label}"]`);
    });
    lines.push(`  end`);
  }

  // 生成连线
  chain.edges.forEach((e) => {
    lines.push(`  ${e.from} --> ${e.to}`);
  });

  return lines.join("\n");
}

/** 向后兼容别名（大写常量形式） */
export const INDUSTRY_CHAINS = industryChains;
