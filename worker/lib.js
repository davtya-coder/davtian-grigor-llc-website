const encoder = new TextEncoder();

export const BUSINESS = Object.freeze({
  name: "Davtian Grigor LLC",
  vehicle: "2025 BMW X5",
  squareApplicationId: "sq0idp-mn4whAbG0YQAFvNlqwHRJw",
  squareLocationId: "LWWHWQ4CTYKWG",
  termsVersion: "2026-10-09",
});

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

export function cleanText(value, max = 300) {
  return typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
}

export function normalizeEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : "";
}

export function normalizePhone(value) {
  const raw = cleanText(value, 40);
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15 && raw.startsWith("+")) return `+${digits}`;
  return "";
}

export function clampInteger(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

export function parseDuration(value) {
  const match = String(value || "").match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  return match ? Math.round(Number(match[1])) : 0;
}

export function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

export function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return toBase64Url(bytes);
}

export function randomReference() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const suffix = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
  return `DG-${date}-${suffix}`;
}

export function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function fromBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function signPayload(payload, secret) {
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = toBase64Url(await hmac(encoded, secret));
  return `${encoded}.${signature}`;
}

export async function verifyPayload(token, secret) {
  if (!secret || typeof token !== "string") return null;
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra) return null;
  const expectedSignature = toBase64Url(await hmac(encoded, secret));
  if (!constantTimeEqual(expectedSignature, suppliedSignature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % a.length] || 0) ^ (b[index % b.length] || 0);
  }
  return difference === 0;
}

export function parseCookies(request) {
  return Object.fromEntries((request.headers.get("cookie") || "").split(";").map(part => {
    const separator = part.indexOf("=");
    return separator < 0 ? ["", ""] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1))];
  }).filter(([key]) => key));
}

export async function createAdminCookie(request, env) {
  const expires = Math.floor(Date.now() / 1000) + 8 * 60 * 60;
  const token = await signPayload({ role: "owner", exp: expires }, env.SESSION_SECRET);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `dg_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`;
}

export function clearAdminCookie(request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `dg_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export async function isAdmin(request, env) {
  const token = parseCookies(request).dg_admin;
  const payload = await verifyPayload(token, env.SESSION_SECRET);
  return payload?.role === "owner";
}

export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("JSON_REQUIRED");
  return request.json();
}

export function trafficLabel(durationSeconds, staticSeconds) {
  if (!durationSeconds || !staticSeconds) return "Unavailable";
  const ratio = durationSeconds / staticSeconds;
  if (ratio >= 1.35) return "Heavy";
  if (ratio >= 1.15) return "Moderate";
  return "Light";
}

export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(self), payment=(self)");
  headers.set("x-frame-options", "DENY");
  headers.set("content-security-policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "script-src 'self' https://web.squarecdn.com",
    "style-src 'self' 'unsafe-inline' https://web.squarecdn.com",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "frame-src https://web.squarecdn.com https://pci-connect.squareup.com https://*.squarecdn.com https://*.squareup.com",
    "connect-src 'self' https://web.squarecdn.com https://pci-connect.squareup.com https://*.squarecdn.com https://*.squareup.com",
  ].join("; "));
  if (new URL(response.url || "https://example.com").protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function csvEscape(value) {
  const string = String(value ?? "");
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}
