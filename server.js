/**
 * Zero-dependency Local Development Server for Cloudflare Pages + Functions
 * Simulates Cloudflare Pages routing and Functions API locally using Node.js built-ins.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { onRequestGet as handleConfig } from './functions/api/config.js';
import { onRequestPost as handleCreateOrder } from './functions/api/create-order.js';
import { onRequestPost as handleVerifyPayment } from './functions/api/verify-payment.js';
import { onRequestPost as handleWebhook } from './functions/api/razorpay-webhook.js';
import { onRequestGet as handleDownload } from './functions/api/download.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8787;
const CLIENT_DIR = path.join(__dirname, 'client');

// Simulated Cloudflare env bindings
const mockEnv = {
  PRODUCT_PRICE: process.env.PRODUCT_PRICE || '149',
  PRODUCT_CURRENCY: process.env.PRODUCT_CURRENCY || 'INR',
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  AWS_REGION: process.env.AWS_REGION || 'ap-south-1',
  AWS_S3_BUCKET: process.env.AWS_S3_BUCKET || 'inkframepress-private-ebooks-442189079113-ap-south-1-an',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
  S3_PDF_KEY: 'Kids_Drawing_Book_Animals_School_Edition.pdf',
  DOWNLOAD_EXPIRY_SECONDS: '600',
  SUPPORT_EMAIL: 'trenzy.helpme@gmail.com'
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // 1. API Route Handling (Cloudflare Functions)
  if (pathname.startsWith('/api/')) {
    // Read body for POST
    let bodyBuffer = [];
    req.on('data', chunk => bodyBuffer.push(chunk));
    req.on('end', async () => {
      const rawBody = Buffer.concat(bodyBuffer).toString();
      const mockRequest = {
        url: `http://${req.headers.host}${req.url}`,
        method: req.method,
        headers: {
          get: (header) => req.headers[header.toLowerCase()]
        },
        json: async () => JSON.parse(rawBody || '{}'),
        text: async () => rawBody
      };

      let response = null;

      try {
        if (pathname === '/api/config' && req.method === 'GET') {
          response = await handleConfig({ request: mockRequest, env: mockEnv });
        } else if (pathname === '/api/create-order' && req.method === 'POST') {
          response = await handleCreateOrder({ request: mockRequest, env: mockEnv });
        } else if (pathname === '/api/verify-payment' && req.method === 'POST') {
          response = await handleVerifyPayment({ request: mockRequest, env: mockEnv });
        } else if (pathname === '/api/razorpay-webhook' && req.method === 'POST') {
          response = await handleWebhook({ request: mockRequest, env: mockEnv });
        } else if (pathname === '/api/download' && req.method === 'GET') {
          response = await handleDownload({ request: mockRequest, env: mockEnv });
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Endpoint not found' }));
          return;
        }

        // Send Cloudflare Response to Node ServerResponse
        const status = response.status || 200;
        const respHeaders = {};
        response.headers.forEach((v, k) => { respHeaders[k] = v; });
        const respBody = await response.text();

        res.writeHead(status, respHeaders);
        res.end(respBody);

      } catch (apiErr) {
        console.error('[API Error]:', apiErr);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: apiErr.message }));
      }
    });
    return;
  }

  // 2. Immediate Server-Side URL Redirects
  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { 'Location': '/ebook/', 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  if (pathname === '/ebook') {
    res.writeHead(301, { 'Location': '/ebook/', 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  if (pathname === '/thank-you') {
    res.writeHead(301, { 'Location': '/thank-you/', 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }

  // 3. Static File Serving (Cloudflare Pages)
  let filePath = path.join(CLIENT_DIR, pathname);

  // If path is a directory, look for index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  } else if (!fs.existsSync(filePath)) {
    if (pathname.startsWith('/assets/')) {
      // Do not fallback to HTML for missing static assets
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Asset Not Found');
      return;
    }
    // Try adding .html
    if (fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    } else {
      filePath = path.join(CLIENT_DIR, 'index.html');
    }
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const isHtml = ext === '.html';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` Kids Drawing Book Store running at:`);
  console.log(` -> http://127.0.0.1:${PORT}/ebook/   (Instant IPv4)`);
  console.log(` -> http://localhost:${PORT}/ebook/`);
  console.log(` -> http://127.0.0.1:${PORT}/thank-you/`);
  console.log(`======================================================\n`);
});

export default server;
