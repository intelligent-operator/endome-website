// EndoMe Worker
// - Serves /api/* (Stripe Checkout, Mandrill, auth)
// - Protects /dashboard* with a signed-cookie session
// - Wraps every HTML response with strict security headers
// Static files come from the [assets] binding under /public.

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const SESSION_COOKIE = "endome_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30;       // 30 days
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
        if (url.pathname === "/api/login/code" && request.method === "POST") {
          return await handleLoginCode(request, env);
        }
        if (url.pathname === "/api/login/verify" && request.method === "POST") {
          return await handleLoginVerify(request, env);
        }
        if (url.pathname === "/api/register" && request.method === "POST") {
          return await handleRegister(request, env);
        }
        if (url.pathname === "/api/logout") {
          return await handleLogout(request, env);
        }

        // --- Authenticated user-data endpoints ----------------------------
        if (url.pathname.startsWith("/api/me/")) {
          const session = await readSession(request, env);
          if (!session) return json({ error: "Unauthorized" }, 401);
          if (!env.DB) return json({ error: "Storage not configured" }, 503);
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
          if (url.pathname === "/api/me/pet" && request.method === "PUT") {
            return jsonHeaders(await putPet(request, env, user));
          }
          if (url.pathname === "/api/me/story" && request.method === "GET") {
            return jsonHeaders(await getStory(env, user));
          }
          if (url.pathname === "/api/me/story/check" && request.method === "POST") {
            return jsonHeaders(await checkStory(request, env, user));
          }
          if (url.pathname === "/api/me/story/uncheck" && request.method === "POST") {
            return jsonHeaders(await uncheckStory(request, env, user));
          }
          if (url.pathname === "/api/me/order/dna" && request.method === "POST") {
            return jsonHeaders(await postDnaOrder(request, env, user));
          }
          if (url.pathname === "/api/me/results/dna" && request.method === "POST") {
            return jsonHeaders(await postDnaResults(request, env, user));
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
    if (
      url.pathname === "/dashboard"   || url.pathname.startsWith("/dashboard/") ||
      url.pathname === "/onboarding"  || url.pathname.startsWith("/onboarding/") ||
      url.pathname === "/story"       || url.pathname.startsWith("/story/")
    ) {
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
  const usernameRaw = typeof body?.username === "string" ? body.username : "";
  const password = typeof body?.password === "string" ? body.password : "";

  // Strict input validation. Reject anything weird before touching secrets.
  if (
    usernameRaw.length === 0 ||
    usernameRaw.length > MAX_USERNAME_LEN ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LEN ||
    /[\x00-\x1f\x7f]/.test(usernameRaw)
  ) {
    await sleep(LOGIN_FAIL_DELAY_MS);
    return json({ error: "Invalid credentials" }, 401);
  }

  const sessionSecret = env.SESSION_SECRET || "";
  if (!sessionSecret) {
    console.error("auth: missing SESSION_SECRET");
    return json({ error: "Authentication not configured" }, 503);
  }

  const username = usernameRaw.toLowerCase();

  // 1. Registered user lookup (D1). Matches against username OR email.
  //    Password right → mail a 6-digit code, return a challenge token, no
  //    session is minted until the code is verified in /api/login/verify.
  if (env.DB) {
    const row = await env.DB.prepare(
      "SELECT id, username, email, password_hash, password_salt FROM users " +
      "WHERE username = ? OR email = ? LIMIT 1"
    ).bind(username, username).first();
    if (row?.password_hash && row?.password_salt) {
      const ok = await verifyPassword(password, row.password_hash, row.password_salt);
      if (!ok) {
        await sleep(LOGIN_FAIL_DELAY_MS);
        return json({ error: "Invalid credentials" }, 401);
      }
      try {
        const challenge = await issueOtpChallenge(env, row.id, row.email || row.username);
        return json({ ok: true, needsOtp: true, challenge, sentTo: maskEmail(row.email || row.username) });
      } catch (err) {
        const status = err?.code === "rate_limited" ? 429 : 500;
        return json({ error: err.message || "Could not send code." }, status);
      }
    }
  }

  // 2. Fallback: hardcoded env-var account (the "endome" admin login).
  //    No OTP — env auth is the recovery backdoor.
  const cfgUser = (env.AUTH_USERNAME || "").toLowerCase();
  const cfgPass = env.AUTH_PASSWORD || "";
  if (cfgUser && cfgPass) {
    const userOk = timingSafeEqual(username, cfgUser);
    const passOk = timingSafeEqual(password, cfgPass);
    if (userOk && passOk) return mintSessionResponse(cfgUser, request, env);
  }

  await sleep(LOGIN_FAIL_DELAY_MS);
  return json({ error: "Invalid credentials" }, 401);
}

// --- Passwordless: email-only "magic code" login --------------------------
async function handleLoginCode(request, env) {
  if (!env.DB) return json({ error: "Storage not configured" }, 503);
  if (!env.SESSION_SECRET) return json({ error: "Authentication not configured" }, 503);

  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return json({ error: "Invalid request" }, 400);

  let body;
  try { body = await request.json(); } catch { body = null; }
  const email = typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";
  if (!isEmail(email) || email.length > 200 || /[\x00-\x1f\x7f]/.test(email)) {
    await sleep(LOGIN_FAIL_DELAY_MS);
    return json({ error: "Please enter a valid email." }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT id, email FROM users WHERE email = ? OR username = ? LIMIT 1"
  ).bind(email, email).first();

  // Anti-enumeration: always return the same shape regardless of existence.
  // We only actually mail + persist if the user is real.
  if (row?.email) {
    try {
      const challenge = await issueOtpChallenge(env, row.id, row.email);
      return json({ ok: true, needsOtp: true, challenge, sentTo: maskEmail(row.email) });
    } catch (err) {
      const status = err?.code === "rate_limited" ? 429 : 500;
      return json({ error: err.message || "Could not send code." }, status);
    }
  }

  await sleep(LOGIN_FAIL_DELAY_MS);
  // Bogus challenge that will fail at verify — keeps response shape uniform.
  const fakeChallenge = b64url(crypto.getRandomValues(new Uint8Array(24)));
  return json({ ok: true, needsOtp: true, challenge: fakeChallenge, sentTo: maskEmail(email) });
}

// --- Verify the 6-digit code, mint a real session -------------------------
async function handleLoginVerify(request, env) {
  if (!env.DB) return json({ error: "Storage not configured" }, 503);
  if (!env.SESSION_SECRET) return json({ error: "Authentication not configured" }, 503);

  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return json({ error: "Invalid request" }, 400);

  let body;
  try { body = await request.json(); } catch { body = null; }
  const challenge = typeof body?.challenge === "string" ? body.challenge : "";
  const code = typeof body?.code === "string" ? body.code.replace(/\s/g, "") : "";

  if (!challenge || challenge.length > 64 || !/^\d{6}$/.test(code)) {
    await sleep(LOGIN_FAIL_DELAY_MS);
    return json({ error: "Enter the 6-digit code from your email." }, 400);
  }

  const row = await env.DB.prepare(
    "SELECT challenge, user_id, code_hash, expires_at, attempts, used_at FROM login_otp WHERE challenge = ?"
  ).bind(challenge).first();

  if (!row) {
    await sleep(LOGIN_FAIL_DELAY_MS);
    return json({ error: "Invalid or expired code. Request a new one." }, 401);
  }
  if (row.used_at) {
    return json({ error: "This code has already been used." }, 401);
  }
  if (row.expires_at < nowSec()) {
    return json({ error: "Code has expired. Request a new one." }, 401);
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return json({ error: "Too many attempts. Request a new code." }, 429);
  }

  const submittedHash = await hmacB64Url(env.SESSION_SECRET, code);
  if (!timingSafeEqual(submittedHash, row.code_hash)) {
    await env.DB.prepare(
      "UPDATE login_otp SET attempts = attempts + 1 WHERE challenge = ?"
    ).bind(challenge).run();
    await sleep(LOGIN_FAIL_DELAY_MS);
    return json({ error: "Invalid code." }, 401);
  }

  // Consume — one-shot.
  await env.DB.prepare(
    "UPDATE login_otp SET used_at = ? WHERE challenge = ?"
  ).bind(nowSec(), challenge).run();

  const user = await env.DB.prepare(
    "SELECT username FROM users WHERE id = ?"
  ).bind(row.user_id).first();
  if (!user) return json({ error: "Account not found." }, 401);

  return mintSessionResponse(user.username, request, env);
}

// --- Registration ---------------------------------------------------------
async function handleRegister(request, env) {
  if (!env.DB) return json({ error: "Storage not configured" }, 503);
  if (!env.SESSION_SECRET) return json({ error: "Authentication not configured" }, 503);

  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return json({ error: "Invalid request" }, 400);

  let body;
  try { body = await request.json(); } catch { body = null; }
  const email = typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const displayName = sanitizeText(body?.displayName, 60);

  // Validation
  if (!isEmail(email) || email.length > 200) {
    return json({ error: "Please enter a valid email address." }, 400);
  }
  if (/[\x00-\x1f\x7f]/.test(email)) {
    return json({ error: "Invalid email." }, 400);
  }
  if (password.length < 10) {
    return json({ error: "Password must be at least 10 characters." }, 400);
  }
  if (password.length > MAX_PASSWORD_LEN) {
    return json({ error: "Password too long." }, 400);
  }
  if (!displayName) {
    return json({ error: "Please enter a display name." }, 400);
  }

  // Quietly slow down duplicate-email probing without leaking existence on
  // happy path.
  const existing = await env.DB.prepare(
    "SELECT 1 FROM users WHERE username = ? OR email = ? LIMIT 1"
  ).bind(email, email).first();
  if (existing) {
    await sleep(LOGIN_FAIL_DELAY_MS);
    return json({ error: "An account with that email already exists." }, 409);
  }

  const { hash, salt } = await hashPassword(password);
  const id = `u_${b64url(crypto.getRandomValues(new Uint8Array(8)))}`;
  const now = nowSec();

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, username, email, display_name, password_hash, password_salt, timezone, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?)"
      ).bind(id, email, email, displayName, hash, salt, now),
      env.DB.prepare(
        "INSERT INTO pets (user_id, pet_type, pet_name, level, xp, mood, streak_days, updated_at) " +
        "VALUES (?, 'luna', 'Luna', 1, 0, 'happy', 0, ?)"
      ).bind(id, now),
    ]);
  } catch (err) {
    console.error("register failed:", err);
    return json({ error: "Could not create account. Try again." }, 500);
  }

  // Fire-and-forget welcome email. Failure here doesn't break signup —
  // the user is already authenticated.
  await sendWelcomeEmail(env, email, displayName);

  return mintSessionResponse(email, request, env, 201, "/onboarding");
}

