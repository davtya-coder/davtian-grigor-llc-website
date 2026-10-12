import {
  BUSINESS,
  clampInteger,
  cleanText,
  clearAdminCookie,
  constantTimeEqual,
  createAdminCookie,
  csvEscape,
  isAdmin,
  json,
  money,
  normalizeEmail,
  normalizePhone,
  parseDuration,
  randomReference,
  randomToken,
  readJson,
  sameOrigin,
  sha256,
  signPayload,
  trafficLabel,
  verifyPayload,
  withSecurityHeaders,
} from "./lib.js";
import {
  notifyCustomerApproved,
  notifyCustomerDeclined,
  notifyOwnerOfRequest,
  notifyOwnerOfZellePending,
  sendEmail,
  sendPaymentConfirmations,
} from "./notifications.js";
import { BookingStore, withBookingDatabase } from "./storage.js";

export { BookingStore };

const MAX_PRICE_CENTS = 5_000_000;
const QUOTE_LIFETIME_SECONDS = 30 * 60;
const APPROVAL_LINK_DAYS = 14;
const STATUSES = new Set(["REQUESTED", "APPROVED", "DECLINED", "PAYMENT_PROCESSING", "CONFIRMED", "CANCELLED", "REFUNDED"]);

function requireDatabase(env) {
  if (!env.DB) throw new Error("DATABASE_NOT_CONFIGURED");
}

async function settings(env) {
  requireDatabase(env);
  const row = await env.DB.prepare("SELECT * FROM settings WHERE id = 1").first();
  if (!row) throw new Error("SETTINGS_NOT_FOUND");
  return row;
}

function publicConfig(row, env) {
  return {
    businessName: row.business_name,
    vehicleName: BUSINESS.vehicle,
    tcpNumber: row.tcp_number,
    squareApplicationId: BUSINESS.squareApplicationId,
    squareLocationId: BUSINESS.squareLocationId,
    termsVersion: BUSINESS.termsVersion,
    services: {
      mapsReady: Boolean(env.GOOGLE_MAPS_API_KEY),
      emailReady: Boolean((env.RESEND_API_KEY && env.RESEND_FROM) || (env.EMAIL && env.EMAIL_FROM)),
      smsReady: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER),
      paymentsReady: Boolean(env.SQUARE_ACCESS_TOKEN || env.SQUARE_ACCESS_TOKE),
    },
    pricing: {
      baseFare: row.base_fare_cents / 100,
      perMile: row.per_mile_cents / 100,
      perMinute: row.per_minute_cents / 100,
      minimumPrice: row.minimum_price_cents / 100,
    },
  };
}

function squareAccessToken(env) {
  return env.SQUARE_ACCESS_TOKEN || env.SQUARE_ACCESS_TOKE || "";
}

function waypoint(address, placeId) {
  return placeId ? { placeId } : { address };
}

async function googleRoute(env, trip) {
  if (!env.GOOGLE_MAPS_API_KEY) throw new Error("MAPS_NOT_CONFIGURED");
  const routeBody = {
    origin: waypoint(trip.pickupAddress, trip.pickupPlaceId),
    destination: waypoint(trip.destinationAddress, trip.destinationPlaceId),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    computeAlternativeRoutes: false,
    languageCode: "en-US",
    units: "IMPERIAL",
  };
  const pickupTimestamp = Date.parse(trip.pickupAtIso);
  if (Number.isFinite(pickupTimestamp) && pickupTimestamp > Date.now() && pickupTimestamp < Date.now() + 100 * 24 * 60 * 60 * 1000) {
    routeBody.departureTime = trip.pickupAtIso;
  }
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GOOGLE_MAPS_API_KEY,
      "x-goog-fieldmask": "routes.distanceMeters,routes.duration,routes.staticDuration",
      "referer": "https://davtian-grigor-llc-website.davtya.workers.dev/",
    },
    body: JSON.stringify(routeBody),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.routes?.[0]) {
    console.error("Routes API failed", response.status, JSON.stringify(result).slice(0, 500));
    throw new Error("ROUTE_NOT_FOUND");
  }
  const route = result.routes[0];
  const durationSeconds = parseDuration(route.duration);
  const staticDurationSeconds = parseDuration(route.staticDuration);
  return {
    distanceMiles: Number((Number(route.distanceMeters) / 1609.344).toFixed(1)),
    durationSeconds,
    staticDurationSeconds,
    trafficCondition: trafficLabel(durationSeconds, staticDurationSeconds),
  };
}

function containsAirport(...addresses) {
  return addresses.some(address => /\b(airport|lax|bur|burbank|sna|john wayne|lgb|long beach airport|ont|ontario international)\b/i.test(address));
}

function calculatePrice(row, trip, route) {
  const minutes = Math.max(1, Math.ceil(route.durationSeconds / 60));
  const baseFareCents = Number(row.base_fare_cents);
  const mileageCents = Math.round(route.distanceMiles * Number(row.per_mile_cents));
  const timeCents = Math.round(minutes * Number(row.per_minute_cents));
  const rawTotalCents = baseFareCents + mileageCents + timeCents;
  const minimumApplied = rawTotalCents < Number(row.minimum_price_cents);
  const totalCents = Math.ceil(Math.max(Number(row.minimum_price_cents), rawTotalCents) / 100) * 100;
  return {
    totalCents,
    breakdown: {
      baseFareCents,
      minutes,
      timeCents,
      perMinuteCents: Number(row.per_minute_cents),
      perMileCents: Number(row.per_mile_cents),
      mileageCents,
      minimumPriceCents: Number(row.minimum_price_cents),
      minimumApplied,
    },
  };
}

