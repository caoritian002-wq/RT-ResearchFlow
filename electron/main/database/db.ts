import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { copyFileSync, existsSync, statSync } from 'fs'
import {
  DEFAULT_ARTICLE_ANALYSIS_PROMPT,
  LEGACY_DEFAULT_ARTICLE_ANALYSIS_PROMPT,
} from '../aiPromptDefaults'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return _db
}

export function initDb(): Database.Database {
  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, 'trade-watch.db')

  const db = new Database(dbPath)

  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('synchronous = NORMAL')
    db.pragma('cache_size = -32000') // 32 MB cache

    runMigrations(db)
  } catch (err) {
    const logPath = join(app.getPath('logs'), 'trade-watch.log')
    const message = err instanceof Error ? err.message : String(err)
    db.close()
    throw new Error(`${message}\n\n日志路径：${logPath}`)
  }

  // Auto-backup: copy to trade-watch.db.bak if last backup was >24h ago (T097)
  const bakPath = join(userDataPath, 'trade-watch.db.bak')
  const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
  try {
    const needsBackup = !existsSync(bakPath) ||
      Date.now() - statSync(bakPath).mtimeMs > BACKUP_INTERVAL_MS
    if (needsBackup) {
      copyFileSync(dbPath, bakPath)
    }
  } catch {
    // Non-fatal: backup failure should not prevent app startup
  }

  _db = db
  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ── Inline migrations (avoids file path issues in both dev and packaged builds) ──

const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS sources (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  nameCN               TEXT    NOT NULL,
  nameEN               TEXT    NOT NULL,
  url                  TEXT    NOT NULL,
  feedUrl              TEXT,
  category             TEXT    NOT NULL CHECK (category IN ('REGULATOR','CENTRAL_BANK','GOVERNMENT','STATE_MEDIA','FINANCIAL_PRESS','CUSTOM')),
  authorityWeight      INTEGER NOT NULL DEFAULT 5 CHECK (authorityWeight BETWEEN 1 AND 10),
  isBuiltIn            INTEGER NOT NULL DEFAULT 1 CHECK (isBuiltIn IN (0,1)),
  isEnabled            INTEGER NOT NULL DEFAULT 1 CHECK (isEnabled IN (0,1)),
  status               TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','UNREACHABLE','DEGRADED','PARSE_FAILED','DISABLED')),
  lastScannedAt        INTEGER,
  successRate          REAL    NOT NULL DEFAULT 1.0,
  parseStrategy        TEXT    NOT NULL CHECK (parseStrategy IN ('RSS','ATOM','HTML_SCRAPE','API')),
  contentSelector      TEXT,
  financeSectionFilter TEXT
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  type              TEXT    NOT NULL CHECK (type IN ('SCHEDULED','MANUAL','CATCH_UP')),
  startedAt         INTEGER NOT NULL,
  completedAt       INTEGER,
  sourcesScanned    INTEGER NOT NULL DEFAULT 0,
  newBriefingsFound INTEGER NOT NULL DEFAULT 0,
  errors            TEXT,
  catchUpRangeStart INTEGER,
  catchUpRangeEnd   INTEGER
);

