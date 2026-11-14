/**
 * POST /api/create-order
 * Creates a Razorpay order and saves a pending record in Cloudflare D1
 */
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { name, email, phone } = body;

    if (!email || !email.includes('@')) {
      return new Response(JSON.stringify({ success: false, error: 'A valid email address is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate phone number: Optional, but if provided, must be exactly 10 numeric digits
    let validatedPhone = '';
    if (phone !== undefined && phone !== null) {
      const rawPhone = String(phone).trim();
      if (rawPhone.length > 0) {
        if (!/^\d{10}$/.test(rawPhone)) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Invalid phone number. Please enter a valid 10-digit mobile number, or leave it blank.'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        validatedPhone = rawPhone;
      }
    }

    const price = parseInt(env.PRODUCT_PRICE || '149', 10);
    const currency = env.PRODUCT_CURRENCY || 'INR';
    const amountInPaise = price * 100;
    const rawKeyId = typeof env.RAZORPAY_KEY_ID === 'string' ? env.RAZORPAY_KEY_ID.trim() : '';
    const rawKeySecret = typeof env.RAZORPAY_KEY_SECRET === 'string' ? env.RAZORPAY_KEY_SECRET.trim() : '';

    // Environment detection
    const envName = (typeof env.ENVIRONMENT === 'string' ? env.ENVIRONMENT : '').trim().toLowerCase();
    const nodeEnv = (typeof env.NODE_ENV === 'string' ? env.NODE_ENV : '').trim().toLowerCase();
    const pagesBranch = (typeof env.CF_PAGES_BRANCH === 'string' ? env.CF_PAGES_BRANCH : '').trim().toLowerCase();
    const testTargetEnv = (typeof env.TEST_TARGET_ENV === 'string' ? env.TEST_TARGET_ENV : '').trim().toLowerCase();

    const isProd = pagesBranch === 'main' || pagesBranch === 'master' || envName === 'production' || nodeEnv === 'production' || testTargetEnv === 'production';
    const isPreview = pagesBranch === 'staging' || envName === 'staging' || envName === 'preview' || nodeEnv === 'staging' || testTargetEnv === 'staging';

    const isPlaceholder = !rawKeyId || rawKeyId.includes('placeholder');

    // 1. Production fail-closed validation: reject if key is missing/placeholder or secret is missing
    if (isProd) {
      if (isPlaceholder || !rawKeySecret) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Payment gateway credentials not configured in production.'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 2. Preview / Staging fail-closed validation: reject if key is missing/placeholder or secret is missing
    if (isPreview) {
      if (isPlaceholder || !rawKeySecret) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Payment gateway credentials not configured in preview/staging environment.'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    const receipt = `rcpt_${Date.now().toString().slice(-8)}`;
    let razorpayOrderId = null;

    // Call Razorpay API when valid genuine credentials are present
    if (rawKeySecret && rawKeyId && !isPlaceholder) {
      const basicAuth = btoa(`${rawKeyId}:${rawKeySecret}`);
      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: amountInPaise,
          currency: currency,
          receipt: receipt,
          notes: {
            customer_name: name || '',
            customer_email: email,
            customer_phone: validatedPhone,
            product: 'kids-drawing-book-animals'
          }
        })
      });

      if (!rzpRes.ok) {
        const errText = await rzpRes.text();
        console.error('[Razorpay Order Error]:', errText);
        return new Response(JSON.stringify({ success: false, error: 'Payment gateway initialization failed.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const rzpData = await rzpRes.json();
      razorpayOrderId = rzpData.id;
    } else {
      // Local development mock mode is strictly isolated to explicit local development configurations
      const allowLocalMock = env.ALLOW_LOCAL_MOCK === true || env.ALLOW_LOCAL_MOCK === 'true' || nodeEnv === 'development';
      if (!isProd && !isPreview && allowLocalMock) {
        razorpayOrderId = `order_test_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
      } else {
        return new Response(JSON.stringify({
          success: false,
          error: 'Payment gateway is unavailable.'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    const localOrderId = `ord_${Date.now()}`;

    // Store in Cloudflare D1 if binding exists (stored in Rupees for clear accounting)
    if (env.DB) {
      try {
        await env.DB.prepare(`
          INSERT INTO orders (id, razorpay_order_id, customer_name, customer_email, customer_phone, amount, currency, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'created')
        `).bind(localOrderId, razorpayOrderId, name || '', email, validatedPhone, price, currency).run();
      } catch (dbErr) {
        console.warn('[D1 Order Insert Warning]:', dbErr.message);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      order_id: localOrderId,
      razorpay_order_id: razorpayOrderId,
      amount: amountInPaise,
      currency: currency,
      key_id: rawKeyId,
      customer: {
        name: name || '',
        email: email,
        phone: validatedPhone
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[Create Order Fatal Error]:', err);
    return new Response(JSON.stringify({ success: false, error: 'Internal server error while creating order.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
