/**
 * Thank You & Secure Download Page Controller
 * Validates purchase token against Cloudflare Worker API and activates temporary AWS S3 download.
 */
document.addEventListener('DOMContentLoaded', async function() {
  'use strict';

  const urlParams = new URLSearchParams(window.location.search);
  const orderId = urlParams.get('order_id');
  const token = urlParams.get('token');

  const statusWrap = document.getElementById('download-status');
  const downloadBtn = document.getElementById('download-btn');
  const orderIdDisplay = document.getElementById('display-order-id');
  const unauthorizedNotice = document.getElementById('unauthorized-notice');
  const authorizedCard = document.getElementById('authorized-card');

  // Guard: Direct URL visit without order_id and token
  if (!orderId || !token) {
    if (authorizedCard) authorizedCard.style.display = 'none';
    if (unauthorizedNotice) unauthorizedNotice.style.display = 'block';
    return;
  }

  if (orderIdDisplay) {
    orderIdDisplay.textContent = orderId;
  }

  // Idempotent Purchase Event Tracking on Thank You Page
  if (window.Analytics && orderId) {
    window.Analytics.trackPurchase(
      orderId,
      window.PRODUCT_CONFIG?.pricing.price || 149,
      window.PRODUCT_CONFIG?.pricing.currency || 'INR'
    );
  }

  // Request fresh S3 presigned URL
  try {
    if (statusWrap) statusWrap.textContent = 'Generating your secure download link...';

    const res = await fetch(`/api/download?order_id=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`);
    const data = await res.json();

    if (!res.ok || !data.success || !data.download_url) {
      throw new Error(data.error || 'Your download token is invalid or expired.');
    }

    // Success: Activate download button
    if (downloadBtn) {
      downloadBtn.href = data.download_url;
      downloadBtn.setAttribute('download', data.filename || 'Kids_Drawing_Book_Animals_School_Edition.pdf');
      downloadBtn.style.display = 'inline-flex';
      downloadBtn.textContent = '📥 Download Activity Book PDF (22 Pages)';
    }

    if (statusWrap) {
      statusWrap.innerHTML = `
        <span style="color:#2b7a2b; font-weight:700;">✓ Ready to download!</span>
        <span style="display:block; font-size:0.8rem; color:#888; margin-top:4px;">Link active for 30 minutes. You can refresh anytime.</span>
      `;
    }

  } catch (err) {
    console.error('[Download Fetch Error]:', err);
    if (statusWrap) {
      statusWrap.innerHTML = `
        <span style="color:#c0392b; font-weight:700;">⚠️ ${err.message}</span>
        <p style="font-size:0.85rem; color:#666; margin-top:8px;">
          Need assistance? Email our support team at <a href="mailto:trenzy.helpme@gmail.com" style="color:#FF914D; text-decoration:underline;">trenzy.helpme@gmail.com</a> with Order ID <strong>${orderId}</strong>.
        </p>
      `;
    }
  }
});