CREATE TABLE IF NOT EXISTS briefings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceId          INTEGER NOT NULL REFERENCES sources(id),
  sourceName        TEXT    NOT NULL,
  originalUrl       TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  summary           TEXT    NOT NULL,
  fullContent       TEXT,
  publishedAt       INTEGER NOT NULL,
  publishedDateBJ   TEXT    NOT NULL,
  collectedAt       INTEGER NOT NULL,
  impactRating      TEXT    NOT NULL CHECK (impactRating IN ('CRITICAL','IMPORTANT','GENERAL')),
  impactRatingScore INTEGER NOT NULL DEFAULT 0,
  deduplicationHash TEXT    NOT NULL UNIQUE,
  titleSimhash      TEXT    NOT NULL,
  isRead            INTEGER NOT NULL DEFAULT 0 CHECK (isRead IN (0,1)),
  readAt            INTEGER,
  scanRunId         INTEGER REFERENCES scan_runs(id),
  isCatchUp         INTEGER NOT NULL DEFAULT 0 CHECK (isCatchUp IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_briefings_date      ON briefings(publishedDateBJ);
CREATE INDEX IF NOT EXISTS idx_briefings_source    ON briefings(sourceId);
CREATE INDEX IF NOT EXISTS idx_briefings_rating    ON briefings(impactRating);
CREATE INDEX IF NOT EXISTS idx_briefings_read      ON briefings(isRead);
CREATE INDEX IF NOT EXISTS idx_briefings_collected ON briefings(collectedAt);
CREATE INDEX IF NOT EXISTS idx_briefings_simhash   ON briefings(titleSimhash);

CREATE VIRTUAL TABLE IF NOT EXISTS briefings_fts USING fts5(
  title,
  summary,
  content='briefings',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS briefings_ai AFTER INSERT ON briefings BEGIN
  INSERT INTO briefings_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS briefings_ad AFTER DELETE ON briefings BEGIN
  INSERT INTO briefings_fts(briefings_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS briefings_au AFTER UPDATE ON briefings BEGIN
  INSERT INTO briefings_fts(briefings_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, old.summary);
  INSERT INTO briefings_fts(rowid, title, summary) VALUES (new.id, new.title, new.summary);
END;

CREATE TABLE IF NOT EXISTS app_settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  scanIntervalMinutes  INTEGER NOT NULL DEFAULT 10 CHECK (scanIntervalMinutes IN (5,10,15,30,60)),
  retentionDays        INTEGER NOT NULL DEFAULT 30,
  catchUpMaxDays       INTEGER NOT NULL DEFAULT 7,
  lastSuccessfulScanAt INTEGER,
  uiLanguage           TEXT    NOT NULL DEFAULT 'zh-CN'
);

INSERT OR IGNORE INTO app_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS daily_archive (
  date          TEXT    PRIMARY KEY,
  totalCount    INTEGER NOT NULL DEFAULT 0,
  unreadCount   INTEGER NOT NULL DEFAULT 0,
  criticalCount INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL
);
`

const MIGRATION_002 = `
ALTER TABLE sources ADD COLUMN detailSelector TEXT;

CREATE TABLE IF NOT EXISTS detail_cache (
  cacheKey    TEXT    PRIMARY KEY,
  briefingUrl TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  fetchedAt   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_detail_cache_fetched ON detail_cache(fetchedAt);
`

// Migration 3: back-fill detailSelector for built-in sources that were seeded
// before the column existed (they will have NULL). Uses URL pattern matching so
// the correction survives even if seeds are added again later.
const MIGRATION_003 = `
UPDATE sources SET detailSelector = '.detail-news'
WHERE url LIKE '%csrc.gov.cn%' AND detailSelector IS NULL;
`

// Migration 4: deduplicate sources table (INSERT OR IGNORE had no UNIQUE
// constraint, so every startup created a new row for each built-in source).
// Strategy: for each URL keep the row with the lowest id (first-ever insert),
// remap any briefings pointing to a duplicate row, then delete duplicates.
const MIGRATION_004 = `
UPDATE briefings
SET sourceId = (
  SELECT MIN(s2.id) FROM sources s2
  WHERE s2.url = (SELECT s3.url FROM sources s3 WHERE s3.id = briefings.sourceId)
)
WHERE sourceId NOT IN (SELECT MIN(id) FROM sources GROUP BY url);

DELETE FROM sources
WHERE id NOT IN (SELECT MIN(id) FROM sources GROUP BY url);
`

// Migration 5: upgrade HTTP → HTTPS for gov.cn and pbc.gov.cn which now
// enforce HTTPS and return 403 on plain HTTP requests.
const MIGRATION_005 = `
UPDATE sources SET url = 'https://www.gov.cn'     WHERE url = 'http://www.gov.cn';
UPDATE sources SET url = 'https://www.pbc.gov.cn' WHERE url = 'http://www.pbc.gov.cn';
`

// Migration 6: add defaultGroupExpanded to app_settings (default 1 = expanded)
const MIGRATION_006 = `
ALTER TABLE app_settings ADD COLUMN defaultGroupExpanded INTEGER NOT NULL DEFAULT 1;
`

// Migration 7: remove stale built-in source rows whose URL was changed in seeds.ts
// (e.g. Caixin was previously seeded as rss.caixin.com; the old row was never deleted
// because seedBuiltInSources matched only by URL).
// Strategy: for each built-in source name that now has >1 row, remap briefings to the
// row with the lowest id and delete the duplicates.
const MIGRATION_007 = `
UPDATE briefings
SET sourceId = (
  SELECT MIN(s2.id) FROM sources s2
  WHERE s2.nameCN = (SELECT s3.nameCN FROM sources s3 WHERE s3.id = briefings.sourceId)
    AND s2.isBuiltIn = 1
)
WHERE sourceId NOT IN (SELECT MIN(id) FROM sources WHERE isBuiltIn = 1 GROUP BY nameCN);

DELETE FROM sources
WHERE isBuiltIn = 1
  AND id NOT IN (SELECT MIN(id) FROM sources WHERE isBuiltIn = 1 GROUP BY nameCN);
`

// Migration 8: AI configuration (single-row) and analysis sessions tables;
// also adds autoAiAnalysisPrompt toggle to app_settings.
const MIGRATION_008 = `
CREATE TABLE IF NOT EXISTS ai_config (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  provider             TEXT    CHECK (provider IN ('claude','chatgpt','qwen','deepseek')),
  model                TEXT,
  apiKeyEncrypted      BLOB,
  baseUrl              TEXT,
  presetPrompt         TEXT,
  triggerRating        TEXT    NOT NULL DEFAULT 'IMPORTANT' CHECK (triggerRating IN ('CRITICAL','IMPORTANT','GENERAL')),
  maxArticlesPerBatch  INTEGER NOT NULL DEFAULT 20,
  autoCleanupDays      INTEGER
);

INSERT OR IGNORE INTO ai_config (id, presetPrompt) VALUES (1, '你现在是一个老道的股票交易员。如果我给到你以下这些文章URL，你试着从这些文章中分析会影响到A股中的哪些版块，并且在这些被影响的版块中，选取三支龙头股。龙头的定义是，近期交易活跃，市值排前列，主营业务在该版块占有率名列前茅。这三支龙头股，你可以查阅近期1个月的走势，结合大盘整体，给出该股的支撑位，压力位，止盈位。并以表格的形式输出给到我，最后附上你选择他们的理由。');

CREATE TABLE IF NOT EXISTS ai_analysis_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt   INTEGER NOT NULL,
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  articleUrls TEXT    NOT NULL,
  promptSent  TEXT    NOT NULL,
  response    TEXT,
  scanRunId   INTEGER REFERENCES scan_runs(id),
  isError     INTEGER NOT NULL DEFAULT 0 CHECK (isError IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_created ON ai_analysis_sessions(createdAt);

ALTER TABLE app_settings ADD COLUMN autoAiAnalysisPrompt INTEGER NOT NULL DEFAULT 0;
`

// Migration 9: add briefingId to ai_analysis_sessions for single-article analysis (FR-047)
const MIGRATION_009 = `
ALTER TABLE ai_analysis_sessions ADD COLUMN briefingId INTEGER REFERENCES briefings(id);
`

// Migration 11: add maxContentCharsPerArticle to ai_config (FR-049)
const MIGRATION_011 = `
ALTER TABLE ai_config ADD COLUMN maxContentCharsPerArticle INTEGER NOT NULL DEFAULT 2000;
`

// Migration 12: add maxArticleAgeDays to ai_config (FR-053)
const MIGRATION_012 = `
ALTER TABLE ai_config ADD COLUMN maxArticleAgeDays INTEGER DEFAULT 90;
`

// Migration 10: backfill default presetPrompt for existing databases that ran M008 with empty prompt
const MIGRATION_010 = `
UPDATE ai_config SET presetPrompt = '${LEGACY_DEFAULT_ARTICLE_ANALYSIS_PROMPT.replace(/'/g, "''")}' WHERE id = 1 AND (presetPrompt IS NULL OR presetPrompt = '');
`

// Migration 13: add responseRound2 to ai_analysis_sessions (FR-056 two-round analysis)
const MIGRATION_013 = `
ALTER TABLE ai_analysis_sessions ADD COLUMN responseRound2 TEXT;
`

// Migration 14: data_source_config table for Tushare (FR-054)
const MIGRATION_014 = `
CREATE TABLE IF NOT EXISTS data_source_config (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  tushareTokenEncrypted  BLOB,
  tushareEnabled         INTEGER NOT NULL DEFAULT 0 CHECK (tushareEnabled IN (0,1))
);
INSERT OR IGNORE INTO data_source_config (id) VALUES (1);
`

// Migration 15: stock price cache for incremental Tushare data (FR-057)
const MIGRATION_015 = `
CREATE TABLE IF NOT EXISTS stock_price_cache (
  stockCode  TEXT    NOT NULL,
  tradeDate  TEXT    NOT NULL,
  open       REAL,
  high       REAL,
  low        REAL,
  close      REAL,
  volume     REAL,
  fetchedAt  INTEGER NOT NULL,
  PRIMARY KEY (stockCode, tradeDate)
);
CREATE INDEX IF NOT EXISTS idx_stock_price_code ON stock_price_cache(stockCode);
`

// Migration 16: add messages column to ai_analysis_sessions (FR-061 conversation history)
const MIGRATION_016 = `
ALTER TABLE ai_analysis_sessions ADD COLUMN messages TEXT;
`

// Migration 17: stock_info table for stock names (FR-063)
const MIGRATION_017 = `
CREATE TABLE IF NOT EXISTS stock_info (
  stockCode  TEXT    PRIMARY KEY,
  stockName  TEXT    NOT NULL,
  fetchedAt  INTEGER NOT NULL
);
`

// Migration 18: add amount column to stock_price_cache (FR-063 成交额)
const MIGRATION_018 = `
ALTER TABLE stock_price_cache ADD COLUMN amount REAL;
`

// Migration 19: add trendForecastPrompt to ai_config (FR-072 预测走势提示词)
const MIGRATION_019 = `
ALTER TABLE ai_config ADD COLUMN trendForecastPrompt TEXT;
UPDATE ai_config SET trendForecastPrompt = '我将会提供给你股票代码和今天大盘、这支股票的版块走势，以及这支股票此时此刻的数据。我需要你结合这些数据，以及公司的基本面分析接下来，到今天15点的走势。以符合分时图的数据返回。' WHERE id = 1 AND trendForecastPrompt IS NULL;
`

// Migration 20: add trendForecastMorrowPrompt to ai_config (FR-072 预测明日提示词)
const MIGRATION_020 = `
ALTER TABLE ai_config ADD COLUMN trendForecastMorrowPrompt TEXT;
UPDATE ai_config SET trendForecastMorrowPrompt = '我将会提供给你股票代码、今天大盘与板块分时走势，以及该股票近30天日线数据和今日完整分时数据。请综合基本面与技术面，预测明日该股票09:30至15:00的分时走势，在响应末尾以 \`\`\`json [{"time":"HH:mm","price":0.00}] \`\`\` 格式输出，并在 JSON 前用自然语言说明预测理由。' WHERE id = 1 AND trendForecastMorrowPrompt IS NULL;
`

// Migration 21: trend_forecasts table (FR-077 预测持久化) + maxForecastsPerStock in ai_config
const MIGRATION_021 = `
CREATE TABLE IF NOT EXISTS trend_forecasts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stockCode   TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK(type IN ('today','morrow')),
  points      TEXT    NOT NULL,
  aiReason    TEXT,
  provider    TEXT,
  model       TEXT,
  createdAt   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trend_forecasts_stock ON trend_forecasts(stockCode, type, createdAt DESC);
ALTER TABLE ai_config ADD COLUMN maxForecastsPerStock INTEGER NOT NULL DEFAULT 50;
`

const MIGRATION_022 = `
CREATE TABLE IF NOT EXISTS provider_api_keys (
  provider          TEXT PRIMARY KEY,
  apiKeyEncrypted   BLOB NOT NULL
);
INSERT OR IGNORE INTO provider_api_keys (provider, apiKeyEncrypted)
  SELECT provider, apiKeyEncrypted FROM ai_config
  WHERE id = 1 AND provider IS NOT NULL AND apiKeyEncrypted IS NOT NULL AND LENGTH(apiKeyEncrypted) > 0;
`

const MIGRATION_023 = `
-- Upgrade provider_api_keys → provider_configs (add per-provider model/baseUrl/prompts)
ALTER TABLE provider_api_keys RENAME TO provider_configs;
ALTER TABLE provider_configs ADD COLUMN model TEXT;
ALTER TABLE provider_configs ADD COLUMN baseUrl TEXT;
ALTER TABLE provider_configs ADD COLUMN presetPrompt TEXT;
ALTER TABLE provider_configs ADD COLUMN trendForecastPrompt TEXT;
ALTER TABLE provider_configs ADD COLUMN trendForecastMorrowPrompt TEXT;

-- Migrate global config values into current provider's row
UPDATE provider_configs
  SET model = (SELECT model FROM ai_config WHERE id = 1),
      baseUrl = (SELECT baseUrl FROM ai_config WHERE id = 1),
      presetPrompt = (SELECT presetPrompt FROM ai_config WHERE id = 1),
      trendForecastPrompt = (SELECT trendForecastPrompt FROM ai_config WHERE id = 1),
      trendForecastMorrowPrompt = (SELECT trendForecastMorrowPrompt FROM ai_config WHERE id = 1)
  WHERE provider = (SELECT provider FROM ai_config WHERE id = 1);

-- Add new columns to ai_config
ALTER TABLE ai_config ADD COLUMN providerPriority TEXT;
ALTER TABLE ai_config ADD COLUMN multiModelProviders TEXT;
ALTER TABLE ai_config ADD COLUMN maxForecastComparison INTEGER NOT NULL DEFAULT 5;

-- Initialize providerPriority / multiModelProviders from current provider
UPDATE ai_config
  SET providerPriority = CASE
        WHEN provider IS NOT NULL THEN json_array(provider)
        ELSE '[]'
      END,
      multiModelProviders = CASE
        WHEN provider IS NOT NULL THEN json_array(provider)
        ELSE '[]'
      END
  WHERE id = 1;
`

// Migration 24: Clear old default prompts so new DEFAULT_TREND_TODAY/MORROW_PROMPT constants take effect.
// Only clears prompts that still match the old migration-19/20 values; user-customized prompts are preserved.
const OLD_TODAY_PROMPT = '我将会提供给你股票代码和今天大盘、这支股票的版块走势，以及这支股票此时此刻的数据。我需要你结合这些数据，以及公司的基本面分析接下来，到今天15点的走势。以符合分时图的数据返回。'
const OLD_MORROW_PROMPT = '我将会提供给你股票代码、今天大盘与板块分时走势，以及该股票近30天日线数据和今日完整分时数据。请综合基本面与技术面，预测明日该股票09:30至15:00的分时走势，在响应末尾以 ```json [{"time":"HH:mm","price":0.00}] ``` 格式输出，并在 JSON 前用自然语言说明预测理由。'

const MIGRATION_024 = `
-- Clear old default trendForecastPrompt that was set by migration 019 (only if unchanged)
UPDATE ai_config SET trendForecastPrompt = NULL WHERE id = 1 AND trendForecastPrompt = '${OLD_TODAY_PROMPT}';
-- Clear old default trendForecastMorrowPrompt that was set by migration 020 (only if unchanged)
UPDATE ai_config SET trendForecastMorrowPrompt = NULL WHERE id = 1 AND trendForecastMorrowPrompt = '${OLD_MORROW_PROMPT}';
-- Clear old prompts from provider_configs too (only if they match the old defaults)
UPDATE provider_configs SET trendForecastPrompt = NULL WHERE trendForecastPrompt = '${OLD_TODAY_PROMPT}';
UPDATE provider_configs SET trendForecastMorrowPrompt = NULL WHERE trendForecastMorrowPrompt = '${OLD_MORROW_PROMPT}';
`

// Migration 25: Re-run prompt cleanup (migration 24 had a typo that prevented matching)
const MIGRATION_025 = `
UPDATE ai_config SET trendForecastPrompt = NULL WHERE id = 1 AND trendForecastPrompt = '${OLD_TODAY_PROMPT}';
UPDATE ai_config SET trendForecastMorrowPrompt = NULL WHERE id = 1 AND trendForecastMorrowPrompt = '${OLD_MORROW_PROMPT}';
UPDATE provider_configs SET trendForecastPrompt = NULL WHERE trendForecastPrompt = '${OLD_TODAY_PROMPT}';
UPDATE provider_configs SET trendForecastMorrowPrompt = NULL WHERE trendForecastMorrowPrompt = '${OLD_MORROW_PROMPT}';
`

// Migration 26: Add Skills (analysis framework) fields to ai_config (FR-084/085/086)
const MIGRATION_026 = `
ALTER TABLE ai_config ADD COLUMN selectedSkills TEXT DEFAULT '[]';
ALTER TABLE ai_config ADD COLUMN customSkillPaths TEXT DEFAULT '[]';
ALTER TABLE ai_config ADD COLUMN skillsForTrend INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_config ADD COLUMN maxSkillChars INTEGER NOT NULL DEFAULT 30000;
`

// Migration 27: intraday_cache table + trend_forecasts backtest columns (FR-088)
const MIGRATION_027 = `
CREATE TABLE IF NOT EXISTS intraday_cache (
  stockCode TEXT NOT NULL,
  tradeDate TEXT NOT NULL,
  points    TEXT NOT NULL,
  fetchedAt INTEGER NOT NULL,
  PRIMARY KEY (stockCode, tradeDate)
);
ALTER TABLE trend_forecasts ADD COLUMN backtestDirection INTEGER DEFAULT NULL;
ALTER TABLE trend_forecasts ADD COLUMN backtestCloseDeviation REAL DEFAULT NULL;
ALTER TABLE trend_forecasts ADD COLUMN backtestMAPE REAL DEFAULT NULL;
ALTER TABLE trend_forecasts ADD COLUMN backtestPearson REAL DEFAULT NULL;
ALTER TABLE trend_forecasts ADD COLUMN backtestAt INTEGER DEFAULT NULL;
`

// Migration 28: app_settings theme column (FR-089)
const MIGRATION_028 = `
ALTER TABLE app_settings ADD COLUMN theme TEXT DEFAULT 'light';
`

// Migration 29: app_settings market_heatmap_provider column (FR-098)
const MIGRATION_029 = `
ALTER TABLE app_settings ADD COLUMN market_heatmap_provider TEXT DEFAULT 'sina';
`

// Migration 30: app_settings momentumWindowMinutes column (FR-102)
const MIGRATION_030 = `
ALTER TABLE app_settings ADD COLUMN momentumWindowMinutes INTEGER DEFAULT 3;
`

// Migration 31: stock_minute_cache table for FR-123 (Tushare 374 rt_min K-line persistence)
const MIGRATION_031 = `
CREATE TABLE IF NOT EXISTS stock_minute_cache (
  stock_code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  ts_minute  TEXT NOT NULL,
  open   REAL,
  high   REAL,
  low    REAL,
  close  REAL,
  vol    REAL,
  amount REAL,
  fetched_at INTEGER,
  PRIMARY KEY (stock_code, trade_date, ts_minute)
);
CREATE INDEX IF NOT EXISTS idx_stock_minute_date ON stock_minute_cache(trade_date);
`

// ── FR-124 短线策略数据基础设施 Migration 032 ~ 037 ──

// Migration 032: 涨停板每日明细
const MIGRATION_032 = `
CREATE TABLE IF NOT EXISTS limit_list_daily (
  trade_date     TEXT NOT NULL,
  ts_code        TEXT NOT NULL,
  name           TEXT,
  close          REAL,
  pct_chg        REAL,
  amount         REAL,
  float_mv       REAL,
  total_mv       REAL,
  turnover_ratio REAL,
  fd_amount      REAL,
  first_time     TEXT,
  last_time      TEXT,
  open_times     INTEGER,
  up_stat        TEXT,
  limit_times    INTEGER,
  "limit"        TEXT,
  fetched_at     INTEGER,
  PRIMARY KEY (trade_date, ts_code)
);
CREATE INDEX IF NOT EXISTS idx_limit_list_daily_ts_code     ON limit_list_daily(ts_code);
CREATE INDEX IF NOT EXISTS idx_limit_list_daily_limit_times ON limit_list_daily(limit_times);
`

// Migration 033: 开盘啦概念每日榜单
const MIGRATION_033 = `
CREATE TABLE IF NOT EXISTS kpl_concept_daily (
  trade_date TEXT NOT NULL,
  ts_code    TEXT NOT NULL,
  name       TEXT,
  z_t_num    INTEGER,
  up_num     INTEGER,
  down_num   INTEGER,
  hot_num    INTEGER,
  fetched_at INTEGER,
  PRIMARY KEY (trade_date, ts_code)
);
`

// Migration 034: 开盘啦概念成分股映射
const MIGRATION_034 = `
CREATE TABLE IF NOT EXISTS kpl_concept_members (
  con_code   TEXT NOT NULL,
  con_name   TEXT,
  ts_code    TEXT NOT NULL,
  name       TEXT,
  hot_num    INTEGER,
  "desc"     TEXT,
  fetched_at INTEGER,
  PRIMARY KEY (con_code, ts_code)
);
CREATE INDEX IF NOT EXISTS idx_kpl_concept_members_ts_code ON kpl_concept_members(ts_code);
`

// Migration 035: 龙虎榜每日明细 + 机构席位（合并存储, top_inst 用 reason JSON 字段附加）
const MIGRATION_035 = `
CREATE TABLE IF NOT EXISTS top_list_daily (
  trade_date    TEXT NOT NULL,
  ts_code       TEXT NOT NULL,
  name          TEXT,
  close         REAL,
  pct_change    REAL,
  turnover_rate REAL,
  amount        REAL,
  l_sell        REAL,
  l_buy         REAL,
  l_amount      REAL,
  net_amount    REAL,
  net_rate      REAL,
  amount_rate   REAL,
  float_values  REAL,
  reason        TEXT,
  fetched_at    INTEGER,
  PRIMARY KEY (trade_date, ts_code)
);
`

// Migration 036: 短线策略信号统一存储
const MIGRATION_036 = `
CREATE TABLE IF NOT EXISTS short_term_signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy        TEXT NOT NULL,
  ts_code         TEXT,
  name            TEXT,
  trigger_at      INTEGER,
  trade_date      TEXT,
  signal_strength REAL,
  signal_meta     TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_short_term_signals_strategy ON short_term_signals(strategy, trade_date);
CREATE INDEX IF NOT EXISTS idx_short_term_signals_ts_code  ON short_term_signals(ts_code, trade_date);
`

// Migration 037: app_settings 新增子页签持久化字段
const MIGRATION_037 = `
ALTER TABLE app_settings ADD COLUMN short_term_active_sub_tab TEXT DEFAULT 'morningAuction';
`

// Migration 038: 重建 kpl_concept_daily，字段对齐 kpl_list 真实 API 输出
// 原 033 表列（z_t_num/up_num/down_num/hot_num）是错误的占位字段，kpl_list 实际返回个股竞价明细
const MIGRATION_038 = `
DROP TABLE IF EXISTS kpl_concept_daily;
CREATE TABLE IF NOT EXISTS kpl_concept_daily (
  trade_date   TEXT NOT NULL,
  ts_code      TEXT NOT NULL,
  name         TEXT,
  lu_time      TEXT,
  lu_desc      TEXT,
  tag          TEXT,
  theme        TEXT,
  bid_amount   REAL,
  status       TEXT,
  bid_turnover REAL,
  bid_pct_chg  REAL,
  pct_chg      REAL,
  fetched_at   INTEGER,
  PRIMARY KEY (trade_date, ts_code)
);
CREATE INDEX IF NOT EXISTS idx_kpl_concept_daily_theme ON kpl_concept_daily(trade_date, theme);
`

// Migration 039: 修正 kpl_concept_members 索引（con_code=股票代码才是按股查询的关键列）
const MIGRATION_039 = `
CREATE INDEX IF NOT EXISTS idx_kpl_concept_members_con_code ON kpl_concept_members(con_code);
`

// Migration 040: FR-138 日线收盘价本地缓存（daily_close_cache）
// 避免每次重启后重复调用 Tushare daily 接口拉取不可变的历史收盘价数据
const MIGRATION_040 = `
CREATE TABLE IF NOT EXISTS daily_close_cache (
  ts_code    TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  close      REAL NOT NULL,
  pct_chg    REAL,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_close_ts_code ON daily_close_cache (ts_code);
`

// Migration 041: FR-139 为 daily_close_cache 新增 OHLCV 列，支持微缩蜡烛图
// SQLite ADD COLUMN 不支持多列同行，须分三条执行
const MIGRATION_041 = `
ALTER TABLE daily_close_cache ADD COLUMN open REAL;
ALTER TABLE daily_close_cache ADD COLUMN high REAL;
ALTER TABLE daily_close_cache ADD COLUMN low  REAL;
`

// Migration 042: FR-142 筹码分布缓存表
const MIGRATION_042 = `
CREATE TABLE IF NOT EXISTS cyq_chips_cache (
  ts_code    TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  price      REAL NOT NULL,
  percent    REAL NOT NULL,
  PRIMARY KEY (ts_code, trade_date, price)
);
CREATE INDEX IF NOT EXISTS idx_cyq_chips_ts_date ON cyq_chips_cache (ts_code, trade_date);
`

// Migration 043: FR-143 技术因子缓存表（精选 21 字段）
const MIGRATION_043 = `
CREATE TABLE IF NOT EXISTS stk_factor_cache (
  ts_code        TEXT NOT NULL,
  trade_date     TEXT NOT NULL,
  close          REAL,
  macd_bfq       REAL,
  macd_dif_bfq   REAL,
  macd_dea_bfq   REAL,
  kdj_k_bfq      REAL,
  kdj_d_bfq      REAL,
  kdj_bfq        REAL,
  rsi_bfq_6      REAL,
  rsi_bfq_12     REAL,
  boll_upper_bfq REAL,
  boll_mid_bfq   REAL,
  boll_lower_bfq REAL,
  ma_bfq_5       REAL,
  ma_bfq_10      REAL,
  ma_bfq_20      REAL,
  ma_bfq_60      REAL,
  turnover_rate  REAL,
  volume_ratio   REAL,
  updays         REAL,
  downdays       REAL,
  PRIMARY KEY (ts_code, trade_date)
);
`

// Migration 044: FR-151a 为 daily_close_cache 新增 vol 列（EMA/量能计算需要成交量）
const MIGRATION_044 = `
ALTER TABLE daily_close_cache ADD COLUMN vol REAL;
`

// Migration 045: FR-151a 新建 stock_basic_cache 表（存储全市场股票基础信息，用于选股预筛）
const MIGRATION_045 = `
CREATE TABLE IF NOT EXISTS stock_basic_cache (
  ts_code    TEXT NOT NULL PRIMARY KEY,
  name       TEXT,
  industry   TEXT,
  market     TEXT,
  list_status TEXT,
  circ_float  REAL,
  updated_at  INTEGER NOT NULL
);
`

// Migration 046: FR-151a 新建 stock_screener_results 表（选股结果持久化）
const MIGRATION_046 = `
CREATE TABLE IF NOT EXISTS stock_screener_results (
  ts_code        TEXT NOT NULL,
  trade_date     TEXT NOT NULL,
  stock_name     TEXT,
  close          REAL,
  pct_chg        REAL,
  turnover_rate  REAL,
  vol            REAL,
  amount         REAL,
  signal_score   INTEGER NOT NULL DEFAULT 0,
  conditions_met TEXT,
  concepts       TEXT,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_screener_trade_date ON stock_screener_results (trade_date);
`

// Migration 047: FR-152a 为 daily_close_cache 新增 turnover_rate 列（换手率主口径）
const MIGRATION_047 = `
ALTER TABLE daily_close_cache ADD COLUMN turnover_rate REAL;
`

// Migration 048: FR-153 为 app_settings 新增 concept_source 列（题材数据源选择：kpl/ths/dc）
const MIGRATION_048 = `
ALTER TABLE app_settings ADD COLUMN concept_source TEXT DEFAULT 'kpl';
`

// Migration 049: FR-153 同花顺题材指数表（ths_concept_index）
const MIGRATION_049 = `
CREATE TABLE IF NOT EXISTS ths_concept_index (
  ts_code   TEXT PRIMARY KEY,
  name      TEXT,
  count     INTEGER,
  synced_at INTEGER NOT NULL DEFAULT 0
);
`

// Migration 050: FR-153 同花顺题材成分股表（ths_concept_members）
// 标准语义：ts_code=股票代码，con_code=概念代码（与 kpl_concept_members 语义相反）
const MIGRATION_050 = `
CREATE TABLE IF NOT EXISTS ths_concept_members (
  ts_code  TEXT NOT NULL,
  con_code TEXT NOT NULL,
  con_name TEXT,
  PRIMARY KEY (ts_code, con_code)
);
CREATE INDEX IF NOT EXISTS idx_ths_members_con_code ON ths_concept_members(con_code);
`

// Migration 051: FR-153 东方财富题材成分股表（dc_concept_members）
// 按日期存储，支持多日查询；ts_code=股票代码，theme_code=题材代码
const MIGRATION_051 = `
CREATE TABLE IF NOT EXISTS dc_concept_members (
  ts_code       TEXT NOT NULL,
  trade_date    TEXT NOT NULL,
  name          TEXT,
  theme_code    TEXT NOT NULL,
  theme_name    TEXT,
  industry_code TEXT,
  industry      TEXT,
  PRIMARY KEY (ts_code, trade_date, theme_code)
);
CREATE INDEX IF NOT EXISTS idx_dc_members_ts_date ON dc_concept_members(ts_code, trade_date);
CREATE INDEX IF NOT EXISTS idx_dc_members_theme_date ON dc_concept_members(theme_code, trade_date);
`

const MIGRATION_052 = `
CREATE TABLE IF NOT EXISTS chip_monitor_stocks (
  ts_code    TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  stock_name TEXT,
  added_at   INTEGER NOT NULL
);
`

const MIGRATION_053 = `
CREATE TABLE IF NOT EXISTS chip_monitor_results (
  ts_code         TEXT NOT NULL,
  trade_date      TEXT NOT NULL,
  bottom_pct      REAL,
  bottom_avg_cost REAL,
  loosening_1d    REAL,
  loosening_3d    REAL,
  loosening_5d    REAL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_cmr_ts_code ON chip_monitor_results(ts_code);
`

export interface DatabaseMigration {
  version: number
  sql: string
  isolateForeignKeys?: boolean
}

const MIGRATIONS: DatabaseMigration[] = [
  { version: 1, sql: MIGRATION_001 },
  { version: 2, sql: MIGRATION_002 },
  { version: 3, sql: MIGRATION_003 },
  { version: 4, sql: MIGRATION_004 },
  { version: 5, sql: MIGRATION_005 },
  { version: 6, sql: MIGRATION_006 },
  { version: 7, sql: MIGRATION_007 },
  { version: 8, sql: MIGRATION_008 },
  { version: 9, sql: MIGRATION_009 },
  { version: 10, sql: MIGRATION_010 },
  { version: 11, sql: MIGRATION_011 },
  { version: 12, sql: MIGRATION_012 },
  { version: 13, sql: MIGRATION_013 },
  { version: 14, sql: MIGRATION_014 },
  { version: 15, sql: MIGRATION_015 },
  { version: 16, sql: MIGRATION_016 },
  { version: 17, sql: MIGRATION_017 },
  { version: 18, sql: MIGRATION_018 },
  { version: 19, sql: MIGRATION_019 },
  { version: 20, sql: MIGRATION_020 },
  { version: 21, sql: MIGRATION_021 },
  { version: 22, sql: MIGRATION_022 },
  { version: 23, sql: MIGRATION_023 },
  { version: 24, sql: MIGRATION_024 },
  { version: 25, sql: MIGRATION_025 },
  { version: 26, sql: MIGRATION_026 },
  { version: 27, sql: MIGRATION_027 },
  { version: 28, sql: MIGRATION_028 },
  { version: 29, sql: MIGRATION_029 },
  { version: 30, sql: MIGRATION_030 },
  { version: 31, sql: MIGRATION_031 },
  { version: 32, sql: MIGRATION_032 },
  { version: 33, sql: MIGRATION_033 },
  { version: 34, sql: MIGRATION_034 },
  { version: 35, sql: MIGRATION_035 },
  { version: 36, sql: MIGRATION_036 },
  { version: 37, sql: MIGRATION_037 },
  { version: 38, sql: MIGRATION_038 },
  { version: 39, sql: MIGRATION_039 },
  { version: 40, sql: MIGRATION_040 },
  { version: 41, sql: MIGRATION_041 },
  { version: 42, sql: MIGRATION_042 },
  { version: 43, sql: MIGRATION_043 },
  { version: 44, sql: MIGRATION_044 },
  { version: 45, sql: MIGRATION_045 },
  { version: 46, sql: MIGRATION_046 },
  { version: 47, sql: MIGRATION_047 },
  { version: 48, sql: MIGRATION_048 },
  { version: 49, sql: MIGRATION_049 },
  { version: 50, sql: MIGRATION_050 },
  { version: 51, sql: MIGRATION_051 },
  { version: 52, sql: MIGRATION_052 },
  { version: 53, sql: MIGRATION_053 },
  { version: 54, sql: 'ALTER TABLE app_settings ADD COLUMN sector_concept_source TEXT DEFAULT \'ths\'' },
  {
    version: 55,
    sql: `
      CREATE TABLE IF NOT EXISTS sector_flow_daily (
        trade_date      TEXT NOT NULL,
        source          TEXT NOT NULL,
        concept_code    TEXT NOT NULL,
        concept_name    TEXT NOT NULL,
        total_amount    REAL NOT NULL,
        net_inflow      REAL NOT NULL,
        net_inflow_rate REAL NOT NULL,
        weighted_change REAL NOT NULL,
        member_count    INTEGER NOT NULL,
        up_count        INTEGER NOT NULL,
        down_count      INTEGER NOT NULL,
        PRIMARY KEY (trade_date, source, concept_code)
      );
      CREATE INDEX IF NOT EXISTS idx_sector_flow_daily_date_source
        ON sector_flow_daily (trade_date, source);
    `
  },
  {
    version: 56,
    sql: `
      CREATE TABLE IF NOT EXISTS stk_auction_cache (
        ts_code       TEXT NOT NULL,
        trade_date    TEXT NOT NULL,
        price         REAL,
        vol           REAL,
        amount        REAL,
        pre_close     REAL,
        turnover_rate REAL,
        volume_ratio  REAL,
        float_share   REAL,
        fetched_at    INTEGER,
        PRIMARY KEY (ts_code, trade_date)
      );
      CREATE INDEX IF NOT EXISTS idx_stk_auction_cache_date
        ON stk_auction_cache (trade_date);
    `
  },
  {
    version: 57,
    sql: `
      CREATE TABLE IF NOT EXISTS stk_auction_backtest_detail (
        trade_date   TEXT NOT NULL,
        ts_code      TEXT NOT NULL,
        pool         TEXT NOT NULL,
        buy_price    REAL,
        ret_1d       REAL,
        ret_2d       REAL,
        ret_3d       REAL,
        ret_5d       REAL,
        computed_at  INTEGER,
        PRIMARY KEY (trade_date, ts_code, pool)
      );
      CREATE INDEX IF NOT EXISTS idx_auction_bt_date
        ON stk_auction_backtest_detail (trade_date);
    `
  },
  {
    version: 58,
    sql: `
      ALTER TABLE stk_auction_backtest_detail ADD COLUMN is_one_word INTEGER NOT NULL DEFAULT 0
    `
  },
  {
    version: 59,
    sql: `
      CREATE TABLE IF NOT EXISTS trade_cal (
        cal_date      TEXT NOT NULL PRIMARY KEY,
        is_open       INTEGER NOT NULL,
        pretrade_date TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trade_cal_is_open ON trade_cal (is_open, cal_date);
    `
  },
  {
    // FR-163: 回测明细加入对应基准指数的同期涨幅，用于计算超额收益（Alpha）
    // idx_today_pct: 信号日当日基准指数涨跌幅（供大盘环境分组用）
    // idx_retNd: 基准指数同期 T+N 收益率
    version: 60,
    sql: `
      ALTER TABLE stk_auction_backtest_detail ADD COLUMN idx_today_pct REAL;
      ALTER TABLE stk_auction_backtest_detail ADD COLUMN idx_ret1d REAL;
      ALTER TABLE stk_auction_backtest_detail ADD COLUMN idx_ret2d REAL;
      ALTER TABLE stk_auction_backtest_detail ADD COLUMN idx_ret3d REAL;
      ALTER TABLE stk_auction_backtest_detail ADD COLUMN idx_ret5d REAL;
    `
  },
  {
    // FR-163f: trend_forecasts 表追加结构化 AI 输出字段
    // direction: 方向（up/down/flat）；confidence: 置信度 0-100
    // key_support/key_resistance: 关键支撑位/阻力位
    version: 61,
    sql: `
      ALTER TABLE trend_forecasts ADD COLUMN direction TEXT;
      ALTER TABLE trend_forecasts ADD COLUMN confidence REAL;
      ALTER TABLE trend_forecasts ADD COLUMN key_support REAL;
      ALTER TABLE trend_forecasts ADD COLUMN key_resistance REAL;
    `
  },
  {
    // 大盘热力图：盘中涨跌停时间序列持久化，支持盘中断点重启恢复 + 盘后回看
    version: 62,
    sql: `
      CREATE TABLE IF NOT EXISTS market_timeline_daily (
        trade_date TEXT NOT NULL,
        time       TEXT NOT NULL,
        limit_up   INTEGER NOT NULL,
        limit_down INTEGER NOT NULL,
        PRIMARY KEY (trade_date, time)
      );
      CREATE INDEX IF NOT EXISTS idx_market_timeline_date
        ON market_timeline_daily (trade_date);
    `
  },
  {
    // FR-164: 长线趋势 Watchlist（用户关注的趋势股池）
    version: 63,
    sql: `
      CREATE TABLE IF NOT EXISTS trend_watchlist (
        ts_code    TEXT PRIMARY KEY,
        stock_name TEXT NOT NULL,
        group_tag  TEXT NOT NULL DEFAULT '',
        added_at   INTEGER NOT NULL
      );
    `
  },
  {
    // FR-164: 趋势评分记录（每日存档，保留90天）
    version: 64,
    sql: `
      CREATE TABLE IF NOT EXISTS trend_scores (
        ts_code         TEXT NOT NULL,
        trade_date      TEXT NOT NULL,
        ma_score        REAL,
        ma_above_60     INTEGER,
        alpha_score     REAL,
        drawdown        REAL,
        turnover_ratio  REAL,
        macd_above_zero INTEGER,
        boll_above_mid  INTEGER,
        total_score     REAL,
        computed_at     INTEGER,
        PRIMARY KEY (ts_code, trade_date)
      );
      CREATE INDEX IF NOT EXISTS idx_trend_scores_date
        ON trend_scores (trade_date);
    `
  },
  {
    // FR-164: 趋势预警记录（保留90天）
    version: 65,
    sql: `
      CREATE TABLE IF NOT EXISTS trend_alerts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_code    TEXT NOT NULL,
        stock_name TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        alert_date TEXT NOT NULL,
        price      REAL,
        ref_price  REAL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trend_alerts_date
        ON trend_alerts (alert_date, ts_code, alert_type);
    `
  },
  {
    // FR-164 升级: trend_watchlist 新增 category/sub_category/notes 三列，
    // PK 从单列 ts_code 改为复合键 (ts_code, sub_category)，支持同一股票出现在多个细分赛道
    version: 66,
    sql: `
      CREATE TABLE IF NOT EXISTS trend_watchlist_new (
        ts_code      TEXT NOT NULL,
        stock_name   TEXT NOT NULL,
        group_tag    TEXT NOT NULL DEFAULT '',
        added_at     INTEGER NOT NULL,
        category     TEXT NOT NULL DEFAULT '',
        sub_category TEXT NOT NULL DEFAULT '',
        notes        TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (ts_code, sub_category)
      );
      INSERT OR IGNORE INTO trend_watchlist_new
        SELECT ts_code, stock_name, group_tag, added_at, '', '', ''
        FROM trend_watchlist;
      DROP TABLE IF EXISTS trend_watchlist;
      ALTER TABLE trend_watchlist_new RENAME TO trend_watchlist;
    `
  },
  {
    // FR-164 种子数据: 预置10大行业 72条赛道股票（INSERT OR IGNORE，不覆盖用户已有数据）
    version: 67,
    sql: `
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('000977.SZ', '浪潮信息', '', 1716163200000, 'AI算力', 'AI服务器', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('603019.SH', '中科曙光', '', 1716163200000, 'AI算力', 'AI服务器', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002371.SZ', '北方华创', '', 1716163200000, '半导体设备', '刻蚀设备', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002371.SZ', '北方华创', '', 1716163200000, '半导体设备', '薄膜沉积设备', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('603690.SH', '至纯科技', '', 1716163200000, '半导体设备', '清洗设备', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('600641.SH', '万业企业', '', 1716163200000, '半导体设备', '离子注入', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('603650.SH', '彤程新材', '', 1716163200000, '半导体材料', '光刻胶（KrF/ArF高端）', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300236.SZ', '上海新阳', '', 1716163200000, '半导体材料', '光刻胶（KrF/ArF高端）', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300655.SZ', '晶瑞电材', '', 1716163200000, '半导体材料', '光刻胶（G/I线成熟）', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300576.SZ', '容大感光', '', 1716163200000, '半导体材料', '光刻胶（G/I线成熟）', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002129.SZ', 'TCL中环', '', 1716163200000, '半导体材料', '半导体硅片', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('605358.SH', '立昂微', '', 1716163200000, '半导体材料', '半导体硅片', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300666.SZ', '江丰电子', '', 1716163200000, '半导体材料', '溅射靶材', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('600206.SH', '有研新材', '', 1716163200000, '半导体材料', '溅射靶材', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300054.SZ', '鼎龙股份', '', 1716163200000, '半导体材料', 'CMP抛光材料', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('301269.SZ', '华大九天', '', 1716163200000, '半导体材料', 'EDA软件', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('301095.SZ', '广立微', '', 1716163200000, '半导体材料', 'EDA软件', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('600584.SH', '长电科技', '', 1716163200000, '半导体材料', '先进封装（封测）', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002156.SZ', '通富微电', '', 1716163200000, '半导体材料', '先进封装（封测）', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002436.SZ', '兴森科技', '', 1716163200000, '半导体材料', '测试板', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300308.SZ', '中际旭创', '', 1716163200000, 'CPO', '光模块', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300502.SZ', '新易盛', '', 1716163200000, 'CPO', '光模块', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002281.SZ', '光迅科技', '', 1716163200000, 'CPO', '光器件', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300394.SZ', '天孚通信', '', 1716163200000, 'CPO', '光器件', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('000938.SZ', '紫光股份', '', 1716163200000, 'CPO', 'CPO交换机', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('301165.SZ', '锐捷网络', '', 1716163200000, 'CPO', 'CPO交换机', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300757.SZ', '罗博特科', '', 1716163200000, 'CPO', '封装/耦合设备', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002938.SZ', '鹏鼎控股', '', 1716163200000, 'PCB', '消费电子/FPC', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002384.SZ', '东山精密', '', 1716163200000, 'PCB', '消费电子/FPC', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002916.SZ', '深南电路', '', 1716163200000, 'PCB', '通信/服务器PCB', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002463.SZ', '沪电股份', '', 1716163200000, 'PCB', '通信/服务器PCB', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('603228.SH', '景旺电子', '', 1716163200000, 'PCB', '汽车电子PCB', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('603920.SH', '世运电路', '', 1716163200000, 'PCB', '汽车电子PCB', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002916.SZ', '深南电路', '', 1716163200000, 'PCB', 'IC封装基板', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002436.SZ', '兴森科技', '', 1716163200000, 'PCB', 'IC封装基板', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('600183.SH', '生益科技', '', 1716163200000, 'PCB', '覆铜板（CCL）', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300476.SZ', '胜宏科技', '', 1716163200000, 'PCB', '显卡/新能源PCB', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002913.SZ', '奥士康', '', 1716163200000, 'PCB', '显卡/新能源PCB', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('301358.SZ', '湖南裕能', '', 1716163200000, '锂电池', '磷酸铁锂正极', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300769.SZ', '德方纳米', '', 1716163200000, '锂电池', '磷酸铁锂正极', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300073.SZ', '当升科技', '', 1716163200000, '锂电池', '三元材料正极', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('920185.BJ', '贝特瑞', '', 1716163200000, '锂电池', '负极材料', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('600884.SH', '杉杉股份', '', 1716163200000, '锂电池', '负极材料', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002709.SZ', '天赐材料', '', 1716163200000, '锂电池', '电解液', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300037.SZ', '新宙邦', '', 1716163200000, '锂电池', '电解液', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002812.SZ', '恩捷股份', '', 1716163200000, '锂电池', '隔膜', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300568.SZ', '星源材质', '', 1716163200000, '锂电池', '隔膜', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002850.SZ', '科达利', '', 1716163200000, '锂电池', '结构件', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300450.SZ', '先导智能', '', 1716163200000, '锂电池', '锂电设备', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300457.SZ', '赢合科技', '', 1716163200000, '锂电池', '锂电设备', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300750.SZ', '宁德时代', '', 1716163200000, '固态电池', '固态电池（整体）', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002460.SZ', '赣锋锂业', '', 1716163200000, '固态电池', '固态电池（整体）', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002460.SZ', '赣锋锂业', '', 1716163200000, '固态电池', '硫化物电解质', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002709.SZ', '天赐材料', '', 1716163200000, '固态电池', '硫化物电解质', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('603200.SH', '上海洗霸', '', 1716163200000, '固态电池', '氧化物电解质', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002167.SZ', '东方锆业', '', 1716163200000, '固态电池', '氧化物电解质', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002812.SZ', '恩捷股份', '', 1716163200000, '固态电池', '固态电池隔膜', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300568.SZ', '星源材质', '', 1716163200000, '固态电池', '固态电池隔膜', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002202.SZ', '金风科技', '', 1716163200000, '绿色能源（风电）', '风电整机', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300772.SZ', '运达股份', '', 1716163200000, '绿色能源（风电）', '风电整机', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002080.SZ', '中材科技', '', 1716163200000, '绿色能源（风电）', '风电叶片', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('600458.SH', '时代新材', '', 1716163200000, '绿色能源（风电）', '风电叶片', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300274.SZ', '阳光电源', '', 1716163200000, '储能', '储能系统集成商', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002594.SZ', '比亚迪', '', 1716163200000, '储能', '储能系统集成商', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300750.SZ', '宁德时代', '', 1716163200000, '储能', '储能电池', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('300014.SZ', '亿纬锂能', '', 1716163200000, '储能', '储能电池', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002460.SZ', '赣锋锂业', '', 1716163200000, '能源金属', '锂矿', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('002466.SZ', '天齐锂业', '', 1716163200000, '能源金属', '锂矿', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('603799.SH', '华友钴业', '', 1716163200000, '能源金属', '钴', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('603993.SH', '洛阳钼业', '', 1716163200000, '能源金属', '钴', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('603799.SH', '华友钴业', '', 1716163200000, '能源金属', '镍', '');
      INSERT OR IGNORE INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES ('600711.SH', '盛屯矿业', '', 1716163200000, '能源金属', '镍', '');
    `
  },
  {
    version: 68,
    sql: `
      -- 为 Migration 067 种子数据补填备注（UPDATE 覆写，不受 INSERT OR IGNORE 已存在行影响）
      UPDATE trend_watchlist SET notes = '2025年市占率：中国AI服务器市占率约47%；占收入比：服务器类产品占营收93.82%；2025年报该业务收入：服务器类产品1,546.05亿元（+47.69%）；2026Q1整体营收：354.7亿元（同比-24.3%），归母净利润6.05亿元（+30.7%）' WHERE ts_code = '000977.SZ' AND sub_category = 'AI服务器';
      UPDATE trend_watchlist SET notes = '2025年市占率：政企市场市占率约41%，承建超20个智算中心；占收入比：高端计算机为绝对主业；2025年报该业务收入：整体营收149.64亿元（+13.81%）；2026Q1整体营收：30.72亿元（+18.80%），扣非归母净利润1.69亿元（+57.77%）' WHERE ts_code = '603019.SH' AND sub_category = 'AI服务器';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内集成电路装备企业第一、全球第六（Gartner 2025），多款设备市占率稳步提升；占收入比：电子工艺装备（含刻蚀/薄膜等）占营收93.32%；2025年报该业务收入：电子工艺装备367.31亿元（+32.57%），其中刻蚀及薄膜设备收入均突破100亿元，集成电路设备营收同比增超50%；2026Q1整体营收：103亿元（+25.80%），归母净利润16亿元（+3.42%）' WHERE ts_code = '002371.SZ' AND sub_category = '刻蚀设备';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内第一（与刻蚀同属电子工艺装备板块）；占收入比：电子工艺装备占93.32%；2025年报该业务收入：电子工艺装备367.31亿元（+32.57%），刻蚀及薄膜设备收入均突破100亿元；2026Q1整体营收：103亿元（+25.80%）' WHERE ts_code = '002371.SZ' AND sub_category = '薄膜沉积设备';
      UPDATE trend_watchlist SET notes = '2025年市占率：中国12寸晶圆厂特气设备及系统市占率46.9%，化学品设备及系统市占率29%；湿法清洗设备实现28纳米节点全工艺机台突破；占收入比：设备业务占营收10.01%，泛半导体合计占92.61%；2025年报该业务收入：设备业务2.86亿元，泛半导体合计26.44亿元；整体营收28.55亿元（-20.81%）；2026Q1整体营收：6.21亿元（同比-14.7%），归母净利润亏损0.79亿元' WHERE ts_code = '603690.SH' AND sub_category = '清洗设备';
      UPDATE trend_watchlist SET notes = '2025年市占率：旗下凯世通国内12英寸低能大束流离子注入机领先地位，累计获12英寸产线订单近60台，重复订单率超50%；占收入比：专用设备制造业务（离子注入机）占公司总收入约18.79%；2025年报该业务收入：离子注入机销售收入3.48亿元（+44.55%），全年交付超10台，验收超15台，创历史新高；2026Q1整体营收：5.35亿元（同比+178.17%），专用设备与材料业务合计收入占比超95%' WHERE ts_code = '600641.SH' AND sub_category = '离子注入';
      UPDATE trend_watchlist SET notes = '2025年市占率：KrF光刻胶国内市占率超40%（北京科华），显示面板光刻胶国内市占率50%；占收入比：电子化学品（含光刻胶等）占营收约27.8%；2025年报该业务收入：半导体光刻胶2025H1营收近2亿元（+50%+），全年电子化学品板块约7-8亿元；整体营收34.29亿元' WHERE ts_code = '603650.SH' AND sub_category = '光刻胶（KrF/ArF高端）';
      UPDATE trend_watchlist SET notes = '2025年市占率：集成电路材料（含光刻胶、蚀刻液等）国内领先；占收入比：集成电路材料占营收76.35%；2025年报该业务收入：集成电路材料14.79亿元；整体营收19.37亿元（+31.28%）；2026Q1整体营收：5.77亿元（+33.05%），归母净利润1.04亿元（+102.59%）' WHERE ts_code = '300236.SZ' AND sub_category = '光刻胶（KrF/ArF高端）';
      UPDATE trend_watchlist SET notes = '2025年市占率：G线光刻胶国内市占率居首（多年第一），KrF/ArF均有量产或送样突破；占收入比：高纯湿化学品占57.69%，光刻胶占13.87%；2025年报该业务收入：光刻胶业务营收2.23亿元（+12.67%）；高纯湿化学品9.29亿元（+19.30%）；整体营收16.10亿元；2026Q1整体营收：4.19亿元（+13.39%），归母净利润669万元（-84.62%）' WHERE ts_code = '300655.SZ' AND sub_category = '光刻胶（G/I线成熟）';
      UPDATE trend_watchlist SET notes = '2025年市占率：PCB湿膜光刻胶国内市占率约42%；占收入比：PCB光刻胶占总营收92.87%；2025年报该业务收入：PCB光刻胶9.93亿元（+12.58%）；整体营收10.69亿元；2026Q1整体营收：2.71亿元（+12.06%），归母净利润2685万元（-22.43%）' WHERE ts_code = '300576.SZ' AND sub_category = '光刻胶（G/I线成熟）';
      UPDATE trend_watchlist SET notes = '2025年市占率：光伏硅片市占率行业第一（半导体硅片非其主位）；占收入比：半导体材料占营收19.64%；2025年报该业务收入：光伏硅片122.38亿元；半导体材料57.07亿元；整体营收约290亿元；2026Q1整体营收：亏损16.47亿元（光伏业务承压）' WHERE ts_code = '002129.SZ' AND sub_category = '半导体硅片';
      UPDATE trend_watchlist SET notes = '2025年市占率：8英寸硅片国内市占率约18%，12英寸产能居本土前三；占收入比：半导体硅片占营收66.40%（母公司口径75.4%）；2025年报该业务收入：半导体硅片23.85亿元（合并口径），其中12英寸硅片收入8.59亿元；整体营收35.91亿元（+16.12%）；2026Q1整体营收：9.99亿元（+21.81%），归母净利润722万元，扭亏为盈；半导体硅片Q1实现收入7.5亿元' WHERE ts_code = '605358.SH' AND sub_category = '半导体硅片';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球晶圆制造溅射靶材市占率第二，3nm制程产品已量产；占收入比：超高纯靶材占营收61.90%；2025年报该业务收入：超高纯靶材28.50亿元（+22.13%）；整体营收46.04亿元（+27.72%）' WHERE ts_code = '300666.SZ' AND sub_category = '溅射靶材';
      UPDATE trend_watchlist SET notes = '2025年市占率：钴靶国内市占率100%，高纯金属靶材国内领先；占收入比：薄膜材料（核心为半导体靶材）占营收23.97%；2025年报该业务收入：薄膜材料22.88亿元（靶材收入同比增长50%）；整体营收95.42亿元；2026Q1整体营收：29.57亿元（+60.72%），归母净利润8827万元（+31%）' WHERE ts_code = '600206.SH' AND sub_category = '溅射靶材';
      UPDATE trend_watchlist SET notes = '2025年市占率：CMP抛光垫国内龙头，已进入中芯国际等头部晶圆厂批量供货，打破陶氏化学垄断；占收入比：半导体材料占总营收57%，其中CMP抛光垫占29.8%；2025年报该业务收入：CMP抛光垫10.91亿元（+52.34%）；CMP抛光液+清洗液2.94亿元（+36.84%）；半导体材料合计20.86亿元（+37.3%）；整体营收36.60亿元；2026Q1整体营收：10.2亿元（+23.8%），CMP抛光垫Q1营收3.8亿元（+71.2%），扣非净利润2.4亿元（+75.2%）' WHERE ts_code = '300054.SZ' AND sub_category = 'CMP抛光材料';
      UPDATE trend_watchlist SET notes = '2025年市占率：国产EDA龙头，国内EDA企业中收入体量最大，市场份额稳居本土EDA企业首位；占收入比：EDA软件销售占总营收81.10%；2025年报该业务收入：EDA软件销售10.75亿元（同比-1.63%）；技术服务2.01亿元（+74.93%）；整体营收13.25亿元；2026Q1整体营收：2.57亿元（+9.65%），归母净利润-0.73亿元' WHERE ts_code = '301269.SZ' AND sub_category = 'EDA软件';
      UPDATE trend_watchlist SET notes = '2025年市占率：良率提升方向国内唯一"软件+测试设备"闭环方案提供商，支持4nm工艺良率优化；占收入比：软件开发及授权占营收37.82%，测试设备及配件占61.63%；2025年报该业务收入：软件开发及授权2.78亿元（+75.13%）；测试设备及配件4.53亿元（+17.30%）；整体营收7.35亿元（+34.40%）；2026Q1整体营收：1.05亿元（+58.47%），归母净利润-1072万元（同比减亏）' WHERE ts_code = '301095.SZ' AND sub_category = 'EDA软件';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球第三、国内第一封测龙头，全球市占率约10%；占收入比：集成电路封测为绝对主业（约100%）；2025年报该业务收入：运算电子营收占比21.3%，汽车电子占比9.6%，2.5D/3D封装2025H1收入同比+217%；整体营收388.71亿元；2026Q1整体营收：91.71亿元（-1.76%），归母净利润2.90亿元（+42.74%）' WHERE ts_code = '600584.SH' AND sub_category = '先进封装（封测）';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球第四（仅次于长电），国内第二；占收入比：集成电路封装测试占营收97.59%；2025年报该业务收入：集成电路封装测试272.48亿元（+16.92%）；整体营收279.21亿元（+16.92%），归母净利润12.19亿元（+79.86%），均创历史新高；2026Q1整体营收：74.82亿元（+22.80%），归母净利润3.29亿元（+224.55%）' WHERE ts_code = '002156.SZ' AND sub_category = '先进封装（封测）';
      UPDATE trend_watchlist SET notes = '2025年市占率：半导体测试板全球市占率约15%，全球排名前三；占收入比：半导体测试板占营收3.33%，IC封装基板占23.22%，PCB占68.07%；2025年报该业务收入：半导体测试板2.39亿元；IC封装基板16.7亿元（+~50%）；PCB 48.97亿元；整体营收71.95亿元（+23.68%）；2026Q1整体营收：18.18亿元（+15.10%），归母净利润同比扭亏' WHERE ts_code = '002436.SZ' AND sub_category = '测试板';
      UPDATE trend_watchlist SET notes = '2025年市占率：800G光模块市占率超40%，全球第一（LightCounting 2025）；占收入比：光通信收发模块占营收97.95%；2025年报该业务收入：光通信收发模块374.57亿元（+63.67%）；整体营收382.40亿元（+60.25%），归母净利润107.97亿元（+108.78%）；2026Q1整体营收：194.96亿元（+192.12%），归母净利润57.35亿元（+262.28%）' WHERE ts_code = '300308.SZ' AND sub_category = '光模块';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球光模块市占率约20%-23%，国内第二；占收入比：光互联产品占营收99.72%；2025年报该业务收入：光互联产品247.71亿元（+188.07%）；整体营收248.42亿元（+187.29%），归母净利润95.32亿元（+235.89%）；2026Q1整体营收：83.38亿元（+105.76%），归母净利润27.80亿元（+76.80%）' WHERE ts_code = '300502.SZ' AND sub_category = '光模块';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球光器件行业第四位，市场份额5.9%（Omdia 2025.4Q-2026.3Q）；占收入比：数据与接入产品占营收70.94%；2025年报该业务收入：数据与接入产品84.63亿元（+65.89%）；整体营收119.29亿元（+44.20%），归母净利润9.46亿元（+43.10%）；2026Q1整体营收：27.73亿元（+24.79%），归母净利润2.4亿元（+59.76%）' WHERE ts_code = '002281.SZ' AND sub_category = '光器件';
      UPDATE trend_watchlist SET notes = '2025年市占率：CPO光接口组件全球市占率约70%（主要来自无源光器件），英伟达CPO光器件金牌供应商；占收入比：光互连元器件占营收98.43%；2025年报该业务收入：有源光器件29.98亿元（+81.11%）；无源光器件20.84亿元（+32.23%）；整体营收51.63亿元（+58.79%），归母净利润20.17亿元（+50.15%）；2026Q1整体营收：13.30亿元，归母净利润保持增长' WHERE ts_code = '300394.SZ' AND sub_category = '光器件';
      UPDATE trend_watchlist SET notes = '2025年市占率：中国企业网交换机36.1%（第一），数据中心交换机33.1%（第二），推出全球首款单芯片800G CPO硅光交换机；占收入比：ICT基础设施与服务占营收79.43%；2025年报该业务收入：ICT基础设施与服务768.47亿元；整体营收967.48亿元（+22.43%）；2026Q1整体营收：279.85亿元（同比高增），归母净利润9.61亿元' WHERE ts_code = '000938.SZ' AND sub_category = 'CPO交换机';
      UPDATE trend_watchlist SET notes = '2025年市占率：数据中心交换机国内第三（互联网行业第一），200G/400G市占率第一；占收入比：数据中心交换机业务为绝对主业（2025H1占比53.2%）；2025年报该业务收入：整体营收143.16亿元（+22.37%），归母净利润6.96亿元（+21.30%）；2026Q1整体营收：29.99亿元' WHERE ts_code = '301165.SZ' AND sub_category = 'CPO交换机';
      UPDATE trend_watchlist SET notes = '2025年市占率：硅光封装设备市占率超80%（子公司ficonTEC），呈垄断地位；占收入比：光电子及半导体封测设备占营收46.23%；2025年报该业务收入：光电子及半导体封测设备4.39亿元；光伏设备4.33亿元；整体营收约9.50亿元（-14.14%）；2026Q1整体营收：1.64亿元（+69.33%），订单兑现弹性强' WHERE ts_code = '300757.SZ' AND sub_category = '封装/耦合设备';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球PCB龙头，营收规模全球第一，高端HDI及SLP市占率超30%；占收入比：通讯用板64.98%+消费电子及计算机用板28.83%；2025年报该业务收入：通讯用板254.37亿元+消费电子及计算机用板112.87亿元；整体营收391.47亿元（+11.4%），归母净利润37.38亿元；2026Q1整体营收：79.86亿元（-1.25%），归母净利润4.63亿元（-5.21%）' WHERE ts_code = '002938.SZ' AND sub_category = '消费电子/FPC';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球PCB销售额排名第三（32.89亿美元），FPC全球前三，苹果核心FPC供应商；占收入比：电子电路产品（含PCB）占63.85%；2025年报该业务收入：电子电路产品256.2亿元；整体营收401.25亿元（+9.12%），归母净利润13.86亿元（+27.67%）；2026Q1整体营收：131.4亿元（同比高增）' WHERE ts_code = '002384.SZ' AND sub_category = '消费电子/FPC';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内唯一能量产Intel服务器认证PCB的企业，华为/中兴5G核心供应商；封装基板国内第一；占收入比：PCB占60.72%，封装基板占17.54%；2025年报该业务收入：PCB 143.59亿元（+36.84%，毛利率35.53%）；封装基板41.48亿元；整体营收236.47亿元（+32.05%），归母净利润32.76亿元（+74.47%）；2026Q1整体营收：65.96亿元（+37.90%），归母净利润8.50亿元（+73.01%）' WHERE ts_code = '002916.SZ' AND sub_category = '通信/服务器PCB';
      UPDATE trend_watchlist SET notes = '2025年市占率：英伟达GPU板主力供应商，数据中心交换机板全球份额超15%；占收入比：企业通讯市场板占约77%；2025年报该业务收入：AI服务器+HPC 30.06亿元；交换机+路由81.69亿元；整体营收189.45亿元（+42%），归母净利润38.22亿元（+47.74%）；2026Q1整体营收：62.14亿元（+53.91%），归母净利润12.42亿元（+62.9%）' WHERE ts_code = '002463.SZ' AND sub_category = '通信/服务器PCB';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球第一大汽车PCB供应商（灼识咨询），全球前十大Tier1汽车供应商中7家为客户；占收入比：印制电路板占营收93.89%；2025年报该业务收入：印制电路板143.73亿元；整体营收153.08亿元（+20.92%），归母净利润12.31亿元；2026Q1整体营收：33.4亿元（+21.9%）' WHERE ts_code = '603228.SH' AND sub_category = '汽车电子PCB';
      UPDATE trend_watchlist SET notes = '2025年市占率：特斯拉PCB最大供应商，自动驾驶雷达板技术领先；占收入比：印制电路板占营收92.49%；2025年报该业务收入：印制电路板51.58亿元；整体营收55.77亿元（+11.05%），归母净利润6.84亿元；2026Q1整体营收：13.22亿元（+8.63%），归母净利润0.37亿元（-79.63%）' WHERE ts_code = '603920.SH' AND sub_category = '汽车电子PCB';
      UPDATE trend_watchlist SET notes = '2025年市占率：FC-BGA载板国内第一，封装基板技术国内领先；占收入比：封装基板占17.54%；2025年报该业务收入：封装基板41.48亿元；整体营收236.47亿元（+32.05%）；2026Q1整体营收：65.96亿元（+37.90%）' WHERE ts_code = '002916.SZ' AND sub_category = 'IC封装基板';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内唯一ABF载板试产企业，BT载板量产（用于存储芯片），获大基金二期投资；占收入比：IC封装基板占23.22%；2025年报该业务收入：IC封装基板16.7亿元（+~50%）；整体营收71.95亿元（+23.68%）；2026Q1整体营收：18.18亿元（+15.10%）' WHERE ts_code = '002436.SZ' AND sub_category = 'IC封装基板';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内最大覆铜板供应商，自主高频高速CCL打破海外罗杰斯垄断；占收入比：CCL为绝对主业；2025年报该业务收入：CCL收入约150-160亿元（预计2026年超210亿元）；整体营收284.31亿元（+39.45%），归母净利润33.34亿元（+91.75%）；2026Q1整体营收：81.41亿元（+45%），归母净利润11.58亿元（+105%）' WHERE ts_code = '600183.SH' AND sub_category = '覆铜板（CCL）';
      UPDATE trend_watchlist SET notes = '2025年市占率：英伟达/AMD显卡板核心供应商，显卡板全球份额超25%；占收入比：PCB为绝对主业（~100%）' WHERE ts_code = '300476.SZ' AND sub_category = '显卡/新能源PCB';
      UPDATE trend_watchlist SET notes = '2025年市占率：服务器板国内份额前三，高速板支持112Gbps量产，绑定亚马逊/微软等云计算巨头；占收入比：PCB为绝对主业' WHERE ts_code = '002913.SZ' AND sub_category = '显卡/新能源PCB';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内磷酸铁锂出货量市占率约29.8%-30%，连续五年第一（中国出货量约394.4万吨，公司超100万吨）；占收入比：正极材料为绝对主业（~100%）' WHERE ts_code = '301358.SZ' AND sub_category = '磷酸铁锂正极';
      UPDATE trend_watchlist SET notes = '2025年市占率：磷酸铁锂出货量行业前列，磷酸锰铁锂（LMFP）技术储备深厚，深度绑定宁德时代；占收入比：正极材料为绝对主业' WHERE ts_code = '300769.SZ' AND sub_category = '磷酸铁锂正极';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球唯一量产Ni≥95%超高镍单晶正极企业，适配全固态电池，供货赣锋锂电、清陶能源；占收入比：正极材料为绝对主业' WHERE ts_code = '300073.SZ' AND sub_category = '三元材料正极';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球负极材料出货量59.5万吨排名第一，硅基负极全球市占率超70%，第六代超高容量产品量产，适配固态电池；占收入比：负极材料为绝对主业' WHERE ts_code = '920185.BJ' AND sub_category = '负极材料';
      UPDATE trend_watchlist SET notes = '2025年市占率：人造石墨负极全球市占率21%（排名第一），宁波4万吨一体化硅基负极基地一期满产；占收入比：负极材料为核心主业，偏光片亦为重要板块' WHERE ts_code = '600884.SH' AND sub_category = '负极材料';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球电解液绝对龙头，出货量72万吨，全球市占率32.2%，连续十年全球第一；LiFSI新型锂盐产能全球第一；占收入比：电解液为绝对主业' WHERE ts_code = '002709.SZ' AND sub_category = '电解液';
      UPDATE trend_watchlist SET notes = '2025年市占率：2025年电解液全球市占率约13%，添加剂VC/FEC市占率高达40%，海外高端客户营收占比提升至45%；占收入比：电解液为绝对主业' WHERE ts_code = '300037.SZ' AND sub_category = '电解液';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球隔膜产能与出货量双冠，湿法隔膜全球第一，全年出货接近100亿平米；占收入比：隔膜为绝对主业' WHERE ts_code = '002812.SZ' AND sub_category = '隔膜';
      UPDATE trend_watchlist SET notes = '2025年市占率：干法隔膜全球龙头，湿法及涂覆同步突破，海外布局加速（瑞典工厂）；占收入比：隔膜为绝对主业' WHERE ts_code = '300568.SZ' AND sub_category = '隔膜';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内动力电池结构件市占率超50%，全球超30%，深度绑定宁德时代、亿纬锂能；占收入比：锂电池结构件占营收96.66%；2025年报该业务收入：锂电池结构件营收147.05亿元（+28.17%）；整体营收约152亿元；2026Q1整体营收：约35亿元+' WHERE ts_code = '002850.SZ' AND sub_category = '结构件';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球锂电设备市占率约22.4%，全球唯一100%自主知识产权全固态电池整线解决方案企业；占收入比：锂电设备为绝对主业；2025年报该业务收入：2025H1新签订单124亿元（+70%），全年设备收入约150亿元+' WHERE ts_code = '300450.SZ' AND sub_category = '锂电设备';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内锂电设备第二梯队领先企业，全球锂电设备发展潜力排名前列；占收入比：锂电设备为绝对主业' WHERE ts_code = '300457.SZ' AND sub_category = '锂电设备';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球动力电池市占率约37.9%，储能电池中国市占率超66%，聚焦硫化物路线，凝聚态电池已量产，计划2027年全固态电池小批量生产；占收入比：动力电池系统占约67%，储能电池占约20%；2025年报该业务收入：整体营收8399亿元（+8.94%），归母净利润637.2亿元（+14.53%）' WHERE ts_code = '300750.SZ' AND sub_category = '固态电池（整体）';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球唯一实现硫化物电解质百吨级量产企业，全固态电池能量密度突破500Wh/kg，首款500Wh/kg级10Ah产品已送样头部车企测试；占收入比：锂化合物为核心主业，固态电池处于产业化早期；2025年报该业务收入：整体营收230.82亿元（+22.08%），归母净利润16.13亿元（+177.77%）' WHERE ts_code = '002460.SZ' AND sub_category = '固态电池（整体）';
      UPDATE trend_watchlist SET notes = '2025年市占率：百吨级量产，成本800元/公斤低于国际水平，规划2025年产能占全球15%；占收入比：占整体营收较小（产业化早期）' WHERE ts_code = '002460.SZ' AND sub_category = '硫化物电解质';
      UPDATE trend_watchlist SET notes = '2025年市占率：硫化物前驱体全球市占率超60%，开发硫化物/聚合物复合电解质，成本较日企低40%；占收入比：占比较小' WHERE ts_code = '002709.SZ' AND sub_category = '硫化物电解质';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内唯一实现LLZO氧化物电解质吨级量产企业，良品率超98%，供货比亚迪刀片固态电池项目，2025年产能计划扩至2000吨/年；占收入比：新材料业务占比持续提升' WHERE ts_code = '603200.SH' AND sub_category = '氧化物电解质';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球最大氧化锆供应商（市占率超50%），高纯度纳米氧化锆产能达1万吨/年，供货清陶能源等头部企业；占收入比：氧化锆为绝对主业' WHERE ts_code = '002167.SZ' AND sub_category = '氧化物电解质';
      UPDATE trend_watchlist SET notes = '2025年市占率：开发PI基复合电解质膜，2025年规划产能2亿平米，参股江苏三合推进半固态电池商业化；占收入比：固态电池隔膜处于导入期' WHERE ts_code = '002812.SZ' AND sub_category = '固态电池隔膜';
      UPDATE trend_watchlist SET notes = '2025年市占率：参股新源邦拥有氧化物电解质百吨级产能和十吨级出货，硫化物电解质预计2025年有吨级出货；占收入比：固态业务占比尚小' WHERE ts_code = '300568.SZ' AND sub_category = '固态电池隔膜';
      UPDATE trend_watchlist SET notes = '2025年市占率：新签风机订单29.2GW全国第一，新增装机29.3GW全球第一，海上风电新增装机占比37.6%行业居首；占收入比：风机及零部件为绝对主业；2025年报该业务收入：整体营收776.97亿元（+9.38%）' WHERE ts_code = '002202.SZ' AND sub_category = '风电整机';
      UPDATE trend_watchlist SET notes = '2025年市占率：新签风机订单25.7GW全国第二，与金风、远景前三家合计市占率超50%；占收入比：风机为绝对主业' WHERE ts_code = '300772.SZ' AND sub_category = '风电整机';
      UPDATE trend_watchlist SET notes = '2025年市占率：央企背景，风电叶片国内核心供应商，玻纤/风电/隔膜多领域协同；占收入比：风电叶片为主要板块之一' WHERE ts_code = '002080.SZ' AND sub_category = '风电叶片';
      UPDATE trend_watchlist SET notes = '2025年市占率：中国中车旗下，风电叶片业务量位居行业前列；占收入比：风电叶片为重要板块' WHERE ts_code = '600458.SH' AND sub_category = '风电叶片';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球储能系统出货稳居前二（交流侧2025Q1全球第一），国内储能系统出货量TOP10；占收入比：光伏逆变器+储能系统为两大主业；2025年报该业务收入：整体营收891.84亿元（+14.55%），归母净利润约110亿元+' WHERE ts_code = '300274.SZ' AND sub_category = '储能系统集成商';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球储能系统出货量超60GWh，市占率约13%，全球储能集成商排名第一，自供电芯一体化布局优势显著；占收入比：储能业务占比持续提升；2025年报该业务收入：整体营收7771亿元（+29.02%），归母净利润402.54亿元（+34.00%）' WHERE ts_code = '002594.SZ' AND sub_category = '储能系统集成商';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内已投运电站TOP5电池厂首位，装机能量占比超66%，全球储能电池出货量连续多年稳居第一；占收入比：储能电池系统占营收约20%；2025年报该业务收入：储能电池出货量超240GWh（全球第一），储能收入约1680亿元' WHERE ts_code = '300750.SZ' AND sub_category = '储能电池';
      UPDATE trend_watchlist SET notes = '2025年市占率：国内已投运电站TOP5电池厂第二，大圆柱电池及储能业务增长强劲；占收入比：储能电池业务占比快速提升' WHERE ts_code = '300014.SZ' AND sub_category = '储能电池';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球锂业龙头，掌控Goulamina锂辉石矿100%股权，覆盖卤水提锂、矿石提锂和回收提锂全路线；占收入比：锂化合物为核心主业；2025年报该业务收入：整体营收230.82亿元（+22.08%），归母净利润16.13亿元（+177.77%）' WHERE ts_code = '002460.SZ' AND sub_category = '锂矿';
      UPDATE trend_watchlist SET notes = '2025年市占率：控股全球最大固体锂辉石矿之一（西澳格林布什），资源自给率高，电池级氢氧化锂产能全球第一；占收入比：锂化合物为核心主业；2025年报该业务收入：整体营收103.46亿元，归母净利润4.62亿元（同比扭亏）' WHERE ts_code = '002466.SZ' AND sub_category = '锂矿';
      UPDATE trend_watchlist SET notes = '2025年市占率：全产业链（矿山→正极材料），印尼镍钴项目自供率70%+，权益钴产能3.9万吨，宁德时代/LG核心供应商；占收入比：钴产品为重要板块，三元前驱体/正极材料亦为核心；2025年报该业务收入：整体营收810.19亿元（+22.07%），归母净利润45.05亿元（+35.82%）' WHERE ts_code = '603799.SH' AND sub_category = '钴';
      UPDATE trend_watchlist SET notes = '2025年市占率：全球最大钴生产商，刚果（金）资源占优，叠加铜钴钼等多金属资源优势；占收入比：钴为重要板块（铜钴钼多金属）' WHERE ts_code = '603993.SH' AND sub_category = '钴';
      UPDATE trend_watchlist SET notes = '2025年市占率：印尼镍权益资源550万金属吨，2025年镍产能30万吨/年，2026年产能将冲50万吨，业绩弹性显著；占收入比：同钴' WHERE ts_code = '603799.SH' AND sub_category = '镍';
      UPDATE trend_watchlist SET notes = '2025年市占率：镍铁+高冰镍总产能16万吨，镍矿自给率超60%，成本优势突出；占收入比：镍为重要板块' WHERE ts_code = '600711.SH' AND sub_category = '镍';
    `
  },
  {
    // FR-165: 统一决策信号池，承接资讯/AI/短线/趋势/板块等模块的机会和风险信号
    version: 69,
    sql: `
      CREATE TABLE IF NOT EXISTS decision_signals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        source_module   TEXT NOT NULL,
        strategy_key    TEXT NOT NULL,
        ts_code         TEXT,
        stock_name      TEXT,
        concept_code    TEXT,
        concept_name    TEXT,
        signal_type     TEXT NOT NULL CHECK (signal_type IN ('ALERT','OPPORTUNITY','RISK','INFO')),
        direction       TEXT NOT NULL CHECK (direction IN ('BULLISH','BEARISH','NEUTRAL')),
        priority        INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
        score           REAL,
        confidence      REAL,
        title           TEXT NOT NULL,
        summary         TEXT NOT NULL,
        reason_json     TEXT,
        source_ref_json TEXT,
        status          TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','READ','WATCHING','DISMISSED','EXPIRED')),
        dedup_key       TEXT NOT NULL,
        signal_time     INTEGER NOT NULL,
        expire_at       INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_signals_dedup
        ON decision_signals (dedup_key);
      CREATE INDEX IF NOT EXISTS idx_decision_signals_time
        ON decision_signals (signal_time DESC);
      CREATE INDEX IF NOT EXISTS idx_decision_signals_status
        ON decision_signals (status, priority, signal_time DESC);
      CREATE INDEX IF NOT EXISTS idx_decision_signals_stock
        ON decision_signals (ts_code, signal_time DESC);
    `
  },
  {
    // FR-167: 今日看板 Windows 原生通知设置
    version: 70,
    sql: `
      ALTER TABLE app_settings ADD COLUMN decision_notify_windows_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE app_settings ADD COLUMN decision_notify_min_priority INTEGER NOT NULL DEFAULT 4;
    `
  },
  {
    // FR-168: 持仓批量 AI 预测 — 持仓股票列表
    version: 71,
    sql: `
      CREATE TABLE IF NOT EXISTS portfolio_stocks (
        ts_code    TEXT NOT NULL PRIMARY KEY,
        stock_name TEXT NOT NULL DEFAULT '',
        added_at   INTEGER NOT NULL
      );
    `
  },
  {
    // FR-171: 产业链传导分析 — 边关系表 + 设置列
    version: 72,
    sql: `
      CREATE TABLE IF NOT EXISTS supply_chain_edges (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        upstream_concept  TEXT    NOT NULL,
        downstream_concept TEXT   NOT NULL,
        relation_label    TEXT    NOT NULL DEFAULT '传导至',
        chain_group       TEXT    NOT NULL DEFAULT '通用',
        sort_order        INTEGER NOT NULL DEFAULT 0,
        is_enabled        INTEGER NOT NULL DEFAULT 1,
        UNIQUE(upstream_concept, downstream_concept)
      );
      CREATE INDEX IF NOT EXISTS idx_supply_chain_edges_group ON supply_chain_edges(chain_group);
      ALTER TABLE app_settings ADD COLUMN supply_chain_llm_fallback INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    // FR-174: 预测追问重算 — 记录来源预测和用户补充信息
    version: 73,
    sql: `
      ALTER TABLE trend_forecasts ADD COLUMN parentForecastId INTEGER DEFAULT NULL;
      ALTER TABLE trend_forecasts ADD COLUMN userFeedback TEXT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_trend_forecasts_parent
        ON trend_forecasts (parentForecastId);
    `
  },
  {
    // FR-179: 我的持仓 — 用户手填持仓成本价
    version: 74,
    sql: `
      ALTER TABLE portfolio_stocks ADD COLUMN cost_price REAL DEFAULT NULL;
    `
  },
  {
    // FR-183: AI 厂商配置 — 最大输出 Tokens
    version: 75,
    sql: `
      ALTER TABLE provider_configs ADD COLUMN maxTokens INTEGER DEFAULT NULL;
    `
  },
  {
    // FR-186: 筹码松动结果按计算模式隔离，并记录空值原因
    version: 76,
    sql: `
      ALTER TABLE chip_monitor_results ADD COLUMN mode TEXT NOT NULL DEFAULT 'relative';
      ALTER TABLE chip_monitor_results ADD COLUMN loosening_1d_reason TEXT DEFAULT NULL;
      ALTER TABLE chip_monitor_results ADD COLUMN loosening_3d_reason TEXT DEFAULT NULL;
      ALTER TABLE chip_monitor_results ADD COLUMN loosening_5d_reason TEXT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_cmr_mode_trade_date ON chip_monitor_results(mode, trade_date DESC);
    `
  },
  {
    // FR-187: 预测记录目标日期，用于按实际预测交易日分组
    version: 77,
    sql: `
      ALTER TABLE trend_forecasts ADD COLUMN targetDate TEXT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_trend_forecasts_target
        ON trend_forecasts (stockCode, targetDate DESC, createdAt DESC);
    `
  },
  {
    // FR-188: 预测准确率增强闭环 — 输入快照、误差归因和用户样本标签
    version: 78,
    sql: `
      ALTER TABLE trend_forecasts ADD COLUMN inputSnapshot TEXT DEFAULT NULL;
      ALTER TABLE trend_forecasts ADD COLUMN errorAnalysis TEXT DEFAULT NULL;
      ALTER TABLE trend_forecasts ADD COLUMN userOutcomeTag TEXT DEFAULT NULL;
      ALTER TABLE trend_forecasts ADD COLUMN userOutcomeNote TEXT DEFAULT NULL;
      ALTER TABLE trend_forecasts ADD COLUMN userOutcomeUpdatedAt INTEGER DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_trend_forecasts_outcome
        ON trend_forecasts (userOutcomeTag, createdAt DESC);
    `
  },
  {
    // FR-190: 统一信号生命周期与处置闭环
    version: 79,
    sql: `
      ALTER TABLE decision_signals ADD COLUMN first_seen_at INTEGER DEFAULT NULL;
      ALTER TABLE decision_signals ADD COLUMN last_seen_at INTEGER DEFAULT NULL;
      ALTER TABLE decision_signals ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE decision_signals ADD COLUMN acknowledged_at INTEGER DEFAULT NULL;
      ALTER TABLE decision_signals ADD COLUMN watched_at INTEGER DEFAULT NULL;
      ALTER TABLE decision_signals ADD COLUMN dismissed_at INTEGER DEFAULT NULL;
      ALTER TABLE decision_signals ADD COLUMN resolved_at INTEGER DEFAULT NULL;
      ALTER TABLE decision_signals ADD COLUMN resolution TEXT DEFAULT NULL;
      ALTER TABLE decision_signals ADD COLUMN resolution_note TEXT DEFAULT NULL;
      UPDATE decision_signals
      SET first_seen_at = COALESCE(first_seen_at, created_at),
          last_seen_at = COALESCE(last_seen_at, signal_time),
          occurrence_count = CASE WHEN occurrence_count < 1 THEN 1 ELSE occurrence_count END;
      CREATE TABLE IF NOT EXISTS decision_signal_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id    INTEGER NOT NULL,
        event_type   TEXT NOT NULL,
        from_status  TEXT DEFAULT NULL,
        to_status    TEXT DEFAULT NULL,
        resolution   TEXT DEFAULT NULL,
        reason       TEXT DEFAULT NULL,
        note         TEXT DEFAULT NULL,
        created_at   INTEGER NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES decision_signals(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_decision_signal_events_signal
        ON decision_signal_events (signal_id, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_decision_signals_resolution
        ON decision_signals (resolution, resolved_at DESC);
    `
  },
  {
    // FR-207: 个性选股 AI 逐票归因解读缓存
    version: 80,
    sql: `
      CREATE TABLE IF NOT EXISTS screener_insights (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date          TEXT NOT NULL,
        ts_code             TEXT NOT NULL,
        stock_name          TEXT DEFAULT NULL,
        evidence_hash       TEXT NOT NULL,
        evidence_json       TEXT NOT NULL,
        insight_json        TEXT NOT NULL,
        provider            TEXT DEFAULT NULL,
        model               TEXT DEFAULT NULL,
        usage_json          TEXT DEFAULT NULL,
        finish_reason       TEXT DEFAULT NULL,
        compliance_blocked  INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        UNIQUE(trade_date, ts_code, evidence_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_screener_insights_trade_date
        ON screener_insights (trade_date DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_screener_insights_stock
        ON screener_insights (ts_code, trade_date DESC, updated_at DESC);
    `
  },
  {
    // FR-208/FR-210: 个性选股白盒排序配置
    version: 81,
    sql: `
      CREATE TABLE IF NOT EXISTS screener_rank_config (
        id                      INTEGER PRIMARY KEY CHECK (id = 1),
        weights_json            TEXT NOT NULL,
        tie_breaker             TEXT NOT NULL DEFAULT 'pctChg',
        normalize_enabled       INTEGER NOT NULL DEFAULT 0,
        normalization_caps_json TEXT NOT NULL,
        updated_at              INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO screener_rank_config
        (id, weights_json, tie_breaker, normalize_enabled, normalization_caps_json, updated_at)
      VALUES (
        1,
        '{"crossUp":1,"volAmplified":1,"bullTrend":1,"macdBull":1,"hasTurnover":1,"moneyInflow":0}',
        'pctChg',
        0,
        '{"volAmplified":3,"macdBull":0.08,"hasTurnover":8,"moneyInflow":5}',
        strftime('%s','now') * 1000
      );
    `
  },
  {
    // FR-209: Tushare moneyflow 个股资金流向缓存，金额统一为元
    version: 82,
    sql: `
      CREATE TABLE IF NOT EXISTS stock_moneyflow_daily (
        ts_code          TEXT NOT NULL,
        trade_date       TEXT NOT NULL,
        buy_sm_vol       REAL,
        buy_sm_amount    REAL,
        sell_sm_vol      REAL,
        sell_sm_amount   REAL,
        buy_md_vol       REAL,
        buy_md_amount    REAL,
        sell_md_vol      REAL,
        sell_md_amount   REAL,
        buy_lg_vol       REAL,
        buy_lg_amount    REAL,
        sell_lg_vol      REAL,
        sell_lg_amount   REAL,
        buy_elg_vol      REAL,
        buy_elg_amount   REAL,
        sell_elg_vol     REAL,
        sell_elg_amount  REAL,
        net_mf_vol       REAL,
        net_mf_amount    REAL,
        fetched_at       INTEGER NOT NULL,
        PRIMARY KEY (ts_code, trade_date)
      );
      CREATE INDEX IF NOT EXISTS idx_stock_moneyflow_trade_date
        ON stock_moneyflow_daily (trade_date);
    `
  },
  {
    // FR-208~FR-210: 选股结果持久化排序解释和资金摘要
    version: 83,
    sql: `
      ALTER TABLE stock_screener_results ADD COLUMN rank_score REAL DEFAULT 0;
      ALTER TABLE stock_screener_results ADD COLUMN rank_breakdown_json TEXT DEFAULT NULL;
      ALTER TABLE stock_screener_results ADD COLUMN moneyflow_json TEXT DEFAULT NULL;
      ALTER TABLE stock_screener_results ADD COLUMN signal_strength_json TEXT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_screener_rank_score
        ON stock_screener_results (trade_date, rank_score DESC);
    `
  },
  {
    // FR-186 修复: SQLite ALTER ADD COLUMN 无法修改主键, 需要重建表让 mode 真正参与唯一约束
    version: 84,
    sql: `
      CREATE TABLE IF NOT EXISTS chip_monitor_results_new (
        ts_code              TEXT NOT NULL,
        trade_date           TEXT NOT NULL,
        mode                 TEXT NOT NULL DEFAULT 'relative',
        bottom_pct           REAL,
        bottom_avg_cost      REAL,
        loosening_1d         REAL,
        loosening_3d         REAL,
        loosening_5d         REAL,
        updated_at           INTEGER NOT NULL,
        loosening_1d_reason  TEXT DEFAULT NULL,
        loosening_3d_reason  TEXT DEFAULT NULL,
        loosening_5d_reason  TEXT DEFAULT NULL,
        PRIMARY KEY (ts_code, trade_date, mode)
      );
      INSERT OR REPLACE INTO chip_monitor_results_new
        (ts_code, trade_date, mode, bottom_pct, bottom_avg_cost,
         loosening_1d, loosening_3d, loosening_5d, updated_at,
         loosening_1d_reason, loosening_3d_reason, loosening_5d_reason)
      SELECT ts_code,
             trade_date,
             CASE WHEN mode = 'absolute' THEN 'absolute' ELSE 'relative' END,
             bottom_pct,
             bottom_avg_cost,
             loosening_1d,
             loosening_3d,
             loosening_5d,
             updated_at,
             loosening_1d_reason,
             loosening_3d_reason,
             loosening_5d_reason
      FROM chip_monitor_results;
      DROP TABLE IF EXISTS chip_monitor_results;
      ALTER TABLE chip_monitor_results_new RENAME TO chip_monitor_results;
      CREATE INDEX IF NOT EXISTS idx_cmr_ts_code ON chip_monitor_results(ts_code);
      CREATE INDEX IF NOT EXISTS idx_cmr_mode_trade_date ON chip_monitor_results(mode, trade_date DESC);
    `
  },
  {
    // 策略级回测引擎 P1：回测运行记录（param_hash 命中即复用，避免重复计算）
    version: 85,
    sql: `
      CREATE TABLE IF NOT EXISTS strategy_backtest_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_key  TEXT NOT NULL,
        date_start    TEXT NOT NULL,
        date_end      TEXT NOT NULL,
        plan_json     TEXT NOT NULL,
        param_hash    TEXT NOT NULL,
        report_json   TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        UNIQUE(param_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_sbr_strategy ON strategy_backtest_runs(strategy_key, created_at DESC);
    `
  },
  {
    // 策略级回测引擎 P1：单笔交易明细（支撑 UI 下钻 + 调试，随 run 级联清理）
    version: 86,
    sql: `
      CREATE TABLE IF NOT EXISTS strategy_backtest_trades (
        run_id        INTEGER NOT NULL,
        ts_code       TEXT NOT NULL,
        entry_date    TEXT,
        entry_price   REAL,
        exit_date     TEXT,
        exit_price    REAL,
        return_pct    REAL,
        exit_reason   TEXT,
        strength      REAL,
        PRIMARY KEY (run_id, ts_code, entry_date)
      );
      CREATE INDEX IF NOT EXISTS idx_sbt_run ON strategy_backtest_trades(run_id);
    `
  },
  {
    // 策略级回测引擎 P1：兼容早期本地 085/086 已应用但字段较少的开发库
    version: 87,
    sql: `
      CREATE TABLE IF NOT EXISTS strategy_backtest_runs_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_key  TEXT NOT NULL,
        date_start    TEXT NOT NULL,
        date_end      TEXT NOT NULL,
        plan_json     TEXT NOT NULL,
        param_hash    TEXT NOT NULL,
        report_json   TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT DEFAULT NULL,
        created_at    INTEGER NOT NULL,
        completed_at  INTEGER DEFAULT NULL,
        UNIQUE(param_hash)
      );
      INSERT OR IGNORE INTO strategy_backtest_runs_new
        (id, strategy_key, date_start, date_end, plan_json, param_hash, report_json, status, error_message, created_at, completed_at)
      SELECT id, strategy_key, date_start, date_end, plan_json, param_hash, report_json,
             'completed', NULL, created_at, created_at
      FROM strategy_backtest_runs;
      DROP TABLE IF EXISTS strategy_backtest_runs;
      ALTER TABLE strategy_backtest_runs_new RENAME TO strategy_backtest_runs;
      CREATE INDEX IF NOT EXISTS idx_sbr_strategy ON strategy_backtest_runs(strategy_key, created_at DESC);

      CREATE TABLE IF NOT EXISTS strategy_backtest_trades_new (
        run_id        INTEGER NOT NULL,
        strategy_key  TEXT NOT NULL,
        ts_code       TEXT NOT NULL,
        signal_date   TEXT NOT NULL,
        entry_date    TEXT,
        entry_price   REAL,
        exit_date     TEXT,
        exit_price    REAL,
        gross_return_pct REAL,
        net_return_pct REAL,
        return_pct    REAL,
        exit_reason   TEXT,
        status        TEXT NOT NULL DEFAULT 'executed',
        strength      REAL,
        meta_json     TEXT DEFAULT NULL,
        PRIMARY KEY (run_id, ts_code, signal_date, entry_date)
      );
      INSERT OR IGNORE INTO strategy_backtest_trades_new
        (run_id, strategy_key, ts_code, signal_date, entry_date, entry_price, exit_date, exit_price,
         gross_return_pct, net_return_pct, return_pct, exit_reason, status, strength, meta_json)
      SELECT run_id, '', ts_code, '', entry_date, entry_price, exit_date, exit_price,
             return_pct, return_pct, return_pct, exit_reason,
             CASE WHEN return_pct IS NULL THEN 'data_insufficient' ELSE 'executed' END,
             strength, NULL
      FROM strategy_backtest_trades;
      DROP TABLE IF EXISTS strategy_backtest_trades;
      ALTER TABLE strategy_backtest_trades_new RENAME TO strategy_backtest_trades;
      CREATE INDEX IF NOT EXISTS idx_sbt_run ON strategy_backtest_trades(run_id);
      CREATE INDEX IF NOT EXISTS idx_sbt_strategy_signal ON strategy_backtest_trades(strategy_key, signal_date);
      CREATE INDEX IF NOT EXISTS idx_sbt_ts_code ON strategy_backtest_trades(ts_code);
    `
  },
  {
    // FR-212 条件积木策略引擎 P1：模板、扫描运行和命中证据
    version: 88,
    sql: `
      CREATE TABLE IF NOT EXISTS condition_block_templates (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        template_key  TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        description   TEXT DEFAULT NULL,
        version       INTEGER NOT NULL DEFAULT 1,
        enabled       INTEGER NOT NULL DEFAULT 1,
        template_json TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_condition_templates_enabled
        ON condition_block_templates(enabled, updated_at DESC);

      CREATE TABLE IF NOT EXISTS condition_block_scan_runs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id       INTEGER NOT NULL,
        template_key      TEXT NOT NULL,
        template_version  INTEGER NOT NULL,
        date_start        TEXT NOT NULL,
        date_end          TEXT NOT NULL,
        scope_json        TEXT NOT NULL,
        param_hash        TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'running',
        error_message     TEXT DEFAULT NULL,
        total_stocks      INTEGER NOT NULL DEFAULT 0,
        matched_count     INTEGER NOT NULL DEFAULT 0,
        summary_json      TEXT DEFAULT NULL,
        created_at        INTEGER NOT NULL,
        completed_at      INTEGER DEFAULT NULL,
        UNIQUE(param_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_condition_scan_template
        ON condition_block_scan_runs(template_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_condition_scan_status
        ON condition_block_scan_runs(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS condition_block_matches (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id            INTEGER NOT NULL,
        template_key      TEXT NOT NULL,
        template_version  INTEGER NOT NULL,
        ts_code           TEXT NOT NULL,
        stock_name        TEXT DEFAULT NULL,
        trade_date        TEXT NOT NULL,
        window_start      TEXT DEFAULT NULL,
        window_end        TEXT DEFAULT NULL,
        total_score       REAL NOT NULL DEFAULT 0,
        data_status       TEXT NOT NULL DEFAULT 'partial',
        evidence_json     TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        UNIQUE(run_id, ts_code, trade_date, window_start, window_end)
      );
      CREATE INDEX IF NOT EXISTS idx_condition_matches_run
        ON condition_block_matches(run_id, total_score DESC);
      CREATE INDEX IF NOT EXISTS idx_condition_matches_template_date
        ON condition_block_matches(template_key, trade_date DESC, total_score DESC);
      CREATE INDEX IF NOT EXISTS idx_condition_matches_stock
        ON condition_block_matches(ts_code, trade_date DESC);
    `
  },
  {
    // FR-218: 免费分钟基础缓存。5分钟近似数据与 stock_minute_cache 的1分钟精确缓存隔离。
    version: 89,
    sql: `
      CREATE TABLE IF NOT EXISTS free_minute_cache (
        provider_id TEXT NOT NULL,
        ts_code     TEXT NOT NULL,
        trade_date  TEXT NOT NULL,
        granularity TEXT NOT NULL,
        ts_minute   TEXT NOT NULL,
        open        REAL,
        high        REAL,
        low         REAL,
        close       REAL NOT NULL,
        vol         REAL,
        amount      REAL,
        fetched_at  INTEGER NOT NULL,
        PRIMARY KEY (provider_id, ts_code, trade_date, granularity, ts_minute)
      );
      CREATE INDEX IF NOT EXISTS idx_free_minute_cache_lookup
        ON free_minute_cache(provider_id, ts_code, trade_date, granularity);
    `
  },
  {
    // FR-225 P2: 策略实验室统一策略模板与草稿持久化
    version: 90,
    sql: `
      CREATE TABLE IF NOT EXISTS strategy_lab_strategies (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_key     TEXT NOT NULL UNIQUE,
        name             TEXT NOT NULL,
        description      TEXT DEFAULT NULL,
        source           TEXT NOT NULL CHECK (source IN ('screener','conditionBlocks','custom')),
        status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','disabled')),
        enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        is_builtin       INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
        version          INTEGER NOT NULL DEFAULT 1,
        rule_draft_json  TEXT NOT NULL,
        run_config_json  TEXT NOT NULL,
        actions_json     TEXT NOT NULL,
        last_run_at      INTEGER DEFAULT NULL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_strategy_lab_strategies_source
        ON strategy_lab_strategies(source, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_strategy_lab_strategies_status
        ON strategy_lab_strategies(status, enabled, updated_at DESC);
    `
  },
  {
    // FR-225 P3: 策略实验室统一运行记录与命中结果
    version: 91,
    sql: `
      CREATE TABLE IF NOT EXISTS strategy_lab_runs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id       INTEGER NOT NULL,
        strategy_key      TEXT NOT NULL,
        strategy_name     TEXT NOT NULL,
        source            TEXT NOT NULL CHECK (source IN ('screener','conditionBlocks','custom')),
        status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('queued','running','completed','failed','cancelled')),
        date_start        TEXT DEFAULT NULL,
        date_end          TEXT DEFAULT NULL,
        run_config_json   TEXT NOT NULL,
        summary_json      TEXT DEFAULT NULL,
        error_message     TEXT DEFAULT NULL,
        backtest_run_id   INTEGER DEFAULT NULL,
        created_at        INTEGER NOT NULL,
        started_at        INTEGER DEFAULT NULL,
        completed_at      INTEGER DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_strategy_lab_runs_strategy
        ON strategy_lab_runs(strategy_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_strategy_lab_runs_status
        ON strategy_lab_runs(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS strategy_lab_matches (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id            INTEGER NOT NULL,
        strategy_id       INTEGER NOT NULL,
        strategy_key      TEXT NOT NULL,
        source            TEXT NOT NULL CHECK (source IN ('screener','conditionBlocks','custom')),
        ts_code           TEXT NOT NULL,
        stock_name        TEXT DEFAULT NULL,
        trade_date        TEXT NOT NULL,
        score             REAL NOT NULL DEFAULT 0,
        signal_strength   REAL DEFAULT NULL,
        matched_from      TEXT NOT NULL,
        evidence_json     TEXT NOT NULL,
        action_json       TEXT DEFAULT NULL,
        created_at        INTEGER NOT NULL,
        UNIQUE(run_id, ts_code, trade_date, matched_from)
      );
      CREATE INDEX IF NOT EXISTS idx_strategy_lab_matches_run
        ON strategy_lab_matches(run_id, score DESC);
      CREATE INDEX IF NOT EXISTS idx_strategy_lab_matches_strategy
        ON strategy_lab_matches(strategy_id, trade_date DESC, score DESC);
      CREATE INDEX IF NOT EXISTS idx_strategy_lab_matches_stock
        ON strategy_lab_matches(ts_code, trade_date DESC);
    `
  },
  {
    // FR-226 P2: AI 分析结构化研判结果
    version: 92,
    sql: `
      CREATE TABLE IF NOT EXISTS ai_analysis_structured_results (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id              INTEGER NOT NULL UNIQUE REFERENCES ai_analysis_sessions(id) ON DELETE CASCADE,
        schema_version          INTEGER NOT NULL DEFAULT 1,
        status                  TEXT NOT NULL CHECK (status IN ('completed','parse_failed')),
        summary                 TEXT DEFAULT NULL,
        confidence              REAL DEFAULT NULL,
        primary_theme           TEXT DEFAULT NULL,
        themes_json             TEXT NOT NULL DEFAULT '[]',
        candidate_stocks_json   TEXT NOT NULL DEFAULT '[]',
        risk_factors_json       TEXT NOT NULL DEFAULT '[]',
        verification_items_json TEXT NOT NULL DEFAULT '[]',
        source_refs_json        TEXT NOT NULL DEFAULT '[]',
        raw_json                TEXT DEFAULT NULL,
        error_message           TEXT DEFAULT NULL,
        generated_at            INTEGER DEFAULT NULL,
        updated_at              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_structured_results_session
        ON ai_analysis_structured_results(session_id);
      CREATE INDEX IF NOT EXISTS idx_ai_structured_results_status
        ON ai_analysis_structured_results(status, updated_at DESC);
    `
  },
  {
    // FR-227 P2: 早盘集合竞价结构化研判结果
    version: 93,
    sql: `
      CREATE TABLE IF NOT EXISTS morning_auction_insights (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date              TEXT NOT NULL,
        ts_code                 TEXT NOT NULL,
        stock_name              TEXT NOT NULL,
        pool_key                TEXT NOT NULL,
        schema_version          INTEGER NOT NULL DEFAULT 1,
        score                   REAL NOT NULL DEFAULT 0,
        score_breakdown_json    TEXT NOT NULL DEFAULT '[]',
        entry_reasons_json      TEXT NOT NULL DEFAULT '[]',
        verification_items_json TEXT NOT NULL DEFAULT '[]',
        risk_flags_json         TEXT NOT NULL DEFAULT '[]',
        intraday_preview_json   TEXT DEFAULT NULL,
        backtest_summary_json   TEXT DEFAULT NULL,
        chip_status             TEXT NOT NULL CHECK (chip_status IN ('available','missing','insufficient')),
        status                  TEXT NOT NULL CHECK (status IN ('completed','partial','failed')),
        error_message           TEXT DEFAULT NULL,
        generated_at            INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        UNIQUE(trade_date, ts_code, pool_key)
      );
      CREATE INDEX IF NOT EXISTS idx_morning_auction_insights_date_score
        ON morning_auction_insights(trade_date, score DESC);
      CREATE INDEX IF NOT EXISTS idx_morning_auction_insights_stock
        ON morning_auction_insights(ts_code, trade_date DESC);
      CREATE INDEX IF NOT EXISTS idx_morning_auction_insights_status
        ON morning_auction_insights(trade_date, status, updated_at DESC);
    `
  },
  {
    // FR-228 P1: 官方每日筹码成本与获利比例缓存
    version: 94,
    sql: `
      CREATE TABLE IF NOT EXISTS cyq_perf_cache (
        ts_code          TEXT NOT NULL,
        trade_date       TEXT NOT NULL,
        his_low          REAL DEFAULT NULL,
        his_high         REAL DEFAULT NULL,
        cost_5pct        REAL DEFAULT NULL,
        cost_15pct       REAL DEFAULT NULL,
        cost_50pct       REAL DEFAULT NULL,
        cost_85pct       REAL DEFAULT NULL,
        cost_95pct       REAL DEFAULT NULL,
        weight_avg       REAL DEFAULT NULL,
        winner_rate      REAL DEFAULT NULL,
        winner_rate_unit TEXT NOT NULL DEFAULT 'percent'
          CHECK (winner_rate_unit IN ('percent','ratio')),
        fetched_at       INTEGER NOT NULL,
        PRIMARY KEY(ts_code, trade_date)
      );
      CREATE INDEX IF NOT EXISTS idx_cyq_perf_cache_stock_date
        ON cyq_perf_cache(ts_code, trade_date DESC);
      CREATE INDEX IF NOT EXISTS idx_cyq_perf_cache_trade_date
        ON cyq_perf_cache(trade_date DESC);
    `
  },
  {
    // FR-228 P2: 龙虎榜机构席位明细与交易日同步覆盖
    version: 95,
    sql: `
      CREATE TABLE IF NOT EXISTS top_inst_daily (
        trade_date       TEXT NOT NULL,
        ts_code          TEXT NOT NULL,
        institution_name TEXT NOT NULL DEFAULT '',
        side             INTEGER NOT NULL CHECK (side IN (0, 1)),
        buy_amount       REAL DEFAULT NULL,
        buy_rate         REAL DEFAULT NULL,
        sell_amount      REAL DEFAULT NULL,
        sell_rate        REAL DEFAULT NULL,
        net_amount       REAL DEFAULT NULL,
        reason           TEXT NOT NULL DEFAULT '',
        fetched_at       INTEGER NOT NULL,
        PRIMARY KEY(trade_date, ts_code, institution_name, side, reason)
      );
      CREATE INDEX IF NOT EXISTS idx_top_inst_daily_stock_date
        ON top_inst_daily(ts_code, trade_date DESC);
      CREATE INDEX IF NOT EXISTS idx_top_inst_daily_trade_date
        ON top_inst_daily(trade_date DESC);

      CREATE TABLE IF NOT EXISTS top_inst_sync_coverage (
        trade_date   TEXT PRIMARY KEY,
        status       TEXT NOT NULL CHECK (status IN ('success', 'failed')),
        row_count    INTEGER NOT NULL DEFAULT 0,
        error_code   TEXT DEFAULT NULL,
        attempted_at INTEGER NOT NULL,
        completed_at INTEGER DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_top_inst_sync_coverage_status
        ON top_inst_sync_coverage(status, trade_date DESC);
    `
  },
  {
    // FR-228 审查修复: 保留同席位、同方向、同原因的不同经济记录
    version: 96,
    sql: `
      CREATE TABLE top_inst_daily_v096 (
        trade_date       TEXT NOT NULL,
        ts_code          TEXT NOT NULL,
        institution_name TEXT NOT NULL DEFAULT '',
        side             INTEGER NOT NULL CHECK (side IN (0, 1)),
        buy_amount       REAL DEFAULT NULL,
        buy_rate         REAL DEFAULT NULL,
        sell_amount      REAL DEFAULT NULL,
        sell_rate        REAL DEFAULT NULL,
        net_amount       REAL DEFAULT NULL,
        reason           TEXT NOT NULL DEFAULT '',
        record_key       TEXT NOT NULL,
        fetched_at       INTEGER NOT NULL,
        PRIMARY KEY(trade_date, ts_code, side, record_key)
      );
      INSERT OR REPLACE INTO top_inst_daily_v096 (
        trade_date, ts_code, institution_name, side,
        buy_amount, buy_rate, sell_amount, sell_rate, net_amount,
        reason, record_key, fetched_at
      )
      SELECT
        trade_date, ts_code, institution_name, side,
        buy_amount, buy_rate, sell_amount, sell_rate, net_amount,
        reason,
        institution_name || char(31) || reason || char(31) ||
          CASE WHEN buy_amount IS NULL THEN 'null' ELSE printf('%.17g', buy_amount) END || char(31) ||
          CASE WHEN buy_rate IS NULL THEN 'null' ELSE printf('%.17g', buy_rate) END || char(31) ||
          CASE WHEN sell_amount IS NULL THEN 'null' ELSE printf('%.17g', sell_amount) END || char(31) ||
          CASE WHEN sell_rate IS NULL THEN 'null' ELSE printf('%.17g', sell_rate) END || char(31) ||
          CASE WHEN net_amount IS NULL THEN 'null' ELSE printf('%.17g', net_amount) END,
        fetched_at
      FROM top_inst_daily;
      DROP TABLE top_inst_daily;
      ALTER TABLE top_inst_daily_v096 RENAME TO top_inst_daily;
      CREATE INDEX idx_top_inst_daily_stock_date
        ON top_inst_daily(ts_code, trade_date DESC);
      CREATE INDEX idx_top_inst_daily_trade_date
        ON top_inst_daily(trade_date DESC);
    `
  },
  {
    // FR-228 运行时修复: 支撑日线按交易日查询，避免数据增长后扫描全表
    version: 97,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_daily_close_trade_date
        ON daily_close_cache(trade_date DESC);
    `
  },
  {
    // FR-229: 跨重启保留最近一次历史日线清理结果
    version: 98,
    sql: `
      CREATE TABLE daily_close_maintenance_state (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        status               TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
        started_at           INTEGER NOT NULL,
        completed_at         INTEGER DEFAULT NULL,
        retain_trade_days    INTEGER NOT NULL,
        removed_rows         INTEGER DEFAULT NULL,
        remaining_trade_days INTEGER DEFAULT NULL,
        message              TEXT DEFAULT NULL
      );
    `
  },
  {
    // FR-230: 产业研究项目、结构化图谱、证据与假设事实层
    version: 99,
    sql: `
      CREATE TABLE industry_research_projects (
        id                   TEXT PRIMARY KEY,
        schema_version       INTEGER NOT NULL DEFAULT 1,
        title                TEXT NOT NULL,
        industry_name        TEXT NOT NULL,
        product_scope        TEXT NOT NULL,
        region_scope         TEXT NOT NULL,
        time_scope           TEXT NOT NULL,
        purpose              TEXT NOT NULL CHECK (purpose IN ('learning', 'strategy', 'investment')),
        depth                TEXT NOT NULL CHECK (depth IN ('quick', 'standard', 'deep')),
        status               TEXT NOT NULL CHECK (status IN ('draft', 'active', 'review_due', 'archived')),
        data_as_of           TEXT DEFAULT NULL,
        valuation_date       TEXT DEFAULT NULL,
        source_type          TEXT NOT NULL CHECK (source_type IN ('manual', 'briefing', 'ai_analysis', 'decision_signal', 'supply_chain')),
        source_ref           TEXT DEFAULT NULL,
        source_text_summary  TEXT DEFAULT NULL,
        skill_id             TEXT NOT NULL,
        skill_content_hash   TEXT NOT NULL,
        skill_rule_version   TEXT DEFAULT NULL,
        generation_model     TEXT DEFAULT NULL,
        next_review_at       INTEGER DEFAULT NULL,
        stop_condition       TEXT DEFAULT NULL,
        graph_updated_at     INTEGER NOT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_projects_status_updated
        ON industry_research_projects(status, updated_at DESC);
      CREATE INDEX idx_industry_research_projects_industry
        ON industry_research_projects(industry_name, updated_at DESC);

      CREATE TABLE industry_research_nodes (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        type                 TEXT NOT NULL CHECK (type IN ('industry', 'product', 'material', 'process', 'equipment', 'company', 'country', 'demand', 'metric', 'stock', 'technology', 'policy', 'hypothesis', 'shock')),
        name                 TEXT NOT NULL,
        stage                TEXT DEFAULT NULL,
        statement_kind       TEXT NOT NULL CHECK (statement_kind IN ('fact', 'estimate', 'hypothesis')),
        status               TEXT DEFAULT NULL,
        metrics_json         TEXT NOT NULL DEFAULT '[]',
        evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
        last_updated         TEXT DEFAULT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        UNIQUE(project_id, type, name)
      );
      CREATE INDEX idx_industry_research_nodes_project
        ON industry_research_nodes(project_id, type, name);

      CREATE TABLE industry_research_edges (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        source_node_id       TEXT NOT NULL REFERENCES industry_research_nodes(id) ON DELETE CASCADE,
        target_node_id       TEXT NOT NULL REFERENCES industry_research_nodes(id) ON DELETE CASCADE,
        relation             TEXT NOT NULL,
        statement_kind       TEXT NOT NULL CHECK (statement_kind IN ('fact', 'estimate', 'hypothesis')),
        strength             REAL DEFAULT NULL CHECK (strength IS NULL OR (strength >= 0 AND strength <= 1)),
        bottleneck           INTEGER NOT NULL DEFAULT 0 CHECK (bottleneck IN (0, 1)),
        exposure_pct         REAL DEFAULT NULL,
        evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
        last_updated         TEXT DEFAULT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        UNIQUE(project_id, source_node_id, target_node_id, relation)
      );
      CREATE INDEX idx_industry_research_edges_project
        ON industry_research_edges(project_id, source_node_id, target_node_id);

      CREATE TABLE industry_research_evidence (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        title                TEXT NOT NULL,
        source_type          TEXT NOT NULL,
        source_name          TEXT NOT NULL,
        source_url           TEXT DEFAULT NULL,
        source_ref           TEXT DEFAULT NULL,
        published_date       TEXT DEFAULT NULL,
        fact_date            TEXT DEFAULT NULL,
        collected_at         INTEGER NOT NULL,
        metric_name          TEXT DEFAULT NULL,
        metric_value         REAL DEFAULT NULL,
        unit                 TEXT DEFAULT NULL,
        region               TEXT DEFAULT NULL,
        product_spec         TEXT DEFAULT NULL,
        methodology          TEXT DEFAULT NULL,
        statement_kind       TEXT NOT NULL CHECK (statement_kind IN ('fact', 'estimate', 'hypothesis')),
        direction            TEXT NOT NULL CHECK (direction IN ('support', 'weaken', 'refute', 'neutral')),
        reliability          TEXT NOT NULL CHECK (reliability IN ('primary', 'secondary', 'tertiary', 'unknown')),
        created_by           TEXT NOT NULL CHECK (created_by IN ('human', 'ai', 'import')),
        primary_source_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (primary_source_confirmed IN (0, 1)),
        conflict_note        TEXT DEFAULT NULL,
        excerpt              TEXT DEFAULT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_evidence_project
        ON industry_research_evidence(project_id, statement_kind, direction, updated_at DESC);

      CREATE TABLE industry_research_hypotheses (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        statement            TEXT NOT NULL,
        importance           INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
        status               TEXT NOT NULL CHECK (status IN ('open', 'supported', 'weakened', 'refuted', 'reopened')),
        cheapest_disproof    TEXT NOT NULL,
        verification_metric  TEXT DEFAULT NULL,
        threshold            TEXT DEFAULT NULL,
        due_at               INTEGER DEFAULT NULL,
        evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_hypotheses_project
        ON industry_research_hypotheses(project_id, status, updated_at DESC);

      CREATE TABLE industry_research_hypothesis_events (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        hypothesis_id        TEXT NOT NULL REFERENCES industry_research_hypotheses(id) ON DELETE CASCADE,
        from_status          TEXT DEFAULT NULL,
        to_status            TEXT NOT NULL CHECK (to_status IN ('open', 'supported', 'weakened', 'refuted', 'reopened')),
        reason               TEXT NOT NULL,
        evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
        created_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_hypothesis_events_hypothesis
        ON industry_research_hypothesis_events(hypothesis_id, created_at DESC);
    `
  },
  {
    // FR-230: 公司、证券、业务暴露与财务事实层
    version: 100,
    sql: `
      CREATE TABLE industry_research_companies (
        id                   TEXT PRIMARY KEY,
        legal_name           TEXT NOT NULL,
        short_name           TEXT DEFAULT NULL,
        unified_credit_code  TEXT DEFAULT NULL UNIQUE,
        registration_region  TEXT DEFAULT NULL,
        source_type          TEXT NOT NULL CHECK (source_type IN ('manual', 'tushare')),
        source_ref           TEXT DEFAULT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_companies_name
        ON industry_research_companies(legal_name, short_name);

      CREATE TABLE industry_research_securities (
        id                   TEXT PRIMARY KEY,
        company_id           TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        ts_code              TEXT NOT NULL UNIQUE,
        symbol               TEXT DEFAULT NULL,
        exchange             TEXT NOT NULL,
        security_type        TEXT NOT NULL,
        list_status          TEXT DEFAULT NULL,
        list_date            TEXT DEFAULT NULL,
        delist_date          TEXT DEFAULT NULL,
        mapping_source       TEXT NOT NULL CHECK (mapping_source IN ('manual', 'tushare')),
        source_ref           TEXT DEFAULT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_securities_company
        ON industry_research_securities(company_id, ts_code);

      CREATE TABLE industry_research_disclosure_evidence (
        id                   TEXT PRIMARY KEY,
        company_id           TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        project_id           TEXT DEFAULT NULL REFERENCES industry_research_projects(id) ON DELETE SET NULL,
        title                TEXT NOT NULL,
        source_url           TEXT NOT NULL,
        published_date       TEXT DEFAULT NULL,
        actual_published_date TEXT DEFAULT NULL,
        excerpt              TEXT DEFAULT NULL,
        created_by           TEXT NOT NULL CHECK (created_by IN ('human', 'import')),
        primary_source_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (primary_source_confirmed IN (0, 1)),
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_disclosure_company
        ON industry_research_disclosure_evidence(company_id, actual_published_date, published_date);

      CREATE TABLE industry_research_main_business_items (
        id                   TEXT PRIMARY KEY,
        company_id           TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        source_api           TEXT NOT NULL,
        source_fact_key      TEXT NOT NULL,
        source_version       TEXT NOT NULL,
        report_period        TEXT NOT NULL,
        dimension            TEXT NOT NULL CHECK (dimension IN ('product', 'region', 'industry')),
        item_code            TEXT DEFAULT NULL,
        item_name            TEXT NOT NULL,
        revenue              REAL DEFAULT NULL,
        cost                 REAL DEFAULT NULL,
        profit               REAL DEFAULT NULL,
        currency             TEXT DEFAULT NULL,
        fetched_at           INTEGER NOT NULL,
        created_at           INTEGER NOT NULL,
        UNIQUE(source_api, source_fact_key, source_version)
      );
      CREATE INDEX idx_industry_research_main_business_company
        ON industry_research_main_business_items(company_id, report_period DESC, dimension);

      CREATE TABLE industry_research_business_exposures (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        company_id           TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        research_node_id     TEXT DEFAULT NULL REFERENCES industry_research_nodes(id) ON DELETE SET NULL,
        main_business_item_id TEXT DEFAULT NULL REFERENCES industry_research_main_business_items(id) ON DELETE SET NULL,
        evidence_id          TEXT DEFAULT NULL REFERENCES industry_research_disclosure_evidence(id) ON DELETE SET NULL,
        source_key           TEXT NOT NULL,
        source_type          TEXT NOT NULL CHECK (source_type IN ('manual', 'fina_mainbz')),
        status               TEXT NOT NULL CHECK (status IN ('confirmed', 'candidate', 'not_separable', 'excluded')),
        exposure_pct         REAL DEFAULT NULL,
        basis                TEXT NOT NULL,
        created_by           TEXT NOT NULL CHECK (created_by IN ('human', 'import')),
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        UNIQUE(project_id, source_type, source_key)
      );
      CREATE INDEX idx_industry_research_exposures_project
        ON industry_research_business_exposures(project_id, status, company_id);

      CREATE TABLE industry_research_financial_facts (
        id                   TEXT PRIMARY KEY,
        company_id           TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        security_id          TEXT DEFAULT NULL REFERENCES industry_research_securities(id) ON DELETE SET NULL,
        source_api           TEXT NOT NULL,
        source_fact_key      TEXT NOT NULL,
        source_version       TEXT NOT NULL,
        metric_name          TEXT NOT NULL,
        metric_value         REAL DEFAULT NULL,
        text_value           TEXT DEFAULT NULL,
        unit                 TEXT DEFAULT NULL,
        currency             TEXT DEFAULT NULL,
        ann_date             TEXT DEFAULT NULL,
        f_ann_date           TEXT DEFAULT NULL,
        report_period        TEXT NOT NULL,
        statement_type       TEXT DEFAULT NULL,
        company_type         TEXT DEFAULT NULL,
        update_flag          TEXT DEFAULT NULL,
        fact_kind            TEXT NOT NULL CHECK (fact_kind IN ('reported', 'derived')),
        derivation_formula   TEXT DEFAULT NULL,
        input_versions_json  TEXT NOT NULL DEFAULT '[]',
        derivation_status    TEXT NOT NULL CHECK (derivation_status IN ('not_applicable', 'derived', 'not_separable', 'blocked')),
        fetched_at           INTEGER NOT NULL,
        created_at           INTEGER NOT NULL,
        UNIQUE(source_api, source_fact_key, source_version, metric_name)
      );
      CREATE INDEX idx_industry_research_financial_company_period
        ON industry_research_financial_facts(company_id, report_period DESC, source_api);
      CREATE INDEX idx_industry_research_financial_disclosure
        ON industry_research_financial_facts(company_id, f_ann_date, ann_date);

      CREATE TABLE industry_research_financial_sync_state (
        company_id           TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE CASCADE,
        dataset              TEXT NOT NULL CHECK (dataset IN ('income', 'balancesheet', 'cashflow', 'fina_indicator', 'fina_audit', 'forecast', 'express', 'disclosure_date', 'fina_mainbz')),
        status               TEXT NOT NULL CHECK (status IN ('idle', 'running', 'success', 'failed')),
        last_attempt_at      INTEGER DEFAULT NULL,
        last_success_at      INTEGER DEFAULT NULL,
        last_error_code      TEXT DEFAULT NULL,
        last_success_fact_date TEXT DEFAULT NULL,
        last_success_row_count INTEGER DEFAULT NULL,
        updated_at           INTEGER NOT NULL,
        PRIMARY KEY(company_id, dataset)
      );
    `
  },
  {
    // FR-230: 项目公司状态、暴露补充字段与版本化利润桥
    version: 101,
    sql: `
      CREATE TABLE industry_research_project_companies (
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        company_id           TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        status               TEXT NOT NULL CHECK (status IN ('candidate', 'watching', 'core', 'excluded')),
        exclusion_reason     TEXT DEFAULT NULL,
        evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        PRIMARY KEY(project_id, company_id)
      );
      CREATE INDEX idx_industry_research_project_companies_status
        ON industry_research_project_companies(project_id, status, updated_at DESC);

      ALTER TABLE industry_research_business_exposures ADD COLUMN fact_date TEXT DEFAULT NULL;
      ALTER TABLE industry_research_business_exposures ADD COLUMN evidence_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE industry_research_business_exposures ADD COLUMN methodology TEXT DEFAULT NULL;

      CREATE TABLE industry_research_profit_bridges (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        company_id           TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        bridge_key           TEXT NOT NULL,
        base_period          TEXT NOT NULL,
        target_period        TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('estimate', 'hypothesis')),
        formula              TEXT DEFAULT NULL,
        input_fact_ids_json  TEXT NOT NULL DEFAULT '[]',
        evidence_ids_json    TEXT NOT NULL DEFAULT '[]',
        created_by           TEXT NOT NULL CHECK (created_by IN ('human', 'import')),
        version              INTEGER NOT NULL CHECK (version > 0),
        previous_version_id  TEXT DEFAULT NULL REFERENCES industry_research_profit_bridges(id) ON DELETE RESTRICT,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        UNIQUE(project_id, company_id, bridge_key, version)
      );
      CREATE INDEX idx_industry_research_profit_bridges_current
        ON industry_research_profit_bridges(project_id, company_id, bridge_key, version DESC);

      CREATE TABLE industry_research_profit_bridge_items (
        id                   TEXT PRIMARY KEY,
        profit_bridge_id     TEXT NOT NULL REFERENCES industry_research_profit_bridges(id) ON DELETE CASCADE,
        item_key             TEXT NOT NULL CHECK (item_key IN ('volume', 'price', 'product_mix', 'raw_material', 'depreciation_expense', 'other_business_drag', 'other')),
        label                TEXT NOT NULL,
        amount               REAL DEFAULT NULL,
        unit                 TEXT DEFAULT NULL,
        methodology          TEXT DEFAULT NULL,
        sort_order           INTEGER NOT NULL,
        UNIQUE(profit_bridge_id, item_key)
      );
      CREATE INDEX idx_industry_research_profit_bridge_items_bridge
        ON industry_research_profit_bridge_items(profit_bridge_id, sort_order, item_key);
    `
  },
  {
    // FR-230 第180D: 受控联网取证配置、候选证据与研究生成运行
    version: 102,
    sql: `
      CREATE TABLE IF NOT EXISTS research_web_search_config (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        provider_id          TEXT NOT NULL CHECK (provider_id IN ('tavily', 'bing', 'custom_openai_compatible_search')),
        enabled              INTEGER NOT NULL DEFAULT 0,
        api_key_encrypted    BLOB DEFAULT NULL,
        base_url             TEXT DEFAULT NULL,
        last_validated_at    INTEGER DEFAULT NULL,
        last_error_code      TEXT DEFAULT NULL,
        updated_at           INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_evidence_candidates (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT DEFAULT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        run_id               TEXT DEFAULT NULL,
        query                TEXT NOT NULL,
        source_url           TEXT NOT NULL,
        title                TEXT NOT NULL,
        summary              TEXT DEFAULT NULL,
        excerpt              TEXT DEFAULT NULL,
        provider_id          TEXT NOT NULL,
        published_at         TEXT DEFAULT NULL,
        fetched_at           INTEGER NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('fetched', 'partial', 'failed', 'confirmed', 'rejected')),
        failure_reason       TEXT DEFAULT NULL,
        confirmed_at         INTEGER DEFAULT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_research_evidence_candidates_project
        ON research_evidence_candidates(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_research_evidence_candidates_run
        ON research_evidence_candidates(run_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS industry_research_generation_runs (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        research_question    TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        current_stage        TEXT NOT NULL CHECK (current_stage IN ('retrieve', 'scope', 'map', 'evidence', 'hypothesis', 'companies', 'report')),
        last_successful_stage TEXT DEFAULT NULL CHECK (last_successful_stage IS NULL OR last_successful_stage IN ('retrieve', 'scope', 'map', 'evidence', 'hypothesis', 'companies', 'report')),
        progress_current     INTEGER NOT NULL DEFAULT 0,
        progress_total       INTEGER NOT NULL DEFAULT 7,
        progress_message     TEXT NOT NULL DEFAULT '',
        cancel_requested     INTEGER NOT NULL DEFAULT 0,
        skill_id             TEXT NOT NULL,
        skill_content_hash   TEXT NOT NULL,
        skill_rule_version   TEXT DEFAULT NULL,
        provider             TEXT DEFAULT NULL,
        model                TEXT DEFAULT NULL,
        error_code           TEXT DEFAULT NULL,
        error_message        TEXT DEFAULT NULL,
        retryable            INTEGER NOT NULL DEFAULT 0,
        stage_artifacts_json TEXT NOT NULL DEFAULT '{}',
        scope_json           TEXT DEFAULT NULL,
        enable_web_retrieval INTEGER NOT NULL DEFAULT 1,
        created_at           INTEGER NOT NULL,
        started_at           INTEGER DEFAULT NULL,
        completed_at         INTEGER DEFAULT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_industry_research_generation_runs_project
        ON industry_research_generation_runs(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_industry_research_generation_runs_active
        ON industry_research_generation_runs(project_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS industry_research_company_candidates (
        id                   TEXT PRIMARY KEY,
        run_id               TEXT NOT NULL REFERENCES industry_research_generation_runs(id) ON DELETE CASCADE,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        legal_name_candidate TEXT NOT NULL,
        display_name         TEXT NOT NULL,
        research_node_ids_json TEXT NOT NULL DEFAULT '[]',
        rationale            TEXT NOT NULL DEFAULT '',
        statement_kind       TEXT NOT NULL DEFAULT 'estimate' CHECK (statement_kind = 'estimate'),
        matched_securities_json TEXT NOT NULL DEFAULT '[]',
        resolution_status    TEXT NOT NULL CHECK (resolution_status IN ('pending', 'accepted', 'excluded', 'unmatched')),
        exclusion_reason     TEXT DEFAULT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_industry_research_company_candidates_project
        ON industry_research_company_candidates(project_id, resolution_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_industry_research_company_candidates_run
        ON industry_research_company_candidates(run_id, resolution_status, updated_at DESC);
    `
  },
  {
    // FR-230 第180E: 候选证据质量字段与来源类别
    version: 103,
    sql: `
      ALTER TABLE research_evidence_candidates ADD COLUMN source_kind TEXT DEFAULT 'web_search';
      ALTER TABLE research_evidence_candidates ADD COLUMN is_detail_page INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE research_evidence_candidates ADD COLUMN relevance_score REAL DEFAULT NULL;
      ALTER TABLE research_evidence_candidates ADD COLUMN authority_score REAL DEFAULT NULL;
      ALTER TABLE research_evidence_candidates ADD COLUMN freshness_score REAL DEFAULT NULL;
      ALTER TABLE research_evidence_candidates ADD COLUMN rank_score REAL DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_research_evidence_candidates_run_rank
        ON research_evidence_candidates(run_id, rank_score DESC, fetched_at DESC);
    `
  },
  {
    // FR-236: 复盘报告不可变快照与历史版本
    version: 104,
    sql: `
      CREATE TABLE IF NOT EXISTS decision_review_reports (
        id                  TEXT PRIMARY KEY,
        request_id          TEXT NOT NULL UNIQUE,
        kind                TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
        period_start        TEXT NOT NULL,
        period_end          TEXT NOT NULL,
        range_days          INTEGER NOT NULL CHECK (range_days > 0),
        generated_at        INTEGER NOT NULL,
        saved_at            INTEGER NOT NULL,
        schema_version      INTEGER NOT NULL CHECK (schema_version > 0),
        title               TEXT NOT NULL,
        headline            TEXT NOT NULL,
        open_risk_count     INTEGER NOT NULL CHECK (open_risk_count >= 0),
        evidence_gap_count  INTEGER NOT NULL CHECK (evidence_gap_count >= 0),
        follow_up_count     INTEGER NOT NULL CHECK (follow_up_count >= 0),
        version_number      INTEGER NOT NULL CHECK (version_number > 0),
        snapshot_json       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decision_review_reports_period
        ON decision_review_reports(kind, period_start, period_end, generated_at DESC, saved_at DESC);
      CREATE INDEX IF NOT EXISTS idx_decision_review_reports_recent
        ON decision_review_reports(generated_at DESC, saved_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_review_reports_version
        ON decision_review_reports(kind, period_start, period_end, version_number);
    `
  },
  {
    // FR-237: 决策判断不可变账本
    version: 105,
    sql: `
      CREATE TABLE IF NOT EXISTS decision_judgments (
        id                  TEXT PRIMARY KEY,
        request_id          TEXT NOT NULL UNIQUE,
        judgment_group_id   TEXT NOT NULL,
        version_number      INTEGER NOT NULL CHECK (version_number > 0),
        ts_code             TEXT NOT NULL,
        stock_name          TEXT DEFAULT NULL,
        tag                 TEXT NOT NULL CHECK (tag IN ('watch', 'risk_off', 'noise', 'insufficient', 'done')),
        note                TEXT NOT NULL DEFAULT '',
        source_signal_id    INTEGER DEFAULT NULL,
        related_signal_ids_json TEXT NOT NULL,
        evidence_snapshot_json  TEXT NOT NULL,
        review_due_at       INTEGER DEFAULT NULL,
        created_at          INTEGER NOT NULL,
        schema_version      INTEGER NOT NULL CHECK (schema_version > 0),
        UNIQUE (judgment_group_id, version_number)
      );
      CREATE INDEX IF NOT EXISTS idx_decision_judgments_recent
        ON decision_judgments(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_decision_judgments_stock
        ON decision_judgments(ts_code, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_decision_judgments_tag
        ON decision_judgments(tag, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_decision_judgments_group
        ON decision_judgments(judgment_group_id, version_number DESC);
    `
  },
  {
    // FR-238: T+N 判断回访完成事实
    version: 106,
    sql: `
      CREATE TABLE IF NOT EXISTS decision_judgment_follow_ups (
        id                  TEXT PRIMARY KEY,
        request_id          TEXT NOT NULL UNIQUE,
        source_judgment_id  TEXT NOT NULL UNIQUE,
        result_judgment_id  TEXT NOT NULL UNIQUE,
        action              TEXT NOT NULL CHECK (action IN ('maintain', 'revise', 'close')),
        note                TEXT NOT NULL DEFAULT '',
        completed_at        INTEGER NOT NULL,
        schema_version      INTEGER NOT NULL CHECK (schema_version > 0),
        FOREIGN KEY(source_judgment_id) REFERENCES decision_judgments(id),
        FOREIGN KEY(result_judgment_id) REFERENCES decision_judgments(id)
      );
      CREATE INDEX IF NOT EXISTS idx_decision_judgment_follow_ups_completed
        ON decision_judgment_follow_ups(completed_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_decision_judgments_review_due
        ON decision_judgments(review_due_at, created_at DESC);
    `
  },
  {
    // FR-239: 上下文 AI 讨论、语义变更包与不可变产业研究版本
    version: 107,
    sql: `
      CREATE TABLE ai_research_discussion_contexts (
        session_id                       INTEGER PRIMARY KEY REFERENCES ai_analysis_sessions(id) ON DELETE CASCADE,
        start_request_id                 TEXT NOT NULL UNIQUE,
        context_update_request_id        TEXT DEFAULT NULL UNIQUE,
        status                           TEXT NOT NULL CHECK (status IN ('active', 'changes_ready', 'partially_applied', 'applied', 'archived')),
        origin_type                      TEXT NOT NULL CHECK (origin_type IN ('daily_review', 'weekly_review', 'decision_signal', 'judgment', 'industry_research', 'briefing', 'manual')),
        origin_id                        TEXT DEFAULT NULL,
        origin_title                     TEXT NOT NULL,
        origin_occurred_at               INTEGER DEFAULT NULL,
        origin_available                 INTEGER NOT NULL DEFAULT 1 CHECK (origin_available IN (0, 1)),
        origin_content_hash              TEXT NOT NULL,
        context_snapshot_json            TEXT NOT NULL,
        context_keys_json                TEXT NOT NULL,
        included_context_keys_json       TEXT NOT NULL,
        return_target_json               TEXT NOT NULL,
        project_id                       TEXT DEFAULT NULL REFERENCES industry_research_projects(id) ON DELETE SET NULL,
        base_snapshot_id                 TEXT DEFAULT NULL,
        base_selection_reason            TEXT NOT NULL CHECK (base_selection_reason IN ('latest_compatible', 'empty_project', 'unassigned')),
        summarized_through_message_index INTEGER DEFAULT NULL,
        latest_batch_id                  TEXT DEFAULT NULL,
        degraded_reason                  TEXT DEFAULT NULL,
        created_at                       INTEGER NOT NULL,
        updated_at                       INTEGER NOT NULL
      );
      CREATE INDEX idx_ai_research_discussions_origin
        ON ai_research_discussion_contexts(origin_type, origin_id, status, updated_at DESC);
      CREATE INDEX idx_ai_research_discussions_project
        ON ai_research_discussion_contexts(project_id, status, updated_at DESC);

      CREATE TABLE industry_research_candidate_batches (
        id                   TEXT PRIMARY KEY,
        request_id           TEXT NOT NULL UNIQUE,
        idempotency_key      TEXT NOT NULL UNIQUE,
        source_type          TEXT NOT NULL CHECK (source_type IN ('discussion', 'archive')),
        source_session_id    INTEGER DEFAULT NULL REFERENCES ai_analysis_sessions(id) ON DELETE SET NULL,
        project_id           TEXT DEFAULT NULL REFERENCES industry_research_projects(id) ON DELETE SET NULL,
        base_snapshot_id     TEXT DEFAULT NULL,
        message_start_index  INTEGER DEFAULT NULL CHECK (message_start_index IS NULL OR message_start_index >= 0),
        message_end_index    INTEGER DEFAULT NULL CHECK (message_end_index IS NULL OR message_end_index >= 0),
        context_hash         TEXT NOT NULL,
        provider             TEXT DEFAULT NULL,
        model                TEXT DEFAULT NULL,
        rule_version         TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'partially_resolved', 'resolved', 'failed', 'cancelled')),
        change_set_count     INTEGER NOT NULL DEFAULT 0 CHECK (change_set_count >= 0),
        candidate_count      INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
        conflict_count       INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
        degraded_reasons_json TEXT NOT NULL DEFAULT '[]',
        archive_meta_json    TEXT DEFAULT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_batches_session
        ON industry_research_candidate_batches(source_session_id, created_at DESC);
      CREATE INDEX idx_industry_research_batches_project
        ON industry_research_candidate_batches(project_id, status, created_at DESC);

      CREATE TABLE industry_research_change_sets (
        id                       TEXT PRIMARY KEY,
        batch_id                 TEXT NOT NULL REFERENCES industry_research_candidate_batches(id) ON DELETE CASCADE,
        title                    TEXT NOT NULL,
        summary                  TEXT NOT NULL,
        impact                   TEXT NOT NULL,
        action                   TEXT NOT NULL CHECK (action IN ('add', 'revise', 'strengthen', 'weaken', 'refute', 'reopen', 'follow_up', 'no_change')),
        status                   TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'deferred', 'superseded', 'conflicted', 'invalid')),
        risk                     TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
        affected_objects_json    TEXT NOT NULL DEFAULT '[]',
        evidence_summary_json    TEXT NOT NULL DEFAULT '[]',
        confidence_boundary      TEXT NOT NULL,
        requires_expanded_review INTEGER NOT NULL DEFAULT 0 CHECK (requires_expanded_review IN (0, 1)),
        candidate_count          INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
        source_session_id        INTEGER DEFAULT NULL,
        message_start_index      INTEGER DEFAULT NULL,
        message_end_index        INTEGER DEFAULT NULL,
        user_edits_json          TEXT DEFAULT NULL,
        resolution_action        TEXT DEFAULT NULL CHECK (resolution_action IS NULL OR resolution_action IN ('accept', 'reject', 'defer')),
        resolution_reason        TEXT DEFAULT NULL,
        resolution_request_id    TEXT DEFAULT NULL,
        resolved_by              TEXT DEFAULT NULL,
        resolved_at              INTEGER DEFAULT NULL,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_change_sets_batch
        ON industry_research_change_sets(batch_id, status, created_at);
      CREATE INDEX idx_industry_research_change_sets_session
        ON industry_research_change_sets(source_session_id, status, created_at DESC);
      CREATE INDEX idx_industry_research_change_sets_resolution
        ON industry_research_change_sets(resolution_request_id);

      CREATE TABLE industry_research_change_candidates (
        id                   TEXT PRIMARY KEY,
        change_set_id        TEXT NOT NULL REFERENCES industry_research_change_sets(id) ON DELETE CASCADE,
        batch_id             TEXT NOT NULL REFERENCES industry_research_candidate_batches(id) ON DELETE CASCADE,
        project_id           TEXT DEFAULT NULL REFERENCES industry_research_projects(id) ON DELETE SET NULL,
        kind                 TEXT NOT NULL CHECK (kind IN ('project', 'node', 'edge', 'evidence', 'hypothesis', 'hypothesis_event', 'company', 'company_exposure', 'follow_up')),
        action               TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded', 'conflicted', 'invalid')),
        external_ref         TEXT DEFAULT NULL,
        source_locator       TEXT NOT NULL,
        message_start_index  INTEGER DEFAULT NULL,
        message_end_index    INTEGER DEFAULT NULL,
        target_entity_id     TEXT DEFAULT NULL,
        statement_type       TEXT NOT NULL CHECK (statement_type IN ('fact', 'estimate', 'hypothesis', 'candidate')),
        primary_source       INTEGER NOT NULL DEFAULT 0 CHECK (primary_source IN (0, 1)),
        payload_json         TEXT NOT NULL,
        conflicts_json       TEXT NOT NULL DEFAULT '[]',
        warnings_json        TEXT NOT NULL DEFAULT '[]',
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_candidates_change_set
        ON industry_research_change_candidates(change_set_id, status, kind, created_at);
      CREATE INDEX idx_industry_research_candidates_batch
        ON industry_research_change_candidates(batch_id, status, created_at);

      CREATE TABLE industry_research_external_refs (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE CASCADE,
        source_scope         TEXT NOT NULL,
        external_id          TEXT NOT NULL,
        entity_kind          TEXT NOT NULL,
        entity_id            TEXT NOT NULL,
        source_batch_id      TEXT NOT NULL REFERENCES industry_research_candidate_batches(id) ON DELETE RESTRICT,
        created_at           INTEGER NOT NULL,
        UNIQUE(project_id, source_scope, external_id)
      );
      CREATE INDEX idx_industry_research_external_refs_entity
        ON industry_research_external_refs(project_id, entity_kind, entity_id);

      CREATE TABLE industry_research_snapshots (
        id                       TEXT PRIMARY KEY,
        project_id               TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        previous_snapshot_id     TEXT DEFAULT NULL REFERENCES industry_research_snapshots(id) ON DELETE RESTRICT,
        trigger_batch_id         TEXT NOT NULL REFERENCES industry_research_candidate_batches(id) ON DELETE RESTRICT,
        source_session_id        INTEGER DEFAULT NULL,
        source_origin_type       TEXT NOT NULL,
        source_origin_id         TEXT DEFAULT NULL,
        source_return_target_json TEXT DEFAULT NULL,
        schema_version           INTEGER NOT NULL CHECK (schema_version > 0),
        graph_updated_at         INTEGER NOT NULL,
        title                    TEXT NOT NULL,
        accepted_change_set_count INTEGER NOT NULL CHECK (accepted_change_set_count > 0),
        snapshot_json            TEXT NOT NULL,
        created_at               INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_snapshots_project
        ON industry_research_snapshots(project_id, created_at DESC, id DESC);
      CREATE TRIGGER industry_research_snapshots_no_update
        BEFORE UPDATE ON industry_research_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_SNAPSHOT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_snapshots_no_delete
        BEFORE DELETE ON industry_research_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_SNAPSHOT_IMMUTABLE'); END;
    `
  },
  {
    // FR-230 第181B: Skill采用、研究决策、监控触发与共享研究版本
    version: 108,
    sql: `
      PRAGMA defer_foreign_keys = ON;

      CREATE TABLE industry_research_skill_snapshots (
        id               TEXT PRIMARY KEY,
        skill_id         TEXT NOT NULL,
        content_hash     TEXT NOT NULL,
        rule_version     TEXT NOT NULL,
        content          TEXT NOT NULL,
        source_type      TEXT NOT NULL CHECK (source_type IN ('builtin', 'custom')),
        source_locator   TEXT NOT NULL,
        content_bytes    INTEGER NOT NULL CHECK (content_bytes > 0 AND content_bytes <= 1048576),
        captured_at      INTEGER NOT NULL,
        UNIQUE(skill_id, content_hash)
      );
      CREATE INDEX idx_industry_research_skill_snapshots_hash
        ON industry_research_skill_snapshots(content_hash, captured_at DESC);
      CREATE TRIGGER industry_research_skill_snapshots_no_update
        BEFORE UPDATE ON industry_research_skill_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_SKILL_SNAPSHOT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_skill_snapshots_no_delete
        BEFORE DELETE ON industry_research_skill_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_SKILL_SNAPSHOT_IMMUTABLE'); END;

      DROP TRIGGER industry_research_snapshots_no_update;
      DROP TRIGGER industry_research_snapshots_no_delete;
      ALTER TABLE industry_research_snapshots RENAME TO industry_research_snapshots_v107;
      CREATE TABLE industry_research_snapshots (
        id                        TEXT PRIMARY KEY,
        project_id                TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        previous_snapshot_id      TEXT DEFAULT NULL REFERENCES industry_research_snapshots(id) ON DELETE RESTRICT,
        snapshot_reason           TEXT NOT NULL CHECK (snapshot_reason IN ('discussion_merge', 'archive_import', 'project_baseline', 'skill_adoption', 'decision_basis')),
        request_id                TEXT DEFAULT NULL UNIQUE,
        trigger_batch_id          TEXT DEFAULT NULL REFERENCES industry_research_candidate_batches(id) ON DELETE RESTRICT,
        skill_snapshot_id         TEXT DEFAULT NULL REFERENCES industry_research_skill_snapshots(id) ON DELETE RESTRICT,
        source_session_id         INTEGER DEFAULT NULL,
        source_origin_type        TEXT NOT NULL,
        source_origin_id          TEXT DEFAULT NULL,
        source_return_target_json TEXT DEFAULT NULL,
        schema_version            INTEGER NOT NULL CHECK (schema_version > 0),
        graph_updated_at          INTEGER NOT NULL,
        title                     TEXT NOT NULL,
        accepted_change_set_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_change_set_count >= 0),
        snapshot_json             TEXT NOT NULL,
        created_at                INTEGER NOT NULL
      );
      INSERT INTO industry_research_snapshots (
        id, project_id, previous_snapshot_id, snapshot_reason, request_id,
        trigger_batch_id, skill_snapshot_id, source_session_id, source_origin_type,
        source_origin_id, source_return_target_json, schema_version, graph_updated_at,
        title, accepted_change_set_count, snapshot_json, created_at
      )
      SELECT
        id, project_id, previous_snapshot_id,
        CASE WHEN source_origin_type = 'archive' THEN 'archive_import' ELSE 'discussion_merge' END,
        NULL, trigger_batch_id, NULL, source_session_id, source_origin_type,
        source_origin_id, source_return_target_json, schema_version, graph_updated_at,
        title, accepted_change_set_count, snapshot_json, created_at
      FROM industry_research_snapshots_v107;
      DROP TABLE industry_research_snapshots_v107;
      CREATE INDEX idx_industry_research_snapshots_project
        ON industry_research_snapshots(project_id, created_at DESC, id DESC);
      CREATE INDEX idx_industry_research_snapshots_reason
        ON industry_research_snapshots(project_id, snapshot_reason, created_at DESC);
      CREATE INDEX idx_industry_research_snapshots_batch
        ON industry_research_snapshots(trigger_batch_id);
      CREATE TRIGGER industry_research_snapshots_no_update
        BEFORE UPDATE ON industry_research_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_SNAPSHOT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_snapshots_no_delete
        BEFORE DELETE ON industry_research_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_SNAPSHOT_IMMUTABLE'); END;

      CREATE TABLE industry_research_skill_adoption_events (
        id                    TEXT PRIMARY KEY,
        request_id            TEXT NOT NULL UNIQUE,
        project_id            TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        event_type            TEXT NOT NULL CHECK (event_type IN ('initial', 'adopted', 'legacy_verified')),
        previous_snapshot_id  TEXT DEFAULT NULL REFERENCES industry_research_skill_snapshots(id) ON DELETE RESTRICT,
        target_snapshot_id    TEXT NOT NULL REFERENCES industry_research_skill_snapshots(id) ON DELETE RESTRICT,
        research_snapshot_id  TEXT DEFAULT NULL REFERENCES industry_research_snapshots(id) ON DELETE RESTRICT,
        migration_note        TEXT NOT NULL,
        diff_schema_version   INTEGER NOT NULL DEFAULT 1 CHECK (diff_schema_version = 1),
        diff_json             TEXT NOT NULL,
        review_summary_json   TEXT NOT NULL DEFAULT '[]',
        adopted_at            INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_skill_adoptions_project
        ON industry_research_skill_adoption_events(project_id, adopted_at DESC, id DESC);

      CREATE TABLE industry_research_work_item_versions (
        id                       TEXT PRIMARY KEY,
        work_item_id             TEXT NOT NULL,
        project_id               TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        version                  INTEGER NOT NULL CHECK (version > 0),
        previous_version_id      TEXT DEFAULT NULL REFERENCES industry_research_work_item_versions(id) ON DELETE RESTRICT,
        request_id               TEXT NOT NULL UNIQUE,
        question                 TEXT NOT NULL,
        effort                   TEXT NOT NULL CHECK (effort IN ('quick_pass', 'standard_validation', 'deep_research')),
        conclusion_sensitivity   TEXT NOT NULL CHECK (conclusion_sensitivity IN ('low', 'medium', 'high')),
        evidence_uncertainty     TEXT NOT NULL CHECK (evidence_uncertainty IN ('low', 'medium', 'high')),
        change_velocity          TEXT NOT NULL CHECK (change_velocity IN ('low', 'medium', 'high')),
        stop_reason              TEXT DEFAULT NULL,
        next_trigger_metric      TEXT DEFAULT NULL,
        affected_objects_json    TEXT NOT NULL DEFAULT '[]',
        status                   TEXT NOT NULL CHECK (status IN ('open', 'blocked', 'completed', 'stopped')),
        created_at               INTEGER NOT NULL,
        UNIQUE(work_item_id, version)
      );
      CREATE INDEX idx_industry_research_work_items_project
        ON industry_research_work_item_versions(project_id, work_item_id, version DESC);

      CREATE TABLE industry_research_scenario_set_versions (
        id                    TEXT PRIMARY KEY,
        scenario_set_id       TEXT NOT NULL,
        project_id            TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        company_id            TEXT DEFAULT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        version               INTEGER NOT NULL CHECK (version > 0),
        previous_version_id   TEXT DEFAULT NULL REFERENCES industry_research_scenario_set_versions(id) ON DELETE RESTRICT,
        request_id            TEXT NOT NULL UNIQUE,
        data_as_of            TEXT NOT NULL,
        valuation_date        TEXT DEFAULT NULL,
        created_at            INTEGER NOT NULL,
        UNIQUE(scenario_set_id, version)
      );
      CREATE INDEX idx_industry_research_scenario_sets_project
        ON industry_research_scenario_set_versions(project_id, company_id, scenario_set_id, version DESC);
      CREATE TABLE industry_research_scenarios (
        id                       TEXT PRIMARY KEY,
        scenario_set_version_id  TEXT NOT NULL REFERENCES industry_research_scenario_set_versions(id) ON DELETE RESTRICT,
        name                     TEXT NOT NULL CHECK (name IN ('bear', 'base', 'bull')),
        weight_pct               REAL DEFAULT NULL CHECK (weight_pct IS NULL OR (weight_pct >= 0 AND weight_pct <= 100)),
        assumptions_json         TEXT NOT NULL DEFAULT '{}',
        fact_ids_json            TEXT NOT NULL DEFAULT '[]',
        UNIQUE(scenario_set_version_id, name)
      );

      CREATE TABLE industry_research_decisions (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        company_id  TEXT DEFAULT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_decisions_project
        ON industry_research_decisions(project_id, company_id, created_at DESC);

      CREATE TABLE industry_research_monitoring_item_versions (
        id                    TEXT PRIMARY KEY,
        monitoring_item_id    TEXT NOT NULL,
        project_id            TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        version               INTEGER NOT NULL CHECK (version > 0),
        previous_version_id   TEXT DEFAULT NULL REFERENCES industry_research_monitoring_item_versions(id) ON DELETE RESTRICT,
        request_id            TEXT NOT NULL UNIQUE,
        name                  TEXT NOT NULL,
        value_kind            TEXT NOT NULL CHECK (value_kind IN ('number', 'text', 'event')),
        frequency             TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'event_driven')),
        source_name           TEXT NOT NULL,
        source_ref            TEXT DEFAULT NULL,
        unit                  TEXT DEFAULT NULL,
        timing_type           TEXT NOT NULL CHECK (timing_type IN ('leading', 'coincident', 'lagging', 'unknown')),
        stale_after_ms        INTEGER NOT NULL CHECK (stale_after_ms > 0),
        next_review_at        INTEGER DEFAULT NULL,
        hypothesis_ids_json   TEXT NOT NULL DEFAULT '[]',
        scenario_set_ids_json TEXT NOT NULL DEFAULT '[]',
        decision_ids_json     TEXT NOT NULL DEFAULT '[]',
        status                TEXT NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
        created_at            INTEGER NOT NULL,
        UNIQUE(monitoring_item_id, version)
      );
      CREATE INDEX idx_industry_research_monitoring_items_project
        ON industry_research_monitoring_item_versions(project_id, monitoring_item_id, version DESC);

      CREATE TABLE industry_research_monitoring_observations (
        id                         TEXT PRIMARY KEY,
        request_id                 TEXT NOT NULL UNIQUE,
        project_id                 TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        monitoring_item_id         TEXT NOT NULL,
        monitoring_item_version_id TEXT NOT NULL REFERENCES industry_research_monitoring_item_versions(id) ON DELETE RESTRICT,
        value_number               REAL DEFAULT NULL,
        value_text                 TEXT DEFAULT NULL,
        unit                       TEXT DEFAULT NULL,
        source_ref                 TEXT DEFAULT NULL,
        observed_at                INTEGER NOT NULL,
        available_at               INTEGER NOT NULL,
        data_as_of                 TEXT NOT NULL,
        methodology_version        TEXT NOT NULL,
        created_at                 INTEGER NOT NULL,
        CHECK ((value_number IS NOT NULL AND value_text IS NULL) OR (value_number IS NULL AND value_text IS NOT NULL))
      );
      CREATE INDEX idx_industry_research_monitoring_observations_item
        ON industry_research_monitoring_observations(project_id, monitoring_item_id, observed_at DESC, id DESC);

      CREATE TABLE industry_research_decision_trigger_versions (
        id                         TEXT PRIMARY KEY,
        trigger_id                 TEXT NOT NULL,
        project_id                 TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        decision_id                TEXT NOT NULL REFERENCES industry_research_decisions(id) ON DELETE RESTRICT,
        monitoring_item_id         TEXT NOT NULL,
        monitoring_item_version_id TEXT NOT NULL REFERENCES industry_research_monitoring_item_versions(id) ON DELETE RESTRICT,
        version                    INTEGER NOT NULL CHECK (version > 0),
        previous_version_id        TEXT DEFAULT NULL REFERENCES industry_research_decision_trigger_versions(id) ON DELETE RESTRICT,
        request_id                 TEXT NOT NULL UNIQUE,
        metric_name                TEXT NOT NULL,
        operator                   TEXT NOT NULL CHECK (operator IN ('gt', 'gte', 'lt', 'lte', 'eq', 'changed')),
        threshold_number           REAL DEFAULT NULL,
        threshold_text             TEXT DEFAULT NULL,
        validation_window_ms       INTEGER NOT NULL CHECK (validation_window_ms > 0),
        action_if_not_triggered    TEXT NOT NULL CHECK (action_if_not_triggered IN ('continue_research', 'wait_financial_validation', 'wait_price', 'monitor', 'exclude')),
        proposed_action_if_triggered TEXT NOT NULL CHECK (proposed_action_if_triggered IN ('continue_research', 'wait_financial_validation', 'wait_price', 'monitor', 'exclude')),
        expires_at                 INTEGER DEFAULT NULL,
        status                     TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        created_at                 INTEGER NOT NULL,
        CHECK ((operator = 'changed' AND threshold_number IS NULL AND threshold_text IS NULL) OR
               (operator != 'changed' AND ((threshold_number IS NOT NULL AND threshold_text IS NULL) OR (threshold_number IS NULL AND threshold_text IS NOT NULL)))),
        UNIQUE(trigger_id, version)
      );
      CREATE INDEX idx_industry_research_trigger_versions_project
        ON industry_research_decision_trigger_versions(project_id, trigger_id, version DESC);

      CREATE TABLE industry_research_decision_trigger_evaluations (
        id                 TEXT PRIMARY KEY,
        request_id         TEXT NOT NULL UNIQUE,
        project_id         TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        trigger_id         TEXT NOT NULL,
        trigger_version_id TEXT NOT NULL REFERENCES industry_research_decision_trigger_versions(id) ON DELETE RESTRICT,
        observation_id     TEXT DEFAULT NULL REFERENCES industry_research_monitoring_observations(id) ON DELETE RESTRICT,
        result             TEXT NOT NULL CHECK (result IN ('not_triggered', 'pending_review', 'blocked', 'expired')),
        result_reason      TEXT NOT NULL,
        evaluated_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_trigger_evaluations_project
        ON industry_research_decision_trigger_evaluations(project_id, trigger_id, evaluated_at DESC);

      CREATE TABLE industry_research_decision_events (
        id                           TEXT PRIMARY KEY,
        request_id                   TEXT NOT NULL UNIQUE,
        decision_id                  TEXT NOT NULL REFERENCES industry_research_decisions(id) ON DELETE RESTRICT,
        project_id                   TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        previous_event_id            TEXT DEFAULT NULL REFERENCES industry_research_decision_events(id) ON DELETE RESTRICT,
        event_type                   TEXT NOT NULL CHECK (event_type IN ('created', 'maintained', 'upgraded', 'downgraded', 'invalidated', 'closed')),
        action                       TEXT NOT NULL CHECK (action IN ('continue_research', 'wait_financial_validation', 'wait_price', 'monitor', 'exclude')),
        rationale                    TEXT NOT NULL,
        data_as_of                   TEXT NOT NULL,
        valuation_date               TEXT DEFAULT NULL,
        valid_until                  INTEGER NOT NULL,
        invalidation_condition       TEXT NOT NULL,
        skill_snapshot_id            TEXT NOT NULL REFERENCES industry_research_skill_snapshots(id) ON DELETE RESTRICT,
        research_snapshot_id         TEXT NOT NULL REFERENCES industry_research_snapshots(id) ON DELETE RESTRICT,
        scenario_set_version_id      TEXT DEFAULT NULL REFERENCES industry_research_scenario_set_versions(id) ON DELETE RESTRICT,
        work_item_ids_json           TEXT NOT NULL DEFAULT '[]',
        fact_ids_json                TEXT NOT NULL DEFAULT '[]',
        evidence_ids_json            TEXT NOT NULL DEFAULT '[]',
        hypothesis_ids_json          TEXT NOT NULL DEFAULT '[]',
        source_trigger_evaluation_id TEXT DEFAULT NULL REFERENCES industry_research_decision_trigger_evaluations(id) ON DELETE RESTRICT,
        created_at                   INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_decision_events_decision
        ON industry_research_decision_events(project_id, decision_id, created_at DESC, id DESC);

      CREATE TABLE industry_research_review_events (
        id                TEXT PRIMARY KEY,
        request_id        TEXT NOT NULL UNIQUE,
        review_group_id   TEXT NOT NULL,
        project_id        TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        previous_event_id TEXT DEFAULT NULL REFERENCES industry_research_review_events(id) ON DELETE RESTRICT,
        kind              TEXT NOT NULL CHECK (kind IN ('skill_adoption', 'trigger', 'project_boundary', 'hypothesis_due', 'financial_validation', 'monitoring_stale', 'decision_expiry', 'work_item')),
        subject_kind      TEXT NOT NULL,
        subject_id        TEXT NOT NULL,
        source_event_id   TEXT DEFAULT NULL,
        state             TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'dismissed')),
        reason            TEXT NOT NULL,
        payload_json      TEXT NOT NULL DEFAULT '{}',
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_review_events_project
        ON industry_research_review_events(project_id, review_group_id, created_at DESC, id DESC);

      CREATE TRIGGER industry_research_skill_adoptions_no_update BEFORE UPDATE ON industry_research_skill_adoption_events BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_skill_adoptions_no_delete BEFORE DELETE ON industry_research_skill_adoption_events BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_work_items_no_update BEFORE UPDATE ON industry_research_work_item_versions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_work_items_no_delete BEFORE DELETE ON industry_research_work_item_versions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_scenario_sets_no_update BEFORE UPDATE ON industry_research_scenario_set_versions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_scenario_sets_no_delete BEFORE DELETE ON industry_research_scenario_set_versions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_scenarios_no_update BEFORE UPDATE ON industry_research_scenarios BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_scenarios_no_delete BEFORE DELETE ON industry_research_scenarios BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_decisions_no_update BEFORE UPDATE ON industry_research_decisions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_decisions_no_delete BEFORE DELETE ON industry_research_decisions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_monitoring_items_no_update BEFORE UPDATE ON industry_research_monitoring_item_versions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_monitoring_items_no_delete BEFORE DELETE ON industry_research_monitoring_item_versions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_monitoring_observations_no_update BEFORE UPDATE ON industry_research_monitoring_observations BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_monitoring_observations_no_delete BEFORE DELETE ON industry_research_monitoring_observations BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_trigger_versions_no_update BEFORE UPDATE ON industry_research_decision_trigger_versions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_trigger_versions_no_delete BEFORE DELETE ON industry_research_decision_trigger_versions BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_trigger_evaluations_no_update BEFORE UPDATE ON industry_research_decision_trigger_evaluations BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_trigger_evaluations_no_delete BEFORE DELETE ON industry_research_decision_trigger_evaluations BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_decision_events_no_update BEFORE UPDATE ON industry_research_decision_events BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_decision_events_no_delete BEFORE DELETE ON industry_research_decision_events BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_review_events_no_update BEFORE UPDATE ON industry_research_review_events BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_review_events_no_delete BEFORE DELETE ON industry_research_review_events BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
    `
  },
  {
    // FR-230 第181C: 市场基准、前复权、估值与不可变决策上下文
    version: 109,
    sql: `
      CREATE TABLE security_adjustment_factor_cache (
        ts_code     TEXT NOT NULL,
        trade_date  TEXT NOT NULL,
        adj_factor  REAL NOT NULL CHECK (adj_factor > 0),
        source      TEXT NOT NULL,
        fetched_at  INTEGER NOT NULL,
        PRIMARY KEY(ts_code, trade_date)
      );
      CREATE INDEX idx_security_adjustment_factor_date
        ON security_adjustment_factor_cache(trade_date DESC, ts_code);

      CREATE TABLE security_valuation_daily_cache (
        ts_code      TEXT NOT NULL,
        trade_date   TEXT NOT NULL,
        total_share  REAL DEFAULT NULL,
        float_share  REAL DEFAULT NULL,
        total_mv     REAL DEFAULT NULL,
        circ_mv      REAL DEFAULT NULL,
        pe_ttm       REAL DEFAULT NULL,
        pb           REAL DEFAULT NULL,
        ps_ttm       REAL DEFAULT NULL,
        dv_ttm       REAL DEFAULT NULL,
        source       TEXT NOT NULL,
        fetched_at   INTEGER NOT NULL,
        PRIMARY KEY(ts_code, trade_date)
      );
      CREATE INDEX idx_security_valuation_daily_date
        ON security_valuation_daily_cache(trade_date DESC, ts_code);

      CREATE TABLE industry_research_market_sync_runs (
        id               TEXT PRIMARY KEY,
        request_id       TEXT NOT NULL UNIQUE,
        project_id       TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        company_id       TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        security_id      TEXT NOT NULL REFERENCES industry_research_securities(id) ON DELETE RESTRICT,
        ts_code          TEXT NOT NULL,
        benchmark_code   TEXT DEFAULT NULL,
        status           TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
        result_json      TEXT NOT NULL DEFAULT '{}',
        data_start       TEXT DEFAULT NULL,
        data_end         TEXT DEFAULT NULL,
        fact_fingerprint TEXT DEFAULT NULL,
        error_code       TEXT DEFAULT NULL,
        started_at       INTEGER NOT NULL,
        completed_at     INTEGER DEFAULT NULL
      );
      CREATE INDEX idx_industry_research_market_sync_runs_scope
        ON industry_research_market_sync_runs(project_id, security_id, started_at DESC, id DESC);

      CREATE TABLE industry_research_market_snapshots (
        id                       TEXT PRIMARY KEY,
        request_id               TEXT NOT NULL UNIQUE,
        project_id               TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        company_id               TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        security_id              TEXT NOT NULL REFERENCES industry_research_securities(id) ON DELETE RESTRICT,
        ts_code                  TEXT NOT NULL,
        requested_valuation_date TEXT NOT NULL,
        market_date              TEXT DEFAULT NULL,
        benchmark_code           TEXT DEFAULT NULL,
        benchmark_name           TEXT DEFAULT NULL,
        raw_close                REAL DEFAULT NULL,
        status                   TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'blocked')),
        reason_json              TEXT NOT NULL DEFAULT '[]',
        market_data_json         TEXT NOT NULL,
        fact_fingerprint         TEXT NOT NULL,
        methodology_version      TEXT NOT NULL,
        created_at               INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_market_snapshots_scope
        ON industry_research_market_snapshots(project_id, company_id, security_id, created_at DESC, id DESC);

      ALTER TABLE industry_research_scenario_set_versions
        ADD COLUMN valuation_method TEXT DEFAULT NULL CHECK (valuation_method IS NULL OR valuation_method IN ('pe', 'pb_roe', 'ev_ebitda', 'dcf', 'sotp', 'nav'));
      ALTER TABLE industry_research_scenario_set_versions
        ADD COLUMN methodology_version TEXT DEFAULT NULL;
      ALTER TABLE industry_research_scenarios
        ADD COLUMN valuation_inputs_json TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE industry_research_valuation_snapshots (
        id                      TEXT PRIMARY KEY,
        request_id              TEXT NOT NULL UNIQUE,
        project_id              TEXT NOT NULL REFERENCES industry_research_projects(id) ON DELETE RESTRICT,
        company_id              TEXT NOT NULL REFERENCES industry_research_companies(id) ON DELETE RESTRICT,
        scenario_set_version_id TEXT NOT NULL REFERENCES industry_research_scenario_set_versions(id) ON DELETE RESTRICT,
        market_snapshot_id      TEXT NOT NULL REFERENCES industry_research_market_snapshots(id) ON DELETE RESTRICT,
        valuation_method        TEXT NOT NULL CHECK (valuation_method IN ('pe', 'pb_roe', 'ev_ebitda', 'dcf', 'sotp', 'nav')),
        status                  TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'blocked')),
        input_json              TEXT NOT NULL,
        output_json             TEXT NOT NULL,
        fact_ids_json           TEXT NOT NULL DEFAULT '[]',
        formula_version         TEXT NOT NULL,
        created_at              INTEGER NOT NULL
      );
      CREATE INDEX idx_industry_research_valuation_snapshots_scope
        ON industry_research_valuation_snapshots(project_id, company_id, created_at DESC, id DESC);

      ALTER TABLE industry_research_decision_events
        ADD COLUMN market_snapshot_id TEXT DEFAULT NULL REFERENCES industry_research_market_snapshots(id) ON DELETE RESTRICT;
      ALTER TABLE industry_research_decision_events
        ADD COLUMN valuation_snapshot_id TEXT DEFAULT NULL REFERENCES industry_research_valuation_snapshots(id) ON DELETE RESTRICT;

      CREATE TRIGGER industry_research_market_sync_runs_no_update
        BEFORE UPDATE ON industry_research_market_sync_runs
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_market_sync_runs_no_delete
        BEFORE DELETE ON industry_research_market_sync_runs
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_market_snapshots_no_update
        BEFORE UPDATE ON industry_research_market_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_market_snapshots_no_delete
        BEFORE DELETE ON industry_research_market_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_valuation_snapshots_no_update
        BEFORE UPDATE ON industry_research_valuation_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
      CREATE TRIGGER industry_research_valuation_snapshots_no_delete
        BEFORE DELETE ON industry_research_valuation_snapshots
        BEGIN SELECT RAISE(ABORT, 'INDUSTRY_RESEARCH_FACT_IMMUTABLE'); END;
    `
  },
  {
    // FR-240: 仅升级未修改的旧系统默认文章分析提示词
    version: 110,
    sql: `
      UPDATE ai_config
      SET presetPrompt = '${DEFAULT_ARTICLE_ANALYSIS_PROMPT.replace(/'/g, "''")}'
      WHERE presetPrompt = '${LEGACY_DEFAULT_ARTICLE_ANALYSIS_PROMPT.replace(/'/g, "''")}';

      UPDATE provider_configs
      SET presetPrompt = '${DEFAULT_ARTICLE_ANALYSIS_PROMPT.replace(/'/g, "''")}'
      WHERE presetPrompt = '${LEGACY_DEFAULT_ARTICLE_ANALYSIS_PROMPT.replace(/'/g, "''")}';
    `
  },
  {
    // FR-241: 今日看板筛选不再依赖按 renderer origin 隔离的 localStorage
    version: 111,
    sql: `
      ALTER TABLE app_settings ADD COLUMN decision_center_filters_json TEXT DEFAULT NULL;
    `
  },
  {
    // FR-243: 保存来源可核验的板块资金事实，旧成交方向估算不再冒充资金流
    version: 112,
    sql: `
      CREATE TABLE sector_flow_observations (
        trade_date                 TEXT NOT NULL,
        provider                   TEXT NOT NULL CHECK (provider IN ('eastmoney','local_estimate')),
        scope                      TEXT NOT NULL CHECK (scope IN ('concept','industry')),
        board_code                 TEXT NOT NULL,
        board_name                 TEXT NOT NULL,
        metric_kind                TEXT NOT NULL CHECK (metric_kind IN ('verified_flow','turnover_strength')),
        total_amount               REAL NOT NULL,
        turnover_direction_strength REAL,
        main_net_inflow            REAL,
        main_net_inflow_rate       REAL,
        super_large_net_inflow     REAL,
        super_large_net_inflow_rate REAL,
        large_net_inflow           REAL,
        large_net_inflow_rate      REAL,
        medium_net_inflow          REAL,
        medium_net_inflow_rate     REAL,
        small_net_inflow           REAL,
        small_net_inflow_rate      REAL,
        weighted_change            REAL NOT NULL,
        total_market_cap           REAL,
        member_count               INTEGER NOT NULL DEFAULT 0,
        up_count                   INTEGER NOT NULL DEFAULT 0,
        down_count                 INTEGER NOT NULL DEFAULT 0,
        flat_count                 INTEGER NOT NULL DEFAULT 0,
        leader_json                TEXT,
        core_stocks_json           TEXT NOT NULL DEFAULT '[]',
        related_themes_json        TEXT NOT NULL DEFAULT '[]',
        source_updated_at          INTEGER,
        captured_at                INTEGER NOT NULL,
        quality_json               TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (trade_date, provider, scope, board_code, metric_kind)
      );
      CREATE INDEX idx_sector_flow_observations_date
        ON sector_flow_observations(metric_kind, provider, trade_date DESC);
      CREATE INDEX idx_sector_flow_observations_board
        ON sector_flow_observations(scope, board_code, trade_date DESC);

      UPDATE decision_signals
      SET status = 'EXPIRED',
          updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE strategy_key = 'sectorFlow.netInflowTop'
        AND status IN ('NEW','READ','WATCHING');
    `
  },
  {
    // FR-246: 只保存用户显式执行的关键数据质量快照
    version: 113,
    sql: `
      CREATE TABLE data_quality_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        checked_at    INTEGER NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('reliable','degraded','blocked')),
        fingerprint   TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_data_quality_runs_checked
        ON data_quality_runs(checked_at DESC, id DESC);
    `
  },
  {
    // FR-248: AI研判评测运行与逐样本规则结果
    version: 114,
    sql: `
      CREATE TABLE ai_evaluation_runs (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        suite_id                    TEXT NOT NULL,
        suite_version               TEXT NOT NULL,
        suite_fingerprint           TEXT NOT NULL,
        provider                    TEXT NOT NULL,
        model                       TEXT NOT NULL,
        business_prompt_fingerprint TEXT NOT NULL,
        evaluation_prompt_fingerprint TEXT NOT NULL,
        status                      TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
        progress_current            INTEGER NOT NULL DEFAULT 0,
        progress_total              INTEGER NOT NULL,
        current_case_id             TEXT,
        total_score                 REAL,
        conclusion                  TEXT CHECK (conclusion IS NULL OR conclusion IN ('passed','warning','failed')),
        dimension_scores_json       TEXT,
        input_tokens                INTEGER,
        output_tokens               INTEGER,
        total_tokens                INTEGER,
        error_message               TEXT,
        started_at                  INTEGER NOT NULL,
        completed_at                INTEGER,
        created_at                  INTEGER NOT NULL
      );
      CREATE INDEX idx_ai_evaluation_runs_recent
        ON ai_evaluation_runs(created_at DESC, id DESC);
      CREATE INDEX idx_ai_evaluation_runs_identity
        ON ai_evaluation_runs(suite_id, suite_version, provider, model, business_prompt_fingerprint, created_at DESC);

      CREATE TABLE ai_evaluation_case_results (
        run_id        INTEGER NOT NULL,
        case_id       TEXT NOT NULL,
        title         TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('round1','round2')),
        status        TEXT NOT NULL CHECK (status IN ('passed','warning','failed')),
        score         REAL NOT NULL,
        rules_json    TEXT NOT NULL,
        response_text TEXT NOT NULL,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        total_tokens  INTEGER,
        error_message TEXT,
        completed_at  INTEGER NOT NULL,
        PRIMARY KEY (run_id, case_id),
        FOREIGN KEY (run_id) REFERENCES ai_evaluation_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_ai_evaluation_case_results_run
        ON ai_evaluation_case_results(run_id, completed_at ASC);
    `
  },
  {
    // FR-165/198/203: 决策信号生命周期与重复补种噪声纠偏
    version: 115,
    sql: `
      DELETE FROM decision_signal_events
      WHERE event_type = 'UPDATED';

      UPDATE decision_signals
      SET occurrence_count = 1
      WHERE occurrence_count != 1;

      UPDATE decision_signals
      SET expire_at = signal_time + 7 * 24 * 60 * 60 * 1000
      WHERE source_module = 'trend'
        AND expire_at = signal_time + 24 * 60 * 60 * 1000;

      UPDATE decision_signals
      SET expire_at = signal_time + 3 * 24 * 60 * 60 * 1000
      WHERE source_module IN ('news', 'ai')
        AND expire_at = signal_time + 24 * 60 * 60 * 1000;

      UPDATE decision_signals
      SET expire_at = CAST(strftime('%s', signal_time / 1000, 'unixepoch', '+8 hours', 'start of day', '-8 hours') AS INTEGER) * 1000
        + (15 * 60 + 30) * 60 * 1000
      WHERE source_module = 'short_term'
        AND expire_at = signal_time + 24 * 60 * 60 * 1000;
    `
  },
  {
    // FR-249: 资讯发布时间可信状态、历史日期恢复与归档口径纠偏
    version: 116,
    sql: `
      ALTER TABLE briefings ADD COLUMN publicationTimeStatus TEXT NOT NULL DEFAULT 'exact'
        CHECK (publicationTimeStatus IN ('exact','date_only','collected_fallback'));
      ALTER TABLE daily_archive ADD COLUMN uncertainTimeCount INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_briefings_publication_time_status
        ON briefings(publicationTimeStatus, publishedDateBJ);

      UPDATE briefings
      SET publicationTimeStatus = 'collected_fallback'
      WHERE ABS(publishedAt - collectedAt) <= 5 * 60 * 1000
         OR publishedAt > collectedAt + 15 * 60 * 1000
         OR publishedDateBJ > date(collectedAt / 1000, 'unixepoch', '+8 hours');

      UPDATE briefings
      SET publishedDateBJ =
            substr(originalUrl, instr(originalUrl, '/article/') + 9, 4) || '-' ||
            substr(originalUrl, instr(originalUrl, '/article/') + 13, 2) || '-' ||
            substr(originalUrl, instr(originalUrl, '/article/') + 15, 2),
          publishedAt = CAST(strftime('%s',
            substr(originalUrl, instr(originalUrl, '/article/') + 9, 4) || '-' ||
            substr(originalUrl, instr(originalUrl, '/article/') + 13, 2) || '-' ||
            substr(originalUrl, instr(originalUrl, '/article/') + 15, 2) || ' 00:00:00',
            '-8 hours') AS INTEGER) * 1000,
          publicationTimeStatus = 'date_only'
      WHERE publicationTimeStatus = 'collected_fallback'
        AND originalUrl LIKE '%21jingji.com%/article/%'
        AND substr(originalUrl, instr(originalUrl, '/article/') + 9, 8) GLOB '20[0-9][0-9][0-1][0-9][0-3][0-9]'
        AND strftime('%s',
          substr(originalUrl, instr(originalUrl, '/article/') + 9, 4) || '-' ||
          substr(originalUrl, instr(originalUrl, '/article/') + 13, 2) || '-' ||
          substr(originalUrl, instr(originalUrl, '/article/') + 15, 2) || ' 00:00:00',
          '-8 hours') IS NOT NULL;

      UPDATE briefings
      SET publishedDateBJ =
            substr(originalUrl, instr(originalUrl, '/n1/') + 4, 4) || '-' ||
            substr(originalUrl, instr(originalUrl, '/n1/') + 9, 2) || '-' ||
            substr(originalUrl, instr(originalUrl, '/n1/') + 11, 2),
          publishedAt = CAST(strftime('%s',
            substr(originalUrl, instr(originalUrl, '/n1/') + 4, 4) || '-' ||
            substr(originalUrl, instr(originalUrl, '/n1/') + 9, 2) || '-' ||
            substr(originalUrl, instr(originalUrl, '/n1/') + 11, 2) || ' 00:00:00',
            '-8 hours') AS INTEGER) * 1000,
          publicationTimeStatus = 'date_only'
      WHERE publicationTimeStatus = 'collected_fallback'
        AND originalUrl LIKE '%people.com.cn%/n1/%'
        AND substr(originalUrl, instr(originalUrl, '/n1/') + 4, 4) GLOB '20[0-9][0-9]'
        AND strftime('%s',
          substr(originalUrl, instr(originalUrl, '/n1/') + 4, 4) || '-' ||
          substr(originalUrl, instr(originalUrl, '/n1/') + 9, 2) || '-' ||
          substr(originalUrl, instr(originalUrl, '/n1/') + 11, 2) || ' 00:00:00',
          '-8 hours') IS NOT NULL;

      UPDATE briefings
      SET publishedDateBJ = substr(originalUrl, instr(originalUrl, '/20') + 1, 10),
          publishedAt = CAST(strftime('%s',
            substr(originalUrl, instr(originalUrl, '/20') + 1, 10) || ' 00:00:00',
            '-8 hours') AS INTEGER) * 1000,
          publicationTimeStatus = 'date_only'
      WHERE publicationTimeStatus = 'collected_fallback'
        AND (originalUrl LIKE '%caixin.com%' OR originalUrl LIKE '%xinhuanet.com%')
        AND substr(originalUrl, instr(originalUrl, '/20') + 1, 10)
          GLOB '20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
        AND strftime('%s',
          substr(originalUrl, instr(originalUrl, '/20') + 1, 10) || ' 00:00:00',
          '-8 hours') IS NOT NULL;

      UPDATE briefings
      SET publishedDateBJ =
            substr(originalUrl, instr(originalUrl, '/20') + 1, 7) || '-' ||
            substr(originalUrl, instr(originalUrl, '/20') + 9, 2),
          publishedAt = CAST(strftime('%s',
            substr(originalUrl, instr(originalUrl, '/20') + 1, 7) || '-' ||
            substr(originalUrl, instr(originalUrl, '/20') + 9, 2) || ' 00:00:00',
            '-8 hours') AS INTEGER) * 1000,
          publicationTimeStatus = 'date_only'
      WHERE publicationTimeStatus = 'collected_fallback'
        AND originalUrl LIKE '%financialnews.com.cn%'
        AND substr(originalUrl, instr(originalUrl, '/20') + 1, 7)
          GLOB '20[0-9][0-9]-[0-1][0-9]'
        AND substr(originalUrl, instr(originalUrl, '/20') + 9, 2)
          GLOB '[0-3][0-9]'
        AND strftime('%s',
          substr(originalUrl, instr(originalUrl, '/20') + 1, 7) || '-' ||
          substr(originalUrl, instr(originalUrl, '/20') + 9, 2) || ' 00:00:00',
          '-8 hours') IS NOT NULL;

      UPDATE briefings
      SET publishedDateBJ =
            substr(originalUrl, instr(originalUrl, '/20') + 1, 4) || '-' ||
            substr(originalUrl, instr(originalUrl, '/20') + 5, 2) || '-' ||
            substr(originalUrl, instr(originalUrl, '/20') + 7, 2),
          publishedAt = CAST(strftime('%s',
            substr(originalUrl, instr(originalUrl, '/20') + 1, 4) || '-' ||
            substr(originalUrl, instr(originalUrl, '/20') + 5, 2) || '-' ||
            substr(originalUrl, instr(originalUrl, '/20') + 7, 2) || ' 00:00:00',
            '-8 hours') AS INTEGER) * 1000,
          publicationTimeStatus = 'date_only'
      WHERE publicationTimeStatus = 'collected_fallback'
        AND originalUrl LIKE '%xinhuanet.com%'
        AND substr(originalUrl, instr(originalUrl, '/20') + 1, 8)
          GLOB '20[0-9][0-9][0-1][0-9][0-3][0-9]'
        AND strftime('%s',
          substr(originalUrl, instr(originalUrl, '/20') + 1, 4) || '-' ||
          substr(originalUrl, instr(originalUrl, '/20') + 5, 2) || '-' ||
          substr(originalUrl, instr(originalUrl, '/20') + 7, 2) || ' 00:00:00',
          '-8 hours') IS NOT NULL;

      UPDATE ai_analysis_sessions
      SET briefingId = NULL
      WHERE briefingId IN (
        SELECT id FROM briefings
        WHERE trim(title) GLOB '评论(*)'
           OR trim(title) GLOB '评论（*）'
      );
      DELETE FROM briefings
      WHERE trim(title) GLOB '评论(*)'
         OR trim(title) GLOB '评论（*）';

      UPDATE ai_analysis_sessions
      SET briefingId = (
        SELECT MIN(keeper.id)
        FROM briefings keeper
        JOIN briefings duplicate
          ON keeper.sourceId = duplicate.sourceId
         AND trim(keeper.title) = trim(duplicate.title)
         AND keeper.publishedDateBJ = duplicate.publishedDateBJ
        WHERE duplicate.id = ai_analysis_sessions.briefingId
      )
      WHERE briefingId IN (
        SELECT duplicate.id
        FROM briefings duplicate
        WHERE duplicate.id != (
          SELECT MIN(keeper.id)
          FROM briefings keeper
          WHERE keeper.sourceId = duplicate.sourceId
            AND trim(keeper.title) = trim(duplicate.title)
            AND keeper.publishedDateBJ = duplicate.publishedDateBJ
        )
      );
      DELETE FROM briefings
      WHERE id != (
        SELECT MIN(keeper.id)
        FROM briefings keeper
        WHERE keeper.sourceId = briefings.sourceId
          AND trim(keeper.title) = trim(briefings.title)
          AND keeper.publishedDateBJ = briefings.publishedDateBJ
      );

      DELETE FROM daily_archive;
      INSERT INTO daily_archive (
        date, totalCount, unreadCount, criticalCount, uncertainTimeCount, updatedAt
      )
      SELECT
        publishedDateBJ,
        SUM(CASE WHEN publicationTimeStatus != 'collected_fallback' THEN 1 ELSE 0 END),
        SUM(CASE WHEN publicationTimeStatus != 'collected_fallback' AND isRead = 0 THEN 1 ELSE 0 END),
        SUM(CASE WHEN publicationTimeStatus != 'collected_fallback' AND impactRating = 'CRITICAL' THEN 1 ELSE 0 END),
        SUM(CASE WHEN publicationTimeStatus = 'collected_fallback' THEN 1 ELSE 0 END),
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM briefings
      GROUP BY publishedDateBJ;
    `
  },
  {
    version: 117,
    sql: `
      UPDATE briefings
      SET publishedAt = collectedAt,
          publishedDateBJ = date(collectedAt / 1000, 'unixepoch', '+8 hours'),
          publicationTimeStatus = 'collected_fallback'
      WHERE publishedAt > collectedAt + 900000
         OR publishedDateBJ > date(collectedAt / 1000, 'unixepoch', '+8 hours');

      UPDATE ai_analysis_sessions
      SET briefingId = (
        SELECT MIN(keeper.id)
        FROM briefings keeper
        JOIN briefings duplicate
          ON keeper.sourceId = duplicate.sourceId
         AND trim(keeper.title) = trim(duplicate.title)
         AND keeper.publishedDateBJ = duplicate.publishedDateBJ
        WHERE duplicate.id = ai_analysis_sessions.briefingId
      )
      WHERE briefingId IN (
        SELECT duplicate.id
        FROM briefings duplicate
        WHERE duplicate.id != (
          SELECT MIN(keeper.id)
          FROM briefings keeper
          WHERE keeper.sourceId = duplicate.sourceId
            AND trim(keeper.title) = trim(duplicate.title)
            AND keeper.publishedDateBJ = duplicate.publishedDateBJ
        )
      );
      DELETE FROM briefings
      WHERE id != (
        SELECT MIN(keeper.id)
        FROM briefings keeper
        WHERE keeper.sourceId = briefings.sourceId
          AND trim(keeper.title) = trim(briefings.title)
          AND keeper.publishedDateBJ = briefings.publishedDateBJ
      );

      DELETE FROM daily_archive;
      INSERT INTO daily_archive (
        date, totalCount, unreadCount, criticalCount, uncertainTimeCount, updatedAt
      )
      SELECT
        publishedDateBJ,
        SUM(CASE WHEN publicationTimeStatus != 'collected_fallback' THEN 1 ELSE 0 END),
        SUM(CASE WHEN publicationTimeStatus != 'collected_fallback' AND isRead = 0 THEN 1 ELSE 0 END),
        SUM(CASE WHEN publicationTimeStatus != 'collected_fallback' AND impactRating = 'CRITICAL' THEN 1 ELSE 0 END),
        SUM(CASE WHEN publicationTimeStatus = 'collected_fallback' THEN 1 ELSE 0 END),
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM briefings
      WHERE publishedDateBJ <= date('now', '+8 hours')
      GROUP BY publishedDateBJ;
    `
  },
  {
    version: 118,
    sql: `
      CREATE TABLE stock_fundamental_profiles (
        ts_code                  TEXT PRIMARY KEY,
        stock_code               TEXT NOT NULL,
        short_name               TEXT DEFAULT NULL,
        legal_name               TEXT DEFAULT NULL,
        security_type            TEXT DEFAULT NULL,
        trade_market             TEXT DEFAULT NULL,
        industry                 TEXT DEFAULT NULL,
        chairman                 TEXT DEFAULT NULL,
        legal_representative     TEXT DEFAULT NULL,
        website                  TEXT DEFAULT NULL,
        office_address           TEXT DEFAULT NULL,
        registered_capital_wan   REAL DEFAULT NULL,
        employee_count           INTEGER DEFAULT NULL,
        business_scope           TEXT DEFAULT NULL,
        company_profile          TEXT DEFAULT NULL,
        source                    TEXT NOT NULL,
        source_fact_date          TEXT DEFAULT NULL,
        fetched_at               INTEGER NOT NULL
      );

      CREATE TABLE stock_fundamental_financials (
        ts_code                    TEXT NOT NULL,
        stock_code                 TEXT NOT NULL,
        short_name                 TEXT DEFAULT NULL,
        report_date                TEXT NOT NULL,
        report_type                TEXT DEFAULT NULL,
        notice_date                TEXT DEFAULT NULL,
        update_date                TEXT DEFAULT NULL,
        currency                   TEXT DEFAULT NULL,
        total_revenue              REAL DEFAULT NULL,
        parent_net_profit          REAL DEFAULT NULL,
        deducted_net_profit        REAL DEFAULT NULL,
        revenue_yoy                REAL DEFAULT NULL,
        parent_net_profit_yoy      REAL DEFAULT NULL,
        deducted_net_profit_yoy    REAL DEFAULT NULL,
        weighted_roe               REAL DEFAULT NULL,
        gross_margin               REAL DEFAULT NULL,
        net_margin                 REAL DEFAULT NULL,
        debt_ratio                 REAL DEFAULT NULL,
        operating_cash_flow        REAL DEFAULT NULL,
        basic_eps                  REAL DEFAULT NULL,
        book_value_per_share       REAL DEFAULT NULL,
        source                     TEXT NOT NULL,
        source_version             TEXT NOT NULL,
        fetched_at                 INTEGER NOT NULL,
        PRIMARY KEY (ts_code, report_date, source_version)
      );
      CREATE INDEX idx_stock_fundamental_financials_latest
        ON stock_fundamental_financials(ts_code, report_date DESC, notice_date DESC, fetched_at DESC);

      CREATE TABLE stock_fundamental_sync_state (
        ts_code             TEXT NOT NULL,
        dataset             TEXT NOT NULL CHECK (dataset IN ('profile', 'financial')),
        status              TEXT NOT NULL CHECK (status IN ('available', 'failed')),
        last_attempt_at     INTEGER NOT NULL,
        last_success_at     INTEGER DEFAULT NULL,
        fact_date           TEXT DEFAULT NULL,
        last_error_code     TEXT DEFAULT NULL,
        rows_written        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (ts_code, dataset)
      );
    `
  },
  {
    version: 119,
    sql: `
      CREATE TABLE stock_fundamental_announcements (
        ts_code                 TEXT NOT NULL,
        stock_code              TEXT NOT NULL,
        short_name              TEXT DEFAULT NULL,
        article_code            TEXT NOT NULL,
        title                   TEXT NOT NULL,
        notice_date             TEXT NOT NULL,
        display_at              INTEGER DEFAULT NULL,
        category_codes_json     TEXT NOT NULL DEFAULT '[]',
        category_names_json     TEXT NOT NULL DEFAULT '[]',
        source                  TEXT NOT NULL,
        source_url              TEXT NOT NULL,
        fetched_at              INTEGER NOT NULL,
        PRIMARY KEY (ts_code, article_code)
      );
      CREATE INDEX idx_stock_fundamental_announcements_latest
        ON stock_fundamental_announcements(
          ts_code, notice_date DESC, display_at DESC, article_code DESC
        );

      CREATE TABLE stock_fundamental_sync_state_v119 (
        ts_code             TEXT NOT NULL,
        dataset             TEXT NOT NULL CHECK (dataset IN ('profile', 'financial', 'announcement')),
        status              TEXT NOT NULL CHECK (status IN ('available', 'failed')),
        last_attempt_at     INTEGER NOT NULL,
        last_success_at     INTEGER DEFAULT NULL,
        fact_date           TEXT DEFAULT NULL,
        last_error_code     TEXT DEFAULT NULL,
        rows_written        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (ts_code, dataset)
      );
      INSERT INTO stock_fundamental_sync_state_v119 (
        ts_code, dataset, status, last_attempt_at, last_success_at,
        fact_date, last_error_code, rows_written
      )
      SELECT
        ts_code, dataset, status, last_attempt_at, last_success_at,
        fact_date, last_error_code, rows_written
      FROM stock_fundamental_sync_state;
      DROP TABLE stock_fundamental_sync_state;
      ALTER TABLE stock_fundamental_sync_state_v119
        RENAME TO stock_fundamental_sync_state;
    `
  },
  {
    version: 120,
    sql: `
      CREATE TABLE research_access_profiles (
        id                       TEXT PRIMARY KEY,
        name                     TEXT NOT NULL,
        credential_hash          TEXT NOT NULL UNIQUE,
        credential_version       INTEGER NOT NULL DEFAULT 1 CHECK (credential_version >= 1),
        scopes_json              TEXT NOT NULL,
        scope_version            INTEGER NOT NULL DEFAULT 1 CHECK (scope_version >= 1),
        enabled                  INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL,
        last_used_at             INTEGER DEFAULT NULL,
        revoked_at               INTEGER DEFAULT NULL,
        CHECK (length(trim(name)) BETWEEN 1 AND 60),
        CHECK (length(credential_hash) = 64)
      );
      CREATE INDEX idx_research_access_profiles_state
        ON research_access_profiles(revoked_at, enabled, updated_at DESC);

      CREATE TABLE research_access_operation_receipts (
        request_id               TEXT PRIMARY KEY,
        operation                TEXT NOT NULL CHECK (operation IN ('create', 'update', 'rotate', 'revoke')),
        profile_id               TEXT NOT NULL,
        created_at               INTEGER NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES research_access_profiles(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_research_access_operation_profile
        ON research_access_operation_receipts(profile_id, created_at DESC);

      CREATE TABLE research_access_audit (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id               TEXT NOT NULL UNIQUE,
        session_id               TEXT DEFAULT NULL,
        profile_id               TEXT DEFAULT NULL,
        profile_name_snapshot    TEXT DEFAULT NULL,
        surface                  TEXT NOT NULL CHECK (surface IN ('mcp', 'cli')),
        external_tool_name       TEXT DEFAULT NULL,
        tool_id                  TEXT DEFAULT NULL,
        input_sha256             TEXT DEFAULT NULL,
        input_summary_json       TEXT DEFAULT NULL,
        as_of                    TEXT DEFAULT NULL,
        decision                 TEXT NOT NULL CHECK (decision IN ('allowed', 'blocked')),
        scope_version            INTEGER DEFAULT NULL,
        tool_status              TEXT DEFAULT NULL,
        error_code               TEXT DEFAULT NULL,
        duration_ms              INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
        result_bytes             INTEGER NOT NULL DEFAULT 0 CHECK (result_bytes >= 0),
        result_sha256            TEXT DEFAULT NULL,
        created_at               INTEGER NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES research_access_profiles(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_research_access_audit_profile_time
        ON research_access_audit(profile_id, created_at DESC, id DESC);
      CREATE INDEX idx_research_access_audit_time
        ON research_access_audit(created_at DESC, id DESC);
    `
  },
  {
    version: 121,
    sql: `
      CREATE TABLE research_agent_runs (
        id                         TEXT PRIMARY KEY CHECK (length(id) = 36),
        request_id                 TEXT NOT NULL UNIQUE CHECK (length(request_id) = 36),
        request_fingerprint        TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
        parent_run_id              TEXT DEFAULT NULL,
        discussion_session_id      INTEGER DEFAULT NULL,
        question                   TEXT NOT NULL CHECK (length(trim(question)) BETWEEN 10 AND 8000),
        context_snapshot_json      TEXT NOT NULL CHECK (json_valid(context_snapshot_json) AND length(context_snapshot_json) <= 524288),
        context_snapshot_sha256    TEXT NOT NULL CHECK (length(context_snapshot_sha256) = 64),
        subjects_json              TEXT NOT NULL CHECK (json_valid(subjects_json) AND length(subjects_json) <= 32768),
        include_portfolio          INTEGER NOT NULL DEFAULT 0 CHECK (include_portfolio IN (0, 1)),
        as_of                      TEXT NOT NULL CHECK (length(as_of) = 8 AND as_of NOT GLOB '*[^0-9]*'),
        status                     TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'needs_attention', 'succeeded', 'failed', 'cancelled')),
        phase                      TEXT NOT NULL CHECK (phase IN ('planning', 'tooling', 'synthesis', 'audit', 'persist')),
        outcome                    TEXT DEFAULT NULL CHECK (outcome IS NULL OR outcome IN ('complete', 'partial', 'blocked')),
        provider                   TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 80),
        model                      TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 160),
        model_config_fingerprint   TEXT NOT NULL CHECK (length(model_config_fingerprint) = 64),
        prompt_rule_version        TEXT NOT NULL CHECK (length(trim(prompt_rule_version)) BETWEEN 1 AND 80),
        tool_registry_version      TEXT NOT NULL CHECK (length(trim(tool_registry_version)) BETWEEN 1 AND 80),
        budget_json                TEXT NOT NULL CHECK (json_valid(budget_json) AND length(budget_json) <= 32768),
        plan_json                  TEXT DEFAULT NULL CHECK (plan_json IS NULL OR (json_valid(plan_json) AND length(plan_json) <= 131072)),
        plan_sha256                TEXT DEFAULT NULL CHECK (plan_sha256 IS NULL OR length(plan_sha256) = 64),
        evidence_snapshot_sha256   TEXT DEFAULT NULL CHECK (evidence_snapshot_sha256 IS NULL OR length(evidence_snapshot_sha256) = 64),
        report_markdown            TEXT DEFAULT NULL CHECK (report_markdown IS NULL OR length(report_markdown) <= 30000),
        report_sha256              TEXT DEFAULT NULL CHECK (report_sha256 IS NULL OR length(report_sha256) = 64),
        audit_json                 TEXT DEFAULT NULL CHECK (audit_json IS NULL OR (json_valid(audit_json) AND length(audit_json) <= 262144)),
        model_call_count           INTEGER NOT NULL DEFAULT 0 CHECK (model_call_count BETWEEN 0 AND 6),
        tool_call_count            INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count BETWEEN 0 AND 8),
        tool_result_bytes          INTEGER NOT NULL DEFAULT 0 CHECK (tool_result_bytes BETWEEN 0 AND 2097152),
        input_tokens               INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens              INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        total_tokens               INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
        usage_status               TEXT NOT NULL DEFAULT 'not_started' CHECK (usage_status IN ('not_started', 'complete', 'partial', 'unknown')),
        estimated_cost             REAL NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
        cost_currency              TEXT DEFAULT NULL,
        cost_status                TEXT NOT NULL DEFAULT 'not_started' CHECK (cost_status IN ('not_started', 'complete', 'partial', 'unknown')),
        cancel_requested           INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        lease_owner                TEXT DEFAULT NULL,
        lease_expires_at           INTEGER DEFAULT NULL,
        revision                   INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        error_code                 TEXT DEFAULT NULL,
        error_message              TEXT DEFAULT NULL,
        retryable                  INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
        created_at                 INTEGER NOT NULL,
        started_at                 INTEGER DEFAULT NULL,
        completed_at               INTEGER DEFAULT NULL,
        updated_at                 INTEGER NOT NULL,
        CHECK ((plan_json IS NULL) = (plan_sha256 IS NULL)),
        CHECK ((report_markdown IS NULL) = (report_sha256 IS NULL)),
        CHECK ((status = 'succeeded' AND outcome IS NOT NULL) OR (status <> 'succeeded' AND outcome IS NULL)),
        CHECK (status <> 'running' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
        FOREIGN KEY (parent_run_id) REFERENCES research_agent_runs(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_research_agent_runs_status_time
        ON research_agent_runs(status, updated_at DESC, id);
      CREATE INDEX idx_research_agent_runs_discussion
        ON research_agent_runs(discussion_session_id, created_at DESC);
      CREATE UNIQUE INDEX idx_research_agent_runs_single_running
        ON research_agent_runs(status) WHERE status = 'running';

      CREATE TABLE research_agent_steps (
        id                         TEXT PRIMARY KEY CHECK (length(id) = 36),
        run_id                     TEXT NOT NULL,
        ordinal                    INTEGER NOT NULL CHECK (ordinal >= 1),
        kind                       TEXT NOT NULL CHECK (kind IN ('planning', 'tooling', 'synthesis', 'audit', 'persist')),
        status                     TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        predecessor_step_id        TEXT DEFAULT NULL,
        input_json                 TEXT NOT NULL CHECK (json_valid(input_json) AND length(input_json) <= 131072),
        input_sha256               TEXT NOT NULL CHECK (length(input_sha256) = 64),
        output_sha256              TEXT DEFAULT NULL CHECK (output_sha256 IS NULL OR length(output_sha256) = 64),
        artifact_json              TEXT DEFAULT NULL CHECK (artifact_json IS NULL OR (json_valid(artifact_json) AND length(artifact_json) <= 262144)),
        attempt_count              INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        revision                   INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        error_code                 TEXT DEFAULT NULL,
        error_message              TEXT DEFAULT NULL,
        created_at                 INTEGER NOT NULL,
        started_at                 INTEGER DEFAULT NULL,
        completed_at               INTEGER DEFAULT NULL,
        updated_at                 INTEGER NOT NULL,
        CHECK ((artifact_json IS NULL AND output_sha256 IS NULL) OR (artifact_json IS NOT NULL AND output_sha256 IS NOT NULL)),
        UNIQUE (run_id, ordinal),
        UNIQUE (id, run_id),
        FOREIGN KEY (run_id) REFERENCES research_agent_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (predecessor_step_id) REFERENCES research_agent_steps(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_research_agent_steps_run_status
        ON research_agent_steps(run_id, status, ordinal);

      CREATE TABLE research_agent_tool_calls (
        id                         TEXT PRIMARY KEY CHECK (length(id) = 36),
        run_id                     TEXT NOT NULL,
        step_id                    TEXT NOT NULL,
        tool_id                    TEXT NOT NULL CHECK (length(trim(tool_id)) BETWEEN 1 AND 120),
        attempt                    INTEGER NOT NULL CHECK (attempt >= 1),
        input_json                 TEXT NOT NULL CHECK (json_valid(input_json) AND length(input_json) <= 65536),
        input_sha256               TEXT NOT NULL CHECK (length(input_sha256) = 64),
        as_of                      TEXT NOT NULL CHECK (length(as_of) = 8 AND as_of NOT GLOB '*[^0-9]*'),
        status                     TEXT NOT NULL CHECK (status IN ('prepared', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')),
        envelope_json              TEXT DEFAULT NULL CHECK (envelope_json IS NULL OR (json_valid(envelope_json) AND length(envelope_json) <= 262144)),
        envelope_sha256            TEXT DEFAULT NULL CHECK (envelope_sha256 IS NULL OR length(envelope_sha256) = 64),
        model_projection_json      TEXT DEFAULT NULL CHECK (model_projection_json IS NULL OR (json_valid(model_projection_json) AND length(model_projection_json) <= 65536)),
        model_projection_sha256    TEXT DEFAULT NULL CHECK (model_projection_sha256 IS NULL OR length(model_projection_sha256) = 64),
        stable_references_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(stable_references_json) AND length(stable_references_json) <= 65536),
        fact_date                  TEXT DEFAULT NULL,
        sources_json               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources_json) AND length(sources_json) <= 65536),
        coverage_json              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(coverage_json) AND length(coverage_json) <= 65536),
        warnings_json              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json) AND length(warnings_json) <= 65536),
        duration_ms                INTEGER DEFAULT NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
        error_code                 TEXT DEFAULT NULL,
        error_message              TEXT DEFAULT NULL,
        prepared_at                INTEGER NOT NULL,
        started_at                 INTEGER DEFAULT NULL,
        completed_at               INTEGER DEFAULT NULL,
        updated_at                 INTEGER NOT NULL,
        CHECK ((envelope_json IS NULL) = (envelope_sha256 IS NULL)),
        CHECK ((model_projection_json IS NULL) = (model_projection_sha256 IS NULL)),
        UNIQUE (run_id, step_id, tool_id, input_sha256, as_of, attempt),
        FOREIGN KEY (run_id) REFERENCES research_agent_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (step_id, run_id) REFERENCES research_agent_steps(id, run_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_research_agent_tool_calls_run_status
        ON research_agent_tool_calls(run_id, status, prepared_at);
      CREATE UNIQUE INDEX idx_research_agent_tool_calls_success_reuse
        ON research_agent_tool_calls(run_id, tool_id, input_sha256, as_of)
        WHERE status = 'succeeded';

      CREATE TABLE research_agent_model_calls (
        id                         TEXT PRIMARY KEY CHECK (length(id) = 36),
        run_id                     TEXT NOT NULL,
        step_id                    TEXT NOT NULL,
        purpose                    TEXT NOT NULL CHECK (length(trim(purpose)) BETWEEN 1 AND 80),
        attempt                    INTEGER NOT NULL CHECK (attempt >= 1),
        status                     TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'succeeded', 'safe_failed', 'outcome_unknown', 'cancelled')),
        provider                   TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 80),
        model                      TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 160),
        prompt_rule_version        TEXT NOT NULL CHECK (length(trim(prompt_rule_version)) BETWEEN 1 AND 80),
        input_messages_json        TEXT NOT NULL CHECK (json_valid(input_messages_json) AND length(input_messages_json) <= 98304),
        input_sha256               TEXT NOT NULL CHECK (length(input_sha256) = 64),
        response_id                TEXT DEFAULT NULL,
        response_text              TEXT DEFAULT NULL CHECK (response_text IS NULL OR length(response_text) <= 131072),
        response_sha256            TEXT DEFAULT NULL CHECK (response_sha256 IS NULL OR length(response_sha256) = 64),
        finish_reason              TEXT DEFAULT NULL,
        input_tokens               INTEGER DEFAULT NULL CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens              INTEGER DEFAULT NULL CHECK (output_tokens IS NULL OR output_tokens >= 0),
        total_tokens               INTEGER DEFAULT NULL CHECK (total_tokens IS NULL OR total_tokens >= 0),
        usage_status               TEXT DEFAULT NULL CHECK (usage_status IS NULL OR usage_status IN ('complete', 'partial', 'unknown')),
        price_snapshot_json        TEXT DEFAULT NULL CHECK (price_snapshot_json IS NULL OR (json_valid(price_snapshot_json) AND length(price_snapshot_json) <= 32768)),
        estimated_cost             REAL DEFAULT NULL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
        cost_currency              TEXT DEFAULT NULL,
        error_code                 TEXT DEFAULT NULL,
        error_message              TEXT DEFAULT NULL,
        prepared_at                INTEGER NOT NULL,
        submitted_at               INTEGER DEFAULT NULL,
        completed_at               INTEGER DEFAULT NULL,
        updated_at                 INTEGER NOT NULL,
        CHECK ((response_text IS NULL) = (response_sha256 IS NULL)),
        UNIQUE (run_id, purpose, attempt),
        FOREIGN KEY (run_id) REFERENCES research_agent_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (step_id, run_id) REFERENCES research_agent_steps(id, run_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_research_agent_model_calls_run_status
        ON research_agent_model_calls(run_id, status, prepared_at);
    `
  },
  {
    version: 122,
    sql: `
      ALTER TABLE research_agent_runs RENAME COLUMN report_markdown TO report_markdown_v121;
      ALTER TABLE research_agent_runs RENAME COLUMN report_sha256 TO report_sha256_v121;
      ALTER TABLE research_agent_runs ADD COLUMN report_sha256 TEXT DEFAULT NULL
        CHECK (report_sha256 IS NULL OR length(report_sha256) = 64);
      ALTER TABLE research_agent_runs ADD COLUMN report_markdown TEXT DEFAULT NULL
        CHECK (
          (report_markdown IS NULL OR length(report_markdown) <= 60000)
          AND ((report_markdown IS NULL) = (report_sha256 IS NULL))
        );
      UPDATE research_agent_runs
      SET report_markdown = report_markdown_v121, report_sha256 = report_sha256_v121;
      UPDATE research_agent_runs
      SET report_markdown_v121 = NULL, report_sha256_v121 = NULL;

      DROP INDEX idx_research_agent_tool_calls_run_status;
      DROP INDEX idx_research_agent_tool_calls_success_reuse;
      ALTER TABLE research_agent_tool_calls RENAME TO research_agent_tool_calls_v121;

      CREATE TABLE research_agent_tool_calls (
        id                         TEXT PRIMARY KEY CHECK (length(id) = 36),
        run_id                     TEXT NOT NULL,
        step_id                    TEXT NOT NULL,
        tool_id                    TEXT NOT NULL CHECK (length(trim(tool_id)) BETWEEN 1 AND 120),
        attempt                    INTEGER NOT NULL CHECK (attempt >= 1),
        input_json                 TEXT NOT NULL CHECK (json_valid(input_json) AND length(input_json) <= 65536),
        input_sha256               TEXT NOT NULL CHECK (length(input_sha256) = 64),
        as_of                      TEXT NOT NULL CHECK (length(as_of) = 8 AND as_of NOT GLOB '*[^0-9]*'),
        status                     TEXT NOT NULL CHECK (status IN ('prepared', 'running', 'submitted', 'succeeded', 'failed', 'blocked', 'outcome_unknown', 'cancelled')),
        envelope_json              TEXT DEFAULT NULL CHECK (envelope_json IS NULL OR (json_valid(envelope_json) AND length(envelope_json) <= 262144)),
        envelope_sha256            TEXT DEFAULT NULL CHECK (envelope_sha256 IS NULL OR length(envelope_sha256) = 64),
        model_projection_json      TEXT DEFAULT NULL CHECK (model_projection_json IS NULL OR (json_valid(model_projection_json) AND length(model_projection_json) <= 24576)),
        model_projection_sha256    TEXT DEFAULT NULL CHECK (model_projection_sha256 IS NULL OR length(model_projection_sha256) = 64),
        stable_references_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(stable_references_json) AND length(stable_references_json) <= 65536),
        fact_date                  TEXT DEFAULT NULL,
        sources_json               TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources_json) AND length(sources_json) <= 65536),
        coverage_json              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(coverage_json) AND length(coverage_json) <= 65536),
        warnings_json              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json) AND length(warnings_json) <= 65536),
        duration_ms                INTEGER DEFAULT NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
        error_code                 TEXT DEFAULT NULL,
        error_message              TEXT DEFAULT NULL,
        prepared_at                INTEGER NOT NULL,
        started_at                 INTEGER DEFAULT NULL,
        submitted_at               INTEGER DEFAULT NULL,
        completed_at               INTEGER DEFAULT NULL,
        updated_at                 INTEGER NOT NULL,
        CHECK ((envelope_json IS NULL) = (envelope_sha256 IS NULL)),
        CHECK ((model_projection_json IS NULL) = (model_projection_sha256 IS NULL)),
        UNIQUE (run_id, step_id, tool_id, input_sha256, as_of, attempt),
        FOREIGN KEY (run_id) REFERENCES research_agent_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (step_id, run_id) REFERENCES research_agent_steps(id, run_id) ON DELETE CASCADE
      );

      INSERT INTO research_agent_tool_calls (
        id, run_id, step_id, tool_id, attempt, input_json, input_sha256, as_of, status,
        envelope_json, envelope_sha256, model_projection_json, model_projection_sha256,
        stable_references_json, fact_date, sources_json, coverage_json, warnings_json,
        duration_ms, error_code, error_message, prepared_at, started_at, submitted_at,
        completed_at, updated_at
      )
      SELECT
        id, run_id, step_id, tool_id, attempt, input_json, input_sha256, as_of, status,
        envelope_json, envelope_sha256, model_projection_json, model_projection_sha256,
        stable_references_json, fact_date, sources_json, coverage_json, warnings_json,
        duration_ms, error_code, error_message, prepared_at, started_at, NULL,
        completed_at, updated_at
      FROM research_agent_tool_calls_v121;

      DROP TABLE research_agent_tool_calls_v121;
      CREATE INDEX idx_research_agent_tool_calls_run_status
        ON research_agent_tool_calls(run_id, status, prepared_at);
      CREATE UNIQUE INDEX idx_research_agent_tool_calls_success_reuse
        ON research_agent_tool_calls(run_id, tool_id, input_sha256, as_of)
        WHERE status = 'succeeded';
    `
  },
  {
    version: 123,
    sql: `
      ALTER TABLE research_agent_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'single_agent'
        CHECK (run_kind IN ('single_agent', 'multi_perspective'));
      CREATE INDEX idx_research_agent_runs_kind_parent
        ON research_agent_runs(run_kind, parent_run_id, created_at DESC);
    `
  },
  {
    version: 124,
    sql: `
      CREATE TABLE after_close_sync_runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date     TEXT NOT NULL UNIQUE
          CHECK (length(trade_date) = 8 AND trade_date NOT GLOB '*[^0-9]*'),
        trigger        TEXT NOT NULL
          CHECK (trigger IN ('scheduled', 'startup_catch_up')),
        status         TEXT NOT NULL
          CHECK (status IN ('running', 'completed', 'partial', 'failed', 'blocked')),
        started_at     INTEGER NOT NULL,
        completed_at   INTEGER DEFAULT NULL,
        updated_at     INTEGER NOT NULL,
        attempt_count  INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
        tasks_json     TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(tasks_json) AND length(tasks_json) <= 16384),
        error_summary  TEXT DEFAULT NULL CHECK (error_summary IS NULL OR length(error_summary) <= 1000)
      );
      CREATE INDEX idx_after_close_sync_runs_status_date
        ON after_close_sync_runs(status, trade_date DESC);
    `
  },
  {
    version: 125,
    sql: `
      CREATE TABLE premarket_fact_snapshots (
        id              TEXT PRIMARY KEY CHECK (length(id) = 36),
        trade_date      TEXT NOT NULL
          CHECK (length(trade_date) = 8 AND trade_date NOT GLOB '*[^0-9]*'),
        stage           TEXT NOT NULL
          CHECK (stage IN ('overnight', 'asia_open', 'auction_confirmed', 'after_close')),
        status          TEXT NOT NULL
          CHECK (status IN ('ready', 'partial', 'blocked', 'failed')),
        schema_version  INTEGER NOT NULL CHECK (schema_version = 1),
        rule_version    TEXT NOT NULL CHECK (length(trim(rule_version)) BETWEEN 1 AND 80),
        cutoff_at       INTEGER NOT NULL CHECK (cutoff_at > 0),
        captured_at     INTEGER NOT NULL CHECK (captured_at > 0),
        provider_id     TEXT NOT NULL CHECK (length(trim(provider_id)) BETWEEN 1 AND 80),
        facts_json      TEXT NOT NULL
          CHECK (json_valid(facts_json) AND json_type(facts_json) = 'object' AND length(facts_json) <= 131072),
        facts_sha256    TEXT NOT NULL CHECK (length(facts_sha256) = 64),
        sources_json    TEXT NOT NULL
          CHECK (json_valid(sources_json) AND json_type(sources_json) = 'array' AND length(sources_json) <= 32768),
        warnings_json   TEXT NOT NULL
          CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array' AND length(warnings_json) <= 32768),
        created_at      INTEGER NOT NULL CHECK (created_at > 0),
        UNIQUE (trade_date, stage, rule_version)
      );
      CREATE INDEX idx_premarket_fact_snapshots_date_stage
        ON premarket_fact_snapshots(trade_date DESC, stage, created_at DESC);
      CREATE TRIGGER premarket_fact_snapshots_no_update
        BEFORE UPDATE ON premarket_fact_snapshots
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_FACT_SNAPSHOT_IMMUTABLE'); END;
      CREATE TRIGGER premarket_fact_snapshots_no_delete
        BEFORE DELETE ON premarket_fact_snapshots
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_FACT_SNAPSHOT_IMMUTABLE'); END;
    `
  },
  {
    version: 126,
    sql: `
      ALTER TABLE app_settings ADD COLUMN premarket_network_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (premarket_network_enabled IN (0, 1));
    `
  },
  {
    version: 127,
    sql: `
      CREATE TABLE premarket_scenario_versions (
        id                     TEXT PRIMARY KEY CHECK (length(id) = 36),
        trade_date             TEXT NOT NULL
          CHECK (length(trade_date) = 8 AND trade_date NOT GLOB '*[^0-9]*'),
        stage                  TEXT NOT NULL
          CHECK (stage IN ('asia_open', 'auction_confirmed')),
        status                 TEXT NOT NULL
          CHECK (status IN ('ready', 'partial', 'blocked')),
        schema_version         INTEGER NOT NULL CHECK (schema_version = 1),
        rule_version           TEXT NOT NULL CHECK (length(trim(rule_version)) BETWEEN 1 AND 80),
        base_fact_snapshot_id  TEXT DEFAULT NULL REFERENCES premarket_fact_snapshots(id),
        parent_version_id      TEXT DEFAULT NULL REFERENCES premarket_scenario_versions(id),
        cutoff_at              INTEGER NOT NULL CHECK (cutoff_at > 0),
        generated_at           INTEGER NOT NULL CHECK (generated_at > 0),
        evidence_json          TEXT NOT NULL
          CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object' AND length(evidence_json) <= 524288),
        evidence_sha256        TEXT NOT NULL CHECK (length(evidence_sha256) = 64),
        scenario_json          TEXT NOT NULL
          CHECK (json_valid(scenario_json) AND json_type(scenario_json) = 'object' AND length(scenario_json) <= 524288),
        scenario_sha256        TEXT NOT NULL CHECK (length(scenario_sha256) = 64),
        warnings_json          TEXT NOT NULL
          CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array' AND length(warnings_json) <= 65536),
        created_at             INTEGER NOT NULL CHECK (created_at > 0),
        UNIQUE (trade_date, stage, rule_version),
        CHECK (
          (stage = 'asia_open' AND parent_version_id IS NULL)
          OR stage = 'auction_confirmed'
        )
      );
      CREATE INDEX idx_premarket_scenario_versions_date_stage
        ON premarket_scenario_versions(trade_date DESC, stage, created_at DESC);
      CREATE TRIGGER premarket_scenario_versions_no_update
        BEFORE UPDATE ON premarket_scenario_versions
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_SCENARIO_VERSION_IMMUTABLE'); END;
      CREATE TRIGGER premarket_scenario_versions_no_delete
        BEFORE DELETE ON premarket_scenario_versions
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_SCENARIO_VERSION_IMMUTABLE'); END;
    `
  },
  {
    version: 128,
    sql: `
      CREATE TABLE premarket_outcome_validations (
        id                     TEXT PRIMARY KEY CHECK (length(id) = 36),
        trade_date             TEXT NOT NULL
          CHECK (length(trade_date) = 8 AND trade_date NOT GLOB '*[^0-9]*'),
        scenario_version_id    TEXT NOT NULL REFERENCES premarket_scenario_versions(id),
        status                 TEXT NOT NULL CHECK (status IN ('matured', 'partial', 'missing')),
        schema_version         INTEGER NOT NULL CHECK (schema_version = 1),
        rule_version           TEXT NOT NULL CHECK (rule_version = 'premarket-validation-v1'),
        source_fingerprint     TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
        validation_json        TEXT NOT NULL
          CHECK (json_valid(validation_json) AND json_type(validation_json) = 'object' AND length(validation_json) <= 524288),
        validation_sha256      TEXT NOT NULL CHECK (length(validation_sha256) = 64),
        created_at             INTEGER NOT NULL CHECK (created_at > 0),
        UNIQUE (scenario_version_id, rule_version, source_fingerprint)
      );
      CREATE INDEX idx_premarket_outcome_validations_date
        ON premarket_outcome_validations(trade_date DESC, created_at DESC);
      CREATE INDEX idx_premarket_outcome_validations_scenario
        ON premarket_outcome_validations(scenario_version_id, created_at DESC);
      CREATE TRIGGER premarket_outcome_validations_no_update
        BEFORE UPDATE ON premarket_outcome_validations
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_OUTCOME_VALIDATION_IMMUTABLE'); END;
      CREATE TRIGGER premarket_outcome_validations_no_delete
        BEFORE DELETE ON premarket_outcome_validations
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_OUTCOME_VALIDATION_IMMUTABLE'); END;

      CREATE TABLE premarket_notification_deliveries (
        trade_date             TEXT PRIMARY KEY
          CHECK (length(trade_date) = 8 AND trade_date NOT GLOB '*[^0-9]*'),
        scenario_version_id    TEXT NOT NULL REFERENCES premarket_scenario_versions(id),
        status                 TEXT NOT NULL CHECK (status IN ('prepared', 'shown', 'unsupported', 'failed')),
        title                  TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        body                   TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
        attempted_at           INTEGER NOT NULL CHECK (attempted_at > 0),
        completed_at           INTEGER DEFAULT NULL,
        error_code             TEXT DEFAULT NULL CHECK (error_code IS NULL OR length(error_code) <= 120)
      );

      CREATE TABLE premarket_ai_explanations (
        id                     TEXT PRIMARY KEY CHECK (length(id) = 36),
        scenario_version_id    TEXT NOT NULL REFERENCES premarket_scenario_versions(id),
        outcome_validation_id  TEXT DEFAULT NULL REFERENCES premarket_outcome_validations(id),
        provider               TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 40),
        model                  TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 120),
        model_config_fingerprint TEXT NOT NULL CHECK (length(model_config_fingerprint) = 64),
        source_fingerprint     TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
        prompt_sha256          TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
        explanation_json       TEXT NOT NULL
          CHECK (json_valid(explanation_json) AND json_type(explanation_json) = 'object' AND length(explanation_json) <= 32768),
        explanation_sha256     TEXT NOT NULL CHECK (length(explanation_sha256) = 64),
        usage_json             TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(usage_json) AND json_type(usage_json) = 'object' AND length(usage_json) <= 4096),
        created_at             INTEGER NOT NULL CHECK (created_at > 0),
        UNIQUE (scenario_version_id, outcome_validation_id, provider, model, model_config_fingerprint, source_fingerprint)
      );
      CREATE UNIQUE INDEX idx_premarket_ai_explanations_identity
        ON premarket_ai_explanations(
          scenario_version_id,
          COALESCE(outcome_validation_id, ''),
          provider,
          model,
          model_config_fingerprint,
          source_fingerprint
        );
      CREATE INDEX idx_premarket_ai_explanations_scenario
        ON premarket_ai_explanations(scenario_version_id, created_at DESC);
      CREATE TRIGGER premarket_ai_explanations_no_update
        BEFORE UPDATE ON premarket_ai_explanations
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_AI_EXPLANATION_IMMUTABLE'); END;
      CREATE TRIGGER premarket_ai_explanations_no_delete
        BEFORE DELETE ON premarket_ai_explanations
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_AI_EXPLANATION_IMMUTABLE'); END;
    `
  },
  {
    version: 129,
    sql: `
      CREATE TABLE premarket_preparation_snapshots (
        id                     TEXT PRIMARY KEY CHECK (length(id) = 36),
        target_trade_date      TEXT NOT NULL
          CHECK (length(target_trade_date) = 8 AND target_trade_date NOT GLOB '*[^0-9]*'),
        status                 TEXT NOT NULL CHECK (status IN ('ready', 'partial', 'failed')),
        schema_version         INTEGER NOT NULL CHECK (schema_version = 1),
        rule_version           TEXT NOT NULL CHECK (rule_version = 'premarket-preparation-v1'),
        captured_at            INTEGER NOT NULL CHECK (captured_at > 0),
        external_json          TEXT NOT NULL
          CHECK (json_valid(external_json) AND json_type(external_json) = 'object' AND length(external_json) <= 131072),
        external_sha256        TEXT NOT NULL CHECK (length(external_sha256) = 64),
        briefings_json         TEXT NOT NULL
          CHECK (json_valid(briefings_json) AND json_type(briefings_json) = 'object' AND length(briefings_json) <= 32768),
        briefings_sha256       TEXT NOT NULL CHECK (length(briefings_sha256) = 64),
        warnings_json          TEXT NOT NULL
          CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array' AND length(warnings_json) <= 32768),
        created_at             INTEGER NOT NULL CHECK (created_at > 0)
      );
      CREATE INDEX idx_premarket_preparation_target
        ON premarket_preparation_snapshots(target_trade_date DESC, created_at DESC);
      CREATE TRIGGER premarket_preparation_snapshots_no_update
        BEFORE UPDATE ON premarket_preparation_snapshots
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_PREPARATION_SNAPSHOT_IMMUTABLE'); END;
      CREATE TRIGGER premarket_preparation_snapshots_no_delete
        BEFORE DELETE ON premarket_preparation_snapshots
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_PREPARATION_SNAPSHOT_IMMUTABLE'); END;
    `
  },
  {
    version: 130,
    isolateForeignKeys: true,
    sql: `
      DROP INDEX idx_research_agent_runs_status_time;
      DROP INDEX idx_research_agent_runs_discussion;
      DROP INDEX idx_research_agent_runs_single_running;
      DROP INDEX idx_research_agent_runs_kind_parent;
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE research_agent_runs RENAME TO research_agent_runs_v129;
      PRAGMA legacy_alter_table = OFF;

      CREATE TABLE research_agent_runs (
        id                         TEXT PRIMARY KEY CHECK (length(id) = 36),
        request_id                 TEXT NOT NULL UNIQUE CHECK (length(request_id) = 36),
        request_fingerprint        TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
        parent_run_id              TEXT DEFAULT NULL,
        discussion_session_id      INTEGER DEFAULT NULL,
        question                   TEXT NOT NULL CHECK (length(trim(question)) BETWEEN 10 AND 8000),
        context_snapshot_json      TEXT NOT NULL CHECK (json_valid(context_snapshot_json) AND length(context_snapshot_json) <= 524288),
        context_snapshot_sha256    TEXT NOT NULL CHECK (length(context_snapshot_sha256) = 64),
        subjects_json              TEXT NOT NULL CHECK (json_valid(subjects_json) AND length(subjects_json) <= 32768),
        include_portfolio          INTEGER NOT NULL DEFAULT 0 CHECK (include_portfolio IN (0, 1)),
        as_of                      TEXT NOT NULL CHECK (length(as_of) = 8 AND as_of NOT GLOB '*[^0-9]*'),
        status                     TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'needs_attention', 'succeeded', 'failed', 'cancelled')),
        phase                      TEXT NOT NULL CHECK (phase IN ('planning', 'tooling', 'synthesis', 'audit', 'persist')),
        outcome                    TEXT DEFAULT NULL CHECK (outcome IS NULL OR outcome IN ('complete', 'partial', 'blocked')),
        provider                   TEXT NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 80),
        model                      TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 160),
        model_config_fingerprint   TEXT NOT NULL CHECK (length(model_config_fingerprint) = 64),
        prompt_rule_version        TEXT NOT NULL CHECK (length(trim(prompt_rule_version)) BETWEEN 1 AND 80),
        tool_registry_version      TEXT NOT NULL CHECK (length(trim(tool_registry_version)) BETWEEN 1 AND 80),
        budget_json                TEXT NOT NULL CHECK (json_valid(budget_json) AND length(budget_json) <= 32768),
        plan_json                  TEXT DEFAULT NULL CHECK (plan_json IS NULL OR (json_valid(plan_json) AND length(plan_json) <= 131072)),
        plan_sha256                TEXT DEFAULT NULL CHECK (plan_sha256 IS NULL OR length(plan_sha256) = 64),
        evidence_snapshot_sha256   TEXT DEFAULT NULL CHECK (evidence_snapshot_sha256 IS NULL OR length(evidence_snapshot_sha256) = 64),
        report_sha256              TEXT DEFAULT NULL CHECK (report_sha256 IS NULL OR length(report_sha256) = 64),
        report_markdown            TEXT DEFAULT NULL CHECK (
          (report_markdown IS NULL OR length(report_markdown) <= 60000)
          AND ((report_markdown IS NULL) = (report_sha256 IS NULL))
        ),
        audit_json                 TEXT DEFAULT NULL CHECK (audit_json IS NULL OR (json_valid(audit_json) AND length(audit_json) <= 262144)),
        model_call_count           INTEGER NOT NULL DEFAULT 0 CHECK (model_call_count >= 0),
        tool_call_count            INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
        tool_result_bytes          INTEGER NOT NULL DEFAULT 0 CHECK (tool_result_bytes >= 0),
        input_tokens               INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens              INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        total_tokens               INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
        usage_status               TEXT NOT NULL DEFAULT 'not_started' CHECK (usage_status IN ('not_started', 'complete', 'partial', 'unknown')),
        estimated_cost             REAL NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
        cost_currency              TEXT DEFAULT NULL,
        cost_status                TEXT NOT NULL DEFAULT 'not_started' CHECK (cost_status IN ('not_started', 'complete', 'partial', 'unknown')),
        cancel_requested           INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        lease_owner                TEXT DEFAULT NULL,
        lease_expires_at           INTEGER DEFAULT NULL,
        revision                   INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        error_code                 TEXT DEFAULT NULL,
        error_message              TEXT DEFAULT NULL,
        retryable                  INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
        created_at                 INTEGER NOT NULL,
        started_at                 INTEGER DEFAULT NULL,
        completed_at               INTEGER DEFAULT NULL,
        updated_at                 INTEGER NOT NULL,
        run_kind                   TEXT NOT NULL DEFAULT 'single_agent' CHECK (run_kind IN ('single_agent', 'multi_perspective')),
        CHECK ((plan_json IS NULL) = (plan_sha256 IS NULL)),
        CHECK ((status = 'succeeded' AND outcome IS NOT NULL) OR (status <> 'succeeded' AND outcome IS NULL)),
        CHECK (status <> 'running' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
        FOREIGN KEY (parent_run_id) REFERENCES research_agent_runs(id) ON DELETE SET NULL
      );

      INSERT INTO research_agent_runs (
        id, request_id, request_fingerprint, parent_run_id, discussion_session_id,
        question, context_snapshot_json, context_snapshot_sha256, subjects_json,
        include_portfolio, as_of, status, phase, outcome, provider, model,
        model_config_fingerprint, prompt_rule_version, tool_registry_version,
        budget_json, plan_json, plan_sha256, evidence_snapshot_sha256,
        report_sha256, report_markdown, audit_json, model_call_count, tool_call_count,
        tool_result_bytes, input_tokens, output_tokens, total_tokens, usage_status,
        estimated_cost, cost_currency, cost_status, cancel_requested, lease_owner,
        lease_expires_at, revision, error_code, error_message, retryable, created_at,
        started_at, completed_at, updated_at, run_kind
      )
      SELECT
        id, request_id, request_fingerprint, parent_run_id, discussion_session_id,
        question, context_snapshot_json, context_snapshot_sha256, subjects_json,
        include_portfolio, as_of, status, phase, outcome, provider, model,
        model_config_fingerprint, prompt_rule_version, tool_registry_version,
        budget_json, plan_json, plan_sha256, evidence_snapshot_sha256,
        report_sha256, report_markdown, audit_json, model_call_count, tool_call_count,
        tool_result_bytes, input_tokens, output_tokens, total_tokens, usage_status,
        estimated_cost, cost_currency, cost_status, cancel_requested, lease_owner,
        lease_expires_at, revision, error_code, error_message, retryable, created_at,
        started_at, completed_at, updated_at, run_kind
      FROM research_agent_runs_v129;

      DROP TABLE research_agent_runs_v129;
      CREATE INDEX idx_research_agent_runs_status_time
        ON research_agent_runs(status, updated_at DESC, id);
      CREATE INDEX idx_research_agent_runs_discussion
        ON research_agent_runs(discussion_session_id, created_at DESC);
      CREATE UNIQUE INDEX idx_research_agent_runs_single_running
        ON research_agent_runs(status) WHERE status = 'running';
      CREATE INDEX idx_research_agent_runs_kind_parent
        ON research_agent_runs(run_kind, parent_run_id, created_at DESC);
    `
  },
  {
    version: 131,
    isolateForeignKeys: true,
    sql: `
      DROP INDEX idx_premarket_scenario_versions_date_stage;
      DROP TRIGGER premarket_scenario_versions_no_update;
      DROP TRIGGER premarket_scenario_versions_no_delete;
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE premarket_scenario_versions RENAME TO premarket_scenario_versions_v130;
      PRAGMA legacy_alter_table = OFF;

      CREATE TABLE premarket_scenario_versions (
        id                     TEXT PRIMARY KEY CHECK (length(id) = 36),
        trade_date             TEXT NOT NULL
          CHECK (length(trade_date) = 8 AND trade_date NOT GLOB '*[^0-9]*'),
        stage                  TEXT NOT NULL
          CHECK (stage IN ('asia_open', 'auction_confirmed')),
        status                 TEXT NOT NULL
          CHECK (status IN ('ready', 'partial', 'blocked')),
        schema_version         INTEGER NOT NULL CHECK (schema_version = 1),
        rule_version           TEXT NOT NULL CHECK (length(trim(rule_version)) BETWEEN 1 AND 80),
        base_fact_snapshot_id  TEXT DEFAULT NULL REFERENCES premarket_fact_snapshots(id),
        parent_version_id      TEXT DEFAULT NULL REFERENCES premarket_scenario_versions(id),
        previous_revision_id   TEXT DEFAULT NULL REFERENCES premarket_scenario_versions(id),
        revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        revision_kind          TEXT NOT NULL DEFAULT 'scheduled'
          CHECK (revision_kind IN ('scheduled', 'startup_catch_up', 'manual_backfill')),
        requested_at           INTEGER NOT NULL DEFAULT 1 CHECK (requested_at > 0),
        cutoff_at              INTEGER NOT NULL CHECK (cutoff_at > 0),
        fact_cutoff_at         INTEGER NOT NULL CHECK (fact_cutoff_at > 0),
        generated_at           INTEGER NOT NULL CHECK (generated_at > 0),
        evidence_json          TEXT NOT NULL
          CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object' AND length(evidence_json) <= 524288),
        evidence_sha256        TEXT NOT NULL CHECK (length(evidence_sha256) = 64),
        scenario_json          TEXT NOT NULL
          CHECK (json_valid(scenario_json) AND json_type(scenario_json) = 'object' AND length(scenario_json) <= 524288),
        scenario_sha256        TEXT NOT NULL CHECK (length(scenario_sha256) = 64),
        warnings_json          TEXT NOT NULL
          CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array' AND length(warnings_json) <= 65536),
        created_at             INTEGER NOT NULL CHECK (created_at > 0),
        UNIQUE (trade_date, stage, rule_version, revision),
        CHECK (
          (stage = 'asia_open' AND parent_version_id IS NULL)
          OR stage = 'auction_confirmed'
        ),
        CHECK (revision > 1 OR previous_revision_id IS NULL)
      );
      INSERT INTO premarket_scenario_versions (
        id, trade_date, stage, status, schema_version, rule_version,
        base_fact_snapshot_id, parent_version_id, previous_revision_id,
        revision, revision_kind, requested_at, cutoff_at, fact_cutoff_at,
        generated_at, evidence_json, evidence_sha256, scenario_json,
        scenario_sha256, warnings_json, created_at
      )
      SELECT
        id, trade_date, stage, status, schema_version, rule_version,
        base_fact_snapshot_id, parent_version_id, NULL,
        1, 'scheduled', created_at, cutoff_at, cutoff_at,
        generated_at, evidence_json, evidence_sha256, scenario_json,
        scenario_sha256, warnings_json, created_at
      FROM premarket_scenario_versions_v130;
      DROP TABLE premarket_scenario_versions_v130;

      CREATE INDEX idx_premarket_scenario_versions_date_stage
        ON premarket_scenario_versions(trade_date DESC, stage, revision DESC, created_at DESC);
      CREATE TRIGGER premarket_scenario_versions_no_update
        BEFORE UPDATE ON premarket_scenario_versions
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_SCENARIO_VERSION_IMMUTABLE'); END;
      CREATE TRIGGER premarket_scenario_versions_no_delete
        BEFORE DELETE ON premarket_scenario_versions
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_SCENARIO_VERSION_IMMUTABLE'); END;
    `
  },
  {
    version: 132,
    isolateForeignKeys: true,
    sql: `
      DROP INDEX idx_premarket_fact_snapshots_date_stage;
      DROP TRIGGER premarket_fact_snapshots_no_update;
      DROP TRIGGER premarket_fact_snapshots_no_delete;
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE premarket_fact_snapshots RENAME TO premarket_fact_snapshots_v131;
      PRAGMA legacy_alter_table = OFF;

      CREATE TABLE premarket_fact_snapshots (
        id                    TEXT PRIMARY KEY CHECK (length(id) = 36),
        trade_date            TEXT NOT NULL
          CHECK (length(trade_date) = 8 AND trade_date NOT GLOB '*[^0-9]*'),
        stage                 TEXT NOT NULL
          CHECK (stage IN ('overnight', 'asia_open', 'auction_confirmed', 'after_close')),
        status                TEXT NOT NULL
          CHECK (status IN ('ready', 'partial', 'blocked', 'failed')),
        schema_version        INTEGER NOT NULL CHECK (schema_version = 1),
        rule_version          TEXT NOT NULL CHECK (length(trim(rule_version)) BETWEEN 1 AND 80),
        previous_revision_id  TEXT DEFAULT NULL REFERENCES premarket_fact_snapshots(id),
        revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        revision_kind         TEXT NOT NULL DEFAULT 'scheduled'
          CHECK (revision_kind IN ('scheduled', 'startup_catch_up', 'manual_backfill')),
        requested_at          INTEGER NOT NULL DEFAULT 1 CHECK (requested_at > 0),
        cutoff_at             INTEGER NOT NULL CHECK (cutoff_at > 0),
        captured_at           INTEGER NOT NULL CHECK (captured_at > 0),
        provider_id           TEXT NOT NULL CHECK (length(trim(provider_id)) BETWEEN 1 AND 80),
        facts_json            TEXT NOT NULL
          CHECK (json_valid(facts_json) AND json_type(facts_json) = 'object' AND length(facts_json) <= 131072),
        facts_sha256          TEXT NOT NULL CHECK (length(facts_sha256) = 64),
        sources_json          TEXT NOT NULL
          CHECK (json_valid(sources_json) AND json_type(sources_json) = 'array' AND length(sources_json) <= 32768),
        warnings_json         TEXT NOT NULL
          CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array' AND length(warnings_json) <= 32768),
        created_at            INTEGER NOT NULL CHECK (created_at > 0),
        UNIQUE (trade_date, stage, rule_version, revision),
        CHECK (revision > 1 OR previous_revision_id IS NULL)
      );
      INSERT INTO premarket_fact_snapshots (
        id, trade_date, stage, status, schema_version, rule_version,
        previous_revision_id, revision, revision_kind, requested_at,
        cutoff_at, captured_at, provider_id, facts_json, facts_sha256,
        sources_json, warnings_json, created_at
      )
      SELECT
        id, trade_date, stage, status, schema_version, rule_version,
        NULL, 1, 'scheduled', created_at,
        cutoff_at, captured_at, provider_id, facts_json, facts_sha256,
        sources_json, warnings_json, created_at
      FROM premarket_fact_snapshots_v131;
      DROP TABLE premarket_fact_snapshots_v131;

      CREATE INDEX idx_premarket_fact_snapshots_date_stage
        ON premarket_fact_snapshots(trade_date DESC, stage, revision DESC, created_at DESC);
      CREATE TRIGGER premarket_fact_snapshots_no_update
        BEFORE UPDATE ON premarket_fact_snapshots
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_FACT_SNAPSHOT_IMMUTABLE'); END;
      CREATE TRIGGER premarket_fact_snapshots_no_delete
        BEFORE DELETE ON premarket_fact_snapshots
        BEGIN SELECT RAISE(ABORT, 'PREMARKET_FACT_SNAPSHOT_IMMUTABLE'); END;
    `
  },
  {
    // FR-260: 应用内决策信号提醒与 Windows 原生通知独立开关
    version: 133,
    sql: `
      ALTER TABLE app_settings
        ADD COLUMN decision_notify_in_app_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (decision_notify_in_app_enabled IN (0, 1));
    `
  },
  {
    // Built-in source defaults remain upgradeable until the user saves local overrides.
    version: 134,
    sql: `
      CREATE TABLE built_in_source_state (
        source_id            INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
        seed_key             TEXT NOT NULL UNIQUE CHECK (length(trim(seed_key)) BETWEEN 1 AND 80),
        has_local_overrides  INTEGER NOT NULL DEFAULT 0
          CHECK (has_local_overrides IN (0, 1))
      );

      INSERT OR IGNORE INTO built_in_source_state (source_id, seed_key, has_local_overrides)
      SELECT
        id,
        CASE
          WHEN nameEN = 'CSRC' OR url LIKE '%csrc.gov.cn%' THEN 'csrc'
          WHEN nameEN = 'PBOC' OR url LIKE '%pbc.gov.cn%' THEN 'pboc'
          WHEN nameEN = 'NDRC' OR url LIKE '%ndrc.gov.cn%' THEN 'ndrc'
          WHEN nameEN = 'MOFCOM' OR url LIKE '%mofcom.gov.cn%' THEN 'mofcom'
          WHEN nameEN = 'NBS' OR url LIKE '%stats.gov.cn%' THEN 'nbs'
          WHEN nameEN = 'MOF' OR url LIKE '%mof.gov.cn%' THEN 'mof'
          WHEN nameEN = 'State Council' OR url LIKE '%gov.cn%' THEN 'state-council'
          WHEN nameEN = 'Xinhua Finance' OR url LIKE '%xinhuanet.com%' THEN 'xinhua-finance'
          WHEN nameEN = 'People''s Daily Finance' OR url LIKE '%people.com.cn%' THEN 'people-finance'
          WHEN nameEN = 'Financial News' OR url LIKE '%financialnews.com.cn%' THEN 'financial-news'
          WHEN nameEN = 'China Securities Journal' OR url LIKE '%cs.com.cn%' THEN 'csj'
          WHEN nameEN = 'Shanghai Securities News' OR url LIKE '%shobserver.com%' THEN 'ssn'
          WHEN nameEN = 'Securities Times' OR url LIKE '%stcn.com%' THEN 'stcn'
          WHEN nameEN = 'Caixin' OR url LIKE '%caixin.com%' THEN 'caixin'
          WHEN nameEN = '21st Century Business Herald' OR url LIKE '%21jingji.com%' THEN '21jingji'
        END,
        1
      FROM sources
      WHERE isBuiltIn = 1
        AND CASE
          WHEN nameEN = 'CSRC' OR url LIKE '%csrc.gov.cn%' THEN 'csrc'
          WHEN nameEN = 'PBOC' OR url LIKE '%pbc.gov.cn%' THEN 'pboc'
          WHEN nameEN = 'NDRC' OR url LIKE '%ndrc.gov.cn%' THEN 'ndrc'
          WHEN nameEN = 'MOFCOM' OR url LIKE '%mofcom.gov.cn%' THEN 'mofcom'
          WHEN nameEN = 'NBS' OR url LIKE '%stats.gov.cn%' THEN 'nbs'
          WHEN nameEN = 'MOF' OR url LIKE '%mof.gov.cn%' THEN 'mof'
          WHEN nameEN = 'State Council' OR url LIKE '%gov.cn%' THEN 'state-council'
          WHEN nameEN = 'Xinhua Finance' OR url LIKE '%xinhuanet.com%' THEN 'xinhua-finance'
          WHEN nameEN = 'People''s Daily Finance' OR url LIKE '%people.com.cn%' THEN 'people-finance'
          WHEN nameEN = 'Financial News' OR url LIKE '%financialnews.com.cn%' THEN 'financial-news'
          WHEN nameEN = 'China Securities Journal' OR url LIKE '%cs.com.cn%' THEN 'csj'
          WHEN nameEN = 'Shanghai Securities News' OR url LIKE '%shobserver.com%' THEN 'ssn'
          WHEN nameEN = 'Securities Times' OR url LIKE '%stcn.com%' THEN 'stcn'
          WHEN nameEN = 'Caixin' OR url LIKE '%caixin.com%' THEN 'caixin'
          WHEN nameEN = '21st Century Business Herald' OR url LIKE '%21jingji.com%' THEN '21jingji'
        END IS NOT NULL;

      UPDATE sources
      SET detailSelector = '.detail-content|.detail-content-wrapper|.video-content-left'
      WHERE id IN (
        SELECT source_id FROM built_in_source_state WHERE seed_key = 'stcn'
      )
        AND COALESCE(trim(detailSelector), '') IN (
          '',
          '.detail-content',
          '.detail-content|.video-content-left'
        );
    `
  }
]

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = MIGRATIONS

export function runMigrations(
  db: Database.Database,
  migrations: readonly DatabaseMigration[] = MIGRATIONS
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      appliedAt INTEGER NOT NULL
    )
  `)

  const applied = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as { version: number }[]
  const appliedVersions = new Set(applied.map((r) => r.version))
  const recordMigration = db.prepare(
    'INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)'
  )
  const applyMigration = db.transaction((migration: DatabaseMigration) => {
    db.exec(migration.sql)
    recordMigration.run(migration.version, Date.now())
  })

  const applyForeignKeyIsolatedMigration = (migration: DatabaseMigration): void => {
    const foreignKeysEnabled = Number(db.pragma('foreign_keys', { simple: true })) === 1
    db.pragma('foreign_keys = OFF')
    try {
      db.exec('BEGIN IMMEDIATE')
      db.exec(migration.sql)
      recordMigration.run(migration.version, Date.now())
      db.exec('COMMIT')
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK')
      throw error
    } finally {
      if (foreignKeysEnabled) db.pragma('foreign_keys = ON')
    }
  }

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      try {
        if (migration.isolateForeignKeys) applyForeignKeyIsolatedMigration(migration)
        else applyMigration(migration)
        console.log(`[DB] Applied migration ${migration.version}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Migration #${migration.version} 执行失败：${message}`, { cause: err })
      }
    }
  }
}
