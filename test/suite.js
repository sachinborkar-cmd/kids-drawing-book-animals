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
import { onRequestPost as handleTestEmail } from '../functions/api/test-email.js';
import { getS3PresignedUrl, verifyRazorpaySignature } from '../functions/api/_aws_s3.js';
import { processOrderEmail, renderPurchaseEmail, escapeHtml } from '../functions/api/_email.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// In-memory mock D1 database implementation for deterministic testing
class MockD1 {
  constructor() {
    this.orders = new Map();
    this.webhooks = new Map();
    this.outbox = new Map();
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
            const [payment_id, signature, token, rzp_order_id, targetOrderId] = args;
            const rec = this.orders.get(rzp_order_id) || Array.from(this.orders.values()).find(o => o.id === rzp_order_id || o.id === targetOrderId);
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
          if (q.startsWith('INSERT INTO email_outbox')) {
            const [id, order_id, recipient_email, email_type, status, attempts] = args;
            const key = `${order_id}_${email_type}`;
            if (this.outbox.has(key)) {
              throw new Error('UNIQUE constraint failed: email_outbox.order_id, email_outbox.email_type');
            }
            this.outbox.set(key, {
              id,
              order_id,
              recipient_email,
              email_type,
              status: status || 'pending',
              attempts: attempts || 0,
              last_attempt_at: null,
              sent_at: null,
              error_message: null
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (q.startsWith('UPDATE email_outbox') && q.includes("status = 'processing'")) {
            const [order_id, email_type] = args;
            const key = `${order_id}_${email_type}`;
            const rec = this.outbox.get(key);
            const isStale = rec && rec.status === 'processing' && rec.last_attempt_at && (Date.now() - new Date(rec.last_attempt_at).getTime() > 5 * 60 * 1000);
            if (rec && (rec.status === 'pending' || rec.status === 'failed' || isStale) && rec.attempts < 3) {
              rec.status = 'processing';
              rec.attempts++;
              rec.last_attempt_at = new Date().toISOString();
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (q.startsWith('UPDATE email_outbox') && q.includes("status = 'sent'")) {
            const [order_id, email_type] = args;
            const key = `${order_id}_${email_type}`;
            const rec = this.outbox.get(key);
            if (rec) {
              rec.status = 'sent';
              rec.sent_at = new Date().toISOString();
              rec.error_message = null;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (q.startsWith('UPDATE email_outbox') && q.includes("status = 'failed'")) {
            const [err_msg, order_id, email_type] = args;
            const key = `${order_id}_${email_type}`;
            const rec = this.outbox.get(key);
            if (rec) {
              rec.status = 'failed';
              rec.error_message = err_msg;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => {
          if (q.includes('FROM orders')) {
            const [orderId, rzpId, token] = args;
            if (token !== undefined) {
              const rec = Array.from(this.orders.values()).find(o => (o.id === orderId || o.razorpay_order_id === orderId) && o.download_token === token);
              return rec || null;
            }
            const rec = Array.from(this.orders.values()).find(o => o.id === orderId || o.razorpay_order_id === orderId || o.id === rzpId || o.razorpay_order_id === rzpId);
            return rec || null;
          }
          if (q.includes('FROM webhook_logs')) {
            const [eventId] = args;
            return this.webhooks.get(eventId) || null;
          }
          if (q.includes('FROM email_outbox')) {
            const [order_id, email_type] = args;
            const key = `${order_id}_${email_type}`;
            return this.outbox.get(key) || null;
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
  SUPPORT_EMAIL: 'trenzy.helpme@gmail.com',
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '465',
  SMTP_SECURITY: 'Implicit TLS',
  SMTP_FROM_EMAIL: 'order.trenzystore@gmail.com',
  SMTP_USER: 'order.trenzystore@gmail.com',
  SMTP_PASSWORD: 'test_mock_app_password_1234'
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

await test('GET /api/download sanitizes credentials with trailing newlines and whitespace', async () => {
  const envWithNewlines = {
    ...mockEnv,
    AWS_ACCESS_KEY_ID: '  MOCK_AWS_ACCESS_KEY_ID_123\n\r  ',
    AWS_SECRET_ACCESS_KEY: '  mock_aws_secret_access_key_xyz_456\n  '
  };
  const req = { url: `http://localhost/api/download?order_id=${createdOrder.order_id}&token=${validToken}` };
  const res = await handleDownload({ request: req, env: envWithNewlines });
  assert.equal(res.status, 200);
  const data = JSON.parse(await res.text());
  assert.equal(data.success, true);
  assert(!data.download_url.includes('%0A'), 'Presigned URL must not contain encoded newline %0A');
  assert(!data.download_url.includes('\n'), 'Presigned URL must not contain raw newline');
  assert(data.download_url.includes('MOCK_AWS_ACCESS_KEY_ID_123%2F'), 'Credential scope must contain clean trimmed key');
});

await test('GET /api/download rejects malformed credentials safely', async () => {
  const envMalformed = {
    ...mockEnv,
    AWS_ACCESS_KEY_ID: 'INVALID_SHORT_KEY',
    NODE_ENV: 'production'
  };
  const req = { url: `http://localhost/api/download?order_id=${createdOrder.order_id}&token=${validToken}` };
  const res = await handleDownload({ request: req, env: envMalformed });
  assert.equal(res.status, 500);
  const data = JSON.parse(await res.text());
  assert.equal(data.error, 'Storage credentials format invalid');
});

await test('GET /api/download fails closed if AWS credentials are unset', async () => {
  const envMissing = {
    ...mockEnv,
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: ''
  };
  const req = { url: `http://localhost/api/download?order_id=${createdOrder.order_id}&token=${validToken}` };
  const res = await handleDownload({ request: req, env: envMissing });
  assert.equal(res.status, 500);
  const data = JSON.parse(await res.text());
  assert.equal(data.error, 'Storage credentials not configured');
});

await test('GET /api/download correctly supports Sydney staging bucket and dashboard alias overrides', async () => {
  const stagingEnv = {
    ...mockEnv,
    AWS_S3_BUCKET: undefined,
    AWS_REGION: undefined,
    S3_PDF_KEY: undefined,
    Bucket: 'kids-drawing-book-staging-441378339677',
    Region: 'ap-southeast-2',
    File: 'Kids_Drawing_Book_Animals_School_Edition.pdf'
  };
  const req = { url: `http://localhost/api/download?order_id=${createdOrder.order_id}&token=${validToken}` };
  const res = await handleDownload({ request: req, env: stagingEnv });
  assert.equal(res.status, 200);
  const data = JSON.parse(await res.text());
  assert.equal(data.success, true);
  assert(data.download_url.includes('kids-drawing-book-staging-441378339677.s3.ap-southeast-2.amazonaws.com'), 'Host must match Sydney staging bucket');
  assert(data.download_url.includes('ap-southeast-2%2Fs3%2Faws4_request'), 'Credential scope must reflect ap-southeast-2');
});

// 6. ANALYTICS DEDUPLICATION AUDIT
console.log('\n[Audit Test 6: Analytics & Conversion Event Protection]');
await test('analytics.js deduplicates Purchase event on repeat triggers', async () => {
  const js = fs.readFileSync(path.join(ROOT_DIR, 'client/assets/js/analytics.js'), 'utf8');
  assert(js.includes('sessionStorage.getItem(storageKey)'), 'Must check sessionStorage for order deduplication');
  assert(js.includes('localStorage.getItem(storageKey)'), 'Must check localStorage for order deduplication');
  assert(js.includes("window.fbq('track', 'Purchase'"), 'Must track Meta Pixel Purchase');
});

// 7. POST-PURCHASE EMAIL DELIVERY & IDEMPOTENCY AUDIT
console.log('\n[Audit Test 7: Post-Purchase Email Delivery & Idempotency]');

await test('renderPurchaseEmail escapes customer values and generates required content', async () => {
  const email = renderPurchaseEmail({
    customerName: '<script>alert("xss")</script>Jane Doe',
    orderId: 'ord_safe_123',
    amount: '149',
    currency: 'INR'
  });
  assert.equal(email.subject, 'Your Kids Drawing Book is Ready! Order Confirmation');
  assert(email.text.includes('Hello <script>alert("xss")</script>Jane Doe'));
  assert(email.text.includes('Amount: ₹149'));
  assert(email.text.includes('Order ID: ord_safe_123'));
  assert(email.html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;Jane Doe'), 'Customer name must be HTML-escaped');
  assert(!email.html.includes('<script>'), 'Must not contain unescaped script tag');
  assert(email.html.includes('order.trenzystore@gmail.com'), 'Must include correct sender email');
});

await test('processOrderEmail refuses to send email for unpaid orders', async () => {
  const unpaidOrderId = 'ord_unpaid_test_1';
  mockDb.orders.set(unpaidOrderId, {
    id: unpaidOrderId,
    razorpay_order_id: 'rzp_unpaid_1',
    customer_name: 'Unpaid Customer',
    customer_email: 'unpaid@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'created'
  });

  const res = await processOrderEmail(unpaidOrderId, mockEnv);
  assert.equal(res.success, false);
  assert.equal(res.status, 'order_not_paid');
  const outbox = mockDb.outbox.get(`${unpaidOrderId}_purchase_delivery`);
  assert(!outbox, 'No outbox record should exist for unpaid order');
});

await test('processOrderEmail refuses to send email for failed payments', async () => {
  const failedOrderId = 'ord_failed_test_email';
  mockDb.orders.set(failedOrderId, {
    id: failedOrderId,
    razorpay_order_id: 'rzp_failed_email',
    customer_name: 'Failed Customer',
    customer_email: 'failed@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'failed'
  });

  const res = await processOrderEmail(failedOrderId, mockEnv);
  assert.equal(res.success, false);
  assert.equal(res.status, 'order_not_paid');
});

await test('processOrderEmail refuses to send email for invalid/missing recipient email', async () => {
  const invalidEmailOrderId = 'ord_invalid_email_test';
  mockDb.orders.set(invalidEmailOrderId, {
    id: invalidEmailOrderId,
    razorpay_order_id: 'rzp_invalid_email',
    customer_name: 'Invalid Email Customer',
    customer_email: 'not-an-email',
    amount: 14900,
    currency: 'INR',
    status: 'paid'
  });

  const res = await processOrderEmail(invalidEmailOrderId, mockEnv);
  assert.equal(res.success, false);
  assert.equal(res.status, 'invalid_email');
});

// Mock PDF Buffer with valid %PDF- magic bytes
const mockPdfBuffer = Buffer.from('%PDF-1.4 Mock PDF Content For Testing Purposes Only\n%%EOF');
let lastSentMail = null;
const mockTransportSuccess = async (mailOptions) => {
  lastSentMail = mailOptions;
  return { success: true, messageId: '<mock-msg-123@smtp.gmail.com>' };
};

await test('processOrderEmail sends email with PDF attachment after verified payment', async () => {
  const paidOrderId = 'ord_paid_email_success';
  mockDb.orders.set(paidOrderId, {
    id: paidOrderId,
    razorpay_order_id: 'rzp_paid_success',
    customer_name: 'Sarah Connor',
    customer_email: 'sarah.connor@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'paid'
  });

  const res = await processOrderEmail(paidOrderId, mockEnv, {
    customTransport: mockTransportSuccess,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf',
      size: mockPdfBuffer.length
    }
  });

  assert.equal(res.success, true);
  assert.equal(res.status, 'sent');
  assert(lastSentMail, 'Transport must have received email');
  assert.equal(lastSentMail.to, 'sarah.connor@example.com', 'Recipient must match customer email');
  assert.equal(lastSentMail.from, 'order.trenzystore@gmail.com', 'Sender must match order.trenzystore@gmail.com');
  assert.equal(lastSentMail.subject, 'Your Kids Drawing Book is Ready! Order Confirmation');
  assert(lastSentMail.attachment, 'Attachment must be present');
  assert.equal(lastSentMail.attachment.filename, 'Kids_Drawing_Book_Animals_School_Edition.pdf');
  assert.equal(lastSentMail.attachment.contentType, 'application/pdf');

  const outbox = mockDb.outbox.get(`${paidOrderId}_purchase_delivery`);
  assert(outbox, 'Outbox record must exist');
  assert.equal(outbox.status, 'sent');
  assert(outbox.sent_at, 'sent_at must be populated');
  assert.equal(outbox.error_message, null);
});

await test('processOrderEmail prevents duplicate emails on re-execution (Idempotency)', async () => {
  lastSentMail = null;
  const res = await processOrderEmail('ord_paid_email_success', mockEnv, {
    customTransport: mockTransportSuccess,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  });

  assert.equal(res.success, true);
  assert.equal(res.status, 'already_sent');
  assert.equal(lastSentMail, null, 'Custom transport must not have been called again');
});

await test('SMTP temporary failure records retryable status without altering paid order status', async () => {
  const tempFailOrderId = 'ord_smtp_temp_fail';
  mockDb.orders.set(tempFailOrderId, {
    id: tempFailOrderId,
    razorpay_order_id: 'rzp_temp_fail',
    customer_name: 'John Doe',
    customer_email: 'john@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'paid'
  });

  const mockTransportFail = async () => {
    throw new Error('ETIMEDOUT: Connection to smtp.gmail.com timed out');
  };

  const res = await processOrderEmail(tempFailOrderId, mockEnv, {
    customTransport: mockTransportFail,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  });

  assert.equal(res.success, false);
  assert.equal(res.status, 'failed');

  const outbox = mockDb.outbox.get(`${tempFailOrderId}_purchase_delivery`);
  assert(outbox, 'Outbox record must exist');
  assert.equal(outbox.status, 'failed');
  assert.equal(outbox.attempts, 1);
  assert(outbox.error_message.includes('ETIMEDOUT'));

  // CRITICAL: Order status in orders table must remain 'paid'!
  const orderRecord = mockDb.orders.get(tempFailOrderId);
  assert.equal(orderRecord.status, 'paid', 'Order status must remain paid despite email delivery failure');
});

await test('Retry succeeds on subsequent attempt without requiring another payment', async () => {
  const res = await processOrderEmail('ord_smtp_temp_fail', mockEnv, {
    customTransport: mockTransportSuccess,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  });

  assert.equal(res.success, true);
  assert.equal(res.status, 'sent');
  const outbox = mockDb.outbox.get('ord_smtp_temp_fail_purchase_delivery');
  assert.equal(outbox.status, 'sent');
  assert.equal(outbox.attempts, 2);
  assert.equal(outbox.error_message, null);
});

await test('processOrderEmail stops retrying when maximum attempts (3) exceeded', async () => {
  const maxAttemptsOrderId = 'ord_max_attempts';
  mockDb.orders.set(maxAttemptsOrderId, {
    id: maxAttemptsOrderId,
    razorpay_order_id: 'rzp_max_attempts',
    customer_name: 'Max Retries',
    customer_email: 'max@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'paid'
  });
  mockDb.outbox.set(`${maxAttemptsOrderId}_purchase_delivery`, {
    id: `out_${maxAttemptsOrderId}_purchase_delivery`,
    order_id: maxAttemptsOrderId,
    recipient_email: 'max@example.com',
    email_type: 'purchase_delivery',
    status: 'failed',
    attempts: 3
  });

  const res = await processOrderEmail(maxAttemptsOrderId, mockEnv);
  assert.equal(res.success, false);
  assert.equal(res.status, 'max_retries_exceeded');
});

await test('Existing browser PDF download continues working independently', async () => {
  const req = { url: `http://localhost/api/download?order_id=${createdOrder.order_id}&token=${validToken}` };
  const res = await handleDownload({ request: req, env: mockEnv });
  assert.equal(res.status, 200);
  const data = JSON.parse(await res.text());
  assert.equal(data.success, true);
  assert(data.download_url.includes('X-Amz-Signature='), 'Presigned URL must still be generated');
});

await test('Stuck processing recovery: Reclaims stale processing records older than 5 minutes', async () => {
  const staleOrderId = 'ord_stale_recovery_test';
  mockDb.orders.set(staleOrderId, {
    id: staleOrderId,
    razorpay_order_id: 'rzp_stale_test',
    customer_name: 'Stale Recovery',
    customer_email: 'stale@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'paid'
  });
  // Simulate record stuck in 'processing' from 10 minutes ago
  mockDb.outbox.set(`${staleOrderId}_purchase_delivery`, {
    id: `out_${staleOrderId}_purchase_delivery`,
    order_id: staleOrderId,
    recipient_email: 'stale@example.com',
    email_type: 'purchase_delivery',
    status: 'processing',
    attempts: 1,
    last_attempt_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  });

  const res = await processOrderEmail(staleOrderId, mockEnv, {
    customTransport: mockTransportSuccess,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  });

  assert.equal(res.success, true);
  assert.equal(res.status, 'sent');
  const outbox = mockDb.outbox.get(`${staleOrderId}_purchase_delivery`);
  assert.equal(outbox.status, 'sent');
  assert.equal(outbox.attempts, 2);
});

await test('Duplicate concurrent workers: Safely skips active processing record', async () => {
  const concurrentOrderId = 'ord_concurrent_worker_test';
  mockDb.orders.set(concurrentOrderId, {
    id: concurrentOrderId,
    razorpay_order_id: 'rzp_concurrent_test',
    customer_name: 'Concurrent Worker',
    customer_email: 'concurrent@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'paid'
  });
  // Simulate active processing attempt from 30 seconds ago
  mockDb.outbox.set(`${concurrentOrderId}_purchase_delivery`, {
    id: `out_${concurrentOrderId}_purchase_delivery`,
    order_id: concurrentOrderId,
    recipient_email: 'concurrent@example.com',
    email_type: 'purchase_delivery',
    status: 'processing',
    attempts: 1,
    last_attempt_at: new Date(Date.now() - 30 * 1000).toISOString()
  });

  const res = await processOrderEmail(concurrentOrderId, mockEnv, {
    customTransport: mockTransportSuccess,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  });

  assert.equal(res.success, true);
  assert.equal(res.status, 'in_progress');
});

await test('SMTP authentication failure is recorded safely without affecting paid order status', async () => {
  const authFailOrderId = 'ord_auth_fail_test';
  mockDb.orders.set(authFailOrderId, {
    id: authFailOrderId,
    razorpay_order_id: 'rzp_auth_fail',
    customer_name: 'Auth Fail',
    customer_email: 'authfail@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'paid'
  });

  const mockTransportAuthFail = async () => {
    throw new Error('535 5.7.8 Username and Password not accepted');
  };

  const res = await processOrderEmail(authFailOrderId, mockEnv, {
    customTransport: mockTransportAuthFail,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  });

  assert.equal(res.success, false);
  assert.equal(res.status, 'failed');
  assert(res.error.includes('535 5.7.8'));

  const outbox = mockDb.outbox.get(`${authFailOrderId}_purchase_delivery`);
  assert.equal(outbox.status, 'failed');
  assert(outbox.error_message.includes('535 5.7.8'));

  // Paid status in orders table is strictly preserved
  const orderRecord = mockDb.orders.get(authFailOrderId);
  assert.equal(orderRecord.status, 'paid');
});

await test('Production configuration isolation: Default [vars] contains zero SMTP configuration', async () => {
  const tomlContent = fs.readFileSync(path.join(ROOT_DIR, 'wrangler.toml'), 'utf8');
  // Match top-level [vars] block until next section or EOF
  const varsBlockMatch = tomlContent.match(/\[vars\]([\s\S]*?)(?:\[|$)/);
  assert(varsBlockMatch, 'wrangler.toml must contain [vars] section');
  const varsContent = varsBlockMatch[1];
  assert(!varsContent.includes('SMTP_HOST'), 'Default [vars] must not contain SMTP_HOST');
  assert(!varsContent.includes('SMTP_PORT'), 'Default [vars] must not contain SMTP_PORT');
  assert(!varsContent.includes('SMTP_USER'), 'Default [vars] must not contain SMTP_USER');
  assert(!varsContent.includes('SMTP_FROM_EMAIL'), 'Default [vars] must not contain SMTP_FROM_EMAIL');
  assert(!varsContent.includes('SMTP_PASSWORD'), 'Default [vars] must not contain SMTP_PASSWORD');
});

await test('POST /api/test-email enforces staging isolation and token authorization', async () => {
  // Test 1: Disabled in production
  const prodReq = {
    url: 'http://localhost/api/test-email?order_id=ord_test&token=some_token',
    json: async () => ({})
  };
  const prodRes = await handleTestEmail({ request: prodReq, env: { ...mockEnv, ENVIRONMENT: 'production' } });
  assert.equal(prodRes.status, 403);

  // Test 2: Missing token returns 401
  const noTokenReq = {
    url: 'http://localhost/api/test-email?order_id=ord_test',
    json: async () => ({})
  };
  const noTokenRes = await handleTestEmail({ request: noTokenReq, env: mockEnv });
  assert.equal(noTokenRes.status, 401);

  // Test 3: Invalid token returns 403
  const badTokenReq = {
    url: `http://localhost/api/test-email?order_id=${createdOrder.order_id}&token=bad_token`,
    json: async () => ({})
  };
  const badTokenRes = await handleTestEmail({ request: badTokenReq, env: mockEnv });
  assert.equal(badTokenRes.status, 403);
});

console.log('\n======================================================');
console.log(` TOTAL AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('======================================================\n');

if (failed > 0) {
  process.exit(1);
}
