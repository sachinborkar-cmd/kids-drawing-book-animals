import { getS3PresignedUrl } from './_aws_s3.js';

/**
 * Escapes HTML characters to prevent XSS / HTML injection in customer email
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generates plain-text and HTML email content for purchased e-book delivery
 */
export function renderPurchaseEmail({ customerName, orderId, amount, currency }) {
  const safeName = customerName && customerName.trim() ? customerName.trim() : 'Valued Customer';
  const escapedName = escapeHtml(safeName);
  const safeOrderId = escapeHtml(orderId);
  const safeAmount = escapeHtml(amount || '149');
  const safeCurrency = escapeHtml(currency || 'INR');

  const subject = 'Your Kids Drawing Book is Ready! Order Confirmation';

  const text = [
    `Hello ${safeName},`,
    '',
    `Thank you for purchasing Kids Drawing Book – Animals!`,
    `Your payment of ₹${safeAmount} has been successfully received.`,
    '',
    `Order details:`,
    `- Product: Kids Drawing Book – Animals`,
    `- Amount: ₹${safeAmount}`,
    `- Currency: ${safeCurrency}`,
    `- Payment status: Successful`,
    `- Order ID: ${orderId}`,
    '',
    `Your purchased PDF is attached to this email.`,
    `We hope you enjoy drawing and learning with the animals!`,
    '',
    `Regards,`,
    `Kids Drawing Book Team`,
    `order.trenzystore@gmail.com`
  ].join('\r\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0; padding:0; background-color:#f8f9fa; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#2c3e50; line-height:1.6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f8f9fa; padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:600px; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.06); border:1px solid #eef2f5;" cellspacing="0" cellpadding="0">
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #FF914D 0%, #FF6B35 100%); padding:28px 24px; text-align:center;">
              <h1 style="color:#ffffff; margin:0; font-size:22px; font-weight:700; letter-spacing:-0.5px;">🎨 Kids Drawing Book – Animals</h1>
              <p style="color:rgba(255,255,255,0.92); margin:8px 0 0; font-size:14px;">Order Confirmation &amp; E-Book Delivery</p>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding:28px 24px;">
              <p style="font-size:16px; margin:0 0 16px;">Hello <strong>${escapedName}</strong>,</p>
              <p style="font-size:15px; margin:0 0 16px;">Thank you for purchasing <strong>Kids Drawing Book – Animals</strong>! Your payment of <strong>₹${safeAmount}</strong> has been successfully received.</p>
              
              <!-- Order Details Card -->
              <table role="presentation" width="100%" style="background-color:#fdfaf6; border:1px solid #fceadc; border-radius:8px; margin:20px 0; padding:16px;" cellspacing="0" cellpadding="0">
                <tr>
                  <td>
                    <h3 style="margin:0 0 12px; font-size:15px; color:#FF6B35; text-transform:uppercase; letter-spacing:0.5px;">Order Details</h3>
                    <table width="100%" cellspacing="0" cellpadding="4" style="font-size:14px;">
                      <tr>
                        <td style="color:#7f8c8d; width:40%;">Product:</td>
                        <td style="font-weight:600; color:#2c3e50;">Kids Drawing Book – Animals</td>
                      </tr>
                      <tr>
                        <td style="color:#7f8c8d;">Amount:</td>
                        <td style="font-weight:600; color:#2c3e50;">₹${safeAmount}</td>
                      </tr>
                      <tr>
                        <td style="color:#7f8c8d;">Currency:</td>
                        <td style="font-weight:600; color:#2c3e50;">${safeCurrency}</td>
                      </tr>
                      <tr>
                        <td style="color:#7f8c8d;">Payment status:</td>
                        <td style="font-weight:700; color:#27ae60;">Successful</td>
                      </tr>
                      <tr>
                        <td style="color:#7f8c8d;">Order ID:</td>
                        <td style="font-family:monospace; font-size:13px; color:#2c3e50;">${safeOrderId}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Attachment Notification -->
              <div style="background-color:#e8f4fd; border-left:4px solid #3498db; padding:14px 16px; border-radius:4px; margin:22px 0;">
                <p style="margin:0; font-size:14px; color:#2980b9; font-weight:600;">
                  📎 Your purchased PDF is attached to this email.
                </p>
                <p style="margin:4px 0 0; font-size:13px; color:#555;">
                  Filename: <code>Kids_Drawing_Book_Animals_School_Edition.pdf</code> (~1.2 MB)
                </p>
              </div>

              <p style="font-size:15px; margin:20px 0 24px;">We hope you enjoy drawing and learning with the animals!</p>
              
              <hr style="border:none; border-top:1px solid #eee; margin:24px 0;" />
              
              <p style="font-size:14px; color:#555; margin:0 0 4px;">Regards,</p>
              <p style="font-size:15px; font-weight:700; color:#2c3e50; margin:0 0 2px;">Kids Drawing Book Team</p>
              <p style="font-size:13px; color:#888; margin:0;"><a href="mailto:order.trenzystore@gmail.com" style="color:#FF914D; text-decoration:none;">order.trenzystore@gmail.com</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

/**
 * Downloads the private PDF from AWS S3 using SigV4 presigned URL
 */
export async function fetchPdfFromS3(env) {
  const bucket = (env.AWS_S3_BUCKET || env.Bucket || 'kids-drawing-book-staging-441378339677').trim();
  const region = (env.AWS_REGION || env.Region || 'ap-southeast-2').trim();
  const pdfKey = (env.S3_PDF_KEY || env.File || 'Kids_Drawing_Book_Animals_School_Edition.pdf').trim();
  const rawAccessKeyId = env.AWS_ACCESS_KEY_ID;
  const rawSecretAccessKey = env.AWS_SECRET_ACCESS_KEY;

  const accessKeyId = typeof rawAccessKeyId === 'string' ? rawAccessKeyId.trim() : '';
  const secretAccessKey = typeof rawSecretAccessKey === 'string' ? rawSecretAccessKey.trim() : '';

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS credentials missing for PDF attachment retrieval');
  }

  const presignedUrl = await getS3PresignedUrl({
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    key: pdfKey,
    expiresInSeconds: 300,
    responseContentDisposition: `attachment; filename="${pdfKey}"`
  });

  const res = await fetch(presignedUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch PDF from AWS S3: HTTP ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  const buffer = await res.arrayBuffer();

  if (!buffer || buffer.byteLength < 1000) {
    throw new Error('Retrieved PDF from AWS S3 is empty or unexpectedly small');
  }

  // Validate magic bytes (%PDF-)
  const headerBytes = new Uint8Array(buffer.slice(0, 5));
  const magic = String.fromCharCode(...headerBytes);
  if (magic !== '%PDF-') {
    throw new Error(`Retrieved file is not a valid PDF (header was: "${magic}")`);
  }

  return {
    buffer,
    filename: pdfKey,
    contentType: contentType.includes('pdf') ? contentType : 'application/pdf',
    size: buffer.byteLength
  };
}

/**
 * Low-level SMTP client using Cloudflare Workers TCP sockets (cloudflare:sockets) on port 465 (Implicit TLS)
 */
export async function sendSmtpEmail({
  host = 'smtp.gmail.com',
  port = 465,
  user,
  password,
  from = 'order.trenzystore@gmail.com',
  to,
  subject,
  text,
  html,
  attachment,
  customTransport
}) {
  if (typeof customTransport === 'function') {
    return await customTransport({ host, port, user, password, from, to, subject, text, html, attachment });
  }

  let connectSocket;
  try {
    const mod = await import('cloudflare:sockets');
    connectSocket = mod.connect;
  } catch (err) {
    throw new Error(`cloudflare:sockets runtime module not available: ${err.message}`);
  }

  if (!connectSocket) {
    throw new Error('TCP socket connector unavailable in this environment');
  }

  const cleanUser = typeof user === 'string' ? user.trim() : '';
  const cleanPass = typeof password === 'string' ? password.trim().replace(/\s+/g, '') : '';

  if (!cleanUser || !cleanPass) {
    throw new Error('SMTP credentials not configured (user or password missing)');
  }

  const socket = connectSocket(
    { hostname: host, port: Number(port) },
    { secureTransport: 'on' }
  );

  await socket.opened;
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let readBuffer = '';
  async function readReply() {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP connection closed unexpectedly by server');
      readBuffer += decoder.decode(value, { stream: true });
      const lines = readBuffer.split('\r\n');
      readBuffer = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/^(\d{3})(?: (.*))?$/);
        if (match) {
          return { code: parseInt(match[1], 10), message: match[2] || '', raw: line };
        }
      }
    }
  }

  async function sendCommand(cmd, expectedCodes) {
    await writer.write(encoder.encode(cmd + '\r\n'));
    const reply = await readReply();
    const validCodes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
    if (!validCodes.includes(reply.code)) {
      throw new Error(`SMTP command failed: [${cmd.split(' ')[0]}] returned ${reply.code} (expected ${validCodes.join('/')}): ${reply.message}`);
    }
    return reply;
  }

  try {
    // 1. Initial greeting
    const greeting = await readReply();
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting unexpected: ${greeting.code} ${greeting.message}`);
    }

    // 2. EHLO
    await sendCommand('EHLO localhost', 250);

    // 3. AUTH LOGIN
    await sendCommand('AUTH LOGIN', 334);
    await sendCommand(btoa(cleanUser), 334);
    await sendCommand(btoa(cleanPass), 235);

    // 4. Envelope MAIL FROM & RCPT TO
    await sendCommand(`MAIL FROM:<${from}>`, 250);
    await sendCommand(`RCPT TO:<${to}>`, [250, 251]);

    // 5. DATA
    await sendCommand('DATA', 354);

    // 6. Build & stream MIME payload
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const dateStr = new Date().toUTCString();
    const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2, 10)}@smtp.gmail.com>`;

    const mimeHeader = [
      `From: Kids Drawing Book <${from}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      `Date: ${dateStr}`,
      `Message-ID: ${messageId}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      '',
      text,
      '',
      `--${altBoundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      '',
      html,
      '',
      `--${altBoundary}--`,
      ''
    ].join('\r\n');

    await writer.write(encoder.encode(mimeHeader));

    // Attachment streaming
    if (attachment && attachment.buffer) {
      const attHeader = [
        `--${boundary}`,
        `Content-Type: ${attachment.contentType || 'application/pdf'}; name="${attachment.filename || 'Kids_Drawing_Book_Animals_School_Edition.pdf'}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${attachment.filename || 'Kids_Drawing_Book_Animals_School_Edition.pdf'}"`,
        '',
        ''
      ].join('\r\n');
      await writer.write(encoder.encode(attHeader));

      // Fast Base64 chunked conversion (48 KB chunk aligns with 3-byte Base64 blocks)
      const bytes = new Uint8Array(attachment.buffer);
      const CHUNK_SIZE = 48000;
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
        let binary = '';
        const subChunkSize = 8192;
        for (let j = 0; j < chunk.length; j += subChunkSize) {
          binary += String.fromCharCode.apply(null, chunk.subarray(j, Math.min(j + subChunkSize, chunk.length)));
        }
        const b64 = btoa(binary);
        let formatted = '';
        for (let k = 0; k < b64.length; k += 76) {
          formatted += b64.substring(k, k + 76) + '\r\n';
        }
        await writer.write(encoder.encode(formatted));
      }

      await writer.write(encoder.encode(`\r\n--${boundary}--\r\n`));
    }

    // End of message marker
    await sendCommand('.', 250);

    // Clean QUIT
    try {
      await sendCommand('QUIT', 221);
    } catch {
      // Non-fatal if server closes immediately after QUIT
    }

    return { success: true, messageId };
  } finally {
    try {
      await writer.close();
    } catch {}
    try {
      await socket.close();
    } catch {}
  }
}

/**
 * Allowed email types for post-purchase communications and testing
 */
export const ALLOWED_EMAIL_TYPES = Object.freeze(['purchase_delivery', 'staging_compressed_test']);

export const EXPECTED_STAGING_BUCKET = 'kids-drawing-book-staging-441378339677';
export const EXPECTED_STAGING_RAZORPAY_KEY = 'rzp_test_TuaqfpTw4hAqFw';

/**
 * Positively verifies whether the runtime environment is an authorized Preview / Staging environment.
 * Multi-factor verification: Requires ALL of the following criteria to be met simultaneously:
 * 1. Zero Production indicators (ENVIRONMENT !== 'production', NODE_ENV !== 'production', CF_PAGES_BRANCH !== 'main'/'master').
 * 2. Positively verified staging branch (CF_PAGES_BRANCH === 'staging').
 * 3. Exact matching Sydney staging bucket (AWS_S3_BUCKET === 'kids-drawing-book-staging-441378339677').
 * 4. Exact matching staging Razorpay key (RAZORPAY_KEY_ID === 'rzp_test_TuaqfpTw4hAqFw').
 * 5. Dedicated Preview-only encrypted secret binding (STAGING_PREVIEW_TOKEN) present, non-empty, and meeting minimum entropy requirements (>= 32 chars).
 *
 * Strictly fails closed if any required setting or secret binding is missing, empty, incorrect, or production.
 * No secret value is hardcoded in source code, printed to logs, or returned in API responses.
 */
export function isPositivelyVerifiedPreview(env) {
  if (!env || typeof env !== 'object') {
    return false;
  }

  // 1. Explicit production indicators immediately disqualify
  const envName = typeof env.ENVIRONMENT === 'string' ? env.ENVIRONMENT.trim().toLowerCase() : '';
  const nodeEnv = typeof env.NODE_ENV === 'string' ? env.NODE_ENV.trim().toLowerCase() : '';
  const pagesBranch = typeof env.CF_PAGES_BRANCH === 'string' ? env.CF_PAGES_BRANCH.trim() : '';

  if (
    envName === 'production' ||
    nodeEnv === 'production' ||
    pagesBranch.toLowerCase() === 'main' ||
    pagesBranch.toLowerCase() === 'master'
  ) {
    return false;
  }

  // 2. Branch verification: Must be explicitly 'staging'
  if (pagesBranch !== 'staging') {
    return false;
  }

  // 3. Staging bucket verification: Must match the Sydney staging bucket exactly
  const bucket = typeof env.AWS_S3_BUCKET === 'string' ? env.AWS_S3_BUCKET.trim() : (typeof env.Bucket === 'string' ? env.Bucket.trim() : '');
  if (bucket !== EXPECTED_STAGING_BUCKET) {
    return false;
  }

  // 4. Staging payment gateway verification: Must match the known staging Razorpay key ID exactly
  const rzpKey = typeof env.RAZORPAY_KEY_ID === 'string' ? env.RAZORPAY_KEY_ID.trim() : '';
  if (rzpKey !== EXPECTED_STAGING_RAZORPAY_KEY) {
    return false;
  }

  // 5. Dedicated Preview-only encrypted secret binding verification
  // Must be configured in Cloudflare Pages Preview secrets, non-empty, and >= 32 characters (high entropy)
  const previewSecret = typeof env.STAGING_PREVIEW_TOKEN === 'string' ? env.STAGING_PREVIEW_TOKEN.trim() : '';
  if (!previewSecret || previewSecret.length < 32) {
    return false;
  }

  return true;
}

/**
 * Idempotent post-purchase email processor using Cloudflare D1 email_outbox table
 */
export async function processOrderEmail(orderId, env, options = {}) {
  // Gate 0: Validate email type before ANY database, outbox, or SMTP operation
  const rawEmailType = options && options.emailType;
  const emailType = (typeof rawEmailType === 'string' && rawEmailType.trim())
    ? rawEmailType.trim()
    : 'purchase_delivery';

  if (!ALLOWED_EMAIL_TYPES.includes(emailType)) {
    console.error(`[Email Outbox]: Disallowed email_type '${emailType}' for order ${orderId}`);
    return { success: false, status: 'invalid_email_type', error: `Disallowed email type: ${emailType}` };
  }

  // Staging test email types require positive Preview verification AND controlled test invocation
  if (emailType === 'staging_compressed_test') {
    if (!options || options.isControlledTest !== true) {
      console.error(`[Email Outbox]: Test email type '${emailType}' rejected. It is exclusively permitted via the controlled test endpoint.`);
      return {
        success: false,
        status: 'unauthorized_caller',
        error: 'staging_compressed_test is exclusively permitted via the controlled test endpoint.'
      };
    }

    if (!isPositivelyVerifiedPreview(env)) {
      console.error(`[Email Outbox]: Test email type '${emailType}' rejected. Environment is not a positively verified preview/staging environment.`);
      return {
        success: false,
        status: 'disallowed_in_production',
        error: 'Test email types require a positively verified Preview environment.'
      };
    }
  }

  if (!env || !env.DB) {
    console.warn('[Email Outbox]: No D1 database bound. Skipping email processing.');
    return { success: false, status: 'no_db' };
  }

  // 1. Fetch order details from D1
  const order = await env.DB.prepare(`
    SELECT id, razorpay_order_id, customer_name, customer_email, amount, currency, status
    FROM orders
    WHERE id = ? OR razorpay_order_id = ?
  `).bind(orderId, orderId).first();

  if (!order) {
    console.error('[Email Outbox]: Order not found for id:', orderId);
    return { success: false, status: 'order_not_found' };
  }

  // Gate 1: Payment must be verified and status must be 'paid'
  if (order.status !== 'paid') {
    console.warn(`[Email Outbox]: Order ${order.id} status is '${order.status}' (not paid). Email will NOT be sent.`);
    return { success: false, status: 'order_not_paid' };
  }

  // Gate 2: Recipient email must be valid
  if (!order.customer_email || !order.customer_email.includes('@')) {
    console.error(`[Email Outbox]: Invalid customer email for order ${order.id}: ${order.customer_email}`);
    return { success: false, status: 'invalid_email' };
  }

  const outboxId = `out_${order.id}_${emailType}`;

  // 2. Check existing outbox record
  const outboxRec = await env.DB.prepare(`
    SELECT id, order_id, status, attempts, last_attempt_at FROM email_outbox
    WHERE order_id = ? AND email_type = ?
  `).bind(order.id, emailType).first();

  if (outboxRec) {
    if (outboxRec.status === 'sent') {
      console.info(`[Email Outbox]: Email already sent for order ${order.id}. Skipping.`);
      return { success: true, status: 'already_sent' };
    }
    if (outboxRec.status === 'processing') {
      const lastAttemptMs = outboxRec.last_attempt_at ? new Date(outboxRec.last_attempt_at).getTime() : 0;
      const isStale = lastAttemptMs > 0 && (Date.now() - lastAttemptMs > 5 * 60 * 1000);
      if (!isStale) {
        console.info(`[Email Outbox]: Email for order ${order.id} is actively in progress.`);
        return { success: true, status: 'in_progress' };
      }
      console.warn(`[Email Outbox]: Found stale processing record for order ${order.id} (older than 5m). Reclaiming.`);
    }
    if (outboxRec.attempts >= 3) {
      console.warn(`[Email Outbox]: Maximum retry attempts (3) exceeded for order ${order.id}.`);
      return { success: false, status: 'max_retries_exceeded' };
    }
  } else {
    // Insert initial pending record
    try {
      await env.DB.prepare(`
        INSERT INTO email_outbox (id, order_id, recipient_email, email_type, status, attempts)
        VALUES (?, ?, ?, ?, 'pending', 0)
      `).bind(outboxId, order.id, order.customer_email, emailType).run();
    } catch {
      // Conflict caught if another parallel request inserted simultaneously
    }
  }

  // 3. Atomically acquire processing lock (recovering stale processing if older than 5m)
  const lockResult = await env.DB.prepare(`
    UPDATE email_outbox
    SET status = 'processing',
        attempts = attempts + 1,
        last_attempt_at = datetime('now'),
        updated_at = datetime('now')
    WHERE order_id = ? AND email_type = ?
      AND (
        status = 'pending'
        OR status = 'failed'
        OR (status = 'processing' AND last_attempt_at < datetime('now', '-5 minutes'))
      )
      AND attempts < 3
  `).bind(order.id, emailType).run();

  if (!lockResult.meta || lockResult.meta.changes === 0) {
    console.info(`[Email Outbox]: Lock not acquired for order ${order.id}. Another worker is processing.`);
    return { success: true, status: 'lock_not_acquired' };
  }

  // 4. Dispatch Email
  try {
    const fromEmail = (env.SMTP_FROM_EMAIL || 'order.trenzystore@gmail.com').trim();
    const smtpUser = (env.SMTP_USER || fromEmail).trim();
    const smtpPass = (env.SMTP_PASSWORD || '').trim();
    const smtpHost = (env.SMTP_HOST || 'smtp.gmail.com').trim();
    const smtpPort = parseInt(env.SMTP_PORT || '465', 10);

    const activeTransport = options.customTransport || env.customTransport;
    const activeAttachment = options.attachmentOverride || env.attachmentOverride;

    // If SMTP_PASSWORD is not configured and no custom test transport provided, fail safely
    if (!smtpPass && !activeTransport) {
      throw new Error('SMTP credentials not configured (SMTP_PASSWORD missing in environment secrets)');
    }

    // Retrieve PDF from S3 (or use attachment override for unit tests)
    const attachment = activeAttachment || (await fetchPdfFromS3(env));

    const { text, html, subject } = renderPurchaseEmail({
      customerName: order.customer_name || 'Valued Customer',
      orderId: order.id,
      amount: (order.amount / 100).toFixed(0),
      currency: order.currency || 'INR'
    });

    const sendResult = await sendSmtpEmail({
      host: smtpHost,
      port: smtpPort,
      user: smtpUser,
      password: smtpPass,
      from: fromEmail,
      to: order.customer_email,
      subject,
      text,
      html,
      attachment,
      customTransport: activeTransport
    });

    // 5. Update outbox record to 'sent'
    await env.DB.prepare(`
      UPDATE email_outbox
      SET status = 'sent',
          sent_at = datetime('now'),
          error_message = NULL,
          updated_at = datetime('now')
      WHERE order_id = ? AND email_type = ?
    `).bind(order.id, emailType).run();

    console.info(`[Email Outbox]: Successfully sent purchase confirmation email for order ${order.id}`);
    return { success: true, status: 'sent', messageId: sendResult?.messageId };

  } catch (err) {
    console.error(`[Email Outbox Error for order ${order.id}]:`, err.message);

    // 6. Record failure in outbox - CRITICAL: Order status in 'orders' table remains 'paid'!
    await env.DB.prepare(`
      UPDATE email_outbox
      SET status = 'failed',
          error_message = ?,
          updated_at = datetime('now')
      WHERE order_id = ? AND email_type = ?
    `).bind(err.message.slice(0, 500), order.id, emailType).run();

    return { success: false, status: 'failed', error: err.message };
  }
}
