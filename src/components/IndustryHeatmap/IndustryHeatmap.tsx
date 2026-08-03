import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";
import { useAppStore } from "../../store/appStore";
import { isInTradingHours } from "../../utils/tradingHours";

// FR-096/FR-099/FR-100: 自研行业云图（ECharts treemap）
// 两实例架构：L1（行业层）始终挂载，下钻时 visibility:hidden；L2（个股层）下钻时挂载。
// snapshot 60s 更新时两层同时静默刷新，用户在 L2 时感知不到 L1 的重绘。

/** A 股红涨绿跌 7 档配色 */
function colorByChange(change: number): string {
  if (change >= 7) return "#cc0000";
  if (change >= 3) return "#dd3322";
  if (change > 0) return "#aa6655";
  if (change === 0) return "#666666";
  if (change > -3) return "#3a7a4a";
  if (change > -7) return "#1c8a2c";
  return "#008800";
}

/** 万亿/亿/万 格式化 */
function formatMarketCap(yuan: number): string {
  if (yuan >= 1e12) return `${(yuan / 1e12).toFixed(2)} 万亿`;
  if (yuan >= 1e8) return `${(yuan / 1e8).toFixed(2)} 亿`;
  if (yuan >= 1e4) return `${(yuan / 1e4).toFixed(2)} 万`;
  return `${yuan.toFixed(0)}`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "--:--:--";
  }
}

/** 云图代码 (SZ002460) → ts_code 格式 (002460.SZ) */
function toTsCode(code: string): string {
  const m = code.match(/^(SH|SZ|BJ)(\d+)$/i);
  return m ? `${m[2]}.${m[1].toUpperCase()}` : code;
}

/** FR-114: hover 懒加载用的轻量 stock 类型 */
interface HeatmapStockLite {
  code: string;
  name: string;
  price: number;
  change: number;
  marketCap: number;
}

/** FR-113: 绘制规则类型与计算函数 */
type DrawRule = "marketCap" | "absChange" | "gain" | "loss" | "equal";

function computeValue(
  change: number,
  marketCap: number,
  rule: DrawRule,
): number {
  let v: number;
  switch (rule) {
    case "absChange":
      v = Math.abs(change);
      break;
    case "gain":
      v = Math.max(change, 0);
      break;
    case "loss":
      v = Math.max(-change, 0);
      break;
    case "equal":
      v = 1;
      break;
    case "marketCap":
    default:
      v = marketCap;
      break;
  }
  // 兜底：value < 0.01 时补 0.01，避免 echarts 不绘制
  return Number.isFinite(v) && v >= 0.01 ? v : 0.01;
}

/** 公共 tooltip 样式 */
function tooltipBase(isDark: boolean) {
  return {
    backgroundColor: isDark ? "#1f2937" : "#ffffff",
    borderColor: isDark ? "#374151" : "#d1d5db",
    textStyle: { color: isDark ? "#f3f4f6" : "#111827" },
    extraCssText:
      "max-width: 320px; white-space: normal; box-shadow: 0 4px 12px rgba(0,0,0,0.15);",
  };
}

/** 公共节点 label 配置 */
function nodeLabel() {
  return {
    show: true,
    position: "inside" as const,
    formatter: (params: any) => {
      const meta = params.data?._meta;
      if (!meta) return params.name;
      const sign = meta.change >= 0 ? "+" : "";
      return `${params.name}\n${sign}${meta.change.toFixed(2)}%`;
    },
    fontSize: 12,
    color: "#ffffff",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowBlur: 2,
  };
}

