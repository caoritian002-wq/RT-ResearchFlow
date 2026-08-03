-- Migration 001: Initial schema
-- Creates all core tables for the financial news monitor

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ──────────────────────────────────────────────────────────
-- sources: monitoring source registry
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  nameCN              TEXT    NOT NULL,
  nameEN              TEXT    NOT NULL,
  url                 TEXT    NOT NULL,
  feedUrl             TEXT,
  category            TEXT    NOT NULL CHECK (category IN ('REGULATOR','CENTRAL_BANK','GOVERNMENT','STATE_MEDIA','FINANCIAL_PRESS','CUSTOM')),
  authorityWeight     INTEGER NOT NULL DEFAULT 5 CHECK (authorityWeight BETWEEN 1 AND 10),
  isBuiltIn           INTEGER NOT NULL DEFAULT 1 CHECK (isBuiltIn IN (0,1)),
  isEnabled           INTEGER NOT NULL DEFAULT 1 CHECK (isEnabled IN (0,1)),
  status              TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','UNREACHABLE','DEGRADED','PARSE_FAILED','DISABLED')),
  lastScannedAt       INTEGER,
  successRate         REAL    NOT NULL DEFAULT 1.0,
  parseStrategy       TEXT    NOT NULL CHECK (parseStrategy IN ('RSS','ATOM','HTML_SCRAPE','API')),
  contentSelector     TEXT,
  financeSectionFilter TEXT
);

-- ──────────────────────────────────────────────────────────
-- scan_runs: audit log for each scanning operation
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scan_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  type                TEXT    NOT NULL CHECK (type IN ('SCHEDULED','MANUAL','CATCH_UP')),
  startedAt           INTEGER NOT NULL,
  completedAt         INTEGER,
  sourcesScanned      INTEGER NOT NULL DEFAULT 0,
  newBriefingsFound   INTEGER NOT NULL DEFAULT 0,
  errors              TEXT,   -- JSON array of error strings
  catchUpRangeStart   INTEGER,
  catchUpRangeEnd     INTEGER
);

-- ──────────────────────────────────────────────────────────
-- briefings: the news items collected from all sources
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS briefings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceId            INTEGER NOT NULL REFERENCES sources(id),
  sourceName          TEXT    NOT NULL,
  originalUrl         TEXT    NOT NULL,
  title               TEXT    NOT NULL,
  summary             TEXT    NOT NULL,
  fullContent         TEXT,
  publishedAt         INTEGER NOT NULL, -- UTC milliseconds
  publishedDateBJ     TEXT    NOT NULL, -- YYYY-MM-DD UTC+8
  collectedAt         INTEGER NOT NULL,
  impactRating        TEXT    NOT NULL CHECK (impactRating IN ('CRITICAL','IMPORTANT','GENERAL')),
  impactRatingScore   INTEGER NOT NULL DEFAULT 0,
  deduplicationHash   TEXT    NOT NULL UNIQUE,
  titleSimhash        TEXT    NOT NULL,
  isRead              INTEGER NOT NULL DEFAULT 0 CHECK (isRead IN (0,1)),
  readAt              INTEGER,
  scanRunId           INTEGER REFERENCES scan_runs(id),
  isCatchUp           INTEGER NOT NULL DEFAULT 0 CHECK (isCatchUp IN (0,1))
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_briefings_date      ON briefings(publishedDateBJ);
CREATE INDEX IF NOT EXISTS idx_briefings_source    ON briefings(sourceId);
CREATE INDEX IF NOT EXISTS idx_briefings_rating    ON briefings(impactRating);
CREATE INDEX IF NOT EXISTS idx_briefings_read      ON briefings(isRead);
CREATE INDEX IF NOT EXISTS idx_briefings_collected ON briefings(collectedAt);
CREATE INDEX IF NOT EXISTS idx_briefings_simhash   ON briefings(titleSimhash);

-- Full-text search virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS briefings_fts USING fts5(
  title,
  summary,
  content='briefings',
  content_rowid='id'
);

-- FTS sync triggers
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

-- ──────────────────────────────────────────────────────────
-- app_settings: singleton row for application configuration
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  scanIntervalMinutes   INTEGER NOT NULL DEFAULT 10 CHECK (scanIntervalMinutes IN (5,10,15,30,60)),
  retentionDays         INTEGER NOT NULL DEFAULT 30,
  catchUpMaxDays        INTEGER NOT NULL DEFAULT 7,
  lastSuccessfulScanAt  INTEGER,
  uiLanguage            TEXT    NOT NULL DEFAULT 'zh-CN'
);

-- Ensure singleton row exists
INSERT OR IGNORE INTO app_settings (id) VALUES (1);

-- ──────────────────────────────────────────────────────────
-- daily_archive: pre-aggregated counts per Beijing-time date
-- ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_archive (
  date         TEXT    PRIMARY KEY, -- YYYY-MM-DD
  totalCount   INTEGER NOT NULL DEFAULT 0,
  unreadCount  INTEGER NOT NULL DEFAULT 0,
  criticalCount INTEGER NOT NULL DEFAULT 0,
  updatedAt    INTEGER NOT NULL
);

-- schema_migrations: version tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  appliedAt   INTEGER NOT NULL
);
