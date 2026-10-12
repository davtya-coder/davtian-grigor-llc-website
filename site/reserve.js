const $ = selector => document.querySelector(selector);
const token = new URLSearchParams(location.search).get("token") || "";
let config;
let reservation;
let squareCard;
let squareReady = false;
let activeMethod = "SQUARE";

const money = value => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
}).format(Number(value || 0));

function status(message = "", type = "error") {
  const element = $("#paymentStatus");
  element.textContent = message;
  element.className = message ? `status-message ${type}` : "status-message";
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(result.message || "Something went wrong. Please try again.");
  return result;
}

function showError(message) {
  $("#loadingPanel").hidden = true;
  $("#checkout").hidden = true;
  $("#paidPanel").hidden = true;
  $("#zellePendingPanel").hidden = true;
  $("#errorPanel").hidden = false;
  $("#loadError").textContent = message;
}

function showPaid() {
  $("#loadingPanel").hidden = true;
  $("#checkout").hidden = true;
  $("#paidPanel").hidden = false;
  $("#paidReference").textContent = reservation.reference;
  $("#paidAmount").textContent = money(reservation.paidAmount || reservation.requestedPaymentAmount || reservation.finalPrice);
  $("#paidRemaining").textContent = money(reservation.remainingBalance);
}

function showZellePending() {
  $("#loadingPanel").hidden = true;
  $("#checkout").hidden = true;
  $("#zellePendingPanel").hidden = false;
  $("#zellePendingReference").textContent = reservation.reference;
  $("#zellePendingAmount").textContent = `${money(reservation.requestedPaymentAmount)} awaiting verification`;
}

function selectedPaymentOption() {
  return document.querySelector('input[name="paymentOption"]:checked')?.value || "";
}

function selectedPaymentAmount() {
  const option = reservation?.paymentOptions?.find(item => item.key === selectedPaymentOption());
  return Number(option?.amount || 0);
}

function updateActionLabels() {
  const amount = selectedPaymentAmount();
  $("#payButton").textContent = amount ? `Pay ${money(amount)} securely with Square` : "Choose a payment amount";
  $("#zelleSentButton").textContent = amount ? `I sent ${money(amount)} through Zelle` : "Choose a payment amount";
  $("#payButton").disabled = !squareReady || !squareCard || !amount;
  $("#zelleSentButton").disabled = !amount;
}

function renderPaymentOptions() {
  const container = $("#paymentOptions");
  container.replaceChildren();
  for (const [index, option] of reservation.paymentOptions.entries()) {
    const label = document.createElement("label");
    label.className = "payment-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "paymentOption";
    radio.value = option.key;
    radio.required = true;
    radio.checked = index === 0;
    const text = document.createElement("span");
    text.textContent = `${option.label} — ${money(option.amount)}`;
    label.append(radio, text);
    container.append(label);
  }
  container.addEventListener("change", updateActionLabels);
}

async function initializeCard() {
  if (!squareReady || squareCard) return;
  if (!window.Square) {
    squareReady = false;
    $("#squareMethod").disabled = true;
    throw new Error("Square's secure card form could not load. You can still use Zelle or refresh the page.");
  }
  const payments = window.Square.payments(config.squareApplicationId, config.squareLocationId);
  squareCard = await payments.card();
  await squareCard.attach("#card-container");
  updateActionLabels();
}

function setMethod(method) {
  activeMethod = method;
  const square = method === "SQUARE";
  $("#squareMethod").classList.toggle("active", square);
  $("#zelleMethod").classList.toggle("active", !square);
  $("#squarePanel").hidden = !square;
  $("#zellePanel").hidden = square;
  status();
  if (square) initializeCard().catch(error => status(error.message, "error"));
}

async function drawZelleQr() {
  const image = new Image();
  image.src = "/assets/zelle-qr-source.png";
  await image.decode();
  const canvas = $("#zelleQrCanvas");
  const context = canvas.getContext("2d");
  context.fillStyle = "#f6f3ef";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 150, 800, 825, 1297, 0, 0, canvas.width, canvas.height);
}

function populateSummary() {
  $("#reference").textContent = reservation.reference;
  $("#zelleReference").textContent = reservation.reference;
  $("#pickup").textContent = reservation.pickupAddress;
  $("#destination").textContent = reservation.destinationAddress;
  $("#dateTime").textContent = `${reservation.pickupDate} · ${reservation.pickupTime}`;
  $("#distance").textContent = `${Number(reservation.distanceMiles).toFixed(1)} miles · about ${reservation.durationMinutes} minutes`;
  $("#total").textContent = money(reservation.finalPrice);
  renderPaymentOptions();
}

