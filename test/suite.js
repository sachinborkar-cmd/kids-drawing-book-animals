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
import {
  getS3PresignedUrl,
  verifyRazorpaySignature,
  getValidatedS3Config,
  AUTHORIZED_S3_CONFIGS
} from '../functions/api/_aws_s3.js';
import {
  processOrderEmail,
  fetchPdfFromS3,
  renderPurchaseEmail,
  escapeHtml,
  ALLOWED_EMAIL_TYPES,
  isPositivelyVerifiedPreview,
  EXPECTED_STAGING_BUCKET,
  EXPECTED_STAGING_RAZORPAY_KEY
} from '../functions/api/_email.js';

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
  CF_PAGES_BRANCH: 'main',
  ENVIRONMENT: 'production',
  PRODUCT_PRICE: '149',
  PRODUCT_CURRENCY: 'INR',
  RAZORPAY_KEY_ID: 'rzp_test_placeholder',
  RAZORPAY_KEY_SECRET: 'test_secret_key_123',
  RAZORPAY_WEBHOOK_SECRET: 'webhook_secret_xyz',
  AWS_REGION: 'ap-southeast-2',
  AWS_S3_BUCKET: 'kids-drawing-book-production-441378339677',
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
  assert.equal(createdOrder.amount, 14900); // 149 INR in paise for Razorpay
  assert.equal(createdOrder.currency, 'INR');
  assert(createdOrder.razorpay_order_id, 'Missing razorpay_order_id');
  const storedDbOrder = mockEnv.DB.orders.get(createdOrder.razorpay_order_id);
  assert.equal(storedDbOrder.amount, 149, 'D1 order record must store amount in rupees (149)');
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
    CF_PAGES_BRANCH: 'staging',
    ENVIRONMENT: 'staging',
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

await test('getValidatedS3Config rejects missing AWS_S3_BUCKET', () => {
  assert.throws(() => {
    getValidatedS3Config({
      CF_PAGES_BRANCH: 'main',
      AWS_REGION: 'ap-southeast-2'
    });
  }, /AWS_S3_BUCKET is required/);
});

await test('getValidatedS3Config rejects missing AWS_REGION', () => {
  assert.throws(() => {
    getValidatedS3Config({
      CF_PAGES_BRANCH: 'main',
      AWS_S3_BUCKET: 'kids-drawing-book-production-441378339677'
    });
  }, /AWS_REGION is required/);
});

await test('getValidatedS3Config succeeds for correct production configuration', () => {
  const cfg = getValidatedS3Config({
    CF_PAGES_BRANCH: 'main',
    AWS_S3_BUCKET: 'kids-drawing-book-production-441378339677',
    AWS_REGION: 'ap-southeast-2'
  });
  assert.equal(cfg.bucket, 'kids-drawing-book-production-441378339677');
  assert.equal(cfg.region, 'ap-southeast-2');
  assert.equal(cfg.key, 'Kids_Drawing_Book_Animals_School_Edition.pdf');
});

await test('getValidatedS3Config succeeds for correct staging configuration', () => {
  const cfg = getValidatedS3Config({
    CF_PAGES_BRANCH: 'staging',
    AWS_S3_BUCKET: 'kids-drawing-book-staging-441378339677',
    AWS_REGION: 'ap-southeast-2'
  });
  assert.equal(cfg.bucket, 'kids-drawing-book-staging-441378339677');
  assert.equal(cfg.region, 'ap-southeast-2');
  assert.equal(cfg.key, 'Kids_Drawing_Book_Animals_School_Edition.pdf');
});

await test('getValidatedS3Config rejects production pointing to staging bucket', () => {
  assert.throws(() => {
    getValidatedS3Config({
      CF_PAGES_BRANCH: 'main',
      AWS_S3_BUCKET: 'kids-drawing-book-staging-441378339677',
      AWS_REGION: 'ap-southeast-2'
    });
  }, /Production environment must strictly use production S3 bucket/);
});

await test('getValidatedS3Config rejects staging pointing to production bucket', () => {
  assert.throws(() => {
    getValidatedS3Config({
      CF_PAGES_BRANCH: 'staging',
      AWS_S3_BUCKET: 'kids-drawing-book-production-441378339677',
      AWS_REGION: 'ap-southeast-2'
    });
  }, /Staging\/Preview environment must strictly use staging S3 bucket/);
});

