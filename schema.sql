-- Cloudflare D1 Database Schema for Kids Drawing Book E-Book Sales
-- Table: orders
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  razorpay_order_id TEXT UNIQUE NOT NULL,
  razorpay_payment_id TEXT,
  razorpay_signature TEXT,
  customer_name TEXT,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'created', -- 'created', 'paid', 'failed'
  download_token TEXT UNIQUE,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_id ON orders(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_token ON orders(download_token) WHERE download_token IS NOT NULL;

-- Table: webhook_logs (For Idempotency & Audit)
CREATE TABLE IF NOT EXISTS webhook_logs (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  order_id TEXT,
  payment_id TEXT,
  payload TEXT,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Table: email_outbox (For Asynchronous Post-Purchase Delivery & Idempotency)
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  email_type TEXT NOT NULL DEFAULT 'purchase_delivery',
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'sent', 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  sent_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id, email_type)
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status);
CREATE INDEX IF NOT EXISTS idx_email_outbox_order ON email_outbox(order_id);
