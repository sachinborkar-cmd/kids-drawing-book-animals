/**
 * POST /api/razorpay-webhook
 * Independently validates asynchronous payment notifications from Razorpay
 * Includes idempotency via webhook_logs table to prevent duplicate processing
 */
export async function onRequestPost({ request, env }) {
  try {
    // 1. Fail closed if webhook secret is not configured
    const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[Razorpay Webhook]: RAZORPAY_WEBHOOK_SECRET is not configured.');
      return new Response(JSON.stringify({ error: 'Webhook secret not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2. Fail closed if signature header is missing
    const signature = request.headers?.get ? request.headers.get('x-razorpay-signature') : null;
    if (!signature) {
      console.error('[Razorpay Webhook]: Missing x-razorpay-signature header.');
      return new Response(JSON.stringify({ error: 'Missing webhook signature header' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Read exact raw request body for HMAC verification
    const rawBody = await request.text();

    // 3. Cryptographically verify signature using HMAC-SHA256
    const keyObj = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const computed = await crypto.subtle.sign('HMAC', keyObj, new TextEncoder().encode(rawBody));
    const expected = Array.from(new Uint8Array(computed)).map(b => b.toString(16).padStart(2, '0')).join('');

    // Constant-time comparison to prevent timing attacks
    const sigLower = signature.toLowerCase().trim();
    const expLower = expected.toLowerCase().trim();
    let diff = 0;
    if (sigLower.length !== expLower.length) {
      diff = 1;
    } else {
      for (let i = 0; i < expLower.length; i++) {
        diff |= sigLower.charCodeAt(i) ^ expLower.charCodeAt(i);
      }
    }

    if (diff !== 0) {
      console.error('[Razorpay Webhook]: Signature mismatch.');
      return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (parseErr) {
      console.error('[Razorpay Webhook]: Malformed JSON payload:', parseErr.message);
      return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const eventId = event.event_id || event.id || `evt_${Date.now()}`;
    const eventType = event.event;

    // Idempotency check with Cloudflare D1
    if (env.DB) {
      try {
        const existing = await env.DB.prepare(`
          SELECT event_id FROM webhook_logs WHERE event_id = ?
        `).bind(eventId).first();

        if (existing) {
          console.info(`[Razorpay Webhook]: Event ${eventId} already processed. Skipping.`);
          return new Response(JSON.stringify({ status: 'already_processed' }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (e) {
        console.warn('[D1 Idempotency Check Warning]:', e.message);
      }
    }

    // Process payment events
    const paymentEntity = event.payload?.payment?.entity;
    const orderId = paymentEntity?.order_id;
    const paymentId = paymentEntity?.id;

    if (eventType === 'payment.captured' || eventType === 'order.paid') {
      if (orderId && env.DB) {
        // Ensure order is marked paid and has a download token
        const tokenBytes = new Uint8Array(24);
        crypto.getRandomValues(tokenBytes);
        const downloadToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

        await env.DB.prepare(`
          UPDATE orders
          SET status = 'paid',
              razorpay_payment_id = COALESCE(razorpay_payment_id, ?),
              download_token = COALESCE(download_token, ?),
              updated_at = datetime('now')
          WHERE razorpay_order_id = ?
        `).bind(paymentId || '', downloadToken, orderId).run();
      }
    } else if (eventType === 'payment.failed') {
      if (orderId && env.DB) {
        await env.DB.prepare(`
          UPDATE orders
          SET status = 'failed',
              updated_at = datetime('now')
          WHERE razorpay_order_id = ?
        `).bind(orderId).run();
      }
    }

    // Record in webhook_logs for idempotency & audit trail
    if (env.DB) {
      try {
        await env.DB.prepare(`
          INSERT INTO webhook_logs (event_id, event_type, order_id, payment_id, payload)
          VALUES (?, ?, ?, ?, ?)
        `).bind(eventId, eventType, orderId || '', paymentId || '', rawBody.slice(0, 1000)).run();
      } catch (logErr) {
        console.warn('[D1 Webhook Log Warning]:', logErr.message);
      }
    }

    return new Response(JSON.stringify({ status: 'success' }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[Razorpay Webhook Handler Error]:', err);
    return new Response(JSON.stringify({ status: 'error', message: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
