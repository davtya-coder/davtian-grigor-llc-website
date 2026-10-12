import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import worker from "../worker/index.js";
import { signPayload } from "../worker/lib.js";
import { agreedAmountCents, SMS_ARRANGEMENT } from "../worker/sms-checkout.js";

assert.equal(agreedAmountCents("80.10"), 8010);
for (const value of ["9.99", "80.001", "1e2", "NaN", "50000.01"]) assert.equal(agreedAmountCents(value), null);
const secret = "sms-payment-test-secret-32-characters";
const outgoing = [];
const replies = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  assert.ok(String(url).startsWith("https://connect.squareup.com/v2/payments"));
  outgoing.push(options.body);
  const next = replies.shift();
  assert.ok(next, "every provider call must have an explicit fake response");
  return new Response(JSON.stringify(next.data), { status: next.status });
};
const square = { intercept() { return { reply(status, data) { replies.push({ status, data }); } }; } };
const mf = new Miniflare({ workers: [{
  name: "sms-checkout-test", scriptPath: "worker/index.js", modules: true,
  modulesRules: [{ type: "ESModule", include: ["**/*.js"] }], compatibilityDate: "2026-08-06",
  bindings: { SESSION_SECRET: secret, ADMIN_PASSWORD: "test-owner", SQUARE_ACCESS_TOKEN: "test-square-token" },
  durableObjects: { BOOKING_STORE: { className: "BookingStore", useSQLite: true } },
}] });
const namespace = await mf.getDurableObjectNamespace("BOOKING_STORE", "sms-checkout-test");
const env = { SESSION_SECRET: secret, SQUARE_ACCESS_TOKEN: "test-square-token", BOOKING_STORE: namespace };
const dispatch = (url, options) => worker.fetch(new Request(url, options), env);
const post = (path, body) => dispatch(`https://example.com${path}`, { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: JSON.stringify(body) });
const quote = nonce => signPayload({ nonce, pickupAddress: "Los Angeles, CA", destinationAddress: "Glendale, CA", pickupDate: "2026-12-01", pickupTime: "10:00", pickupAtIso: "2026-12-01T18:00:00.000Z", distanceMiles: 20, durationSeconds: 2400, estimatedPriceCents: 10000, priceBreakdown: { total: 10000 }, exp: Math.floor(Date.now() / 1000) + 1800 }, secret);
const customer = { firstName: "Test", lastName: "Customer", phone: "7475550100", agreedAmount: "80.00", smsConfirmed: true, termsAccepted: true };
const payment = { firstName: "Test", lastName: "Customer", termsAccepted: true, paymentOption: "full", expectedAmount: "80.00", sourceId: "cnon:test-card-one" };
try {
  const quoteToken = await quote("manual-sms-1");
  let response = await post("/api/sms-checkout", { ...customer, quoteToken, smsConfirmed: false });
  assert.equal(response.status, 400, "customer must attest to the SMS agreement before payment");
  response = await post("/api/sms-checkout", { ...customer, quoteToken: `${quoteToken}x` });
  assert.equal(response.status, 400, "tampered trip quotes are rejected");
  response = await post("/api/sms-checkout", { ...customer, quoteToken });
  assert.equal(response.status, 200);
  const checkout = await response.json();
  assert.equal(checkout.agreedAmount, 80);
  response = await post("/api/sms-checkout", { ...customer, quoteToken });
  assert.equal((await response.json()).token, checkout.token, "same trip creates one checkout");
  response = await dispatch(`https://example.com/api/reservations/${encodeURIComponent(checkout.token)}`);
  const reservation = (await response.json()).reservation;
  assert.equal(reservation.finalPrice, 80, "agreed $80 is used instead of the $100 estimate");
  assert.equal(reservation.arrangementMethod, SMS_ARRANGEMENT);
  response = await post(`/api/reservations/${encodeURIComponent(checkout.token)}/pay`, { ...payment, expectedAmount: "100" });
  assert.equal(response.status, 409, "a different card payment amount cannot be charged");

  square.intercept({ path: "/v2/payments", method: "POST" }).reply(500, { message: "Uncertain provider response" });
  response = await post(`/api/reservations/${encodeURIComponent(checkout.token)}/pay`, payment);
  assert.equal(response.status, 502);
  const stub = namespace.get(namespace.idFromName("davtian-grigor-llc-bookings"));
  const savedResponse = await stub.fetch("https://internal/query", { method: "POST", body: JSON.stringify({ sql: "SELECT request_json FROM private_square_attempts LIMIT 1", params: [], mode: "first" }) });
  const exactBody = (await savedResponse.json()).rows[0].request_json;
  const savedBody = JSON.parse(exactBody);
  assert.equal(savedBody.amount_money.amount, 8000);
  assert.equal(savedBody.source_id, payment.sourceId);
  assert.ok(!("buyer_email_address" in savedBody), "email is optional for the SMS flow");
  square.intercept({ path: "/v2/payments", method: "POST", body: exactBody }).reply(200, { payment: { id: "sms-paid-one", status: "COMPLETED", amount_money: { amount: 8000, currency: "USD" } } });
  response = await post(`/api/reservations/${encodeURIComponent(checkout.token)}/pay`, { ...payment, sourceId: "cnon:a-new-browser-token" });
  assert.equal(response.status, 200, "an uncertain attempt is replayed with the exact original request");
  assert.equal(outgoing[1], exactBody, "retry sends the exact saved request to Square");
  assert.equal(outgoing[0], outgoing[1], "both attempts use the same body and idempotency key");
  const paid = await response.json();
  assert.equal(paid.reservation.status, "CONFIRMED");
  assert.equal(paid.reservation.paidAmount, 80);
  response = await post(`/api/reservations/${encodeURIComponent(checkout.token)}/pay`, payment);
  assert.equal((await response.json()).alreadyPaid, true, "repeated clicks cannot charge again");

  response = await post("/api/sms-checkout", { ...customer, quoteToken: await quote("manual-sms-pending") });
  const pendingToken = (await response.json()).token;
  square.intercept({ path: "/v2/payments", method: "POST" }).reply(200, { payment: { id: "sms-pending", status: "PENDING", amount_money: { amount: 8000, currency: "USD" } } });
  response = await post(`/api/reservations/${encodeURIComponent(pendingToken)}/pay`, payment);
  assert.equal(response.status, 202);
  const pending = await response.json();
  assert.equal(pending.paymentPending, true);
  assert.equal(pending.reservation.status, "PAYMENT_PROCESSING", "pending payments are not confirmed");
  square.intercept({ path: "/v2/payments/sms-pending", method: "GET" }).reply(200, { payment: { id: "sms-pending", status: "COMPLETED", amount_money: { amount: 8000, currency: "USD" } } });
  response = await dispatch(`https://example.com/api/reservations/${encodeURIComponent(pendingToken)}`);
  assert.equal((await response.json()).reservation.status, "CONFIRMED", "payment is confirmed only when Square completes it");

  response = await post("/api/sms-checkout", { ...customer, quoteToken: await quote("manual-sms-zelle") });
  const zelleToken = (await response.json()).token;
  response = await post(`/api/reservations/${encodeURIComponent(zelleToken)}/zelle`, { ...payment, expectedAmount: "100" });
  assert.equal(response.status, 409);
  response = await post(`/api/reservations/${encodeURIComponent(zelleToken)}/zelle`, payment);
  assert.equal(response.status, 200);
  const zelle = await response.json();
  assert.equal(zelle.zellePending, true);
  assert.notEqual(zelle.reservation.status, "CONFIRMED", "Zelle remains unconfirmed until the owner checks the bank");
  assert.equal(zelle.reservation.requestedPaymentAmount, 80);
  assert.equal(replies.length, 0);
  console.log("Negotiated SMS checkout, exact retries, pending card status and Zelle tests passed.");
} finally { globalThis.fetch = originalFetch; await mf.dispose(); }