// Shared: signs a session, sets the cookie, returns the JSON redirect response.
async function mintSessionResponse(username, request, env, status = 200, redirect = "/dashboard") {
  const token = await signSession(
    { u: username, iat: nowSec(), exp: nowSec() + SESSION_TTL_SEC },
    env.SESSION_SECRET
  );
  const headers = new Headers(JSON_HEADERS);
  headers.append("Set-Cookie", buildCookie(SESSION_COOKIE, token, request, SESSION_TTL_SEC));
  return new Response(JSON.stringify({ ok: true, redirect }), { status, headers });
}

// --- Password hashing (PBKDF2-SHA256, per-user salt) ---------------------
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

async function hashPassword(password, existingSaltB64) {
  let saltBytes;
  if (existingSaltB64) {
    saltBytes = b64urlDecode(existingSaltB64);
  } else {
    saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password),
    { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key, HASH_BYTES * 8
  );
  return { hash: b64url(new Uint8Array(bits)), salt: b64url(saltBytes) };
}

async function verifyPassword(password, storedHashB64, storedSaltB64) {
  try {
    const { hash } = await hashPassword(password, storedSaltB64);
    return timingSafeEqual(hash, storedHashB64);
  } catch {
    return false;
  }
}

// --- Login OTP (email code) ----------------------------------------------
const OTP_TTL_SEC = 10 * 60;          // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_WINDOW_SEC = 60 * 60;  // 1 hour
const OTP_MAX_PER_WINDOW = 5;

