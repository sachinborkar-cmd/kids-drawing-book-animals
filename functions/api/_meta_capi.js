/**
 * Meta Conversions API (CAPI) - Server-Side Event Tracking Module
 * Scope: Purchase Event Tracking & Deduplication for Kids Drawing Book
 * 
 * Deduplication Guarantee:
 * - CAPI event_id strictly matches the browser Meta Pixel eventID (the stable order ID, e.g. ord_UUID).
 * - D1 capi_events table provides durable atomic idempotency across concurrent webhooks and verify-payment calls.
 * - Access token is read exclusively from env.META_CAPI_ACCESS_TOKEN and never logged or exposed.
 */

export const META_PIXEL_ID_DEFAULT = '3370053963196277';
export const META_GRAPH_API_VERSION_DEFAULT = 'v26.0';

/**
 * Deterministically parses a timestamp into Unix epoch seconds with explicit UTC handling.
 * Accepts:
 * - integer or float Unix seconds (e.g. 1732103456)
 * - integer Unix milliseconds (e.g. 1732103456000)
 * - ISO-8601 strings (e.g. '2026-11-20T12:00:00.000Z')
 * - SQLite datetime strings (e.g. '2026-11-20 12:00:00') - explicitly treated as UTC ('Z')
 * Returns null if missing, invalid, or non-positive.
 */
export function parseUtcToUnixSeconds(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') {
    if (val > 1e11) {
      return Math.floor(val / 1000);
    }
    if (val > 0) {
      return Math.floor(val);
    }
    return null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    // Check if numeric string
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (num > 1e11) return Math.floor(num / 1000);
      if (num > 0) return Math.floor(num);
      return null;
    }
    // Handle SQLite datetime 'YYYY-MM-DD HH:MM:SS' or ISO strings
    let candidate = trimmed;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(candidate)) {
      candidate = candidate.replace(' ', 'T');
    }
    if (!candidate.endsWith('Z') && !/[+-]\d{2}:?\d{2}$/.test(candidate)) {
      candidate += 'Z';
    }
    const ms = Date.parse(candidate);
    if (!Number.isNaN(ms) && ms > 0) {
      return Math.floor(ms / 1000);
    }
  }
  return null;
}

/**
 * Standard SHA-256 hex hasher using Web Crypto API
 * Formats strings per Meta CAPI requirements (lowercase, trimmed)
 */
