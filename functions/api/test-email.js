import { processOrderEmail } from './_email.js';

/**
 * POST /api/test-email
 * Staging-only controlled test endpoint for verifying post-purchase email delivery.
 * Requires authorized order_id AND valid download_token.
 * Strictly disabled in production.
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. Strictly disabled in Production
  if (env.ENVIRONMENT === 'production' || env.NODE_ENV === 'production') {
    return new Response(JSON.stringify({ success: false, error: 'Endpoint strictly disabled in production.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    let orderId = null;
    let token = null;

    // Support both JSON body and URL query params
    const url = new URL(request.url);
    orderId = url.searchParams.get('order_id');
    token = url.searchParams.get('token');

    if (!orderId || !token) {
      const body = await request.json().catch(() => ({}));
      orderId = orderId || body.order_id;
      token = token || body.token;
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

    if (!env.DB) {
      return new Response(JSON.stringify({ success: false, error: 'Database binding missing.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3. Verify order exists and is paid in D1
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

    // 4. Trigger controlled email processing
    const result = await processOrderEmail(order.id, env);

    // 5. Query outbox status for full audit response
    const outbox = await env.DB.prepare(`
      SELECT id, status, attempts, last_attempt_at, sent_at, error_message
      FROM email_outbox
      WHERE order_id = ? AND email_type = 'purchase_delivery'
    `).bind(order.id).first();

    return new Response(JSON.stringify({
      success: result.success,
      status: result.status,
      order_id: order.id,
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
