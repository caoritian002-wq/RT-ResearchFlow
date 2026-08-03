import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAppStore } from "../../store/appStore";
import { ForecastPanel } from "../ForecastPanel/ForecastPanel";
import { StockDecisionSummary } from "./StockDecisionSummary";
import { StockCostPriceEditor } from "./StockCostPriceEditor";
import { StockSignalHistoryPanel } from "./StockSignalHistoryPanel";
import { PortfolioJourneyBanner } from "./PortfolioJourneyBanner";
import { StockFundamentalDrawer } from "./StockFundamentalDrawer";
import { buildStockDecisionContextModel } from "./stockDecisionContextModel";
import { SignalLifecycleDrawer } from "../DecisionCenter/SignalLifecycleDrawer";
import { StockJudgmentPanel } from "../DecisionCenter/StockJudgmentPanel";
import { applyStockJudgment } from "../DecisionCenter/stockJudgmentModel";
import type { DecisionSignalItem } from "../DecisionCenter/SignalCard";
import type { DecisionHistorySignalsData, DecisionReviewSignalItem } from "../DecisionCenter/decisionReviewStatsModel";
import type { PortfolioHoldingRow } from "../DecisionCenter/portfolioCommandModel";
import { ChipPoint, drawChipsCanvas } from "../../utils/drawChipsCanvas";
import { FactorData, FactorSummary } from "../shared/FactorSummary";
import InfoTip from "../shared/InfoTip";
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  LineStyle,
  ColorType,
  createSeriesMarkers,
} from "lightweight-charts";
import type { IChartApi, ISeriesApi, IPriceLine, SeriesMarker, Time } from "lightweight-charts";
import { computeSMC } from "../../utils/smcAnalysis";
import { buildBollingerBandSeries, buildMovingAverageSeries } from "../../utils/movingAverage";
import {
  DEFAULT_VISIBLE_BARS,
  HISTORY_RANGE_PRESETS,
  INITIAL_HISTORY_BARS,
  OLDER_HISTORY_BATCH,
  countVisibleRows,
  defaultVisibleLogicalRange,
  mergeHistoryRows,
  resolveHistoryRangeSelection,
  shiftLogicalRange,
  shouldLoadOlderHistory,
  visibleLogicalRange,
  type HistoryRangePreset,
  type HistoryRangeSelection,
  type LogicalRange,
} from "./stockChartHistoryModel";

// ─── Types ───────────────────────────────────────────────────────────────────

interface StockItem {
  stockCode: string;
  stockName: string;
}

interface PriceRow {
  stockCode: string;
  tradeDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  amount: number | null;
  pctChg: number | null;
  turnoverRate: number | null;
  fetchedAt: number;
}

interface PriceHistoryPage {
  rows: PriceRow[];
  hasMore: boolean;
}

interface StockDataStatus {
  stockCode: string;
  provider: "tushare" | "eastmoney" | "local-cache";
  latestTradeDate: string | null;
  totalRows: number;
  dataState: "complete" | "degraded";
  benchmark?: {
    state: "current" | "stale" | "missing" | "insufficient" | "calendar-unknown";
    message: string;
  };
  message: string;
}

interface ChartRow {
  date: string;
  tradeDate: string;
  open: number | null;
  // Absolute price mode
  收盘: number | null;
  最高: number | null;
  最低: number | null;
  // Overlay % mode — main stock + 3 preset indices (fixed slots)
  pctMain: number | null;
  pct0: number | null; // 000001.SH
  pct1: number | null; // 399001.SZ
  pct2: number | null; // 399006.SZ
  // Always present
  成交额: number | null;
  涨跌幅: number | null;
  换手率: number | null;
  isUp: boolean;
}

type ChipStructureMetricName =
  | "winnerRate"
  | "thickProfitPct"
  | "thinProfitPct"
  | "trappedPct"
  | "deepLowPct"
  | "concentration"
  | "costDeviationPct";

interface ChipStructureSummary {
  tsCode: string;
  stockName: string | null;
  tradeDate: string | null;
  dateRelation: "same_day" | "history" | "missing";
  winnerRate: number | null;
  thickProfitPct: number | null;
  thinProfitPct: number | null;
  trappedPct: number | null;
  deepLowPct: number | null;
  concentration: number | null;
  costDeviationPct: number | null;
  primaryChange: {
    metric: ChipStructureMetricName;
    days: 1 | 3 | 5 | 12;
    value: number;
  } | null;
  freshnessStatus: "current" | "stale" | "unknown";
  completenessStatus: "complete" | "partial" | "blocked";
  consistencyStatus: "matched" | "warning" | "not_comparable";
  missingReasons: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PRESET_INDICES: StockItem[] = [
  { stockCode: "000001.SH", stockName: "上证指数" },
  { stockCode: "399001.SZ", stockName: "深成指" },
  { stockCode: "399006.SZ", stockName: "创业板指" },
];

const PRESET_CODES = PRESET_INDICES.map((p) => p.stockCode);

// Index slot → PRESET_INDICES position
const OVERLAY_COLORS = ["#8b5cf6", "#f59e0b", "#06b6d4"];
const MAIN_STOCK_COLOR = "#2563eb";

// FR-082: colors for multi-model prediction overlay lines (cycled)
const FORECAST_COLORS = ["#f97316", "#8b5cf6", "#06b6d4", "#22c55e"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A股午休过滤：剔除 11:30 ≤ time < 13:00 的时间点 */
function isAShareLunchBreak(time: string): boolean {
  return time >= "11:30" && time < "13:00";
}

function filterLunchBreak<T extends { time: string }>(items: T[]): T[] {
  return items.filter((i) => !isAShareLunchBreak(i.time));
}

function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}/${yyyymmdd.slice(6, 8)}`;
}

// FR-123: 6 位 A 股代码 → Tushare ts_code 后缀
function toTsCodeForMinute(code: string): string {
  if (code.startsWith("6") || code.startsWith("5") || code.startsWith("9")) return `${code}.SH`;
  if (code.startsWith("4") || code.startsWith("8")) return `${code}.BJ`;
  return `${code}.SZ`;
}

// T616: 将 6 位纯数字代码转为带后缀 Tushare 代码（用于 chips/factor IPC）
// 指数代码已含"."（如 000001.SH），返回空串表示跳过
function toTsCodeWithSuffix(code: string): string {
  if (code.includes(".")) return "";
  if (code.startsWith("6") || code.startsWith("5") || code.startsWith("9")) return `${code}.SH`;
  if (code.startsWith("4") || code.startsWith("8")) return `${code}.BJ`;
  return `${code}.SZ`;
}

// FR-123: 从 SQLite stock_minute_cache 读取分钟 K 线, 映射为现有 IntradayRow 格式
async function loadMinuteFromDb(
  stockCode: string,
  tradeDate?: string,
): Promise<{ time: string; price: number; volume: number }[]> {
  try {
    const tsCode = toTsCodeForMinute(stockCode);
    const api = window.api.datasource as unknown as {
      getStockMinuteKline?: (
        tsCode: string,
        tradeDate?: string,
      ) => Promise<{
        ok: boolean;
        data?: Array<{
          tsMinute: string;
          close: number | null;
          vol: number | null;
        }>;
      }>;
    };
    if (!api.getStockMinuteKline) return [];
    const res = await api.getStockMinuteKline(tsCode, tradeDate);
    if (!res?.ok || !Array.isArray(res.data) || res.data.length === 0) return [];
    const rows = res.data
      .filter((r) => r.close !== null && Number.isFinite(r.close))
      .map((r) => ({
        time: r.tsMinute,
        price: r.close as number,
        volume: r.vol ?? 0,
      }));
    // 过滤午休时段 + 集合竞价(09:25-09:29) + 盘后数据，只保留正式交易时段
    return rows.filter((r) => !isAShareLunchBreak(r.time) && r.time >= "09:30" && r.time <= "15:00");
  } catch {
    return [];
  }
}

// T617: 从 stock_minute_cache 读取完整 OHLCV，用于 lwc 蜡烛图
async function loadMinuteOHLCVFromDb(
  stockCode: string,
  tradeDate?: string,
): Promise<Array<{ tsMinute: string; open: number; high: number; low: number; close: number; vol: number }>> {
  try {
    const tsCode = toTsCodeForMinute(stockCode);
    const res = await window.api.datasource.getStockMinuteKline(tsCode, tradeDate);
    if (!res?.ok || !Array.isArray(res.data) || res.data.length === 0) return [];
    return res.data
      .filter(
        (r) =>
          r.open != null &&
          r.high != null &&
          r.low != null &&
          r.close != null &&
          Number.isFinite(r.close) &&
          !isAShareLunchBreak(r.tsMinute) &&
          r.tsMinute >= "09:30" &&
          r.tsMinute <= "15:00",
      )
      .map((r) => ({
        tsMinute: r.tsMinute,
        open: r.open!,
        high: r.high!,
        low: r.low!,
        close: r.close!,
        vol: r.vol ?? 0,
      }));
  } catch {
    return [];
  }
}

/**
 * Format amount in 千元 units.
 * ≥ 1亿 (100,000千元)  → "xxx.xx亿"
 * ≥ 1千万 (10,000千元) → "x.xx千万"
 * < 1千万              → "0.xx千万"
 */
function formatAmount(amountQian: number): string {
  if (amountQian >= 100000) return `${(amountQian / 100000).toFixed(2)}亿`;
  return `${(amountQian / 10000).toFixed(2)}千万`;
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatRatioPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}%`;
}

function formatChipTradeDate(tradeDate: string | null | undefined): string {
  if (!tradeDate || tradeDate.length !== 8) return "无事实日";
  return `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`;
}

const CHIP_MISSING_REASON_LABELS: Record<string, string> = {
  CYQ_PERF_MISSING: "缺少官方成本分位与获利比例",
  CYQ_CHIPS_MISSING: "缺少价格级筹码分布",
  DAILY_CLOSE_MISSING: "缺少同日收盘价",
  DATE_MISMATCH: "筹码来源事实日不一致",
};

function formatChipMissingReasons(reasons: string[] | undefined): string {
  if (!reasons || reasons.length === 0) return "本地暂无完整的同日筹码事实";
  return reasons.map((reason) => CHIP_MISSING_REASON_LABELS[reason] ?? reason).join("；");
}

const CHIP_METRIC_LABELS: Record<ChipStructureMetricName, string> = {
  winnerRate: "获利比例",
  thickProfitPct: "厚浮盈",
  thinProfitPct: "薄浮盈",
  trappedPct: "套牢盘",
  deepLowPct: "深度低位",
  concentration: "集中度",
  costDeviationPct: "成本偏离",
};

/** Convert YYYYMMDD → YYYY-MM-DD for lightweight-charts */
function toISODate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** Compute % change against a stable comparison date so prepending history does not move the lines. */
function toPctMap(prices: PriceRow[], baselineTradeDate?: string): Map<string, number | null> {
  const sorted = [...prices].sort((a, b) =>
    a.tradeDate.localeCompare(b.tradeDate),
  );
  const map = new Map<string, number | null>();
  if (sorted.length === 0) return map;
  const baseline = baselineTradeDate
    ? sorted.find((row) => row.tradeDate >= baselineTradeDate && row.close != null)
    : sorted[0];
  const base = baseline?.close;
  if (!base) return map;
  for (const r of sorted) {
    map.set(
      r.tradeDate,
      r.close != null ? ((r.close - base) / base) * 100 : null,
    );
  }
  return map;
}

async function getStockHistoryPage(
  stockCode: string,
  beforeTradeDate?: string,
  limit = INITIAL_HISTORY_BARS,
): Promise<PriceHistoryPage> {
  const datasource = window.api.datasource as unknown as {
    getStockPricePage?: (
      code: string,
      before?: string,
      pageSize?: number,
    ) => Promise<
      | { ok: true; rows: PriceRow[]; hasMore: boolean }
      | { ok: false; error: { code: string; message: string } }
    >;
    getStockPrices: (code: string) => Promise<PriceRow[]>;
  };

  if (datasource.getStockPricePage) {
    const response = await datasource.getStockPricePage(stockCode, beforeTradeDate, limit);
    if (!response.ok) throw new Error(response.error.message);
    return { rows: response.rows, hasMore: response.hasMore };
  }

  // 兼容尚未重启、仍运行旧 preload 的开发会话。
  const allRows = await datasource.getStockPrices(stockCode);
  const eligible = beforeTradeDate
    ? allRows.filter((row) => row.tradeDate < beforeTradeDate)
    : allRows;
  const rows = eligible.slice(-limit);
  return { rows, hasMore: eligible.length > rows.length };
}

interface IntradayRow {
  time: string;
  price: number;
  volume: number;
}

interface ForecastPoint {
  time: string;
  price: number;
}

interface ProviderForecastData {
  today?: ForecastPoint[];
  morrow?: ForecastPoint[];
  aiReason?: string;
  todayCreatedAt?: string;
  model?: string;
}

interface StockForecastCache {
  today?: ForecastPoint[];
  morrow?: ForecastPoint[];
  aiReason?: string;
  providers?: Record<string, ProviderForecastData>;
}

/**
 * FR-072: Returns true if today is a weekday (Mon–Fri) in Beijing time.
 * In dev mode always returns true.
 */
