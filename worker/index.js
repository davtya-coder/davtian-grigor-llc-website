const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  },
});

const vehicleRates = {
  "90": { name: "2025 BMW X5", hourlyRate: 90, maxPassengers: 4 },
};

function cleanText(value, max = 300) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function createPayment(request, env) {
  if (!env.SQUARE_ACCESS_TOKEN) {
    return json({ ok: false, message: "Secure payment setup is not complete yet." }, 503);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid payment request." }, 400);
  }

  const vehicle = vehicleRates[String(input.vehicle)];
  const hours = Number(input.hours);
  const passengers = Number(input.passengers);
  const sourceId = cleanText(input.sourceId, 200);
  const idempotencyKey = cleanText(input.idempotencyKey, 100);
  const firstName = cleanText(input.firstName, 60);
  const lastName = cleanText(input.lastName, 60);
  const phone = cleanText(input.phone, 40);
  const email = cleanText(input.email, 160);
  const pickup = cleanText(input.pickup, 250);
  const destination = cleanText(input.destination, 250);
  const date = cleanText(input.date, 20);
  const time = cleanText(input.time, 20);
  const notes = cleanText(input.notes, 250);
  const tip = Number(input.tip || 0);
  const paymentAmount = Number(input.paymentAmount);

  const estimatedTotal = vehicle ? vehicle.hourlyRate * hours * 100 : 0;

  if (!vehicle || !Number.isInteger(hours) || hours < 2 || hours > 10 ||
      !Number.isInteger(passengers) || passengers < 1 || passengers > vehicle.maxPassengers ||
      !Number.isInteger(paymentAmount) || paymentAmount < 1000 || paymentAmount > estimatedTotal ||
      !Number.isInteger(tip) || tip < 0 || tip > 50000 ||
      !sourceId || !idempotencyKey || !firstName || !lastName || !phone || !email || !pickup || !destination || !date || !time) {
    return json({ ok: false, message: "Please check the reservation details and try again." }, 400);
  }

  const remainingBalance = estimatedTotal - paymentAmount;
  const tripNote = [
    `${vehicle.name} — ${hours} hours`,
    `${date} ${time}`,
    `${pickup} to ${destination}`,
    `Passenger: ${firstName} ${lastName} · ${phone}`,
    `Estimated trip total: $${(estimatedTotal / 100).toFixed(2)}`,
    `Payment today: $${(paymentAmount / 100).toFixed(2)} · Remaining balance by agreement: $${(remainingBalance / 100).toFixed(2)}`,
    tip ? `Optional tip paid: $${(tip / 100).toFixed(2)}` : "No tip added",
    notes ? `Notes: ${notes}` : "",
  ].filter(Boolean).join(" | ").slice(0, 500);

  const squareResponse = await fetch("https://connect.squareup.com/v2/payments", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: { amount: paymentAmount, currency: "USD" },
      ...(tip ? { tip_money: { amount: tip, currency: "USD" } } : {}),
      location_id: "LWWHWQ4CTYKWG",
      autocomplete: true,
      buyer_email_address: email,
      note: tripNote,
      reference_id: `booking-${idempotencyKey}`.slice(0, 40),
    }),
  });

  const result = await squareResponse.json().catch(() => ({}));
  if (!squareResponse.ok || !result.payment) {
    const code = result?.errors?.[0]?.code;
    const message = code === "CARD_DECLINED" ? "The card was declined. Please use another card." :
      code === "VERIFY_CVV_FAILURE" ? "Please check the security code and try again." :
      code === "VERIFY_POSTAL_CODE_FAILURE" ? "Please check the billing ZIP code and try again." :
      "Payment could not be completed. Please check the card details and try again.";
    return json({ ok: false, message }, 400);
  }

  return json({
    ok: true,
    paymentId: result.payment.id,
    receiptUrl: result.payment.receipt_url || null,
    status: result.payment.status,
    paymentAmount: paymentAmount / 100,
    tip: tip / 100,
    chargedToday: (paymentAmount + tip) / 100,
    estimatedTotal: estimatedTotal / 100,
    remainingBalance: remainingBalance / 100,
    vehicle: vehicle.name,
    date,
    time,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/create-payment" && request.method === "POST") {
      try {
        return await createPayment(request, env);
      } catch {
        return json({ ok: false, message: "Payment service is temporarily unavailable. Please try again." }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
