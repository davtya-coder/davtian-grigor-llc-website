# Davtian Grigor LLC Booking Website

Cloudflare Workers booking workflow for the 2025 BMW X5:

1. Google Maps route estimate and emailed ride request.
2. Private owner approval or decline.
3. Single-booking payment link with owner-authorized $10, $20, or full-payment options.
4. Square Web Payments SDK or Zelle business transfer.
5. Manual owner verification for Zelle and payment confirmations.

The customer never creates an account. Card fields are hosted by Square; this Worker never receives or stores full card details.

## Pricing

The production defaults are:

- $25 base fare
- $2.50 per route mile
- $0.75 per Google route minute
- $70 minimum

The estimate is rounded up to the next whole dollar. The owner can change all four values from `/admin.html` without changing source code. With the defaults, 16.3 miles and 46 minutes is $101.

## Cloudflare resources

Create the D1 database once, copy its ID into `wrangler.jsonc`, and apply migrations:

```sh
npx wrangler d1 create davtian-bookings
npx wrangler d1 migrations apply DB --remote
```

Required encrypted Worker secrets:

- `GOOGLE_MAPS_API_KEY`
- `SQUARE_ACCESS_TOKEN`
- `ADMIN_PASSWORD`
- `SESSION_SECRET` (a long random value)

The Google key stays server-side and should be API-restricted to the Google Routes API (and Places API if autocomplete is enabled). The Square token must be the production token matching application `sq0idp-mn4whAbG0YQAFvNlqwHRJw` and location `LWWHWQ4CTYKWG`.

## Transactional email

The Worker supports either:

- Cloudflare Email Service: bind it as `EMAIL` and set `EMAIL_FROM` to an address on an onboarded sender domain; or
- Resend: set `RESEND_API_KEY` and `RESEND_FROM`.

`davtya@gmail.com` is the default owner recipient. The private dashboard displays whether email delivery is configured.

## Verification

```sh
npm ci
npm run check
npm test
npx wrangler deploy --dry-run
```

The integration test covers request creation, owner approval, allowed payment amounts, Square idempotency, Zelle pending status, manual Zelle verification, and remaining balances.
