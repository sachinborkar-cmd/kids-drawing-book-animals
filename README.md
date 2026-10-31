# Kids Drawing Book – Animals | Three-Step E-Book Selling Website

A professional, mobile-first, high-converting digital product selling funnel built specifically for Meta Ads (Facebook & Instagram) traffic with zero ongoing infrastructure costs.

---

## 1. System Architecture (Zero-Cost Infrastructure)

- **Frontend:** Cloudflare Pages (Fast global CDN, mobile-responsive, zero paid plugins).
- **Backend APIs:** Cloudflare Pages Functions / Cloudflare Workers (`functions/api/`).
- **Database:** Cloudflare D1 (`schema.sql`) for order records, signature verification, and webhook idempotency.
- **Private File Storage:** AWS S3 (`inkframepress-private-ebooks-442189079113-ap-south-1-an`) using secure, short-lived (30 min) AWS SigV4 presigned URLs.
- **Payment Processing:** Razorpay Standard Checkout (Cards, UPI, NetBanking, Wallets).
- **Analytics:** Integrated tracking for Meta Pixel, GA4, and Google Tag Manager (`PageView`, `ViewContent`, `InitiateCheckout`, `Purchase`).

---

## 2. Three-Step Customer Purchase Funnel

```text
Meta Ads (FB/IG) ──> Step 1: /ebook/ (Landing Page)
                           │
                           ▼
                     Step 2: Razorpay Checkout Modal
                           │ (Server-side HMAC verification + D1 order recording)
                           ▼
                     Step 3: /thank-you/ (Secure Download Page)
                           │ (Generates 30-min AWS SigV4 Presigned S3 URL)
                           ▼
                     Customer Downloads 22-Page PDF
```