export async function sha256Hex(str) {
  if (typeof str !== 'string') return null;
  const normalized = str.trim().toLowerCase();
  if (!normalized) return null;

  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Normalizes phone numbers (digits only, e.g. 919876543210) before hashing
 */
export async function hashPhone(phone) {
  if (typeof phone !== 'string') return null;
  const digitsOnly = phone.replace(/\D/g, '');
  if (!digitsOnly || digitsOnly.length < 7) return null;
  return sha256Hex(digitsOnly);
}

/**
 * Extracts and hashes customer first and last names if available
 */
export async function hashCustomerNames(fullName) {
  if (typeof fullName !== 'string') return { fn: null, ln: null };
  const trimmed = fullName.trim();
  if (!trimmed) return { fn: null, ln: null };

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { fn: null, ln: null };

  const fn = await sha256Hex(parts[0]);
  const ln = parts.length > 1 ? await sha256Hex(parts.slice(1).join(' ')) : null;
  return { fn, ln };
}

/**
 * Builds the sanitized, standards-compliant Meta CAPI Purchase payload
 */
export async function buildCapiPurchasePayload(order, env, requestContext = {}) {
  const pixelId = (env.META_PIXEL_ID || META_PIXEL_ID_DEFAULT).trim();

  // 1. User Data (Hashed PII according to Meta requirements; zero secrets/tokens)
  const userData = {};

  if (order.customer_email && order.customer_email.includes('@')) {
    const hashedEmail = await sha256Hex(order.customer_email);
    if (hashedEmail) userData.em = [hashedEmail];
  }

  if (order.customer_phone) {
    const hashedPhone = await hashPhone(order.customer_phone);
    if (hashedPhone) userData.ph = [hashedPhone];
  }

  if (order.customer_name) {
    const { fn, ln } = await hashCustomerNames(order.customer_name);
    if (fn) userData.fn = [fn];
    if (ln) userData.ln = [ln];
  }

  if (requestContext.clientIp && typeof requestContext.clientIp === 'string') {
    userData.client_ip_address = requestContext.clientIp.trim();
  }

  if (requestContext.userAgent && typeof requestContext.userAgent === 'string') {
    userData.client_user_agent = requestContext.userAgent.trim();
  }

  // 2. Custom Data (Transaction and Product Metadata)
  const finalAmount = (typeof order.amount === 'number' && order.amount > 0)
    ? order.amount
    : parseInt(env.PRODUCT_PRICE || '1', 10);
  const finalCurrency = order.currency || env.PRODUCT_CURRENCY || 'INR';

  const customData = {
    value: finalAmount,
    currency: finalCurrency,
    content_name: 'Kids Drawing Book – Animals',
    content_category: 'Children Activity Books',
    content_ids: ['kids-drawing-book-animals'],
    content_type: 'product',
    num_items: 1,
    order_id: order.id
  };

  // 3. Event Time (Unix epoch seconds from verified payment capture timestamp)
  const rawPaidAt = order.paid_at || requestContext.paidAt || requestContext.paymentCreatedAt;
  const eventTime = parseUtcToUnixSeconds(rawPaidAt);
  if (!eventTime) {
    throw new Error(`Order ${order.id} is missing a valid payment capture timestamp (paid_at)`);
  }

  // 4. Source URL
  const sourceUrl = requestContext.sourceUrl || `https://ebooks.trenzy.store/thank-you/?order_id=${encodeURIComponent(order.id)}`;

  const eventObject = {
    event_name: 'Purchase',
    event_time: eventTime,
    event_id: order.id, // Strictly matches browser Pixel eventID
    action_source: 'website',
    event_source_url: sourceUrl,
    user_data: userData,
    custom_data: customData
  };

  const payload = {
    data: [eventObject]
  };

  // 5. Test Event Code (Preview / Testing support)
  const testEventCode = (env.META_TEST_EVENT_CODE || '').trim();
  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }

  return { pixelId, payload };
}

/**
 * Ensures capi_events table exists in D1 (defensive fallback)
 */
export async function ensureCapiEventsTable(db) {
  if (!db) return;
  try {
    await db.prepare(`
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
    `).run();
  } catch (err) {
    // Non-fatal if table already exists or permission restricted
  }
  try {
    await db.prepare(`ALTER TABLE orders ADD COLUMN paid_at TEXT;`).run();
  } catch (err) {
    // Column already exists or permission restricted - non-fatal
  }
}

/**
 * Sanitizes an error message so tokens or credentials can never leak
 */
export function sanitizeErrorMessage(err) {
  if (!err) return 'Unknown error';
  const msg = typeof err === 'string' ? err : (err.message || String(err));
  return msg
    .replace(/EA[A-Za-z0-9_-]{20,}/g, '[REDACTED_ACCESS_TOKEN]')
    .replace(/rzp_(test|live)_[A-Za-z0-9]{10,}/g, '[REDACTED_RZP_KEY]')
    .slice(0, 500);
}

/**
 * Dispatches an idempotent Meta Conversions API Purchase event for a verified paid order.
 * 
 * @param {string} orderId - Stored order ID (e.g. ord_UUID) or razorpay_order_id
 * @param {object} env - Cloudflare environment bindings
 * @param {object} requestContext - Context metadata (clientIp, userAgent, sourceUrl, customFetch, paidAt, paymentCreatedAt)
 * @returns {Promise<object>} Result status object
 */
