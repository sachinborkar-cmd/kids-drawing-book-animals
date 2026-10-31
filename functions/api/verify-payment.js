import { verifyRazorpaySignature } from './_aws_s3.js';

/**
 * POST /api/verify-payment
 * Verifies Razorpay HMAC signature, marks order paid in D1, and generates download token
 */
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = body;

    if (!razorpay_order_id || !razorpay_payment_id) {
      return new Response(JSON.stringify({ success: false, error: 'Missing payment verification parameters.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const keySecret = env.RAZORPAY_KEY_SECRET;
    let isSignatureValid = false;

    if (keySecret) {
      isSignatureValid = await verifyRazorpaySignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        keySecret
      );
    } else {
      // In production, missing secret must strictly fail
      if (env.ENVIRONMENT === 'production' || env.NODE_ENV === 'production') {
        return new Response(JSON.stringify({ success: false, error: 'Payment gateway secret not configured in production.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // In local development test mode with placeholder keys, allow test mock
      console.warn('[Payment Verify]: Running without RAZORPAY_KEY_SECRET. Development test mode active.');
      isSignatureValid = true;
    }

    if (!isSignatureValid) {
      console.error('[Payment Verification Failed]: Invalid signature for order', razorpay_order_id);
      return new Response(JSON.stringify({ success: false, verified: false, error: 'Invalid payment signature.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Generate secure random download token (32 bytes hex)
    const tokenBytes = new Uint8Array(24);
    crypto.getRandomValues(tokenBytes);
    const downloadToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const targetOrderId = order_id || razorpay_order_id;

    // Update D1 Database
    if (env.DB) {
      try {
        await env.DB.prepare(`
          UPDATE orders
          SET status = 'paid',
              razorpay_payment_id = ?,
              razorpay_signature = ?,
              download_token = ?,
              updated_at = datetime('now')
          WHERE razorpay_order_id = ? OR id = ?
        `).bind(razorpay_payment_id, razorpay_signature || '', downloadToken, razorpay_order_id, targetOrderId).run();
      } catch (dbErr) {
        console.error('[D1 Verify Update Error]:', dbErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      verified: true,
      order_id: targetOrderId,
      download_token: downloadToken,
      redirect_url: `/thank-you/?order_id=${encodeURIComponent(targetOrderId)}&token=${encodeURIComponent(downloadToken)}`
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[Verify Payment Fatal Error]:', err);
    return new Response(JSON.stringify({ success: false, error: 'Internal error during payment verification.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