### Step 1: Sales Landing Page (`/ebook/`)
- **Section A (Hero):** Headline *"Little Artists. Big Imagination!"*, 5 product highlights, primary and secondary CTAs, featuring the supplied 3D book mockup on children's workspace desk (`hero-mockup.jpg`).
- **Section B (Problem & Solution):** Three visual benefit cards (*Explore 13 Cute Animals*, *Colour, Create & Imagine*, *Fun Learning Activities*) and promotional banner (`promo-banner-animals.jpg`).
- **Section C (What's Inside):** High-resolution preview gallery with interactive Lightbox containing real pages extracted from the source PDF:
  - Page 6: Dog
  - Page 7: Giraffe
  - Page 8: Monkey
  - Page 10: Duck
  - Page 11: Lion
  - Page 12: Count & Color
  - Page 14: Rabbit
  - Page 15: Cat
  - Page 16: Dolphin
  - Page 19: Crocodile
  - Page 20: Connect the Dots
  - Page 21: My Favorite Animal
- **Section D (Product Benefits):** 4 feature cards (*13 Adorable Animals*, *Fun Colouring Activities*, *Interactive Learning Activities*, *Printable 22-Page PDF*) with promotional banner (`promo-banner-kids.jpg`).
- **Section E (How It Works):** 3 simple steps from purchase to colouring.
- **Section F (Pricing Offer):** Dedicated card with transparent 3D book mockup (`book-3d-isolated.jpg`), complete feature checklist, dynamic price injection, and primary *"BUY NOW"* CTA.
- **Section G (FAQ):** 8 expandable accordion questions and answers matching exact specifications.
- **Section H (Final CTA):** High-converting closing CTA with crocodile banner (`promo-banner-croc.jpg`).
- **Section I (Footer):** Legal navigation (`/legal/privacy.html`, `/legal/refund.html`, `/legal/terms.html`), copyright, and support contacts.
- **Mobile Sticky Purchase Bar:** Fixed bottom bar on mobile screens boosting conversions from Meta Ads traffic.

### Step 2: Payment Checkout (`functions/api/create-order.js` & `verify-payment.js`)
- Customer enters Name, Email, and Phone.
- `POST /api/create-order` creates order record in Cloudflare D1 with status `'created'`.
- Razorpay Checkout window opens with brand theme and prefilled customer info.
- On completion, `POST /api/verify-payment` verifies HMAC-SHA256 signature using Web Crypto API.
- Cloudflare D1 order is updated to `'paid'`, and a cryptographically secure `download_token` is generated.
- Webhook endpoint (`POST /api/razorpay-webhook`) ensures independent confirmation and prevents duplicate processing.

### Step 3: Thank You & Secure Download (`/thank-you/`)
- Access guard: Direct or unauthorized visits without valid `order_id` and `token` are blocked.
- Calls `GET /api/download?order_id=...&token=...`.
- Generates a 30-minute AWS SigV4 presigned download URL for `Kids_Drawing_Book_Animals_School_Edition.pdf`.
- Displays download instructions, printing tips, and customer support contact.

---

## 3. Directory Layout

```text
Ebook3step_Code/
├── client/                      # Cloudflare Pages static root
│   ├── index.html               # Canonical redirect to /ebook/
│   ├── ebook/
│   │   └── index.html           # Step 1: Sales Landing Page
│   ├── thank-you/
│   │   └── index.html           # Step 3: Thank You & Secure PDF Download
│   ├── legal/
│   │   ├── privacy.html         # Privacy Policy
│   │   ├── refund.html          # Refund Policy
│   │   └── terms.html           # Terms and Conditions
│   └── assets/
│       ├── css/style.css        # Warm, playful design system (#FFF8ED cream palette)
│       ├── js/
│       │   ├── config.js        # Central product & price configuration
│       │   ├── landing.js       # Lightbox gallery, FAQ accordion, UI triggers
│       │   ├── checkout.js      # Razorpay checkout & payment verification
│       │   ├── thank-you.js     # Token verification & S3 download link handler
│       │   └── analytics.js     # Meta Pixel, GA4, GTM tracking
│       └── images/
│           ├── hero-mockup.jpg          # Supplied creative asset 1
│           ├── book-3d-isolated.jpg     # Supplied creative asset 2
│           ├── promo-banner-animals.jpg # Supplied creative asset 3
│           ├── promo-banner-kids.jpg    # Supplied creative asset 4
│           ├── promo-banner-croc.jpg    # Supplied creative asset 5
│           ├── book-cover.png           # Extracted genuine PDF cover
│           └── previews/                # Extracted genuine PDF pages
├── functions/api/               # Cloudflare Pages Functions / Workers APIs
│   ├── _aws_s3.js               # AWS SigV4 Presigned URL generator (Web Crypto)
│   ├── config.js                # GET /api/config
│   ├── create-order.js          # POST /api/create-order
│   ├── verify-payment.js        # POST /api/verify-payment
│   ├── razorpay-webhook.js      # POST /api/razorpay-webhook
│   └── download.js              # GET /api/download
├── schema.sql                   # Cloudflare D1 SQL schema
├── wrangler.toml                # Cloudflare Pages configuration
├── server.js                    # Zero-dependency local development server
└── test/suite.js                # Automated verification test suite
```

---

## 4. Local Testing & Verification

Run the automated test suite:
```bash
npm test
```
*Output: 12 tests covering asset integrity, frontend copy, Cloudflare Functions, SigV4 generation, and security guards passed.*

Start the local server:
```bash
npm start
```
Open in your browser:
- Sales Landing Page: `http://localhost:8787/ebook/`
- Thank You Page: `http://localhost:8787/thank-you/`

---

## 5. Deployment Instructions (Cloudflare Pages + D1)

### Step A: Create Cloudflare D1 Database
```bash
npx wrangler d1 create kids-drawing-book-db
npx wrangler d1 execute kids-drawing-book-db --file=./schema.sql
```

### Step B: Configure Secrets in Cloudflare Pages
In Cloudflare Dashboard > Workers & Pages > Settings > Environment Variables:
- `RAZORPAY_KEY_ID`: Your Razorpay Key ID (`rzp_test_...` or `rzp_live_...`)
- `RAZORPAY_KEY_SECRET`: Your Razorpay Secret Key (Encrypted secret)
- `RAZORPAY_WEBHOOK_SECRET`: Your Razorpay Webhook secret (Encrypted secret)
- `AWS_ACCESS_KEY_ID`: Your AWS Access Key ID (e.g. `AKIA...`)
- `AWS_SECRET_ACCESS_KEY`: Your AWS Secret Access Key (Encrypted secret)
- `AWS_REGION`: `ap-south-1`
- `AWS_S3_BUCKET`: `inkframepress-private-ebooks-442189079113-ap-south-1-an`
- `S3_PDF_KEY`: `Kids_Drawing_Book_Animals_School_Edition.pdf`
- `PRODUCT_PRICE`: `149` (or your chosen price)

### Step C: Deploy to Cloudflare Pages
```bash
npx wrangler pages deploy client
```
Your website will be live globally on Cloudflare's free edge network!