export async function sendCapiPurchaseEvent(orderId, env, requestContext = {}) {
  if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
    return { success: false, status: 'invalid_order_id', error: 'Order ID is missing or invalid' };
  }
  const cleanOrderId = orderId.trim();

  // 1. Validate D1 database availability
  if (!env || !env.DB) {
    return { success: false, status: 'no_db', error: 'Cloudflare D1 database binding (env.DB) is not available' };
  }

  // Ensure table exists defensively
  await ensureCapiEventsTable(env.DB);

  // 2. Fetch order details from D1
  let order;
  try {
    order = await env.DB.prepare(`
      SELECT id, razorpay_order_id, razorpay_payment_id, customer_name, customer_email, customer_phone, amount, currency, status, created_at, paid_at
      FROM orders
      WHERE id = ? OR razorpay_order_id = ?
    `).bind(cleanOrderId, cleanOrderId).first();
  } catch (dbErr) {
    console.warn('[CAPI Dispatch]: Failed to query order from D1:', dbErr.message);
    return { success: false, status: 'db_error', error: sanitizeErrorMessage(dbErr) };
  }

  if (!order) {
    return { success: false, status: 'order_not_found', error: `Order not found for ID: ${cleanOrderId}` };
  }

  // 3. Strict Pre-Conditions: Order MUST be verified paid
  if (order.status !== 'paid') {
    return {
      success: false,
      status: 'order_not_paid',
      error: `Order ${order.id} status is '${order.status}' (not paid). CAPI Purchase event rejected.`
    };
  }

  // 4. Validate Amount and Currency
  if (typeof order.amount !== 'number' || order.amount <= 0) {
    return {
      success: false,
      status: 'invalid_amount',
      error: `Order ${order.id} amount is invalid: ${order.amount}`
    };
  }

  const expectedCurrency = (env.PRODUCT_CURRENCY || 'INR').toUpperCase();
  if ((order.currency || '').toUpperCase() !== expectedCurrency) {
    return {
      success: false,
      status: 'invalid_currency',
      error: `Order ${order.id} currency '${order.currency}' does not match expected '${expectedCurrency}'`
    };
  }

  // 5. Validate verified payment capture timestamp (paid_at)
  const rawPaidAt = order.paid_at || requestContext.paidAt || requestContext.paymentCreatedAt;
  const verifiedEventTime = parseUtcToUnixSeconds(rawPaidAt);
  if (!verifiedEventTime) {
    return {
      success: false,
      status: 'missing_paid_at',
      error: `Order ${order.id} is missing a valid payment capture timestamp (paid_at). CAPI Purchase event rejected.`
    };
  }

  const outboxId = `capi_${order.id}_Purchase`;

  // 5. Idempotency Check in capi_events
  try {
    const existingRecord = await env.DB.prepare(`
      SELECT id, status, attempts, last_attempt_at FROM capi_events
      WHERE order_id = ? AND event_name = 'Purchase'
    `).bind(order.id).first();

    if (existingRecord) {
      if (existingRecord.status === 'sent') {
        return { success: true, status: 'already_sent', message: 'CAPI Purchase event already successfully sent to Meta' };
      }
      if (existingRecord.status === 'sending') {
        const lastAttemptMs = existingRecord.last_attempt_at ? new Date(existingRecord.last_attempt_at).getTime() : 0;
        const isStale = lastAttemptMs > 0 && (Date.now() - lastAttemptMs > 5 * 60 * 1000);
        if (!isStale) {
          return { success: true, status: 'in_progress', message: 'CAPI Purchase event transmission is actively in progress' };
        }
      }
      if (existingRecord.attempts >= 3) {
        return { success: false, status: 'max_retries_exceeded', error: 'Maximum retry attempts (3) exceeded for CAPI event' };
      }
    } else {
      // Insert initial pending record
      try {
        await env.DB.prepare(`
          INSERT INTO capi_events (id, order_id, event_name, status, attempts, meta_event_id)
          VALUES (?, ?, 'Purchase', 'pending', 0, ?)
        `).bind(outboxId, order.id, order.id).run();
      } catch {
        // Handled if parallel request inserted simultaneously
      }
    }
  } catch (outboxQueryErr) {
    console.warn('[CAPI Idempotency Query Warning]:', outboxQueryErr.message);
  }

  // 6. Atomically acquire sending lock
  try {
    const lockResult = await env.DB.prepare(`
      UPDATE capi_events
      SET status = 'sending',
          attempts = attempts + 1,
          last_attempt_at = datetime('now'),
          updated_at = datetime('now')
      WHERE order_id = ? AND event_name = 'Purchase'
        AND (
          status = 'pending'
          OR status = 'failed'
          OR (status = 'sending' AND last_attempt_at < datetime('now', '-5 minutes'))
        )
        AND attempts < 3
    `).bind(order.id).run();

    if (!lockResult.meta || lockResult.meta.changes === 0) {
      return { success: true, status: 'lock_not_acquired', message: 'Another worker acquired the CAPI event lock or already completed' };
    }
  } catch (lockErr) {
    console.warn('[CAPI Lock Acquisition Error]:', lockErr.message);
    return { success: false, status: 'lock_error', error: sanitizeErrorMessage(lockErr) };
  }

  // 7. Verify META_CAPI_ACCESS_TOKEN availability
  const accessToken = typeof env.META_CAPI_ACCESS_TOKEN === 'string' ? env.META_CAPI_ACCESS_TOKEN.trim() : '';
  if (!accessToken) {
    const missingTokenMsg = 'META_CAPI_ACCESS_TOKEN secret is not configured in environment';
    try {
      await env.DB.prepare(`
        UPDATE capi_events
        SET status = 'failed',
            error_message = ?,
            updated_at = datetime('now')
        WHERE order_id = ? AND event_name = 'Purchase'
      `).bind(missingTokenMsg, order.id).run();
    } catch {}
    return { success: false, status: 'missing_token', error: missingTokenMsg };
  }

  // 8. Build CAPI Payload
  const { pixelId, payload } = await buildCapiPurchasePayload(order, env, requestContext);
  const apiVersion = (env.META_CAPI_API_VERSION || META_GRAPH_API_VERSION_DEFAULT).trim();
  const endpoint = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pixelId)}/events`;

  // 9. Dispatch to Meta Graph API
  const fetchImpl = requestContext.customFetch || fetch;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });

    const responseBody = await response.json().catch(() => ({}));

    if (!response.ok) {
      const metaErrMsg = responseBody?.error?.message || `HTTP ${response.status} ${response.statusText}`;
      const sanitizedErr = sanitizeErrorMessage(metaErrMsg);

      await env.DB.prepare(`
        UPDATE capi_events
        SET status = 'failed',
            error_message = ?,
            fbtrace_id = ?,
            updated_at = datetime('now')
        WHERE order_id = ? AND event_name = 'Purchase'
      `).bind(sanitizedErr, responseBody?.error?.fbtrace_id || null, order.id).run();

      return {
        success: false,
        status: 'meta_api_error',
        error: sanitizedErr,
        fbtrace_id: responseBody?.error?.fbtrace_id
      };
    }

    // Success response: Meta returns { events_received: 1, fbtrace_id: '...' }
    const fbtraceId = responseBody?.fbtrace_id || null;
    await env.DB.prepare(`
      UPDATE capi_events
      SET status = 'sent',
          sent_at = datetime('now'),
          fbtrace_id = ?,
          error_message = NULL,
          updated_at = datetime('now')
      WHERE order_id = ? AND event_name = 'Purchase'
    `).bind(fbtraceId, order.id).run();

    return {
      success: true,
      status: 'sent',
      events_received: responseBody?.events_received || 1,
      fbtrace_id: fbtraceId,
      event_id: order.id
    };

  } catch (networkErr) {
    const sanitizedNetErr = sanitizeErrorMessage(networkErr);
    try {
      await env.DB.prepare(`
        UPDATE capi_events
        SET status = 'failed',
            error_message = ?,
            updated_at = datetime('now')
        WHERE order_id = ? AND event_name = 'Purchase'
      `).bind(sanitizedNetErr, order.id).run();
    } catch {}

    return {
      success: false,
      status: 'network_error',
      error: sanitizedNetErr
    };
  }
}
