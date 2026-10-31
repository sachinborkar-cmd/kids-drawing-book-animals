import { getS3PresignedUrl } from './_aws_s3.js';

/**
 * GET /api/download
 * Verifies customer order and token against Cloudflare D1, then generates a temporary
 * AWS S3 presigned URL for private PDF download.
 */
export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get('order_id');
    const token = url.searchParams.get('token');
    const redirectMode = url.searchParams.get('redirect') === 'true';

    if (!orderId || !token) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Access denied. Order ID and verification token are required.'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let isAuthorized = false;
    let orderRecord = null;

    // Validate against Cloudflare D1
    if (env.DB) {
      try {
        orderRecord = await env.DB.prepare(`
          SELECT id, razorpay_order_id, status, download_token, customer_email, download_count
          FROM orders
          WHERE (id = ? OR razorpay_order_id = ?) AND download_token = ?
        `).bind(orderId, orderId, token).first();

        if (orderRecord && orderRecord.status === 'paid') {
          isAuthorized = true;
          // Increment download count
          await env.DB.prepare(`
            UPDATE orders
            SET download_count = download_count + 1,
                updated_at = datetime('now')
            WHERE id = ? OR razorpay_order_id = ?
          `).bind(orderId, orderId).run();
        }
      } catch (dbErr) {
        console.error('[D1 Download Auth Error]:', dbErr.message);
      }
    } else {
      // Development mode fallback when D1 is not attached locally
      console.warn('[Download API]: D1 database not bound. Allowing verified local dev token.');
      if (token && token.length >= 16) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid or expired download authorization. Please contact support if you completed payment.'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // AWS S3 Configuration
    const bucket = env.AWS_S3_BUCKET || 'inkframepress-private-ebooks-442189079113-ap-south-1-an';
    const region = env.AWS_REGION || 'ap-south-1';
    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;

    if (!accessKeyId || !secretAccessKey) {
      console.error('[Download Error]: AWS credentials not configured in environment bindings');
      return new Response(JSON.stringify({ error: 'Storage credentials not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const pdfKey = env.S3_PDF_KEY || 'Kids_Drawing_Book_Animals_School_Edition.pdf';
    const expirySeconds = parseInt(env.DOWNLOAD_EXPIRY_SECONDS || '600', 10);

    // Generate secure temporary presigned download URL (Valid for 10 minutes)
    const presignedUrl = await getS3PresignedUrl({
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      key: pdfKey,
      expiresInSeconds: expirySeconds,
      responseContentDisposition: 'attachment; filename="Kids_Drawing_Book_Animals_School_Edition.pdf"'
    });

    if (redirectMode) {
      return Response.redirect(presignedUrl, 302);
    }

    return new Response(JSON.stringify({
      success: true,
      download_url: presignedUrl,
      filename: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
      expires_in: expirySeconds
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      }
    });

  } catch (err) {
    console.error('[Download Handler Fatal Error]:', err);
    return new Response(JSON.stringify({
      success: false,
      error: 'An error occurred while generating secure download URL.'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
