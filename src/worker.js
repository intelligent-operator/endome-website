// EndoMe Worker
// - Serves /api/* (Stripe Checkout, Mandrill, auth)
// - Protects /dashboard* with a signed-cookie session
// - Wraps every HTML response with strict security headers
// Static files come from the [assets] binding under /public.

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const SESSION_COOKIE = "endome_session";
const SESSION_TTL_SEC = 60 * 60 * 12;            // 12 hours
const LOGIN_FAIL_DELAY_MS = 300;                 // small constant-time-ish stall
const MAX_USERNAME_LEN = 100;
const MAX_PASSWORD_LEN = 500;

// Strict security headers attached to every text/html response.
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(self)",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy":
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
    "font-src https://fonts.gstatic.com data:; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self' https://api.stripe.com; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "object-src 'none'",
};

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    // --- API routes ---------------------------------------------------------
    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/subscribe" && request.method === "POST") {
          return jsonHeaders(await handleSubscribe(request, env));
        }
        if (url.pathname === "/api/checkout" && request.method === "POST") {
          return jsonHeaders(await handleCheckout(request, env));
        }
        if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
          return await handleStripeWebhook(request, env);
        }
        if (url.pathname === "/api/contact" && request.method === "POST") {
          return jsonHeaders(await handleContact(request, env));
        }
        if (url.pathname === "/api/login" && request.method === "POST") {
          return await handleLogin(request, env);
        }
        if (url.pathname === "/api/logout") {
          return await handleLogout(request, env);
        }
        return json({ error: "Not found" }, 404);
      } catch (err) {
        console.error("api error", err);
        return json({ error: "Server error" }, 500);
      }
    }

    // --- Dashboard auth gate ------------------------------------------------
    if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
      const session = await readSession(request, env);
      if (!session) {
        return Response.redirect(new URL("/login", request.url).toString(), 302);
      }
    }

    // --- Static assets ------------------------------------------------------
    const assetResponse = await env.ASSETS.fetch(request);
    return withSecurityHeaders(assetResponse);
  },
};

// =============================================================================
// AUTH
// =============================================================================

async function handleLogin(request, env) {
  // Only accept JSON to make CSRF-via-form impossible.
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return json({ error: "Invalid request" }, 400);
  }

  let body;
  try { body = await request.json(); } catch { body = null; }
  const username = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";

  // Strict input validation. Reject anything weird before touching secrets.
  if (
    username.length === 0 ||
    username.length > MAX_USERNAME_LEN ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LEN ||
    /[\x00-\x1f\x7f]/.test(username)
  ) {
    await sleep(LOGIN_FAIL_DELAY_MS);
    return json({ error: "Invalid credentials" }, 401);
  }

  const cfgUser = env.AUTH_USERNAME || "";
  const cfgPass = env.AUTH_PASSWORD || "";
  const sessionSecret = env.SESSION_SECRET || "";
  if (!cfgUser || !cfgPass || !sessionSecret) {
    console.error("auth: missing AUTH_USERNAME / AUTH_PASSWORD / SESSION_SECRET");
    return json({ error: "Authentication not configured" }, 503);
  }

  const userOk = timingSafeEqual(username, cfgUser);
  const passOk = timingSafeEqual(password, cfgPass);
  if (!userOk || !passOk) {
    await sleep(LOGIN_FAIL_DELAY_MS);
    return json({ error: "Invalid credentials" }, 401);
  }

  const token = await signSession(
    { u: cfgUser, iat: nowSec(), exp: nowSec() + SESSION_TTL_SEC },
    sessionSecret
  );

  const headers = new Headers(JSON_HEADERS);
  headers.append("Set-Cookie", buildCookie(SESSION_COOKIE, token, request, SESSION_TTL_SEC));
  return new Response(JSON.stringify({ ok: true, redirect: "/dashboard" }), {
    status: 200,
    headers,
  });
}

async function handleLogout(request, _env) {
  const headers = new Headers({ location: "/" });
  headers.append("Set-Cookie", buildCookie(SESSION_COOKIE, "", request, 0));
  return new Response(null, { status: 302, headers });
}

async function readSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const payload = await verifySession(token, env.SESSION_SECRET);
  if (!payload) return null;
  if (payload.exp && payload.exp < nowSec()) return null;
  return payload;
}

// --- Session token: base64url(payload).base64url(HMAC-SHA256) ---------------

async function signSession(payload, secret) {
  const data = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, data));
  return `${data}.${sig}`;
}

async function verifySession(token, secret) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Cap parsing work to defend against absurdly long input.
  if (data.length > 4096 || sig.length > 256) return null;

  const expected = b64url(await hmac(secret, data));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const json = new TextDecoder().decode(b64urlDecode(data));
    return JSON.parse(json);
  } catch { return null; }
}

async function hmac(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function getCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  // Anchored match, no regex shenanigans on attacker-controlled names.
  const needle = `${name}=`;
  for (const part of cookie.split(/;\s*/)) {
    if (part.startsWith(needle)) return part.slice(needle.length);
  }
  return null;
}

