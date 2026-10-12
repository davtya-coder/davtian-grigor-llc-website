import assert from "node:assert/strict";
import { composeSmsRequest, createSmsHref, REQUEST_PHONE } from "../site/sms.js";

const trip = { pickupAddress: "100 A & B St, Los Angeles", destinationAddress: "200 Destination Ave", pickupDate: "2026-10-12", pickupTime: "10:00" };
const text = composeSmsRequest(trip, 131);
for (const value of [...Object.values(trip), "$131.00"]) assert.ok(text.includes(value));
for (const device of [
  { userAgent: "iPhone", separator: "&" },
  { userAgent: "Android", separator: "?" },
  { platform: "MacIntel", maxTouchPoints: 5, separator: "&" },
  { userAgent: "Desktop", separator: "?" },
]) {
  const href = createSmsHref(text, device);
  assert.ok(href.startsWith(`sms:${REQUEST_PHONE}${device.separator}body=`));
  assert.equal(decodeURIComponent(href.split("body=")[1]), text, "all trip details survive URI encoding");
  assert.ok(href.endsWith("%24131.00"));
}
assert.ok(!text.includes("confirmed"), "opening an SMS draft must not claim a confirmed booking");
console.log("SMS recipient, trip details, encoding and mobile link tests passed.");
