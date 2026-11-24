import { verifyRazorpaySignature } from './_aws_s3.js';
import { processOrderEmail, classifyEmailEnvironment } from './_email.js';
import { sendCapiPurchaseEvent } from './_meta_capi.js';

/**
 * POST /api/verify-payment
 * Verifies Razorpay HMAC signature, marks order paid in D1, and generates download token
 */
export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  try {
    const body = await request.json().catch(() => ({}));
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = body;

    if (!razorpay_order_id || !razorpay_payment_id) {
      return new Response(JSON.stringify({ success: false, error: 'Missing payment verification parameters.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const rawKeyId = typeof env.RAZORPAY_KEY_ID === 'string' ? env.RAZORPAY_KEY_ID.trim() : '';
    const rawKeySecret = typeof env.RAZORPAY_KEY_SECRET === 'string' ? env.RAZORPAY_KEY_SECRET.trim() : '';
    const isPlaceholder = !rawKeyId || rawKeyId.includes('placeholder');

    const envName = (typeof env.ENVIRONMENT === 'string' ? env.ENVIRONMENT : '').trim().toLowerCase();
    const nodeEnv = (typeof env.NODE_ENV === 'string' ? env.NODE_ENV : '').trim().toLowerCase();
    const pagesBranch = (typeof env.CF_PAGES_BRANCH === 'string' ? env.CF_PAGES_BRANCH : '').trim().toLowerCase();
    const testTargetEnv = (typeof env.TEST_TARGET_ENV === 'string' ? env.TEST_TARGET_ENV : '').trim().toLowerCase();

    const isProd = pagesBranch === 'main' || pagesBranch === 'master' || envName === 'production' || nodeEnv === 'production' || testTargetEnv === 'production';
    const isPreview = pagesBranch === 'staging' || envName === 'staging' || envName === 'preview' || nodeEnv === 'staging' || testTargetEnv === 'staging';

    let isSignatureValid = false;

    if (rawKeySecret) {
      isSignatureValid = await verifyRazorpaySignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        rawKeySecret
      );
    } else {
      // In production or preview environments, missing secret must strictly fail closed
      if (isProd || isPreview) {
        return new Response(JSON.stringify({ success: false, error: 'Payment gateway secret not configured in production.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // In local development test mode, allow mock only if explicitly enabled
      const allowLocalMock = env.ALLOW_LOCAL_MOCK === true || env.ALLOW_LOCAL_MOCK === 'true' || nodeEnv === 'development';
      if (allowLocalMock) {
        console.warn('[Payment Verify]: Running without RAZORPAY_KEY_SECRET. Development test mode active.');
        isSignatureValid = true;
      } else {
        return new Response(JSON.stringify({ success: false, error: 'Payment gateway secret not configured.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (!isSignatureValid) {
      console.error('[Payment Verification Failed]: Invalid signature for order', razorpay_order_id);
      return new Response(JSON.stringify({ success: false, verified: false, error: 'Invalid payment signature.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const targetOrderId = order_id || razorpay_order_id;
    let existingOrder = null;

    // Check existing order in Cloudflare D1
    if (env.DB) {
      try {
        existingOrder = await env.DB.prepare(`
          SELECT id, razorpay_order_id, customer_email, amount, currency, status, download_token, paid_at, paid_at_source
          FROM orders
          WHERE id = ? OR razorpay_order_id = ?
        `).bind(targetOrderId, razorpay_order_id).first();
      } catch (dbErr) {
        console.warn('[D1 Order Query Warning]:', dbErr.message);
      }
    }

    // 1. Order ID matching check & existing paid order token preservation
    if (existingOrder) {
      if (existingOrder.razorpay_order_id && existingOrder.razorpay_order_id !== razorpay_order_id) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Order ID mismatch.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Idempotency: If already paid, preserve existing download token (unaffected by subsequent price changes)
      if (existingOrder.status === 'paid' && existingOrder.download_token) {
        // Trigger idempotent CAPI check in case previous attempt failed or webhook arrived first
        const earlyCapiContext = {
          clientIp: request.headers?.get ? (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')) : null,
          userAgent: request.headers?.get ? request.headers.get('user-agent') : null,
          sourceUrl: `https://${(request.headers?.get ? request.headers.get('host') : null) || 'ebooks.trenzy.store'}/thank-you/?order_id=${encodeURIComponent(existingOrder.id)}`,
          paidAt: existingOrder.paid_at,
          paidAtSource: existingOrder.paid_at_source || 'verify_approx',
          customFetch: env.customFetch
        };
        const earlyCapiPromise = sendCapiPurchaseEvent(existingOrder.id, env, earlyCapiContext);
        if (typeof waitUntil === 'function') {
          waitUntil(earlyCapiPromise);
        } else if (typeof context !== 'undefined' && context && typeof context.waitUntil === 'function') {
          context.waitUntil(earlyCapiPromise);
        }

        return new Response(JSON.stringify({
          success: true,
          verified: true,
          order_id: existingOrder.id,
          download_token: existingOrder.download_token,
          redirect_url: `/thank-you/?order_id=${encodeURIComponent(existingOrder.id)}&token=${encodeURIComponent(existingOrder.download_token)}`
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 2. Amount and currency check against stored D1 order
      const expectedPrice = parseInt(env.PRODUCT_PRICE || '149', 10);
      const expectedCurrency = env.PRODUCT_CURRENCY || 'INR';

      if (existingOrder.amount && existingOrder.amount !== expectedPrice) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment amount mismatch.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (existingOrder.currency && existingOrder.currency !== expectedCurrency) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment currency mismatch.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 4. Independent Razorpay API verification of captured payment status
    let paymentData = null;
    if (rawKeySecret && rawKeyId && !isPlaceholder) {
      let rzpPaymentRes;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8-second safety timeout

        const basicAuth = btoa(`${rawKeyId}:${rawKeySecret}`);
        rzpPaymentRes = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpay_payment_id)}`, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Content-Type': 'application/json'
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
      } catch (fetchErr) {
        console.error('[Razorpay Payment Fetch Error]:', fetchErr.message);
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          status: 'gateway_timeout',
          error: 'Unable to verify payment status with gateway. Please wait a moment and refresh.'
        }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (!rzpPaymentRes.ok) {
        const errText = await rzpPaymentRes.text();
        console.error('[Razorpay Payment API Error]:', rzpPaymentRes.status, errText);
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          status: 'gateway_error',
          error: 'Payment gateway status inquiry failed. Please contact support if debited.'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        paymentData = await rzpPaymentRes.json();
      } catch (jsonErr) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Invalid response from payment gateway.'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify payment ID matches
      if (paymentData.id !== razorpay_payment_id) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment ID mismatch from gateway.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify Razorpay order ID matches
      if (paymentData.order_id !== razorpay_order_id) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment order ID mismatch from gateway.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify amount matches expected configured amount in paise (e.g. 100 paise = 1 INR)
      const expectedAmountPaise = parseInt(env.PRODUCT_PRICE || '149', 10) * 100;
      if (paymentData.amount !== expectedAmountPaise) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment amount mismatch from gateway.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify currency is INR
      const expectedCurrency = env.PRODUCT_CURRENCY || 'INR';
      if (paymentData.currency !== expectedCurrency) {
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          error: 'Payment currency mismatch from gateway.'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify payment status is strictly 'captured'
      if (paymentData.status !== 'captured') {
        console.warn(`[Payment Verification Non-Captured]: status is '${paymentData.status}' for payment ${razorpay_payment_id}`);
        if (paymentData.status === 'authorized' || paymentData.status === 'pending') {
          return new Response(JSON.stringify({
            success: false,
            verified: false,
            status: paymentData.status,
            error: 'Payment capture is pending. Please wait a moment and refresh.'
          }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({
          success: false,
          verified: false,
          status: paymentData.status,
          error: `Payment status is '${paymentData.status}' (not captured). Fulfilment refused.`
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Determine payment capture timestamp (authoritative webhook vs server-side verification approximation)
    let canonicalPaidAt = null;
    let canonicalSource = null;

    if (existingOrder?.paid_at_source === 'webhook' && existingOrder.paid_at) {
      // Authoritative webhook timestamp already recorded; preserve it
      canonicalPaidAt = existingOrder.paid_at;
      canonicalSource = 'webhook';
    } else if (existingOrder?.paid_at) {
      // Previous verification timestamp already recorded; preserve it
      canonicalPaidAt = existingOrder.paid_at;
      canonicalSource = existingOrder.paid_at_source || 'verify_approx';
    } else {
      // No authoritative capture timestamp is available; use server-side verification timestamp as approximation
      canonicalPaidAt = new Date().toISOString();
      canonicalSource = 'verify_approx';
    }

    // Generate secure random download token (or preserve existing)
    let downloadToken = existingOrder?.download_token;
    if (!downloadToken) {
      const tokenBytes = new Uint8Array(24);
      crypto.getRandomValues(tokenBytes);
      downloadToken = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Update D1 Database
    if (env.DB) {
      try {
        await env.DB.prepare(`
          UPDATE orders
          SET status = 'paid',
              razorpay_payment_id = ?,
              razorpay_signature = ?,
              download_token = COALESCE(download_token, ?),
              paid_at = CASE
                          WHEN paid_at_source = 'webhook' THEN paid_at
                          WHEN paid_at IS NOT NULL THEN paid_at
                          ELSE ?
                        END,
              paid_at_source = CASE
                                 WHEN paid_at_source = 'webhook' THEN paid_at_source
                                 WHEN paid_at IS NOT NULL THEN paid_at_source
                                 ELSE 'verify_approx'
                               END,
              updated_at = datetime('now')
          WHERE razorpay_order_id = ? OR id = ?
        `).bind(razorpay_payment_id, razorpay_signature || '', downloadToken, canonicalPaidAt, razorpay_order_id, targetOrderId).run();

        // Asynchronously dispatch purchase confirmation email with PDF attachment
        // Production environment detection takes precedence; staging/unknown/conflicting environments fail closed
        const envCheck = classifyEmailEnvironment(env);
        if (envCheck.shouldSuppressPurchaseDelivery) {
          console.info(`[Payment Verify]: Staging email suppression active for order ${targetOrderId}. Skipping automatic email dispatch (${envCheck.reason}).`);
        } else {
          const emailPromise = processOrderEmail(targetOrderId, env);
          if (typeof waitUntil === 'function') {
            waitUntil(emailPromise);
          } else if (typeof context !== 'undefined' && context && typeof context.waitUntil === 'function') {
            context.waitUntil(emailPromise);
          } else {
            // Await in local test runners where waitUntil is not provided
            await emailPromise;
          }
        }

        // Asynchronously dispatch Meta Conversions API (CAPI) Purchase event
        const capiContext = {
          clientIp: request.headers?.get ? (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')) : null,
          userAgent: request.headers?.get ? request.headers.get('user-agent') : null,
          sourceUrl: `https://${(request.headers?.get ? request.headers.get('host') : null) || 'ebooks.trenzy.store'}/thank-you/?order_id=${encodeURIComponent(targetOrderId)}`,
          paidAt: canonicalPaidAt,
          paidAtSource: canonicalSource,
          customFetch: env.customFetch
        };
        const capiPromise = sendCapiPurchaseEvent(targetOrderId, env, capiContext);
        if (typeof waitUntil === 'function') {
          waitUntil(capiPromise);
        } else if (typeof context !== 'undefined' && context && typeof context.waitUntil === 'function') {
          context.waitUntil(capiPromise);
        } else {
          // Await in local test runners where waitUntil is not provided
          await capiPromise;
        }
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
