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

        // --- Authenticated user-data endpoints ----------------------------
        if (url.pathname.startsWith("/api/me/")) {
          const session = await readSession(request, env);
          if (!session) return json({ error: "Unauthorized" }, 401);
          if (!env.DB) return json({ error: "Database not configured" }, 503);
          const user = await getOrCreateUser(env, session.u);

          if (url.pathname === "/api/me/today" && request.method === "GET") {
            return jsonHeaders(await getMeToday(request, env, user));
          }
          if (url.pathname === "/api/me/checkin/morning" && request.method === "POST") {
            return jsonHeaders(await postMorningCheckin(request, env, user));
          }
          if (url.pathname === "/api/me/checkin/evening" && request.method === "POST") {
            return jsonHeaders(await postEveningCheckin(request, env, user));
          }
          if (url.pathname === "/api/me/symptoms" && request.method === "POST") {
            return jsonHeaders(await postSymptom(request, env, user));
          }
          if (url.pathname === "/api/me/symptoms" && request.method === "GET") {
            return jsonHeaders(await getSymptoms(request, env, user));
          }
          if (url.pathname === "/api/me/notifications" && request.method === "GET") {
            return jsonHeaders(await getNotifications(env, user));
          }
          const dismissMatch = url.pathname.match(/^\/api\/me\/notifications\/(\d+)\/dismiss$/);
          if (dismissMatch && request.method === "POST") {
            return jsonHeaders(await dismissNotification(env, user, +dismissMatch[1]));
          }
          return json({ error: "Not found" }, 404);
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

// =============================================================================
// USER DATA (D1) — daily logs, symptoms, pet, notifications
// =============================================================================

const POINTS_MORNING = 10;
const POINTS_SYMPTOM = 5;
const POINTS_EVENING = 15;
const POINTS_FULL_DAY_BONUS = 20;     // awarded once both check-ins logged
const XP_PER_LEVEL = 100;
const ALLOWED_SYMPTOMS = new Set([
  // generic
  "pain", "fatigue", "bloating", "nausea", "cramps",
  "headache", "mood", "sleep", "other",
  // female-health / endo-aware
  "pelvic_pain", "back_pain", "breast_tender", "hot_flash",
  "painful_urination", "painful_bowel", "painful_sex",
  "spotting", "endo_belly", "dizziness",
]);
const ALLOWED_PHASES   = new Set(["menstrual", "follicular", "ovulation", "luteal"]);
const ALLOWED_FLOW     = new Set(["none", "spotting", "light", "medium", "heavy"]);
const ALLOWED_MUCUS    = new Set(["dry", "sticky", "creamy", "watery", "eggwhite"]);
const ALLOWED_MOVEMENT = new Set(["none", "light", "moderate", "vigorous"]);
const ALLOWED_BOWEL    = new Set(["constipated", "normal", "loose"]);
const ALLOWED_INTIMACY = new Set(["none", "comfortable", "uncomfortable"]);
const ALLOWED_TRIGGERS = new Set(["food","stress","exercise","intimacy","cold","hormones","travel","sleep","unknown"]);
const ALLOWED_RELIEF   = new Set(["heat","rest","medication","hydration","movement","massage","bath","sleep","none"]);

async function getOrCreateUser(env, username) {
  // Look up by username; create with deterministic id on first hit.
  let row = await env.DB
    .prepare("SELECT id, username, display_name, timezone FROM users WHERE username = ?")
    .bind(username).first();
  if (row) return row;

  const id = `user_${username}`;
  const display = username.charAt(0).toUpperCase() + username.slice(1);
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, username, display_name, timezone, created_at) VALUES (?, ?, ?, 'UTC', ?)"
    ).bind(id, username, display, now),
    env.DB.prepare(
      `INSERT INTO pets (user_id, pet_type, pet_name, level, xp, mood, streak_days, updated_at)
       VALUES (?, 'luna', 'Luna', 1, 0, 'happy', 0, ?)`
    ).bind(id, now),
  ]);
  return { id, username, display_name: display, timezone: "UTC" };
}

