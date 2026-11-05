/**
 * AWS Signature Version 4 (SigV4) Presigned URL Generator for Cloudflare Workers
 * Uses native Web Crypto API (crypto.subtle) - Zero external dependencies.
 */

// Helper to compute SHA-256 hex string
async function sha256Hex(data) {
  const enc = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper to compute HMAC-SHA256 raw bytes
async function hmacRaw(key, data) {
  const keyObj = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', keyObj, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

// Helper to compute HMAC-SHA256 hex string
async function hmacHex(key, data) {
  const raw = await hmacRaw(key, data);
  return Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate AWS S3 GET Presigned URL
 */
export async function getS3PresignedUrl({
  bucket,
  region,
  accessKeyId,
  secretAccessKey,
  key,
  expiresInSeconds = 600,
  responseContentDisposition = 'attachment; filename="Kids_Drawing_Book_Animals_School_Edition.pdf"'
}) {
  const cleanAccessKeyId = typeof accessKeyId === 'string' ? accessKeyId.trim() : '';
  const cleanSecretAccessKey = typeof secretAccessKey === 'string' ? secretAccessKey.trim() : '';

  if (!cleanAccessKeyId || !cleanSecretAccessKey) {
    throw new Error('Missing AWS credentials for presigned URL generation');
  }

  const isMockKey = cleanAccessKeyId.startsWith('MOCK_');
  const validKeyPattern = isMockKey ? /^[A-Za-z0-9_]{16,40}$/ : /^(AKIA|ASIA)[A-Z0-9]{16}$/;
  if (!validKeyPattern.test(cleanAccessKeyId)) {
    throw new Error('Invalid AWS access key ID format');
  }

  if (cleanSecretAccessKey.length < 20) {
    throw new Error('Invalid AWS secret access key format');
  }

  const cleanBucket = (bucket || '').trim();
  const cleanRegion = (region || '').trim();
  const cleanKey = (key || '').trim();

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.substring(0, 8); // YYYYMMDD

  const host = `${cleanBucket}.s3.${cleanRegion}.amazonaws.com`;
  const canonicalUri = `/${encodeURIComponent(cleanKey).replace(/%2F/g, '/')}`;
  const credentialScope = `${dateStamp}/${cleanRegion}/s3/aws4_request`;

  // Query parameters in canonical alphabetical order
  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cleanAccessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': expiresInSeconds.toString(),
    'X-Amz-SignedHeaders': 'host'
  };

  if (responseContentDisposition) {
    queryParams['response-content-disposition'] = responseContentDisposition;
  }

  const sortedKeys = Object.keys(queryParams).sort();
  const canonicalQueryString = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const canonicalRequestHash = await sha256Hex(canonicalRequest);

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');

  // Derive signing key: HMAC(HMAC(HMAC(HMAC('AWS4' + Secret, Date), Region), Service), 'aws4_request')
  const kDate = await hmacRaw(`AWS4${cleanSecretAccessKey}`, dateStamp);
  const kRegion = await hmacRaw(kDate, cleanRegion);
  const kService = await hmacRaw(kRegion, 's3');
  const kSigning = await hmacRaw(kService, 'aws4_request');

  const signature = await hmacHex(kSigning, stringToSign);

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * Verify Razorpay HMAC-SHA256 Signature
 */
export async function verifyRazorpaySignature(orderId, paymentId, signature, secret) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const data = `${orderId}|${paymentId}`;
  const expectedSignature = await hmacHex(secret, data);
  return expectedSignature.toLowerCase() === signature.toLowerCase();
}
