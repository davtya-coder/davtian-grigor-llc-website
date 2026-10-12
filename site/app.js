const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
}).format(value);
const rateMoney = value => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format(value);

const routeForm = $("#routeForm");
const requestForm = $("#requestForm");
const routeStatus = $("#routeStatus");
const requestStatus = $("#requestStatus");
const routeResult = $("#routeResult");
const routeButton = $("#routeButton");
const requestButton = $("#requestButton");
const pickupDate = $("#pickupDate");
const pickupTime = $("#pickupTime");
let quoteToken = "";
let emailAvailable = null;

function updateEmailAvailability() {
  if (emailAvailable !== false) return;
  requestButton.disabled = true;
  requestStatus.textContent = "Online requests are temporarily unavailable. Please email davtya@gmail.com with your trip details.";
}

api("/api/config").then(config => {
  emailAvailable = config.services.emailReady;
  updateEmailAvailability();
  const { baseFare, perMile, perMinute, minimumPrice } = config.pricing;
  $("#pricingFormula").textContent = `Estimate based on the actual Google Maps driving route, a ${rateMoney(baseFare)} base fare, ${rateMoney(perMile)} per mile, ${rateMoney(perMinute)} per minute and a ${rateMoney(minimumPrice)} minimum. Tolls, parking, airport fees, waiting time and major traffic changes are not included.`;
}).catch(() => {});

function localDate(date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function pickupIso() {
  const value = new Date(`${pickupDate.value}T${pickupTime.value}:00`);
  return Number.isFinite(value.getTime()) ? value.toISOString() : "";
}

async function api(path, options) {
  const response = await fetch(path, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    const error = new Error(result.message || "The service is temporarily unavailable.");
    error.requestSaved = result.requestSaved === true;
    throw error;
  }
  return result;
}

function resetQuote() {
  quoteToken = "";
  routeResult.hidden = true;
  requestStatus.textContent = "";
  requestStatus.className = "request-status";
  requestButton.disabled = false;
  requestButton.textContent = "Send ride request";
  updateEmailAvailability();
}

["#pickup", "#destination", "#pickupDate", "#pickupTime"].forEach(selector => {
  $(selector).addEventListener("input", resetQuote);
});

routeForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!routeForm.reportValidity()) return;
  routeButton.disabled = true;
  routeButton.textContent = "Calculating route…";
  routeStatus.textContent = "";
  routeResult.hidden = true;
  quoteToken = "";
  try {
    const result = await api("/api/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pickupAddress: $("#pickup").value.trim(),
        destinationAddress: $("#destination").value.trim(),
        pickupDate: pickupDate.value,
        pickupTime: pickupTime.value,
        pickupAtIso: pickupIso(),
      }),
    });
    quoteToken = result.quoteToken;
    $("#routeDistance").textContent = `${Number(result.distanceMiles).toFixed(1)} miles`;
    $("#routeTime").textContent = `${result.durationMinutes} minutes`;
    $("#routePrice").textContent = money(result.estimatedPrice);
    routeResult.hidden = false;
    updateEmailAvailability();
  } catch (error) {
    routeStatus.textContent = error.message || "Route could not be calculated. Please check both addresses.";
  } finally {
    routeButton.disabled = false;
    routeButton.textContent = "Calculate route and price";
  }
});

requestForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!requestForm.reportValidity() || !routeForm.reportValidity()) return;
  if (!quoteToken) {
    requestStatus.textContent = "Please calculate the route again before sending the request.";
    return;
  }
  requestButton.disabled = true;
  requestButton.textContent = "Sending request…";
  requestStatus.textContent = "";
  requestStatus.className = "request-status";
  try {
    const result = await api("/api/booking-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteToken,
        contactType: "email",
        contactValue: $("#customerEmail").value.trim(),
        company: $("#company").value,
      }),
    });
    requestStatus.textContent = `Request ${result.reference} sent. We will email you after review.`;
    requestStatus.className = "request-status success";
    requestButton.textContent = "Request sent";
  } catch (error) {
    requestStatus.textContent = error.message || "The request could not be sent. Please try again.";
    requestButton.disabled = false;
    requestButton.textContent = error.requestSaved ? "Retry sending email" : "Send ride request";
  }
});

const now = new Date(Date.now() + 15 * 60_000);
pickupDate.min = localDate(new Date());
if (!pickupDate.value) pickupDate.value = localDate(now);
if (!pickupTime.value) pickupTime.value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
$("#year").textContent = new Date().getFullYear();

