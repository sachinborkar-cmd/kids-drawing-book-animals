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

    const price = parseInt(env.PRODUCT_PRICE || '149', 10);
    const currency = env.PRODUCT_CURRENCY || 'INR';
    const amountInPaise = price * 100;
    const keyId = env.RAZORPAY_KEY_ID || 'rzp_test_placeholder';
    const keySecret = env.RAZORPAY_KEY_SECRET;

    const receipt = `rcpt_${Date.now().toString().slice(-8)}`;
    let razorpayOrderId = null;

    // Call Razorpay API if live/test secret is provided
    if (keySecret && keyId && !keyId.includes('placeholder')) {
      const basicAuth = btoa(`${keyId}:${keySecret}`);
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
            customer_phone: phone || '',
            product: 'kids-drawing-book-animals'
          }
        })
      });

      if (!rzpRes.ok) {
        const errText = await rzpRes.text();
        console.error('[Razorpay Order Error]:', errText);
        return new Response(JSON.stringify({ success: false, error: 'Payment gateway initialization failed.' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const rzpData = await rzpRes.json();
      razorpayOrderId = rzpData.id;
    } else {
      // Development / Test placeholder mode order ID
      razorpayOrderId = `order_test_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
    }

    const localOrderId = `ord_${Date.now()}`;

    // Store in Cloudflare D1 if binding exists (stored in Rupees for clear accounting)
    if (env.DB) {
      try {
        await env.DB.prepare(`
          INSERT INTO orders (id, razorpay_order_id, customer_name, customer_email, customer_phone, amount, currency, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'created')
        `).bind(localOrderId, razorpayOrderId, name || '', email, phone || '', price, currency).run();
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
      key_id: keyId,
      customer: {
        name: name || '',
        email: email,
        phone: phone || ''
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
