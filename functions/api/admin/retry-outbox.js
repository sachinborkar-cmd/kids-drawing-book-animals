import { processOrderEmail } from '../_email.js';

/**
 * Target order explicitly authorized for this single-purpose emergency retry.
 * Any other order ID is strictly rejected.
 */
const AUTHORIZED_TARGET_ORDER_ID = 'ord_1794804630315';
const EXPECTED_OUTBOX_ID = 'out_ord_1794804630315_purchase_delivery';

/**
 * Constant-time byte-by-byte comparison to mitigate timing attacks on secret comparison.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const aBuf = enc.encode(a);
  const bBuf = enc.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}

/**
 * POST /api/admin/retry-outbox
 * 
 * TEMPORARY RESTRICTED ADMINISTRATIVE RETRY ENDPOINT
 * Exclusively permits retrying the failed post-purchase email for order ord_1794804630315.
 * Fails closed if not authenticated by encrypted ADMIN_API_KEY via Bearer token.
 * Once verified and successfully dispatched, this file must be deleted.
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1. Fail closed if admin secret is not configured
    const adminKeySecret = typeof env.ADMIN_API_KEY === 'string' ? env.ADMIN_API_KEY.trim() : '';
    if (!adminKeySecret || adminKeySecret.length < 32) {
      console.error('[Admin Retry Outbox]: ADMIN_API_KEY not configured or insufficient entropy.');
      return new Response(JSON.stringify({
        success: false,
        error: 'Administrative interface unavailable. Security secret not configured.'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Security Correction 2: Validate Authorization header securely (Bearer token only; X-Admin-Key removed)
    const authHeader = (request.headers && typeof request.headers.get === 'function')
      ? (request.headers.get('Authorization') || '')
      : '';
    
    if (!authHeader.startsWith('Bearer ')) {
      console.warn('[Admin Retry Outbox]: Missing or malformed Bearer authorization header.');
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized. Bearer token required in Authorization header.'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const providedKey = authHeader.slice(7).trim();
    if (!providedKey || !timingSafeEqual(providedKey, adminKeySecret)) {
      console.warn('[Admin Retry Outbox]: Unauthorized access attempt with invalid Bearer token.');
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized. Invalid administrative credentials.'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Security Correction 4: Parse request payload with strict malformed JSON handling
    let body = {};
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({
        success: false,
        error: 'Malformed request. Valid JSON body required.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request body. A JSON object is required.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { order_id } = body;

    // 4. Security Correction 1 & 4: Strictly validate order_id as a string, check missing/numeric, and enforce exact match
    if (order_id === undefined || order_id === null) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing order_id parameter in request body.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (typeof order_id !== 'string') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid order_id format. A string value is strictly required.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const trimmedOrderId = order_id.trim();
    if (!trimmedOrderId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'order_id cannot be blank. A valid order ID is required.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (trimmedOrderId !== AUTHORIZED_TARGET_ORDER_ID) {
      return new Response(JSON.stringify({
        success: false,
        error: `Unauthorized order ID. This endpoint is strictly restricted to order '${AUTHORIZED_TARGET_ORDER_ID}'. General-purpose retry is disallowed.`
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!env || !env.DB) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Database binding unavailable.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 5. Requirement 4: Verify the order exists and is paid in D1
    const order = await env.DB.prepare(`
      SELECT id, status, customer_email, download_token
      FROM orders
      WHERE id = ?
    `).bind(AUTHORIZED_TARGET_ORDER_ID).first();

    if (!order) {
      return new Response(JSON.stringify({
        success: false,
        error: `Order '${AUTHORIZED_TARGET_ORDER_ID}' not found.`
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (order.status !== 'paid') {
      return new Response(JSON.stringify({
        success: false,
        error: `Order status is '${order.status}' (not paid). Email delivery requires confirmed payment.`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 6. Requirement 5, 7, 9, 10: Verify the existing outbox record exists, is 'failed', and attempts < 3
    const outboxRecord = await env.DB.prepare(`
      SELECT id, order_id, recipient_email, status, attempts
      FROM email_outbox
      WHERE id = ? AND order_id = ? AND email_type = 'purchase_delivery'
    `).bind(EXPECTED_OUTBOX_ID, AUTHORIZED_TARGET_ORDER_ID).first();

    if (!outboxRecord) {
      return new Response(JSON.stringify({
        success: false,
        error: `Existing outbox record '${EXPECTED_OUTBOX_ID}' not found. Creation of new outbox records is prohibited.`
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (outboxRecord.status === 'sent') {
      return new Response(JSON.stringify({
        success: false,
        status: 'already_sent',
        error: 'Email has already been successfully delivered. Duplicate email delivery is permanently prohibited.'
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (outboxRecord.status !== 'failed') {
      return new Response(JSON.stringify({
        success: false,
        error: `Outbox record status is '${outboxRecord.status}'. Only failed records are eligible for administrative retry.`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (outboxRecord.attempts >= 3) {
      return new Response(JSON.stringify({
        success: false,
        error: `Maximum retry attempts (${outboxRecord.attempts}/3) reached. Manual investigation required.`
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 7. Requirement 6, 8, 11: Call processOrderEmail() to execute retry with genuine S3 PDF attachment
    const attemptNumber = outboxRecord.attempts + 1;
    console.info(`[Admin Retry Outbox]: Initiating authorized retry for order ${AUTHORIZED_TARGET_ORDER_ID} (Attempt ${attemptNumber})...`);
    
    const sendResult = await processOrderEmail(AUTHORIZED_TARGET_ORDER_ID, env, {
      emailType: 'purchase_delivery'
    });

    // Security Correction 3: Handle concurrent requests gracefully
    if (sendResult.status === 'lock_not_acquired' || sendResult.status === 'in_progress') {
      console.warn(`[Admin Retry Outbox]: Lock not acquired for order ${AUTHORIZED_TARGET_ORDER_ID}. Another worker is processing.`);
      return new Response(JSON.stringify({
        success: false,
        order_id: AUTHORIZED_TARGET_ORDER_ID,
        status: sendResult.status,
        error: 'Email retry is already actively in progress by another request. Concurrent duplicate delivery locked out.'
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (sendResult.success && sendResult.status === 'sent') {
      console.info(`[Admin Retry Outbox]: Retry succeeded for order ${AUTHORIZED_TARGET_ORDER_ID}.`);
      return new Response(JSON.stringify({
        success: true,
        order_id: AUTHORIZED_TARGET_ORDER_ID,
        status: 'sent',
        attempts: attemptNumber,
        message: 'Purchase confirmation email and PDF attachment successfully dispatched.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      console.error(`[Admin Retry Outbox]: Retry failed for order ${AUTHORIZED_TARGET_ORDER_ID}:`, sendResult.error || sendResult.status);
      return new Response(JSON.stringify({
        success: false,
        order_id: AUTHORIZED_TARGET_ORDER_ID,
        status: sendResult.status,
        error: sendResult.error || 'SMTP delivery attempt failed. Check outbox error log.'
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (fatalErr) {
    console.error('[Admin Retry Outbox Fatal Error]:', fatalErr.message);
    return new Response(JSON.stringify({
      success: false,
      error: 'An internal error occurred during the administrative retry operation.'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
