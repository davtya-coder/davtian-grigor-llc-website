import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { __test } from "../worker/index.js";
import { signPayload, verifyPayload } from "../worker/lib.js";
import { notifyCustomerApproved, notifyOwnerOfRequest, sendPaymentConfirmations } from "../worker/notifications.js";

const settings = {
  base_fare_cents: 2500,
  per_mile_cents: 250,
  per_minute_cents: 75,
  minimum_price_cents: 7000,
};

const trip = { pickupAddress: "Glendale, CA", destinationAddress: "Los Angeles, CA" };
const price = (distanceMiles, durationSeconds = 3600, overrides = {}) => __test.calculatePrice(
  { ...settings, ...overrides },
  trip,
  { distanceMiles, durationSeconds },
).totalCents;

assert.equal(price(1, 5 * 60), 7000, "minimum fare is applied");
assert.equal(price(10, 60 * 60), 9500, "base + mileage + time");
assert.equal(price(16.3, 46 * 60), 10100, "16.3 miles and 46 minutes is $101, not $180");
assert.equal(price(30, 90 * 60), 16800, "result rounds up to the next whole dollar");
assert.equal(__test.containsAirport("LAX Terminal 4", "Glendale, CA"), true);
assert.equal(__test.containsAirport("Glendale, CA", "Pasadena, CA"), false);

const secret = "test-session-secret-32-characters";
const token = await signPayload({ value: "quote", exp: Math.floor(Date.now() / 1000) + 60 }, secret);
assert.equal((await verifyPayload(token, secret)).value, "quote");
assert.equal(await verifyPayload(`${token}x`, secret), null);

const sentEmails = [];
const emailEnv = {
  EMAIL_FROM: "Davtian Grigor LLC <bookings@example.com>",
  EMAIL: { send: async message => { sentEmails.push(message); return { messageId: `test-${sentEmails.length}` }; } },
};
const emailBooking = {
  reference: "DG-TEST-EMAIL",
  pickup_address: "100 Pickup St, Los Angeles, CA",
  destination_address: "200 Destination Ave, Los Angeles, CA",
  pickup_date: "2026-12-01",
  pickup_time: "10:00",
  distance_miles: 16.3,
  duration_seconds: 46 * 60,
  estimated_price_cents: 10100,
  final_price_cents: 10100,
  contact_type: "email",
  contact_value: "customer@example.com",
  allowed_payment_options_json: '["10","20","full"]',
  payment_method: "SQUARE",
  payment_amount_cents: 2000,
  remaining_balance_cents: 8100,
  payment_id: "square-test-payment",
  first_name: "Test",
  last_name: "Customer",
  email: "customer@example.com",
};
assert.equal((await notifyOwnerOfRequest(emailEnv, emailBooking, "https://example.com", "davtya@gmail.com")).sent, true);
assert.equal(sentEmails[0].to[0], "davtya@gmail.com");
assert.match(sentEmails[0].html, /16\.3 miles/);
assert.match(sentEmails[0].html, /\$101\.00/);
assert.equal(sentEmails[0].replyTo, "customer@example.com");
for (const value of [emailBooking.pickup_address, emailBooking.destination_address, emailBooking.pickup_date, emailBooking.pickup_time]) {
  assert.ok(sentEmails[0].html.includes(value), `owner email includes ${value}`);
}
assert.equal((await notifyCustomerApproved(emailEnv, emailBooking, "https://example.com/reserve.html?token=secret")).sent, true);
assert.equal(sentEmails[1].to[0], "customer@example.com");
await sendPaymentConfirmations(emailEnv, emailBooking, "davtya@gmail.com");
assert.equal(sentEmails.length, 4);
assert.equal(sentEmails[2].to[0], "customer@example.com");
assert.equal(sentEmails[3].to[0], "davtya@gmail.com");

const homePage = await readFile("site/index.html", "utf8");
const labels = [">From", ">To", ">Date", ">Time"];
let previousLabel = -1;
for (const label of labels) {
  const position = homePage.indexOf(label);
  assert.ok(position > previousLabel, `home page contains ${label.slice(1)} in the requested order`);
  previousLabel = position;
}
assert.ok(homePage.indexOf("Phone: (747) 488-6300") > homePage.indexOf("</main>"), "phone number is below the booking page");
assert.doesNotMatch(homePage, /id="(?:fleet|services|terms|paymentModal)"/, "extra homepage sections are removed");

console.log("Pricing, signed-token, and email composition tests passed.");