function isTradingWeekday(): boolean {
  if (import.meta.env.DEV) return true;
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const day = bjNow.getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * FR-072: Returns true before 15:00 Beijing time (market not closed).
 * In dev mode always returns true.
 */
function isBeforeClose(): boolean {
  if (import.meta.env.DEV) return true;
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const h = bjNow.getUTCHours();
  const m = bjNow.getUTCMinutes();
  const totalMin = h * 60 + m;
  return totalMin < 15 * 60;
}

/** Get today's Beijing date as YYYY-MM-DD */
function getTodayBJDate(): string {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return bjNow.toISOString().slice(0, 10);
}

// ─── SortableStockItem ───────────────────────────────────────────────────────

interface SortableStockItemProps {
  stock: { stockCode: string; stockName: string };
  isSelected: boolean;
  isPortfolio: boolean;
  displayName: string;
  onSelect: () => void;
  onDelete: () => void;
}

function SortableStockItem({
  stock,
  isSelected,
  isPortfolio,
  displayName,
  onSelect,
  onDelete,
}: SortableStockItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: stock.stockCode });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative",
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <div
      data-testid={`stock-list-item-${stock.stockCode}`}
      ref={setNodeRef}
      style={style}
      className={[
        "flex items-center border-b border-gray-50 dark:border-gray-700 group",
        isSelected
          ? "bg-blue-50 dark:bg-blue-900/30"
          : "hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800",
      ].join(" ")}
    >
      {/* 拖拽手柄（hover 时显示） */}
      <span
        {...attributes}
        {...listeners}
        className="pl-1.5 pr-0.5 py-2 text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 select-none"
        title="拖动排序"
      >
        ⠿
      </span>
      <button
        onClick={onSelect}
        className="flex-1 text-left px-2 py-2.5 min-w-0"
      >
        <div
          className={`text-sm font-medium truncate flex items-center gap-1 ${isSelected ? "text-blue-700" : "text-gray-700 dark:text-gray-300 dark:text-gray-600"}`}
        >
          {/* 持仓星号标记 */}
          {isPortfolio && (
            <span className="text-orange-400 shrink-0" title="持仓股">★</span>
          )}
          {displayName}
        </div>
        <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
          {stock.stockCode}
        </div>
      </button>
      {/* 删除按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="移除该股票"
        className="px-2 py-1 text-gray-300 dark:text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
      >
        ✕
      </button>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function StockChart() {
  const theme = useAppStore((s) => s.theme);
  const isDark = theme === "dark";
  const pendingStockCode = useAppStore((s) => s.pendingStockCode);
  const pendingDisplay = useAppStore((s) => s.pendingDisplay);
  const pendingStockContext = useAppStore((s) => s.pendingStockContext);
  const clearPendingStockCode = useAppStore((s) => s.clearPendingStockCode);
  const clearPendingStockContext = useAppStore((s) => s.clearPendingStockContext);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setShortTermActiveSubTab = useAppStore((s) => s.setShortTermActiveSubTab);
  const requestDecisionCenterRefresh = useAppStore((s) => s.requestDecisionCenterRefresh);
  const firstPortfolioJourney = useAppStore((s) => s.firstPortfolioJourney);
  const advanceFirstPortfolioJourney = useAppStore((s) => s.advanceFirstPortfolioJourney);
  const finishFirstPortfolioJourney = useAppStore((s) => s.finishFirstPortfolioJourney);
  const clearFirstPortfolioJourney = useAppStore((s) => s.clearFirstPortfolioJourney);
  const [regularStocks, setRegularStocks] = useState<StockItem[]>([]);
  // 拖拽传感器：长按 250ms + 5px 容差才激活，防止误触普通点击
  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    })
  );
  const [selected, setSelected] = useState<string>(PRESET_INDICES[0].stockCode);
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [priceDataCode, setPriceDataCode] = useState(PRESET_INDICES[0].stockCode);
  const [loading, setLoading] = useState(false);
  const [hasOlderPrices, setHasOlderPrices] = useState(false);
  const [loadingOlderCode, setLoadingOlderCode] = useState<string | null>(null);
  const [historyRangeSelection, setHistoryRangeSelection] = useState<HistoryRangeSelection>(DEFAULT_VISIBLE_BARS);
  const [visibleHistoryBars, setVisibleHistoryBars] = useState(0);
  const [historyRangeError, setHistoryRangeError] = useState<string | null>(null);
  const historyCacheRef = useRef<Map<string, PriceHistoryPage>>(new Map());
  const initialHistoryRequestRef = useRef(0);
  const olderHistoryInflightRef = useRef<Map<string, Promise<void>>>(new Map());
  const pendingLogicalRangeRef = useRef<{ range: LogicalRange; addedBefore: number } | null>(null);
  const pendingHistoryRangePresetRef = useRef<HistoryRangePreset | null>(null);
  const historyRangeSelectionRef = useRef<HistoryRangeSelection>(DEFAULT_VISIBLE_BARS);
  const visibleHistoryBarsRef = useRef(0);
  const selectedRef = useRef(selected);
  const loadOlderHistoryRef = useRef<() => void>(() => {});
  // FR-107: 已自动 refresh 过的 ts_code 集合，防止空历史循环触发
  const autoRefreshedRef = useRef<Set<string>>(new Set());
  // FR-109: 从云图导航跳转的 code 集合，需检查今日日线是否完整
  const needTodayRefreshRef = useRef<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  // overlayIndices: Set of PRESET_CODES currently overlaid
  const [overlayIndices, setOverlayIndices] = useState<Set<string>>(new Set());
  // Prices loaded for overlay indices (keyed by ts_code)
  const [indexPricesMap, setIndexPricesMap] = useState<
    Record<string, PriceRow[]>
  >({});
  // Track whether we've done the initial mount auto-refresh
  const didAutoRefresh = useRef(false);
  // FR-069: manual stock search
  const [searchCode, setSearchCode] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [stockDataStatus, setStockDataStatus] = useState<StockDataStatus | null>(null);
  const [fundamentalDrawerOpen, setFundamentalDrawerOpen] = useState(false);
  const [stockBasicSyncing, setStockBasicSyncing] = useState(false);
  // 搜索候选列表（支持中文 / 代码模糊匹配）
  type SearchCandidate = { tsCode: string; name: string; market: string | null };
  const [candidates, setCandidates] = useState<SearchCandidate[]>([]);
  const [candidateEmpty, setCandidateEmpty] = useState(false); // stock_basic 未初始化
  const [showCandidates, setShowCandidates] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  const querySearchCandidates = useCallback(async (keyword: string): Promise<void> => {
    const trimmed = keyword.trim();
    if (!trimmed) return;
    const res = await (window.api.datasource as unknown as {
      searchStock: (k: string) => Promise<
        | { ok: true; results: Array<{ tsCode: string; name: string; market: string | null }>; empty: false }
        | { ok: true; results: []; empty: true }
      >;
    }).searchStock(trimmed);
    if (res.ok) {
      setCandidates(res.results);
      setCandidateEmpty(res.empty);
      setShowCandidates(true);
    }
  }, []);

  const handleSyncStockBasic = useCallback(async (): Promise<void> => {
    const keyword = searchCode.trim();
    if (!keyword || stockBasicSyncing) return;
    setStockBasicSyncing(true);
    setSearchError("");
    try {
      const result = await window.api.shortTerm.syncDataNow("stockBasic");
      if (!result.ok) {
        setSearchError(result.error === "TUSHARE_DISABLED" ? "请先在数据源页启用 Tushare" : "股票基础数据同步失败");
        return;
      }
      await querySearchCandidates(keyword);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "股票基础数据同步失败");
    } finally {
      setStockBasicSyncing(false);
    }
  }, [querySearchCandidates, searchCode, stockBasicSyncing]);
  // FR-070: daily / intraday chart mode toggle
  const [chartMode, setChartMode] = useState<"daily" | "intraday">("daily");
  // 分时图样式：candle=专业蜡烛图，line=传统折线图
  const [intradayStyle, setIntradayStyle] = useState<"candle" | "line">(
    () => (localStorage.getItem("intradayStyle") as "candle" | "line") ?? "candle",
  );
  const [intradayItems, setIntradayItems] = useState<IntradayRow[]>([]);
  const [intradayLoading, setIntradayLoading] = useState(false);
  // FR-072: forecast overlay — cached per stock code
  const [forecastCache, setForecastCache] = useState<
    Record<string, StockForecastCache>
  >({});
  const [forecasting, setForecasting] = useState(false);
  const [forecastError, setForecastError] = useState("");
  // FR-076: forecast panel modal
  const [isForecastPanelOpen, setIsForecastPanelOpen] = useState(false);
  // FR-073: intraday data for overlay indices (keyed by ts_code)
  const [intradayOverlayMap, setIntradayOverlayMap] = useState<
    Record<string, IntradayRow[]>
  >({});
  // FR-082: which providers' forecast lines are visible
  const [checkedProviders, setCheckedProviders] = useState<Set<string>>(
    new Set(),
  );
  // FR-082: configured multi-model providers from AI config (for pre-forecast display)
  const [configuredProviders, setConfiguredProviders] = useState<
    { provider: string; label: string }[]
  >([]);
  // Track per-provider errors per stock (stockCode → provider → errorMsg)
  const [providerErrorsCache, setProviderErrorsCache] = useState<
    Record<string, Record<string, string>>
  >({});
  // FR-087: lightweight-charts refs for daily K-line chart
  const dailyChartContainerRef = useRef<HTMLDivElement>(null);
  const dailyChartRef = useRef<IChartApi | null>(null);
  const [legendData, setLegendData] = useState<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    amount: number;
    turnoverRate: number | null;
    pctChg: number | null;
    amplitude: number | null;
    isUp: boolean;
  } | null>(null);
  const [legendPosition, setLegendPosition] = useState<{ left: number; top: number } | null>(null);

  // T617: lwc 分时蜡烛图
  const intradayLwcContainerRef = useRef<HTMLDivElement>(null);
  const intradayChartRef = useRef<IChartApi | null>(null);
  const [intradayOHLCV, setIntradayOHLCV] = useState<
    Array<{ tsMinute: string; open: number; high: number; low: number; close: number; vol: number }>
  >([]);

  // T619: 筹码分布面板（右侧可折叠）
  const [chipsOpen, setChipsOpen] = useState(false);
  const [chipsData, setChipsData] = useState<ChipPoint[] | null>(null);
  const [chipsLoading, setChipsLoading] = useState(false);
  const chipsCanvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedChipTradeDate, setSelectedChipTradeDate] = useState<{
    stockCode: string;
    tradeDate: string;
  } | null>(null);
  const [chipStructureSummary, setChipStructureSummary] = useState<ChipStructureSummary | null>(null);
  const [chipStructureLoading, setChipStructureLoading] = useState(false);
  const [chipStructureError, setChipStructureError] = useState<string | null>(null);
  const [chipStructureRefreshFeedback, setChipStructureRefreshFeedback] = useState<{
    tone: "warning" | "error";
    text: string;
  } | null>(null);
  const [chipStructureReloadKey, setChipStructureReloadKey] = useState(0);
  const [chipStructureRefreshSubmitting, setChipStructureRefreshSubmitting] = useState(false);
  const [chipStructureRefreshTask, setChipStructureRefreshTask] = useState<{
    taskId: string;
    tsCode: string;
  } | null>(null);
  const chipStructureRefreshTaskRef = useRef<{ taskId: string; tsCode: string } | null>(null);

  // T620: 技术因子面板（底部可折叠）
  const [factorOpen, setFactorOpen] = useState(false);
  const [factorData, setFactorData] = useState<FactorData | null>(null);

  // T622: SMC 结构分析叠加层
  const [smcSwingN, setSmcSwingN] = useState<0 | 2 | 3 | 5>(() => {
    const v = Number(localStorage.getItem("smcSwingN"));
    return ([2, 3, 5].includes(v) ? v : 0) as 0 | 2 | 3 | 5;
  });
  const dailyCandleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const dailyHistogramSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const dailyMainLineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const dailyOverlaySeriesRefs = useRef<Array<ISeriesApi<"Line"> | null>>([null, null, null]);
  const dailyMovingAverageSeriesRefs = useRef<Record<number, ISeriesApi<"Line"> | null>>({});
  const dailyBollSeriesRefs = useRef<Record<string, ISeriesApi<"Line"> | null>>({});
  const dailyChartRowsByTimeRef = useRef<Map<string, ChartRow>>(new Map());
  const dailyVisibleStockRef = useRef<string | null>(null);
  const historyRangeReadyRef = useRef(false);
  const historyRangeReadyFrameRef = useRef<number | null>(null);
  const smcPriceLinesRef = useRef<IPriceLine[]>([]);
  // T622: v5 createSeriesMarkers primitive 引用，切换时清除旧标注
  const smcMarkersRef = useRef<{ setMarkers: (markers: SeriesMarker<Time>[]) => void } | null>(null);

  // FR-168: 持仓状态（非预设指数才显示）
  const [isInPortfolio, setIsInPortfolio] = useState(false);
  // 所有持仓股票代码集合，用于列表星号标记
  const [portfolioSet, setPortfolioSet] = useState<Set<string>>(new Set());
  const [portfolioAddedAt, setPortfolioAddedAt] = useState<Map<string, number>>(new Map());
  const [portfolioCostMap, setPortfolioCostMap] = useState<Map<string, number | null>>(new Map());
  const [portfolioSaving, setPortfolioSaving] = useState(false);
  const [portfolioMessage, setPortfolioMessage] = useState<string | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [decisionActionSaving, setDecisionActionSaving] = useState<string | null>(null);
  const [decisionActionMessage, setDecisionActionMessage] = useState<string | null>(null);
  const [decisionActionError, setDecisionActionError] = useState<string | null>(null);
  const [decisionLifecycleOpen, setDecisionLifecycleOpen] = useState(false);
  const [decisionJudgmentOpen, setDecisionJudgmentOpen] = useState(false);
  const [judgmentSaving, setJudgmentSaving] = useState(false);
  const [judgmentError, setJudgmentError] = useState<string | null>(null);
  const [lifecycleSignalOverride, setLifecycleSignalOverride] = useState<DecisionSignalItem | null>(null);
  const [stockHoldings, setStockHoldings] = useState<PortfolioHoldingRow[] | null>(null);
  const [costEditorOpen, setCostEditorOpen] = useState(false);
  const [costSaving, setCostSaving] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);
  const [stockHistoryRangeDays, setStockHistoryRangeDays] = useState(30);
  const [stockHistoryItems, setStockHistoryItems] = useState<DecisionReviewSignalItem[]>([]);
  const [stockHistoryTotal, setStockHistoryTotal] = useState(0);
  const [stockHistoryLoading, setStockHistoryLoading] = useState(false);
  const [stockHistoryError, setStockHistoryError] = useState<string | null>(null);

  // 当前个股所属题材标签（替换日K底部提示文字）
  const [stockConcepts, setStockConcepts] = useState<string[]>([]);

  selectedRef.current = selected;
  historyRangeSelectionRef.current = historyRangeSelection;
  visibleHistoryBarsRef.current = visibleHistoryBars;

  // 刷新持仓集合（挂载后及操作后调用）
  const reloadPortfolioSet = useCallback(async () => {
    await window.api.portfolio.list().then(res => {
      if (res.ok && res.data) {
        setPortfolioSet(new Set(res.data.map(s => s.tsCode)));
        setPortfolioAddedAt(new Map(res.data.map(s => [s.tsCode, s.addedAt])));
        const nextCostMap = new Map<string, number | null>();
        for (const item of res.data) {
          nextCostMap.set(item.tsCode, item.costPrice ?? null);
          nextCostMap.set(item.tsCode.includes('.') ? item.tsCode.split('.')[0] : item.tsCode, item.costPrice ?? null);
        }
        setPortfolioCostMap(nextCostMap);
      }
    }).catch(() => { /* 静默失败 */ });
  }, []);

  const displayStocks = useMemo(() => {
    const indexed = regularStocks.map((stock, index) => ({ stock, index }));
    return indexed
      .sort((a, b) => {
        const aPortfolio = portfolioSet.has(a.stock.stockCode);
        const bPortfolio = portfolioSet.has(b.stock.stockCode);
        if (aPortfolio !== bPortfolio) return aPortfolio ? -1 : 1;
        if (aPortfolio && bPortfolio) {
          return (portfolioAddedAt.get(b.stock.stockCode) ?? 0) - (portfolioAddedAt.get(a.stock.stockCode) ?? 0);
        }
        return a.index - b.index;
      })
      .map(item => item.stock);
  }, [regularStocks, portfolioAddedAt, portfolioSet]);

  // FR-168: selected 变更时检查当前股票是否在持仓中（复用 portfolioSet）
  useEffect(() => {
    if (PRESET_CODES.includes(selected)) {
      setIsInPortfolio(false);
      return;
    }
    setIsInPortfolio(portfolioSet.has(selected));
  }, [selected, portfolioSet]);

  // 挂载时初始化持仓集合
  useEffect(() => {
    void reloadPortfolioSet();
  }, [reloadPortfolioSet]);

  // Reset to daily mode when selected stock changes (forecast cache is preserved per stock)
  useEffect(() => {
    setChartMode("daily");
    setIntradayItems([]);
    setIntradayOHLCV([]);
    setForecastError("");
    // T619/T620: 切换股票时重置面板数据（数据由下面的 useEffect 重新加载）
    setChipsData(null);
    setChipStructureSummary(null);
    setChipStructureError(null);
    setChipStructureRefreshFeedback(null);
    setFactorData(null);
    setStockConcepts([]);
  }, [selected]);

  // 加载当前股票所属题材（指数跳过）
  useEffect(() => {
    if (PRESET_CODES.includes(selected)) return;
    const tsCode = toTsCodeWithSuffix(selected);
    if (!tsCode) return;
    let cancelled = false;
    void (window.api.shortTerm as unknown as {
      getStockConcepts?: (tsCode: string) => Promise<{ ok: true; names: string[] } | { ok: false; error: string }>
    }).getStockConcepts?.(tsCode).then(res => {
      if (!cancelled && res?.ok) setStockConcepts(res.names);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected]);

  // FR-123: 分时模式订阅生命周期 + 60s 推送刷新 + Tushare 失败 fallback 到东财
  useEffect(() => {
    if (chartMode !== "intraday") return;
    if (PRESET_CODES.includes(selected)) return; // 预设指数不订阅 374

    const api = window.api.datasource as unknown as {
      subscribeStockMinute?: (code: string) => Promise<{ ok: boolean; code?: string }>;
      unsubscribeStockMinute?: () => Promise<unknown>;
      onStockMinuteUpdated?: (cb: (p: { stockCode: string }) => void) => () => void;
      onStockMinuteFallback?: (cb: (p: { stockCode: string }) => void) => () => void;
    };
    if (!api.subscribeStockMinute) return;

    let cancelled = false;
    api.subscribeStockMinute(selected).catch(() => {});

    const offUpdated = api.onStockMinuteUpdated?.((payload) => {
      if (cancelled || payload.stockCode !== selected) return;
      void loadMinuteFromDb(selected).then((rows) => {
        if (!cancelled && rows.length > 0) setIntradayItems(rows);
      });
      // T617: 同步刷新 OHLCV 供蜡烛图使用
      void loadMinuteOHLCVFromDb(selected).then((ohlcv) => {
        if (!cancelled && ohlcv.length > 0) setIntradayOHLCV(ohlcv);
      });
    });

    const offFallback = api.onStockMinuteFallback?.((payload) => {
      if (cancelled || payload.stockCode !== selected) return;
      // Tushare 连续失败 → 立即拉一次东财, 退化到折线
      (async () => {
        try {
          const result = await window.api.datasource.getIntradayData(selected) as { items?: IntradayRow[] };
          if (!cancelled) setIntradayItems(filterLunchBreak(result?.items ?? []));
        } catch {
          /* 忽略 */
        }
      })();
    });

    return () => {
      cancelled = true;
      offUpdated?.();
      offFallback?.();
      api.unsubscribeStockMinute?.().catch(() => {});
    };
  }, [chartMode, selected]);

  // ── Stock list management ───────────────────────────────────────────────────

  /** 从 localStorage 读取用户自定义排序（存放 stockCode 数组） */
  function loadSortOrder(): string[] {
    try {
      const raw = localStorage.getItem("stockSortOrder");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  /** 将当前排序写入 localStorage */
  function saveSortOrder(codes: string[]) {
    localStorage.setItem("stockSortOrder", JSON.stringify(codes));
  }

  /** 按已保存顺序重排列表，新增股票追加到末尾 */
  function applySortOrder(items: StockItem[]): StockItem[] {
    const order = loadSortOrder();
    if (order.length === 0) return items;
    const orderMap = new Map(order.map((code, idx) => [code, idx]));
    const sorted = [...items].sort((a, b) => {
      const ia = orderMap.has(a.stockCode) ? orderMap.get(a.stockCode)! : Infinity;
      const ib = orderMap.has(b.stockCode) ? orderMap.get(b.stockCode)! : Infinity;
      return ia - ib;
    });
    return sorted;
  }

  async function reloadStocks() {
    const items = await window.api.datasource.listStocks();
    const regular = items.filter((s) => !PRESET_CODES.includes(s.stockCode));
    setRegularStocks(applySortOrder(regular));
  }

  useEffect(() => {
    reloadStocks();
    const unsub = window.api.on("datasource:stocksUpdated", () =>
      reloadStocks(),
    );
    return () => {
      unsub();
    };
  }, []);

  // FR-092/FR-107: 消费 appStore.pendingStockCode（云图跳转导航）
  useEffect(() => {
    if (!pendingStockCode) return;
    const code = pendingStockCode;
    // 在 clearPendingStockCode 之前捕获权威名称：
    // fetchStock 后端在 Tushare 未配置/查询失败时以代码本身作为 stockName fallback 存入 DB，
    // 此处用云图传入的正确名称在 reload 后直接修正 regularStocks state。
    const displayName = pendingDisplay?.code === code ? pendingDisplay.name : null;
    clearPendingStockCode(); // 只清 pendingStockCode，pendingDisplay 继续存活
    // FR-109: 标记此 code 需要在价格加载后检查今日数据是否完整
    needTodayRefreshRef.current.add(code);
    historyCacheRef.current.delete(code);
    setSelected(code);

    const known = [
      ...PRESET_INDICES.map((p) => p.stockCode),
      ...regularStocks.map((s) => s.stockCode),
    ];
    if (!known.includes(code)) {
      const sixDigit = code.includes(".") ? code.split(".")[0] : code;
      // 先确保 stock_info 有记录（fetchStock 可能因 Tushare 未配置而失败）
      // 无论 fetchStock 成败，只要有 displayName 就立即写入正确名称到 DB
      const ensureName = () => {
        if (displayName) {
          window.api.datasource.updateStockName(code, displayName)
            .catch(() => {});
        }
      };
      window.api.datasource.fetchStock(sixDigit)
        .then(() => { ensureName(); return reloadStocks(); })
        .catch(() => { ensureName(); reloadStocks(); });
    } else if (displayName) {
      // 股票已在列表中，但 stockName 可能是脏数据（代码 fallback），直接修正 DB + state
      window.api.datasource.updateStockName(code, displayName)
        .then(() => reloadStocks())
        .catch(() => {});
    }
  }, [pendingStockCode]);

  // Load configured AI providers for pre-forecast overlay display
  useEffect(() => {
    window.api.ai
      .getConfig()
      .then(
        (cfg: {
          providerPriority?: string[];
          providerLabels?: Record<string, string>;
          multiModelProviders?: string[];
        }) => {
          const priority = cfg.providerPriority ?? [];
          const labels = cfg.providerLabels ?? {};
          setConfiguredProviders(
            priority.map((p) => ({ provider: p, label: labels[p] ?? p })),
          );
          // FR-094: keep intraday overlay selection aligned with AI config multi-model providers.
          const selectedProviders = cfg.multiModelProviders ?? [];
          setCheckedProviders(new Set(selectedProviders));
        },
      )
      .catch(() => {});
  }, []);

  // Auto-refresh preset indices on first mount (non-blocking, respects cache via force=false in tushareService)
  useEffect(() => {
    if (didAutoRefresh.current) return;
    didAutoRefresh.current = true;
    for (const idx of PRESET_INDICES) {
      window.api.datasource.refreshStock(idx.stockCode, false).catch(() => {});
    }
  }, []);

  // ── Price loading ───────────────────────────────────────────────────────────

  useEffect(() => {
    historyRangeSelectionRef.current = DEFAULT_VISIBLE_BARS;
    visibleHistoryBarsRef.current = 0;
    pendingHistoryRangePresetRef.current = null;
    pendingLogicalRangeRef.current = null;
    setHistoryRangeSelection(DEFAULT_VISIBLE_BARS);
    setVisibleHistoryBars(0);
    setHistoryRangeError(null);
  }, [selected]);

  useEffect(() => {
    const requestId = ++initialHistoryRequestRef.current;
    let cancelled = false;
    const cached = needTodayRefreshRef.current.has(selected)
      ? undefined
      : historyCacheRef.current.get(selected);
    if (cached) {
      setPriceDataCode(selected);
      setPrices(cached.rows);
      setHasOlderPrices(cached.hasMore);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setHasOlderPrices(false);
    setPriceDataCode(selected);
    setPrices([]); // 立即清空旧数据，避免加载期间继续渲染上一股票 K 线

    const commitPage = (page: PriceHistoryPage) => {
      historyCacheRef.current.set(selected, page);
      if (cancelled || requestId !== initialHistoryRequestRef.current) return;
      setPriceDataCode(selected);
      setPrices(page.rows);
      setHasOlderPrices(page.hasMore);
    };

    async function loadPrices() {
      let page = await getStockHistoryPage(selected);
      if (cancelled) return;

      // FR-107: 无历史且本 ts_code 未自动 refresh 过 → 触发一次补拉日线
      if (page.rows.length === 0 && !autoRefreshedRef.current.has(selected)) {
        autoRefreshedRef.current.add(selected);
        try {
          await window.api.datasource.refreshStock(selected);
          if (cancelled) return;
          page = await getStockHistoryPage(selected);
          commitPage(page);
        } catch {
          commitPage({ rows: [], hasMore: false });
        }
      } else {
        // FR-109: 从云图跳转后历史数据不足或陈旧时自动补拉
        // 先过滤掉 FR-093 合成的今日数据，只看真实历史
        const todayKey = getTodayBJDate().replace(/-/g, ""); // YYYYMMDD
        if (needTodayRefreshRef.current.has(selected)) {
          const historicalRows = page.rows.filter((r) => r.tradeDate !== todayKey);
          // 判断是否需要补拉：历史不足20天，或最新历史距今超过7天（与今天不连贯）
          const latestHist =
            historicalRows.length > 0
              ? historicalRows[historicalRows.length - 1].tradeDate
              : null;
          const isStale = (() => {
            if (!latestHist) return true;
            const latestDate = new Date(
              parseInt(latestHist.slice(0, 4)),
              parseInt(latestHist.slice(4, 6)) - 1,
              parseInt(latestHist.slice(6, 8)),
            );
            const diffDays =
              (Date.now() - latestDate.getTime()) / (24 * 60 * 60 * 1000);
            return diffDays > 7;
          })();

          if (historicalRows.length < 20 || isStale) {
            needTodayRefreshRef.current.delete(selected);
            // 先展示旧数据 + 关闭 loading，让 K 线图立即渲染，再静默补拉完整历史
            commitPage(page);
            if (!cancelled) setLoading(false);
            try {
              await window.api.datasource.refreshStock(selected);
              if (cancelled) return;
              page = await getStockHistoryPage(selected);
              commitPage(page);
            } catch {
              // 退化：已展示旧数据，无需额外处理
            }
            return; // setLoading(false) 已提前调用，跳过末尾的调用
          } else {
            needTodayRefreshRef.current.delete(selected);
            commitPage(page);
          }
        } else {
          commitPage(page);
        }
      }
      if (!cancelled && requestId === initialHistoryRequestRef.current) setLoading(false);
    }

    loadPrices().catch(() => {
      if (!cancelled && requestId === initialHistoryRequestRef.current) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const loadOlderHistory = useCallback(() => {
    const stockCode = selectedRef.current;
    const current = historyCacheRef.current.get(stockCode);
    if (!current?.hasMore || current.rows.length === 0) return;
    if (olderHistoryInflightRef.current.has(stockCode)) return;

    const task = (async () => {
      if (selectedRef.current === stockCode) setLoadingOlderCode(stockCode);
      try {
        const olderPage = await getStockHistoryPage(
          stockCode,
          current.rows[0].tradeDate,
          OLDER_HISTORY_BATCH,
        );
        const merged = mergeHistoryRows(current.rows, olderPage.rows);
        const nextEntry = { rows: merged.rows, hasMore: olderPage.hasMore };
        historyCacheRef.current.set(stockCode, nextEntry);

        const overlayUpdates: Record<string, PriceRow[]> = {};
        if (!PRESET_CODES.includes(stockCode) && overlayIndices.size > 0) {
          await Promise.all(Array.from(overlayIndices).map(async (indexCode) => {
            const indexCurrent = historyCacheRef.current.get(indexCode);
            if (!indexCurrent?.hasMore || indexCurrent.rows.length === 0) return;
            const indexOlder = await getStockHistoryPage(
              indexCode,
              indexCurrent.rows[0].tradeDate,
              OLDER_HISTORY_BATCH,
            );
            const indexMerged = mergeHistoryRows(indexCurrent.rows, indexOlder.rows);
            historyCacheRef.current.set(indexCode, {
              rows: indexMerged.rows,
              hasMore: indexOlder.hasMore,
            });
            overlayUpdates[indexCode] = indexMerged.rows;
          }));
        }

        if (selectedRef.current !== stockCode) return;
        const range = dailyChartRef.current?.timeScale().getVisibleLogicalRange() ?? null;
        if (range && merged.addedBefore > 0) {
          pendingLogicalRangeRef.current = {
            range: { from: range.from, to: range.to },
            addedBefore: merged.addedBefore,
          };
        }
        setPrices(nextEntry.rows);
        setHasOlderPrices(nextEntry.hasMore);
        if (Object.keys(overlayUpdates).length > 0) {
          setIndexPricesMap((previous) => ({ ...previous, ...overlayUpdates }));
        }
      } finally {
        olderHistoryInflightRef.current.delete(stockCode);
        if (selectedRef.current === stockCode) setLoadingOlderCode(null);
      }
    })().catch(() => {});

    olderHistoryInflightRef.current.set(stockCode, task);
  }, [overlayIndices]);

  useEffect(() => {
    loadOlderHistoryRef.current = loadOlderHistory;
  }, [loadOlderHistory]);

  const loadAllHistory = useCallback(async (stockCode: string): Promise<boolean> => {
    const existing = olderHistoryInflightRef.current.get(stockCode);
    if (existing) await existing;

    const initial = historyCacheRef.current.get(stockCode);
    if (!initial || initial.rows.length === 0 || !initial.hasMore) return true;

    const readAllCachedRows = async (code: string): Promise<PriceHistoryPage | null> => {
      let current = historyCacheRef.current.get(code);
      if (!current || current.rows.length === 0) return current ?? null;

      while (current.hasMore) {
        const olderPage = await getStockHistoryPage(
          code,
          current.rows[0].tradeDate,
          OLDER_HISTORY_BATCH,
        );
        const merged = mergeHistoryRows(current.rows, olderPage.rows);
        current = {
          rows: merged.rows,
          hasMore: merged.addedBefore > 0 ? olderPage.hasMore : false,
        };
        historyCacheRef.current.set(code, current);
        if (merged.addedBefore === 0) break;
      }
      return current;
    };

    const task = (async () => {
      if (selectedRef.current === stockCode) setLoadingOlderCode(stockCode);
      const completed = await readAllCachedRows(stockCode);
      if (!completed) return;

      const overlayUpdates: Record<string, PriceRow[]> = {};
      if (!PRESET_CODES.includes(stockCode) && overlayIndices.size > 0) {
        await Promise.all(Array.from(overlayIndices).map(async (indexCode) => {
          const indexCompleted = await readAllCachedRows(indexCode);
          if (indexCompleted) overlayUpdates[indexCode] = indexCompleted.rows;
        }));
      }

      if (selectedRef.current !== stockCode) return;
      pendingHistoryRangePresetRef.current = "all";
      setPrices([...completed.rows]);
      setHasOlderPrices(completed.hasMore);
      if (Object.keys(overlayUpdates).length > 0) {
        setIndexPricesMap((previous) => ({ ...previous, ...overlayUpdates }));
      }
    })();

    olderHistoryInflightRef.current.set(stockCode, task);
    try {
      await task;
      return true;
    } catch {
      if (selectedRef.current === stockCode) {
        pendingHistoryRangePresetRef.current = null;
        setHistoryRangeError("更早日K读取失败，请重试");
      }
      return false;
    } finally {
      olderHistoryInflightRef.current.delete(stockCode);
      if (selectedRef.current === stockCode) setLoadingOlderCode(null);
    }
  }, [overlayIndices]);

  const applyHistoryRange = useCallback((preset: HistoryRangePreset, rowCount: number) => {
    const chart = dailyChartRef.current;
    if (!chart || chartMode !== "daily" || rowCount <= 0) return;

    historyRangeReadyRef.current = false;
    if (historyRangeReadyFrameRef.current != null) {
      cancelAnimationFrame(historyRangeReadyFrameRef.current);
    }
    const range = visibleLogicalRange(rowCount, preset);
    chart.timeScale().setVisibleLogicalRange(range);
    const visibleRows = countVisibleRows(range, rowCount);
    visibleHistoryBarsRef.current = visibleRows;
    setVisibleHistoryBars(visibleRows);
    dailyVisibleStockRef.current = selectedRef.current;
    historyRangeReadyFrameRef.current = requestAnimationFrame(() => {
      historyRangeReadyFrameRef.current = requestAnimationFrame(() => {
        historyRangeReadyRef.current = true;
        historyRangeReadyFrameRef.current = null;
      });
    });
  }, [chartMode]);

  const handleHistoryRangeChange = useCallback(async (preset: HistoryRangePreset) => {
    historyRangeSelectionRef.current = preset;
    setHistoryRangeSelection(preset);
    setHistoryRangeError(null);

    const stockCode = selectedRef.current;
    const current = historyCacheRef.current.get(stockCode);
    if (preset === "all" && current?.hasMore) {
      const completed = await loadAllHistory(stockCode);
      if (!completed) {
        const fallback = resolveHistoryRangeSelection(
          visibleHistoryBarsRef.current,
          current.rows.length,
          current.hasMore,
        );
        historyRangeSelectionRef.current = fallback;
        setHistoryRangeSelection(fallback);
      }
      return;
    }
    applyHistoryRange(preset, current?.rows.length ?? prices.length);
  }, [applyHistoryRange, loadAllHistory, prices.length]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setSearchError("");
    try {
      const result = await window.api.datasource.refreshStock(selected);
      if (result.ok) {
        setStockDataStatus({
          stockCode: selected,
          provider: result.provider,
          latestTradeDate: result.latestTradeDate,
          totalRows: result.totalRows,
          dataState: result.dataState,
          benchmark: result.benchmark,
          message: result.message,
        });
        await reloadStocks();
      } else {
        const message = result.reason === "invalid_code"
          ? "股票代码无效"
          : result.reason === "not_found"
            ? "未找到这只股票，请确认代码"
            : result.reason === "no_token"
              ? "Tushare 配置不可用，请检查数据源设置"
              : "行情拉取失败，请稍后重试";
        setSearchError(message);
      }
    } catch {
      setSearchError("行情拉取失败，请稍后重试");
    }
    const page = await getStockHistoryPage(selected).catch(() => null);
    if (page) {
      historyCacheRef.current.set(selected, page);
      if (selectedRef.current === selected) {
        setPriceDataCode(selected);
        setPrices(page.rows);
        setHasOlderPrices(page.hasMore);
      }
    }
    // Also reload overlay index data if active
    const updated: Record<string, PriceRow[]> = {};
    await Promise.all(Array.from(overlayIndices).map(async (tsCode) => {
      const indexPage = await getStockHistoryPage(tsCode).catch(() => null);
      if (!indexPage) return;
      historyCacheRef.current.set(tsCode, indexPage);
      updated[tsCode] = indexPage.rows;
    }));
    if (Object.keys(updated).length > 0) {
      setIndexPricesMap((prev) => ({ ...prev, ...updated }));
    }
    // FR-072: clear forecast cache for current stock when data is refreshed
    setForecastCache((prev) => {
      const next = { ...prev };
      delete next[selected];
      return next;
    });
    await window.api.ai.clearForecast(selected).catch(() => {});
    setRefreshing(false);
  }

  async function handleDeleteStock(stockCode: string) {
    await window.api.datasource.deleteStock(stockCode).catch(() => {});
    historyCacheRef.current.delete(stockCode);
    setRegularStocks((prev) => prev.filter((s) => s.stockCode !== stockCode));
    if (selected === stockCode) setSelected(PRESET_INDICES[0].stockCode);
  }

  async function handleClearAll() {
    await window.api.datasource.clearAllStocks().catch(() => {});
    setRegularStocks([]);
    setOverlayIndices(new Set());
    setIndexPricesMap({});
    historyCacheRef.current.clear();
    if (!PRESET_CODES.includes(selected))
      setSelected(PRESET_INDICES[0].stockCode);
  }

  // FR-069: search for a stock by 6-digit code on Enter key
  async function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setShowCandidates(false);
      return;
    }
    if (e.key !== "Enter") return;
    const code = searchCode.trim();
    // 直接输入 6 位数字时兼容旧逻辑：直接查询
    if (/^\d{6}$/.test(code)) {
      setShowCandidates(false);
      await doFetchStock(code);
      return;
    }
    // 其他情况提示候选（用户应点击候选项）
    if (candidates.length === 0 && code.length > 0) {
      setSearchError("请输入公司名称或 6 位股票代码");
    }
  }

  // 共用：按 6 位数字代码拉取并加入列表
  async function doFetchStock(sixDigit: string) {
    setSearchError("");
    setSearching(true);
    try {
      const result = await window.api.datasource.fetchStock(sixDigit) as {
        stockCode?: string;
        stockName?: string;
        provider?: "tushare" | "eastmoney" | "local-cache";
        latestTradeDate?: string | null;
        totalRows?: number;
        dataState?: "complete" | "degraded";
        benchmark?: StockDataStatus["benchmark"];
        message?: string;
        error?: { code: string; message: string };
      };
      if (result?.error) {
        if (firstPortfolioJourney && result.error.code === "TUSHARE_NOT_CONFIGURED") {
          setSearchError("行情暂不可用，仍可先加入持仓并稍后补充数据");
          setSelected(sixDigit);
        } else {
          setSearchError(result.error.message);
          // FR-069 补充：STOCK_NOT_FOUND 时保留输入框内容，其余错误清空
          if (result.error.code !== "STOCK_NOT_FOUND") {
            setSearchCode("");
          }
        }
      } else if (result?.stockCode) {
        setSearchCode("");
        if (
          result.provider
          && result.totalRows != null
          && result.dataState
          && result.message
        ) {
          setStockDataStatus({
            stockCode: result.stockCode,
            provider: result.provider,
            latestTradeDate: result.latestTradeDate ?? null,
            totalRows: result.totalRows,
            dataState: result.dataState,
            benchmark: result.benchmark,
            message: result.message,
          });
        }
        await reloadStocks();
        setSelected(result.stockCode);
      }
    } catch {
      setSearchError("查询失败");
    }
    setSearching(false);
  }

  // 点击候选项：提取 6 位代码后直接 fetchStock
  async function handleSelectCandidate(candidate: SearchCandidate) {
    const sixDigit = candidate.tsCode.split(".")[0];
    setShowCandidates(false);
    setCandidates([]);
    setSearchCode("");
    await doFetchStock(sixDigit);
  }

  // FR-070: toggle between daily and intraday chart mode
  async function handleToggleChartMode() {
    if (chartMode === "intraday") {
      setChartMode("daily");
      setIntradayItems([]);
      setIntradayOverlayMap({});
      // FR-123: 退出分时模式立即取消分钟 K 订阅
      try {
        await (
          window.api.datasource as unknown as {
            unsubscribeStockMinute?: () => Promise<unknown>;
          }
        ).unsubscribeStockMinute?.();
      } catch {
        /* 忽略 */
      }
      return;
    }
    setIntradayLoading(true);
    setChartMode("intraday");
    // FR-123: 主数据路径 — 优先 374 rt_min（持久化, 跨日可看）, 失败/空 fallback 东财
    let items: IntradayRow[] = [];
    if (!PRESET_CODES.includes(selected)) {
      items = await loadMinuteFromDb(selected);
    }
    if (items.length === 0) {
      try {
        const result = await window.api.datasource.getIntradayData(selected) as { items?: IntradayRow[] };
        items = filterLunchBreak(result?.items ?? []);
      } catch {
        items = [];
      }
    }
    setIntradayItems(items);
    // T617: 并行加载 OHLCV 供蜡烛图使用
    if (!PRESET_CODES.includes(selected)) {
      void loadMinuteOHLCVFromDb(selected).then((ohlcv) => setIntradayOHLCV(ohlcv));
    }
    // FR-073: load intraday data for any already-active overlay indices
    if (overlayIndices.size > 0) {
      const overlayData: Record<string, IntradayRow[]> = {};
      for (const tsCode of overlayIndices) {
        try {
          const r = await window.api.datasource.getIntradayData(tsCode) as { items?: IntradayRow[] };
          overlayData[tsCode] = filterLunchBreak(r?.items ?? []);
        } catch {
          overlayData[tsCode] = [];
        }
      }
      setIntradayOverlayMap(overlayData);
    }
    setIntradayLoading(false);
  }

  // FR-072 + FR-081: predict today's trend (single or multi-model)
  async function handlePredictTrendToday(isManual = true) {
    if (isManual) {
      const selectedProviders = Array.from(checkedProviders);
      if (selectedProviders.length === 0) {
        setForecastError("请先勾选至少一个模型");
        return;
      }
    }
    setForecasting(true);
    setForecastError("");
    try {
      const selectedProviders = isManual
        ? Array.from(checkedProviders)
        : undefined;
      const result = (await window.api.ai.predictTrendToday(
        selected,
        undefined,
        selectedProviders,
      )) as {
        // Single-model response
        points?: ForecastPoint[];
        aiReason?: string;
        message?: string;
        provider?: string;
        model?: string;
        // Multi-model response
        results?: {
          provider: string;
          model: string;
          points: ForecastPoint[];
          aiReason: string;
          forecastId: number;
        }[];
        errors?: { provider: string; error: string }[];
        error?: { message: string };
      };
      if (result?.error) {
        setForecastError(result.error.message);
      } else if (result?.results) {
        // Multi-model response
        const providers: Record<string, ProviderForecastData> = {};
        for (const r of result.results) {
          providers[r.provider] = {
            today: r.points,
            aiReason: r.aiReason,
            model: r.model,
            todayCreatedAt: new Date().toISOString(),
          };
        }
        const firstResult = result.results[0];
        setForecastCache((prev) => ({
          ...prev,
          [selected]: {
            ...prev[selected],
            today: firstResult?.points,
            aiReason: firstResult?.aiReason,
            providers: { ...prev[selected]?.providers, ...providers },
          },
        }));
        // Auto-check all successful providers
        setCheckedProviders(new Set(result.results.map((r) => r.provider)));
        if (result.errors && result.errors.length > 0) {
          const errMap: Record<string, string> = {};
          for (const e of result.errors) errMap[e.provider] = e.error;
          setProviderErrorsCache((prev) => ({
            ...prev,
            [selected]: { ...(prev[selected] ?? {}), ...errMap },
          }));
          setForecastError(
            `部分模型预测失败: ${result.errors.map((e) => `${e.provider}: ${e.error}`).join("; ")}`,
          );
        }
      } else if (result?.points && result.points.length > 0) {
        // Single-model response
        const providers: Record<string, ProviderForecastData> = {};
        if (result.provider) {
          providers[result.provider] = {
            today: result.points,
            aiReason: result.aiReason,
            model: result.model,
            todayCreatedAt: new Date().toISOString(),
          };
        }
        setForecastCache((prev) => ({
          ...prev,
          [selected]: {
            ...prev[selected],
            today: result.points,
            aiReason: result.aiReason,
            providers: { ...prev[selected]?.providers, ...providers },
          },
        }));
        if (result.provider) {
          setCheckedProviders((prev) => new Set([...prev, result.provider!]));
        }
      } else {
        setForecastError(result?.message ?? "AI未返回有效预测数据");
      }
    } catch {
      setForecastError("预测失败");
    }
    setForecasting(false);
  }

  // FR-072 + FR-081: predict tomorrow's trend (single or multi-model)
  async function handlePredictTrendMorrow() {
    const selectedProviders = Array.from(checkedProviders);
    if (selectedProviders.length === 0) {
      setForecastError("请先勾选至少一个模型");
      return;
    }
    setForecasting(true);
    setForecastError("");
    try {
      const result = (await window.api.ai.predictTrendMorrow(
        selected,
        selectedProviders,
      )) as {
        points?: ForecastPoint[];
        aiReason?: string;
        message?: string;
        provider?: string;
        model?: string;
        results?: {
          provider: string;
          model: string;
          points: ForecastPoint[];
          aiReason: string;
          forecastId: number;
        }[];
        errors?: { provider: string; error: string }[];
        error?: { message: string };
      };
      if (result?.error) {
        setForecastError(result.error.message);
      } else if (result?.results) {
        const providers: Record<string, ProviderForecastData> = {};
        for (const r of result.results) {
          providers[r.provider] = {
            ...((forecastCache[selected]?.providers ?? {})[r.provider] ?? {}),
            morrow: r.points,
            aiReason: r.aiReason,
            model: r.model,
          };
        }
        const firstResult = result.results[0];
        setForecastCache((prev) => ({
          ...prev,
          [selected]: {
            ...prev[selected],
            morrow: firstResult?.points,
            aiReason: firstResult?.aiReason,
            providers: { ...prev[selected]?.providers, ...providers },
          },
        }));
        setCheckedProviders(new Set(result.results.map((r) => r.provider)));
        if (result.errors && result.errors.length > 0) {
          setForecastError(
            `部分模型预测失败: ${result.errors.map((e) => `${e.provider}: ${e.error}`).join("; ")}`,
          );
        }
      } else if (result?.points && result.points.length > 0) {
        const providers: Record<string, ProviderForecastData> = {};
        if (result.provider) {
          providers[result.provider] = {
            ...((forecastCache[selected]?.providers ?? {})[result.provider] ??
              {}),
            morrow: result.points,
            aiReason: result.aiReason,
            model: result.model,
          };
        }
        setForecastCache((prev) => ({
          ...prev,
          [selected]: {
            ...prev[selected],
            morrow: result.points,
            aiReason: result.aiReason,
            providers: { ...prev[selected]?.providers, ...providers },
          },
        }));
        if (result.provider) {
          setCheckedProviders((prev) => new Set([...prev, result.provider!]));
        }
      } else {
        setForecastError(result?.message ?? "AI未返回有效预测数据");
      }
    } catch {
      setForecastError("预测失败");
    }
    setForecasting(false);
  }

  // FR-072: clear forecast for current stock
  const handleClearForecast = useCallback(async () => {
    setForecastCache((prev) => {
      const next = { ...prev };
      delete next[selected];
      return next;
    });
    setForecastError("");
    setCheckedProviders(new Set());
    setProviderErrorsCache((prev) => {
      const next = { ...prev };
      delete next[selected];
      return next;
    });
    await window.api.ai.clearForecast(selected).catch(() => {});
  }, [selected]);

  // Re-predict today for a single errored provider (triggered by re-checking its checkbox)
  async function handlePredictSingleProvider(provider: string) {
    setForecasting(true);
    setForecastError("");
    // Clear error for this provider
    setProviderErrorsCache((prev) => {
      if (!prev[selected]) return prev;
      const errs = { ...prev[selected] };
      delete errs[provider];
      return { ...prev, [selected]: errs };
    });
    try {
      const result = (await window.api.ai.predictTrendToday(
        selected,
        provider,
      )) as {
        points?: ForecastPoint[];
        aiReason?: string;
        message?: string;
        provider?: string;
        model?: string;
        error?: { message: string };
      };
      if (result?.error) {
        setProviderErrorsCache((prev) => ({
          ...prev,
          [selected]: {
            ...(prev[selected] ?? {}),
            [provider]: result.error!.message,
          },
        }));
        setForecastError(result.error.message);
      } else if (result?.points && result.points.length > 0) {
        const providerKey = result.provider ?? provider;
        setForecastCache((prev) => ({
          ...prev,
          [selected]: {
            ...prev[selected],
            today: prev[selected]?.today ?? result.points,
            providers: {
              ...(prev[selected]?.providers ?? {}),
              [providerKey]: {
                today: result.points,
                aiReason: result.aiReason,
                model: result.model,
                todayCreatedAt: new Date().toISOString(),
              },
            },
          },
        }));
        setCheckedProviders((prev) => new Set([...prev, providerKey]));
      } else {
        const msg = result?.message ?? "AI未返回有效预测数据";
        setProviderErrorsCache((prev) => ({
          ...prev,
          [selected]: { ...(prev[selected] ?? {}), [provider]: msg },
        }));
        setForecastError(msg);
      }
    } catch {
      const msg = "预测失败";
      setProviderErrorsCache((prev) => ({
        ...prev,
        [selected]: { ...(prev[selected] ?? {}), [provider]: msg },
      }));
      setForecastError(msg);
    }
    setForecasting(false);
  }

  async function handleToggleOverlay(tsCode: string) {
    const next = new Set(overlayIndices);
    if (next.has(tsCode)) {
      next.delete(tsCode);
      setOverlayIndices(next);
      setIntradayOverlayMap((prev) => {
        const n = { ...prev };
        delete n[tsCode];
        return n;
      });
    } else {
      // Load daily index prices if not already in state
      if (!indexPricesMap[tsCode]) {
        const cachedPage = historyCacheRef.current.get(tsCode);
        const page = cachedPage ?? await getStockHistoryPage(tsCode);
        historyCacheRef.current.set(tsCode, page);
        setIndexPricesMap((prev) => ({
          ...prev,
          [tsCode]: page.rows,
        }));
      }
      // FR-073: also load intraday data when in intraday mode
      if (chartMode === "intraday") {
        try {
          const r = await window.api.datasource.getIntradayData(tsCode) as { items?: IntradayRow[] };
          setIntradayOverlayMap((prev) => ({
            ...prev,
            [tsCode]: filterLunchBreak(r?.items ?? []),
          }));
        } catch {
          setIntradayOverlayMap((prev) => ({ ...prev, [tsCode]: [] }));
        }
      }
      next.add(tsCode);
      setOverlayIndices(next);
    }
  }

  // ── Derived display data ────────────────────────────────────────────────────
  const currentForecast = forecastCache[selected] ?? {};
  const forecastTodayItems = currentForecast.today ?? [];
  const forecastMorrowItems = currentForecast.morrow ?? [];
  // FR-082: per-provider forecast data for checked providers
  const forecastProviders = currentForecast.providers ?? {};
  const providerKeys = Object.keys(forecastProviders).filter(
    (p) => forecastProviders[p]?.today || forecastProviders[p]?.morrow,
  );

  const isOverlayMode =
    overlayIndices.size > 0 && !PRESET_CODES.includes(selected);

  const selectedItem =
    // FR-107: 云图跳转传入的权威信息优先级最高（覆盖 regularStocks 中可能没有中文名的脏数据）
    (pendingDisplay && pendingDisplay.code === selected
      ? ({ stockCode: selected, stockName: pendingDisplay.name } as StockItem)
      : undefined) ??
    PRESET_INDICES.find((p) => p.stockCode === selected) ??
    regularStocks.find((s) => s.stockCode === selected);

  useEffect(() => {
    if (pendingStockContext && pendingStockContext.code !== selected) {
      clearPendingStockContext();
    }
  }, [clearPendingStockContext, pendingStockContext, selected]);

  // Build chart rows
  const sortedPrices = useMemo(
    () => [...prices].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)),
    [prices],
  );
  const activeStockContext =
    pendingStockContext && pendingStockContext.code === selected
      ? pendingStockContext
      : null;
  const latestPrice = sortedPrices[sortedPrices.length - 1] ?? null;
  const selectedCostPrice = portfolioCostMap.get(selected) ?? null;
  const stockDecisionModel = buildStockDecisionContextModel({
    stockCode: selected,
    stockName: selectedItem?.stockName ?? selected,
    navigationContext: activeStockContext,
    isPortfolio: isInPortfolio,
    costPrice: selectedCostPrice,
    hasForecastToday: forecastTodayItems.length > 0,
    hasForecastMorrow: forecastMorrowItems.length > 0,
    hasChips: Boolean(chipsData?.length),
    hasFactor: Boolean(factorData),
    latestClose: latestPrice?.close ?? null,
    latestPctChg: latestPrice?.pctChg ?? null,
    tradeDate: latestPrice?.tradeDate ?? null
  });

  const activeDecisionSignal: DecisionSignalItem | null = activeStockContext
    ? {
        id: activeStockContext.signalId,
        sourceModule: activeStockContext.sourceModule,
        strategyKey: activeStockContext.strategyKey,
        tsCode: selected,
        stockName: selectedItem?.stockName ?? activeStockContext.name ?? null,
        conceptCode: null,
        conceptName: null,
        signalType: activeStockContext.signalType,
        direction: activeStockContext.direction,
        priority: activeStockContext.priority,
        score: activeStockContext.score ?? null,
        confidence: activeStockContext.confidence ?? null,
        title: activeStockContext.title,
        summary: activeStockContext.summary ?? '',
        reasonJson: activeStockContext.reasonJson ?? null,
        sourceRefJson: activeStockContext.sourceRefJson ?? null,
        status: (activeStockContext.status as DecisionSignalItem['status']) ?? 'NEW',
        signalTime: activeStockContext.signalTime,
        occurrenceCount: activeStockContext.occurrenceCount ?? 1,
        resolution: null,
        resolutionNote: null
      }
    : null;

  useEffect(() => {
    let cancelled = false
    void window.api.portfolio.list().then((res) => {
      if (cancelled) return
      if (!res.ok || !res.data) {
        setStockHoldings([])
        return
      }
      setStockHoldings(res.data.map((row) => ({
        tsCode: row.tsCode,
        stockName: row.stockName,
        addedAt: row.addedAt,
        costPrice: row.costPrice ?? null,
      })))
    }).catch(() => {
      if (!cancelled) setStockHoldings(null)
    })
    return () => { cancelled = true }
  }, [selected, portfolioSet])

  const refreshAfterDecisionAction = useCallback((message: string, nextStatus?: string) => {
    setDecisionActionMessage(message);
    setDecisionActionError(null);
    requestDecisionCenterRefresh('signal-updated');
    if (nextStatus && activeStockContext) {
      useAppStore.setState({ pendingStockContext: { ...activeStockContext, status: nextStatus } });
    }
  }, [activeStockContext, requestDecisionCenterRefresh]);

  const handleDecisionAction = useCallback(async (action: 'read' | 'watch' | 'dismiss') => {
    if (!activeStockContext) return;
    setDecisionActionSaving(action);
    setDecisionActionMessage(null);
    setDecisionActionError(null);
    try {
      const res = action === 'read'
        ? await window.api.decision.markRead(activeStockContext.signalId)
        : action === 'watch'
          ? await window.api.decision.watch(activeStockContext.signalId)
          : await window.api.decision.dismiss(activeStockContext.signalId, '已在单股页忽略', '单股研判后暂不继续跟踪');
      if (!res.ok) throw new Error(res.message || res.error || '更新信号状态失败');
      const nextStatus = action === 'read' ? 'READ' : action === 'watch' ? 'WATCHING' : 'DISMISSED';
      refreshAfterDecisionAction(action === 'read' ? '已标记为已读' : action === 'watch' ? '已加入关注' : '已忽略该信号', nextStatus);
    } catch (err) {
      setDecisionActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDecisionActionSaving(null);
    }
  }, [activeStockContext, refreshAfterDecisionAction]);

  const handleSaveCostPrice = useCallback(async (costPrice: number | null) => {
    const tsCode = toTsCodeWithSuffix(selected) ?? selected;
    setCostSaving(true);
    setCostError(null);
    setDecisionActionMessage(null);
    setDecisionActionError(null);
    try {
      let res = await window.api.portfolio.updateCostPrice(tsCode, costPrice);
      if (!res.ok && res.code === 'NOT_FOUND') {
        res = await window.api.portfolio.updateCostPrice(selected, costPrice);
      }
      if (!res.ok) throw new Error(res.message || '成本价保存失败');
      await reloadPortfolioSet();
      requestDecisionCenterRefresh('portfolio-updated');
      setCostEditorOpen(false);
      setDecisionActionMessage(costPrice == null ? '已清空成本价' : '成本价已保存');
    } catch (err) {
      setCostError(err instanceof Error ? err.message : String(err));
    } finally {
      setCostSaving(false);
    }
  }, [reloadPortfolioSet, requestDecisionCenterRefresh, selected]);

  const handleTogglePortfolio = useCallback(async () => {
    if (portfolioSaving || PRESET_CODES.includes(selected)) return;
    const stock = regularStocks.find(item => item.stockCode === selected);
    const name = stock?.stockName ?? selected;
    setPortfolioSaving(true);
    setPortfolioMessage(null);
    setPortfolioError(null);
    try {
      const res = isInPortfolio
        ? await window.api.portfolio.remove(selected)
        : await window.api.portfolio.add(selected, name);
      if (!res.ok) throw new Error(res.message || (isInPortfolio ? '移除持仓失败' : '加入持仓失败'));

      const nextIsInPortfolio = !isInPortfolio;
      setIsInPortfolio(nextIsInPortfolio);
      await reloadPortfolioSet();
      requestDecisionCenterRefresh('portfolio-updated');
      setPortfolioMessage(nextIsInPortfolio ? '已加入持仓' : '已从持仓移除');
      if (nextIsInPortfolio && firstPortfolioJourney) {
        advanceFirstPortfolioJourney(selected, name);
      }
    } catch (err) {
      setPortfolioError(err instanceof Error ? err.message : String(err));
    } finally {
      setPortfolioSaving(false);
    }
  }, [advanceFirstPortfolioJourney, firstPortfolioJourney, isInPortfolio, portfolioSaving, regularStocks, reloadPortfolioSet, requestDecisionCenterRefresh, selected]);

  const loadStockSignalHistory = useCallback(async () => {
    if (PRESET_CODES.includes(selected)) return;
    setStockHistoryLoading(true);
    setStockHistoryError(null);
    try {
      const res = await window.api.decision.getHistorySignals({ rangeDays: stockHistoryRangeDays, tsCode: selected, limit: 6 });
      if (!res.ok) throw new Error(res.message || res.error || '加载历史信号失败');
      const data = (res.data ?? null) as DecisionHistorySignalsData | null;
      setStockHistoryItems(data?.items ?? []);
      setStockHistoryTotal(data?.total ?? 0);
    } catch (err) {
      setStockHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setStockHistoryLoading(false);
    }
  }, [selected, stockHistoryRangeDays]);

  useEffect(() => {
    setStockHistoryItems([]);
    setStockHistoryTotal(0);
    setStockHistoryError(null);
    if (PRESET_CODES.includes(selected)) return;
    void loadStockSignalHistory();
  }, [loadStockSignalHistory, selected]);

  // Overlay % maps (keyed by preset index position 0/1/2)
  const overlayBaselineTradeDate = sortedPrices[
    Math.max(0, sortedPrices.length - DEFAULT_VISIBLE_BARS)
  ]?.tradeDate;
  const pctMaps = useMemo<(Map<string, number | null> | null)[]>(
    () => PRESET_INDICES.map((idx) =>
      overlayIndices.has(idx.stockCode)
        ? toPctMap(indexPricesMap[idx.stockCode] ?? [], overlayBaselineTradeDate)
        : null,
    ),
    [indexPricesMap, overlayBaselineTradeDate, overlayIndices],
  );
  const mainPctMap = useMemo(
    () => isOverlayMode ? toPctMap(sortedPrices, overlayBaselineTradeDate) : null,
    [isOverlayMode, overlayBaselineTradeDate, sortedPrices],
  );

  const chartData = useMemo<ChartRow[]>(() => sortedPrices.map((r, idx) => {
    const prevClose = idx > 0 ? sortedPrices[idx - 1]?.close : null;
    const pctChg =
      r.pctChg ??
      (r.close != null && prevClose != null && prevClose > 0
        ? ((r.close - prevClose) / prevClose) * 100
        : null);
    return {
      date: formatDate(r.tradeDate),
      tradeDate: r.tradeDate,
      open: r.open,
      收盘: r.close,
      最高: r.high,
      最低: r.low,
      pctMain: mainPctMap?.get(r.tradeDate) ?? null,
      pct0: pctMaps[0]?.get(r.tradeDate) ?? null,
      pct1: pctMaps[1]?.get(r.tradeDate) ?? null,
      pct2: pctMaps[2]?.get(r.tradeDate) ?? null,
      成交额: r.amount,
      涨跌幅: pctChg,
      换手率: r.turnoverRate ?? null,
      isUp: (r.close ?? 0) >= (r.open ?? 0),
    };
  }), [mainPctMap, pctMaps, sortedPrices]);

  const latestChipTradeDate = chartData.length > 0
    ? chartData[chartData.length - 1].tradeDate
    : null;
  const explicitChipTradeDate = selectedChipTradeDate?.stockCode === selected
    ? selectedChipTradeDate.tradeDate
    : null;
  const activeChipTradeDate = explicitChipTradeDate ?? latestChipTradeDate;
  const displayedChipTradeDate = chipStructureSummary?.tradeDate ?? activeChipTradeDate;
  const hasNormalizedChipFacts = chipStructureSummary != null && [
    chipStructureSummary.winnerRate,
    chipStructureSummary.thickProfitPct,
    chipStructureSummary.trappedPct,
    chipStructureSummary.concentration,
    chipStructureSummary.costDeviationPct,
  ].some((value) => value != null && Number.isFinite(value));
  const shouldOfferChipRefresh = explicitChipTradeDate
    ? !chipStructureSummary || chipStructureSummary.completenessStatus !== "complete"
    : !chipStructureSummary
      || chipStructureSummary.completenessStatus !== "complete"
      || chipStructureSummary.dateRelation === "history"
      || chipStructureSummary.freshnessStatus !== "current";
  const currentChipTsCode = toTsCodeWithSuffix(selected);
  const chipStructureRefreshing = chipStructureRefreshSubmitting
    || chipStructureRefreshTask?.tsCode === currentChipTsCode;
  const chipStructureRefreshFeedbackLabel = chipStructureRefreshFeedback?.text.includes("Tushare")
    ? "需配置 Tushare"
    : chipStructureRefreshFeedback?.tone === "error"
      ? "补齐失败"
      : "仍有数据缺口";

  useEffect(() => {
    const tsCode = toTsCodeWithSuffix(selected);
    if (PRESET_CODES.includes(selected) || !tsCode || !activeChipTradeDate) {
      setChipStructureSummary(null);
      setChipStructureLoading(false);
      setChipStructureError(null);
      return;
    }

    let cancelled = false;
    setChipStructureLoading(true);
    setChipStructureError(null);
    void window.api.chipStructure.getSummaries({
      tsCodes: [tsCode],
      referenceTradeDate: activeChipTradeDate,
      ...(explicitChipTradeDate
        ? { tradeDate: explicitChipTradeDate }
        : { selectionPolicy: "latest_complete" as const }),
    }).then((response) => {
      if (cancelled) return;
      if (response.ok) {
        setChipStructureSummary(response.summaries[0] ?? null);
      } else {
        setChipStructureSummary(null);
        setChipStructureError(response.error.message);
      }
      setChipStructureLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setChipStructureSummary(null);
        setChipStructureError("筹码结构摘要读取失败");
        setChipStructureLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeChipTradeDate, chipStructureReloadKey, explicitChipTradeDate, selected]);

  const handleChipStructureRefresh = useCallback(async () => {
    const tsCode = toTsCodeWithSuffix(selected);
    if (!tsCode || !activeChipTradeDate || chipStructureRefreshing) return;

    setChipStructureError(null);
    setChipStructureRefreshFeedback(null);
    setChipStructureRefreshSubmitting(true);
    const response = await window.api.chipStructure.refresh({
      tsCodes: [tsCode],
      ...(explicitChipTradeDate ? { tradeDate: explicitChipTradeDate } : {}),
      scope: "structure",
      force: true,
    }).catch(() => null);
    if (!response) {
      setChipStructureRefreshSubmitting(false);
      setChipStructureRefreshFeedback({ tone: "error", text: "无法启动筹码结构补齐，请稍后重试" });
      return;
    }
    if (!response.ok) {
      setChipStructureRefreshSubmitting(false);
      setChipStructureRefreshFeedback({ tone: "error", text: response.error.message });
      return;
    }
    const task = { taskId: response.taskId, tsCode };
    chipStructureRefreshTaskRef.current = task;
    setChipStructureRefreshTask(task);
    setChipStructureRefreshSubmitting(false);
  }, [activeChipTradeDate, chipStructureRefreshing, explicitChipTradeDate, selected]);

  useEffect(() => window.api.chipStructure.onDone((result) => {
    const task = chipStructureRefreshTaskRef.current;
    if (!task || task.taskId !== result.taskId) return;
    chipStructureRefreshTaskRef.current = null;
    setChipStructureRefreshTask(null);
    if (result.state === "failed") {
      setChipStructureRefreshFeedback({ tone: "error", text: "筹码结构补齐失败，本地事实已保留" });
    } else if (result.state === "partial") {
      setChipStructureRefreshFeedback({ tone: "warning", text: "补齐完成，但上游仍未返回完整的同日数据" });
    }
    setChipStructureReloadKey((value) => value + 1);
  }), []);

  // FR-087: lightweight-charts daily K-line chart lifecycle
  useEffect(() => {
    if (chartMode !== "daily") {
      if (dailyChartRef.current) {
        dailyChartRef.current.remove();
        dailyChartRef.current = null;
      }
      setLegendData(null);
      setLegendPosition(null);
      return;
    }
    const container = dailyChartContainerRef.current;
    if (!container) return;

    // Destroy previous instance
    if (dailyChartRef.current) {
      dailyChartRef.current.remove();
      dailyChartRef.current = null;
    }

    const chart = createChart(container, {
      layout: {
        background: {
          type: ColorType.Solid,
          color: isDark ? "#111827" : "#ffffff",
        },
        textColor: isDark ? "#d1d5db" : "#6b7280",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: isDark ? "#374151" : "#f0f0f0" },
      },
      leftPriceScale: {
        visible: true,
        borderColor: isDark ? "#374151" : "#e5e7eb",
      },
      rightPriceScale: {
        visible: false,
      },
      timeScale: {
        borderColor: isDark ? "#374151" : "#e5e7eb",
        timeVisible: false,
      },
      localization: {
        locale: "zh-CN",
        dateFormat: "MM月dd日",
      },
      width: container.clientWidth,
      height: container.clientHeight,
    });
    dailyChartRef.current = chart;

    const histSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      color: "#94a3b8",
      priceFormat: {
        type: "custom",
        formatter: (v: number) => formatAmount(v),
        minMove: 1,
      },
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.7, bottom: 0 },
    });
    dailyHistogramSeriesRef.current = histSeries;

    chart.subscribeClick((param) => {
      if (!param.time) return;
      const row = dailyChartRowsByTimeRef.current.get(String(param.time));
      if (row) {
        setSelectedChipTradeDate({ stockCode: selectedRef.current, tradeDate: row.tradeDate });
      }
    });

    if (isOverlayMode) {
      const pctFormat = {
        type: "custom" as const,
        formatter: (price: number) => `${price.toFixed(1)}%`,
        minMove: 0.01,
      };
      const mainLine = chart.addSeries(LineSeries, {
        color: MAIN_STOCK_COLOR,
        lineWidth: 2,
        priceScaleId: "left",
        priceFormat: pctFormat,
        title: "",
      });
      dailyMainLineSeriesRef.current = mainLine;
      dailyOverlaySeriesRefs.current = PRESET_INDICES.map((idx, i) =>
        chart.addSeries(LineSeries, {
          color: OVERLAY_COLORS[i],
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          priceScaleId: "left",
          priceFormat: pctFormat,
          title: idx.stockName,
        }),
      );

      setLegendData(null);
      setLegendPosition(null);
    } else {
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#ef4444",
        downColor: "#22c55e",
        wickUpColor: "#ef4444",
        wickDownColor: "#22c55e",
        borderUpColor: "#ef4444",
        borderDownColor: "#22c55e",
        priceScaleId: "left",
      });
      dailyCandleSeriesRef.current = candleSeries;

      const movingAverages = [
        [5, "#f97316", "MA5"],
        [10, "#3b82f6", "MA10"],
        [20, "#8b5cf6", "MA20 / BOLL中轨"],
        [60, "#a16207", "MA60"],
      ] as const;
      dailyMovingAverageSeriesRefs.current = Object.fromEntries(
        movingAverages.map(([period, color, title]) => [period, chart.addSeries(LineSeries, {
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          lastValueVisible: false,
          priceLineVisible: false,
          title,
        })]),
      );
      dailyBollSeriesRefs.current = {
        bollUpperBfq: chart.addSeries(LineSeries, {
          color: "#ef4444", lineWidth: 1, lineStyle: LineStyle.Dashed,
          lastValueVisible: false, priceLineVisible: false, title: "BOLL上",
        }),
        bollLowerBfq: chart.addSeries(LineSeries, {
          color: "#22c55e", lineWidth: 1, lineStyle: LineStyle.Dashed,
          lastValueVisible: false, priceLineVisible: false, title: "BOLL下",
        }),
      };

      // Crosshair → legend bar
      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.seriesData?.size || !param.point) {
          setLegendData(null);
          setLegendPosition(null);
          return;
        }
        const currentCandle = dailyCandleSeriesRef.current;
        const currentHistogram = dailyHistogramSeriesRef.current;
        if (!currentCandle || !currentHistogram) return;
        const candle = param.seriesData.get(currentCandle);
        const hist = param.seriesData.get(currentHistogram);
        if (candle && "open" in candle) {
          const c = candle as {
            open: number;
            high: number;
            low: number;
            close: number;
          };
          const h = hist as { value: number } | undefined;
          const row = dailyChartRowsByTimeRef.current.get(String(param.time));
          const pctChg = row?.涨跌幅 ?? null;
          const amplitude =
            row?.最高 != null &&
            row.最低 != null &&
            row.open != null &&
            row.open > 0
              ? ((row.最高 - row.最低) / row.open) * 100
              : null;
          const cardWidth = 184;
          const cardHeight = 168;
          const gap = 14;
          const maxLeft = Math.max(8, container.clientWidth - cardWidth - 8);
          const maxTop = Math.max(8, container.clientHeight - cardHeight - 8);
          const nextLeft =
            param.point.x + gap + cardWidth > container.clientWidth
              ? param.point.x - cardWidth - gap
              : param.point.x + gap;
          const nextTop =
            param.point.y + gap + cardHeight > container.clientHeight
              ? param.point.y - cardHeight - gap
              : param.point.y + gap;
          setLegendData({
            date: String(param.time),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            amount: h?.value ?? 0,
            turnoverRate: row?.换手率 ?? null,
            pctChg,
            amplitude,
            isUp: pctChg != null ? pctChg >= 0 : c.close >= c.open,
          });
          setLegendPosition({
            left: Math.min(maxLeft, Math.max(8, nextLeft)),
            top: Math.min(maxTop, Math.max(8, nextTop)),
          });
        }
      });
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      container.dataset.visibleLogicalFrom = range ? String(range.from) : "";
      const code = selectedRef.current;
      const entry = historyCacheRef.current.get(code);
      const visibleRows = countVisibleRows(range, entry?.rows.length ?? 0);
      if (visibleRows !== visibleHistoryBarsRef.current) {
        visibleHistoryBarsRef.current = visibleRows;
        setVisibleHistoryBars(visibleRows);
      }
      if (!historyRangeReadyRef.current) return;
      if (pendingLogicalRangeRef.current) return;
      if (dailyVisibleStockRef.current !== code) return;
      const nextSelection = resolveHistoryRangeSelection(
        visibleRows,
        entry?.rows.length ?? 0,
        Boolean(entry?.hasMore),
      );
      if (nextSelection !== historyRangeSelectionRef.current) {
        historyRangeSelectionRef.current = nextSelection;
        setHistoryRangeSelection(nextSelection);
      }
      const loadingOlder = olderHistoryInflightRef.current.has(code);
      if (shouldLoadOlderHistory(range, Boolean(entry?.hasMore), loadingOlder)) {
        loadOlderHistoryRef.current();
      }
    });

    // ResizeObserver for responsive sizing
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          const preservedRange = chart.timeScale().getVisibleLogicalRange();
          chart.applyOptions({ width, height });
          if (preservedRange) {
            chart.timeScale().setVisibleLogicalRange(preservedRange);
          }
        }
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      dailyCandleSeriesRef.current = null;
      dailyHistogramSeriesRef.current = null;
      dailyMainLineSeriesRef.current = null;
      dailyOverlaySeriesRefs.current = [null, null, null];
      dailyMovingAverageSeriesRefs.current = {};
      dailyBollSeriesRefs.current = {};
      dailyVisibleStockRef.current = null;
      historyRangeReadyRef.current = false;
      if (historyRangeReadyFrameRef.current != null) {
        cancelAnimationFrame(historyRangeReadyFrameRef.current);
        historyRangeReadyFrameRef.current = null;
      }
      smcMarkersRef.current = null; // series 已销毁， primitive 失效
      if (dailyChartRef.current === chart) {
        chart.remove();
        dailyChartRef.current = null;
      }
    };
  }, [chartMode, isDark, isOverlayMode, loading]);

  // 切股和增量补历史只更新 series 数据，不销毁图表实例。
  useEffect(() => {
    if (chartMode !== "daily" || !dailyChartRef.current) return;
    historyRangeReadyRef.current = false;
    if (historyRangeReadyFrameRef.current != null) {
      cancelAnimationFrame(historyRangeReadyFrameRef.current);
      historyRangeReadyFrameRef.current = null;
    }
    const effectiveData = priceDataCode === selected ? chartData : [];
    dailyChartRowsByTimeRef.current = new Map(
      effectiveData.map((row) => [toISODate(row.tradeDate), row]),
    );

    dailyHistogramSeriesRef.current?.setData(effectiveData
      .filter((row) => row.成交额 != null)
      .map((row) => ({
        time: toISODate(row.tradeDate) as Time,
        value: row.成交额!,
        color: row.isUp ? "rgba(239, 68, 68, 0.5)" : "rgba(34, 197, 94, 0.5)",
      })));

    if (isOverlayMode) {
      dailyMainLineSeriesRef.current?.applyOptions({ title: selectedItem?.stockName ?? selected });
      dailyMainLineSeriesRef.current?.setData(effectiveData
        .filter((row) => row.pctMain != null)
        .map((row) => ({ time: toISODate(row.tradeDate) as Time, value: row.pctMain! })));
      PRESET_INDICES.forEach((index, position) => {
        const key = `pct${position}` as "pct0" | "pct1" | "pct2";
        dailyOverlaySeriesRefs.current[position]?.setData(
          overlayIndices.has(index.stockCode)
            ? effectiveData
                .filter((row) => row[key] != null)
                .map((row) => ({ time: toISODate(row.tradeDate) as Time, value: row[key] as number }))
            : [],
        );
      });
    } else {
      dailyCandleSeriesRef.current?.setData(effectiveData
        .filter((row) => row.收盘 != null && row.open != null && row.最高 != null && row.最低 != null)
        .map((row) => ({
          time: toISODate(row.tradeDate) as Time,
          open: row.open!, high: row.最高!, low: row.最低!, close: row.收盘!,
        })));
      const movingAverageRows = effectiveData.map((row) => ({
        tradeDate: row.tradeDate,
        close: row.收盘 ?? Number.NaN,
      }));
      for (const period of [5, 10, 20, 60]) {
        dailyMovingAverageSeriesRefs.current[period]?.setData(
          buildMovingAverageSeries(movingAverageRows, period).map((point) => ({
            time: toISODate(point.tradeDate) as Time,
            value: point.value,
          })),
        );
      }
      const bollingerRows = buildBollingerBandSeries(movingAverageRows);
      const bollingerKeys = {
        bollUpperBfq: "upper",
        bollLowerBfq: "lower",
      } as const;
      for (const [seriesKey, valueKey] of Object.entries(bollingerKeys)) {
        dailyBollSeriesRefs.current[seriesKey]?.setData(
          bollingerRows.map((point) => ({
            time: toISODate(point.tradeDate) as Time,
            value: point[valueKey],
          })),
        );
      }
    }

    if (effectiveData.length === 0) return;
    const requestedPreset = pendingHistoryRangePresetRef.current;
    const pending = pendingLogicalRangeRef.current;
    if (requestedPreset) {
      const range = visibleLogicalRange(effectiveData.length, requestedPreset);
      dailyChartRef.current.timeScale().setVisibleLogicalRange(range);
      const visibleRows = countVisibleRows(range, effectiveData.length);
      visibleHistoryBarsRef.current = visibleRows;
      setVisibleHistoryBars(visibleRows);
      historyRangeSelectionRef.current = requestedPreset;
      setHistoryRangeSelection(requestedPreset);
      pendingHistoryRangePresetRef.current = null;
      pendingLogicalRangeRef.current = null;
      dailyVisibleStockRef.current = selected;
    } else if (pending) {
      const shifted = shiftLogicalRange(pending.range, pending.addedBefore);
      if (shifted) {
        dailyChartRef.current.timeScale().setVisibleLogicalRange(shifted);
        const visibleRows = countVisibleRows(shifted, effectiveData.length);
        visibleHistoryBarsRef.current = visibleRows;
        setVisibleHistoryBars(visibleRows);
      }
      pendingLogicalRangeRef.current = null;
    } else if (dailyVisibleStockRef.current !== selected) {
      const selection = historyRangeSelectionRef.current;
      const target = selection === "custom"
        ? Math.max(1, visibleHistoryBarsRef.current || DEFAULT_VISIBLE_BARS)
        : selection;
      const range = selection === DEFAULT_VISIBLE_BARS
        ? defaultVisibleLogicalRange(effectiveData.length)
        : visibleLogicalRange(effectiveData.length, target);
      dailyChartRef.current.timeScale().setVisibleLogicalRange(range);
      const visibleRows = countVisibleRows(range, effectiveData.length);
      visibleHistoryBarsRef.current = visibleRows;
      setVisibleHistoryBars(visibleRows);
      dailyVisibleStockRef.current = selected;
    }
    historyRangeReadyFrameRef.current = requestAnimationFrame(() => {
      historyRangeReadyFrameRef.current = requestAnimationFrame(() => {
        historyRangeReadyRef.current = true;
        historyRangeReadyFrameRef.current = null;
      });
    });
  }, [chartData, chartMode, isDark, isOverlayMode, overlayIndices, priceDataCode, selected, selectedItem?.stockName]);

  // T622: SMC 结构分析叠加层 useEffect
  useEffect(() => {
    const series = dailyCandleSeriesRef.current;
    // 清除旧 markers（v5: createSeriesMarkers primitive）
    if (smcMarkersRef.current) {
      try { smcMarkersRef.current.setMarkers([]); } catch { /* series 已销毁 */ }
      smcMarkersRef.current = null;
    }
    // 清除旧 price lines
    smcPriceLinesRef.current.forEach((l) => {
      try { series?.removePriceLine(l); } catch { /* 图表已销毁时忽略 */ }
    });
    smcPriceLinesRef.current = [];
    if (!series || prices.length === 0 || smcSwingN === 0) return;
    // 构造 OHLCVBar 数组（过滤掉 null 字段）
    const bars = [...prices]
      .filter((r) => r.open != null && r.high != null && r.low != null && r.close != null)
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
      .map((r) => ({
        time: toISODate(r.tradeDate),
        open: r.open!,
        high: r.high!,
        low: r.low!,
        close: r.close!,
      }));
    const result = computeSMC(bars, smcSwingN);
    // 构造 markers（摆动高/低点 + 买卖信号）
    const markers: SeriesMarker<Time>[] = [];
    for (const sp of result.swingHighs) {
      const isHH = sp.label === "HH";
      markers.push({
        time: sp.time as Time,
        position: "aboveBar",
        shape: "circle",
        color: sp.confirmed ? (isHH ? "#ef4444" : "#f97316") : "#9ca3af",
        text: sp.confirmed ? sp.label : sp.label + "?",
        size: 1,
      });
    }
    for (const sp of result.swingLows) {
      const isHL = sp.label === "HL";
      markers.push({
        time: sp.time as Time,
        position: "belowBar",
        shape: "circle",
        color: sp.confirmed ? (isHL ? "#22c55e" : "#15803d") : "#9ca3af",
        text: sp.confirmed ? sp.label : sp.label + "?",
        size: 1,
      });
    }
    for (const sig of result.signals) {
      if (sig.signalType === "buy") {
        markers.push({
          time: sig.time as Time,
          position: "belowBar",
          shape: "arrowUp",
          color: "#22c55e",
          text: `买${sig.count}`,
          size: 2,
        });
      } else {
        markers.push({
          time: sig.time as Time,
          position: "aboveBar",
          shape: "arrowDown",
          color: "#ef4444",
          text: `卖${sig.count}`,
          size: 2,
        });
      }
    }
    // createSeriesMarkers 要求按 time 升序（lightweight-charts v5 API）
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    smcMarkersRef.current = createSeriesMarkers(series, markers);
    // CHoCH price lines（最多显示最近 3 条，避免图表过于杂乱）
    const recentEvents = result.events.slice(-3);
    smcPriceLinesRef.current = recentEvents.map((ev) =>
      series.createPriceLine({
        price: ev.level,
        color: ev.direction === "bullish" ? "#f97316" : "#3b82f6",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "CHoCH",
      }),
    );
  }, [chartMode, isDark, isOverlayMode, smcSwingN, prices, selected]);

  // T617: lwc 分时蜡烛图 lifecycle
  useEffect(() => {
    if (chartMode !== "intraday" || intradayOHLCV.length === 0) {
      if (intradayChartRef.current) {
        intradayChartRef.current.remove();
        intradayChartRef.current = null;
      }
      return;
    }
    const isLineStyle = intradayStyle === "line";
    const container = intradayLwcContainerRef.current;
    if (!container) return;
    if (intradayChartRef.current) {
      intradayChartRef.current.remove();
      intradayChartRef.current = null;
    }
    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: isDark ? "#111827" : "#ffffff" },
        textColor: isDark ? "#d1d5db" : "#6b7280",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: isDark ? "#1f2937" : "#f0f0f0" },
        horzLines: { color: isDark ? "#1f2937" : "#f0f0f0" },
      },
      rightPriceScale: { borderColor: isDark ? "#374151" : "#e5e7eb" },
      timeScale: {
        borderColor: isDark ? "#374151" : "#e5e7eb",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: unknown) => {
          if (typeof time !== "number") return String(time);
          const d = new Date((time as number) * 1000);
          return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
        },
      },
      width: container.clientWidth,
      height: container.clientHeight,
    });
    intradayChartRef.current = chart;

    const volSeries = chart.addSeries(HistogramSeries, {
      color: "rgba(148,163,184,0.5)",
      priceScaleId: "vol",
      priceFormat: { type: "volume" as const },
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });

    // 专业版：蜡烛图；传统版：区域折线图
    const priceSeries = isLineStyle
      ? chart.addSeries(AreaSeries, {
          lineColor: isDark ? "#60a5fa" : "#3b82f6",
          topColor: isDark ? "rgba(96,165,250,0.25)" : "rgba(59,130,246,0.2)",
          bottomColor: "rgba(0,0,0,0)",
          lineWidth: 2,
          crosshairMarkerVisible: true,
        })
      : chart.addSeries(CandlestickSeries, {
          upColor: "#ef4444",
          downColor: "#22c55e",
          wickUpColor: "#ef4444",
          wickDownColor: "#22c55e",
          borderUpColor: "#ef4444",
          borderDownColor: "#22c55e",
        });

    const vwapSeries = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: "VWAP",
      lastValueVisible: false,
    });

    // 将 HH:mm 转为当日 Unix 时间戳
    const todayStr = getTodayBJDate(); // YYYY-MM-DD
    const [ty, tm, td] = todayStr.split("-").map(Number);
    const toTs = (tsMinute: string): Time => {
      const [hh, mm] = tsMinute.split(":").map(Number);
      return Math.floor(Date.UTC(ty, tm - 1, td, hh, mm, 0) / 1000) as Time;
    };

    if (isLineStyle) {
      priceSeries.setData(
        intradayOHLCV.map((r) => ({
          time: toTs(r.tsMinute),
          value: r.close,
        })),
      );
    } else {
      priceSeries.setData(
        intradayOHLCV.map((r) => ({
          time: toTs(r.tsMinute),
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
        })),
      );
    }
    volSeries.setData(
      intradayOHLCV.map((r) => ({
        time: toTs(r.tsMinute),
        value: r.vol,
        color: r.close >= r.open ? "rgba(239,68,68,0.5)" : "rgba(34,197,94,0.5)",
      })),
    );
    let cumVol = 0,
      cumPV = 0;
    vwapSeries.setData(
      intradayOHLCV.map((r) => {
        cumVol += r.vol;
        cumPV += r.close * r.vol;
        return { time: toTs(r.tsMinute), value: cumVol > 0 ? cumPV / cumVol : r.close };
      }),
    );

    // AI 预测线叠加
    const curForecast = forecastCache[selected] ?? null;
    const curProviders = (curForecast as { byProvider?: Record<string, { today?: { time: string; price: number }[] }> })
      ?.byProvider ?? {};
    const activeKeys = Object.keys(curProviders).filter((p) => checkedProviders.has(p));
    for (let i = 0; i < activeKeys.length; i++) {
      const pData = curProviders[activeKeys[i]];
      if (!pData?.today) continue;
      const predSeries = chart.addSeries(LineSeries, {
        color: FORECAST_COLORS[i % FORECAST_COLORS.length],
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        lastValueVisible: false,
      });
      const predData = pData.today
        .map((fp) => ({ time: toTs(fp.time), value: fp.price }))
        .sort((a, b) => (a.time as number) - (b.time as number));
      if (predData.length > 0) predSeries.setData(predData);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && intradayChartRef.current === chart) {
          chart.applyOptions({ width, height });
        }
      }
    });
    ro.observe(container);
    return () => {
      ro.disconnect();
      if (intradayChartRef.current === chart) {
        chart.remove();
        intradayChartRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartMode, intradayStyle, intradayOHLCV, isDark, forecastCache, selected, checkedProviders]);

  // T619: 筹码画布绘制
  useEffect(() => {
    if (!chipsOpen || !chipsData || chipsData.length === 0 || !chipsCanvasRef.current) return;
    const canvas = chipsCanvasRef.current;
    const container = canvas.parentElement;
    if (!container) return;
    const w = container.clientWidth || 176;
    const h = container.clientHeight || 400;
    const currentPrice =
      prices.length > 0 ? (prices[prices.length - 1].close ?? null) : null;
    drawChipsCanvas(canvas, chipsData, currentPrice, w, h);
  }, [chipsOpen, chipsData, prices]);

  // T619/T620: 筹码 + 技术因子懒加载（切换股票时触发）
  useEffect(() => {
    const tsCode = toTsCodeWithSuffix(selected);
    if (!tsCode) {
      setChipsData(null);
      setFactorData(null);
      return;
    }
    let cancelled = false;
    setChipsLoading(true);
    void (window.api.shortTerm as unknown as {
      getStockChips: (tsCode: string) => Promise<{ ok: boolean; data?: ChipPoint[] }>;
    })
      .getStockChips(tsCode)
      .then((res) => {
        if (!cancelled) {
          setChipsData(res?.ok && Array.isArray(res.data) ? res.data : null);
          setChipsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setChipsLoading(false);
      });
    void (window.api.shortTerm as unknown as {
      getStockFactor: (tsCode: string) => Promise<{ ok: boolean; data?: FactorData }>;
    })
      .getStockFactor(tsCode)
      .then((res) => {
        if (!cancelled) setFactorData(res?.ok ? (res.data ?? null) : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      data-testid="stock-chart-root"
      data-history-count={prices.length}
      data-history-has-more={hasOlderPrices ? "true" : "false"}
      data-history-visible-count={visibleHistoryBars}
      data-history-range-selection={historyRangeSelection}
      className="flex flex-1 min-h-0 overflow-hidden"
    >
      {/* ── Left: stock list ── */}
      <div className="w-52 border-r border-gray-200 dark:border-gray-700 flex flex-col flex-shrink-0 overflow-hidden">
        {/* Preset indices header */}
        <div className="px-3 py-1.5 text-xs font-medium text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
          市场指数
        </div>

        {PRESET_INDICES.map((idx) => (
          <button
            key={idx.stockCode}
            onClick={() => setSelected(idx.stockCode)}
            className={[
              "w-full text-left px-3 py-2 border-b border-gray-50 dark:border-gray-700 shrink-0",
              selected === idx.stockCode
                ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700"
                : "text-gray-700 dark:text-gray-300 dark:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800",
            ].join(" ")}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium truncate">
                {idx.stockName}
              </span>
              <span className="text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-600 shrink-0">
                指数
              </span>
            </div>
            <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
              {idx.stockCode}
            </div>
          </button>
        ))}

        {/* Regular stocks header */}
        <div className="px-3 py-1.5 text-xs font-medium text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
          已缓存个股
        </div>

        {/* FR-069: Manual stock search — 支持中文 / 代码模糊搜索 */}
        <div ref={searchBoxRef} className="px-2 py-1.5 border-b border-gray-100 dark:border-gray-700 shrink-0 relative">
          <input
            type="text"
            value={searchCode}
            onChange={(e) => {
              const val = e.target.value;
              setSearchCode(val);
              setSearchError("");
              setStockDataStatus(null);
              if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
              if (!val.trim()) {
                setCandidates([]);
                setShowCandidates(false);
                setCandidateEmpty(false);
                return;
              }
              searchDebounceRef.current = setTimeout(async () => {
                try {
                  await querySearchCandidates(val.trim());
                } catch {
                  /* 搜索失败静默处理 */
                }
              }, 200);
            }}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => {
              if (candidates.length > 0 || candidateEmpty) setShowCandidates(true);
            }}
            onBlur={() => {
              // 延迟关闭，确保点击候选项时 blur 不先关闭列表
              setTimeout(() => setShowCandidates(false), 150);
            }}
            placeholder="输入公司名或股票代码"
            disabled={searching}
            className="w-full text-xs px-2 py-1 border border-gray-200 dark:border-gray-700 rounded outline-none focus:border-blue-400 disabled:opacity-50"
          />
          {searching && (
            <p className="text-[10px] text-blue-500 mt-0.5">查询中…</p>
          )}
          {searchError && (
            <p className="text-[10px] text-red-500 mt-0.5">{searchError}</p>
          )}
          {stockDataStatus?.stockCode === selected && !searchError && (
            <p
              role="status"
              aria-live="polite"
              data-testid="stock-data-source-status"
              data-provider={stockDataStatus.provider}
              data-state={stockDataStatus.dataState}
              data-benchmark-state={stockDataStatus.benchmark?.state}
              className={[
                "mt-1 text-[10px] leading-4",
                stockDataStatus.dataState === "complete"
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-amber-700 dark:text-amber-300",
              ].join(" ")}
            >
              {stockDataStatus.message}
              {stockDataStatus.benchmark?.state === "current" ? " · 沪深300基准已对齐" : ""}
              {stockDataStatus.dataState === "degraded" ? " · 长期指标仍待补" : ""}
            </p>
          )}
          {/* 候选下拉列表 */}
          {showCandidates && (
            <div className="absolute left-2 right-2 top-full mt-0.5 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg max-h-56 overflow-y-auto">
              {candidateEmpty ? (
                <div className="px-3 py-2 text-[10px] text-gray-500 dark:text-gray-400 leading-relaxed">
                  <div className="mb-2">
                    尚未同步股票基础数据，名称搜索暂不可用。
                  </div>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void handleSyncStockBasic()}
                    disabled={stockBasicSyncing}
                    className="w-full rounded bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {stockBasicSyncing ? "正在触发同步…" : "立即同步股票基础数据"}
                  </button>
                </div>
              ) : candidates.length === 0 ? (
                <div className="px-3 py-2 text-[10px] text-gray-400 dark:text-gray-500">未找到匹配结果</div>
              ) : (
                candidates.map((c) => (
                  <button
                    key={c.tsCode}
                    onMouseDown={(e) => e.preventDefault()} // 阻止 blur 先于 click 触发
                    onClick={() => void handleSelectCandidate(c)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                  >
                    <span className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate flex-1">{c.name}</span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">{c.tsCode.split(".")[0]}</span>
                    {c.market && (
                      <span className="text-[10px] text-gray-300 dark:text-gray-600 shrink-0">{c.market}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {regularStocks.length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-400 dark:text-gray-500">
              暂无数据
              <br />
              完成一次 AI 分析后自动抓取
            </div>
          ) : (
            <DndContext
              sensors={dndSensors}
              onDragEnd={(event: DragEndEvent) => {
                const { active, over } = event;
                if (!over || active.id === over.id) return;
                if (portfolioSet.has(String(active.id)) || portfolioSet.has(String(over.id))) return;
                setRegularStocks((prev) => {
                  const oldIdx = prev.findIndex((s) => s.stockCode === active.id);
                  const newIdx = prev.findIndex((s) => s.stockCode === over.id);
                  const next = arrayMove(prev, oldIdx, newIdx);
                  saveSortOrder(next.map((s) => s.stockCode));
                  return next;
                });
              }}
            >
              <SortableContext
                items={displayStocks.map((s) => s.stockCode)}
                strategy={verticalListSortingStrategy}
              >
                {displayStocks.map((s) => (
                  <SortableStockItem
                    key={s.stockCode}
                    stock={s}
                    isSelected={selected === s.stockCode}
                    isPortfolio={portfolioSet.has(s.stockCode)}
                    displayName={
                      pendingDisplay && pendingDisplay.code === s.stockCode
                        ? pendingDisplay.name
                        : s.stockName
                    }
                    onSelect={() => setSelected(s.stockCode)}
                    onDelete={() => handleDeleteStock(s.stockCode)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* Clear all button */}
        {regularStocks.length > 0 && (
          <button
            onClick={handleClearAll}
            className="w-full py-2 text-xs text-red-600/70 dark:text-red-300/70 hover:text-red-700 dark:hover:text-red-200 hover:bg-red-50 dark:hover:bg-red-900/30 border-t border-gray-100 dark:border-gray-700 transition-colors shrink-0"
          >
            清除全部个股
          </button>
        )}
      </div>

      {/* ── Right: chart area ── */}
      <div className="flex-1 min-h-0 flex flex-col p-3 overflow-hidden">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
            加载中…
          </div>
        ) : prices.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <div className="text-sm text-gray-400 dark:text-gray-500">
              暂无 {selectedItem?.stockName ?? selected} 的行情数据
            </div>
            {firstPortfolioJourney && !PRESET_CODES.includes(selected) && (
              <>
                <PortfolioJourneyBanner
                  journey={firstPortfolioJourney}
                  selectedCode={selected}
                  stockName={selectedItem?.stockName ?? selected}
                  isInPortfolio={isInPortfolio}
                  onEditCostPrice={() => setCostEditorOpen(true)}
                  onReturnToPortfolio={finishFirstPortfolioJourney}
                  onCancel={clearFirstPortfolioJourney}
                />
                {!isInPortfolio && (
                  <button
                    type="button"
                    data-testid="portfolio-toggle-btn"
                    onClick={() => void handleTogglePortfolio()}
                    disabled={portfolioSaving}
                    className="rounded border border-cyan-700 bg-cyan-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {portfolioSaving ? "处理中..." : "+ 持仓"}
                  </button>
                )}
                {portfolioError && (
                  <div data-testid="portfolio-toggle-error" className="text-xs text-red-600 dark:text-red-400">{portfolioError}</div>
                )}
              </>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="text-xs px-3 py-1.5 rounded border border-blue-300 text-blue-500 hover:bg-blue-50 dark:bg-blue-900/30 disabled:opacity-50 transition-colors"
            >
              {refreshing ? "拉取中…" : "立即拉取"}
            </button>
          </div>
        ) : (
          <>
            {/* Header row */}
            <div className="flex items-center gap-2 mb-2 shrink-0 flex-wrap">
              <span className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {selectedItem?.stockName ?? selected}
              </span>
              <span className="text-sm text-gray-400 dark:text-gray-500">
                {selected}
              </span>
              {chartMode === "daily" && (
                <div className="flex items-center gap-1.5">
                  <span
                    data-testid="stock-chart-history-summary"
                    className="whitespace-nowrap text-xs tabular-nums text-gray-500 dark:text-gray-400"
                  >
                    当前 {visibleHistoryBars || Math.min(DEFAULT_VISIBLE_BARS, prices.length)} 日
                    <span className="px-1 text-gray-300 dark:text-gray-600">·</span>
                    已加载 {prices.length} 日
                  </span>
                  <div
                    role="group"
                    aria-label="日K展示周期"
                    data-testid="stock-chart-history-range"
                    className="flex h-7 items-center rounded border border-gray-200 bg-gray-50 p-0.5 dark:border-gray-700 dark:bg-gray-800"
                  >
                    {[...HISTORY_RANGE_PRESETS, "all" as const].map((preset) => {
                      const active = historyRangeSelection === preset;
                      const label = preset === "all" ? "全部" : `${preset}日`;
                      return (
                        <button
                          key={String(preset)}
                          type="button"
                          data-testid={`stock-chart-history-${preset}`}
                          aria-label={preset === "all" ? "显示全部本地日K" : `显示最近${preset}个交易日`}
                          aria-pressed={active}
                          disabled={loadingOlderCode === selected}
                          onClick={() => void handleHistoryRangeChange(preset)}
                          className={`h-6 min-w-[38px] rounded-sm px-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-1 disabled:cursor-wait disabled:opacity-50 ${
                            active
                              ? "bg-white text-cyan-700 shadow-sm dark:bg-gray-700 dark:text-cyan-300"
                              : "text-gray-500 hover:bg-white hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {historyRangeError && (
                <span role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {historyRangeError}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2 flex-wrap">
                {/* T622: SMC 结构分析 select（日线模式时显示） */}
                <select
                  className={`text-xs border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5 bg-white dark:bg-gray-800 dark:text-gray-200 ${
                    chartMode !== "daily" ? "invisible" : ""
                  }`}
                  value={smcSwingN}
                  onChange={(e) => {
                    const v = Number(e.target.value) as 0 | 2 | 3 | 5;
                    setSmcSwingN(v);
                    localStorage.setItem("smcSwingN", String(v));
                  }}
                >
                  <option value={0}>SMC 关</option>
                  <option value={2}>灵敏度 2</option>
                  <option value={3}>灵敏度 3</option>
                  <option value={5}>灵敏度 5</option>
                </select>
                {/* FR-070: daily / intraday toggle */}
                {/* FR-168: 持仓按钮（仅非预设指数显示）*/}
                {!PRESET_CODES.includes(selected) && (
                  <button
                    data-testid="portfolio-toggle-btn"
                    onClick={() => void handleTogglePortfolio()}
                    disabled={portfolioSaving}
                    className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                      isInPortfolio
                        ? "border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100 dark:bg-orange-900/30 dark:border-orange-600 dark:text-orange-400"
                        : "border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                    title={isInPortfolio ? "从持仓移除" : "加入持仓"}
                  >
                    {portfolioSaving ? "处理中..." : isInPortfolio ? "✓ 持仓" : "+ 持仓"}
                  </button>
                )}
                {!PRESET_CODES.includes(selected) && (
                  <button
                    type="button"
                    data-testid="stock-fundamental-open"
                    onClick={() => setFundamentalDrawerOpen(true)}
                    className="relative h-7 rounded border border-gray-200 bg-white px-2.5 text-xs font-medium text-gray-600 transition-colors after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 focus-visible:ring-offset-1 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-cyan-700 dark:hover:bg-cyan-950/30 dark:hover:text-cyan-300 motion-reduce:transition-none"
                  >
                    基本面
                  </button>
                )}
                <button
                  data-testid="chart-mode-toggle-btn"
                  onClick={handleToggleChartMode}
                  disabled={intradayLoading}
                  className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 disabled:opacity-50 transition-colors"
                >
                  {chartMode === "daily" ? "分时图" : "日线图"}
                </button>
                {/* 分时图样式切换：专业版（蜡烛）/ 传统版（折线）*/}
                {chartMode === "intraday" && !PRESET_CODES.includes(selected) && (
                  <button
                    onClick={() => {
                      setIntradayStyle((prev) => {
                        const next = prev === "candle" ? "line" : "candle";
                        localStorage.setItem("intradayStyle", next);
                        return next;
                      });
                    }}
                    className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 transition-colors"
                    title={intradayStyle === "candle" ? "切换到传统折线分时图" : "切换到专业蜡烛分时图"}
                  >
                    {intradayStyle === "candle" ? "传统版" : "专业版"}
                  </button>
                )}
                {/* FR-072: predict trend hover dropdown — only in intraday mode */}
                {chartMode === "intraday" && (
                  <div className="relative group/forecast">
                    <button
                      data-testid="forecast-menu-btn"
                      disabled={forecasting}
                      className="text-xs px-2.5 py-1 rounded border border-orange-300 text-orange-600 hover:bg-orange-50 disabled:opacity-50 transition-colors flex items-center gap-1"
                    >
                      {forecasting ? (
                        <>
                          <span className="inline-block w-3 h-3 border border-orange-400 border-t-transparent rounded-full animate-spin" />
                          预测中…
                        </>
                      ) : (
                        <>
                          预测走势 <span className="text-[10px]">▾</span>
                        </>
                      )}
                    </button>
                    {/* Dropdown menu */}
                    <div className="absolute right-0 top-full mt-0.5 w-28 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded shadow-lg z-20 hidden group-hover/forecast:block">
                      <button
                        onClick={() => { void handlePredictTrendToday(true) }}
                        disabled={
                          forecasting || !isTradingWeekday() || !isBeforeClose()
                        }
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-orange-50 text-orange-700 dark:text-orange-300 disabled:text-orange-300/60 dark:disabled:text-orange-200/40 disabled:cursor-not-allowed transition-colors"
                      >
                        预测今日
                      </button>
                      <button
                        onClick={handlePredictTrendMorrow}
                        disabled={forecasting}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-purple-50 text-purple-700 disabled:opacity-50 transition-colors"
                      >
                        预测明日
                      </button>
                      <div className="border-t border-gray-100 dark:border-gray-700 mx-2" />
                      <button
                        onClick={handleClearForecast}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors"
                      >
                        清除预测
                      </button>
                    </div>
                  </div>
                )}
                {/* FR-076: forecast panel button — always visible */}
                <button
                  onClick={() => setIsForecastPanelOpen(true)}
                  data-testid="forecast-panel-btn"
                  className="text-xs px-2.5 py-1 rounded border border-purple-200 text-purple-600 hover:bg-purple-50 transition-colors"
                >
                  预测面板
                </button>
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 disabled:opacity-50 transition-colors flex items-center gap-1"
                >
                  {refreshing ? (
                    <>
                      <span className="inline-block w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
                      更新中…
                    </>
                  ) : (
                    "更新数据"
                  )}
                </button>
              </div>
            </div>

            {portfolioMessage && !firstPortfolioJourney && (
              <div className="mb-2 shrink-0 text-xs text-emerald-600 dark:text-emerald-400">{portfolioMessage}</div>
            )}
            {portfolioError && (
              <div data-testid="portfolio-toggle-error" className="mb-2 shrink-0 text-xs text-red-600 dark:text-red-400">{portfolioError}</div>
            )}
            {firstPortfolioJourney && !PRESET_CODES.includes(selected) && (
              <PortfolioJourneyBanner
                journey={firstPortfolioJourney}
                selectedCode={selected}
                stockName={selectedItem?.stockName ?? selected}
                isInPortfolio={isInPortfolio}
                onEditCostPrice={() => setCostEditorOpen(true)}
                onReturnToPortfolio={finishFirstPortfolioJourney}
                onCancel={clearFirstPortfolioJourney}
              />
            )}

            {!PRESET_CODES.includes(selected) && (
              <div
                data-testid="stock-chip-structure-summary"
                className="mb-2 flex min-h-8 shrink-0 items-center gap-2 border-y border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300"
              >
                <button
                  type="button"
                  onClick={() => setSelectedChipTradeDate(null)}
                  className="shrink-0 font-medium text-slate-800 hover:text-blue-600 dark:text-slate-100 dark:hover:text-blue-400"
                  title="恢复到最新日 K 交易日"
                >
                  筹码结构 截至 {formatChipTradeDate(displayedChipTradeDate)}
                </button>
                {selectedChipTradeDate?.stockCode === selected && (
                  <span className="shrink-0 rounded bg-blue-100 px-1 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                    已选日
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap" aria-live="polite">
                  {chipStructureLoading ? (
                    <span className="inline-flex items-center gap-1.5 text-slate-400">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500 motion-reduce:animate-none dark:border-slate-600 dark:border-t-blue-400" aria-hidden="true" />
                      读取中
                    </span>
                  ) : chipStructureError ? (
                    <InfoTip content={chipStructureError} placement="top">
                      <span className="cursor-help text-red-500">{chipStructureError}</span>
                    </InfoTip>
                  ) : !hasNormalizedChipFacts ? (
                    <InfoTip
                      content={formatChipMissingReasons(chipStructureSummary?.missingReasons)}
                      placement="top"
                    >
                      <span className="cursor-help text-slate-500 dark:text-slate-400">暂无可归一化筹码事实</span>
                    </InfoTip>
                  ) : (
                    <>
                      <span>获利 {formatRatioPercent(chipStructureSummary.winnerRate)}</span>
                      <span>厚浮盈 {formatRatioPercent(chipStructureSummary.thickProfitPct)}</span>
                      <span>套牢 {formatRatioPercent(chipStructureSummary.trappedPct)}</span>
                      <span>集中 {formatRatioPercent(chipStructureSummary.concentration)}</span>
                      <span>偏离 {formatPercent(chipStructureSummary.costDeviationPct)}</span>
                      {chipStructureSummary.primaryChange && (
                        <span>
                          {CHIP_METRIC_LABELS[chipStructureSummary.primaryChange.metric]}
                          {chipStructureSummary.primaryChange.days}日 {formatPercent(chipStructureSummary.primaryChange.value)}
                        </span>
                      )}
                      <InfoTip
                        content={chipStructureSummary.completenessStatus === "complete"
                          ? `三个来源已按 ${formatChipTradeDate(chipStructureSummary.tradeDate)} 同日对齐并统一为百分比口径`
                          : formatChipMissingReasons(chipStructureSummary.missingReasons)}
                        placement="top"
                      >
                        <span className={chipStructureSummary.completenessStatus === "complete" ? "text-emerald-600 dark:text-emerald-400" : "cursor-help text-amber-600 dark:text-amber-400"}>
                          {chipStructureSummary.completenessStatus === "complete" ? "同日归一" : "部分归一"}
                        </span>
                      </InfoTip>
                      <InfoTip
                        content={chipStructureSummary.consistencyStatus === "matched"
                          ? "官方获利比例与价格级筹码重算值偏差不超过 3 个百分点"
                          : chipStructureSummary.consistencyStatus === "warning"
                            ? "官方获利比例与价格级筹码重算值偏差超过 3 个百分点"
                            : "当前事实不足以核验两种获利比例口径"}
                        placement="top"
                      >
                        <span className={chipStructureSummary.consistencyStatus === "matched" ? "text-emerald-600 dark:text-emerald-400" : chipStructureSummary.consistencyStatus === "warning" ? "cursor-help text-amber-600 dark:text-amber-400" : "cursor-help text-slate-500 dark:text-slate-400"}>
                          {chipStructureSummary.consistencyStatus === "matched" ? "口径一致" : chipStructureSummary.consistencyStatus === "warning" ? "口径偏差" : "一致性待核验"}
                        </span>
                      </InfoTip>
                      {chipStructureSummary.dateRelation === "history" && (
                        <span className="text-amber-600 dark:text-amber-400">历史参考</span>
                      )}
                    </>
                  )}
                </div>
                {chipStructureRefreshFeedback && (
                  <InfoTip content={chipStructureRefreshFeedback.text} placement="top">
                    <span
                      data-testid="stock-chip-structure-refresh-feedback"
                      aria-label={chipStructureRefreshFeedback.text}
                      className={chipStructureRefreshFeedback.tone === "error"
                        ? "shrink-0 cursor-help text-red-500"
                        : "shrink-0 cursor-help text-amber-600 dark:text-amber-400"}
                    >
                      {chipStructureRefreshFeedbackLabel}
                    </span>
                  </InfoTip>
                )}
                {shouldOfferChipRefresh && (
                  <button
                    type="button"
                    data-testid="stock-chip-structure-refresh"
                    onClick={() => void handleChipStructureRefresh()}
                    disabled={chipStructureRefreshing || chipStructureLoading || !activeChipTradeDate}
                    className="relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded border border-slate-300 bg-white px-2 font-medium text-slate-700 transition-colors after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] hover:border-blue-300 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:border-blue-500 dark:hover:text-blue-300"
                    aria-label={explicitChipTradeDate ? "手动补齐该日筹码结构" : "手动补齐最新筹码结构"}
                    title={explicitChipTradeDate ? "从已配置的 Tushare 数据源补齐该日筹码结构" : "从已配置的 Tushare 数据源强制补齐最新筹码结构"}
                  >
                    {chipStructureRefreshing && (
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-current/30 border-t-current motion-reduce:animate-none" aria-hidden="true" />
                    )}
                    {chipStructureRefreshing ? "补齐中" : explicitChipTradeDate ? "补齐该日" : "补齐最新"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void setShortTermActiveSubTab("chipMonitor");
                    setActiveTab("short-term-strategy");
                  }}
                  className="ml-auto shrink-0 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  打开工作台
                </button>
              </div>
            )}

            {!PRESET_CODES.includes(selected) && (
              <StockDecisionSummary
                model={stockDecisionModel}
                savingAction={decisionActionSaving}
                actionMessage={decisionActionMessage}
                actionError={decisionActionError}
                onOpenForecast={() => setIsForecastPanelOpen(true)}
                onBackToDecisionCenter={() => setActiveTab('decision-center')}
                onMarkRead={() => void handleDecisionAction('read')}
                onWatch={() => void handleDecisionAction('watch')}
                onDismiss={() => void handleDecisionAction('dismiss')}
                onOpenLifecycle={() => {
                  setJudgmentError(null)
                  if (activeDecisionSignal) setDecisionJudgmentOpen(true)
                  else setDecisionLifecycleOpen(true)
                }}
                onEditCostPrice={() => setCostEditorOpen(true)}
              />
            )}

            {!PRESET_CODES.includes(selected) && (
              <StockSignalHistoryPanel
                items={stockHistoryItems}
                total={stockHistoryTotal}
                loading={stockHistoryLoading}
                error={stockHistoryError}
                rangeDays={stockHistoryRangeDays}
                onRangeChange={setStockHistoryRangeDays}
                onReload={() => void loadStockSignalHistory()}
                onLifecycle={(signal) => {
                  setLifecycleSignalOverride(signal);
                  setDecisionLifecycleOpen(true);
                }}
              />
            )}

            {/* Overlay checkboxes — only shown for non-index stocks */}
            {!PRESET_CODES.includes(selected) && (
              <div className="flex items-center gap-3 mb-2 shrink-0 flex-wrap">
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  叠加板块：
                </span>
                {PRESET_INDICES.map((idx, i) => (
                  <label
                    key={idx.stockCode}
                    className="flex items-center gap-1 cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={overlayIndices.has(idx.stockCode)}
                      onChange={() => handleToggleOverlay(idx.stockCode)}
                      className="rounded"
                    />
                    <span
                      className="text-xs"
                      style={{ color: OVERLAY_COLORS[i] }}
                    >
                      {idx.stockName}
                    </span>
                  </label>
                ))}
                {isOverlayMode && (
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-1">
                    （Y轴已切换为涨跌幅%）
                  </span>
                )}
              </div>
            )}

            {/* FR-072: forecast error */}
            {forecastError && (
              <p className="text-xs text-orange-500 mb-1 shrink-0">
                {forecastError}
              </p>
            )}

            {/* FR-082: overlay prediction checkboxes — shown in intraday mode when providers are configured or forecast data exists */}
            {chartMode === "intraday" &&
              !PRESET_CODES.includes(selected) &&
              (providerKeys.length > 0 ||
                configuredProviders.length > 0 ||
                Object.keys(providerErrorsCache[selected] ?? {}).length > 0) &&
              (() => {
                // Union of: providers with forecast data + providers with errors + configured providers
                const currentErrors = providerErrorsCache[selected] ?? {};
                const allProviderSet = new Set<string>([
                  ...providerKeys,
                  ...Object.keys(currentErrors),
                  ...configuredProviders.map((c) => c.provider),
                ]);
                const allProviders = Array.from(allProviderSet);
                return (
                  <div className="flex items-center gap-3 mb-2 shrink-0 flex-wrap">
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      叠加预测：
                    </span>
                    {allProviders.map((provider, i) => {
                      const pData = forecastProviders[provider];
                      const cfgLabel = configuredProviders.find(
                        (c) => c.provider === provider,
                      )?.label;
                      const label = pData?.model
                        ? `${provider}/${pData.model}`
                        : (cfgLabel ?? provider);
                      const color = FORECAST_COLORS[i % FORECAST_COLORS.length];
                      const hasError = !!currentErrors[provider];
                      const isChecked = checkedProviders.has(provider);
                      return (
                        <label
                          key={provider}
                          className="flex items-center gap-1 cursor-pointer select-none"
                          title={hasError ? currentErrors[provider] : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={forecasting}
                            onChange={() => {
                              if (hasError && !isChecked) {
                                // Re-check errored provider → trigger single-provider prediction
                                handlePredictSingleProvider(provider);
                              } else {
                                setCheckedProviders((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(provider)) next.delete(provider);
                                  else next.add(provider);
                                  return next;
                                });
                              }
                            }}
                            className="rounded"
                          />
                          <span
                            className="text-xs"
                            style={{ color: hasError ? "#ef4444" : color }}
                          >
                            {label}
                            {hasError ? " ✕" : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                );
              })()}

            {/* Chart — daily or intraday；T619/T620: 外层包裹布局 */}
            <div data-testid="stock-chart-canvas-area" className="flex-1 min-h-0 flex flex-row overflow-hidden">
              {/* 左侧：主图表 + 底部因子面板 */}
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {/* 图表主区域 */}
                {chartMode === "intraday" ? (
              intradayLoading ? (
                <div className="flex-1 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
                  加载中…
                </div>
              ) : intradayOHLCV.length > 0 ? (
                // T617: lwc 蜡烛图（Tushare OHLCV 数据）
                <div ref={intradayLwcContainerRef} className="flex-1 min-h-0" />
              ) : intradayItems.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
                  当日暂无分时数据
                </div>
              ) : (
                (() => {
                  // FR-073: compute % change maps for intraday overlay mode
                  const isIntradayOverlay = isOverlayMode;
                  function toIntradayPct(
                    items: IntradayRow[],
                  ): Map<string, number | null> {
                    const map = new Map<string, number | null>();
                    if (items.length === 0) return map;
                    const base = items[0].price;
                    if (!base) return map;
                    for (const r of items)
                      map.set(r.time, ((r.price - base) / base) * 100);
                    return map;
                  }
                  const mainPctMap = isIntradayOverlay
                    ? toIntradayPct(intradayItems)
                    : null;
                  const overlayPctMaps: (Map<string, number | null> | null)[] =
                    PRESET_INDICES.map((idx) =>
                      isIntradayOverlay && overlayIndices.has(idx.stockCode)
                        ? toIntradayPct(intradayOverlayMap[idx.stockCode] ?? [])
                        : null,
                    );

                  // FR-072 + FR-082: merge actual intraday + per-provider forecasts + overlay indices
                  const actualMap = new Map(
                    intradayItems.map((i) => [i.time, i]),
                  );

                  // FR-082: build per-provider forecast maps (today + morrow)
                  const activeProviders = providerKeys.filter((p) =>
                    checkedProviders.has(p),
                  );
                  const providerTodayMaps: Map<
                    string,
                    Map<string, number>
                  > = new Map();
                  const providerMorrowMaps: Map<
                    string,
                    Map<string, number>
                  > = new Map();
                  for (const p of activeProviders) {
                    const pData = forecastProviders[p];
                    if (pData?.today) {
                      providerTodayMaps.set(
                        p,
                        new Map(pData.today.map((f) => [f.time, f.price])),
                      );
                    }
                    if (pData?.morrow) {
                      providerMorrowMaps.set(
                        p,
                        new Map(
                          pData.morrow.map((f) => [`明日${f.time}`, f.price]),
                        ),
                      );
                    }
                  }

                  // Fallback: if no multi-provider data at all (not just unchecked), use legacy single forecast
                  const useLegacyForecast = providerKeys.length === 0;
                  const todayForecastMap = useLegacyForecast
                    ? new Map(forecastTodayItems.map((f) => [f.time, f.price]))
                    : new Map<string, number>();
                  const morrowForecastMap = useLegacyForecast
                    ? new Map(
                        forecastMorrowItems.map((f) => [
                          `明日${f.time}`,
                          f.price,
                        ]),
                      )
                    : new Map<string, number>();

                  const overlayTimes: string[] = [];
                  overlayPctMaps.forEach((m) => {
                    if (m) m.forEach((_, t) => overlayTimes.push(t));
                  });

                  // Collect all provider forecast times
                  const providerTimes: string[] = [];
                  for (const m of providerTodayMaps.values())
                    m.forEach((_, t) => providerTimes.push(t));
                  for (const m of providerMorrowMaps.values())
                    m.forEach((_, t) => providerTimes.push(t));

                  const allTimes = Array.from(
                    new Set([
                      ...intradayItems.map((i) => i.time),
                      ...(useLegacyForecast
                        ? forecastTodayItems.map((f) => f.time)
                        : []),
                      ...(useLegacyForecast
                        ? forecastMorrowItems.map((f) => `明日${f.time}`)
                        : []),
                      ...providerTimes,
                      ...overlayTimes,
                    ]),
                  ).sort((a, b) => {
                    const aM = a.startsWith("明日");
                    const bM = b.startsWith("明日");
                    if (aM !== bM) return aM ? 1 : -1;
                    return a.localeCompare(b);
                  });
                  const mergedData = allTimes.map((t) => {
                    const row: Record<string, unknown> = {
                      time: t,
                      price: isIntradayOverlay
                        ? (mainPctMap?.get(t) ?? null)
                        : (actualMap.get(t)?.price ?? null),
                      volume: actualMap.get(t)?.volume ?? null,
                      // Legacy single forecast (used when no multi-provider data)
                      forecastPrice:
                        !isIntradayOverlay && todayForecastMap.has(t)
                          ? (todayForecastMap.get(t) ?? null)
                          : null,
                      morrowPrice:
                        !isIntradayOverlay && morrowForecastMap.has(t)
                          ? (morrowForecastMap.get(t) ?? null)
                          : null,
                      overlayPct0: overlayPctMaps[0]?.get(t) ?? null,
                      overlayPct1: overlayPctMaps[1]?.get(t) ?? null,
                      overlayPct2: overlayPctMaps[2]?.get(t) ?? null,
                    };
                    // FR-082: per-provider forecast price columns
                    if (!isIntradayOverlay) {
                      for (const p of activeProviders) {
                        row[`forecast_today_${p}`] =
                          providerTodayMaps.get(p)?.get(t) ?? null;
                        row[`forecast_morrow_${p}`] =
                          providerMorrowMaps.get(p)?.get(t) ?? null;
                      }
                    }
                    return row;
                  });
                  return (
                    <div className="flex-1 min-h-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                          data={mergedData}
                          margin={{ top: 8, right: 64, left: 8, bottom: 8 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke={isDark ? "#374151" : "#f0f0f0"}
                            vertical={false}
                          />
                          <XAxis
                            dataKey="time"
                            tick={{ fontSize: 10 }}
                            interval={Math.max(
                              1,
                              Math.floor(mergedData.length / 8),
                            )}
                            tickLine={false}
                          />
                          <YAxis
                            yAxisId="price"
                            orientation="left"
                            domain={["auto", "auto"]}
                            tick={{ fontSize: 11 }}
                            width={56}
                            tickFormatter={(v: number) =>
                              isIntradayOverlay
                                ? `${v.toFixed(1)}%`
                                : v.toFixed(2)
                            }
                          />
                          <YAxis
                            yAxisId="volume"
                            orientation="right"
                            tick={{ fontSize: 10 }}
                            width={64}
                            tickFormatter={(v: number) =>
                              `${(v / 1000).toFixed(0)}千手`
                            }
                          />
                          <Tooltip
                            formatter={
                              ((value: number, name: string) => {
                                if (name === "成交量")
                                  return [`${value}手`, name];
                                if (isIntradayOverlay)
                                  return [`${value?.toFixed(2)}%`, name];
                                return [value?.toFixed(2), name];
                              }) as never
                            }
                            labelStyle={{
                              fontSize: 12,
                              color: isDark ? "#d1d5db" : undefined,
                            }}
                            contentStyle={{
                              fontSize: 12,
                              backgroundColor: isDark ? "#1f2937" : "#fff",
                              borderColor: isDark ? "#374151" : "#e5e7eb",
                              color: isDark ? "#d1d5db" : undefined,
                            }}
                          />
                          <Legend
                            wrapperStyle={{ fontSize: 11, paddingBottom: 4 }}
                          />
                          {isIntradayOverlay && (
                            <ReferenceLine
                              yAxisId="price"
                              y={0}
                              stroke="#9ca3af"
                              strokeDasharray="4 2"
                            />
                          )}
                          <Line
                            yAxisId="price"
                            type="monotone"
                            dataKey="price"
                            name={
                              isIntradayOverlay
                                ? (selectedItem?.stockName ?? selected)
                                : "价格"
                            }
                            stroke={MAIN_STOCK_COLOR}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 3 }}
                            connectNulls={true}
                          />
                          {/* FR-082: per-provider today forecast lines — only in non-overlay intraday mode */}
                          {!isIntradayOverlay &&
                            activeProviders.map((p, i) => {
                              const pData = forecastProviders[p];
                              if (!pData?.today) return null;
                              const label = pData.model
                                ? `${p}/${pData.model} 今日`
                                : `${p} 今日`;
                              return (
                                <Line
                                  key={`forecast_today_${p}`}
                                  yAxisId="price"
                                  type="monotone"
                                  dataKey={`forecast_today_${p}`}
                                  name={label}
                                  stroke={
                                    FORECAST_COLORS[i % FORECAST_COLORS.length]
                                  }
                                  strokeWidth={2}
                                  strokeDasharray="6 3"
                                  dot={false}
                                  activeDot={{ r: 3 }}
                                  connectNulls={false}
                                />
                              );
                            })}
                          {/* FR-082: per-provider morrow forecast lines */}
                          {!isIntradayOverlay &&
                            activeProviders.map((p, i) => {
                              const pData = forecastProviders[p];
                              if (!pData?.morrow) return null;
                              const label = pData.model
                                ? `${p}/${pData.model} 明日`
                                : `${p} 明日`;
                              return (
                                <Line
                                  key={`forecast_morrow_${p}`}
                                  yAxisId="price"
                                  type="monotone"
                                  dataKey={`forecast_morrow_${p}`}
                                  name={label}
                                  stroke={
                                    FORECAST_COLORS[i % FORECAST_COLORS.length]
                                  }
                                  strokeWidth={2}
                                  strokeDasharray="2 2"
                                  dot={false}
                                  activeDot={{ r: 3 }}
                                  connectNulls={false}
                                />
                              );
                            })}
                          {/* Legacy single forecast lines — only when no multi-provider data */}
                          {!isIntradayOverlay &&
                            useLegacyForecast &&
                            forecastTodayItems.length > 0 && (
                              <Line
                                yAxisId="price"
                                type="monotone"
                                dataKey="forecastPrice"
                                name="今日预测"
                                stroke="#f97316"
                                strokeWidth={2}
                                strokeDasharray="6 3"
                                dot={false}
                                activeDot={{ r: 3 }}
                                connectNulls={false}
                              />
                            )}
                          {/* Legacy morrow forecast line — only when no multi-provider data */}
                          {!isIntradayOverlay &&
                            useLegacyForecast &&
                            forecastMorrowItems.length > 0 && (
                              <Line
                                yAxisId="price"
                                type="monotone"
                                dataKey="morrowPrice"
                                name="明日预测"
                                stroke="#8b5cf6"
                                strokeWidth={2}
                                strokeDasharray="6 3"
                                dot={false}
                                activeDot={{ r: 3 }}
                                connectNulls={false}
                              />
                            )}
                          {/* FR-073: overlay index % lines in intraday mode */}
                          {isIntradayOverlay &&
                            PRESET_INDICES.map((idx, i) =>
                              overlayIndices.has(idx.stockCode) ? (
                                <Line
                                  key={idx.stockCode}
                                  yAxisId="price"
                                  type="monotone"
                                  dataKey={`overlayPct${i}`}
                                  name={idx.stockName}
                                  stroke={OVERLAY_COLORS[i]}
                                  strokeWidth={1.5}
                                  dot={false}
                                  strokeDasharray="5 2"
                                  connectNulls={false}
                                />
                              ) : null,
                            )}
                          <Bar
                            yAxisId="volume"
                            dataKey="volume"
                            name="成交量"
                            maxBarSize={6}
                            fill="#94a3b8"
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  );
                })()
              )
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                {/* FR-087/166: 日K十字准线提示 */}
                <div
                  className="text-xs px-1 py-0.5 flex items-center shrink-0 flex-wrap gap-1 min-h-[20px]"
                >
                  {isOverlayMode ? (
                    <span className="text-gray-400 dark:text-gray-500 text-[10px]">
                      涨跌幅%模式 · 十字准线查看详情
                    </span>
                  ) : stockConcepts.length > 0 ? (
                    <>
                      {stockConcepts.slice(0, 6).map(name => (
                        <span
                          key={name}
                          className="text-[10px] px-1 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                        >
                          {name}
                        </span>
                      ))}
                      {stockConcepts.length > 6 && (
                        <InfoTip
                          content={stockConcepts.slice(6).join('\n')}
                          placement="top"
                        >
                          <span className="text-[10px] text-slate-400 dark:text-slate-500 cursor-help">
                            +{stockConcepts.length - 6}
                          </span>
                        </InfoTip>
                      )}
                    </>
                  ) : (
                    <span className="text-gray-400 dark:text-gray-500 text-[10px]">
                      鼠标悬停查看K线详情
                    </span>
                  )}
                </div>
                {/* FR-087: lightweight-charts mount point */}
                <div className="flex-1 min-h-0 relative">
                  <div ref={dailyChartContainerRef} data-testid="daily-chart-container" className="absolute inset-0" />
                  {loadingOlderCode === selected && (
                    <div
                      role="status"
                      data-testid="stock-chart-history-loading"
                      className="pointer-events-none absolute left-3 top-3 z-20 flex items-center gap-2 rounded border border-slate-200 bg-white/95 px-2.5 py-1.5 text-[11px] text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-300"
                    >
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-cyan-600 motion-reduce:animate-none dark:border-slate-600 dark:border-t-cyan-400" />
                      正在载入更早日K
                    </div>
                  )}
                  {!isOverlayMode && legendData && legendPosition && (
                    <div
                      data-testid="stock-chart-candle-tooltip"
                      className="absolute z-20 w-[200px] rounded border border-gray-200 bg-white px-3 py-2 text-xs shadow-[0_12px_30px_rgba(15,23,42,0.22)] pointer-events-none select-none dark:border-gray-700 dark:bg-gray-900 dark:shadow-[0_12px_30px_rgba(0,0,0,0.5)]"
                      style={{
                        left: legendPosition.left,
                        top: legendPosition.top,
                      }}
                    >
                      <div className="flex items-center justify-between mb-1.5 border-b border-gray-100 dark:border-gray-800 pb-1">
                        <span className="font-medium text-gray-800 dark:text-gray-100">
                          {legendData.date}
                        </span>
                        <span
                          className={legendData.isUp ? "text-red-500" : "text-green-500"}
                        >
                          {formatPercent(legendData.pctChg)}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <span className="text-gray-500 dark:text-gray-400">
                          开 <b className={legendData.isUp ? "text-red-500" : "text-green-500"}>{legendData.open.toFixed(2)}</b>
                        </span>
                        <span className="text-gray-500 dark:text-gray-400">
                          收 <b className={legendData.isUp ? "text-red-500" : "text-green-500"}>{legendData.close.toFixed(2)}</b>
                        </span>
                        <span className="text-gray-500 dark:text-gray-400">
                          高 <b className="text-red-500">{legendData.high.toFixed(2)}</b>
                        </span>
                        <span className="text-gray-500 dark:text-gray-400">
                          低 <b className="text-green-500">{legendData.low.toFixed(2)}</b>
                        </span>
                        <span className="text-gray-500 dark:text-gray-400">
                          振幅 <b className="text-gray-700 dark:text-gray-200">{formatPercent(legendData.amplitude)}</b>
                        </span>
                        <span className="text-gray-500 dark:text-gray-400">
                          换手 <b className="text-gray-700 dark:text-gray-200">{legendData.turnoverRate == null ? "--" : `${legendData.turnoverRate.toFixed(2)}%`}</b>
                        </span>
                      </div>
                      <div className="mt-1.5 pt-1 border-t border-gray-100 dark:border-gray-800 text-gray-500 dark:text-gray-400">
                        成交 <b className="text-gray-700 dark:text-gray-200">{formatAmount(legendData.amount)}</b>
                      </div>
                    </div>
                  )}
                  {/* BOLL/MA均由当前完整日K本地计算，不依赖短周期因子缓存。 */}
                  {!isOverlayMode && !PRESET_CODES.includes(selected) && (
                    <div className="absolute top-2 right-2 z-10 pointer-events-none select-none
                      bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm
                      border border-gray-200 dark:border-gray-700
                      rounded px-2 py-1.5 text-[10px] leading-5 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-gray-500 dark:text-gray-400 font-medium">BOLL</span>
                        {[
                          { label: "上轨", color: "#ef4444" },
                          { label: "下轨", color: "#22c55e" },
                        ].map(({ label, color }) => (
                          <span key={label} className="flex items-center gap-0.5">
                            <span style={{ display: "inline-block", width: 16, height: 2, background: color, verticalAlign: "middle", borderRadius: 1 }} />
                            <span style={{ color }} className="font-medium">{label}</span>
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-gray-500 dark:text-gray-400 font-medium">MA</span>
                        {[
                          { label: "MA5",  color: "#f97316" },
                          { label: "MA10", color: "#3b82f6" },
                          { label: "MA20 / BOLL中轨", color: "#8b5cf6" },
                          { label: "MA60", color: "#a16207" },
                        ].map(({ label, color }) => (
                          <span key={label} className="flex items-center gap-0.5">
                            <span style={{ display: "inline-block", width: 16, height: 2, background: color, verticalAlign: "middle", borderRadius: 1 }} />
                            <span style={{ color }} className="font-medium">{label}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

                {/* T620: 底部技术因子折叠面板 */}
                {factorData && !PRESET_CODES.includes(selected) && (() => {
                  const { macdBfq, macdDifBfq, macdDeaBfq, kdjKBfq, rsiBfq6 } = factorData;
                  const macdLabel =
                    macdBfq != null && macdDifBfq != null && macdDeaBfq != null
                      ? macdBfq > 0 && macdDifBfq > macdDeaBfq
                        ? "金叉▲"
                        : macdBfq < 0 && macdDifBfq < macdDeaBfq
                          ? "死叉▼"
                          : "震荡"
                      : "";
                  return (
                    <div className="shrink-0 border-t border-gray-100 dark:border-gray-700">
                      <button
                        onClick={() => setFactorOpen((p) => !p)}
                        className="w-full flex items-center gap-2 px-2 py-0.5 text-xs text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                      >
                        <span>{factorOpen ? "▲" : "▼"}</span>
                        <span className="font-medium">技术指标</span>
                        {macdLabel && (
                          <span>
                            MACD{" "}
                            <span className={macdLabel.includes("金") ? "text-red-400" : macdLabel.includes("死") ? "text-green-400" : ""}>
                              {macdLabel}
                            </span>
                          </span>
                        )}
                        {kdjKBfq != null && <span>KDJ K:{kdjKBfq.toFixed(0)}</span>}
                        {rsiBfq6 != null && <span>RSI6:{rsiBfq6.toFixed(1)}</span>}
                      </button>
                      {factorOpen && <FactorSummary factor={factorData} />}
                    </div>
                  );
                })()}
              </div>{/* end 左侧 */}

              {/* T619: 右侧筹码开关按钮 */}
              {!PRESET_CODES.includes(selected) && chipsData && chipsData.length > 0 && (
                <button
                  onClick={() => setChipsOpen((p) => !p)}
                  className="w-5 flex items-center justify-center bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 border-l border-gray-200 dark:border-gray-700 text-gray-400 text-xs shrink-0"
                  title={chipsOpen ? "收起筹码" : "展开筹码"}
                >
                  {chipsOpen ? "▶" : "◀"}
                </button>
              )}

              {/* T619: 右侧筹码分布面板 */}
              {chipsOpen && !PRESET_CODES.includes(selected) && chipsData && chipsData.length > 0 && (
                <div className="w-44 min-h-0 flex flex-col bg-gray-900 border-l border-gray-700 shrink-0">
                  <div className="text-center text-[10px] text-gray-500 py-0.5 shrink-0">筹码分布</div>
                  {chipsLoading ? (
                    <div className="flex-1 flex items-center justify-center text-xs text-gray-400">加载中…</div>
                  ) : (
                    <div className="flex-1 min-h-0 relative">
                      <canvas ref={chipsCanvasRef} className="absolute inset-0 w-full h-full" />
                    </div>
                  )}
                </div>
              )}
            </div>{/* end 图表+面板外层 */}
          </>
        )}
      </div>

      {/* FR-076: Forecast panel modal */}
      <ForecastPanel
        stockCode={selected}
        stockName={selectedItem?.stockName ?? selected}
        isOpen={isForecastPanelOpen}
        onClose={() => setIsForecastPanelOpen(false)}
      />
      <StockJudgmentPanel
        open={decisionJudgmentOpen && activeDecisionSignal != null}
        signal={activeDecisionSignal}
        relatedSignals={activeDecisionSignal ? [activeDecisionSignal, ...stockHistoryItems.filter((item) => item.id !== activeDecisionSignal.id)].slice(0, 8) : []}
        holdings={stockHoldings}
        saving={judgmentSaving}
        error={judgmentError}
        onClose={() => {
          setDecisionJudgmentOpen(false)
          setJudgmentError(null)
        }}
        onOpenEventDetail={(signal) => {
          setLifecycleSignalOverride(signal)
          setDecisionLifecycleOpen(true)
        }}
        onNavigateStock={() => {
          // 已在走势图, 仅关闭面板
          setDecisionJudgmentOpen(false)
        }}
        onSubmitJudgment={(payload) => {
          void (async () => {
            setJudgmentSaving(true)
            setJudgmentError(null)
            try {
              const applied = await applyStockJudgment({
                requestId: crypto.randomUUID(),
                tsCode: payload.tsCode,
                stockName: payload.stockName,
                tag: payload.tag,
                note: payload.note,
                sourceSignalId: payload.signal.id,
                relatedSignalIds: payload.relatedSignalIds,
                evidenceSnapshot: payload.evidenceSnapshot,
              })
              if (!applied.ok) throw new Error(applied.message || applied.error || '保存结论失败')
              refreshAfterDecisionAction('研判结论已保存', applied.data?.status ?? activeStockContext?.status)
              setDecisionJudgmentOpen(false)
              void loadStockSignalHistory()
            } catch (err) {
              setJudgmentError(err instanceof Error ? err.message : String(err))
            } finally {
              setJudgmentSaving(false)
            }
          })()
        }}
      />
      <SignalLifecycleDrawer
        signal={lifecycleSignalOverride ?? activeDecisionSignal}
        open={decisionLifecycleOpen}
        onClose={() => { setDecisionLifecycleOpen(false); setLifecycleSignalOverride(null); }}
        onUpdated={(signal) => {
          refreshAfterDecisionAction('事件明细已更新', signal?.status ?? activeStockContext?.status);
          setLifecycleSignalOverride(null);
          void loadStockSignalHistory();
        }}
      />
      <StockCostPriceEditor
        open={costEditorOpen}
        stockName={selectedItem?.stockName ?? selected}
        costPrice={selectedCostPrice}
        saving={costSaving}
        error={costError}
        onSave={(costPrice) => void handleSaveCostPrice(costPrice)}
        onClose={() => setCostEditorOpen(false)}
      />
      <StockFundamentalDrawer
        open={fundamentalDrawerOpen && !PRESET_CODES.includes(selected)}
        stockCode={selected}
        stockName={selectedItem?.stockName ?? selected}
        onClose={() => setFundamentalDrawerOpen(false)}
      />
    </div>
  );
}