// --- /api/me/today ---------------------------------------------------------
async function getMeToday(request, env, user) {
  const url = new URL(request.url);
  const date = normaliseDate(url.searchParams.get("date"));

  const [daily, symptoms, pet, notifs] = await Promise.all([
    env.DB.prepare("SELECT * FROM daily_logs WHERE user_id = ? AND log_date = ?")
      .bind(user.id, date).first(),
    env.DB.prepare(
      "SELECT id, log_date, logged_at, symptom, severity, location, notes, points " +
      "FROM symptoms WHERE user_id = ? AND log_date = ? ORDER BY logged_at DESC"
    ).bind(user.id, date).all(),
    env.DB.prepare("SELECT * FROM pets WHERE user_id = ?").bind(user.id).first(),
    env.DB.prepare(
      "SELECT id, type, title, body, action_url, created_at, read_at " +
      "FROM notifications WHERE user_id = ? AND dismissed_at IS NULL " +
      "ORDER BY created_at DESC LIMIT 20"
    ).bind(user.id).all(),
  ]);

  return json({
    user: { displayName: user.display_name, username: user.username },
    date,
    morning: daily?.morning_logged_at ? {
      mood: daily.morning_mood,
      energy: daily.morning_energy,
      pain: daily.morning_pain,
      sleepHours: daily.morning_sleep_hours,
      sleepQuality: daily.morning_sleep_quality,
      notes: daily.morning_notes,
      loggedAt: daily.morning_logged_at,
    } : null,
    evening: daily?.evening_logged_at ? {
      overall: daily.evening_overall,
      reflection: daily.evening_reflection,
      gratitude: daily.evening_gratitude,
      waterGlasses: daily.water_glasses,
      movementLevel: daily.movement_level,
      bowelCount: daily.bowel_count,
      bowelType: daily.bowel_type,
      stressLevel: daily.stress_level,
      intimacy: daily.intimacy,
      medications: daily.medications,
      loggedAt: daily.evening_logged_at,
    } : null,
    cycle: daily ? {
      day: daily.cycle_day,
      phase: daily.cycle_phase,
      flow: daily.flow,
      bbt: daily.bbt,
      cervicalMucus: daily.cervical_mucus,
      breastTenderness: daily.breast_tenderness,
    } : null,
    symptoms: symptoms.results || [],
    pointsToday: daily?.points_total || 0,
    pet: petResponse(pet),
    notifications: notifs.results || [],
  });
}

// --- /api/me/checkin/morning ----------------------------------------------
async function postMorningCheckin(request, env, user) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  const mood = clampInt(body.mood, 1, 5);
  const energy = clampInt(body.energy, 1, 5);
  const pain = clampInt(body.pain, 1, 5);
  if (mood == null || energy == null || pain == null) {
    return json({ error: "mood, energy and pain are required (1–5)" }, 400);
  }

  const sleepHours = body.sleepHours == null || body.sleepHours === ""
    ? null : clampFloat(body.sleepHours, 0, 24);
  const sleepQuality = clampInt(body.sleepQuality, 1, 5);
  const notes = sanitizeText(body.notes, 1000);

  // Cycle + body-awareness fields (all optional)
  const cycleDay   = body.cycleDay == null || body.cycleDay === "" ? null : clampInt(body.cycleDay, 1, 60);
  const cyclePhase = oneOf(body.cyclePhase, ALLOWED_PHASES);
  const flow       = oneOf(body.flow, ALLOWED_FLOW);
  const bbt        = body.bbt == null || body.bbt === "" ? null : clampFloat(body.bbt, 35, 40);
  const mucus      = oneOf(body.cervicalMucus, ALLOWED_MUCUS);
  const breastTender = clampInt(body.breastTenderness, 0, 5);

  const date = normaliseDate(body.date);
  const now = nowSec();

  const existing = await env.DB
    .prepare("SELECT morning_logged_at, evening_logged_at FROM daily_logs WHERE user_id = ? AND log_date = ?")
    .bind(user.id, date).first();

  const firstTime = !existing?.morning_logged_at;
  let pointsAwarded = firstTime ? POINTS_MORNING : 0;
  let fullDayBonus = false;
  if (firstTime && existing?.evening_logged_at) {
    pointsAwarded += POINTS_FULL_DAY_BONUS;
    fullDayBonus = true;
  }

  await env.DB.prepare(
    `INSERT INTO daily_logs (
       user_id, log_date,
       morning_mood, morning_energy, morning_pain,
       morning_sleep_hours, morning_sleep_quality, morning_notes, morning_logged_at,
       cycle_day, cycle_phase, flow, bbt, cervical_mucus, breast_tenderness,
       points_total)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       morning_mood          = excluded.morning_mood,
       morning_energy        = excluded.morning_energy,
       morning_pain          = excluded.morning_pain,
       morning_sleep_hours   = excluded.morning_sleep_hours,
       morning_sleep_quality = excluded.morning_sleep_quality,
       morning_notes         = excluded.morning_notes,
       morning_logged_at     = COALESCE(daily_logs.morning_logged_at, excluded.morning_logged_at),
       cycle_day             = COALESCE(excluded.cycle_day,         daily_logs.cycle_day),
       cycle_phase           = COALESCE(excluded.cycle_phase,       daily_logs.cycle_phase),
       flow                  = COALESCE(excluded.flow,              daily_logs.flow),
       bbt                   = COALESCE(excluded.bbt,               daily_logs.bbt),
       cervical_mucus        = COALESCE(excluded.cervical_mucus,    daily_logs.cervical_mucus),
       breast_tenderness     = COALESCE(excluded.breast_tenderness, daily_logs.breast_tenderness),
       points_total          = daily_logs.points_total + ?16`
  ).bind(
    user.id, date,
    mood, energy, pain,
    sleepHours, sleepQuality, notes, now,
    cycleDay, cyclePhase, flow, bbt, mucus, breastTender,
    pointsAwarded
  ).run();

  const pet = await awardXp(env, user.id, pointsAwarded, date);
  return json({ ok: true, pointsAwarded, fullDayBonus, pet });
}