function buildCookie(name, value, request, maxAgeSec) {
  const isHttps = new URL(request.url).protocol === "https:";
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (isHttps) parts.push("Secure");
  parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join("; ");
}

// =============================================================================
// SECURITY HEADERS
// =============================================================================

function withSecurityHeaders(response) {
  const ct = response.headers.get("content-type") || "";
  if (!ct.startsWith("text/html")) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, { status: response.status, headers });
}

// =============================================================================
// EXISTING: newsletter / Stripe / Mandrill / contact
// =============================================================================

async function handleSubscribe(request, env) {
  const { email } = await readJson(request);
  if (!isEmail(email)) return json({ error: "Invalid email" }, 400);

  await mandrillSend(env, {
    to: [{ email, type: "to" }],
    subject: "Welcome to EndoMe",
    from_email: env.NEWSLETTER_FROM_EMAIL,
    from_name: env.NEWSLETTER_FROM_NAME,
    html:
      `<p>Thanks for joining EndoMe.</p>` +
      `<p>Your story starts here. We'll keep you posted on health tips, ` +
      `stories from the community, and product updates.</p>`,
    text:
      "Thanks for joining EndoMe.\n\n" +
      "Your story starts here. We'll keep you posted on health tips, " +
      "stories from the community, and product updates.",
  });

  await mandrillSend(env, {
    to: [{ email: env.NOTIFY_EMAIL, type: "to" }],
    subject: "New newsletter signup",
    from_email: env.NEWSLETTER_FROM_EMAIL,
    from_name: env.NEWSLETTER_FROM_NAME,
    text: `New subscriber: ${email}`,
  });

  return json({ ok: true });
}

async function handleCheckout(request, env) {
  const body = await readJson(request).catch(() => ({}));
  const priceId = body.priceId || env.STRIPE_DNA_PRICE_ID;
  if (!priceId) return json({ error: "Missing price" }, 400);

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", `${env.SITE_URL}/?checkout=success`);
  form.set("cancel_url", `${env.SITE_URL}/?checkout=cancelled`);
  form.set("allow_promotion_codes", "true");
  form.set("billing_address_collection", "required");
  form.set("shipping_address_collection[allowed_countries][0]", "GB");
  form.set("shipping_address_collection[allowed_countries][1]", "US");
  form.set("automatic_tax[enabled]", "true");

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("stripe checkout failed", res.status, text);
    return json({ error: "Checkout failed" }, 502);
  }
  const session = await res.json();
  return json({ url: session.url });
}

async function handleStripeWebhook(request, env) {
  const signature = request.headers.get("stripe-signature");
  const payload = await request.text();
  const ok = await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("Invalid signature", { status: 400 });

  const event = JSON.parse(payload);
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    if (customerEmail) {
      await mandrillSend(env, {
        to: [{ email: customerEmail, type: "to" }],
        subject: "Your EndoMe DNA test is on the way",
        from_email: env.NEWSLETTER_FROM_EMAIL,
        from_name: env.NEWSLETTER_FROM_NAME,
        html:
          `<p>Thanks for your order.</p>` +
          `<p>We'll prepare your at-home DNA test kit and email you a tracking link shortly. ` +
          `In the meantime, download the EndoMe app to set up your profile and EndoPet.</p>`,
      });
    }
    await mandrillSend(env, {
      to: [{ email: env.NOTIFY_EMAIL, type: "to" }],
      subject: `New DNA test order — ${customerEmail || "unknown"}`,
      from_email: env.NEWSLETTER_FROM_EMAIL,
      from_name: env.NEWSLETTER_FROM_NAME,
      text: `Stripe session: ${session.id}\nAmount: ${session.amount_total}\nEmail: ${customerEmail}`,
    });
  }
  return new Response("ok");
}

async function handleContact(request, env) {
  const { name, email, message } = await readJson(request);
  if (!isEmail(email) || !message) return json({ error: "Invalid input" }, 400);
  await mandrillSend(env, {
    to: [{ email: env.NOTIFY_EMAIL, type: "to" }],
    subject: `Contact form: ${name || "Anonymous"}`,
    from_email: env.NEWSLETTER_FROM_EMAIL,
    from_name: env.NEWSLETTER_FROM_NAME,
    headers: { "Reply-To": email },
    text: `From: ${name || "Anonymous"} <${email}>\n\n${message}`,
  });
  return json({ ok: true });
}

// =============================================================================
// HELPERS
// =============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
async function readJson(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return request.json();
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}
function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nowSec() { return Math.floor(Date.now() / 1000); }

async function mandrillSend(env, message) {
  if (!env.MANDRILL_API_KEY) throw new Error("MANDRILL_API_KEY not configured");
  const res = await fetch("https://mandrillapp.com/api/1.0/messages/send.json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: env.MANDRILL_API_KEY, message }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mandrill ${res.status}: ${text}`);
  }
  return res.json();
}

async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const timestamp = parts.t;
  const sig = parts.v1;
  if (!timestamp || !sig) return false;
  const mac = await hmac(secret, `${timestamp}.${payload}`);
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, sig);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
