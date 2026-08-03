// SMC（Smart Money Concepts）结构分析算法——主进程专用版本
// 从 src/utils/smcAnalysis.ts 复制，用于主进程（tsconfig.node.json 不包含 src/）
// 纯 TypeScript，无外部依赖

export interface OHLCVBar {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
}

export type SwingLabel = 'HH' | 'LH' | 'HL' | 'LL';

export interface SwingPoint {
  index: number;
  time: string;
  price: number;
  /** 'high' 或 'low' */
  swingType: 'high' | 'low';
  label: SwingLabel;
  /** true = 左右各 swingN 根均满足，false = 右侧数据不足（末端待确认） */
  confirmed: boolean;
}

export interface StructureEvent {
  index: number;
  time: string;
  /** 被突破的参考价位 */
  level: number;
  eventType: 'CHoCH';
  /** bullish = 空头结构中向上突破（转多），bearish = 多头结构中向下跌破（转空） */
  direction: 'bullish' | 'bearish';
}

export interface SMCSignal {
  index: number;
  time: string;
  price: number;
  signalType: 'buy' | 'sell';
  count: number;
}

export interface SMCResult {
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
  events: StructureEvent[];
  signals: SMCSignal[];
}

/**
 * 计算 SMC 结构分析结果
 * @param bars   OHLCV bar 数组，按时间升序排列
 * @param swingN 摆动点检测窗口大小（左右各 swingN 根），建议 2~5
 */
export function computeSMC(bars: OHLCVBar[], swingN: number): SMCResult {
  const n = bars.length;
  if (n < swingN * 2 + 1) {
    return { swingHighs: [], swingLows: [], events: [], signals: [] };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 步骤 1：检测摆动高/低点（含末端 unconfirmed）
  // ──────────────────────────────────────────────────────────────────────────
  const rawHighs: Array<{ index: number; confirmed: boolean }> = [];
  const rawLows: Array<{ index: number; confirmed: boolean }> = [];

  for (let i = 0; i < n; i++) {
    const leftStart = Math.max(0, i - swingN);
    const rightEnd = Math.min(n - 1, i + swingN);

    // 是否为左侧局部极值（左侧各 swingN 根都小于当前）
    let isLocalHigh = true;
    let isLocalLow = true;
    for (let j = leftStart; j < i; j++) {
      if (bars[j].high >= bars[i].high) { isLocalHigh = false; }
      if (bars[j].low <= bars[i].low) { isLocalLow = false; }
    }
    if (!isLocalHigh && !isLocalLow) continue;

    // 右侧数据是否充足
    const rightEnough = i + swingN <= n - 1;

    // 检查右侧
    let rightConfirmHigh = true;
    let rightConfirmLow = true;
    for (let j = i + 1; j <= rightEnd; j++) {
      if (bars[j].high >= bars[i].high) { rightConfirmHigh = false; }
      if (bars[j].low <= bars[i].low) { rightConfirmLow = false; }
    }

    if (isLocalHigh) {
      if (rightEnough && rightConfirmHigh) {
        rawHighs.push({ index: i, confirmed: true });
      } else if (!rightEnough && rightConfirmHigh) {
        rawHighs.push({ index: i, confirmed: false });
      }
    }
    if (isLocalLow) {
      if (rightEnough && rightConfirmLow) {
        rawLows.push({ index: i, confirmed: true });
      } else if (!rightEnough && rightConfirmLow) {
        rawLows.push({ index: i, confirmed: false });
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 步骤 2：标注 HH/LH（高点）和 HL/LL（低点）
  // ──────────────────────────────────────────────────────────────────────────
  const swingHighs: SwingPoint[] = rawHighs.map((rh, idx) => {
    const price = bars[rh.index].high;
    let label: SwingLabel = 'HH';
    if (idx > 0) {
      const prevPrice = bars[rawHighs[idx - 1].index].high;
      label = price > prevPrice ? 'HH' : 'LH';
    }
    return {
      index: rh.index,
      time: bars[rh.index].time,
      price,
      swingType: 'high',
      label,
      confirmed: rh.confirmed,
    };
  });

  const swingLows: SwingPoint[] = rawLows.map((rl, idx) => {
    const price = bars[rl.index].low;
    let label: SwingLabel = 'HL';
    if (idx > 0) {
      const prevPrice = bars[rawLows[idx - 1].index].low;
      label = price > prevPrice ? 'HL' : 'LL';
    }
    return {
      index: rl.index,
      time: bars[rl.index].time,
      price,
      swingType: 'low',
      label,
      confirmed: rl.confirmed,
    };
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 步骤 3：逐 bar 扫描检测 CHoCH（特征变换）
  // ──────────────────────────────────────────────────────────────────────────
  const events: StructureEvent[] = [];
  const signals: SMCSignal[] = [];

  // 仅使用 confirmed 摆动点作为结构参考
  const confirmedHighs = swingHighs.filter((sp) => sp.confirmed);
  const confirmedLows = swingLows.filter((sp) => sp.confirmed);

  if (confirmedHighs.length === 0 || confirmedLows.length === 0) {
    return { swingHighs, swingLows, events, signals };
  }

  // 初始 bias 由前 N 个摆动点判断：第一个摆动高点 vs 摆动低点的顺序
  let bias: 'bullish' | 'bearish' | 'unknown' = 'unknown';
  if (confirmedHighs.length >= 2 && confirmedLows.length >= 2) {
    const latestTwoHighs = confirmedHighs.slice(-2);
    const latestTwoLows = confirmedLows.slice(-2);
    const isHigherHighs = latestTwoHighs[1].price > latestTwoHighs[0].price;
    const isHigherLows = latestTwoLows[1].price > latestTwoLows[0].price;
    if (isHigherHighs && isHigherLows) bias = 'bullish';
    else if (!isHigherHighs && !isHigherLows) bias = 'bearish';
  }

  let refHigh = confirmedHighs[confirmedHighs.length - 1]?.price ?? Infinity;
  let refLow = confirmedLows[confirmedLows.length - 1]?.price ?? 0;

  let hPtr = 0;
  let lPtr = 0;

  let buyCount = 0;
  let sellCount = 0;

  for (let i = 0; i < n; i++) {
    while (hPtr < confirmedHighs.length && confirmedHighs[hPtr].index < i) {
      refHigh = confirmedHighs[hPtr].price;
      hPtr++;
    }
    while (lPtr < confirmedLows.length && confirmedLows[lPtr].index < i) {
      refLow = confirmedLows[lPtr].price;
      lPtr++;
    }

    const close = bars[i].close;

    if (bias !== 'bullish' && close > refHigh && refHigh !== Infinity) {
      // 空头/未知结构中向上突破最近确认高点 → 多头 CHoCH
      events.push({
        index: i,
        time: bars[i].time,
        level: refHigh,
        eventType: 'CHoCH',
        direction: 'bullish',
      });
      bias = 'bullish';
      buyCount++;
      signals.push({
        index: i,
        time: bars[i].time,
        price: bars[i].low,
        signalType: 'buy',
        count: buyCount,
      });
    } else if (bias !== 'bearish' && close < refLow && refLow !== 0) {
      // 多头/未知结构中向下跌破最近确认低点 → 空头 CHoCH
      events.push({
        index: i,
        time: bars[i].time,
        level: refLow,
        eventType: 'CHoCH',
        direction: 'bearish',
      });
      bias = 'bearish';
      sellCount++;
      signals.push({
        index: i,
        time: bars[i].time,
        price: bars[i].high,
        signalType: 'sell',
        count: sellCount,
      });
    }
  }

  return { swingHighs, swingLows, events, signals };
}
