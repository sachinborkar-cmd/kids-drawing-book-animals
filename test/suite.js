/**
 * Complete Production-Readiness Automated Test Suite
 * Tests all 9 audit requirements:
 * 1. Local frontend test
 * 2. Local API test
 * 3. Razorpay test-mode simulation
 * 4. Invalid signature test
 * 5. Failed payment test
 * 6. Duplicate webhook test
 * 7. Unauthorized download test
 * 8. 10-minute presigned expiry test
 * 9. Mobile layout test
 */
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';

import { onRequestGet as handleConfig } from '../functions/api/config.js';
import { onRequestPost as handleCreateOrder } from '../functions/api/create-order.js';
import { onRequestPost as handleVerifyPayment } from '../functions/api/verify-payment.js';
import { onRequestPost as handleWebhook } from '../functions/api/razorpay-webhook.js';
import { onRequestGet as handleDownload } from '../functions/api/download.js';
import { getS3PresignedUrl, verifyRazorpaySignature } from '../functions/api/_aws_s3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// In-memory mock D1 database implementation for deterministic testing
class MockD1 {
  constructor() {
    this.orders = new Map();
    this.webhooks = new Map();
  }

  prepare(query) {
    const q = query.trim();
    return {
      bind: (...args) => ({
        run: async () => {
          if (q.startsWith('INSERT INTO orders')) {
            const [id, rzp_order_id, name, email, phone, amount, currency, status] = args;
            this.orders.set(rzp_order_id, {
              id,
              razorpay_order_id: rzp_order_id,
              customer_name: name,
              customer_email: email,
              customer_phone: phone,
              amount,
              currency,
              status: status || 'created',
              download_token: null,
              download_count: 0
            });
            return { success: true };
          }
          if (q.startsWith('UPDATE orders') && q.includes("status = 'paid'")) {
            if (args.length === 3) {
              const [payment_id, token, rzp_order_id] = args;
              const rec = this.orders.get(rzp_order_id) || Array.from(this.orders.values()).find(o => o.id === rzp_order_id);
              if (rec) {
                rec.status = 'paid';
                rec.razorpay_payment_id = rec.razorpay_payment_id || payment_id;
                rec.download_token = rec.download_token || token;
              }
              return { success: true };
            }
            const [payment_id, signature, token, rzp_order_id] = args;
            const rec = this.orders.get(rzp_order_id) || Array.from(this.orders.values()).find(o => o.id === rzp_order_id);
            if (rec) {
              rec.status = 'paid';
              rec.razorpay_payment_id = payment_id;
              rec.razorpay_signature = signature;
              rec.download_token = token;
            }
            return { success: true };
          }
          if (q.startsWith('UPDATE orders') && q.includes("status = 'failed'")) {
            const [rzp_order_id] = args;
            const rec = this.orders.get(rzp_order_id);
            if (rec) rec.status = 'failed';
            return { success: true };
          }
          if (q.startsWith('UPDATE orders') && q.includes('download_count')) {
            const [orderId] = args;
            const rec = Array.from(this.orders.values()).find(o => o.id === orderId || o.razorpay_order_id === orderId);
            if (rec) rec.download_count++;
            return { success: true };
          }
          if (q.startsWith('INSERT INTO webhook_logs')) {
            const [event_id, event_type, order_id, payment_id, payload] = args;
            this.webhooks.set(event_id, { event_id, event_type, order_id, payment_id, payload });
            return { success: true };
          }
          return { success: true };
        },
        first: async () => {
          if (q.includes('FROM orders')) {
            const [orderId, , token] = args;
            const rec = Array.from(this.orders.values()).find(o => (o.id === orderId || o.razorpay_order_id === orderId) && o.download_token === token);
            return rec || null;
          }
          if (q.includes('FROM webhook_logs')) {
            const [eventId] = args;
            return this.webhooks.get(eventId) || null;
          }
          return null;
        }
      })
    };
  }
}

