import { processOrderEmail, isPositivelyVerifiedPreview } from './_email.js';

/**
 * Supported test email type for this staging endpoint.
 * Strictly restricted to 'staging_compressed_test'. All other types are rejected.
 */
const ALLOWED_TEST_EMAIL_TYPE = 'staging_compressed_test';

/**
 * POST /api/test-email
 * Staging-only controlled test endpoint for verifying post-purchase email delivery.
 * Requires authorized order_id AND valid download_token.
 * Strictly disabled in production and any unverified environment (fail-closed).
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. Fail-closed staging/preview gate: Strictly require positive Preview verification
  if (!isPositivelyVerifiedPreview(env)) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Endpoint strictly disabled. Environment is not a positively verified staging or preview environment.'
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    let orderId = null;
    let token = null;
    let rawEmailType = null;
    let clientPreviewToken = null;

    // Support both URL query params and JSON body
    const url = new URL(request.url);
    orderId = url.searchParams.get('order_id');
    token = url.searchParams.get('token');
    rawEmailType = url.searchParams.get('email_type');
    clientPreviewToken = url.searchParams.get('preview_token') || (request.headers && typeof request.headers.get === 'function' ? request.headers.get('x-preview-token') : null);

    let body = {};
    if (request.method !== 'GET' && (!orderId || !token || !rawEmailType || !clientPreviewToken)) {
      body = await request.json().catch(() => ({}));
      orderId = orderId || body.order_id;
      token = token || body.token;
      rawEmailType = rawEmailType || body.email_type;
      clientPreviewToken = clientPreviewToken || body.preview_token;
    }

    // 2. Strict authorization gate
    if (!orderId || !token) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized. Valid order_id and verification token are required.'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2b. Optional client preview secret check: If client supplies a preview_token, it must match env.STAGING_PREVIEW_TOKEN
    if (clientPreviewToken && clientPreviewToken !== env.STAGING_PREVIEW_TOKEN) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized. Incorrect Preview secret.'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Restrict endpoint strictly to 'staging_compressed_test'. Reject 'purchase_delivery' and all other types with HTTP 400.
    const emailType = (typeof rawEmailType === 'string' && rawEmailType.trim())
      ? rawEmailType.trim()
      : ALLOWED_TEST_EMAIL_TYPE;

    if (emailType !== ALLOWED_TEST_EMAIL_TYPE) {
      return new Response(JSON.stringify({
        success: false,
        error: `Invalid test email type '${emailType}'. The test endpoint is strictly restricted to '${ALLOWED_TEST_EMAIL_TYPE}'. 'purchase_delivery' and arbitrary types are rejected.`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!env.DB) {
      return new Response(JSON.stringify({ success: false, error: 'Database binding missing.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 4. Verify order exists and is paid in D1
    const order = await env.DB.prepare(`
      SELECT id, status, customer_email, download_token
      FROM orders
      WHERE (id = ? OR razorpay_order_id = ?) AND download_token = ?
    `).bind(orderId, orderId, token).first();

    if (!order) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Order not found or invalid token.'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (order.status !== 'paid') {
      return new Response(JSON.stringify({
        success: false,
        error: `Order status is '${order.status}'. Email delivery is only permitted for paid orders.`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 5. Trigger controlled email processing with selected emailType and controlled test authorization
    const result = await processOrderEmail(order.id, env, { emailType, isControlledTest: true });

    // 6. Query outbox status for selected emailType (preserving existing purchase_delivery record)
    const outbox = await env.DB.prepare(`
      SELECT id, status, attempts, last_attempt_at, sent_at, error_message
      FROM email_outbox
      WHERE order_id = ? AND email_type = ?
    `).bind(order.id, emailType).first();

    return new Response(JSON.stringify({
      success: result.success,
      status: result.status,
      order_id: order.id,
      email_type: emailType,
      recipient: order.customer_email,
      outbox: outbox || null,
      error: result.error || null
    }), {
      status: result.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[Test Email Handler Error]:', err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * GET /api/test-email (For browser-based staging verification)
 */
export async function onRequestGet(context) {
  return onRequestPost(context);
}