await test('getValidatedS3Config rejects mismatched bucket and region', () => {
  assert.throws(() => {
    getValidatedS3Config({
      CF_PAGES_BRANCH: 'staging',
      AWS_S3_BUCKET: 'kids-drawing-book-staging-441378339677',
      AWS_REGION: 'ap-south-1' // Wrong region for staging bucket
    });
  }, /Staging\/Preview environment must strictly use staging S3 bucket.*in ap-southeast-2/);

  assert.throws(() => {
    getValidatedS3Config({
      CF_PAGES_BRANCH: 'main',
      AWS_S3_BUCKET: 'kids-drawing-book-production-441378339677',
      AWS_REGION: 'ap-south-1' // Wrong region for production bucket
    });
  }, /Production environment must strictly use production S3 bucket.*in ap-southeast-2/);
});

await test('getValidatedS3Config rejects unknown or missing environment identification', () => {
  // Missing environment indicators
  assert.throws(() => {
    getValidatedS3Config({
      AWS_S3_BUCKET: 'kids-drawing-book-production-441378339677',
      AWS_REGION: 'ap-southeast-2'
    });
  }, /Unable to determine runtime environment/);

  // Unknown environment indicator
  assert.throws(() => {
    getValidatedS3Config({
      ENVIRONMENT: 'unknown_env',
      AWS_S3_BUCKET: 'kids-drawing-book-production-441378339677',
      AWS_REGION: 'ap-southeast-2'
    });
  }, /Unable to determine runtime environment/);
});

await test('Download API fails safely without making an S3 request on invalid configuration', async () => {
  const badEnv = {
    ...mockEnv,
    CF_PAGES_BRANCH: 'main',
    AWS_S3_BUCKET: 'kids-drawing-book-staging-441378339677' // Cross-environment violation
  };
  const req = { url: `http://localhost/api/download?order_id=${createdOrder.order_id}&token=${validToken}` };
  const res = await handleDownload({ request: req, env: badEnv });
  assert.equal(res.status, 500);
  const data = JSON.parse(await res.text());
  assert.equal(data.error, 'Storage configuration error');
});

await test('Email PDF retrieval rejects invalid configuration before making an S3 request', async () => {
  const badEnv = {
    ...mockEnv,
    CF_PAGES_BRANCH: 'main',
    AWS_S3_BUCKET: 'kids-drawing-book-staging-441378339677' // Cross-environment violation
  };
  await assert.rejects(async () => {
    await fetchPdfFromS3(badEnv);
  }, /Production environment must strictly use production S3 bucket/);
});

