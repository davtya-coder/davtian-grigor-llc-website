const $ = selector => document.querySelector(selector);
const money = value => `$${Number(value).toFixed(2)}`;

function loadSquareSdk() {
  if (window.Square) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://web.squarecdn.com/v1/square.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("The secure card form could not load. You can choose Zelle."));
    document.head.append(script);
  });
}

export function initializeCheckout(api) {
  let config;
  let squareCard;
  let trip;
  let checkoutToken = "";
  let busy = false;
  let finished = false;
  let unresolvedPayment = false;
  let resolvingPrevious = true;
  let method = "SQUARE";
  const form = $("#smsPaymentForm");
  const amount = $("#agreedAmount");
  const payButton = $("#inlinePayButton");
  const zelleButton = $("#inlineZelleSent");
  const message = $("#inlinePaymentStatus");

  function status(text, success = false) {
    message.textContent = text;
    message.className = success ? "payment-notice success" : "payment-notice";
  }
  function update() {
    const eligible = Boolean(!resolvingPrevious && trip && $("#smsConfirmed").checked && $("#inlineTermsAccepted").checked && Number(amount.value) >= 10);
    payButton.disabled = busy || finished || !eligible || !squareCard || !config?.services.paymentsReady;
    zelleButton.disabled = busy || finished || unresolvedPayment || !eligible;
    amount.disabled = busy || unresolvedPayment;
    payButton.textContent = busy ? "Processing…" : unresolvedPayment ? "Retry original payment safely" : `Pay ${money(amount.value || 0)} by card`;
    $("#zelleAgreedAmount").textContent = money(amount.value || 0);
  }
  function setBusy(value) {
    busy = value;
    form.querySelectorAll("input, button").forEach(element => { element.disabled = value; });
    document.querySelectorAll("#routeForm input, #routeForm button").forEach(element => { element.disabled = value; });
    update();
  }
  function details() {
    if (!trip) { status("Calculate your route above before paying."); return null; }
    if (!form.reportValidity()) return null;
    return {
      firstName: $("#payFirstName").value.trim(), lastName: $("#payLastName").value.trim(),
      phone: $("#payPhone").value.trim(), email: $("#payEmail").value.trim(),
      agreedAmount: amount.value, expectedAmount: amount.value,
      smsConfirmed: $("#smsConfirmed").checked, termsAccepted: $("#inlineTermsAccepted").checked,
      paymentOption: "full",
    };
  }
  async function prepare(data) {
    if (unresolvedPayment && checkoutToken) {
      const saved = await api(`/api/reservations/${encodeURIComponent(checkoutToken)}`);
      if (Number(saved.reservation.finalPrice) !== Number(data.agreedAmount)) throw new Error("Please contact Grigor to check the original payment amount.");
      return { ...saved.reservation, token: checkoutToken };
    }
    const result = await api("/api/sms-checkout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...data, quoteToken: trip.quoteToken }),
    });
    checkoutToken = result.token;
    $("#inlineReference").textContent = result.reference;
    try { sessionStorage.setItem("davtian-last-checkout", checkoutToken); } catch {}
    return result;
  }
  function paid(reservation, receiptUrl) {
    finished = true;
    unresolvedPayment = false;
    form.hidden = true;
    $("#inlinePaymentDone").hidden = false;
    $("#inlinePaymentDone").textContent = `Payment received: ${money(reservation.paidAmount)}. Reference ${reservation.reference}.`;
    if (receiptUrl && /^https:\/\//.test(receiptUrl)) {
      $("#inlineReceipt").href = receiptUrl;
      $("#inlineReceipt").hidden = false;
    }
  }
  function showProcessing(reservation) {
    finished = true;
    unresolvedPayment = true;
    status(`Payment for ${reservation.reference} is still processing. Please do not pay again. Use Check payment status below.`);
    $("#inlineCheckPayment").hidden = false;
  }
  function setMethod(value) {
    method = value;
    $("#inlineSquarePanel").hidden = value !== "SQUARE";
    $("#inlineZellePanel").hidden = value !== "ZELLE";
    $("#inlineCardMethod").classList.toggle("active", value === "SQUARE");
    $("#inlineZelleMethod").classList.toggle("active", value === "ZELLE");
  }
  $("#inlineCardMethod").addEventListener("click", () => setMethod("SQUARE"));
  $("#inlineZelleMethod").addEventListener("click", () => setMethod("ZELLE"));
  form.addEventListener("input", update);
  form.addEventListener("submit", event => event.preventDefault());

  payButton.addEventListener("click", async () => {
    if (busy || finished || method !== "SQUARE" || !squareCard) return;
    const data = details();
    if (!data) return;
    setBusy(true);
    status("");
    try {
      const prepared = await prepare(data);
      if (prepared.status === "CONFIRMED") {
        const existing = await api(`/api/reservations/${encodeURIComponent(checkoutToken)}`);
        return paid(existing.reservation);
      }
      if (prepared.status === "PAYMENT_PROCESSING") {
        const existing = await api(`/api/reservations/${encodeURIComponent(checkoutToken)}`);
        return existing.reservation.status === "CONFIRMED" ? paid(existing.reservation) : showProcessing(existing.reservation);
      }
      const token = unresolvedPayment ? { status: "OK", token: "retry-original-payment" } : await squareCard.tokenize({
        amount: Number(data.agreedAmount).toFixed(2), currencyCode: "USD", intent: "CHARGE", customerInitiated: true, sellerKeyedIn: false,
        billingContact: { givenName: data.firstName, familyName: data.lastName, phone: data.phone, countryCode: "US", ...(data.email ? { email: data.email } : {}) },
      });
      if (token.status !== "OK") throw new Error("Please check the card details and billing ZIP code.");
      const result = await api(`/api/reservations/${encodeURIComponent(checkoutToken)}/pay`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...data, sourceId: token.token }),
      });
      if (result.paymentPending || result.reservation.status !== "CONFIRMED") return showProcessing(result.reservation);
      try { await squareCard.destroy(); } catch {}
      squareCard = null;
      paid(result.reservation, result.receiptUrl);
    } catch (error) {
      if (error.paymentUncertain) {
        unresolvedPayment = true;
        $("#inlineCheckPayment").hidden = false;
        status("The payment result is not confirmed. Retry the original payment below or check its status. Do not create another payment or send Zelle.");
      } else status(error.message);
    }
    finally { setBusy(false); }
  });

  zelleButton.addEventListener("click", async () => {
    if (busy || finished || method !== "ZELLE") return;
    const data = details();
    if (!data) return;
    setBusy(true);
    try {
      await prepare(data);
      const result = await api(`/api/reservations/${encodeURIComponent(checkoutToken)}/zelle`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
      });
      if (result.reservation.status === "CONFIRMED") return paid(result.reservation);
      finished = true;
      unresolvedPayment = true;
      $("#inlineCheckPayment").hidden = false;
      status(`Zelle transfer reported for ${result.reservation.reference}. Grigor must verify receipt in the bank; payment is not confirmed yet.`);
    } catch (error) { status(error.message); }
    finally { setBusy(false); }
  });

  $("#inlineCheckPayment").addEventListener("click", async () => {
    if (!checkoutToken) return;
    try {
      const result = await api(`/api/reservations/${encodeURIComponent(checkoutToken)}`);
      if (result.reservation.status === "CONFIRMED") paid(result.reservation);
      else status(`Payment for ${result.reservation.reference} is not confirmed yet. Please contact Grigor before making another payment.`);
    } catch (error) { status(error.message); }
  });

  return {
    async configure(value) {
      config = value;
      if (config.services.paymentsReady) {
        try {
          await loadSquareSdk();
          const payments = window.Square.payments(config.squareApplicationId, config.squareLocationId);
          squareCard = await payments.card();
          await squareCard.attach("#inlineCardContainer");
          $("#inlineCardLoading").hidden = true;
        } catch (error) { $("#inlineCardLoading").textContent = error.message; }
      } else { $("#inlineCardLoading").textContent = "Card payment is temporarily unavailable. You can choose Zelle."; }
      try {
        const image = new Image(); image.src = "/assets/zelle-qr-source.png"; await image.decode();
        $("#inlineZelleQr").getContext("2d").drawImage(image, 150, 800, 825, 1297, 0, 0, 330, 519);
      } catch { $("#inlineZelleQr").hidden = true; }
      try {
        const savedToken = sessionStorage.getItem("davtian-last-checkout");
        if (savedToken) {
          const saved = await api(`/api/reservations/${encodeURIComponent(savedToken)}`);
          if (saved.reservation.status === "PAYMENT_PROCESSING" || saved.reservation.zellePending || (saved.reservation.paymentMethod === "SQUARE" && saved.reservation.status === "APPROVED")) {
            checkoutToken = savedToken;
            showProcessing(saved.reservation);
            update();
          }
        }
      } catch { /* Old or cancelled checkouts do not block a new trip. */ }
      resolvingPrevious = false;
      update();
    },
    setTrip(value) {
      if (unresolvedPayment) return;
      const keepAmount = trip && trip.pickupAddress === value.pickupAddress && trip.destinationAddress === value.destinationAddress && trip.pickupDate === value.pickupDate && trip.pickupTime === value.pickupTime ? amount.value : "";
      trip = value;
      checkoutToken = "";
      finished = false;
      form.hidden = false;
      $("#inlinePaymentDone").hidden = true;
      $("#inlineReceipt").hidden = true;
      $("#inlineCheckPayment").hidden = true;
      amount.value = keepAmount || Number(value.estimatedPrice).toFixed(2);
      $("#smsConfirmed").checked = false;
      status("Enter the price agreed with Grigor by SMS. Pay only after he confirms your pickup time.");
      update();
    },
    resetTrip() {
      if (busy || unresolvedPayment) return;
      trip = null;
      checkoutToken = "";
      $("#smsConfirmed").checked = false;
      update();
    },
  };
}
