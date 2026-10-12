import assert from "node:assert/strict";
import { createFetchMock, Miniflare } from "miniflare";
import { signPayload } from "../worker/lib.js";

const secret = "integration-session-secret-32-characters";
const fetchMock = createFetchMock();
fetchMock.disableNetConnect();
fetchMock.get("https://connect.squareup.com").intercept({ path: "/v2/payments", method: "POST" }).reply(200, {
  payment: {
    id: "sq-payment-test-1",
    status: "COMPLETED",
    amount_money: { amount: 1000, currency: "USD" },
    receipt_url: "https://squareup.com/receipt/test",
  },
});
const mf = new Miniflare({
  workers: [{
    name: "booking-test-worker",
    scriptPath: "worker/index.js",
    modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-08-06",
    bindings: { SESSION_SECRET: secret, ADMIN_PASSWORD: "owner-test-password", SQUARE_ACCESS_TOKEN: "test-square-token" },
    fetchMock,
    durableObjects: { BOOKING_STORE: { className: "BookingStore", useSQLite: true } },
    serviceBindings: {
      ASSETS: async () => new Response("asset response", { status: 200 }),
    },
  }],
});

try {
  let response = await mf.dispatchFetch("https://example.com/api/config");
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.vehicleName, "2025 BMW X5");
  assert.equal(config.services.mapsReady, false);

  response = await mf.dispatchFetch("https://example.com/api/quote", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({
      pickupAddress: "Glendale, CA",
      destinationAddress: "Los Angeles, CA",
      pickupDate: "2026-12-01",
      pickupTime: "10:00",
      pickupAtIso: "2026-12-01T18:00:00.000Z",
    }),
  });
  assert.equal(response.status, 503);

  const quote = {
    nonce: "integration-quote-1",
    pickupAddress: "Glendale, CA",
    pickupPlaceId: "",
    destinationAddress: "Los Angeles, CA",
    destinationPlaceId: "",
    pickupDate: "2026-12-01",
    pickupTime: "10:00",
    pickupAtIso: "2026-12-01T18:00:00.000Z",
    distanceMiles: 30,
    durationSeconds: 3600,
    staticDurationSeconds: 3300,
    trafficCondition: "Moderate",
    estimatedPriceCents: 14500,
    priceBreakdown: { baseFareCents: 2500, timeCents: 4500, mileageCents: 7500 },
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const quoteToken = await signPayload(quote, secret);
  response = await mf.dispatchFetch("https://example.com/api/booking-requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ quoteToken, contactType: "email", contactValue: "customer@example.com" }),
  });
  assert.equal(response.status, 201);
  const requestResult = await response.json();
  assert.match(requestResult.reference, /^DG-/);
  assert.equal(requestResult.ownerNotified, false);

  response = await mf.dispatchFetch("https://example.com/api/booking-requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ quoteToken, contactType: "email", contactValue: "customer@example.com" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reference, requestResult.reference);

  response = await mf.dispatchFetch("https://example.com/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ password: "owner-test-password" }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];

  response = await mf.dispatchFetch("https://example.com/api/admin/bookings", { headers: { cookie } });
  const list = await response.json();
  assert.equal(list.bookings.length, 1);
  assert.equal(list.bookings[0].status, "REQUESTED");
  const bookingId = list.bookings[0].id;

  response = await mf.dispatchFetch(`https://example.com/api/admin/bookings/${bookingId}/approve`, {
    method: "POST",
    headers: { cookie, origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ finalPrice: 155, allowedPaymentOptions: ["10", "20", "full"] }),
  });
  assert.equal(response.status, 200);
  const approval = await response.json();
  assert.equal(approval.booking.status, "APPROVED");
  assert.equal(approval.booking.final_price_cents, 15500);
  assert.equal(approval.notification.sent, false);
  const reservationUrl = new URL(approval.link);

  response = await mf.dispatchFetch(`https://example.com${reservationUrl.pathname}${reservationUrl.search}`.replace("/reserve.html", "/api/reservations/" + encodeURIComponent(reservationUrl.searchParams.get("token"))).replace("?token=" + encodeURIComponent(reservationUrl.searchParams.get("token")), ""));
  assert.equal(response.status, 200);
  const reservation = await response.json();
  assert.equal(reservation.reservation.finalPrice, 155);
  assert.equal(reservation.squareReady, true);
  assert.equal(reservation.zelleReady, true);
  assert.deepEqual(reservation.reservation.paymentOptions.map(option => option.key), ["10", "20", "full"]);

  const reservationToken = reservationUrl.searchParams.get("token");
  response = await mf.dispatchFetch(`https://example.com/api/reservations/${encodeURIComponent(reservationToken)}/zelle`, {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Test", lastName: "Customer", paymentOption: "15", termsAccepted: true }),
  });
  assert.equal(response.status, 400, "customer cannot submit an owner-unapproved amount");

  response = await mf.dispatchFetch(`https://example.com/api/reservations/${encodeURIComponent(reservationToken)}/zelle`, {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Test", lastName: "Customer", paymentOption: "20", termsAccepted: true }),
  });
  assert.equal(response.status, 200);
  const zellePending = await response.json();
  assert.equal(zellePending.zellePending, true);
  assert.equal(zellePending.reservation.status, "APPROVED");
  assert.equal(zellePending.reservation.requestedPaymentAmount, 20);
  assert.equal(zellePending.reservation.remainingBalance, 135);

  response = await mf.dispatchFetch(`https://example.com/api/admin/bookings/${bookingId}/verify-zelle`, {
    method: "POST",
    headers: { cookie, origin: "https://example.com", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const zelleVerified = await response.json();
  assert.equal(zelleVerified.booking.status, "CONFIRMED");
  assert.equal(zelleVerified.booking.payment_method, "ZELLE");
  assert.equal(zelleVerified.booking.payment_amount_cents, 2000);
  assert.equal(zelleVerified.booking.remaining_balance_cents, 13500);

  response = await mf.dispatchFetch(`https://example.com/api/reservations/${encodeURIComponent(reservationToken)}`);
  const completedReservation = await response.json();
  assert.equal(completedReservation.reservation.status, "CONFIRMED");
  assert.equal(completedReservation.reservation.paidAmount, 20);
  assert.equal(completedReservation.reservation.remainingBalance, 135);

  response = await mf.dispatchFetch(`https://example.com/api/reservations/${encodeURIComponent(reservationToken)}/zelle`, {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Test", lastName: "Customer", paymentOption: "20", termsAccepted: true }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).alreadyPaid, true, "completed link cannot create another Zelle payment");

  response = await mf.dispatchFetch(`https://example.com/api/admin/bookings/${bookingId}`, {
    method: "PUT",
    headers: { cookie, origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({
      customerAddress: "123 Main St, Glendale, CA",
      passengerCount: 2,
      driverName: "Test Driver",
      vehiclePlate: "TEST123",
      tcpNumber: "TCP0051387-P",
      ownerNotes: "Integration test",
    }),
  });
  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.booking.passenger_count, 2);
  assert.equal(updated.booking.vehicle_plate, "TEST123");

  const squareQuoteToken = await signPayload({
    ...quote,
    nonce: "integration-quote-2",
    estimatedPriceCents: 10100,
    distanceMiles: 16.3,
    durationSeconds: 46 * 60,
    exp: Math.floor(Date.now() / 1000) + 600,
  }, secret);
  response = await mf.dispatchFetch("https://example.com/api/booking-requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ quoteToken: squareQuoteToken, contactValue: "square-customer@example.com" }),
  });
  assert.equal(response.status, 201);
  const squareRequest = await response.json();
  response = await mf.dispatchFetch("https://example.com/api/admin/bookings", { headers: { cookie } });
  const squareBooking = (await response.json()).bookings.find(row => row.reference === squareRequest.reference);
  assert.ok(squareBooking);
  response = await mf.dispatchFetch(`https://example.com/api/admin/bookings/${squareBooking.id}/approve`, {
    method: "POST",
    headers: { cookie, origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ finalPrice: 101, allowedPaymentOptions: ["10", "full"] }),
  });
  assert.equal(response.status, 200);
  const squareApproval = await response.json();
  const squareToken = new URL(squareApproval.link).searchParams.get("token");

  response = await mf.dispatchFetch(`https://example.com/api/reservations/${encodeURIComponent(squareToken)}/pay`, {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "cnon:card-nonce-ok", firstName: "Square", lastName: "Customer", paymentOption: "20", termsAccepted: true }),
  });
  assert.equal(response.status, 400, "Square cannot charge an owner-unapproved amount");

  response = await mf.dispatchFetch(`https://example.com/api/reservations/${encodeURIComponent(squareToken)}/pay`, {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "cnon:card-nonce-ok", firstName: "Square", lastName: "Customer", paymentOption: "10", termsAccepted: true }),
  });
  assert.equal(response.status, 200);
  const squarePaid = await response.json();
  assert.equal(squarePaid.reservation.status, "CONFIRMED");
  assert.equal(squarePaid.reservation.paymentMethod, "SQUARE");
  assert.equal(squarePaid.reservation.paidAmount, 10);
  assert.equal(squarePaid.reservation.remainingBalance, 91);

  response = await mf.dispatchFetch(`https://example.com/api/reservations/${encodeURIComponent(squareToken)}/pay`, {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "another-token", firstName: "Square", lastName: "Customer", paymentOption: "10", termsAccepted: true }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).alreadyPaid, true, "completed link cannot charge twice");

  console.log("Booking workflow integration tests passed.");
} finally {
  await mf.dispose();
}