async function issueOtpChallenge(env, userId, email) {
  // Per-user rate limit so an attacker can't spam someone's inbox via the
  // login endpoint.
  const since = nowSec() - OTP_RATE_WINDOW_SEC;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM login_otp WHERE user_id = ? AND created_at > ?"
  ).bind(userId, since).first();
  if ((count?.c || 0) >= OTP_MAX_PER_WINDOW) {
    const err = new Error("Too many codes requested. Try again in a little while.");
    err.code = "rate_limited";
    throw err;
  }

  // 6-digit code from CSPRNG; padded to 6 chars.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const code = String(buf[0] % 1_000_000).padStart(6, "0");

  // We hash with SESSION_SECRET so a DB read alone can't recover live codes.
  const codeHash = await hmacB64Url(env.SESSION_SECRET, code);
  const challenge = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const now = nowSec();

  await env.DB.prepare(
    "INSERT INTO login_otp (challenge, user_id, code_hash, expires_at, created_at) " +
    "VALUES (?, ?, ?, ?, ?)"
  ).bind(challenge, userId, codeHash, now + OTP_TTL_SEC, now).run();

  await sendOtpEmail(env, email, code);
  return challenge;
}

const FROM_EMAIL_DEFAULT = "contact@endome.com";

async function sendOtpEmail(env, email, code) {
  if (!env.MANDRILL_API_KEY) {
    console.error("OTP: MANDRILL_API_KEY missing — code would have been:", code);
    throw new Error("Email delivery is not configured. Contact support.");
  }
  const html = renderEmail({
    siteUrl: env.SITE_URL || "https://endome.com",
    preheader: `Your EndoMe sign-in code is ${code}. Expires in 10 minutes.`,
    headline: "Your sign-in code",
    body: `
      <p style="margin:0 0 18px;font-size:15px;color:#3a2330;line-height:1.6">
        Use this code to finish signing in to your EndoMe account.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px"><tr>
        <td align="center">
          <div style="display:inline-block;background-color:#fff5f8;border:2px dashed #ffaecb;border-radius:16px;padding:18px 30px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:34px;font-weight:700;color:#ff4e8a;letter-spacing:10px">
            ${code}
          </div>
        </td>
      </tr></table>
      <p style="margin:0 0 8px;font-size:14px;color:#5a3a48;line-height:1.6">
        It expires in <strong>10 minutes</strong>.
      </p>
      <p style="margin:0;font-size:13px;color:#7a5f6c;line-height:1.6">
        Didn't try to sign in? You can safely ignore this email — your account stays locked.
      </p>`,
  });
  const text =
    `Your EndoMe sign-in code: ${code}\n\n` +
    `It expires in 10 minutes.\n\n` +
    `If you didn't try to sign in, you can ignore this email — your account stays locked.`;

  await mandrillSend(env, {
    to: [{ email, type: "to" }],
    subject: `Your EndoMe sign-in code: ${code}`,
    from_email: env.NEWSLETTER_FROM_EMAIL || FROM_EMAIL_DEFAULT,
    from_name: env.NEWSLETTER_FROM_NAME || "EndoMe",
    headers: { "Reply-To": env.NOTIFY_EMAIL || FROM_EMAIL_DEFAULT },
    html, text,
  });
}

