/**
 * Central Product & Store Configuration
 * Single source of truth for pricing, details, and feature flags.
 */
const PRODUCT_CONFIG = {
  id: 'kids-drawing-book-animals',
  title: 'Kids Drawing Book – Animals',
  subtitle: 'A School-Ready Coloring & Activity Book for Ages 3–12 Years',
  ageGroup: 'Ages 3–12 Years',
  pages: 22,
  animalsCount: 13,
  format: 'Printable Digital PDF',

  // Pricing configuration (Placeholder: easily adjusted)
  pricing: {
    currency: 'INR',
    currencySymbol: '₹',
    price: 149,          // Current selling price (INR)
    originalPrice: 299,  // Regular price
    get displayPrice() {
      return `${this.currencySymbol}${this.price}`;
    },
    get displayOriginalPrice() {
      return `${this.currencySymbol}${this.originalPrice}`;
    }
  },

  // Support contact
  support: {
    email: 'trenzy.helpme@gmail.com',
    brandName: 'Inkframe Press'
  },

  // Razorpay public key (Fetched dynamically from /api/config if available, or fallback to test key)
  razorpay: {
    keyId: 'rzp_test_51placeholderKey',
    companyName: 'Kids Drawing Book – Animals',
    themeColor: '#FF914D'
  },

  // Analytics placeholders (Can be injected or configured)
  analytics: {
    metaPixelId: '', // Set your Meta Pixel ID here e.g. '1234567890'
    ga4MeasurementId: '', // Set your GA4 ID here e.g. 'G-XXXXXXXXXX'
    gtmContainerId: '' // Set your GTM Container ID here e.g. 'GTM-XXXXXX'
  }
};

// Freeze to prevent accidental tampering
Object.freeze(PRODUCT_CONFIG);
if (typeof window !== 'undefined') {
  window.PRODUCT_CONFIG = PRODUCT_CONFIG;
}