async function load() {
  if (!token) return showError("The secure booking token is missing.");
  try {
    const [configResult, reservationResult] = await Promise.all([
      api("/api/config"),
      api(`/api/reservations/${encodeURIComponent(token)}`),
    ]);
    config = configResult;
    reservation = reservationResult.reservation;
    squareReady = Boolean(reservationResult.squareReady);
    if (reservation.status === "CONFIRMED") return showPaid();
    if (reservation.zellePending) return showZellePending();
    if (reservation.status !== "APPROVED") return showError("This booking is not approved for payment.");
    if (!reservation.paymentOptions?.length) return showError("No payment amount is currently authorized for this booking.");
    populateSummary();
    await drawZelleQr();
    $("#loadingPanel").hidden = true;
    $("#checkout").hidden = false;
    if (!squareReady) {
      $("#squareMethod").disabled = true;
      setMethod("ZELLE");
      status("Square card payment is temporarily unavailable. Zelle remains available.", "warning");
    } else {
      setMethod("SQUARE");
    }
    updateActionLabels();
  } catch (error) {
    if ($("#checkout").hidden) showError(error.message);
    else status(error.message, "error");
  }
}

function customerDetails() {
  if (!$("#paymentForm").reportValidity()) return null;
  const paymentOption = selectedPaymentOption();
  if (!paymentOption) {
    status("Choose one of the amounts approved for this booking.", "error");
    return null;
  }
  return {
    firstName: $("#firstName").value.trim(),
    lastName: $("#lastName").value.trim(),
    paymentOption,
    termsAccepted: $("#termsAccepted").checked,
  };
}

$("#squareMethod").addEventListener("click", () => setMethod("SQUARE"));
$("#zelleMethod").addEventListener("click", () => setMethod("ZELLE"));

$("#payButton").addEventListener("click", async () => {
  if (activeMethod !== "SQUARE" || !squareCard || !reservation) return;
  const details = customerDetails();
  if (!details) return;
  const button = $("#payButton");
  const amount = selectedPaymentAmount();
  button.disabled = true;
  button.textContent = "Processing secure payment…";
  status();
  try {
    const tokenResult = await squareCard.tokenize({
      amount: amount.toFixed(2),
      currencyCode: "USD",
      intent: "CHARGE",
      customerInitiated: true,
      sellerKeyedIn: false,
      billingContact: {
        givenName: details.firstName,
        familyName: details.lastName,
        countryCode: "US",
      },
    });
    if (tokenResult.status !== "OK") throw new Error("Please check the card details and try again.");
    const result = await api(`/api/reservations/${encodeURIComponent(token)}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...details, sourceId: tokenResult.token }),
    });
    if (result.paymentPending || result.reservation.status !== "CONFIRMED") {
      reservation = result.reservation;
      status("Payment is still processing. Do not pay again; contact Grigor to check its status.", "error");
      return;
    }
    try { await squareCard.destroy(); } catch {}
    squareCard = null;
    reservation = result.reservation;
    $("#checkout").hidden = true;
    $("#successPanel").hidden = false;
    $("#successReference").textContent = reservation.reference;
    $("#successAmount").textContent = money(reservation.paidAmount);
    $("#successRemaining").textContent = money(reservation.remainingBalance);
    if (result.receiptUrl) {
      $("#receiptLink").href = result.receiptUrl;
      $("#receiptLink").hidden = false;
    }
  } catch (error) {
    status(error.message, "error");
    updateActionLabels();
  }
});

$("#zelleSentButton").addEventListener("click", async () => {
  if (activeMethod !== "ZELLE" || !reservation) return;
  const details = customerDetails();
  if (!details) return;
  const amount = selectedPaymentAmount();
  if (!confirm(`Have you sent ${money(amount)} to DAVTIAN GRIGOR LLC through Zelle? This will still require manual bank verification.`)) return;
  const button = $("#zelleSentButton");
  button.disabled = true;
  button.textContent = "Recording transfer notice…";
  status();
  try {
    const result = await api(`/api/reservations/${encodeURIComponent(token)}/zelle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(details),
    });
    reservation = result.reservation;
    showZellePending();
  } catch (error) {
    status(error.message, "error");
    updateActionLabels();
  }
});

$("#saveZelleQr").addEventListener("click", () => {
  const canvas = $("#zelleQrCanvas");
  canvas.toBlob(blob => {
    if (!blob) return status("The QR image could not be saved. Please take a screenshot instead.", "error");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "davtian-grigor-llc-zelle-qr.png";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, "image/png");
});

load();