async function sendWelcomeEmail(env, email, displayName) {
  if (!env.MANDRILL_API_KEY) {
    console.warn("welcome email skipped — MANDRILL_API_KEY missing");
    return;
  }
  const siteUrl = env.SITE_URL || "https://endome.com";
  const safeName = (displayName || "").replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  })[c]);

  // Reusable two-column row with a soft-pink emoji disk + body text.
  const featureRow = (emoji, text) => `
    <tr>
      <td valign="top" width="56" style="padding:6px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center" bgcolor="#ffeaf2" width="40" height="40" style="background-color:#ffeaf2;width:40px;height:40px;border-radius:20px;font-size:20px;line-height:40px;vertical-align:middle">${emoji}</td></tr>
        </table>
      </td>
      <td valign="middle" style="padding:6px 0 6px 14px;color:#3a2330;font-size:15px;line-height:1.55">${text}</td>
    </tr>`;

  const html = renderEmail({
    siteUrl,
    preheader: `Hi ${safeName}, you've just taken a brave first step — we're walking it with you.`,
    headline: `Welcome, ${safeName} 🌸`,
    body: `
      <p style="margin:0 0 16px;color:#3a2330;font-size:16px;line-height:1.65">
        You've just taken a brave first step. We're so glad you're here.
      </p>
      <p style="margin:0 0 18px;color:#3a2330;font-size:16px;line-height:1.65">
        EndoMe isn't just an app — it's your <strong style="color:#ff4e8a">personal companion</strong> through every part of your endometriosis journey. Whether you're learning to listen to your body, preparing for a doctor's visit, or just looking for someone who gets it — we're here. Always.
      </p>

      <!-- Pink callout / quote box -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0">
        <tr><td bgcolor="#fff0f5" style="background-color:#fff0f5;border-left:4px solid #ff4e8a;padding:18px 22px;border-radius:0 12px 12px 0">
          <p style="margin:0;color:#3a2330;font-size:16px;font-style:italic;line-height:1.55">
            "This is your story. We'll walk it with you, one day at a time."
          </p>
        </td></tr>
      </table>

      <p style="margin:0 0 16px;color:#3a2330;font-size:16px;line-height:1.65">
        Your EndoPet <strong style="color:#ff4e8a">Luna</strong> is here too. Every time you check in, Luna grows alongside you — a gentle reminder that progress, however small, is still progress.
      </p>

      <p style="margin:24px 0 14px;color:#3a2330;font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">What's waiting for you</p>

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0">
        ${featureRow("🌅", `<strong>Morning check-ins</strong> for the days you need to listen to your body — and the days you don't.`)}
        ${featureRow("📝", `<strong>Quick-log symptoms</strong> when they happen. We'll spot the patterns over time so you don't have to.`)}
        ${featureRow("🌙", `<strong>Evening reflections</strong> on your terms. A short moment, that's it.`)}
        ${featureRow("🐾", `<strong>Watch Luna grow</strong> with every entry — because every step counts.`)}
      </table>

      <p style="margin:28px 0 0;color:#7a5f6c;font-size:14px;line-height:1.7;text-align:center">
        Track what feels right. Skip what doesn't. We're here when you need us.
      </p>`,
    ctaText: "Open your dashboard",
    ctaUrl: `${siteUrl}/dashboard`,
  });

  const text =
    `Welcome, ${displayName} 🌸\n\n` +
    `You've just taken a brave first step. We're so glad you're here.\n\n` +
    `EndoMe is your personal companion through every part of your endometriosis journey — ` +
    `learning to listen to your body, preparing for a doctor's visit, or just looking for someone who gets it.\n\n` +
    `"This is your story. We'll walk it with you, one day at a time."\n\n` +
    `Your EndoPet Luna is here too. Every check-in helps Luna grow alongside you.\n\n` +
    `What's waiting for you:\n` +
    ` • Morning check-ins for the days you need to listen to your body\n` +
    ` • Quick-log symptoms when they happen\n` +
    ` • Evening reflections on your terms\n` +
    ` • Watch Luna grow with every entry\n\n` +
    `Open your dashboard: ${siteUrl}/dashboard\n\n` +
    `Track what feels right. Skip what doesn't. We're here when you need us.\n`;

  try {
    await mandrillSend(env, {
      to: [{ email, type: "to", name: displayName }],
      subject: `Welcome to EndoMe, ${displayName} 🌸`,
      from_email: env.NEWSLETTER_FROM_EMAIL || FROM_EMAIL_DEFAULT,
      from_name: env.NEWSLETTER_FROM_NAME || "EndoMe",
      headers: { "Reply-To": env.NOTIFY_EMAIL || FROM_EMAIL_DEFAULT },
      html, text,
    });
  } catch (err) {
    console.error("welcome email failed:", err?.message || err);
  }
}

// Shared branded email layout. Bulletproof inline styles, table-based,
// bgcolor attrs alongside style for max client compat (Outlook needs both).
function renderEmail({ siteUrl, preheader, headline, body, ctaText, ctaUrl }) {
  const logoUrl = `${siteUrl}/logo-final.png`;
  const ff = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>EndoMe</title>
</head>
<body style="margin:0;padding:0;background-color:#fff5f8;font-family:${ff};color:#3a2330;-webkit-font-smoothing:antialiased">
<div style="display:none;font-size:1px;color:#fff5f8;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${preheader || ""}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#fff5f8" style="background-color:#fff5f8;padding:40px 16px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" bgcolor="#ffffff" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:20px;overflow:hidden">
      <!-- Gradient header (solid bg fallback for Outlook) -->
      <tr>
        <td bgcolor="#ff4e8a" align="center" style="background-color:#ff4e8a;background-image:linear-gradient(135deg,#ffb380 0%,#ff6a92 50%,#e8348a 100%);padding:36px 32px">
          <img src="${logoUrl}" alt="EndoMe" width="64" height="64" style="display:block;margin:0 auto;border:0;border-radius:16px"/>
        </td>
      </tr>
      <!-- Body -->
      <tr>
        <td style="padding:36px 36px 28px;color:#3a2330;font-family:${ff}">
          <h1 style="margin:0 0 18px;color:#3a2330;font-size:24px;font-weight:700;line-height:1.3;text-align:left">${headline}</h1>
          ${body}
          ${ctaText && ctaUrl ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:28px auto 6px">
              <tr><td align="center" bgcolor="#ff4e8a" style="background-color:#ff4e8a;border-radius:999px">
                <a href="${ctaUrl}" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;font-family:${ff}">${ctaText} &rarr;</a>
              </td></tr>
            </table>` : ""}
        </td>
      </tr>
      <!-- Footer -->
      <tr>
        <td bgcolor="#fff5f8" align="center" style="background-color:#fff5f8;padding:24px 36px;border-top:1px solid #ffeaf2;font-family:${ff}">
          <p style="margin:0 0 6px;color:#7a5f6c;font-size:13px;font-weight:600">EndoMe</p>
          <p style="margin:0;color:#a08596;font-size:12px;line-height:1.5">
            Your story starts here · <a href="${siteUrl}" style="color:#ff4e8a;text-decoration:none">endome.com</a>
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

async function hmacB64Url(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return b64url(new Uint8Array(sig));
}

function maskEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) return email || "";
  const [local, domain] = email.split("@");
  const visible = local.length <= 2 ? local : local[0] + "•".repeat(Math.min(local.length - 2, 4)) + local.slice(-1);
  return `${visible}@${domain}`;
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
const ALLOWED_PET_TYPES = new Set(["luna", "poppy", "mochi", "sunny", "coco", "kiki"]);
const DEFAULT_PET_NAME = {
  luna: "Luna", poppy: "Poppy", mochi: "Mochi",
  sunny: "Sunny", coco: "Coco", kiki: "Kiki",
};

async function putPet(request, env, user) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const type = oneOf(body.type, ALLOWED_PET_TYPES);
  if (!type) return json({ error: "Unknown pet" }, 400);
  let name = sanitizeText(body.name, 30) || DEFAULT_PET_NAME[type];
  // Strip any control chars and cap silly lengths.
  name = name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 30) || DEFAULT_PET_NAME[type];

  await env.DB.prepare(
    "UPDATE pets SET pet_type = ?, pet_name = ?, updated_at = ? WHERE user_id = ?"
  ).bind(type, name, nowSec(), user.id).run();

  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?")
    .bind(user.id).first();
  return json({ ok: true, pet: petResponse(pet) });
}

// =============================================================================
// YOUR STORY — milestone checklist tied to real product actions.
// Steps have one of three types:
//   action  — has a CTA button on the right; can only be marked via the API
//             endpoint listed in actionEndpoint (the user can't tick it off).
//   auto    — completed by app activity (e.g. logging N days); rendered with
//             a small progress hint and no checkbox.
//   manual  — the user ticks it off themselves with a real checkbox.
// A step can also list `requires: <other_step_id>` — until that step is
// completed the step renders locked.
// =============================================================================
const STORY_STEPS = [
  // Phase 1 — Get insights from your body
  { id: "order_dna", phase: "Get insights", phaseDesc: "Real data about what's happening inside.",
    title: "Request your EndoMe DNA test",
    desc: "Order the at-home DNA kit that maps the markers most linked to endometriosis.",
    icon: "🧬", type: "action",
    actionLabel: "Request EndoMe DNA test", actionEndpoint: "/api/me/order/dna" },

  { id: "dna_results", phase: "Get insights",
    title: "Upload your DNA results",
    desc: "Send back your sample, then upload your results here when they arrive (2–3 weeks).",
    icon: "📊", type: "action", requires: "order_dna",
    actionLabel: "Upload results", actionEndpoint: "/api/me/results/dna" },

  { id: "log_14_days", phase: "Get insights",
    title: "Log symptoms for 14 days",
    desc: "Two weeks of consistent tracking is enough to start seeing patterns in your story.",
    icon: "📈", type: "auto", autoLabel: "Tracks automatically" },

  // Phase 2 — Talk to your doctor
  { id: "prepare_gp", phase: "Talk to your doctor", phaseDesc: "Bring the receipts. The right preparation changes how this conversation goes.",
    title: "Prepare for your GP visit",
    desc: "Pull together your symptom history, your DNA results, and a list of questions.",
    icon: "📝", type: "manual" },

  { id: "talk_gp", phase: "Talk to your doctor",
    title: "Talk to your GP about endometriosis",
    desc: "Share what you've tracked. Be specific: pain, cycle, what you've already tried.",
    icon: "👩‍⚕️", type: "manual" },

  { id: "referral", phase: "Talk to your doctor",
    title: "Get a specialist referral",
    desc: "Ask for a gynaecologist who specifically works with endometriosis patients.",
    icon: "📋", type: "manual" },

  // Phase 3 — Diagnosis
  { id: "specialist", phase: "Diagnosis", phaseDesc: "The path to answers — gather everything, then bring it together.",
    title: "See an endo specialist",
    desc: "Bring your records, your DNA results, and the questions you prepared.",
    icon: "🏥", type: "manual" },

  { id: "imaging", phase: "Diagnosis",
    title: "Get pelvic imaging",
    desc: "Pelvic ultrasound or MRI as recommended by your specialist.",
    icon: "🔬", type: "manual" },

  { id: "diagnosis", phase: "Diagnosis",
    title: "Receive your diagnosis",
    desc: "Formal diagnosis (or ruling out) from your specialist. Whatever it says, you're not alone.",
    icon: "📜", type: "manual" },

  // Phase 4 — Live well
  { id: "treatment", phase: "Live well", phaseDesc: "Beyond diagnosis. This is the day-to-day work that adds up.",
    title: "Agree a treatment plan",
    desc: "Lifestyle, hormonal options, pain management, surgery — discuss the right mix with your specialist.",
    icon: "💊", type: "manual" },

  { id: "habits", phase: "Live well",
    title: "Build daily habits that help",
    desc: "Sleep, gentle movement, anti-inflammatory eating, stress care. Small things, repeated.",
    icon: "🌿", type: "manual" },

  { id: "community", phase: "Live well",
    title: "Connect with the EndoMe community",
    desc: "Share your story with others who get it — when you're ready.",
    icon: "💖", type: "manual" },
];
const STORY_STEP_IDS = new Set(STORY_STEPS.map((s) => s.id));
const STORY_ACTION_TYPES = new Set(["action"]);

async function getStory(env, user) {
  // Tolerant of a missing story_progress table.
  let rows = { results: [] };
  try {
    rows = await env.DB.prepare(
      "SELECT step_id, completed_at, completed_by FROM story_progress WHERE user_id = ?"
    ).bind(user.id).all();
  } catch (err) {
    console.warn("story_progress query failed (table missing?):", err?.message || err);
  }

  // Apply on-the-fly auto-completion for "log_14_days" without needing a cron.
  // Also re-asserts the dna_* steps based on the users table, so even if the
  // story_progress row got nuked the state remains consistent.
  await reconcileAutoSteps(env, user);
  // Re-fetch after the reconcile (cheap, single user).
  try {
    rows = await env.DB.prepare(
      "SELECT step_id, completed_at, completed_by FROM story_progress WHERE user_id = ?"
    ).bind(user.id).all();
  } catch {}

  const done = new Map();
  for (const r of rows.results || []) done.set(r.step_id, r);

  const steps = STORY_STEPS.map((s) => {
    const d = done.get(s.id);
    const locked = !!(s.requires && !done.has(s.requires));
    return {
      ...s,
      completed:   !!d,
      completedAt: d?.completed_at || null,
      completedBy: d?.completed_by || null,
      locked,
    };
  });

  const completed = steps.filter((s) => s.completed).length;
  return json({
    steps,
    completed,
    total: STORY_STEPS.length,
    percent: Math.round((completed / STORY_STEPS.length) * 100),
  });
}

// Reasserts auto-completable steps based on the users + logs tables.
// Cheap enough to run on each /api/me/story call for a single user.
async function reconcileAutoSteps(env, user) {
  // log_14_days: count distinct YYYY-MM-DD where the user logged anything.
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS days FROM (
         SELECT log_date FROM symptoms WHERE user_id = ?
         UNION
         SELECT log_date FROM daily_logs
           WHERE user_id = ?
             AND (morning_logged_at IS NOT NULL OR evening_logged_at IS NOT NULL)
       )`
    ).bind(user.id, user.id).first();
    if ((row?.days || 0) >= 14) {
      await markStoryStep(env, user.id, "log_14_days", "auto");
    }
  } catch (err) {
    console.warn("reconcile log_14_days failed:", err?.message || err);
  }

  // dna_ordered_at / dna_results_at: drive order_dna + dna_results steps.
  try {
    const u = await env.DB.prepare(
      "SELECT dna_ordered_at, dna_results_at FROM users WHERE id = ?"
    ).bind(user.id).first();
    if (u?.dna_ordered_at) await markStoryStep(env, user.id, "order_dna", "auto");
    if (u?.dna_results_at) await markStoryStep(env, user.id, "dna_results", "auto");
  } catch (err) {
    console.warn("reconcile DNA steps failed:", err?.message || err);
  }
}