// --- /api/me/checkin/evening ----------------------------------------------
async function postEveningCheckin(request, env, user) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  const overall = clampInt(body.overall, 1, 5);
  if (overall == null) return json({ error: "overall is required (1–5)" }, 400);

  const reflection = sanitizeText(body.reflection, 2000);
  const gratitude  = sanitizeText(body.gratitude, 500);

  // Body-care
  const water     = body.waterGlasses == null ? null : clampInt(body.waterGlasses, 0, 30);
  const movement  = oneOf(body.movementLevel, ALLOWED_MOVEMENT);
  const bowelCnt  = body.bowelCount == null ? null : clampInt(body.bowelCount, 0, 15);
  const bowelTyp  = oneOf(body.bowelType, ALLOWED_BOWEL);
  const stress    = clampInt(body.stressLevel, 1, 5);
  const intimacy  = oneOf(body.intimacy, ALLOWED_INTIMACY);
  const meds      = sanitizeText(body.medications, 500);

  const date = normaliseDate(body.date);
  const now = nowSec();

  const existing = await env.DB
    .prepare("SELECT morning_logged_at, evening_logged_at FROM daily_logs WHERE user_id = ? AND log_date = ?")
    .bind(user.id, date).first();

  const firstTime = !existing?.evening_logged_at;
  let pointsAwarded = firstTime ? POINTS_EVENING : 0;
  let fullDayBonus = false;
  if (firstTime && existing?.morning_logged_at) {
    pointsAwarded += POINTS_FULL_DAY_BONUS;
    fullDayBonus = true;
  }

  await env.DB.prepare(
    `INSERT INTO daily_logs (
       user_id, log_date,
       evening_overall, evening_reflection, evening_gratitude, evening_logged_at,
       water_glasses, movement_level, bowel_count, bowel_type, stress_level, intimacy, medications,
       points_total)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       evening_overall    = excluded.evening_overall,
       evening_reflection = excluded.evening_reflection,
       evening_gratitude  = excluded.evening_gratitude,
       evening_logged_at  = COALESCE(daily_logs.evening_logged_at, excluded.evening_logged_at),
       water_glasses      = COALESCE(excluded.water_glasses,  daily_logs.water_glasses),
       movement_level     = COALESCE(excluded.movement_level, daily_logs.movement_level),
       bowel_count        = COALESCE(excluded.bowel_count,    daily_logs.bowel_count),
       bowel_type         = COALESCE(excluded.bowel_type,     daily_logs.bowel_type),
       stress_level       = COALESCE(excluded.stress_level,   daily_logs.stress_level),
       intimacy           = COALESCE(excluded.intimacy,       daily_logs.intimacy),
       medications        = COALESCE(excluded.medications,    daily_logs.medications),
       points_total       = daily_logs.points_total + ?14`
  ).bind(
    user.id, date,
    overall, reflection, gratitude, now,
    water, movement, bowelCnt, bowelTyp, stress, intimacy, meds,
    pointsAwarded
  ).run();

  const pet = await awardXp(env, user.id, pointsAwarded, date);
  return json({ ok: true, pointsAwarded, fullDayBonus, pet });
}

