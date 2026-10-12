import assert from "node:assert/strict";
import { createFetchMock, Miniflare } from "miniflare";

const fetchMock = createFetchMock();
fetchMock.disableNetConnect();
fetchMock.get("https://routes.googleapis.com").intercept({ path: "/directions/v2:computeRoutes", method: "POST" }).reply(200, {
  routes: [{ distanceMeters: 16.3 * 1609.344, duration: "2760s", staticDuration: "2400s" }],
}).persist();
fetchMock.get("https://api.resend.com").intercept({ path: "/emails", method: "POST" }).reply(503, { message: "Temporary failure" });
fetchMock.get("https://api.resend.com").intercept({ path: "/emails", method: "POST" }).reply(200, { id: "request-email" });

const mf = new Miniflare({
  workers: [{
    name: "request-email-test", scriptPath: "worker/index.js", modules: true,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }], compatibilityDate: "2026-08-06",
    bindings: { GOOGLE_MAPS_API_KEY: "test-google-key", RESEND_API_KEY: "test-email-token", RESEND_FROM: "bookings@example.com" },
    durableObjects: { BOOKING_STORE: { className: "BookingStore", useSQLite: true } }, fetchMock,
  }],
});
const post = (path, body) => mf.dispatchFetch(`https://example.com${path}`, {
  method: "POST", headers: { "content-type": "application/json", origin: "https://example.com" }, body: JSON.stringify(body),
});
try {
  const trip = { pickupAddress: "100 Pickup St, Los Angeles, CA", destinationAddress: "200 Destination Ave, Los Angeles, CA", pickupDate: "2026-12-01", pickupTime: "10:00", pickupAtIso: "2026-12-01T18:00:00.000Z" };
  const quoteResponse = await post("/api/quote", trip);
  assert.equal(quoteResponse.status, 200);
  const quote = await quoteResponse.json();
  assert.equal(quote.estimatedPrice, 101);
  assert.equal(quote.durationMinutes, 46);
  const body = { quoteToken: quote.quoteToken, contactValue: "customer@example.com" };
  let response = await post("/api/booking-requests", body);
  assert.equal(response.status, 503, "email failure must not report successful submission");
  const failed = await response.json();
  assert.equal(failed.ok, false);
  assert.equal(failed.requestSaved, true);
  assert.equal(failed.ownerNotified, false);
  response = await post("/api/booking-requests", body);
  assert.equal(response.status, 200);
  const retried = await response.json();
  assert.equal(retried.reference, failed.reference, "retry reuses the saved request");
  assert.equal(retried.ownerNotified, true);
  response = await post("/api/booking-requests", body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ownerNotified, true);
  fetchMock.assertNoPendingInterceptors();
  console.log("Route, fare, owner email, failure and retry tests passed.");
} finally {
  await mf.dispose();
}
