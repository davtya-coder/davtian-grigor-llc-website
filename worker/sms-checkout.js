import { cleanText, json, normalizeEmail, normalizePhone, randomReference, readJson, sha256, signPayload, verifyPayload } from "./lib.js";

export const SMS_ARRANGEMENT = "SMS agreement reported by customer";

export function agreedAmountCents(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [dollars, fraction = ""] = text.split(".");
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 1000 && cents <= 5_000_000 ? cents : null;
}

export async function createSmsCheckout(request, env) {
  const input = await readJson(request);
  if (input.smsConfirmed !== true || input.termsAccepted !== true) {
    return json({ ok: false, message: "Receive Grigor's SMS confirmation of the pickup time and price before paying, then accept the booking terms." }, 400);
  }
  const quote = await verifyPayload(cleanText(input.quoteToken, 6000), env.SESSION_SECRET);
  if (!quote?.nonce || !quote.estimatedPriceCents) return json({ ok: false, message: "Please calculate the route again. Your agreed payment amount can stay the same." }, 400);
  if (Date.parse(quote.pickupAtIso) < Date.now() - 5 * 60_000) return json({ ok: false, message: "Please check the pickup date and time." }, 400);
  const amountCents = agreedAmountCents(input.agreedAmount);
  const firstName = cleanText(input.firstName, 60);
  const lastName = cleanText(input.lastName, 60);
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  if (!amountCents || !firstName || !lastName || !phone || (input.email && !email)) {
    return json({ ok: false, message: "Enter your name, phone number and the agreed payment amount of at least $10." }, 400);
  }
  const expires = Number(quote.exp) + 14 * 24 * 60 * 60;
  const token = await signPayload({ purpose: "sms-checkout", nonce: quote.nonce, exp: expires }, env.SESSION_SECRET);
  const tokenHash = await sha256(token);
  let row = await env.DB.prepare("SELECT * FROM bookings WHERE quote_nonce = ?").bind(quote.nonce).first();
  if (row && row.arrangement_method !== SMS_ARRANGEMENT) return json({ ok: false, message: "This request already has a separate booking. Please contact Grigor before paying." }, 409);
  if (!row) {
    for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO bookings (
          reference, quote_nonce, status, pickup_address, destination_address, pickup_date, pickup_time,
          pickup_at_iso, distance_miles, duration_seconds, static_duration_seconds, traffic_condition,
          price_breakdown_json, estimated_price_cents, final_price_cents, contact_type, contact_value,
          arrangement_method, approval_token_hash, approval_token_expires_at, allowed_payment_options_json,
          first_name, last_name, phone, email
        ) VALUES (?, ?, 'APPROVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'phone', ?, ?, ?, ?, '["full"]', ?, ?, ?, ?)
      `).bind(
        randomReference(), quote.nonce, quote.pickupAddress, quote.destinationAddress, quote.pickupDate, quote.pickupTime,
        quote.pickupAtIso, quote.distanceMiles, quote.durationSeconds, quote.staticDurationSeconds || null,
        quote.trafficCondition || null, JSON.stringify(quote.priceBreakdown), quote.estimatedPriceCents, amountCents,
        phone, SMS_ARRANGEMENT, tokenHash, new Date(expires * 1000).toISOString(), firstName, lastName, phone, email || null,
      ).run();
      row = await env.DB.prepare("SELECT * FROM bookings WHERE quote_nonce = ?").bind(quote.nonce).first();
    }
    if (!row) throw new Error("Booking could not be saved.");
    await env.DB.prepare("INSERT INTO booking_events (booking_id, event_type, actor, details_json) VALUES (?, 'SMS_AGREEMENT_REPORTED', 'customer', ?)")
      .bind(row.id, JSON.stringify({ agreedAmountCents: amountCents, ownerSmsVerifiedByWebsite: false })).run();
  }
  if (row.approval_token_hash !== tokenHash || ["DECLINED", "CANCELLED", "REFUNDED"].includes(row.status)) {
    return json({ ok: false, message: "This booking is not available for payment. Please contact Grigor." }, 409);
  }
  if (row.status === "APPROVED" && !row.payment_method && !row.payment_id) {
    await env.DB.prepare(`
      UPDATE bookings SET final_price_cents = ?, first_name = ?, last_name = ?, phone = ?, contact_value = ?, email = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'APPROVED' AND payment_method IS NULL AND payment_id IS NULL
    `).bind(amountCents, firstName, lastName, phone, phone, email || null, row.id).run();
    row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(row.id).first();
  }
  if (Number(row.final_price_cents) !== amountCents) {
    return json({ ok: false, message: "A payment is already in progress for a different amount. Please contact Grigor before making another payment." }, 409);
  }
  return json({ ok: true, token, reference: row.reference, agreedAmount: amountCents / 100, status: row.status });
}
