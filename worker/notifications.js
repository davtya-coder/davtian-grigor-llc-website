import { BUSINESS, escapeHtml, money } from "./lib.js";

export async function sendEmail(env, { to, subject, html, replyTo, idempotencyKey }) {
  if (!to) {
    return { sent: false, reason: "Email provider is not configured." };
  }
  if (env.EMAIL && env.EMAIL_FROM) {
    try {
      const match = String(env.EMAIL_FROM).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
      const from = match ? { name: match[1] || BUSINESS.name, email: match[2] } : { name: BUSINESS.name, email: String(env.EMAIL_FROM).trim() };
      await env.EMAIL.send({
        to: [to],
        from,
        subject,
        html,
        ...(replyTo ? { replyTo } : {}),
        text: html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      });
      return { sent: true, provider: "cloudflare" };
    } catch (error) {
      console.error("Cloudflare Email failed", error);
      return { sent: false, reason: "Email delivery failed." };
    }
  }
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) {
    return { sent: false, reason: "Email provider is not configured." };
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Email failed", response.status, detail.slice(0, 300));
    return { sent: false, reason: "Email delivery failed." };
  }
  return { sent: true, provider: "resend" };
}

export async function sendSms(env, { to, body }) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER || !to) {
    return { sent: false, reason: "SMS provider is not configured." };
  }
  const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body });
  const credentials = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${credentials}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("SMS failed", response.status, detail.slice(0, 300));
    return { sent: false, reason: "SMS delivery failed." };
  }
  return { sent: true };
}

function tripRows(booking) {
  return `
    <table style="border-collapse:collapse;width:100%;max-width:640px">
      <tr><td style="padding:8px;border-bottom:1px solid #ddd">Reference</td><td style="padding:8px;border-bottom:1px solid #ddd"><strong>${escapeHtml(booking.reference)}</strong></td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #ddd">Vehicle</td><td style="padding:8px;border-bottom:1px solid #ddd">${BUSINESS.vehicle}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #ddd">Pickup</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(booking.pickup_address)}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #ddd">Destination</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(booking.destination_address)}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #ddd">Date & time</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(booking.pickup_date)} ${escapeHtml(booking.pickup_time)}</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #ddd">Distance</td><td style="padding:8px;border-bottom:1px solid #ddd">${Number(booking.distance_miles).toFixed(1)} miles</td></tr>
      <tr><td style="padding:8px;border-bottom:1px solid #ddd">Estimated time</td><td style="padding:8px;border-bottom:1px solid #ddd">${Math.ceil(Number(booking.duration_seconds) / 60)} minutes</td></tr>
    </table>`;
}

export async function notifyOwnerOfRequest(env, booking, origin, configuredOwnerEmail) {
  const ownerEmail = env.OWNER_EMAIL || configuredOwnerEmail || "davtya@gmail.com";
  return sendEmail(env, {
    to: ownerEmail,
    subject: `New booking request ${booking.reference}`,
    replyTo: booking.contact_value,
    idempotencyKey: `owner-request/${booking.reference}`,
    html: `<h2>New booking request</h2>${tripRows(booking)}
      <p><strong>Estimate:</strong> ${money(booking.estimated_price_cents)}</p>
      <p><strong>Customer contact:</strong> ${escapeHtml(booking.contact_value)}</p>
      <p><a href="${escapeHtml(`${origin}/admin.html`)}">Open the private owner dashboard</a> to accept, decline, or change the price.</p>`,
  });
}

export async function notifyCustomerApproved(env, booking, link) {
  let approvedOptions = [];
  try { approvedOptions = JSON.parse(booking.allowed_payment_options_json || "[]"); } catch {}
  const options = approvedOptions.map(option => option === "full" ? "full payment" : `$${option}`).join(", ");
  const message = `${BUSINESS.name}: booking ${booking.reference} approved for ${money(booking.final_price_cents)}. Available payment amounts: ${options}. Complete your reservation securely: ${link}`;
  if (booking.contact_type === "email") {
    return sendEmail(env, {
      to: booking.contact_value,
      subject: `Your booking ${booking.reference} is approved`,
      html: `<h2>Your booking is approved</h2>${tripRows(booking)}
        <p><strong>Approved total:</strong> ${money(booking.final_price_cents)}</p>
        <p><strong>Allowed payment amounts:</strong> ${escapeHtml(options)}</p>
        <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:999px">Choose Square or Zelle</a></p>
        <p>This secure link is for this booking only. No customer account is required.</p>`,
    });
  }
  return sendSms(env, { to: booking.contact_value, body: message });
}

export async function notifyOwnerOfZellePending(env, booking, configuredOwnerEmail) {
  return sendEmail(env, {
    to: env.OWNER_EMAIL || configuredOwnerEmail || "davtya@gmail.com",
    subject: `Verify Zelle payment — ${booking.reference}`,
    html: `<h2>Zelle payment awaiting your verification</h2>${tripRows(booking)}
      <p><strong>Customer:</strong> ${escapeHtml(`${booking.first_name} ${booking.last_name}`)}</p>
      <p><strong>Expected Zelle amount:</strong> ${money(booking.payment_requested_amount_cents)}</p>
      <p><strong>Important:</strong> Do not mark this booking paid until you personally see the money in the business bank account.</p>
      <p>Open the private owner dashboard and select “Confirm Zelle received” only after checking the bank.</p>`,
  });
}

export async function notifyCustomerDeclined(env, booking) {
  const message = `${BUSINESS.name}: we are sorry, booking request ${booking.reference} is not available. No payment was taken.`;
  if (booking.contact_type === "email") {
    return sendEmail(env, {
      to: booking.contact_value,
      subject: `Booking request ${booking.reference}`,
      html: `<p>${escapeHtml(message)}</p>`,
    });
  }
  return sendSms(env, { to: booking.contact_value, body: message });
}

export async function sendPaymentConfirmations(env, booking, configuredOwnerEmail) {
  const method = booking.payment_method === "ZELLE" ? "Zelle — verified by owner" : "Square card payment";
  const remaining = Number(booking.remaining_balance_cents || 0);
  const customerHtml = `<h2>Booking payment confirmed</h2>${tripRows(booking)}
    <p><strong>Payment method:</strong> ${escapeHtml(method)}</p>
    <p><strong>Amount paid:</strong> ${money(booking.payment_amount_cents)}</p>
    <p><strong>Remaining trip balance:</strong> ${money(remaining)}</p>
    <p><strong>Payment confirmation:</strong> ${escapeHtml(booking.payment_id)}</p>
    <p>Keep this email with your booking reference.</p>`;
  const ownerHtml = `<h2>Payment received</h2>${tripRows(booking)}
    <p><strong>Customer:</strong> ${escapeHtml(`${booking.first_name} ${booking.last_name}`)}</p>
    <p><strong>Email:</strong> ${escapeHtml(booking.email)}</p>
    <p><strong>Method:</strong> ${escapeHtml(method)}</p>
    <p><strong>Paid:</strong> ${money(booking.payment_amount_cents)}</p>
    <p><strong>Remaining:</strong> ${money(remaining)}</p>
    <p><strong>Payment confirmation:</strong> ${escapeHtml(booking.payment_id)}</p>`;
  const customer = await sendEmail(env, {
    to: booking.email,
    subject: `Payment confirmed — ${booking.reference}`,
    html: customerHtml,
  });
  const owner = await sendEmail(env, {
    to: env.OWNER_EMAIL || configuredOwnerEmail || "davtya@gmail.com",
    subject: `Paid booking ${booking.reference}`,
    html: ownerHtml,
  });
  return { customer, owner };
}