const mockDb = new MockD1();
const mockEnv = {
  DB: mockDb,
  PRODUCT_PRICE: '149',
  PRODUCT_CURRENCY: 'INR',
  RAZORPAY_KEY_ID: 'rzp_test_placeholder',
  RAZORPAY_KEY_SECRET: 'test_secret_key_123',
  RAZORPAY_WEBHOOK_SECRET: 'webhook_secret_xyz',
  AWS_REGION: 'ap-south-1',
  AWS_S3_BUCKET: 'inkframepress-private-ebooks-442189079113-ap-south-1-an',
  AWS_ACCESS_KEY_ID: 'MOCK_AWS_ACCESS_KEY_ID_123',
  AWS_SECRET_ACCESS_KEY: 'mock_aws_secret_access_key_xyz_456',
  S3_PDF_KEY: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
  DOWNLOAD_EXPIRY_SECONDS: '600',
  SUPPORT_EMAIL: 'trenzy.helpme@gmail.com'
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log('\n======================================================');
console.log(' AUDIT TEST SUITE: PRODUCTION READINESS VERIFICATION');
console.log('======================================================\n');

// 1. FRONTEND AUDIT
console.log('[Audit Test 1: Frontend Assets & Layout]');
await test('All 5 promotional marketing images exist and are non-empty', async () => {
  const images = ['hero-mockup.jpg', 'book-3d-isolated.jpg', 'promo-banner-animals.jpg', 'promo-banner-kids.jpg', 'promo-banner-croc.jpg'];
  images.forEach(f => {
    const p = path.join(ROOT_DIR, 'client/assets/images', f);
    assert(fs.existsSync(p), `Missing: ${f}`);
    assert(fs.statSync(p).size > 10000, `Empty image: ${f}`);
  });
});

await test('All genuine PDF preview images exist and are non-empty', async () => {
  const previews = [
    'page-06-dog.png', 'page-07-giraffe.png', 'page-08-monkey.png',
    'page-10-duck.png', 'page-11-lion.png', 'page-12-count-color.svg',
    'page-14-rabbit.png', 'page-15-cat.png', 'page-16-dolphin.png',
    'page-19-crocodile.png', 'page-20-connect-dots.svg', 'page-21-favorite-animal.svg'
  ];
  previews.forEach(f => {
    const p = path.join(ROOT_DIR, 'client/assets/images/previews', f);
    assert(fs.existsSync(p), `Missing: ${f}`);
    assert(fs.statSync(p).size > 500, `Empty: ${f}`);
  });
});

await test('Mobile layout CSS has sticky bar and responsive breakpoints', async () => {
  const css = fs.readFileSync(path.join(ROOT_DIR, 'client/assets/css/style.css'), 'utf8');
  assert(css.includes('.mobile-sticky-bar'), 'Missing .mobile-sticky-bar');
  assert(css.includes('position: fixed;'), 'Missing fixed position for sticky bar');
  assert(css.includes('@media (min-width: 768px)'), 'Missing 768px breakpoint');
});

// 2. LOCAL API AUDIT
console.log('\n[Audit Test 2: Core Payment & Order APIs]');
await test('GET /api/config returns verified pricing and currency (INR)', async () => {
  const res = await handleConfig({ env: mockEnv });
  assert.equal(res.status, 200);
  const data = JSON.parse(await res.text());
  assert.equal(data.product.price, 149);
  assert.equal(data.product.currency, 'INR');
});

let createdOrder = null;
await test('POST /api/create-order creates order with server-enforced amount', async () => {
  const req = {
    json: async () => ({ name: 'Aarav Patel', email: 'aarav@example.com', phone: '9876543210' })
  };
  const res = await handleCreateOrder({ request: req, env: mockEnv });
  assert.equal(res.status, 200);
  createdOrder = JSON.parse(await res.text());
  assert.equal(createdOrder.amount, 14900); // 149 INR in paise
  assert.equal(createdOrder.currency, 'INR');
  assert(createdOrder.razorpay_order_id, 'Missing razorpay_order_id');
});

await test('POST /api/create-order blocks requests without valid email', async () => {
  const req = { json: async () => ({ name: 'No Email User' }) };
  const res = await handleCreateOrder({ request: req, env: mockEnv });
  assert.equal(res.status, 400);
});

// 3. RAZORPAY SECURITY & SIGNATURE AUDIT
console.log('\n[Audit Test 3: Razorpay Security & Signature Tests]');
let validToken = null;
await test('POST /api/verify-payment succeeds with valid HMAC signature and issues token', async () => {
  const orderId = createdOrder.razorpay_order_id;
  const paymentId = 'pay_test_succ_123';

  // Calculate valid signature using secret
  const enc = new TextEncoder().encode(mockEnv.RAZORPAY_KEY_SECRET);
  const keyObj = await crypto.subtle.importKey('raw', enc, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = await crypto.subtle.sign('HMAC', keyObj, new TextEncoder().encode(`${orderId}|${paymentId}`));
  const validSig = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('');

  const req = {
    json: async () => ({
      order_id: createdOrder.order_id,
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: validSig
    })
  };
  const res = await handleVerifyPayment({ request: req, env: mockEnv });
  assert.equal(res.status, 200);
  const data = JSON.parse(await res.text());
  assert.equal(data.verified, true);
  assert(data.download_token, 'Missing download token');
  validToken = data.download_token;
});

await test('POST /api/verify-payment strictly rejects invalid / tampered signature', async () => {
  const req = {
    json: async () => ({
      order_id: createdOrder.order_id,
      razorpay_order_id: createdOrder.razorpay_order_id,
      razorpay_payment_id: 'pay_tampered_fake',
      razorpay_signature: 'deadbeef_invalid_signature_12345'
    })
  };
  const res = await handleVerifyPayment({ request: req, env: mockEnv });
  assert.equal(res.status, 400);
  const data = JSON.parse(await res.text());
  assert.equal(data.verified, false);
});

// 4. WEBHOOK IDEMPOTENCY & FAILED PAYMENTS AUDIT
console.log('\n[Audit Test 4: Webhook Security, Idempotency & Failure Handling]');

// Helper to compute HMAC-SHA256 signature for test webhooks
async function computeWebhookSig(payload, secret) {
  const enc = new TextEncoder().encode(secret);
  const keyObj = await crypto.subtle.importKey('raw', enc, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = await crypto.subtle.sign('HMAC', keyObj, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}

await test('POST /api/razorpay-webhook fails closed (HTTP 500) if RAZORPAY_WEBHOOK_SECRET is missing', async () => {
  const rawPayload = JSON.stringify({ event_id: 'evt_no_secret', event: 'payment.captured' });
  const req = {
    text: async () => rawPayload,
    headers: { get: (h) => h === 'x-razorpay-signature' ? 'some_sig' : null }
  };
  const envNoSecret = { ...mockEnv, RAZORPAY_WEBHOOK_SECRET: '' };
  const res = await handleWebhook({ request: req, env: envNoSecret });
  assert.equal(res.status, 500);
  const body = JSON.parse(await res.text());
  assert.equal(body.error, 'Webhook secret not configured');
});

await test('POST /api/razorpay-webhook rejects request (HTTP 400) if x-razorpay-signature is missing', async () => {
  const rawPayload = JSON.stringify({ event_id: 'evt_no_sig', event: 'payment.captured' });
  const req = {
    text: async () => rawPayload,
    headers: { get: () => null }
  };
  const res = await handleWebhook({ request: req, env: mockEnv });
  assert.equal(res.status, 400);
  const body = JSON.parse(await res.text());
  assert.equal(body.error, 'Missing webhook signature header');
});

await test('POST /api/razorpay-webhook rejects request (HTTP 400) if signature is invalid / tampered', async () => {
  const rawPayload = JSON.stringify({ event_id: 'evt_bad_sig', event: 'payment.captured' });
  const req = {
    text: async () => rawPayload,
    headers: { get: (h) => h === 'x-razorpay-signature' ? 'deadbeef_invalid_signature_hex' : null }
  };
  const res = await handleWebhook({ request: req, env: mockEnv });
  assert.equal(res.status, 400);
  const body = JSON.parse(await res.text());
  assert.equal(body.error, 'Invalid webhook signature');
});

await test('POST /api/razorpay-webhook accepts request with valid HMAC-SHA256 signature', async () => {
  const orderId = 'order_valid_sig_test';
  mockDb.orders.set(orderId, {
    id: 'ord_valid_sig',
    razorpay_order_id: orderId,
    status: 'created',
    download_token: null
  });

  const rawPayload = JSON.stringify({
    event_id: 'evt_valid_sig_test',
    event: 'payment.captured',
    payload: { payment: { entity: { order_id: orderId, id: 'pay_valid_sig_1' } } }
  });
  const validSig = await computeWebhookSig(rawPayload, mockEnv.RAZORPAY_WEBHOOK_SECRET);

  const req = {
    text: async () => rawPayload,
    headers: { get: (h) => h === 'x-razorpay-signature' ? validSig : null }
  };
  const res = await handleWebhook({ request: req, env: mockEnv });
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.status, 'success');
});

await test('POST /api/razorpay-webhook idempotently skips duplicate events (already processed)', async () => {
  const dupOrderId = 'order_dup_webhook_test';
  mockDb.orders.set(dupOrderId, {
    id: 'ord_dup_webhook',
    razorpay_order_id: dupOrderId,
    status: 'created',
    download_token: null
  });

  const rawPayload = JSON.stringify({
    event_id: 'evt_dup_test_456',
    event: 'payment.captured',
    payload: { payment: { entity: { order_id: dupOrderId, id: 'pay_captured_dup' } } }
  });
  const validSig = await computeWebhookSig(rawPayload, mockEnv.RAZORPAY_WEBHOOK_SECRET);

  const req = {
    text: async () => rawPayload,
    headers: { get: (h) => h === 'x-razorpay-signature' ? validSig : null }
  };

  // First delivery
  const res1 = await handleWebhook({ request: req, env: mockEnv });
  assert.equal(res1.status, 200);

  // Second delivery (duplicate event)
  const res2 = await handleWebhook({ request: req, env: mockEnv });
  assert.equal(res2.status, 200);
  const data2 = JSON.parse(await res2.text());
  assert.equal(data2.status, 'already_processed');
});

await test('POST /api/razorpay-webhook handles payment.captured, marks order paid, and issues download token', async () => {
  const capturedOrderId = 'order_captured_webhook_test';
  mockDb.orders.set(capturedOrderId, {
    id: 'ord_captured',
    razorpay_order_id: capturedOrderId,
    status: 'created',
    download_token: null
  });

  const rawPayload = JSON.stringify({
    event_id: 'evt_captured_test_789',
    event: 'payment.captured',
    payload: { payment: { entity: { order_id: capturedOrderId, id: 'pay_cap_789' } } }
  });
  const validSig = await computeWebhookSig(rawPayload, mockEnv.RAZORPAY_WEBHOOK_SECRET);

  const req = {
    text: async () => rawPayload,
    headers: { get: (h) => h === 'x-razorpay-signature' ? validSig : null }
  };
  const res = await handleWebhook({ request: req, env: mockEnv });
  assert.equal(res.status, 200);

  const orderRec = mockDb.orders.get(capturedOrderId);
  assert.equal(orderRec.status, 'paid');
  assert.equal(orderRec.razorpay_payment_id, 'pay_cap_789');
  assert(orderRec.download_token, 'download_token must be generated');
});

await test('POST /api/razorpay-webhook handles payment.failed and marks order failed', async () => {
  const failedOrderId = 'order_failed_test_99';
  mockDb.orders.set(failedOrderId, {
    id: 'ord_failed',
    razorpay_order_id: failedOrderId,
    status: 'created',
    download_token: null
  });

  const rawPayload = JSON.stringify({
    event_id: 'evt_fail_1',
    event: 'payment.failed',
    payload: { payment: { entity: { order_id: failedOrderId, id: 'pay_failed_1' } } }
  });
  const validSig = await computeWebhookSig(rawPayload, mockEnv.RAZORPAY_WEBHOOK_SECRET);

  const req = {
    text: async () => rawPayload,
    headers: { get: (h) => h === 'x-razorpay-signature' ? validSig : null }
  };
  const res = await handleWebhook({ request: req, env: mockEnv });
  assert.equal(res.status, 200);

  // Verify order status is marked failed
  assert.equal(mockDb.orders.get(failedOrderId).status, 'failed');
});

// 5. SECURE DOWNLOAD & 10-MINUTE EXPIRY AUDIT
console.log('\n[Audit Test 5: S3 Download Authorization & Expiry]');
await test('GET /api/download rejects unauthorized requests with no token', async () => {
  const req = { url: 'http://localhost/api/download' };
  const res = await handleDownload({ request: req, env: mockEnv });
  assert.equal(res.status, 403);
});

await test('GET /api/download rejects invalid / fabricated tokens', async () => {
  const req = { url: `http://localhost/api/download?order_id=${createdOrder.order_id}&token=fake_invalid_token` };
  const res = await handleDownload({ request: req, env: mockEnv });
  assert.equal(res.status, 403);
});

await test('GET /api/download issues 10-minute temporary AWS SigV4 URL for verified paid order', async () => {
  const req = { url: `http://localhost/api/download?order_id=${createdOrder.order_id}&token=${validToken}` };
  const res = await handleDownload({ request: req, env: mockEnv });
  assert.equal(res.status, 200);
  const data = JSON.parse(await res.text());
  assert.equal(data.success, true);
  assert.equal(data.expires_in, 600); // Exactly 10 minutes (600 seconds)
  assert(data.download_url.includes('X-Amz-Expires=600'), 'SigV4 URL must contain 10m expiry (600s)');
  assert(data.download_url.includes('X-Amz-Signature='), 'SigV4 URL must be cryptographically signed');
});

// 6. ANALYTICS DEDUPLICATION AUDIT
console.log('\n[Audit Test 6: Analytics & Conversion Event Protection]');
await test('analytics.js deduplicates Purchase event on repeat triggers', async () => {
  const js = fs.readFileSync(path.join(ROOT_DIR, 'client/assets/js/analytics.js'), 'utf8');
  assert(js.includes('sessionStorage.getItem(storageKey)'), 'Must check sessionStorage for order deduplication');
  assert(js.includes('localStorage.getItem(storageKey)'), 'Must check localStorage for order deduplication');
  assert(js.includes("window.fbq('track', 'Purchase'"), 'Must track Meta Pixel Purchase');
});

console.log('\n======================================================');
console.log(` TOTAL AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('======================================================\n');

if (failed > 0) {
  process.exit(1);
}
