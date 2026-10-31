/**
 * GET /api/config
 * Returns public store configuration (price, currency, Razorpay key_id)
 */
export async function onRequestGet({ env }) {
  const price = parseInt(env.PRODUCT_PRICE || '149', 10);
  const currency = env.PRODUCT_CURRENCY || 'INR';
  const keyId = env.RAZORPAY_KEY_ID || 'rzp_test_placeholder';
  const supportEmail = env.SUPPORT_EMAIL || 'trenzy.helpme@gmail.com';

  return new Response(JSON.stringify({
    success: true,
    product: {
      id: 'kids-drawing-book-animals',
      title: 'Kids Drawing Book – Animals',
      price: price,
      currency: currency,
      formattedPrice: `₹${price}`,
      pages: 22,
      animals: 13
    },
    razorpay: {
      keyId: keyId
    },
    supportEmail: supportEmail
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60'
    }
  });
}
