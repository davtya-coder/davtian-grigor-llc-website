const $ = selector => document.querySelector(selector);
const id = new URLSearchParams(location.search).get("id");

async function load() {
  if (!/^\d+$/.test(id || "")) {
    $("#waybillWarning").textContent = "Invalid booking number.";
    $("#waybillWarning").hidden = false;
    return;
  }
  const response = await fetch(`/api/admin/bookings/${id}`);
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.href = `/admin.html?return=${encodeURIComponent(location.pathname + location.search)}`;
    return;
  }
  if (!response.ok) {
    $("#waybillWarning").textContent = result.message || "Waybill could not be loaded.";
    $("#waybillWarning").hidden = false;
    return;
  }
  const row = result.booking;
  const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ");
  const missing = [];
  if (!row.tcp_number) missing.push("TCP number");
  if (!row.vehicle_plate) missing.push("vehicle plate");
  if (!row.driver_name) missing.push("driver name");
  if (!fullName) missing.push("customer/passenger name");
  if (!row.customer_address) missing.push("customer address");
  if (!row.passenger_count) missing.push("passenger count");
  $("#reference").textContent = row.reference;
  $("#carrier").textContent = `Davtian Grigor LLC · ${row.tcp_number || "MISSING"}`;
  $("#plate").textContent = row.vehicle_plate || "MISSING";
  $("#driver").textContent = row.driver_name || "MISSING";
  $("#customer").textContent = `${fullName || "MISSING NAME"} · ${row.customer_address || "MISSING ADDRESS"}`;
  $("#arrangedAt").textContent = row.created_at;
  $("#method").textContent = row.arrangement_method || "Electronic communication";
  $("#passengers").textContent = row.passenger_count || "MISSING";
  $("#passengerName").textContent = fullName || "MISSING";
  $("#route").textContent = `${row.pickup_address} → ${row.destination_address}`;
  $("#pickupTime").textContent = `${row.pickup_date} · ${row.pickup_time}`;
  $("#status").textContent = row.status;
  $("#payment").textContent = row.payment_id ? `${row.payment_status} · ${row.payment_id}` : "Not paid";
  $("#waybillGrid").hidden = false;
  if (missing.length) {
    $("#waybillWarning").textContent = `Not ready for inspection. Complete: ${missing.join(", ")}.`;
    $("#waybillWarning").hidden = false;
  }
}

$("#printButton").addEventListener("click", () => window.print());
load();