function validateTrip(input) {
  const pickupAddress = cleanText(input.pickupAddress, 300);
  const pickupPlaceId = cleanText(input.pickupPlaceId, 180);
  const destinationAddress = cleanText(input.destinationAddress, 300);
  const destinationPlaceId = cleanText(input.destinationPlaceId, 180);
  const pickupDate = cleanText(input.pickupDate, 10);
  const pickupTime = cleanText(input.pickupTime, 5);
  const pickupAtIso = cleanText(input.pickupAtIso, 40);
  if (!pickupAddress || !destinationAddress || !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate) || !/^\d{2}:\d{2}$/.test(pickupTime)) {
    return null;
  }
  const pickupTimestamp = Date.parse(pickupAtIso);
  if (!pickupAtIso || !Number.isFinite(pickupTimestamp) || pickupTimestamp < Date.now() - 5 * 60 * 1000) return null;
  return { pickupAddress, pickupPlaceId, destinationAddress, destinationPlaceId, pickupDate, pickupTime, pickupAtIso };
}

async function autocomplete(request, env) {
  if (!env.GOOGLE_MAPS_API_KEY) return json({ ok: false, message: "Address search is not configured yet." }, 503);
  const input = await readJson(request);
  const query = cleanText(input.input, 160);
  const sessionToken = cleanText(input.sessionToken, 80);
  if (query.length < 3 || !sessionToken) return json({ ok: true, suggestions: [] });
  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GOOGLE_MAPS_API_KEY,
      "x-goog-fieldmask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text",
      "referer": "https://davtian-grigor-llc-website.davtya.workers.dev/",
    },
    body: JSON.stringify({
      input: query,
      sessionToken,
      includedRegionCodes: ["us"],
      languageCode: "en",
      locationBias: { circle: { center: { latitude: 34.0522, longitude: -118.2437 }, radius: 100000 } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Places API failed", response.status, JSON.stringify(result).slice(0, 500));
    return json({ ok: false, message: "Address search is temporarily unavailable." }, 502);
  }
  const suggestions = (result.suggestions || []).map(item => item.placePrediction).filter(Boolean).slice(0, 6).map(item => ({
    placeId: item.placeId,
    text: item.text?.text || "",
  })).filter(item => item.placeId && item.text);
  return json({ ok: true, suggestions });
}

async function createQuote(request, env) {
  const trip = validateTrip(await readJson(request));
  if (!trip) return json({ ok: false, message: "Please enter a valid pickup, destination, date, and time." }, 400);
  const row = await settings(env);
  let route;
  try {
    route = await googleRoute(env, trip);
  } catch (error) {
    const message = error.message === "MAPS_NOT_CONFIGURED"
      ? "Google Maps pricing is not configured yet."
      : "We could not calculate this route. Please select both addresses from the suggestions and try again.";
    return json({ ok: false, message }, error.message === "MAPS_NOT_CONFIGURED" ? 503 : 400);
  }
  const price = calculatePrice(row, trip, route);
  const quote = {
    nonce: randomToken(16),
    ...trip,
    ...route,
    estimatedPriceCents: price.totalCents,
    priceBreakdown: price.breakdown,
    exp: Math.floor(Date.now() / 1000) + QUOTE_LIFETIME_SECONDS,
  };
  const quoteToken = await signPayload(quote, env.SESSION_SECRET);
  return json({
    ok: true,
    quoteToken,
    vehicle: BUSINESS.vehicle,
    distanceMiles: route.distanceMiles,
    durationMinutes: Math.ceil(route.durationSeconds / 60),
    normalDurationMinutes: route.staticDurationSeconds ? Math.ceil(route.staticDurationSeconds / 60) : null,
    trafficCondition: route.trafficCondition,
    estimatedPrice: price.totalCents / 100,
    breakdown: {
      baseFare: price.breakdown.baseFareCents / 100,
      time: price.breakdown.timeCents / 100,
      mileage: price.breakdown.mileageCents / 100,
      minimumApplied: price.breakdown.minimumApplied,
    },
  });
}

async function audit(env, bookingId, eventType, actor, details = {}) {
  await env.DB.prepare("INSERT INTO booking_events (booking_id, event_type, actor, details_json) VALUES (?, ?, ?, ?)")
    .bind(bookingId, eventType, actor, JSON.stringify(details)).run();
}

async function notifyBookingRequest(request, env, booking, status = 200) {
  const sent = await env.DB.prepare("SELECT id FROM booking_events WHERE booking_id = ? AND event_type = 'OWNER_NOTIFIED' LIMIT 1")
    .bind(booking.id).first();
  if (sent) return json({ ok: true, reference: booking.reference, ownerNotified: true });
  const notification = await notifyOwnerOfRequest(env, booking, new URL(request.url).origin, (await settings(env)).owner_email).catch(error => {
    console.error("Owner notification failed", error);
    return { sent: false, reason: "Email delivery failed." };
  });
  await audit(env, booking.id, notification.sent ? "OWNER_NOTIFIED" : "OWNER_NOTIFICATION_PENDING", "system", notification);
  if (!notification.sent) {
    return json({
      ok: false,
      reference: booking.reference,
      requestSaved: true,
      ownerNotified: false,
      message: `Request ${booking.reference} is saved, but the email could not be sent. Please retry sending the email below.`,
    }, 503);
  }
  return json({ ok: true, reference: booking.reference, ownerNotified: true }, status);
}

async function createBookingRequest(request, env) {
  requireDatabase(env);
  const input = await readJson(request);
  if (cleanText(input.company, 100)) return json({ ok: true, reference: "RECEIVED" }, 201);
  const quote = await verifyPayload(cleanText(input.quoteToken, 6000), env.SESSION_SECRET);
  if (!quote?.nonce || !quote.estimatedPriceCents) return json({ ok: false, message: "This estimate expired. Please calculate the trip again." }, 400);
  const contactType = "email";
  const contactValue = normalizeEmail(input.contactValue || input.email);
  if (!contactValue) return json({ ok: false, message: "Please enter a valid email address." }, 400);
  const existing = await env.DB.prepare("SELECT * FROM bookings WHERE quote_nonce = ?").bind(quote.nonce).first();
  if (existing) return notifyBookingRequest(request, env, existing);
  let reference;
  let result;
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? await sha256(`${ip}:${env.SESSION_SECRET || ""}`) : "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    reference = randomReference();
    try {
      result = await env.DB.prepare(`
        INSERT INTO bookings (
          reference, quote_nonce, pickup_address, pickup_place_id, destination_address, destination_place_id,
          pickup_date, pickup_time, pickup_at_iso, distance_miles, duration_seconds, static_duration_seconds,
          traffic_condition, price_breakdown_json, estimated_price_cents, contact_type, contact_value,
          request_ip_hash, request_user_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        reference, quote.nonce, quote.pickupAddress, quote.pickupPlaceId || null,
        quote.destinationAddress, quote.destinationPlaceId || null, quote.pickupDate, quote.pickupTime,
        quote.pickupAtIso, quote.distanceMiles, quote.durationSeconds, quote.staticDurationSeconds || null,
        quote.trafficCondition || null, JSON.stringify(quote.priceBreakdown), quote.estimatedPriceCents,
        contactType, contactValue, ipHash || null, cleanText(request.headers.get("user-agent"), 300) || null,
      ).run();
      break;
    } catch (error) {
      if (String(error).includes("quote_nonce")) {
        const duplicate = await env.DB.prepare("SELECT * FROM bookings WHERE quote_nonce = ?").bind(quote.nonce).first();
        if (duplicate) {
          return notifyBookingRequest(request, env, duplicate);
        }
        throw error;
      }
      if (attempt === 2) throw error;
    }
  }
  const booking = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(result.meta.last_row_id).first();
  await audit(env, booking.id, "REQUESTED", "customer", { contactType });
  return notifyBookingRequest(request, env, booking, 201);
}

async function reservationByToken(env, token) {
  const hash = await sha256(token);
  return env.DB.prepare("SELECT * FROM bookings WHERE approval_token_hash = ?").bind(hash).first();
}

function allowedPaymentKeys(row) {
  try {
    const parsed = JSON.parse(row.allowed_payment_options_json || "[]");
    return [...new Set(parsed)].filter(key => ["10", "20", "full"].includes(key));
  } catch {
    return [];
  }
}

function paymentAmountFor(row, option) {
  if (!allowedPaymentKeys(row).includes(option)) return null;
  if (option === "full") return Number(row.final_price_cents);
  const cents = option === "10" ? 1000 : option === "20" ? 2000 : 0;
  return cents > 0 && cents <= Number(row.final_price_cents) ? cents : null;
}

function publicPaymentOptions(row) {
  return allowedPaymentKeys(row).map(key => ({
    key,
    label: key === "full" ? "Full trip price" : `$${key} deposit`,
    amount: paymentAmountFor(row, key) / 100,
  })).filter(option => Number.isFinite(option.amount) && option.amount > 0);
}

function reservationPublic(row) {
  const finalPriceCents = Number(row.final_price_cents || 0);
  const paidAmountCents = Number(row.payment_amount_cents || 0);
  return {
    reference: row.reference,
    status: row.status,
    vehicle: BUSINESS.vehicle,
    pickupAddress: row.pickup_address,
    destinationAddress: row.destination_address,
    pickupDate: row.pickup_date,
    pickupTime: row.pickup_time,
    distanceMiles: row.distance_miles,
    durationMinutes: Math.ceil(row.duration_seconds / 60),
    finalPrice: finalPriceCents / 100,
    paymentOptions: publicPaymentOptions(row),
    selectedPaymentOption: row.selected_payment_option,
    paymentMethod: row.payment_method,
    requestedPaymentAmount: row.payment_requested_amount_cents == null ? null : Number(row.payment_requested_amount_cents) / 100,
    paidAmount: row.payment_amount_cents == null ? null : paidAmountCents / 100,
    remainingBalance: row.remaining_balance_cents == null ? Math.max(0, finalPriceCents - paidAmountCents) / 100 : Number(row.remaining_balance_cents) / 100,
    paymentStatus: row.payment_status,
    zellePending: Boolean(row.payment_method === "ZELLE" && row.zelle_submitted_at && !row.zelle_verified_at),
    termsVersion: BUSINESS.termsVersion,
  };
}

async function getReservation(env, token) {
  requireDatabase(env);
  let row = await reservationByToken(env, token);
  if (!row) return json({ ok: false, message: "This reservation link is invalid." }, 404);
  if (row.approval_token_expires_at && Date.parse(row.approval_token_expires_at) < Date.now() && row.status !== "CONFIRMED") {
    return json({ ok: false, message: "This reservation link expired. Please contact Davtian Grigor LLC." }, 410);
  }
  return json({
    ok: true,
    reservation: reservationPublic(row),
    squareReady: Boolean(squareAccessToken(env)),
    zelleReady: true,
  });
}

async function chargeApprovedReservation(request, env, token) {
  const accessToken = squareAccessToken(env);
  if (!accessToken) return json({ ok: false, message: "Secure card payment is not configured yet." }, 503);
  const input = await readJson(request);
  const firstName = cleanText(input.firstName, 60);
  const lastName = cleanText(input.lastName, 60);
  const sourceId = cleanText(input.sourceId, 200);
  const paymentOption = cleanText(input.paymentOption, 20);
  const termsAccepted = input.termsAccepted === true;
  if (!firstName || !lastName || !sourceId || !paymentOption || !termsAccepted) {
    return json({ ok: false, message: "Please enter your first and last name, choose an approved amount, and accept the booking terms." }, 400);
  }
  let row = await reservationByToken(env, token);
  if (!row) return json({ ok: false, message: "This reservation link is invalid." }, 404);
  if (row.status === "CONFIRMED") return json({ ok: true, alreadyPaid: true, reservation: reservationPublic(row) });
  if (row.payment_method === "ZELLE") return json({ ok: false, message: "A Zelle payment is already awaiting owner verification for this booking." }, 409);
  if (row.status === "PAYMENT_PROCESSING" && !row.payment_id && Date.parse(`${row.payment_lock_at}Z`) < Date.now() - 2 * 60 * 1000) {
    await env.DB.prepare("UPDATE bookings SET status = 'APPROVED', payment_lock = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PAYMENT_PROCESSING' AND payment_id IS NULL")
      .bind(row.id).run();
    row = await reservationByToken(env, token);
  }
  if (row.status !== "APPROVED") return json({ ok: false, message: "This reservation is not available for payment." }, 409);
  if (Date.parse(row.approval_token_expires_at) < Date.now()) return json({ ok: false, message: "This reservation link expired." }, 410);
  const paymentAmountCents = paymentAmountFor(row, paymentOption);
  if (!paymentAmountCents) return json({ ok: false, message: "Choose one of the payment amounts approved for this booking." }, 400);
  if (row.payment_requested_amount_cents && Number(row.payment_requested_amount_cents) !== paymentAmountCents) {
    return json({ ok: false, message: "For payment safety, retry the same approved amount you selected previously." }, 409);
  }
  const email = normalizeEmail(row.contact_value);
  const lock = randomToken(12);
  const idempotencyKey = row.payment_idempotency_key || `dg-${row.id}-${paymentAmountCents}-${randomToken(8)}`.slice(0, 45);
  const lockResult = await env.DB.prepare(`
    UPDATE bookings SET status = 'PAYMENT_PROCESSING', payment_lock = ?, payment_lock_at = CURRENT_TIMESTAMP,
      first_name = ?, last_name = ?, email = ?, terms_version = ?, terms_accepted_at = CURRENT_TIMESTAMP,
      selected_payment_option = ?, payment_method = 'SQUARE', payment_requested_amount_cents = ?,
      remaining_balance_cents = ?, payment_idempotency_key = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'APPROVED' AND payment_id IS NULL AND (payment_method IS NULL OR payment_method = 'SQUARE')
  `).bind(
    lock, firstName, lastName, email, BUSINESS.termsVersion, paymentOption, paymentAmountCents,
    Math.max(0, Number(row.final_price_cents) - paymentAmountCents), idempotencyKey, row.id,
  ).run();
  if (lockResult.meta.changes !== 1) return json({ ok: false, message: "Payment is already being processed. Please wait before trying again." }, 409);
  await audit(env, row.id, "SQUARE_PAYMENT_STARTED", "customer", { paymentOption, paymentAmountCents });
  const paymentBody = {
    source_id: sourceId,
    idempotency_key: idempotencyKey,
    amount_money: { amount: paymentAmountCents, currency: "USD" },
    location_id: BUSINESS.squareLocationId,
    autocomplete: true,
    buyer_email_address: email,
    reference_id: row.reference.slice(0, 40),
    note: `${BUSINESS.vehicle} | ${row.pickup_date} ${row.pickup_time} | ${row.pickup_address} to ${row.destination_address} | ${row.reference} | ${paymentOption} payment`.slice(0, 500),
  };
  let squareResponse;
  let squareResult;
  try {
    squareResponse = await fetch("https://connect.squareup.com/v2/payments", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(paymentBody),
    });
    squareResult = await squareResponse.json().catch(() => ({}));
  } catch (error) {
    console.error("Square network failure", error);
    await env.DB.prepare("UPDATE bookings SET status = 'APPROVED', payment_lock = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_lock = ?")
      .bind(row.id, lock).run();
    return json({ ok: false, message: "Payment service is temporarily unavailable. Please try again." }, 502);
  }
  if (!squareResponse.ok || !squareResult.payment) {
    await env.DB.prepare(`
      UPDATE bookings SET status = 'APPROVED', payment_lock = NULL, payment_method = NULL,
        selected_payment_option = NULL, payment_requested_amount_cents = NULL, remaining_balance_cents = NULL,
        payment_idempotency_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_lock = ?
    `)
      .bind(row.id, lock).run();
    const code = squareResult?.errors?.[0]?.code;
    const message = code === "CARD_DECLINED" ? "The card was declined. Please use another card." :
      code === "VERIFY_CVV_FAILURE" ? "Please check the security code and try again." :
      code === "VERIFY_POSTAL_CODE_FAILURE" ? "Please check the billing ZIP code and try again." :
      "Payment could not be completed. Please check the card details and try again.";
    await audit(env, row.id, "SQUARE_PAYMENT_FAILED", "system", { code: code || "UNKNOWN" });
    return json({ ok: false, message }, 400);
  }
  const payment = squareResult.payment;
  await env.DB.prepare(`
    UPDATE bookings SET status = 'CONFIRMED', payment_id = ?, payment_status = ?, payment_amount_cents = ?,
      payment_receipt_url = ?, payment_lock = NULL, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND payment_lock = ?
  `).bind(payment.id, payment.status, Number(payment.amount_money?.amount || paymentAmountCents), payment.receipt_url || null, row.id, lock).run();
  await audit(env, row.id, "SQUARE_PAYMENT_CONFIRMED", "system", { paymentId: payment.id, amountCents: payment.amount_money?.amount });
  const confirmed = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(row.id).first();
  await sendPaymentConfirmations(env, confirmed, (await settings(env)).owner_email).catch(error => console.error("Confirmation notification failed", error));
  return json({ ok: true, reservation: reservationPublic(confirmed), paymentId: payment.id, receiptUrl: payment.receipt_url || null });
}

async function submitZellePayment(request, env, token) {
  const input = await readJson(request);
  const firstName = cleanText(input.firstName, 60);
  const lastName = cleanText(input.lastName, 60);
  const paymentOption = cleanText(input.paymentOption, 20);
  const termsAccepted = input.termsAccepted === true;
  if (!firstName || !lastName || !paymentOption || !termsAccepted) {
    return json({ ok: false, message: "Please enter your first and last name, choose an approved amount, and accept the booking terms." }, 400);
  }
  const row = await reservationByToken(env, token);
  if (!row) return json({ ok: false, message: "This reservation link is invalid." }, 404);
  if (row.status === "CONFIRMED") return json({ ok: true, alreadyPaid: true, reservation: reservationPublic(row) });
  if (row.zelle_submitted_at && row.payment_method === "ZELLE") {
    return json({ ok: true, zellePending: true, reservation: reservationPublic(row) });
  }
  if (row.status !== "APPROVED" || row.payment_method) {
    return json({ ok: false, message: "This reservation is not available for a Zelle payment." }, 409);
  }
  if (Date.parse(row.approval_token_expires_at) < Date.now()) return json({ ok: false, message: "This reservation link expired." }, 410);
  const paymentAmountCents = paymentAmountFor(row, paymentOption);
  if (!paymentAmountCents) return json({ ok: false, message: "Choose one of the payment amounts approved for this booking." }, 400);
  const result = await env.DB.prepare(`
    UPDATE bookings SET first_name = ?, last_name = ?, email = ?, terms_version = ?, terms_accepted_at = CURRENT_TIMESTAMP,
      selected_payment_option = ?, payment_method = 'ZELLE', payment_requested_amount_cents = ?,
      remaining_balance_cents = ?, zelle_submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'APPROVED' AND payment_method IS NULL AND payment_id IS NULL
  `).bind(
    firstName, lastName, normalizeEmail(row.contact_value), BUSINESS.termsVersion, paymentOption,
    paymentAmountCents, Math.max(0, Number(row.final_price_cents) - paymentAmountCents), row.id,
  ).run();
  if (result.meta.changes !== 1) return json({ ok: false, message: "A payment method has already been selected for this booking." }, 409);
  const pending = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(row.id).first();
  await audit(env, row.id, "ZELLE_AWAITING_VERIFICATION", "customer", { paymentOption, paymentAmountCents });
  await notifyOwnerOfZellePending(env, pending, (await settings(env)).owner_email).catch(error => console.error("Zelle notification failed", error));
  return json({ ok: true, zellePending: true, reservation: reservationPublic(pending) });
}

async function login(request, env) {
  if (!sameOrigin(request)) return json({ ok: false, message: "Request rejected." }, 403);
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({ ok: false, message: "Owner login is not configured yet." }, 503);
  const ipKey = await sha256(`${request.headers.get("cf-connecting-ip") || "local"}:${env.SESSION_SECRET}`);
  const attempt = await env.DB.prepare("SELECT * FROM login_attempts WHERE key = ?").bind(ipKey).first();
  if (attempt?.blocked_until && Date.parse(attempt.blocked_until) > Date.now()) {
    return json({ ok: false, message: "Too many attempts. Try again in 15 minutes." }, 429);
  }
  const input = await readJson(request);
  const password = cleanText(input.password, 300);
  if (!constantTimeEqual(password, env.ADMIN_PASSWORD)) {
    const now = new Date();
    const recent = attempt && Date.parse(attempt.first_attempt_at) > Date.now() - 15 * 60 * 1000;
    const attempts = recent ? Number(attempt.attempts) + 1 : 1;
    const blockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    await env.DB.prepare(`
      INSERT INTO login_attempts (key, attempts, first_attempt_at, blocked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET attempts = excluded.attempts, first_attempt_at = excluded.first_attempt_at, blocked_until = excluded.blocked_until
    `).bind(ipKey, attempts, recent ? attempt.first_attempt_at : now.toISOString(), blockedUntil).run();
    return json({ ok: false, message: "Incorrect password." }, 401);
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(ipKey).run();
  return json({ ok: true }, 200, { "set-cookie": await createAdminCookie(request, env) });
}

async function requireAdmin(request, env, mutate = false) {
  if (mutate && !sameOrigin(request)) return json({ ok: false, message: "Request rejected." }, 403);
  if (!await isAdmin(request, env)) return json({ ok: false, message: "Owner login required." }, 401);
  return null;
}

async function adminBookings(url, env) {
  const status = cleanText(url.searchParams.get("status"), 30).toUpperCase();
  const where = status && STATUSES.has(status) ? "WHERE status = ?" : "";
  const statement = env.DB.prepare(`SELECT * FROM bookings ${where} ORDER BY created_at DESC LIMIT 250`);
  const result = where ? await statement.bind(status).all() : await statement.all();
  return json({ ok: true, bookings: result.results || [] });
}

async function adminBooking(env, id) {
  const row = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, message: "Booking not found." }, 404);
  const events = await env.DB.prepare("SELECT * FROM booking_events WHERE booking_id = ? ORDER BY created_at").bind(id).all();
  return json({ ok: true, booking: row, events: events.results || [] });
}

async function approveBooking(request, env, id) {
  const input = await readJson(request);
  const finalPriceCents = clampInteger(Math.round(Number(input.finalPrice) * 100), 100, MAX_PRICE_CENTS);
  if (finalPriceCents == null) return json({ ok: false, message: "Enter a valid final price." }, 400);
  const allowedPaymentOptions = [...new Set(Array.isArray(input.allowedPaymentOptions) ? input.allowedPaymentOptions : [])]
    .filter(option => ["10", "20", "full"].includes(option))
    .filter(option => option === "full" || Number(option) * 100 <= finalPriceCents);
  if (!allowedPaymentOptions.length) return json({ ok: false, message: "Allow at least one payment option: $10, $20, or full payment." }, 400);
  const existing = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!existing) return json({ ok: false, message: "Booking not found." }, 404);
  if (!["REQUESTED", "APPROVED"].includes(existing.status)) return json({ ok: false, message: "This booking can no longer be approved." }, 409);
  if (existing.payment_method || existing.payment_id) {
    return json({ ok: false, message: "A payment method has already been selected for this booking." }, 409);
  }
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const defaultExpiry = Date.now() + APPROVAL_LINK_DAYS * 24 * 60 * 60 * 1000;
  const tripExpiry = Date.parse(existing.pickup_at_iso || "") + 24 * 60 * 60 * 1000;
  const expiryTimestamp = Number.isFinite(tripExpiry) && tripExpiry > Date.now()
    ? Math.min(defaultExpiry, tripExpiry)
    : defaultExpiry;
  const expires = new Date(expiryTimestamp).toISOString();
  await env.DB.prepare(`
    UPDATE bookings SET status = 'APPROVED', final_price_cents = ?, approval_token_hash = ?,
      approval_token_expires_at = ?, allowed_payment_options_json = ?, approved_at = CURRENT_TIMESTAMP,
      decline_reason = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(finalPriceCents, tokenHash, expires, JSON.stringify(allowedPaymentOptions), id).run();
  const booking = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  const link = `${new URL(request.url).origin}/reserve.html?token=${encodeURIComponent(token)}`;
  const notification = await notifyCustomerApproved(env, booking, link).catch(error => {
    console.error("Approval notification failed", error);
    return { sent: false, reason: "Delivery failed." };
  });
  await audit(env, id, "APPROVED", "owner", { finalPriceCents, allowedPaymentOptions, notification });
  return json({ ok: true, booking, link, notification });
}

async function declineBooking(request, env, id) {
  const input = await readJson(request);
  const reason = cleanText(input.reason, 300);
  const result = await env.DB.prepare(`
    UPDATE bookings SET status = 'DECLINED', decline_reason = ?, declined_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('REQUESTED','APPROVED') AND payment_method IS NULL AND payment_id IS NULL
  `).bind(reason || null, id).run();
  if (result.meta.changes !== 1) return json({ ok: false, message: "This booking cannot be declined." }, 409);
  const booking = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  const notification = await notifyCustomerDeclined(env, booking).catch(() => ({ sent: false, reason: "Delivery failed." }));
  await audit(env, id, "DECLINED", "owner", { reason, notification });
  return json({ ok: true, booking, notification });
}

async function updateBooking(request, env, id) {
  const input = await readJson(request);
  const passengerCount = input.passengerCount === "" || input.passengerCount == null ? null : clampInteger(Number(input.passengerCount), 1, 4);
  if (input.passengerCount !== "" && input.passengerCount != null && passengerCount == null) {
    return json({ ok: false, message: "Passenger count must be from 1 to 4." }, 400);
  }
  await env.DB.prepare(`
    UPDATE bookings SET customer_address = ?, passenger_count = ?, driver_name = ?, vehicle_plate = ?,
      tcp_number = ?, owner_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(
    cleanText(input.customerAddress, 300) || null,
    passengerCount,
    cleanText(input.driverName, 120) || null,
    cleanText(input.vehiclePlate, 30) || null,
    cleanText(input.tcpNumber, 40) || null,
    cleanText(input.ownerNotes, 1000) || null,
    id,
  ).run();
  await audit(env, id, "WAYBILL_UPDATED", "owner");
  return adminBooking(env, id);
}

async function cancelBooking(request, env, id) {
  const input = await readJson(request);
  const reason = cleanText(input.reason, 300);
  const result = await env.DB.prepare(`
    UPDATE bookings SET status = 'CANCELLED', owner_notes = CASE WHEN ? = '' THEN owner_notes ELSE ? END,
      cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('REQUESTED','APPROVED','CONFIRMED')
  `).bind(reason, reason, id).run();
  if (result.meta.changes !== 1) return json({ ok: false, message: "This booking cannot be cancelled." }, 409);
  await audit(env, id, "CANCELLED", "owner", { reason });
  return adminBooking(env, id);
}

async function refundBooking(request, env, id) {
  const accessToken = squareAccessToken(env);
  if (!accessToken) return json({ ok: false, message: "Square is not configured." }, 503);
  const booking = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!booking?.payment_id || booking.payment_method !== "SQUARE" || !["CONFIRMED", "CANCELLED"].includes(booking.status)) {
    return json({ ok: false, message: "This booking has no refundable payment." }, 409);
  }
  const input = await readJson(request);
  const alreadyRefunded = Number(booking.refund_amount_cents || 0);
  const maximum = Number(booking.payment_amount_cents) - alreadyRefunded;
  const amountCents = clampInteger(Math.round(Number(input.amount) * 100), 1, maximum);
  const reason = cleanText(input.reason, 190) || "Customer request";
  if (amountCents == null) return json({ ok: false, message: `Enter a refund up to ${money(maximum)}.` }, 400);
  const response = await fetch("https://connect.squareup.com/v2/refunds", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      idempotency_key: `refund-${id}-${alreadyRefunded}-${amountCents}`.slice(0, 45),
      payment_id: booking.payment_id,
      amount_money: { amount: amountCents, currency: "USD" },
      reason,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.refund) return json({ ok: false, message: "Square could not complete this refund. Check the Square dashboard." }, 400);
  const totalRefunded = alreadyRefunded + Number(result.refund.amount_money?.amount || amountCents);
  const status = totalRefunded >= Number(booking.payment_amount_cents) ? "REFUNDED" : booking.status;
  await env.DB.prepare(`
    UPDATE bookings SET status = ?, refund_id = ?, refund_amount_cents = ?, refund_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(status, result.refund.id, totalRefunded, reason, id).run();
  await audit(env, id, "REFUNDED", "owner", { refundId: result.refund.id, amountCents });
  return adminBooking(env, id);
}

async function verifyZellePayment(env, id) {
  const booking = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!booking) return json({ ok: false, message: "Booking not found." }, 404);
  if (booking.payment_method !== "ZELLE" || !booking.zelle_submitted_at || booking.zelle_verified_at || booking.status !== "APPROVED") {
    return json({ ok: false, message: "This booking has no pending Zelle payment to verify." }, 409);
  }
  const amountCents = Number(booking.payment_requested_amount_cents || 0);
  if (!amountCents) return json({ ok: false, message: "The expected Zelle amount is missing." }, 409);
  const paymentId = `ZELLE-${booking.reference}`;
  const verification = await env.DB.prepare(`
    UPDATE bookings SET status = 'CONFIRMED', payment_id = ?, payment_status = 'VERIFIED_BY_OWNER',
      payment_amount_cents = ?, zelle_verified_at = CURRENT_TIMESTAMP, paid_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'APPROVED' AND payment_method = 'ZELLE'
  `).bind(paymentId, amountCents, id).run();
  if (verification.meta.changes !== 1) {
    return json({ ok: false, message: "This Zelle payment was already verified or the booking changed." }, 409);
  }
  await audit(env, id, "ZELLE_PAYMENT_VERIFIED", "owner", { amountCents });
  const confirmed = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  await sendPaymentConfirmations(env, confirmed, (await settings(env)).owner_email).catch(error => console.error("Zelle confirmation failed", error));
  return json({ ok: true, booking: confirmed });
}

async function updateSettings(request, env) {
  const input = await readJson(request);
  const values = {
    baseFare: clampInteger(Math.round(Number(input.baseFare) * 100), 0, 100000),
    perMile: clampInteger(Math.round(Number(input.perMile) * 100), 0, 10000),
    perMinute: clampInteger(Math.round(Number(input.perMinute) * 100), 0, 10000),
    minimum: clampInteger(Math.round(Number(input.minimumPrice) * 100), 100, 1000000),
  };
  if (Object.values(values).some(value => value == null || !Number.isFinite(value))) {
    return json({ ok: false, message: "Check the pricing values." }, 400);
  }
  await env.DB.prepare(`
    UPDATE settings SET owner_email = ?, tcp_number = ?, driver_name = ?, vehicle_plate = ?,
      base_fare_cents = ?, per_mile_cents = ?, per_minute_cents = ?, minimum_price_cents = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = 1
  `).bind(
    normalizeEmail(input.ownerEmail) || "davtya@gmail.com",
    cleanText(input.tcpNumber, 40), cleanText(input.driverName, 120), cleanText(input.vehiclePlate, 30),
    values.baseFare, values.perMile, values.perMinute, values.minimum,
  ).run();
  return json({ ok: true, settings: await settings(env) });
}

async function sendAdminTestEmail(env) {
  const row = await settings(env);
  const result = await sendEmail(env, {
    to: env.OWNER_EMAIL || row.owner_email || "davtya@gmail.com",
    subject: "Davtian Grigor LLC website email test",
    html: `<h2>Email delivery is working</h2><p>This test was sent from the private owner dashboard.</p><p>No booking or payment was created.</p>`,
  });
  if (!result.sent) return json({ ok: false, message: result.reason || "The test email could not be sent." }, 503);
  return json({ ok: true, message: `Test email sent to ${env.OWNER_EMAIL || row.owner_email}.` });
}

async function exportCsv(env) {
  const result = await env.DB.prepare("SELECT * FROM bookings ORDER BY created_at DESC").all();
  const columns = [
    "reference", "status", "created_at", "pickup_date", "pickup_time", "vehicle_name", "pickup_address",
    "destination_address", "distance_miles", "duration_seconds", "estimated_price_cents", "final_price_cents",
    "contact_type", "contact_value", "first_name", "last_name", "email", "phone", "customer_address",
    "passenger_count", "driver_name", "vehicle_plate", "tcp_number", "arrangement_method", "payment_id",
    "payment_status", "payment_amount_cents", "paid_at", "refund_id", "refund_amount_cents", "owner_notes",
  ];
  const lines = [columns.join(","), ...(result.results || []).map(row => columns.map(column => csvEscape(row[column])).join(","))];
  return new Response(`\uFEFF${lines.join("\r\n")}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="davtian-bookings-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}

async function handleApi(request, env, url) {
  if (request.method !== "GET" && !sameOrigin(request)) return json({ ok: false, message: "Request rejected." }, 403);
  if (url.pathname === "/api/config" && request.method === "GET") return json({ ok: true, ...(publicConfig(await settings(env), env)) });
  if (url.pathname === "/api/places/autocomplete" && request.method === "POST") return autocomplete(request, env);
  if (url.pathname === "/api/quote" && request.method === "POST") return createQuote(request, env);
  if (url.pathname === "/api/booking-requests" && request.method === "POST") return createBookingRequest(request, env);

  const reservationMatch = url.pathname.match(/^\/api\/reservations\/([^/]+)(?:\/(pay|zelle))?$/);
  if (reservationMatch) {
    const token = cleanText(decodeURIComponent(reservationMatch[1]), 200);
    if (!reservationMatch[2] && request.method === "GET") return getReservation(env, token);
    if (reservationMatch[2] === "pay" && request.method === "POST") return chargeApprovedReservation(request, env, token);
    if (reservationMatch[2] === "zelle" && request.method === "POST") return submitZellePayment(request, env, token);
  }

  if (url.pathname === "/api/admin/login" && request.method === "POST") return login(request, env);
  if (url.pathname === "/api/admin/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearAdminCookie(request) });
  }
  if (url.pathname.startsWith("/api/admin/")) {
    const unauthorized = await requireAdmin(request, env, request.method !== "GET");
    if (unauthorized) return unauthorized;
    if (url.pathname === "/api/admin/session" && request.method === "GET") return json({ ok: true });
    if (url.pathname === "/api/admin/settings" && request.method === "GET") {
      const row = await settings(env);
      return json({ ok: true, settings: row, services: publicConfig(row, env).services });
    }
    if (url.pathname === "/api/admin/settings" && request.method === "PUT") return updateSettings(request, env);
    if (url.pathname === "/api/admin/test-email" && request.method === "POST") return sendAdminTestEmail(env);
    if (url.pathname === "/api/admin/bookings" && request.method === "GET") return adminBookings(url, env);
    if (url.pathname === "/api/admin/export.csv" && request.method === "GET") return exportCsv(env);
    const bookingMatch = url.pathname.match(/^\/api\/admin\/bookings\/(\d+)(?:\/(approve|decline|cancel|refund|verify-zelle))?$/);
    if (bookingMatch) {
      const id = Number(bookingMatch[1]);
      const action = bookingMatch[2];
      if (!action && request.method === "GET") return adminBooking(env, id);
      if (!action && request.method === "PUT") return updateBooking(request, env, id);
      if (action === "approve" && request.method === "POST") return approveBooking(request, env, id);
      if (action === "decline" && request.method === "POST") return declineBooking(request, env, id);
      if (action === "cancel" && request.method === "POST") return cancelBooking(request, env, id);
      if (action === "refund" && request.method === "POST") return refundBooking(request, env, id);
      if (action === "verify-zelle" && request.method === "POST") return verifyZellePayment(env, id);
    }
  }
  return json({ ok: false, message: "Not found." }, 404);
}

function friendlyError(error) {
  if (error?.message === "DATABASE_NOT_CONFIGURED") return json({ ok: false, message: "Booking database is not configured yet." }, 503);
  if (error?.message === "JSON_REQUIRED") return json({ ok: false, message: "Invalid request." }, 415);
  console.error("Unhandled worker error", error?.stack || error);
  return json({ ok: false, message: "The service is temporarily unavailable. Please try again." }, 500);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const runtimeEnv = withBookingDatabase(env);
      if (url.pathname.startsWith("/api/")) return withSecurityHeaders(await handleApi(request, runtimeEnv, url));
      if (url.pathname === "/admin" || url.pathname === "/admin/") return Response.redirect(`${url.origin}/admin.html`, 302);
      return withSecurityHeaders(await runtimeEnv.ASSETS.fetch(request));
    } catch (error) {
      return withSecurityHeaders(friendlyError(error));
    }
  },
};

export const __test = { calculatePrice, containsAirport, validateTrip };