// --- /api/me/symptoms (POST) ----------------------------------------------
async function postSymptom(request, env, user) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  const symptom = typeof body.symptom === "string" ? body.symptom.toLowerCase().trim() : "";
  if (!ALLOWED_SYMPTOMS.has(symptom)) return json({ error: "Unknown symptom" }, 400);
  const severity = clampInt(body.severity, 1, 5);
  if (severity == null) return json({ error: "severity is required (1–5)" }, 400);
  const location = sanitizeText(body.location, 60);
  const notes    = sanitizeText(body.notes, 500);
  const triggers = tagList(body.triggers, ALLOWED_TRIGGERS);
  const relief   = tagList(body.relief, ALLOWED_RELIEF);
  const date = normaliseDate(body.date);
  const now = nowSec();
  const points = POINTS_SYMPTOM;

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO symptoms (user_id, log_date, logged_at, symptom, severity, location, notes, triggers, relief, points) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(user.id, date, now, symptom, severity, location, notes, triggers, relief, points),
    env.DB.prepare(
      `INSERT INTO daily_logs (user_id, log_date, points_total)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, log_date) DO UPDATE SET points_total = daily_logs.points_total + ?`
    ).bind(user.id, date, points, points),
  ]);

  const pet = await awardXp(env, user.id, points, date);
  return json({ ok: true, pointsAwarded: points, pet });
}

// --- /api/me/symptoms (GET) -----------------------------------------------
async function getSymptoms(request, env, user) {
  const url = new URL(request.url);
  const from = normaliseDate(url.searchParams.get("from"));
  const to = normaliseDate(url.searchParams.get("to") || url.searchParams.get("from"));
  const res = await env.DB
    .prepare(
      "SELECT id, log_date, logged_at, symptom, severity, location, notes " +
      "FROM symptoms WHERE user_id = ? AND log_date BETWEEN ? AND ? " +
      "ORDER BY logged_at DESC LIMIT 200"
    )
    .bind(user.id, from, to).all();
  return json({ symptoms: res.results || [] });
}

// --- Notifications --------------------------------------------------------
async function getNotifications(env, user) {
  const res = await env.DB
    .prepare(
      "SELECT id, type, title, body, action_url, created_at, read_at " +
      "FROM notifications WHERE user_id = ? AND dismissed_at IS NULL " +
      "ORDER BY created_at DESC LIMIT 50"
    )
    .bind(user.id).all();
  return json({ notifications: res.results || [] });
}

async function dismissNotification(env, user, id) {
  await env.DB.prepare(
    "UPDATE notifications SET dismissed_at = ? WHERE id = ? AND user_id = ?"
  ).bind(nowSec(), id, user.id).run();
  return json({ ok: true });
}

// --- Gamification ---------------------------------------------------------
async function awardXp(env, userId, points, logDate) {
  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?").bind(userId).first();
  if (!pet) return null;
  if (points <= 0) return petResponse(pet);

  // Streak: bump only on first log of a new day; reset if a day was skipped.
  let streak = pet.streak_days;
  if (pet.last_log_date !== logDate) {
    const prev = new Date(`${logDate}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const prevDate = prev.toISOString().slice(0, 10);
    streak = pet.last_log_date === prevDate ? streak + 1 : 1;
  }

  let xp = pet.xp + points;
  let level = pet.level;
  let leveledUp = false;
  while (xp >= level * XP_PER_LEVEL) {
    xp -= level * XP_PER_LEVEL;
    level += 1;
    leveledUp = true;
  }

  const mood = "happy";   // anything logged today keeps them happy
  await env.DB.prepare(
    "UPDATE pets SET xp = ?, level = ?, mood = ?, streak_days = ?, last_log_date = ?, updated_at = ? WHERE user_id = ?"
  ).bind(xp, level, mood, streak, logDate, nowSec(), userId).run();

  return { ...petResponse({ ...pet, xp, level, mood, streak_days: streak }), leveledUp };
}

function petResponse(pet) {
  if (!pet) return null;
  return {
    name: pet.pet_name,
    type: pet.pet_type,
    level: pet.level,
    xp: pet.xp,
    xpForNext: pet.level * XP_PER_LEVEL,
    mood: pet.mood,
    streakDays: pet.streak_days,
  };
}

// --- small validators ----------------------------------------------------
async function readJsonSafe(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  try { return await request.json(); } catch { return null; }
}
function clampInt(v, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}
function clampFloat(v, min, max) {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}
function oneOf(v, allowed) {
  if (typeof v !== "string") return null;
  const lc = v.toLowerCase().trim();
  return allowed.has(lc) ? lc : null;
}
function tagList(v, allowed) {
  if (!Array.isArray(v)) return null;
  const tags = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const lc = item.toLowerCase().trim();
    if (allowed.has(lc) && !tags.includes(lc)) tags.push(lc);
    if (tags.length >= 10) break;
  }
  return tags.length ? tags.join(",") : null;
}
function sanitizeText(v, maxLen) {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}
function normaliseDate(s) {
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Reject anything more than ±2 days from now to stop date-spoofing.
    const sent = Date.parse(`${s}T00:00:00Z`);
    const now = Date.now();
    if (Math.abs(sent - now) <= 2 * 86400 * 1000) return s;
  }
  return new Date().toISOString().slice(0, 10);
}