export function IndustryHeatmap() {
  const theme = useAppStore((s) => s.theme);
  const navigateToStock = useAppStore((s) => s.navigateToStock);
  const snapshot = useAppStore((s) => s.heatmapSnapshot);
  const loading = useAppStore((s) => s.heatmapLoading);
  const errorMsg = useAppStore((s) => s.heatmapError);
  const fetchHeatmapSnapshot = useAppStore((s) => s.fetchHeatmapSnapshot);
  const industryMomentum = useAppStore((s) => s.industryMomentum);
  const settings = useAppStore((s) => s.settings);
  // FR-115: 从 store 读取当前 active provider + 切换 action
  const provider = useAppStore((s) => s.activeHeatmapProvider);
  const setHeatmapProvider = useAppStore((s) => s.setHeatmapProvider);
  const isDark = theme === "dark";

  const [momentumOpen, setMomentumOpen] = useState(true);
  const [hoveredIndustryName, setHoveredIndustryName] = useState<string | null>(
    null,
  );
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  // FR-112: 延迟关闭定时器，允许鼠标从榜单行平滑移入浮层卡片
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // FR-114: hover 懒加载防抖定时器（≥300ms 停留才发起 IPC）
  const hoverLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // FR-114: 已加载的行业成分股缓存（按行业名）
  const [hoverConstituents, setHoverConstituents] = useState<
    Map<string, HeatmapStockLite[]>
  >(() => new Map());
  // 两实例下钻状态：null = 一级行业层，非 null = 当前下钻的行业名
  const [drilledIndustry, setDrilledIndustry] = useState<string | null>(null);
  // snapshot 刷新时 drilledIndustryData 可能短暂变 null（行业名临时找不到），用 ref 缓存最后一次有效值防止 L2 闪消
  const lastDrilledDataRef = useRef<typeof drilledIndustryData | null>(null);
  // FR-113: 绘制规则（面积权重维度），从 localStorage 恢复
  const [drawRule, setDrawRule] = useState<DrawRule>("marketCap");
  // FR-132: Tushare 申万数据源是否可用（token 已配置且已启用）
  const [tushareReady, setTushareReady] = useState(false);
  // FR-132: Tushare 申万数据源权限不足横幅控制
  const [tushareQuotaError, setTushareQuotaError] = useState(false);
  // FR-132: 检查 Tushare 是否启用 + token 是否配置
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await window.api.datasource.getConfig();
        if (!cancelled) {
          setTushareReady(!!(cfg?.tushareEnabled && cfg?.hasTushareToken));
        }
      } catch {
        if (!cancelled) setTushareReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // FR-132: 监听错误消息，检测 Tushare 权限不足
  useEffect(() => {
    if (provider === 'tushare' && errorMsg) {
      const lower = errorMsg.toLowerCase();
      if (
        lower.includes('权限') ||
        lower.includes('套餐') ||
        lower.includes('积分') ||
        lower.includes('quota') ||
        lower.includes('tushare_quota_insufficient')
      ) {
        setTushareQuotaError(true);
      }
    } else if (provider !== 'tushare') {
      setTushareQuotaError(false);
    }
  }, [errorMsg, provider]);

  // 挂载时从 localStorage 读取上次选择
  useEffect(() => {
    const saved = localStorage.getItem("heatmapDrawRule");
    if (
      saved === "marketCap" ||
      saved === "absChange" ||
      saved === "gain" ||
      saved === "loss" ||
      saved === "equal"
    ) {
      setDrawRule(saved);
    }
  }, []);

  /**
   * FR-114: hover 懒加载行业成分股（带 300ms 防抖）
   * - 鼠标在榜单行 / 浮层卡片对应行业上停留 ≥ 300ms 才发起 IPC
   * - 已缓存（hoverConstituents 命中）则不发请求
   * - 失败静默退化：hover 卡片继续展示 snapshot 占位 stocks
   * - 仅东财数据源会真正发上游请求；新浪由后端路由层从 lastSnapshot 读
   */
  const scheduleLoadConstituents = useCallback(
    (industryName: string, industryCode: string | undefined) => {
      if (hoverLoadTimer.current) {
        clearTimeout(hoverLoadTimer.current);
        hoverLoadTimer.current = null;
      }
      hoverLoadTimer.current = setTimeout(async () => {
        // 用 ref 检查缓存，避免 stale closure 导致缓存命中判断失效
        if (hoverConstituentsRef.current.has(industryName)) return;
        try {
          const resp = await window.api.marketHeatmap.getIndustryConstituents(
            industryCode ?? "",
            industryName,
          );
          // 无论返回数据是否为空，都存入缓存，防止 tooltip 永远显示「正在加载」
          if (resp.ok) {
            setHoverConstituents((prev) => {
              const next = new Map(prev);
              next.set(industryName, resp.data ?? []);
              hoverConstituentsRef.current = next;
              return next;
            });
          }
        } catch {
          // 静默：fallback 到 snapshot 占位 stocks；不存入缓存，允许下次重试
        }
      }, 300);
    },
    // 不再依赖 hoverConstituents state（改用 ref），避免 l1Events 在每次缓存更新时重建
    [],
  );

  const cancelLoadConstituents = useCallback(() => {
    if (hoverLoadTimer.current) {
      clearTimeout(hoverLoadTimer.current);
      hoverLoadTimer.current = null;
    }
  }, []);

  const l1ChartRef = useRef<ReactECharts | null>(null);
  const l2ChartRef = useRef<ReactECharts | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // FR-114: 当前 treemap 上鼠标停留的行业名（用于懒加载完成后复刷 tooltip）
  const treemapHoverNameRef = useRef<string | null>(null);
  // 方案 B：mousemove 节流时间戳，用于 100ms 节流判断
  const treemapMoveThrottleRef = useRef<number>(0);
  // 成分股缓存 ref：供不依赖重渲染的回调直接读取，避免 stale closure
  const hoverConstituentsRef = useRef<Map<string, HeatmapStockLite[]>>(new Map());
  // 当前下钻行业 ref：供 snapshot 刷新 effect 读取（避免 stale closure）
  const drilledIndustryRef = useRef<string | null>(null);

  // FR-114: 懒加载完成后，若鼠标仍停留在该行业 treemap 节点上，复刷 tooltip 让 Top3 立刻显示
  useEffect(() => {
    const hoverName = treemapHoverNameRef.current;
    if (!hoverName) return;
    if (!hoverConstituents.has(hoverName)) return;
    const inst = (l1ChartRef.current as any)?.getEchartsInstance?.();
    if (!inst) return;
    try {
      inst.dispatchAction({ type: "showTip", seriesIndex: 0, name: hoverName });
    } catch {
      /* ignore */
    }
  }, [hoverConstituents]);

  // FR-114/FR-120: 行业名 → 板块代码索引（同时包含 L1 和 L2，供榜单 hover/点击反查 code）
  const nameToCode = useMemo(() => {
    const m = new Map<string, string>();
    snapshot?.industries.forEach((i) => {
      if (i.code) m.set(i.name, i.code);
      for (const sub of i.subIndustries ?? []) {
        if (sub.code) m.set(sub.name, sub.code);
      }
    });
    return m;
  }, [snapshot]);

  // drilledIndustryRef 与 drilledIndustry state 保持同步，供 snapshot 刷新 effect 读取（避免 stale closure）
  useEffect(() => {
    drilledIndustryRef.current = drilledIndustry;
  }, [drilledIndustry]);

  // snapshot 刷新时清空成分股缓存，但保留当前下钻行业的条目，避免 L2 个股层因刷新消失
  useEffect(() => {
    if (!snapshot?.updatedAt) return;
    setHoverConstituents(prev => {
      const drilled = drilledIndustryRef.current;
      const next = new Map<string, HeatmapStockLite[]>();
      if (drilled) {
        const preserved = prev.get(drilled);
        if (preserved) next.set(drilled, preserved);
      }
      hoverConstituentsRef.current = next;
      return next;
    });
  }, [snapshot?.updatedAt]);

  // ResizeObserver：同时 resize 两个实例（L1 在 visibility:hidden 时仍有尺寸）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      (l1ChartRef.current as any)?.getEchartsInstance?.()?.resize();
      (l2ChartRef.current as any)?.getEchartsInstance?.()?.resize();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // 返回一级时触发 L1 resize（从 visibility:hidden 恢复后确保尺寸正确）
  useEffect(() => {
    if (!drilledIndustry) {
      (l1ChartRef.current as any)?.getEchartsInstance?.()?.resize();
    }
  }, [drilledIndustry]);

  // ── Level 1 option：平铺行业，无 children，nodeClick 由 React 层接管 ───────────
  const l1Option = useMemo<EChartsOption>(() => {
    if (!snapshot) return {};
    const borderColor = isDark ? "#1f2937" : "#e5e7eb";

    const data = snapshot.industries.map((ind) => {
      const momentumDelta = industryMomentum[ind.name];
      const lazy = hoverConstituents.get(ind.name);
      const sourceStocks = lazy ?? ind.stocks;
      // FR-119: 子行业 children（仅东财 provider 填充 subIndustries）
      const subChildren = (ind.subIndustries ?? []).map((sub) => ({
        name: sub.name,
        value: computeValue(sub.change, sub.marketCap, drawRule),
        itemStyle: { color: colorByChange(sub.change) },
        // FR-119: L2 自身的 label override，两行显示「名\n±X.XX%」
        label: {
          show: true,
          position: "inside" as const,
          align: "center" as const,
          verticalAlign: "middle" as const,
          color: "#ffffff",
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 13,
          overflow: "truncate" as const,
          formatter: `${sub.name}\n${sub.change >= 0 ? "+" : ""}${sub.change.toFixed(2)}%`,
        },
        _meta: {
          type: "subIndustry" as const,
          code: sub.code,
          name: sub.name,
          change: sub.change,
          marketCap: sub.marketCap,
        },
      }));
      const l1Color = colorByChange(ind.weightedChange);
      const l1Sign = ind.weightedChange >= 0 ? "+" : "";
      return {
        name: ind.name,
        value: computeValue(ind.weightedChange, ind.totalMarketCap, drawRule),
        itemStyle: { color: l1Color },
        children: subChildren.length > 0 ? subChildren : undefined,
        // 无子行业时（如 Tushare provider 中 综合 等）：用显式 label 在块内显示名称+涨跌幅
        label:
          subChildren.length === 0
            ? {
                show: true,
                color: "#ffffff",
                fontSize: 13,
                fontWeight: "bold" as const,
                lineHeight: 18,
                overflow: "truncate" as const,
                formatter: `${ind.name}  ${l1Sign}${ind.weightedChange.toFixed(2)}%`,
              }
            : undefined,
        // FR-119: L1 顶部条颜色按涨跌色着色，显示「行业 ±X.XX%」（有子行业时生效）
        upperLabel: {
          show: subChildren.length > 0,
          height: 22,
          color: "#ffffff",
          fontSize: 12,
          fontWeight: "bold" as const,
          backgroundColor: l1Color,
          padding: [2, 6, 2, 6],
          formatter: `${ind.name}  ${l1Sign}${ind.weightedChange.toFixed(2)}%`,
        },
        _meta: {
          type: "industry" as const,
          code: ind.code,
          change: ind.weightedChange,
          totalMarketCap: ind.totalMarketCap,
          stockCount: ind.stocks.length,
          momentumDelta,
          subIndustries: ind.subIndustries ?? [],
          topGainers: [...sourceStocks]
            .sort((a, b) => b.change - a.change)
            .slice(0, 3),
          topLosers: [...sourceStocks]
            .sort((a, b) => a.change - b.change)
            .slice(0, 3),
          isLazyLoaded: !!lazy,
        },
      };
    });

    return {
      tooltip: {
        ...tooltipBase(isDark),
        formatter: (params: any) => {
          const meta = params.data?._meta;
          if (!meta) return params.name;

          const sign = meta.change >= 0 ? "+" : "";
          const fmtRow = (s: {
            name: string;
            code: string;
            change: number;
          }) => {
            const sg = s.change >= 0 ? "+" : "";
            return `<div style="display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:1.6;">
              <span style="color:${isDark ? "#d1d5db" : "#374151"}">${s.name}</span>
              <span style="color:${colorByChange(s.change)};font-weight:600">${sg}${s.change.toFixed(2)}%</span>
            </div>`;
          };
          const sectionTitle = (txt: string, color: string) =>
            `<div style="margin-top:6px;font-size:11px;color:${color};font-weight:600">${txt}</div>`;

          // FR-119: L2 子行业 tooltip —— 显示该 L2 自己的领涨/领跌（来自懒加载缓存）
          if (meta.type === "subIndustry") {
            const subStocks = hoverConstituents.get(meta.name) ?? [];
            // L2 子行业 领涨/领跌：有个股涨跌数据时展示个股，否则静默隐藏分区
            const subGainers = subStocks.some(s => s.change > 0)
              ? [...subStocks].sort((a, b) => b.change - a.change).filter((s) => s.change > 0).slice(0, 3).map(fmtRow).join("")
              : "";
            const subLosers = subStocks.some(s => s.change < 0)
              ? [...subStocks].sort((a, b) => a.change - b.change).filter((s) => s.change < 0).slice(0, 3).map(fmtRow).join("")
              : "";
            // 未命中缓存（undefined）表示请求中；命中但为空数组表示无数据
            const subIsLoading = !hoverConstituents.has(meta.name);
            const subLoadingHint = subIsLoading
              ? `<div style="margin-top:6px;color:#9ca3af;font-size:11px">正在加载成分股…</div>`
              : "";
            return [
              `<div style="font-weight:600;font-size:13px;margin-bottom:4px">${params.name} <span style="color:#9ca3af;font-weight:400;font-size:11px">子行业</span></div>`,
              `<div style="font-size:12px;line-height:1.6">涨跌幅：<b style="color:${colorByChange(meta.change)}">${sign}${meta.change.toFixed(2)}%</b></div>`,
              `<div style="font-size:12px;line-height:1.6">市值：${formatMarketCap(meta.marketCap)}</div>`,
              subStocks.length > 0
                ? `<div style="font-size:12px;line-height:1.6">成分股：${subStocks.length} 只</div>`
                : "",
              subGainers ? sectionTitle("领涨", "#cc0000") + subGainers : "",
              subLosers ? sectionTitle("领跌", "#1c8a2c") + subLosers : "",
              subLoadingHint,
              `<div style="margin-top:6px;color:#9ca3af;font-size:11px">点击下钻查看全部成分股</div>`,
            ]
              .filter(Boolean)
              .join("");
          }

          // L1 行业 tooltip
          const gainers = (meta.topGainers ?? [])
            .filter((s: any) => s.change > 0)
            .map(fmtRow)
            .join("");
          const losers = (meta.topLosers ?? [])
            .filter((s: any) => s.change < 0)
            .map(fmtRow)
            .join("");

          // 无个股涨跌数据时（Tushare 模式），降级展示子行业领涨/领跌
          const fmtSubRow = (s: { name: string; change: number }) => {
            const sg = s.change >= 0 ? "+" : "";
            return `<div style="display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:1.6;">
              <span style="color:${isDark ? "#d1d5db" : "#374151"}">${s.name}</span>
              <span style="color:${colorByChange(s.change)};font-weight:600">${sg}${s.change.toFixed(2)}%</span>
            </div>`;
          };
          const subIndustriesData: Array<{ name: string; change: number }> = meta.subIndustries ?? [];
          const subGainersL1 = !gainers && !losers && subIndustriesData.length > 0
            ? [...subIndustriesData].sort((a, b) => b.change - a.change).filter(s => s.change > 0).slice(0, 3).map(fmtSubRow).join("")
            : "";
          const subLosersL1 = !gainers && !losers && subIndustriesData.length > 0
            ? [...subIndustriesData].sort((a, b) => a.change - b.change).filter(s => s.change < 0).slice(0, 3).map(fmtSubRow).join("")
            : "";

          const momentumLine =
            meta.momentumDelta !== undefined
              ? `<div style="font-size:12px;line-height:1.6;margin-top:4px">${settings?.momentumWindowMinutes ?? 3}min 变化：<b style="color:${colorByChange(meta.momentumDelta)}">${meta.momentumDelta >= 0 ? "+" : ""}${meta.momentumDelta.toFixed(2)}%</b></div>`
              : "";
          const loadingHint =
            !meta.isLazyLoaded && (meta.topGainers?.length ?? 0) <= 1
              ? `<div style="margin-top:6px;color:#9ca3af;font-size:11px">正在加载成分股…</div>`
              : "";
          return [
            `<div style="font-weight:600;font-size:13px;margin-bottom:4px">${params.name}</div>`,
            `<div style="font-size:12px;line-height:1.6">加权涨跌幅：<b style="color:${colorByChange(meta.change)}">${sign}${meta.change.toFixed(2)}%</b></div>`,
            momentumLine,
            `<div style="font-size:12px;line-height:1.6">总市值：${formatMarketCap(meta.totalMarketCap)}</div>`,
            meta.stockCount > 0 ? `<div style="font-size:12px;line-height:1.6">成分股：${meta.stockCount} 只</div>` : "",
            gainers ? sectionTitle("领涨", "#cc0000") + gainers : "",
            losers ? sectionTitle("领跌", "#1c8a2c") + losers : "",
            subGainersL1 ? sectionTitle("子行业领涨", "#cc0000") + subGainersL1 : "",
            subLosersL1 ? sectionTitle("子行业领跌", "#1c8a2c") + subLosersL1 : "",
            loadingHint,
            `<div style="margin-top:6px;color:#9ca3af;font-size:11px">点击下钻查看全部成分股</div>`,
          ]
            .filter(Boolean)
            .join("");
        },
      },
      series: [
        {
          name: "A股全图",
          type: "treemap",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          roam: false,
          nodeClick: false,
          animationDuration: 400,
          animationDurationUpdate: 300,
          animationEasing: "cubicInOut" as const,
          animationEasingUpdate: "cubicInOut" as const,
          drillDownIcon: "",
          breadcrumb: { show: false },
          // FR-119: leafDepth=2 让 treemap 自动渲染 L1+L2 两层嵌套
          leafDepth: 2,
          // 不同层级独立配置 label/itemStyle（个性化样式由 data 项 override）
          levels: [
            // L1（行业）
            {
              itemStyle: { borderWidth: 2, borderColor, gapWidth: 2 },
              label: {
                align: "center" as const,
                verticalAlign: "middle" as const,
              },
            },
            // L2层（子行业）
            {
              itemStyle: { borderWidth: 1, borderColor, gapWidth: 1 },
              label: {
                show: true,
                align: "center" as const,
                verticalAlign: "middle" as const,
                color: "#ffffff",
                fontSize: 11,
                fontWeight: 600 as const,
                lineHeight: 16,
              },
            },
          ],
          itemStyle: { borderColor, borderWidth: 1, gapWidth: 1 },
          data,
        },
      ],
    };
  }, [snapshot, isDark, industryMomentum, settings, drawRule, hoverConstituents]);

  // 当前下钻行业的最新数据（始终跟随 snapshot 更新，60s 刷新无感知）
  // FR-119: 兼容 L2 下钻 —— 先在 industries 数组找 L1，找不到则在 subIndustries 里找 L2 并包装为伪 industry
  const drilledIndustryData = useMemo(() => {
    if (!drilledIndustry) { lastDrilledDataRef.current = null; return null; }
    let found: NonNullable<typeof snapshot>['industries'][number] | null = null;
    if (snapshot) {
      found = snapshot.industries.find((i) => i.name === drilledIndustry) ?? null;
      if (!found) {
        // L2 兜底：遍历所有 L1 的 subIndustries 找名字匹配
        for (const ind of snapshot.industries) {
          const sub = ind.subIndustries?.find((s) => s.name === drilledIndustry);
          if (sub) {
            found = {
              name: sub.name,
              code: sub.code,
              totalMarketCap: sub.marketCap,
              weightedChange: sub.change,
              stocks: [], // L2 时成分股由 hoverConstituents 提供
            } as typeof ind;
            break;
          }
        }
      }
    }
    // snapshot 刷新期间临时找不到时，fallback 到上次有效值，避免 L2 因 snapshot 更新而意外消失
    if (found !== null) lastDrilledDataRef.current = found;
    return lastDrilledDataRef.current ?? null;
  }, [snapshot, drilledIndustry]);

  // ── Level 2 option：平铺个股 ─────────────────────────────────────────────────
  const l2Option = useMemo<EChartsOption>(() => {
    if (!drilledIndustryData) return {};
    const borderColor = isDark ? "#1f2937" : "#e5e7eb";

    // FR-116: 优先用懒加载的全量成分股，fallback 到 snapshot 原始 stocks（东财主拉仅 1 只占位）
    const stockSource =
      (drilledIndustry ? hoverConstituents.get(drilledIndustry) : null) ??
      drilledIndustryData.stocks;

    const data = stockSource.map((s) => ({
      name: s.name,
      value: computeValue(s.change, s.marketCap, drawRule),
      itemStyle: { color: colorByChange(s.change) },
      _meta: {
        type: "stock" as const,
        code: s.code,
        name: s.name,
        price: s.price,
        change: s.change,
        marketCap: s.marketCap,
      },
    }));

    return {
      tooltip: {
        ...tooltipBase(isDark),
        formatter: (params: any) => {
          const meta = params.data?._meta;
          if (!meta) return params.name;
          const sign = meta.change >= 0 ? "+" : "";
          return [
            `<div style="font-weight:600;font-size:13px;margin-bottom:4px">${params.name} <span style="color:#9ca3af;font-weight:400">${meta.code}</span></div>`,
            `<div style="font-size:12px;line-height:1.6">现价：${meta.price.toFixed(2)}</div>`,
            `<div style="font-size:12px;line-height:1.6">涨跌幅：<b style="color:${colorByChange(meta.change)}">${sign}${meta.change.toFixed(2)}%</b></div>`,
            `<div style="font-size:12px;line-height:1.6">总市值：${formatMarketCap(meta.marketCap)}</div>`,
            `<div style="margin-top:6px;color:#9ca3af;font-size:11px">点击跳转走势图</div>`,
          ].join("");
        },
      },
      series: [
        {
          name: drilledIndustryData.name,
          type: "treemap",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          roam: false,
          nodeClick: false,
          animationDuration: 400,
          animationDurationUpdate: 300,
          animationEasing: "cubicInOut" as const,
          animationEasingUpdate: "cubicInOut" as const,
          breadcrumb: { show: false },
          label: nodeLabel(),
          itemStyle: { borderColor, borderWidth: 1, gapWidth: 1 },
          levels: [{ itemStyle: { borderWidth: 2, borderColor, gapWidth: 2 } }],
          data,
        },
      ],
    };
  }, [drilledIndustryData, isDark, drawRule, hoverConstituents, drilledIndustry]);

  // L1 事件：点击行业 → React 层接管下钻；hover → 懒加载该板块成分股（FR-114）
  // 方案 B：用 mousemove 100ms 节流 + 比较 name 变化替代 mouseover/mouseout，彻底规避 border/gap 抖动
  const l1Events = useMemo(
    () => ({
      click: (params: any) => {
        const meta = params?.data?._meta;
        if (meta?.type === "industry" || meta?.type === "subIndustry") {
          // FR-119: L1 行业 / L2 子行业 点击都触发下钻到对应成分股
          const targetName = params.name;
          const targetCode = meta.code ?? "";
          setDrilledIndustry(targetName);
          // FR-116: 点击时立即触发无防抖加载（不等 300ms），确保 L2 层能拿到全量成分股
          if (!hoverConstituentsRef.current.has(targetName)) {
            void (async () => {
              try {
                const resp =
                  await window.api.marketHeatmap.getIndustryConstituents(
                    targetCode,
                    targetName,
                  );
                if (resp.ok && resp.data.length > 0) {
                  setHoverConstituents((prev) => {
                    const next = new Map(prev);
                    next.set(targetName, resp.data);
                    hoverConstituentsRef.current = next;
                    return next;
                  });
                }
              } catch {
                // 懒加载失败静默退化，保留 snapshot 占位数据
              }
            })();
          }
        }
      },
      mousemove: (params: any) => {
        const now = Date.now();
        // 100ms 节流：丢弃高频 mousemove
        if (now - treemapMoveThrottleRef.current < 100) return;
        treemapMoveThrottleRef.current = now;

        const meta = params?.data?._meta;
        // FR-119: L1 行业 / L2 子行业 都触发懒加载
        if (meta?.type !== "industry" && meta?.type !== "subIndustry") {
          // 移到空白/border 区域，视为离开
          if (treemapHoverNameRef.current !== null) {
            treemapHoverNameRef.current = null;
            cancelLoadConstituents();
          }
          return;
        }
        // 行业未变化：什么都不做（schedule 继续倒计时）
        if (treemapHoverNameRef.current === params.name) return;
        // 切换到新行业/子行业：更新 ref，重启 schedule
        treemapHoverNameRef.current = params.name;
        scheduleLoadConstituents(params.name, meta.code);
      },
    }),
    // 不再依赖 hoverConstituents state（改用 hoverConstituentsRef），避免频繁重建
    [scheduleLoadConstituents, cancelLoadConstituents],
  );

  // L2 事件：点击个股 → 跳转走势图
  const l2Events = useMemo(
    () => ({
      click: (params: any) => {
        const meta = params?.data?._meta;
        if (meta?.type === "stock" && meta.code) {
          navigateToStock(toTsCode(meta.code), meta.name ?? params?.name);
        }
      },
    }),
    [navigateToStock],
  );

  const trading = isInTradingHours();
  const lastUpdate = snapshot ? formatTime(snapshot.updatedAt) : "--:--:--";

  // FR-100: 动量榜单数据
  const momentumEntries = Object.entries(industryMomentum);
  const hasMomentum = momentumEntries.length > 0;
  const topMomentumGainers = momentumEntries
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topMomentumLosers = momentumEntries
    .filter(([, d]) => d < 0)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 5);

  // FR-101/FR-120: 今日涨跌幅榜单 —— 东财优先用 L2 子行业，新浪 fallback 到 L1
  const subList = (snapshot?.industries ?? []).flatMap((i) =>
    (i.subIndustries ?? []).map((s) => ({
      name: s.name,
      code: s.code,
      change: s.change,
    })),
  );
  const displayList = subList.length > 0
    ? subList
    : (snapshot?.industries ?? []).map((i) => ({
        name: i.name,
        code: i.code,
        change: i.weightedChange,
      }));
  const todayGainers = [...displayList]
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);
  const todayLosers = [...displayList]
    .sort((a, b) => a.change - b.change)
    .slice(0, 5);
  const hasTodayData = displayList.length > 0;

  const momentumN = settings?.momentumWindowMinutes ?? 3;

  return (
    <div
      className="flex flex-col flex-1 w-full h-full bg-white dark:bg-gray-900"
      onMouseLeave={() => {
        // 鼠标离开整个组件区域时立即关闭 hover 卡片
        // 卡片是本 div 的直接子元素，鼠标在卡片上时本事件不会触发（鼠标在子元素上）
        if (hoverCloseTimer.current) {
          clearTimeout(hoverCloseTimer.current);
          hoverCloseTimer.current = null;
        }
        setHoveredIndustryName(null);
        setHoverPos(null);
        cancelLoadConstituents();
      }}
    >
      {/* 顶部工具栏 */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-200 dark:border-gray-700 text-sm flex-shrink-0">
        <div className="font-medium text-gray-900 dark:text-gray-100">
          行业云图
        </div>
        <div className="text-gray-500 dark:text-gray-400">
          最后更新：{lastUpdate}
        </div>
        <div className="text-gray-500 dark:text-gray-400">
          {trading ? "自动刷新：盘中" : "自动刷新：已暂停"}
        </div>
        <div className="flex-1" />
        {loading && snapshot !== null && (
          <span className="inline-block w-3.5 h-3.5 border-2 border-gray-300 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin" />
        )}
        {/* FR-113: 绘制规则下拉 */}
        <select
          value={drawRule}
          onChange={(e) => {
            const val = e.target.value as DrawRule;
            setDrawRule(val);
            localStorage.setItem("heatmapDrawRule", val);
            // 切换绘制规则触发 treemap 重排，立即关闭 hover 卡片避免悬浮在错误位置
            setHoveredIndustryName(null);
          }}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-0.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
          title="选择 treemap 面积权重维度"
        >
          <option value="marketCap">市值/成交额</option>
          <option value="absChange">涨跌幅强度</option>
          <option value="gain">上涨强度</option>
          <option value="loss">下跌强度</option>
          <option value="equal">等权</option>
        </select>
        <select
          value={provider}
          onChange={(e) => {
            const val = e.target.value as "sina" | "eastmoney" | "tushare";
            // FR-115: store action 内部完成持久化 + 瞬间切换 + 后台静默拉新
            void setHeatmapProvider(val);
          }}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-0.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
        >
          <option value="sina">新浪财经</option>
          <option value="eastmoney">东方财富</option>
          <option value="tushare" disabled={!tushareReady}>Tushare 申万</option>
        </select>
        <button
          type="button"
          onClick={() => fetchHeatmapSnapshot()}
          disabled={loading}
          className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 text-gray-700 dark:text-gray-200"
        >
          {loading && snapshot === null ? "刷新中…" : "手动刷新"}
        </button>
      </div>

      {/* FR-111: 面包屑导航栏始终占位，切换时布局不跳动 */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm flex-shrink-0">
        {drilledIndustry ? (
          <>
            <button
              type="button"
              onClick={() => setDrilledIndustry(null)}
              className="flex items-center gap-1 text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
            >
              ← 行业总览
            </button>
            <span className="text-gray-400 dark:text-gray-500">/</span>
            <span className="font-medium text-gray-800 dark:text-gray-200">
              {drilledIndustry}
            </span>
            {drilledIndustryData && (
              <span className="text-gray-400 dark:text-gray-500 text-xs">
                共 {(hoverConstituents.get(drilledIndustry) ?? drilledIndustryData.stocks).length} 只个股
              </span>
            )}
          </>
        ) : (
          <span className="text-gray-400 dark:text-gray-500">
            行业总览
            {snapshot && (
              <span className="ml-1 text-xs font-normal">
                （{snapshot.industries.length} 个行业）
              </span>
            )}
          </span>
        )}
      </div>

      {/* 错误横幅 */}
      {errorMsg && (
        <div className="flex items-center justify-between px-4 py-2 bg-red-50 dark:bg-red-900/30 border-b border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300 flex-shrink-0">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => fetchHeatmapSnapshot()}
            className="ml-4 px-2 py-0.5 text-xs border border-red-300 dark:border-red-700 rounded hover:bg-red-100 dark:hover:bg-red-900/50"
          >
            重试
          </button>
        </div>
      )}

      {/* FR-132: Tushare 申万实时行情权限不足提示横幅 */}
      {tushareQuotaError && provider === 'tushare' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-yellow-50 dark:bg-yellow-900/30 border-b border-yellow-200 dark:border-yellow-700 text-sm text-yellow-800 dark:text-yellow-300 flex-shrink-0">
          <span>⚠️</span>
          <span>申万实时行情权限不足，请在 Tushare Pro 开通「申万实时行情」月度订阅（200元/月）后再使用此数据源。</span>
          <button
            type="button"
            onClick={() => setTushareQuotaError(false)}
            className="ml-auto text-yellow-600 dark:text-yellow-400 hover:text-yellow-800 dark:hover:text-yellow-200 text-xs"
          >
            关闭
          </button>
        </div>
      )}

      {/* 主体区域：双层 Treemap + 动量侧边榜单 */}
      <div className="flex flex-1 min-h-0">
        {/* 图表区：L1 始终挂载，L2 下钻时挂载 */}
        <div ref={containerRef} className="flex-1 min-w-0 relative">
          {/* ── L1 行业层：始终在 DOM，下钻时 visibility:hidden 静默刷新 ── */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              visibility: drilledIndustry ? "hidden" : "visible",
              pointerEvents: drilledIndustry ? "none" : "auto",
            }}
          >
            {snapshot && snapshot.industries.length > 0 ? (
              <ReactECharts
                ref={l1ChartRef}
                option={l1Option}
                style={{ width: "100%", height: "100%" }}
                opts={{ renderer: "canvas" }}
                onEvents={l1Events}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500 text-sm">
                {loading
                  ? "加载中…"
                  : errorMsg
                    ? "加载失败，请重试"
                    : "暂无数据"}
              </div>
            )}
          </div>

          {/* ── L2 个股层：下钻时挂载，snapshot 更新时同步刷新 ── */}
          {drilledIndustry && drilledIndustryData && (
            <div style={{ position: "absolute", inset: 0 }}>
              <ReactECharts
                ref={l2ChartRef}
                option={l2Option}
                style={{ width: "100%", height: "100%" }}
                opts={{ renderer: "canvas" }}
                onEvents={l2Events}
              />
            </div>
          )}
        </div>

        {/* FR-100/FR-101: 动量侧边榜单（方案 B：上半今日涨跌幅 + 下半动量） */}
        <div className="flex flex-shrink-0">
          {/* 收起/展开手柄 */}
          <button
            type="button"
            onClick={() => setMomentumOpen((v) => !v)}
            className="flex items-center justify-center w-4 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 border-l border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 text-xs transition-colors"
            title={momentumOpen ? "收起榜单" : "展开榜单"}
          >
            {momentumOpen ? "‹" : "›"}
          </button>

          {/* 榜单内容 */}
          {momentumOpen && (
            <div
              className="w-44 flex flex-col border-l border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-hidden"
              onMouseLeave={() => {
                // 鼠标离开整个侧边榜单容器时，启动 150ms 关闭计时
                // 若鼠标移向 hover 卡片（position:fixed），卡片的 onMouseEnter 会取消此计时
                cancelLoadConstituents();
                if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
                hoverCloseTimer.current = setTimeout(() => {
                  setHoveredIndustryName(null);
                  setHoverPos(null);
                }, 150);
              }}
            >
              {/* ── 上半区：今日涨跌幅 ── */}
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                今日涨跌幅
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {!hasTodayData ? (
                  <div className="px-3 py-3 text-xs text-gray-400 dark:text-gray-500">
                    等待数据…
                  </div>
                ) : (
                  <>
                    {todayGainers.length > 0 && (
                      <div>
                        <div className="px-3 py-0.5 text-xs text-red-500 font-semibold">
                          ↑ 涨幅 Top5
                        </div>
                        {todayGainers.map((ind) => (
                          <div
                            key={ind.name}
                            className="flex items-center justify-between px-3 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
                            onClick={() => setDrilledIndustry(ind.name)}
                            onMouseEnter={(e) => {
                              if (hoverCloseTimer.current) {
                                clearTimeout(hoverCloseTimer.current);
                                hoverCloseTimer.current = null;
                              }
                              setHoveredIndustryName(ind.name);
                              setHoverPos({ x: e.clientX, y: e.clientY });
                              scheduleLoadConstituents(ind.name, ind.code);
                            }}
                            onMouseLeave={() => {
                              cancelLoadConstituents();
                              hoverCloseTimer.current = setTimeout(() => {
                                setHoveredIndustryName(null);
                                setHoverPos(null);
                              }, 150);
                            }}
                          >
                            <span
                              className="text-xs text-gray-700 dark:text-gray-300 truncate max-w-[76px]"
                              title={ind.name}
                            >
                              {ind.name}
                            </span>
                            <span className="text-xs font-medium text-red-600 dark:text-red-400 ml-1 flex-shrink-0">
                              {ind.change >= 0 ? "+" : ""}
                              {ind.change.toFixed(2)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {todayLosers.length > 0 && (
                      <div className="mt-0.5">
                        <div className="px-3 py-0.5 text-xs text-green-600 dark:text-green-500 font-semibold">
                          ↓ 跌幅 Top5
                        </div>
                        {todayLosers.map((ind) => (
                          <div
                            key={ind.name}
                            className="flex items-center justify-between px-3 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
                            onClick={() => setDrilledIndustry(ind.name)}
                            onMouseEnter={(e) => {
                              if (hoverCloseTimer.current) {
                                clearTimeout(hoverCloseTimer.current);
                                hoverCloseTimer.current = null;
                              }
                              setHoveredIndustryName(ind.name);
                              setHoverPos({ x: e.clientX, y: e.clientY });
                              scheduleLoadConstituents(ind.name, ind.code);
                            }}
                            onMouseLeave={() => {
                              cancelLoadConstituents();
                              hoverCloseTimer.current = setTimeout(() => {
                                setHoveredIndustryName(null);
                                setHoverPos(null);
                              }, 150);
                            }}
                          >
                            <span
                              className="text-xs text-gray-700 dark:text-gray-300 truncate max-w-[76px]"
                              title={ind.name}
                            >
                              {ind.name}
                            </span>
                            <span className="text-xs font-medium text-green-700 dark:text-green-500 ml-1 flex-shrink-0">
                              {ind.change.toFixed(2)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* ── 分割线 ── */}
              <div className="border-t border-gray-300 dark:border-gray-600 flex-shrink-0" />

              {/* ── 下半区：N 分钟动量 ── */}
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                {momentumN}min 动量
              </div>
              <div className="flex-1 overflow-y-auto">
                {!hasMomentum ? (
                  <div className="px-3 py-3 text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
                    数据积累中，约 {momentumN} 分钟后显示动量
                  </div>
                ) : (
                  <>
                    {topMomentumGainers.length > 0 && (
                      <div>
                        <div className="px-3 py-0.5 text-xs text-red-500 font-semibold">
                          ↑ 涨速最快
                        </div>
                        {topMomentumGainers.map(([name, delta]) => (
                          <div
                            key={name}
                            className="flex items-center justify-between px-3 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
                            onClick={() => setDrilledIndustry(name)}
                            onMouseEnter={(e) => {
                              if (hoverCloseTimer.current) {
                                clearTimeout(hoverCloseTimer.current);
                                hoverCloseTimer.current = null;
                              }
                              setHoveredIndustryName(name);
                              setHoverPos({ x: e.clientX, y: e.clientY });
                              scheduleLoadConstituents(
                                name,
                                nameToCode.get(name),
                              );
                            }}
                            onMouseLeave={() => {
                              cancelLoadConstituents();
                              hoverCloseTimer.current = setTimeout(() => {
                                setHoveredIndustryName(null);
                                setHoverPos(null);
                              }, 150);
                            }}
                          >
                            <span
                              className="text-xs text-gray-700 dark:text-gray-300 truncate max-w-[76px]"
                              title={name}
                            >
                              {name}
                            </span>
                            <span className="text-xs font-medium text-red-600 dark:text-red-400 ml-1 flex-shrink-0">
                              +{delta.toFixed(2)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {topMomentumLosers.length > 0 && (
                      <div className="mt-0.5">
                        <div className="px-3 py-0.5 text-xs text-green-600 dark:text-green-500 font-semibold">
                          ↓ 跌速最快
                        </div>
                        {topMomentumLosers.map(([name, delta]) => (
                          <div
                            key={name}
                            className="flex items-center justify-between px-3 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer"
                            onClick={() => setDrilledIndustry(name)}
                            onMouseEnter={(e) => {
                              if (hoverCloseTimer.current) {
                                clearTimeout(hoverCloseTimer.current);
                                hoverCloseTimer.current = null;
                              }
                              setHoveredIndustryName(name);
                              setHoverPos({ x: e.clientX, y: e.clientY });
                              scheduleLoadConstituents(
                                name,
                                nameToCode.get(name),
                              );
                            }}
                            onMouseLeave={() => {
                              cancelLoadConstituents();
                              hoverCloseTimer.current = setTimeout(() => {
                                setHoveredIndustryName(null);
                                setHoverPos(null);
                              }, 150);
                            }}
                          >
                            <span
                              className="text-xs text-gray-700 dark:text-gray-300 truncate max-w-[76px]"
                              title={name}
                            >
                              {name}
                            </span>
                            <span className="text-xs font-medium text-green-700 dark:text-green-500 ml-1 flex-shrink-0">
                              {delta.toFixed(2)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* FR-103/FR-114: 行业 hover 详情浮层（优先用懒加载的完整成分股 Top3 涨/跌） */}
      {hoveredIndustryName &&
        hoverPos &&
        (() => {
          const PANEL_W = 224;
          // FR-120: 先找 L1，找不到再遍历 L2 子行业；统一为 { name, change, marketCap, stocks } 视图
          type IndView = { name: string; change: number; marketCap: number; stocks: any[] };
          let ind: IndView | null = null;
          const l1 = snapshot?.industries.find((i) => i.name === hoveredIndustryName);
          if (l1) {
            ind = { name: l1.name, change: l1.weightedChange, marketCap: l1.totalMarketCap, stocks: l1.stocks };
          } else {
            for (const i of snapshot?.industries ?? []) {
              const sub = (i.subIndustries ?? []).find((s) => s.name === hoveredIndustryName);
              if (sub) {
                ind = { name: sub.name, change: sub.change, marketCap: sub.marketCap, stocks: [] };
                break;
              }
            }
          }
          if (!ind) return null;
          // 优先用懒加载结果（含全量成分股），否则 fallback 到 snapshot 占位 stocks（L2 hover 时为空数组，等懒加载）
          const sourceStocks =
            hoverConstituents.get(hoveredIndustryName) ?? ind.stocks;
          const gainers = [...sourceStocks]
            .filter((s) => s.change > 0)
            .sort((a, b) => b.change - a.change)
            .slice(0, 3);
          const losers = [...sourceStocks]
            .filter((s) => s.change < 0)
            .sort((a, b) => a.change - b.change)
            .slice(0, 3);
          const isLoadingConstituents =
            !hoverConstituents.has(hoveredIndustryName) &&
            (ind.stocks?.length ?? 0) <= 1;
          const leftX = hoverPos.x - PANEL_W - 12;
          const panelLeft = leftX > 0 ? leftX : hoverPos.x + 12;
          const panelTop = Math.min(hoverPos.y - 8, window.innerHeight - 280);
          const fmt = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
          const mcap = (v: number) =>
            v >= 1e12
              ? (v / 1e12).toFixed(2) + "万亿"
              : v >= 1e8
                ? (v / 1e8).toFixed(0) + "亿"
                : (v / 1e4).toFixed(0) + "万";
          return (
            <div
              style={{
                position: "fixed",
                left: panelLeft,
                top: panelTop,
                width: PANEL_W,
                zIndex: 9999,
              }}
              className={`rounded-lg shadow-xl border text-xs ${
                isDark
                  ? "bg-gray-800 border-gray-600 text-gray-200"
                  : "bg-white border-gray-200 text-gray-800"
              }`}
              onMouseEnter={() => {
                if (hoverCloseTimer.current) {
                  clearTimeout(hoverCloseTimer.current);
                  hoverCloseTimer.current = null;
                }
              }}
              onMouseLeave={() => {
                setHoveredIndustryName(null);
                setHoverPos(null);
              }}
            >
              <div
                className={`px-3 py-2 border-b font-semibold ${
                  isDark ? "border-gray-700" : "border-gray-100"
                }`}
              >
                {ind.name}
              </div>
              <div className="px-3 py-1.5 flex items-center justify-between">
                <span className={isDark ? "text-gray-400" : "text-gray-500"}>
                  今日涨跌幅
                </span>
                <span
                  className={`font-semibold ${
                    ind.change >= 0
                      ? "text-red-500 dark:text-red-400"
                      : "text-green-600 dark:text-green-500"
                  }`}
                >
                  {fmt(ind.change)}
                </span>
              </div>
              <div className="px-3 pb-1 flex items-center justify-between">
                <span className={isDark ? "text-gray-400" : "text-gray-500"}>
                  总市值
                </span>
                <span>{mcap(ind.marketCap)}</span>
              </div>
              {gainers.length > 0 && (
                <div
                  className={`px-3 py-1.5 border-t ${
                    isDark ? "border-gray-700" : "border-gray-100"
                  }`}
                >
                  <div className="text-red-500 font-semibold mb-1">
                    领涨 Top3
                  </div>
                  {gainers.map((s) => (
                    <div
                      key={s.code}
                      className={`flex justify-between items-center py-0.5 cursor-pointer rounded px-1 -mx-1 ${
                        isDark ? "hover:bg-gray-700" : "hover:bg-gray-50"
                      }`}
                      onClick={() => {
                        navigateToStock(toTsCode(s.code), s.name);
                        setHoveredIndustryName(null);
                        setHoverPos(null);
                      }}
                    >
                      <span
                        className={`truncate max-w-[120px] ${isDark ? "text-gray-300" : "text-gray-600"}`}
                      >
                        {s.name}
                      </span>
                      <span className="text-red-500 font-medium flex-shrink-0 ml-1">
                        {fmt(s.change)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {losers.length > 0 && (
                <div
                  className={`px-3 py-1.5 border-t ${
                    isDark ? "border-gray-700" : "border-gray-100"
                  }`}
                >
                  <div className="text-green-600 dark:text-green-500 font-semibold mb-1">
                    领跌 Top3
                  </div>
                  {losers.map((s) => (
                    <div
                      key={s.code}
                      className={`flex justify-between items-center py-0.5 cursor-pointer rounded px-1 -mx-1 ${
                        isDark ? "hover:bg-gray-700" : "hover:bg-gray-50"
                      }`}
                      onClick={() => {
                        navigateToStock(toTsCode(s.code), s.name);
                        setHoveredIndustryName(null);
                        setHoverPos(null);
                      }}
                    >
                      <span
                        className={`truncate max-w-[120px] ${isDark ? "text-gray-300" : "text-gray-600"}`}
                      >
                        {s.name}
                      </span>
                      <span className="text-green-600 dark:text-green-500 font-medium flex-shrink-0 ml-1">
                        {fmt(s.change)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {isLoadingConstituents && (
                <div
                  className={`px-3 py-1.5 border-t text-center ${
                    isDark
                      ? "border-gray-700 text-gray-500"
                      : "border-gray-100 text-gray-400"
                  }`}
                >
                  加载成分股…
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}
