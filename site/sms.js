export const REQUEST_PHONE = "+17474886300";

export function composeSmsRequest(trip, estimatedPrice) {
  return [
    "Ride request - Davtian Grigor LLC",
    `From: ${trip.pickupAddress}`,
    `To: ${trip.destinationAddress}`,
    `Date: ${trip.pickupDate}`,
    `Time: ${trip.pickupTime}`,
    `Estimated price: $${Number(estimatedPrice).toFixed(2)}`,
  ].join("\n");
}

export function createSmsHref(text, device = {}) {
  const appleMobile = /iPad|iPhone|iPod/.test(device.userAgent || "") ||
    (device.platform === "MacIntel" && Number(device.maxTouchPoints) > 1);
  return `sms:${REQUEST_PHONE}${appleMobile ? "&" : "?"}body=${encodeURIComponent(text)}`;
}
