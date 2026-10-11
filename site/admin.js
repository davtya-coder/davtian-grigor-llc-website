const $ = selector => document.querySelector(selector);
const state = { bookings: [], selected: null, status: "", settings: null };
const money = cents => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(cents || 0) / 100);

function setStatus(element, message = "", type = "error") {
  element.textContent = message;
  element.className = message ? `status-message ${type}` : "status-message";
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
  if (!response.ok || result.ok === false) {
    const error = new Error(result.message || "Something went wrong.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function dateText(row) {
  return `${row.pickup_date} · ${row.pickup_time}`;
}

function renderList() {
  const list = $("#bookingList");
  list.replaceChildren();
  if (!state.bookings.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No bookings in this view.";
    list.append(empty);
    return;
  }
  state.bookings.forEach(row => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `booking-item${state.selected?.id === row.id ? " active" : ""}`;
    const reference = document.createElement("strong");
    const route = document.createElement("span");
    const date = document.createElement("span");
    const status = document.createElement("span");
    reference.textContent = row.reference;
    route.textContent = `${row.pickup_address} → ${row.destination_address}`;
    date.textContent = dateText(row);
    status.className = "status-pill";
    status.textContent = row.status;
    button.append(reference, route, date, status);
    button.addEventListener("click", () => selectBooking(row.id));
    list.append(button);
  });
}

function serviceBadge(label, ready) {
  const badge = document.createElement("span");
  badge.className = ready ? "ready" : "";
  badge.textContent = `${ready ? "✓" : "○"} ${label}`;
  return badge;
}

async function loadSettings() {
  const result = await api("/api/admin/settings");
  state.settings = result.settings;
  $("#serviceStatus").replaceChildren(
    serviceBadge("Google Maps", result.services.mapsReady),
    serviceBadge("Email", result.services.emailReady),
    serviceBadge("Square", result.services.paymentsReady),
  );
}

async function loadBookings(keepSelection = true) {
  const query = state.status ? `?status=${encodeURIComponent(state.status)}` : "";
  const result = await api(`/api/admin/bookings${query}`);
  state.bookings = result.bookings;
  renderList();
  if (keepSelection && state.selected && state.bookings.some(row => row.id === state.selected.id)) await selectBooking(state.selected.id);
}

function showDashboard() {
  $("#loginPanel").hidden = true;
  $("#dashboard").hidden = false;
}

async function start() {
  try {
    await api("/api/admin/session");
    showDashboard();
    await Promise.all([loadSettings(), loadBookings(false)]);
  } catch (error) {
    if (error.status !== 401) setStatus($("#loginStatus"), error.message, "error");
  }
}

$("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  setStatus($("#loginStatus"));
  try {
    await api("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: $("#password").value }),
    });
    showDashboard();
    await Promise.all([loadSettings(), loadBookings(false)]);
  } catch (error) {
    setStatus($("#loginStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

async function selectBooking(id) {
  const result = await api(`/api/admin/bookings/${id}`);
  state.selected = result.booking;
  renderList();
  $("#emptyDetail").hidden = true;
  $("#bookingDetail").hidden = false;
  const row = state.selected;
  $("#detailReference").textContent = row.reference;
  $("#detailStatus").textContent = row.status;
  $("#detailPickup").textContent = row.pickup_address;
  $("#detailDestination").textContent = row.destination_address;
  $("#detailDate").textContent = dateText(row);
  $("#detailRoute").textContent = `${Number(row.distance_miles).toFixed(1)} miles · about ${Math.ceil(row.duration_seconds / 60)} minutes · ${row.traffic_condition || "traffic unavailable"}`;
  $("#detailContact").textContent = `${row.contact_type}: ${row.contact_value}`;
  $("#detailEstimate").textContent = money(row.estimated_price_cents);
  $("#detailFinal").textContent = row.final_price_cents == null ? "Not approved" : money(row.final_price_cents);
  const pendingZelle = row.payment_method === "ZELLE" && row.zelle_submitted_at && !row.zelle_verified_at;
  if (row.payment_id) {
    $("#detailPayment").textContent = `${row.payment_method || "Payment"} · ${money(row.payment_amount_cents)} · ${row.payment_status} · ${row.payment_id}`;
  } else if (pendingZelle) {
    $("#detailPayment").textContent = `Zelle · ${money(row.payment_requested_amount_cents)} awaiting your bank verification`;
  } else {
    $("#detailPayment").textContent = "Not paid";
  }
  $("#detailRemaining").textContent = row.remaining_balance_cents == null
    ? (row.final_price_cents == null ? "—" : money(row.final_price_cents))
    : money(row.remaining_balance_cents);
  $("#finalPrice").value = Number((row.final_price_cents ?? row.estimated_price_cents) / 100).toFixed(2);
  let allowedOptions = ["10", "20", "full"];
  try { allowedOptions = JSON.parse(row.allowed_payment_options_json || "[]"); } catch {}
  $("#allow10").checked = allowedOptions.includes("10");
  $("#allow20").checked = allowedOptions.includes("20");
  $("#allowFull").checked = allowedOptions.includes("full");
  $("#customerAddress").value = row.customer_address || "";
  $("#passengerCount").value = row.passenger_count || "";
  $("#driverName").value = row.driver_name || state.settings?.driver_name || "";
  $("#vehiclePlate").value = row.vehicle_plate || state.settings?.vehicle_plate || "";
  $("#tcpNumber").value = row.tcp_number || state.settings?.tcp_number || "";
  $("#ownerNotes").value = row.owner_notes || "";
  $("#approveButton").disabled = !["REQUESTED", "APPROVED"].includes(row.status) || Boolean(row.payment_method);
  $("#declineButton").disabled = !["REQUESTED", "APPROVED"].includes(row.status) || Boolean(row.payment_method);
  $("#cancelButton").disabled = !["REQUESTED", "APPROVED", "CONFIRMED"].includes(row.status);
  $("#refundButton").disabled = row.payment_method !== "SQUARE" || !row.payment_id || !["CONFIRMED", "CANCELLED"].includes(row.status);
  $("#verifyZelleButton").hidden = !pendingZelle;
  $("#verifyZelleButton").disabled = !pendingZelle;
  $("#waybillButton").href = `/waybill.html?id=${row.id}`;
  $("#approvalLinkBox").hidden = true;
}

$("#filters").addEventListener("click", async event => {
  const button = event.target.closest("button[data-status]");
  if (!button) return;
  state.status = button.dataset.status;
  document.querySelectorAll("#filters button").forEach(item => item.classList.toggle("active", item === button));
  state.selected = null;
  $("#bookingDetail").hidden = true;
  $("#emptyDetail").hidden = false;
  await loadBookings(false);
});

$("#approveButton").addEventListener("click", async () => {
  if (!state.selected) return;
  const finalPrice = Number($("#finalPrice").value);
  if (!Number.isFinite(finalPrice) || finalPrice <= 0) return setStatus($("#globalStatus"), "Enter a valid final price.", "error");
  const allowedPaymentOptions = [
    $("#allow10").checked ? "10" : "",
    $("#allow20").checked ? "20" : "",
    $("#allowFull").checked ? "full" : "",
  ].filter(Boolean);
  if (!allowedPaymentOptions.length) return setStatus($("#globalStatus"), "Allow at least one payment amount.", "error");
  $("#approveButton").disabled = true;
  setStatus($("#globalStatus"));
  try {
    const result = await api(`/api/admin/bookings/${state.selected.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ finalPrice, allowedPaymentOptions }),
    });
    $("#approvalLink").href = result.link;
    $("#approvalLink").textContent = result.link;
    $("#approvalDelivery").textContent = result.notification.sent
      ? "Approval and the secure link were sent to the customer."
      : `The booking is approved, but automatic delivery was not sent: ${result.notification.reason || "provider not configured"}. Copy the link below.`;
    $("#approvalLinkBox").hidden = false;
    setStatus($("#globalStatus"), "Booking approved. No payment has been charged yet.", "success");
    state.selected = result.booking;
    await loadBookings(false);
    $("#detailStatus").textContent = result.booking.status;
    $("#detailFinal").textContent = money(result.booking.final_price_cents);
    $("#approveButton").disabled = false;
  } catch (error) {
    setStatus($("#globalStatus"), error.message, "error");
    $("#approveButton").disabled = false;
  }
});

$("#copyLinkButton").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#approvalLink").href);
  $("#copyLinkButton").textContent = "Copied";
});

$("#declineButton").addEventListener("click", async () => {
  if (!state.selected || !confirm("Decline this booking request? No payment will be taken.")) return;
  const reason = prompt("Optional reason for your records:", "") || "";
  try {
    await api(`/api/admin/bookings/${state.selected.id}/decline`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
    });
    setStatus($("#globalStatus"), "Booking declined. No payment was taken.", "success");
    await loadBookings();
  } catch (error) { setStatus($("#globalStatus"), error.message, "error"); }
});

$("#waybillForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.selected) return;
  try {
    await api(`/api/admin/bookings/${state.selected.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerAddress: $("#customerAddress").value,
        passengerCount: $("#passengerCount").value,
        driverName: $("#driverName").value,
        vehiclePlate: $("#vehiclePlate").value,
        tcpNumber: $("#tcpNumber").value,
        ownerNotes: $("#ownerNotes").value,
      }),
    });
    setStatus($("#globalStatus"), "Waybill details saved.", "success");
    await selectBooking(state.selected.id);
  } catch (error) { setStatus($("#globalStatus"), error.message, "error"); }
});

$("#cancelButton").addEventListener("click", async () => {
  if (!state.selected || !confirm("Mark this booking as cancelled? This does not automatically issue a refund.")) return;
  const reason = prompt("Cancellation reason:", "") || "";
  try {
    await api(`/api/admin/bookings/${state.selected.id}/cancel`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
    });
    setStatus($("#globalStatus"), "Booking cancelled. Use Issue refund separately if money should be returned.", "success");
    await loadBookings();
  } catch (error) { setStatus($("#globalStatus"), error.message, "error"); }
});

$("#refundButton").addEventListener("click", async () => {
  if (!state.selected) return;
  const maximum = (Number(state.selected.payment_amount_cents) - Number(state.selected.refund_amount_cents || 0)) / 100;
  const amount = Number(prompt(`Refund amount (maximum $${maximum.toFixed(2)}):`, maximum.toFixed(2)));
  if (!Number.isFinite(amount) || amount <= 0 || !confirm(`Issue a $${amount.toFixed(2)} refund through Square?`)) return;
  const reason = prompt("Refund reason:", "Customer request") || "Customer request";
  try {
    await api(`/api/admin/bookings/${state.selected.id}/refund`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount, reason }),
    });
    setStatus($("#globalStatus"), "Refund submitted through Square.", "success");
    await loadBookings();
  } catch (error) { setStatus($("#globalStatus"), error.message, "error"); }
});