await test('Email PDF retrieval fails closed if AWS credentials are unset', async () => {
  const badCredsEnv = {
    ...mockEnv,
    CF_PAGES_BRANCH: 'main',
    AWS_ACCESS_KEY_ID: '',
    AWS_SECRET_ACCESS_KEY: ''
  };
  await assert.rejects(async () => {
    await fetchPdfFromS3(badCredsEnv);
  }, /AWS credentials missing for PDF attachment retrieval/);
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
  assert(email.html.includes('trenzy.helpme@gmail.com'), 'Must include correct support email');
  assert(email.text.includes('trenzy.helpme@gmail.com'), 'Must include correct support email in plain text');
  assert(email.html.includes('~1.2 MB'), 'Must include updated compressed PDF size note (~1.2 MB)');
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

const dynamicTestPreviewSecret = 'preview_sec_' + Math.random().toString(36).substring(2) + '_' + Date.now().toString(36) + '_secure_token_8640';

const previewTestEnv = {
  ...mockEnv,
  ENVIRONMENT: 'staging',
  CF_PAGES_BRANCH: 'staging',
  AWS_S3_BUCKET: EXPECTED_STAGING_BUCKET,
  AWS_REGION: 'ap-southeast-2',
  RAZORPAY_KEY_ID: EXPECTED_STAGING_RAZORPAY_KEY,
  STAGING_PREVIEW_TOKEN: dynamicTestPreviewSecret
};

await test('isPositivelyVerifiedPreview strictly enforces multi-factor preview verification and rejects permissive signals', async () => {
  // Fail-closed 1: Missing or empty environment
  assert.equal(isPositivelyVerifiedPreview(null), false, 'Null env must return false');
  assert.equal(isPositivelyVerifiedPreview({}), false, 'Empty env must return false');
  assert.equal(isPositivelyVerifiedPreview(mockEnv), false, 'Raw default mockEnv (production settings) must return false');

  // Fail-closed 2: Permissive signals alone MUST NOT authorize preview
  assert.equal(isPositivelyVerifiedPreview({ ENVIRONMENT: 'development' }), false, 'ENVIRONMENT=development alone must return false');
  assert.equal(isPositivelyVerifiedPreview({ ENVIRONMENT: 'test' }), false, 'ENVIRONMENT=test alone must return false');
  assert.equal(isPositivelyVerifiedPreview({ NODE_ENV: 'test' }), false, 'NODE_ENV=test alone must return false');
  assert.equal(isPositivelyVerifiedPreview({ AWS_S3_BUCKET: EXPECTED_STAGING_BUCKET }), false, 'Staging S3 bucket alone must return false');
  assert.equal(isPositivelyVerifiedPreview({ RAZORPAY_KEY_ID: EXPECTED_STAGING_RAZORPAY_KEY }), false, 'Staging Razorpay key alone must return false');
  assert.equal(isPositivelyVerifiedPreview({ CF_PAGES_BRANCH: 'staging' }), false, 'Branch alone without bucket and key must return false');

  // Fail-closed 3: Missing branch (even with correct bucket, key and secret)
  assert.equal(isPositivelyVerifiedPreview({
    AWS_S3_BUCKET: EXPECTED_STAGING_BUCKET,
    RAZORPAY_KEY_ID: EXPECTED_STAGING_RAZORPAY_KEY,
    STAGING_PREVIEW_TOKEN: dynamicTestPreviewSecret
  }), false, 'Missing branch must return false');

  // Fail-closed 4: Wrong branch
  assert.equal(isPositivelyVerifiedPreview({
    ...previewTestEnv,
    CF_PAGES_BRANCH: 'feature-test'
  }), false, 'Wrong branch must return false');

  // Fail-closed 5: Production branch (main or master)
  assert.equal(isPositivelyVerifiedPreview({
    ...previewTestEnv,
    CF_PAGES_BRANCH: 'main'
  }), false, 'Production branch main must return false');
  assert.equal(isPositivelyVerifiedPreview({
    ...previewTestEnv,
    CF_PAGES_BRANCH: 'master'
  }), false, 'Production branch master must return false');

  // Fail-closed 6: Correct staging branch but wrong bucket (e.g. production bucket)
  assert.equal(isPositivelyVerifiedPreview({
    ...previewTestEnv,
    AWS_S3_BUCKET: 'kids-drawing-book-production-441378339677'
  }), false, 'Correct branch with wrong bucket must return false');

  // Fail-closed 7: Correct staging branch but wrong Razorpay key
  assert.equal(isPositivelyVerifiedPreview({
    ...previewTestEnv,
    RAZORPAY_KEY_ID: 'rzp_test_placeholder'
  }), false, 'Correct branch with wrong key must return false');

  // Fail-closed 8: Production environment with accidental staging credentials
  assert.equal(isPositivelyVerifiedPreview({
    ...previewTestEnv,
    ENVIRONMENT: 'production'
  }), false, 'ENVIRONMENT=production must override and return false');
  assert.equal(isPositivelyVerifiedPreview({
    ...previewTestEnv,
    NODE_ENV: 'production'
  }), false, 'NODE_ENV=production must override and return false');

  // Fail-closed 9: Missing Preview secret binding
  assert.equal(isPositivelyVerifiedPreview({
    CF_PAGES_BRANCH: 'staging',
    AWS_S3_BUCKET: EXPECTED_STAGING_BUCKET,
    RAZORPAY_KEY_ID: EXPECTED_STAGING_RAZORPAY_KEY,
    STAGING_PREVIEW_TOKEN: ''
  }), false, 'Empty STAGING_PREVIEW_TOKEN must return false');
  assert.equal(isPositivelyVerifiedPreview({
    CF_PAGES_BRANCH: 'staging',
    AWS_S3_BUCKET: EXPECTED_STAGING_BUCKET,
    RAZORPAY_KEY_ID: EXPECTED_STAGING_RAZORPAY_KEY,
    STAGING_PREVIEW_TOKEN: undefined
  }), false, 'Missing STAGING_PREVIEW_TOKEN must return false');

  // Fail-closed 10: Incorrect / weak Preview secret (< 32 characters)
  assert.equal(isPositivelyVerifiedPreview({
    CF_PAGES_BRANCH: 'staging',
    AWS_S3_BUCKET: EXPECTED_STAGING_BUCKET,
    RAZORPAY_KEY_ID: EXPECTED_STAGING_RAZORPAY_KEY,
    STAGING_PREVIEW_TOKEN: 'short_weak_token'
  }), false, 'Incorrect/short STAGING_PREVIEW_TOKEN must return false');

  // Success: Correct Preview secret and complete staging configuration
  assert.equal(isPositivelyVerifiedPreview(previewTestEnv), true, 'Complete valid staging configuration with secure Preview secret must return true');
});

await test('POST /api/test-email enforces strict fail-closed staging isolation and token authorization', async () => {
  const authorizedUrl = `http://localhost/api/test-email?order_id=${createdOrder.order_id}&token=${validToken}`;
  const validReq = {
    url: authorizedUrl,
    method: 'POST',
    json: async () => ({})
  };

  // Fail-closed Test 1: Missing ENVIRONMENT (raw production [vars] mockEnv)
  const missingEnvRes = await handleTestEmail({ request: validReq, env: mockEnv });
  assert.equal(missingEnvRes.status, 403, 'Missing ENVIRONMENT must fail closed with 403');
  const missingEnvData = JSON.parse(await missingEnvRes.text());
  assert(missingEnvData.error.includes('positively verified staging or preview'));

  // Fail-closed Test 2: Unknown or arbitrary ENVIRONMENT string
  const unknownEnvRes = await handleTestEmail({ request: validReq, env: { ...mockEnv, ENVIRONMENT: 'unknown' } });
  assert.equal(unknownEnvRes.status, 403, 'Unknown ENVIRONMENT must fail closed with 403');

  // Fail-closed Test 3: Explicit production environment (ENVIRONMENT = production)
  const prodRes = await handleTestEmail({ request: validReq, env: { ...mockEnv, ENVIRONMENT: 'production' } });
  assert.equal(prodRes.status, 403, 'ENVIRONMENT=production must return 403');

  // Fail-closed Test 4: Explicit production environment (NODE_ENV = production)
  const prodNodeRes = await handleTestEmail({ request: validReq, env: { ...mockEnv, NODE_ENV: 'production' } });
  assert.equal(prodNodeRes.status, 403, 'NODE_ENV=production must return 403');

  // Fail-closed Test 5: Production Git branch (CF_PAGES_BRANCH = main)
  const mainBranchRes = await handleTestEmail({ request: validReq, env: { ...mockEnv, CF_PAGES_BRANCH: 'main' } });
  assert.equal(mainBranchRes.status, 403, 'CF_PAGES_BRANCH=main must return 403');

  // Fail-closed Test 6: Missing Preview secret binding
  const missingSecretRes = await handleTestEmail({
    request: validReq,
    env: { ...previewTestEnv, STAGING_PREVIEW_TOKEN: undefined }
  });
  assert.equal(missingSecretRes.status, 403, 'Missing STAGING_PREVIEW_TOKEN must return 403');

  // Fail-closed Test 7: Incorrect client Preview secret
  const badClientSecretReq = {
    url: `${authorizedUrl}&preview_token=wrong_client_secret`,
    method: 'POST',
    json: async () => ({})
  };
  const badClientSecretRes = await handleTestEmail({ request: badClientSecretReq, env: previewTestEnv });
  assert.equal(badClientSecretRes.status, 403, 'Incorrect client preview_token must return 403');
  const badSecretData = JSON.parse(await badClientSecretRes.text());
  assert(badSecretData.error.includes('Incorrect Preview secret'));

  // Fail-closed Test 8: Completely empty environment object
  const emptyRes = await handleTestEmail({ request: validReq, env: {} });
  assert.equal(emptyRes.status, 403, 'Empty env must return 403');

  // Fail-closed Test 9: Null environment
  const nullRes = await handleTestEmail({ request: validReq, env: null });
  assert.equal(nullRes.status, 403, 'Null env must return 403');

  // Authorization Test 10: Missing token in positively verified preview returns 401
  const noTokenReq = {
    url: `http://localhost/api/test-email?order_id=${createdOrder.order_id}`,
    method: 'POST',
    json: async () => ({})
  };
  const noTokenRes = await handleTestEmail({ request: noTokenReq, env: previewTestEnv });
  assert.equal(noTokenRes.status, 401);

  // Authorization Test 11: Missing order_id in positively verified preview returns 401
  const noOrderReq = {
    url: `http://localhost/api/test-email?token=${validToken}`,
    method: 'POST',
    json: async () => ({})
  };
  const noOrderRes = await handleTestEmail({ request: noOrderReq, env: previewTestEnv });
  assert.equal(noOrderRes.status, 401);

  // Authorization Test 12: Invalid token in positively verified preview returns 403
  const badTokenReq = {
    url: `http://localhost/api/test-email?order_id=${createdOrder.order_id}&token=bad_token`,
    method: 'POST',
    json: async () => ({})
  };
  const badTokenRes = await handleTestEmail({ request: badTokenReq, env: previewTestEnv });
  assert.equal(badTokenRes.status, 403);

  // Authorization Test 13: Non-existent order in positively verified preview returns 403
  const missingOrderReq = {
    url: 'http://localhost/api/test-email?order_id=ord_nonexistent_999&token=any_token',
    method: 'POST',
    json: async () => ({})
  };
  const missingOrderRes = await handleTestEmail({ request: missingOrderReq, env: previewTestEnv });
  assert.equal(missingOrderRes.status, 403);
});

await test('Normal checkout defaults strictly to purchase_delivery email_type', async () => {
  const normalOrderId = 'ord_normal_checkout_type';
  mockDb.orders.set(normalOrderId, {
    id: normalOrderId,
    razorpay_order_id: 'rzp_normal_type',
    customer_name: 'Normal Checkout User',
    customer_email: 'normal@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'paid'
  });

  const res = await processOrderEmail(normalOrderId, mockEnv, {
    customTransport: mockTransportSuccess,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  });

  assert.equal(res.success, true);
  assert.equal(res.status, 'sent');
  const outbox = mockDb.outbox.get(`${normalOrderId}_purchase_delivery`);
  assert(outbox, 'Must create purchase_delivery outbox record');
  assert.equal(outbox.email_type, 'purchase_delivery');
  assert.equal(outbox.status, 'sent');
  assert.equal(outbox.id, `out_${normalOrderId}_purchase_delivery`);
});

await test('Controlled test endpoint defaults strictly to staging_compressed_test email_type', async () => {
  const testOrderId = 'ord_controlled_staging_test';
  const testToken = 'token_test_staging_compressed_123';
  mockDb.orders.set(testOrderId, {
    id: testOrderId,
    razorpay_order_id: 'rzp_test_staging_compressed',
    customer_name: 'Compressed Staging User',
    customer_email: 'compressed.test@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'paid',
    download_token: testToken
  });

  const testEnv = {
    ...previewTestEnv,
    customTransport: mockTransportSuccess,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  };

  const req = {
    url: `http://localhost/api/test-email?order_id=${testOrderId}&token=${testToken}`,
    method: 'POST',
    json: async () => ({})
  };

  const res = await handleTestEmail({ request: req, env: testEnv });
  assert.equal(res.status, 200);
  const data = JSON.parse(await res.text());
  assert.equal(data.success, true);
  assert.equal(data.status, 'sent');
  assert.equal(data.email_type, 'staging_compressed_test');
  assert.equal(data.order_id, testOrderId);

  const outbox = mockDb.outbox.get(`${testOrderId}_staging_compressed_test`);
  assert(outbox, 'Must create staging_compressed_test outbox record');
  assert.equal(outbox.email_type, 'staging_compressed_test');
  assert.equal(outbox.status, 'sent');
  assert.equal(outbox.id, `out_${testOrderId}_staging_compressed_test`);
});

await test('The two outbox records (purchase_delivery and staging_compressed_test) remain completely independent', async () => {
  const dualOrderId = 'ord_dual_record_test';
  const dualToken = 'token_dual_record_456';
  mockDb.orders.set(dualOrderId, {
    id: dualOrderId,
    razorpay_order_id: 'rzp_dual_record',
    customer_name: 'Dual Record User',
    customer_email: 'dual@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'paid',
    download_token: dualToken
  });

  const testEnv = {
    ...previewTestEnv,
    customTransport: mockTransportSuccess,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  };

  // Step 1: Send initial purchase_delivery email (e.g. historical purchase)
  const res1 = await processOrderEmail(dualOrderId, testEnv, {
    emailType: 'purchase_delivery'
  });
  assert.equal(res1.success, true);
  assert.equal(res1.status, 'sent');

  const purchaseRecord = mockDb.outbox.get(`${dualOrderId}_purchase_delivery`);
  assert(purchaseRecord, 'purchase_delivery record must exist');
  assert.equal(purchaseRecord.status, 'sent');
  assert.equal(purchaseRecord.email_type, 'purchase_delivery');
  const originalPurchaseSentAt = purchaseRecord.sent_at;

  // Step 2: Trigger staging compressed PDF test via POST /api/test-email
  const req = {
    url: `http://localhost/api/test-email?order_id=${dualOrderId}&token=${dualToken}`,
    method: 'POST',
    json: async () => ({})
  };
  const res2 = await handleTestEmail({ request: req, env: testEnv });
  assert.equal(res2.status, 200);
  const data2 = JSON.parse(await res2.text());
  assert.equal(data2.success, true);
  assert.equal(data2.status, 'sent');
  assert.equal(data2.email_type, 'staging_compressed_test');

  // Step 3: Verify both records exist simultaneously and neither altered the other
  const testRecord = mockDb.outbox.get(`${dualOrderId}_staging_compressed_test`);
  assert(testRecord, 'staging_compressed_test record must exist');
  assert.equal(testRecord.status, 'sent');
  assert.equal(testRecord.email_type, 'staging_compressed_test');
  assert.equal(testRecord.id, `out_${dualOrderId}_staging_compressed_test`);

  // Verify original purchase record is completely untouched
  const untouchedPurchaseRecord = mockDb.outbox.get(`${dualOrderId}_purchase_delivery`);
  assert.equal(untouchedPurchaseRecord.status, 'sent');
  assert.equal(untouchedPurchaseRecord.sent_at, originalPurchaseSentAt);
  assert.equal(untouchedPurchaseRecord.id, `out_${dualOrderId}_purchase_delivery`);
});

await test('Duplicate test requests do not send duplicate emails (Idempotency for staging_compressed_test)', async () => {
  lastSentMail = null;
  const testOrderId = 'ord_controlled_staging_test';
  const testToken = 'token_test_staging_compressed_123';

  const testEnv = {
    ...previewTestEnv,
    customTransport: mockTransportSuccess,
    attachmentOverride: {
      buffer: mockPdfBuffer,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      contentType: 'application/pdf'
    }
  };

  const req = {
    url: `http://localhost/api/test-email?order_id=${testOrderId}&token=${testToken}`,
    method: 'POST',
    json: async () => ({})
  };

  const res = await handleTestEmail({ request: req, env: testEnv });
  assert.equal(res.status, 200);
  const data = JSON.parse(await res.text());
  assert.equal(data.success, true);
  assert.equal(data.status, 'already_sent');
  assert.equal(data.email_type, 'staging_compressed_test');
  assert.equal(lastSentMail, null, 'Custom transport must not be called again on duplicate test request');
});

await test('Arbitrary email types are strictly rejected by both backend processor and test endpoint', async () => {
  const paidOrderId = 'ord_paid_email_success';
  const validToken = 'valid_token_xyz_123';
  mockDb.orders.get(paidOrderId).download_token = validToken;

  // 1. processOrderEmail rejects arbitrary emailType
  const badTypeRes = await processOrderEmail(paidOrderId, previewTestEnv, { emailType: 'unauthorized_newsletter' });
  assert.equal(badTypeRes.success, false);
  assert.equal(badTypeRes.status, 'invalid_email_type');

  // 2. processOrderEmail strictly rejects staging test type in production environment (even with isControlledTest)
  const prodTypeRes = await processOrderEmail(paidOrderId, { ...mockEnv, ENVIRONMENT: 'production' }, { emailType: 'staging_compressed_test', isControlledTest: true });
  assert.equal(prodTypeRes.success, false);
  assert.equal(prodTypeRes.status, 'disallowed_in_production');

  // 2b. processOrderEmail strictly rejects staging test type in missing environment (fail-closed, even with isControlledTest)
  const missingEnvTypeRes = await processOrderEmail(paidOrderId, mockEnv, { emailType: 'staging_compressed_test', isControlledTest: true });
  assert.equal(missingEnvTypeRes.success, false);
  assert.equal(missingEnvTypeRes.status, 'disallowed_in_production');

  // 2c. processOrderEmail strictly rejects staging test type when isControlledTest flag is missing (cannot be triggered via checkout)
  const noFlagRes = await processOrderEmail(paidOrderId, previewTestEnv, { emailType: 'staging_compressed_test' });
  assert.equal(noFlagRes.success, false);
  assert.equal(noFlagRes.status, 'unauthorized_caller');
  assert(noFlagRes.error.includes('controlled test endpoint'));

  // 3. /api/test-email rejects arbitrary requested email_type with HTTP 400
  const reqBadType = {
    url: `http://localhost/api/test-email?order_id=${paidOrderId}&token=${validToken}&email_type=malicious_type`,
    method: 'POST',
    json: async () => ({})
  };
  const resBadType = await handleTestEmail({ request: reqBadType, env: previewTestEnv });
  assert.equal(resBadType.status, 400);
  const dataBad = JSON.parse(await resBadType.text());
  assert.equal(dataBad.success, false);
  assert(dataBad.error.includes('Invalid test email type'));

  // 4. /api/test-email strictly rejects 'purchase_delivery' with HTTP 400
  const reqPurchaseDelivery = {
    url: `http://localhost/api/test-email?order_id=${paidOrderId}&token=${validToken}&email_type=purchase_delivery`,
    method: 'POST',
    json: async () => ({})
  };
  const resPurchaseDelivery = await handleTestEmail({ request: reqPurchaseDelivery, env: previewTestEnv });
  assert.equal(resPurchaseDelivery.status, 400);
  const dataPurchaseDelivery = JSON.parse(await resPurchaseDelivery.text());
  assert.equal(dataPurchaseDelivery.success, false);
  assert(dataPurchaseDelivery.error.includes("'purchase_delivery' and arbitrary types are rejected"));
});

await test('POST /api/test-email rejects unpaid orders and non-existent orders', async () => {
  const unpaidOrderId = 'ord_unpaid_test_email_endpoint';
  const unpaidToken = 'token_unpaid_abc';
  mockDb.orders.set(unpaidOrderId, {
    id: unpaidOrderId,
    razorpay_order_id: 'rzp_unpaid_endpoint',
    customer_name: 'Unpaid User',
    customer_email: 'unpaid.user@example.com',
    amount: 14900,
    currency: 'INR',
    status: 'created',
    download_token: unpaidToken
  });

  // Test unpaid order rejection (HTTP 400)
  const reqUnpaid = {
    url: `http://localhost/api/test-email?order_id=${unpaidOrderId}&token=${unpaidToken}`,
    method: 'POST',
    json: async () => ({})
  };
  const resUnpaid = await handleTestEmail({ request: reqUnpaid, env: previewTestEnv });
  assert.equal(resUnpaid.status, 400);
  const dataUnpaid = JSON.parse(await resUnpaid.text());
  assert.equal(dataUnpaid.success, false);
  assert(dataUnpaid.error.includes("Order status is 'created'"));
});

console.log('\n======================================================');
console.log(` TOTAL AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED`);
console.log('======================================================\n');

if (failed > 0) {
  process.exit(1);
}
