/**
 * Kids Drawing Book – Landing Page Interactions
 * Lightbox, FAQ accordion, dynamic price injection, and CTA events.
 */
document.addEventListener('DOMContentLoaded', function() {
  'use strict';

  // 1. Inject Dynamic Config Pricing
  if (window.PRODUCT_CONFIG) {
    const p = window.PRODUCT_CONFIG;
    document.querySelectorAll('[data-product-price]').forEach(el => {
      el.textContent = p.pricing.displayPrice;
    });
    document.querySelectorAll('[data-original-price]').forEach(el => {
      el.textContent = p.pricing.displayOriginalPrice;
    });
    document.querySelectorAll('[data-product-title]').forEach(el => {
      el.textContent = p.title;
    });
  }

  // 2. Track ViewContent event for Meta Ads / GA4
  if (window.Analytics) {
    window.Analytics.trackViewContent();
  }

  // 3. FAQ Accordion
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const questionBtn = item.querySelector('.faq-question');
    if (!questionBtn) return;
    questionBtn.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      // Close other items
      faqItems.forEach(other => other.classList.remove('open'));
      if (!isOpen) {
        item.classList.add('open');
      }
    });
  });

  // 4. Gallery Lightbox Functionality
  const galleryItems = document.querySelectorAll('.gallery-item');
  const lightbox = document.getElementById('lightbox-modal');
  const lightboxImgWrap = document.getElementById('lightbox-content');
  const lightboxTitle = document.getElementById('lightbox-title');
  const closeBtn = document.getElementById('lightbox-close');
  const prevBtn = document.getElementById('lightbox-prev');
  const nextBtn = document.getElementById('lightbox-next');

  let currentIndex = 0;
  const itemsData = [];

  galleryItems.forEach((item, index) => {
    const src = item.getAttribute('data-full-src') || item.querySelector('img, svg')?.getAttribute('src');
    const title = item.getAttribute('data-title') || 'Book Preview';
    const isSvg = src && src.endsWith('.svg');
    itemsData.push({ src, title, isSvg, element: item });

    item.addEventListener('click', () => {
      openLightbox(index);
    });
  });

  function openLightbox(index) {
    if (!lightbox || !itemsData[index]) return;
    currentIndex = index;
    renderLightboxItem();
    lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('active');
    document.body.style.overflow = '';
  }

  function renderLightboxItem() {
    const data = itemsData[currentIndex];
    if (!data) return;
    if (lightboxTitle) lightboxTitle.textContent = data.title;
    if (lightboxImgWrap) {
      lightboxImgWrap.innerHTML = `<img src="${data.src}" alt="${data.title}" style="max-height:70vh; width:auto; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.15);" />`;
    }
  }

  if (closeBtn) closeBtn.addEventListener('click', closeLightbox);
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      currentIndex = (currentIndex - 1 + itemsData.length) % itemsData.length;
      renderLightboxItem();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      currentIndex = (currentIndex + 1) % itemsData.length;
      renderLightboxItem();
    });
  }

  // Close on outside click
  if (lightbox) {
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLightbox();
    });
  }

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (!lightbox || !lightbox.classList.contains('active')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft' && prevBtn) prevBtn.click();
    if (e.key === 'ArrowRight' && nextBtn) nextBtn.click();
  });

  // 5. Connect Buy Now CTAs to Checkout Modal
  document.querySelectorAll('[data-buy-trigger]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.Checkout && typeof window.Checkout.openModal === 'function') {
        window.Checkout.openModal();
      } else {
        // Fallback: smooth scroll to pricing card
        const pricing = document.getElementById('pricing');
        if (pricing) pricing.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
});
