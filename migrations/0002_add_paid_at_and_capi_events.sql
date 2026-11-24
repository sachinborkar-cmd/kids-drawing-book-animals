-- ====================================================================
-- Migration: 0002_add_paid_at_and_capi_events.sql
-- Project: Trenzy Store – Kids Drawing Book Animals
-- Target Database: kids-drawing-book-db (7cba95dc-6955-4e16-9973-5d912c1c1a16)
-- Compatibility: SQLite 3.16+ / Cloudflare D1
-- Safety: Strictly additive. Non-destructive $O(1)$ operations.
-- Preflight requirement: Verify columns with pragma_table_info('orders')
-- ====================================================================

-- 1. Extend orders table with payment capture timestamp tracking
ALTER TABLE orders ADD COLUMN paid_at TEXT;
ALTER TABLE orders ADD COLUMN paid_at_source TEXT;

-- 2. Create capi_events table for atomic deduplication and delivery audit trail
CREATE TABLE IF NOT EXISTS capi_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  event_name TEXT NOT NULL DEFAULT 'Purchase',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  sent_at TEXT,
  meta_event_id TEXT,
  fbtrace_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id, event_name)
);

-- 3. Create performance indexes
CREATE INDEX IF NOT EXISTS idx_capi_events_status ON capi_events(status);
CREATE INDEX IF NOT EXISTS idx_capi_events_order ON capi_events(order_id);