$("#verifyZelleButton").addEventListener("click", async () => {
  if (!state.selected) return;
  const amount = money(state.selected.payment_requested_amount_cents);
  if (!confirm(`Confirm only if ${amount} is visible in the DAVTIAN GRIGOR LLC bank account. Mark this Zelle payment received?`)) return;
  $("#verifyZelleButton").disabled = true;
  try {
    const result = await api(`/api/admin/bookings/${state.selected.id}/verify-zelle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    setStatus($("#globalStatus"), "Zelle payment verified. The booking is confirmed.", "success");
    await loadBookings(false);
    await selectBooking(result.booking.id);
  } catch (error) {
    setStatus($("#globalStatus"), error.message, "error");
    $("#verifyZelleButton").disabled = false;
  }
});

function populateSettings() {
  const row = state.settings;
  $("#ownerEmail").value = row.owner_email || "";
  $("#baseFare").value = row.base_fare_cents / 100;
  $("#perMile").value = row.per_mile_cents / 100;
  $("#perMinute").value = row.per_minute_cents / 100;
  $("#minimumPrice").value = row.minimum_price_cents / 100;
  $("#settingsDriverName").value = row.driver_name || "";
  $("#settingsVehiclePlate").value = row.vehicle_plate || "";
  $("#settingsTcpNumber").value = row.tcp_number || "";
}

$("#settingsButton").addEventListener("click", () => { populateSettings(); $("#settingsDialog").showModal(); });
$("#closeSettings").addEventListener("click", () => $("#settingsDialog").close());
$("#settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  const payload = {
    ownerEmail: $("#ownerEmail").value,
    baseFare: $("#baseFare").value,
    perMile: $("#perMile").value,
    perMinute: $("#perMinute").value,
    minimumPrice: $("#minimumPrice").value,
    driverName: $("#settingsDriverName").value,
    vehiclePlate: $("#settingsVehiclePlate").value,
    tcpNumber: $("#settingsTcpNumber").value,
  };
  try {
    await api("/api/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    await loadSettings();
    setStatus($("#settingsStatus"), "Settings saved.", "success");
  } catch (error) { setStatus($("#settingsStatus"), error.message, "error"); }
});

$("#testEmailButton").addEventListener("click", async () => {
  const button = $("#testEmailButton");
  button.disabled = true;
  setStatus($("#settingsStatus"));
  try {
    const result = await api("/api/admin/test-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    setStatus($("#settingsStatus"), result.message, "success");
  } catch (error) {
    setStatus($("#settingsStatus"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#refreshButton").addEventListener("click", () => Promise.all([loadSettings(), loadBookings()]));
$("#logoutButton").addEventListener("click", async () => { await api("/api/admin/logout", { method: "POST" }); location.reload(); });
start();