async function checkStory(request, env, user) {
  const body = await readJsonSafe(request);
  const stepId = typeof body?.stepId === "string" ? body.stepId : null;
  if (!stepId || !STORY_STEP_IDS.has(stepId)) {
    return json({ error: "Unknown step" }, 400);
  }
  const step = STORY_STEPS.find((s) => s.id === stepId);
  if (step.type !== "manual") {
    return json({ error: "This step is completed automatically — no need to tick it." }, 400);
  }
  await markStoryStep(env, user.id, stepId, "manual");
  return getStory(env, user);
}

async function uncheckStory(request, env, user) {
  const body = await readJsonSafe(request);
  const stepId = typeof body?.stepId === "string" ? body.stepId : null;
  if (!stepId || !STORY_STEP_IDS.has(stepId)) {
    return json({ error: "Unknown step" }, 400);
  }
  const step = STORY_STEPS.find((s) => s.id === stepId);
  if (step.type !== "manual") {
    return json({ error: "Auto steps can't be unchecked manually." }, 400);
  }
  await env.DB.prepare(
    "DELETE FROM story_progress WHERE user_id = ? AND step_id = ?"
  ).bind(user.id, stepId).run();
  return getStory(env, user);
}

// --- DNA test order + results upload --------------------------------------
async function postDnaOrder(_request, env, user) {
  const now = nowSec();
  await env.DB.prepare(
    "UPDATE users SET dna_ordered_at = COALESCE(dna_ordered_at, ?) WHERE id = ?"
  ).bind(now, user.id).run();
  await markStoryStep(env, user.id, "order_dna", "auto");
  return json({ ok: true, dna_ordered_at: now });
}

async function postDnaResults(_request, env, user) {
  // First require an order to exist.
  const u = await env.DB.prepare(
    "SELECT dna_ordered_at FROM users WHERE id = ?"
  ).bind(user.id).first();
  if (!u?.dna_ordered_at) {
    return json({ error: "Order your EndoMe DNA test first." }, 400);
  }
  const now = nowSec();
  await env.DB.prepare(
    "UPDATE users SET dna_results_at = COALESCE(dna_results_at, ?) WHERE id = ?"
  ).bind(now, user.id).run();
  await markStoryStep(env, user.id, "dna_results", "auto");
  return json({ ok: true, dna_results_at: now });
}

// Idempotent — first call sets the row, subsequent calls are no-ops.
async function markStoryStep(env, userId, stepId, by = "auto") {
  if (!STORY_STEP_IDS.has(stepId)) return;
  try {
    await env.DB.prepare(
      "INSERT INTO story_progress (user_id, step_id, completed_at, completed_by) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(user_id, step_id) DO NOTHING"
    ).bind(userId, stepId, nowSec(), by).run();
  } catch (err) {
    // Don't ever break the calling handler — story progress is best-effort.
    console.warn("markStoryStep failed:", err?.message || err);
  }
}

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
