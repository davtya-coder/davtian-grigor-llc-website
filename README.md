# Davtian Grigor LLC Booking Website

Customer booking and secure card payment website for Davtian Grigor LLC.

## Secure configuration

Before production deployment, add `SQUARE_ACCESS_TOKEN` as an encrypted Cloudflare Worker secret. Never commit the token to this repository.

The browser uses Square Web Payments SDK. Card details are handled by Square and are not stored by this site.
