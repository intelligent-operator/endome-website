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

        // --- Donations (public) ------------------------------------------
        if (url.pathname === "/api/donations/totals" && request.method === "GET") {
          if (!env.DB) return json({ error: "Storage not configured" }, 503);
          return jsonHeaders(await getDonationTotals(env));
        }
        if (url.pathname === "/api/donations/leaderboard" && request.method === "GET") {
          if (!env.DB) return json({ error: "Storage not configured" }, 503);
          return jsonHeaders(await getDonationLeaderboard(env));
        }
        if (url.pathname === "/api/donations/checkout" && request.method === "POST") {
          if (!env.DB) return json({ error: "Storage not configured" }, 503);
          const sess = await readSession(request, env);
          const viewer = sess ? await getOrCreateUser(env, sess.u).catch(() => null) : null;
          return jsonHeaders(await postDonationCheckout(request, env, viewer));
        }

        // --- Public(ish) profile read: /api/users/:username -----------------
        // Still session-gated so anonymous scraping is blocked, but the
        // viewer doesn't have to share a circle with the target.
        const userProfileMatch = url.pathname.match(/^\/api\/users\/([^\/]+)$/);
        if (userProfileMatch && request.method === "GET") {
          const session = await readSession(request, env);
          if (!session) return json({ error: "Unauthorized" }, 401);
          if (!env.DB) return json({ error: "Storage not configured" }, 503);
          const viewer = await getOrCreateUser(env, session.u);
          return jsonHeaders(await getPublicProfile(env, viewer, decodeURIComponent(userProfileMatch[1])));
        }

        // --- /api/acp/* — Admin Control Panel APIs ------------------------
        // Locked to the env-var admin login only (AUTH_USERNAME).
        if (url.pathname.startsWith("/api/acp/")) {
          const session = await readSession(request, env);
          if (!isAdminSession(env, session)) return json({ error: "Forbidden" }, 403);
          if (!env.DB) return json({ error: "Storage not configured" }, 503);
          return jsonHeaders(await handleAcp(request, env, url));
        }

        // --- Authenticated user-data endpoints ----------------------------
        if (url.pathname.startsWith("/api/me/")) {
          const session = await readSession(request, env);
          if (!session) return json({ error: "Unauthorized" }, 401);
          if (!env.DB) return json({ error: "Storage not configured" }, 503);
          const user = await getOrCreateUser(env, session.u);

          // --- Medications ------------------------------------------------
          if (url.pathname === "/api/me/medications" && request.method === "GET") {
            return jsonHeaders(await getMedications(env, user));
          }
          if (url.pathname === "/api/me/medications" && request.method === "POST") {
            return jsonHeaders(await createMedication(request, env, user));
          }
          if (url.pathname === "/api/me/medications/community" && request.method === "POST") {
            return jsonHeaders(await getCommunityStatsForCatalog(request, env, user));
          }
          if (url.pathname === "/api/me/medications/react" && request.method === "POST") {
            return jsonHeaders(await postMedReaction(request, env, user));
          }
          if (url.pathname === "/api/me/medications/top" && request.method === "GET") {
            return jsonHeaders(await getMedTopPicks(env));
          }
          if (url.pathname === "/api/me/medications/timetable" && request.method === "GET") {
            return jsonHeaders(await getMedicationTimetable(env, user));
          }
          const medSchedMatch = url.pathname.match(/^\/api\/me\/medications\/(\d+)\/schedules(?:\/(\d+))?$/);
          if (medSchedMatch) {
            const medId = +medSchedMatch[1];
            const schedId = medSchedMatch[2] ? +medSchedMatch[2] : null;
            if (!schedId && request.method === "GET")  return jsonHeaders(await getMedicationSchedules(env, user, medId));
            if (!schedId && request.method === "POST") return jsonHeaders(await createMedicationSchedule(request, env, user, medId));
            if (schedId && request.method === "DELETE") return jsonHeaders(await deleteMedicationSchedule(env, user, medId, schedId));
          }
          const medMatch = url.pathname.match(/^\/api\/me\/medications\/(\d+)(?:\/(\w+))?$/);
          if (medMatch) {
            const id = +medMatch[1];
            const action = medMatch[2];
            if (!action      && request.method === "PUT")    return jsonHeaders(await updateMedication(request, env, user, id));
            if (!action      && request.method === "DELETE") return jsonHeaders(await deleteMedication(env, user, id));
            if (action === "log"  && request.method === "POST") return jsonHeaders(await logMedicationDose(request, env, user, id));
            if (action === "logs" && request.method === "GET")  return jsonHeaders(await getMedicationLogs(env, user, id));
          }

          // --- Recipes (community cookbook) ------------------------------
          if (url.pathname === "/api/me/recipes" && request.method === "GET") {
            return jsonHeaders(await listRecipes(request, env, user));
          }
          if (url.pathname === "/api/me/recipes" && request.method === "POST") {
            return jsonHeaders(await createRecipe(request, env, user));
          }
          if (url.pathname === "/api/me/recipe-foods" && request.method === "GET") {
            return jsonHeaders(await listRecipeFoods(request, env, user));
          }
          if (url.pathname === "/api/me/recipe-foods" && request.method === "POST") {
            return jsonHeaders(await createRecipeFood(request, env, user));
          }
          if (url.pathname === "/api/me/recipe-categories" && request.method === "GET") {
            return jsonHeaders(getRecipeCategories());
          }
          const recipeMatch = url.pathname.match(/^\/api\/me\/recipes\/(\d+)(?:\/(\w+))?$/);
          if (recipeMatch) {
            const id = +recipeMatch[1];
            const action = recipeMatch[2];
            if (!action     && request.method === "GET")    return jsonHeaders(await getRecipe(env, user, id));
            if (!action     && request.method === "DELETE") return jsonHeaders(await deleteRecipe(env, user, id));
            if (action === "react" && request.method === "POST") return jsonHeaders(await postRecipeReaction(request, env, user, id));
          }

          // --- Documents (private file storage in R2) ---------------------
          if (url.pathname === "/api/me/documents" && request.method === "GET") {
            return jsonHeaders(await listDocuments(env, user));
          }
          if (url.pathname === "/api/me/documents" && request.method === "POST") {
            return jsonHeaders(await uploadDocument(request, env, user));
          }
          const docMatch = url.pathname.match(/^\/api\/me\/documents\/(\d+)(?:\/(\w+))?$/);
          if (docMatch) {
            const id = +docMatch[1];
            const action = docMatch[2];
            if (!action       && request.method === "DELETE") return await deleteDocument(env, user, id);
            if (action === "file" && request.method === "GET") return await streamDocument(env, user, id);
          }

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
          if (url.pathname === "/api/me/week" && request.method === "GET") {
            return jsonHeaders(await getMeWeek(env, user));
          }
          if (url.pathname === "/api/me/notifications" && request.method === "GET") {
            return jsonHeaders(await getNotifications(env, user));
          }
          if (url.pathname === "/api/me/pet" && request.method === "GET") {
            return jsonHeaders(await getMePet(env, user));
          }
          if (url.pathname === "/api/me/pet" && request.method === "PUT") {
            return jsonHeaders(await putPet(request, env, user));
          }
          if (url.pathname === "/api/me/pet/hatch" && request.method === "POST") {
            return jsonHeaders(await postPetHatch(env, user));
          }
          if (url.pathname === "/api/me/pet/feed" && request.method === "POST") {
            return jsonHeaders(await postPetFeed(env, user));
          }
          if (url.pathname === "/api/me/pet/play" && request.method === "POST") {
            return jsonHeaders(await postPetPlay(env, user));
          }
          if (url.pathname === "/api/me/pet/pat" && request.method === "POST") {
            return jsonHeaders(await postPetPat(env, user));
          }
          if (url.pathname === "/api/me/pet/clean" && request.method === "POST") {
            return jsonHeaders(await postPetClean(env, user));
          }
          if (url.pathname === "/api/me/pet/state" && request.method === "GET") {
            return jsonHeaders(await getEndopetState(env, user));
          }
          if (url.pathname === "/api/me/pet/shop" && request.method === "GET") {
            return jsonHeaders(await getEndopetShop(env, user));
          }
          if (url.pathname === "/api/me/pet/buy" && request.method === "POST") {
            return jsonHeaders(await postEndopetBuy(request, env, user));
          }
          if (url.pathname === "/api/me/pet/equip" && request.method === "POST") {
            return jsonHeaders(await postEndopetEquip(request, env, user));
          }
          if (url.pathname === "/api/me/pet/use" && request.method === "POST") {
            return jsonHeaders(await postEndopetUse(request, env, user));
          }
          if (url.pathname === "/api/me/pet/rest" && request.method === "POST") {
            return jsonHeaders(await postEndopetRest(request, env, user));
          }
          if (url.pathname === "/api/me/pet/rest/end" && request.method === "POST") {
            return jsonHeaders(await postEndopetRestEnd(request, env, user));
          }

          // --- Community ----------------------------------------------------
          // --- Profile & Friends ------------------------------------------
          if (url.pathname === "/api/me/profile" && request.method === "GET") {
            return jsonHeaders(await getMyProfile(env, user));
          }
          if (url.pathname === "/api/me/profile" && request.method === "PUT") {
            return jsonHeaders(await putMyProfile(request, env, user));
          }
          if (url.pathname === "/api/me/password" && request.method === "POST") {
            return jsonHeaders(await postChangePassword(request, env, user));
          }
          if (url.pathname === "/api/me/account" && request.method === "DELETE") {
            return jsonHeaders(await deleteMyAccount(request, env, user));
          }
          if (url.pathname === "/api/me/friends" && request.method === "GET") {
            return jsonHeaders(await getMyFriends(env, user));
          }
          const friendActionMatch = url.pathname.match(/^\/api\/me\/friends\/([^\/]+)(?:\/(\w+))?$/);
          if (friendActionMatch) {
            const [, otherId, action] = friendActionMatch;
            const decoded = decodeURIComponent(otherId);
            if (!action      && request.method === "POST")   return jsonHeaders(await postFriendRequest(env, user, decoded));
            if (!action      && request.method === "DELETE") return jsonHeaders(await deleteFriendship(env, user, decoded));
            if (action === "accept"  && request.method === "POST") return jsonHeaders(await postFriendAccept(env, user, decoded));
            if (action === "decline" && request.method === "POST") return jsonHeaders(await postFriendDecline(env, user, decoded));
          }
          if (url.pathname === "/api/me/community" && request.method === "GET") {
            return jsonHeaders(await getCommunityHub(env, user));
          }
          if (url.pathname === "/api/me/community/stats" && request.method === "GET") {
            return jsonHeaders(await getCommunityStats(env, user));
          }
          if (url.pathname === "/api/me/community/circles" && request.method === "POST") {
            return jsonHeaders(await postCreateCircle(request, env, user));
          }
          const slugMatch = url.pathname.match(/^\/api\/me\/community\/circles\/([a-z0-9-]+)(?:\/(\w+))?$/);
          if (slugMatch) {
            const [, slug, action] = slugMatch;
            if (!action      && request.method === "GET")  return jsonHeaders(await getCircleDetail(env, user, slug));
            if (action === "join"   && request.method === "POST") return jsonHeaders(await postJoinCircle(env, user, slug));
            if (action === "leave"  && request.method === "POST") return jsonHeaders(await postLeaveCircle(env, user, slug));
            if (action === "posts"  && request.method === "POST") return jsonHeaders(await postCreatePost(request, env, user, slug));
          }
          const postMatch = url.pathname.match(/^\/api\/me\/community\/posts\/(\d+)(?:\/(\w+))?$/);
          if (postMatch) {
            const id = +postMatch[1];
            const action = postMatch[2];
            if (!action     && request.method === "DELETE") return jsonHeaders(await deletePost(env, user, id));
            if (action === "react"   && request.method === "POST") return jsonHeaders(await reactPost(env, user, id));
            if (action === "replies" && request.method === "GET")  return jsonHeaders(await getReplies(env, user, id));
            if (action === "replies" && request.method === "POST") return jsonHeaders(await postCreateReply(request, env, user, id));
          }
          const replyMatch = url.pathname.match(/^\/api\/me\/community\/replies\/(\d+)\/react$/);
          if (replyMatch && request.method === "POST") {
            return jsonHeaders(await reactReply(env, user, +replyMatch[1]));
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
            return jsonHeaders(await postTestOrder(request, env, user, "dna"));
          }
          if (url.pathname === "/api/me/order/bloods" && request.method === "POST") {
            return jsonHeaders(await postTestOrder(request, env, user, "bloods"));
          }
          if (url.pathname === "/api/me/order/map" && request.method === "POST") {
            return jsonHeaders(await postTestOrder(request, env, user, "map"));
          }
          if (url.pathname === "/api/me/checkout/dna" && request.method === "POST") {
            return jsonHeaders(await postTestCheckout(env, user, "dna"));
          }
          if (url.pathname === "/api/me/checkout/bloods" && request.method === "POST") {
            return jsonHeaders(await postTestCheckout(env, user, "bloods"));
          }
          if (url.pathname === "/api/me/checkout/map" && request.method === "POST") {
            return jsonHeaders(await postTestCheckout(env, user, "map"));
          }
          if (url.pathname === "/api/me/results/dna" && request.method === "POST") {
            return jsonHeaders(await postTestResults(request, env, user, "dna"));
          }
          if (url.pathname === "/api/me/results/bloods" && request.method === "POST") {
            return jsonHeaders(await postTestResults(request, env, user, "bloods"));
          }
          if (url.pathname === "/api/me/results/map" && request.method === "POST") {
            return jsonHeaders(await postTestResults(request, env, user, "map"));
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
      url.pathname === "/story"       || url.pathname.startsWith("/story/") ||
      url.pathname === "/tests"       || url.pathname.startsWith("/tests/") ||
      url.pathname === "/pet"         || url.pathname.startsWith("/pet/") ||
      url.pathname === "/community"   || url.pathname.startsWith("/community/") ||
      url.pathname === "/profile"     || url.pathname.startsWith("/profile/") ||
      url.pathname === "/u"           || url.pathname.startsWith("/u/") ||
      url.pathname === "/meds"        || url.pathname.startsWith("/meds/") ||
      url.pathname === "/documents"   || url.pathname.startsWith("/documents/") ||
      url.pathname === "/security"    || url.pathname.startsWith("/security/") ||
      url.pathname === "/research"    || url.pathname.startsWith("/research/") ||
      url.pathname === "/recipes"     || url.pathname.startsWith("/recipes/") ||
      url.pathname === "/explore"     || url.pathname.startsWith("/explore/")
    ) {
      const session = await readSession(request, env);
      if (!session) {
        return Response.redirect(new URL("/login", request.url).toString(), 302);
      }
    }

    // --- /acp — Admin Control Panel HTML gate ------------------------------
    // Same env-var admin as the API: anyone else gets bounced.
    if (url.pathname === "/acp" || url.pathname === "/acp.html" || url.pathname.startsWith("/acp/")) {
      const session = await readSession(request, env);
      if (!session) {
        return Response.redirect(new URL("/login", request.url).toString(), 302);
      }
      if (!isAdminSession(env, session)) {
        return Response.redirect(new URL("/dashboard", request.url).toString(), 302);
      }
    }

    // --- /u/<username> — serve the shared u.html page (JS reads the path). --
    if (url.pathname.startsWith("/u/")) {
      const profileReq = new Request(new URL("/u.html", request.url).toString(), request);
      const r = await env.ASSETS.fetch(profileReq);
      return withSecurityHeaders(r);
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
  // HTML must always revalidate so deploys reach users on next navigation
  // instead of being trapped behind a stale browser cache. JS/CSS are
  // versioned via ?v= query strings so they can be cached aggressively.
  headers.set("Cache-Control", "no-cache, must-revalidate");
  headers.set("Pragma", "no-cache");
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
    const userId        = session.metadata?.user_id || session.client_reference_id || null;
    const testId        = session.metadata?.test_id || null;
    const donationId    = session.metadata?.donation_id || null;
    const customerEmail = session.customer_details?.email || null;
    const amount        = session.amount_total != null ? (session.amount_total / 100).toFixed(2) : "?";
    const currency      = (session.currency || "AUD").toUpperCase();

    // Donation completion (no order to record, just mark paid).
    if (donationId) {
      try { await completeDonation(env, session); }
      catch (err) { console.error("completeDonation failed:", err?.message || err); }
    }

    // Record the order against the user (sets ordered_at + marks story step
    // + sends the customer a branded confirmation email).
    if (userId && testId) {
      await recordTestOrder(env, userId, testId, customerEmail);
    }

    // Notify the team inbox so we know to fulfill.
    try {
      await mandrillSend(env, {
        to: [{ email: env.NOTIFY_EMAIL || FROM_EMAIL_DEFAULT, type: "to" }],
        subject: `New ${testId ? TESTS[testId]?.name || testId : "EndoMe"} order — ${customerEmail || "unknown"}`,
        from_email: env.NEWSLETTER_FROM_EMAIL || FROM_EMAIL_DEFAULT,
        from_name:  env.NEWSLETTER_FROM_NAME || "EndoMe",
        text:
          `Test:    ${testId || "unknown"}\n` +
          `Amount:  $${amount} ${currency}\n` +
          `Email:   ${customerEmail || "—"}\n` +
          `User ID: ${userId || "—"}\n` +
          `Session: ${session.id}\n`,
      });
    } catch (err) {
      console.error("notify-team email failed:", err?.message || err);
    }
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
  // appetite
  "appetite",
]);
const ALLOWED_PHASES   = new Set(["menstrual", "follicular", "ovulation", "luteal"]);
const ALLOWED_FLOW     = new Set(["none", "spotting", "light", "medium", "heavy"]);
const ALLOWED_MUCUS    = new Set(["dry", "sticky", "creamy", "watery", "eggwhite"]);
const ALLOWED_MOVEMENT = new Set(["none", "light", "moderate", "vigorous"]);
const ALLOWED_BOWEL    = new Set(["constipated", "normal", "loose"]);
const ALLOWED_INTIMACY = new Set(["none", "comfortable", "uncomfortable"]);
const ALLOWED_TRIGGERS = new Set(["food","stress","exercise","intimacy","cold","hormones","travel","sleep","unknown"]);
const ALLOWED_RELIEF   = new Set(["heat","rest","medication","hydration","movement","massage","bath","sleep","none"]);
const ALLOWED_EVENING_SYMPTOMS = new Set([
  "bloating", "ovulation_pain", "nausea", "fatigue", "headaches",
  "dizziness", "pms", "skin_breakout",
]);
const ALLOWED_APPETITE = new Set(["low", "normal", "high"]);
const ALLOWED_PAIN_TYPES = new Set([
  "sharp", "dull", "deep", "burning", "aching", "throbbing", "cramping", "stabbing", "shooting", "pressure", "twisting", "pulling",
]);
// Pain-type field only makes sense for these symptom ids.
const PAIN_SYMPTOMS = new Set([
  "pain", "pelvic_pain", "back_pain", "cramps", "headache", "endo_belly", "breast_tender",
  "painful_urination", "painful_bowel", "painful_sex",
]);

// Aggregate runtime bootstrap. Each underlying ensure* function is already
// idempotent + boot-cached, so calling this on every signed-in request is
// effectively free after the first. Running here means a fresh deploy with
// new tables/columns "just works" without anyone touching the D1 console.
let _bootstrapDone = false;
let _bootstrapPromise = null;
async function bootstrapSchema(env) {
  if (_bootstrapDone) return;
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    await Promise.all([
      ensureCommunitySchema(env),
      ensureProfileSchema(env),
      ensureStoryTable(env),
      ensureMedSchema(env),
      ensureDocSchema(env),
      ensurePetPoopColumn(env),
      ensureDonationsSchema(env),
      ensureRecipeSchema(env),
    ]);
    _bootstrapDone = true;
  })();
  return _bootstrapPromise;
}

// Force-run for admin debugging. Resets the cache so this isolate re-runs
// the whole bootstrap and reports any failures.
async function adminBootstrapSchema(env) {
  _bootstrapDone = false;
  _bootstrapPromise = null;
  const results = [];
  const run = async (name, fn) => {
    try { await fn(env); results.push({ name, ok: true }); }
    catch (err) { results.push({ name, ok: false, error: String(err?.message || err) }); }
  };
  await run("community",  ensureCommunitySchema);
  await run("profile",    ensureProfileSchema);
  await run("story",      ensureStoryTable);
  await run("medications", ensureMedSchema);
  await run("documents",  ensureDocSchema);
  await run("pet_columns", ensurePetPoopColumn);
  await run("donations",  ensureDonationsSchema);
  await run("recipes",    ensureRecipeSchema);
  return json({ ok: true, results });
}

async function getOrCreateUser(env, username) {
  // Schema gets bootstrapped on every cold isolate before we touch tables
  // that might still be missing — saves us hand-running D1 console commands
  // after each deploy. Cheap (no-ops once tables exist).
  await bootstrapSchema(env);

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
      `INSERT INTO pets (user_id, pet_type, pet_name, level, xp, mood, streak_days, color_seed, hunger, happiness, updated_at)
       VALUES (?, 'luna', 'Luna', 1, 0, 'happy', 0, ABS(RANDOM() % 360), 0, 100, ?)`
    ).bind(id, now),
  ]);
  // Auto-join the official EndoMe circle. Best-effort.
  await autoJoinOfficialCircle(env, id);
  return { id, username, display_name: display, timezone: "UTC" };
}

// --- /api/me/today ---------------------------------------------------------
async function getMeToday(request, env, user) {
  const url = new URL(request.url);
  const date = normaliseDate(url.searchParams.get("date"));

  // Every query individually .catch()ed so a missing column in any one
  // table (mid-migration) can't take down the whole /api/me/today response.
  const [daily, symptoms, pet, notifs, userRow] = await Promise.all([
    env.DB.prepare("SELECT * FROM daily_logs WHERE user_id = ? AND log_date = ?")
      .bind(user.id, date).first().catch((e) => { console.warn("daily_logs read:", e?.message); return null; }),
    env.DB.prepare(
      "SELECT * FROM symptoms WHERE user_id = ? AND log_date = ? ORDER BY logged_at DESC"
    ).bind(user.id, date).all().catch((e) => { console.warn("symptoms read:", e?.message); return { results: [] }; }),
    env.DB.prepare("SELECT * FROM pets WHERE user_id = ?").bind(user.id).first()
      .catch((e) => { console.warn("pets read:", e?.message); return null; }),
    env.DB.prepare(
      "SELECT id, type, title, body, action_url, created_at, read_at " +
      "FROM notifications WHERE user_id = ? AND dismissed_at IS NULL " +
      "ORDER BY created_at DESC LIMIT 20"
    ).bind(user.id).all().catch((e) => { console.warn("notifications read:", e?.message); return { results: [] }; }),
    env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(user.id).first()
      .catch((e) => { console.warn("users read:", e?.message); return null; }),
  ]);

  const tests = {};
  if (userRow) {
    for (const [id, t] of Object.entries(TESTS)) {
      tests[id] = {
        orderedAt: userRow[t.orderedCol] || null,
        resultsAt: userRow[t.resultsCol] || null,
      };
    }
  }

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
      eveningSymptoms: daily.evening_symptoms ? String(daily.evening_symptoms).split(",").filter(Boolean) : [],
      appetite: daily.appetite,
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
    tests,
    notifications: [
      ...(notifs.results || []),
      ...(await computeMedReminders(env, user).catch(() => [])),
    ],
  });
}

// Virtual reminders synthesised from medication_schedules. Returns notification
// objects shaped like the real `notifications` table so the dashboard bell can
// render them with the same template. Each due slot offers a "yes I took it /
// no I skipped" action linking back to /meds#timetable.
async function computeMedReminders(env, user) {
  await ensureMedSchema(env);
  // Pull all of today's slots + recent logs (past 6h).
  const day = new Date(); // server UTC — best-effort until we honour user TZ.
  const todayBit = 1 << day.getUTCDay();
  const slots = await env.DB.prepare(
    "SELECT s.medication_id, s.time_of_day, m.name " +
    "FROM medication_schedules s JOIN medications m " +
    "  ON m.id = s.medication_id AND m.is_active = 1 " +
    "WHERE s.user_id = ? AND (s.days_mask & ?) != 0"
  ).bind(user.id, todayBit).all().catch(() => ({ results: [] }));

  const recentLogs = await env.DB.prepare(
    "SELECT medication_id, taken_at FROM medication_logs " +
    "WHERE user_id = ? AND taken_at >= ?"
  ).bind(user.id, nowSec() - 6 * 3600).all().catch(() => ({ results: [] }));

  const out = [];
  const now = nowSec();
  for (const s of (slots.results || [])) {
    const [hh, mm] = (s.time_of_day || "0:0").split(":").map(Number);
    const slotDate = new Date(day);
    slotDate.setUTCHours(hh, mm, 0, 0);
    const slotSec = Math.floor(slotDate.getTime() / 1000);
    // Active window: 15 minutes before until 2 hours after the scheduled time.
    if (now < slotSec - 15 * 60) continue;
    if (now > slotSec + 2 * 3600) continue;
    const taken = (recentLogs.results || []).some(
      (l) => l.medication_id === s.medication_id && Math.abs(l.taken_at - slotSec) < 2 * 3600
    );
    if (taken) continue;
    out.push({
      id: `med:${s.medication_id}:${s.time_of_day}`,
      type: "med_due",
      title: `💊 Time for ${s.name}`,
      body: `Scheduled ${s.time_of_day}. Did you take it? Tap to mark yes or no.`,
      action_url: "/meds#timetable",
      created_at: slotSec,
      read_at: null,
    });
  }
  return out;
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
  const glow = await endopetGrantReward(env, user.id, "morning_checkin", date);
  const ach  = await endopetRunAllChecks(env, user.id, { welcomeBack: glow?.welcomeBack });
  return json({ ok: true, pointsAwarded, fullDayBonus, pet, glow, ach });
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
  const evenSyms  = tagList(body.eveningSymptoms, ALLOWED_EVENING_SYMPTOMS);
  const appetite  = oneOf(body.appetite, ALLOWED_APPETITE);

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
       evening_symptoms, appetite,
       points_total)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
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
       evening_symptoms   = COALESCE(excluded.evening_symptoms, daily_logs.evening_symptoms),
       appetite           = COALESCE(excluded.appetite,         daily_logs.appetite),
       points_total       = daily_logs.points_total + ?16`
  ).bind(
    user.id, date,
    overall, reflection, gratitude, now,
    water, movement, bowelCnt, bowelTyp, stress, intimacy, meds,
    evenSyms, appetite,
    pointsAwarded
  ).run();

  const pet = await awardXp(env, user.id, pointsAwarded, date);
  const glow = await endopetGrantReward(env, user.id, "evening_checkin", date);
  const ach  = await endopetRunAllChecks(env, user.id, { welcomeBack: glow?.welcomeBack });
  return json({ ok: true, pointsAwarded, fullDayBonus, pet, glow, ach });
}

// --- /api/me/symptoms (POST) ----------------------------------------------
async function postSymptom(request, env, user) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  // Accept either a `symptoms` array (new multi-select UI) or a single
  // `symptom` string (legacy single-select callers).
  const rawList = Array.isArray(body.symptoms) ? body.symptoms
                : (typeof body.symptom === "string" ? [body.symptom] : []);
  const symptoms = [];
  for (const item of rawList) {
    if (typeof item !== "string") continue;
    const lc = item.toLowerCase().trim();
    if (ALLOWED_SYMPTOMS.has(lc) && !symptoms.includes(lc)) symptoms.push(lc);
    if (symptoms.length >= 20) break;
  }
  if (!symptoms.length) return json({ error: "Pick at least one symptom." }, 400);

  const severity = clampInt(body.severity, 1, 5);
  if (severity == null) return json({ error: "severity is required (1–5)" }, 400);

  // Locations / pain types accept either an array (new) or a single string (legacy).
  const locations = pickStringList(body.locations ?? body.location, 6, 60);
  const locationCsv = locations.length ? locations.join(", ").slice(0, 240) : null;

  const painTypeList = [];
  const rawPainTypes = Array.isArray(body.painTypes) ? body.painTypes
                     : (typeof body.painType === "string" ? [body.painType] : []);
  for (const item of rawPainTypes) {
    if (typeof item !== "string") continue;
    const lc = item.toLowerCase().trim();
    if (ALLOWED_PAIN_TYPES.has(lc) && !painTypeList.includes(lc)) painTypeList.push(lc);
    if (painTypeList.length >= 6) break;
  }

  const notes    = sanitizeText(body.notes, 500);
  const triggers = tagList(body.triggers, ALLOWED_TRIGGERS);
  const relief   = tagList(body.relief, ALLOWED_RELIEF);
  const date = normaliseDate(body.date);
  const now = nowSec();

  // One DB row per symptom, sharing the descriptors. We only credit XP for
  // the first one (so logging "10 things at once" doesn't game the system),
  // and we batch the writes.
  const POINTS_FIRST = POINTS_SYMPTOM;
  const POINTS_EXTRA = Math.max(1, Math.floor(POINTS_SYMPTOM / 2));
  let totalPoints = 0;
  const stmts = [];
  symptoms.forEach((s, i) => {
    const painType = PAIN_SYMPTOMS.has(s) && painTypeList.length
      ? painTypeList.join(",").slice(0, 120) : null;
    const pts = i === 0 ? POINTS_FIRST : POINTS_EXTRA;
    totalPoints += pts;
    stmts.push(env.DB.prepare(
      "INSERT INTO symptoms (user_id, log_date, logged_at, symptom, severity, location, notes, triggers, relief, pain_type, points) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(user.id, date, now + i, s, severity, locationCsv, notes, triggers, relief, painType, pts));
  });
  stmts.push(env.DB.prepare(
    `INSERT INTO daily_logs (user_id, log_date, points_total)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, log_date) DO UPDATE SET points_total = daily_logs.points_total + ?`
  ).bind(user.id, date, totalPoints, totalPoints));
  await env.DB.batch(stmts);

  const pet = await awardXp(env, user.id, totalPoints, date);
  const flareSym = symptoms.find((s) => ["pelvic_pain", "endo_belly"].includes(s));
  const isFlare = severity >= 4 || !!flareSym;
  const glow = await endopetGrantReward(env, user.id, isFlare ? "flare" : "symptom", `${date}:${now}`);
  const ach  = await endopetRunAllChecks(env, user.id, { welcomeBack: glow?.welcomeBack });
  return json({ ok: true, pointsAwarded: totalPoints, count: symptoms.length, pet, glow, ach });
}

// Sanitize a list of free-text strings (location). Accepts either an array
// or a single string. Trims, drops empties, dedupes, caps length per item.
function pickStringList(v, maxCount, maxLen) {
  const arr = Array.isArray(v) ? v : (typeof v === "string" ? [v] : []);
  const out = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const cleaned = sanitizeText(item, maxLen);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= maxCount) break;
  }
  return out;
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

// --- /api/me/week ---------------------------------------------------------
// Last 7 days (local-ish, from "today" backwards) of: morning pain/energy/mood
// and whether anything was logged that day. Drives the streak ticks and the
// cycle-snapshot weekly chart.
async function getMeWeek(env, user) {
  const today = normaliseDate(null); // current local-ish YYYY-MM-DD
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 6);
  const startISO = start.toISOString().slice(0, 10);

  let daily = { results: [] };
  let symRows = { results: [] };
  try {
    daily = await env.DB.prepare(
      "SELECT log_date, morning_logged_at, evening_logged_at, " +
      "       morning_mood AS mood, morning_energy AS energy, morning_pain AS pain " +
      "FROM daily_logs WHERE user_id = ? AND log_date BETWEEN ? AND ? ORDER BY log_date ASC"
    ).bind(user.id, startISO, today).all();
  } catch (err) { console.warn("week daily:", err?.message); }
  try {
    symRows = await env.DB.prepare(
      "SELECT log_date, COUNT(*) AS n FROM symptoms " +
      "WHERE user_id = ? AND log_date BETWEEN ? AND ? GROUP BY log_date"
    ).bind(user.id, startISO, today).all();
  } catch (err) { console.warn("week symptoms:", err?.message); }

  const byDate = new Map();
  for (const r of daily.results || []) byDate.set(r.log_date, r);
  const symBy = new Map();
  for (const r of symRows.results || []) symBy.set(r.log_date, r.n);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const row = byDate.get(iso);
    const symCount = symBy.get(iso) || 0;
    const logged = !!(row?.morning_logged_at || row?.evening_logged_at || symCount > 0);
    days.push({
      date: iso,
      logged,
      pain:   row?.pain   ?? null,
      energy: row?.energy ?? null,
      mood:   row?.mood   ?? null,
      symptomCount: symCount,
    });
  }
  return json({ days });
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
  const meds = await computeMedReminders(env, user).catch(() => []);
  return json({ notifications: [...(res.results || []), ...meds] });
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
// PET — Tamagotchi-style state: hatching, hunger, happiness, actions.
// =============================================================================

// Per-hour decay/growth (so the pet feels alive between sessions).
const HUNGER_PER_HOUR    = 4;
const HAPPINESS_PER_HOUR = 3;

async function getMePet(env, user) {
  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?")
    .bind(user.id).first();
  return json({ pet: petFullResponse(pet) });
}

async function postPetHatch(env, user) {
  const now = nowSec();
  try {
    await env.DB.prepare(
      "UPDATE pets SET hatched_at = COALESCE(hatched_at, ?), updated_at = ?, " +
      "last_fed_at = COALESCE(last_fed_at, ?), last_played_at = COALESCE(last_played_at, ?) " +
      "WHERE user_id = ?"
    ).bind(now, now, now, now, user.id).run();
  } catch (err) {
    console.error("postPetHatch failed:", err?.message || err);
    return json({
      error: "Your pet's home isn't set up yet — migration 0007 needs to be applied to the database.",
    }, 503);
  }
  return getMePet(env, user);
}

async function postPetFeed(env, user) {
  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?")
    .bind(user.id).first();
  if (!pet?.hatched_at) return json({ error: "Hatch your pet first" }, 400);
  await ensurePetPoopColumn(env);
  const live = liveStats(pet);
  // Feeding is *mostly* the same effect, but with a sprinkle of randomness so
  // the same kibble doesn't always land the same way.
  const hunger    = Math.max(0, live.hunger - randInt(38, 52));
  const happiness = Math.min(100, live.happiness + randInt(5, 12));
  const now = nowSec();
  const meals = (pet.meals_since_clean || 0) + 1;
  try {
    await env.DB.prepare(
      "UPDATE pets SET hunger = ?, happiness = ?, last_fed_at = ?, meals_since_clean = ?, updated_at = ? WHERE user_id = ?"
    ).bind(hunger, happiness, now, meals, now, user.id).run();
  } catch {
    await env.DB.prepare(
      "UPDATE pets SET hunger = ?, happiness = ?, last_fed_at = ?, updated_at = ? WHERE user_id = ?"
    ).bind(hunger, happiness, now, now, user.id).run();
  }
  return getMePet(env, user);
}

async function postPetPlay(env, user) {
  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?")
    .bind(user.id).first();
  if (!pet?.hatched_at) return json({ error: "Hatch your pet first" }, 400);
  await ensurePetPoopColumn(env);
  const live = liveStats(pet);
  const now = nowSec();

  // Natural routine: how recently they were played with shapes the reaction.
  // First play after a quiet stretch lands big; rapid-fire plays earn less
  // (the pet's a little worn out) and only *sometimes* burn hunger.
  const minsSincePlay = pet.last_played_at ? (now - pet.last_played_at) / 60 : 99999;
  let happinessDelta, hungerDelta;
  if (minsSincePlay > 30) {
    happinessDelta = randInt(22, 30);
    hungerDelta    = Math.random() < 0.7 ? randInt(3, 9) : 0;
  } else if (minsSincePlay > 5) {
    happinessDelta = randInt(12, 22);
    hungerDelta    = Math.random() < 0.5 ? randInt(2, 6) : 0;
  } else {
    happinessDelta = randInt(4, 12);
    hungerDelta    = Math.random() < 0.3 ? randInt(1, 4) : 0;
  }

  const happiness = Math.min(100, live.happiness + happinessDelta);
  const hunger    = Math.min(100, live.hunger + hungerDelta);

  // Small XP reward for playing.
  let xp = (pet.xp || 0) + 3;
  let level = pet.level || 1;
  let leveledUp = false;
  while (xp >= level * 100) { xp -= level * 100; level += 1; leveledUp = true; }
  await env.DB.prepare(
    "UPDATE pets SET happiness = ?, hunger = ?, xp = ?, level = ?, last_played_at = ?, updated_at = ? WHERE user_id = ?"
  ).bind(happiness, hunger, xp, level, now, now, user.id).run();
  const res = await getMePet(env, user);
  const data = JSON.parse(await res.clone().text());
  if (leveledUp) data.leveledUp = true;
  return json(data);
}

// --- /api/me/pet/clean — wipe up the poop, small happiness + XP boost. ----
async function postPetClean(env, user) {
  await ensurePetPoopColumn(env);
  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?")
    .bind(user.id).first();
  if (!pet?.hatched_at) return json({ error: "Hatch your pet first" }, 400);
  if (!petHasPoop(pet)) {
    return json({ ok: true, hadPoop: false });
  }
  const live = liveStats(pet);
  const happiness = Math.min(100, live.happiness + randInt(4, 9));
  const now = nowSec();
  // Bump XP gently — clean pet, clean conscience.
  let xp = (pet.xp || 0) + 2;
  let level = pet.level || 1;
  while (xp >= level * 100) { xp -= level * 100; level += 1; }
  try {
    await env.DB.prepare(
      "UPDATE pets SET happiness = ?, xp = ?, level = ?, last_cleaned_at = ?, meals_since_clean = 0, updated_at = ? WHERE user_id = ?"
    ).bind(happiness, xp, level, now, now, user.id).run();
  } catch (err) {
    // Column might not exist if ensurePetPoopColumn lost the race. Fallback.
    await env.DB.prepare(
      "UPDATE pets SET happiness = ?, xp = ?, level = ?, updated_at = ? WHERE user_id = ?"
    ).bind(happiness, xp, level, now, user.id).run();
  }
  return getMePet(env, user);
}

// --- Pet poop helpers -----------------------------------------------------
// Best-effort: add `last_cleaned_at` to the `pets` table if it doesn't exist.
// SQLite has no IF NOT EXISTS for ADD COLUMN, so we just swallow the error.
let _petPoopColumnChecked = false;
async function ensurePetPoopColumn(env) {
  if (_petPoopColumnChecked) return;
  _petPoopColumnChecked = true;
  for (const sql of [
    "ALTER TABLE pets ADD COLUMN last_cleaned_at INTEGER",
    "ALTER TABLE pets ADD COLUMN meals_since_clean INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { await env.DB.prepare(sql).run(); } catch { /* already exists */ }
  }
}

// Pet has poop when it's been a few hours since the last feed and we haven't
// cleaned up since that feed. Each feed has its own randomised "poop time"
// derived from last_fed_at so we don't need extra storage.
function petHasPoop(pet) {
  if (!pet) return false;
  const now = nowSec();
  const cleanedAt = pet.last_cleaned_at || 0;

  // Path 1 — "ate too much": three or more meals stacked up between cleans.
  // Random 25% chance per extra meal that one of them produces a mess, but
  // it's deterministic per pet so refreshes don't flip the state.
  const meals = pet.meals_since_clean || 0;
  if (meals >= 3) return true;
  if (meals === 2 && pet.last_fed_at && now > pet.last_fed_at + 20 * 60) {
    const seed = (pet.last_fed_at ^ (pet.id || 0)) % 100;
    if (seed < 35) return true; // 35% chance after 2 stacked meals + 20 min
  }

  // Path 2 — normal pet-like routine, a few hours after a meal.
  if (!pet.last_fed_at) return false;
  const delaySec = (90 + (pet.last_fed_at % 151)) * 60;  // 90–240 min
  const poopAt = pet.last_fed_at + delaySec;
  if (now < poopAt) return false;
  if (cleanedAt >= poopAt) return false;
  if (now > poopAt + 36 * 3600) return false; // gives up after a day-and-a-half
  return true;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function postPetPat(env, user) {
  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?")
    .bind(user.id).first();
  if (!pet?.hatched_at) return json({ error: "Hatch your pet first" }, 400);
  const live = liveStats(pet);
  const happiness = Math.min(100, live.happiness + 8);
  const now = nowSec();
  await env.DB.prepare(
    "UPDATE pets SET happiness = ?, last_played_at = COALESCE(last_played_at, ?), updated_at = ? WHERE user_id = ?"
  ).bind(happiness, now, now, user.id).run();
  return getMePet(env, user);
}

// Apply time-based decay so hunger/happiness reflect how long it's been.
function liveStats(pet) {
  const now = nowSec();
  const hoursFed   = pet.last_fed_at    ? Math.max(0, (now - pet.last_fed_at)    / 3600) : 0;
  const hoursPlay  = pet.last_played_at ? Math.max(0, (now - pet.last_played_at) / 3600) : 0;
  const hunger     = Math.max(0, Math.min(100, (pet.hunger || 0)    + Math.floor(hoursFed  * HUNGER_PER_HOUR)));
  const happiness  = Math.max(0, Math.min(100, (pet.happiness || 100) - Math.floor(hoursPlay * HAPPINESS_PER_HOUR)));
  return { hunger, happiness };
}

function petFullResponse(pet) {
  if (!pet) return null;
  const live = liveStats(pet);
  const xpForNext = (pet.level || 1) * 100;
  const mood = live.happiness >= 70 ? "happy" : live.happiness >= 35 ? "neutral" : "sad";
  return {
    type:        pet.pet_type,
    name:        pet.pet_name,
    level:       pet.level || 1,
    xp:          pet.xp || 0,
    xpForNext,
    mood,
    streakDays:  pet.streak_days || 0,
    hatchedAt:   pet.hatched_at || null,
    isHatched:   !!pet.hatched_at,
    colorSeed:   pet.color_seed || 0,
    hunger:      live.hunger,
    happiness:   live.happiness,
    lastFedAt:   pet.last_fed_at || null,
    lastPlayedAt: pet.last_played_at || null,
    hasPoop:     petHasPoop(pet),
  };
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
const TESTS = {
  dna: {
    name: "EndoMe DNA",
    icon: "🧬",
    priceLabel: "$249 AUD",
    orderedCol: "dna_ordered_at",
    resultsCol: "dna_results_at",
    priceEnv:   "STRIPE_PRICE_DNA",
  },
  bloods: {
    name: "EndoMe Bloods",
    icon: "🩸",
    priceLabel: "$149 AUD",
    orderedCol: "bloods_ordered_at",
    resultsCol: "bloods_results_at",
    priceEnv:   "STRIPE_PRICE_BLOODS",
  },
  map: {
    name: "EndoMe Map",
    icon: "🗺️",
    priceLabel: "$349 AUD",
    orderedCol: "map_ordered_at",
    resultsCol: "map_results_at",
    priceEnv:   "STRIPE_PRICE_MAP",
  },
};
const TEST_IDS = new Set(Object.keys(TESTS));

const STORY_STEPS = [
  // Phase 1 — Get insights from your body
  { id: "order_dna", phase: "Get insights", phaseDesc: "Real data about what's happening inside.",
    title: "Request your EndoMe DNA test",
    desc: "An at-home DNA kit that maps the markers most linked to endometriosis.",
    why: "Why this matters",
    details: "Endometriosis runs in families and is partly genetic, but most people never get tested for the markers that affect how their body handles oestrogen, inflammation and pain. The EndoMe DNA kit reads the variants that are most studied in endo so you stop guessing about whether the pill, an NSAID or a particular supplement is actually going to do anything for you. Your results stay private and feed into the picture you bring to your specialist.",
    icon: "🧬", type: "action",
    actionLabel: "Request EndoMe DNA", actionEndpoint: "/api/me/order/dna" },
  { id: "dna_results", phase: "Get insights",
    title: "Upload your DNA results",
    desc: "Send back your sample, then upload your results when they arrive.",
    why: "Why uploading matters",
    details: "Once your sample is processed we send you the raw report. Uploading it here unlocks the personalised insights across EndoMe — the medication page can flag whether you'll metabolise something faster or slower than average, and your story timeline can adapt to what your genetics suggest is most likely to help first.",
    icon: "📊", type: "action", requires: "order_dna",
    actionLabel: "Upload results", actionEndpoint: "/api/me/results/dna" },

  { id: "order_bloods", phase: "Get insights",
    title: "Request your EndoMe Bloods test",
    desc: "A blood panel covering inflammation, hormones, and key deficiencies.",
    why: "Why this matters",
    details: "Endo flares show up in your bloodwork before you have a clear diagnosis. The EndoMe Bloods panel covers CA-125, CRP, ferritin, vitamin D, B12 and the sex hormones — exactly the things a good endo specialist asks for at the first visit. Doing it now means you walk in with the receipts rather than waiting weeks for a referral and then weeks more for results.",
    icon: "🩸", type: "action",
    actionLabel: "Request EndoMe Bloods", actionEndpoint: "/api/me/order/bloods" },
  { id: "bloods_results", phase: "Get insights",
    title: "Upload your Bloods results",
    desc: "Get your blood draw done and upload the report here.",
    why: "Why uploading matters",
    details: "Your bloodwork joins your DNA and symptom log to build the full picture. Trends are more useful than single numbers, so the sooner this is in the more your future check-ins can be compared against your own baseline.",
    icon: "📊", type: "action", requires: "order_bloods",
    actionLabel: "Upload results", actionEndpoint: "/api/me/results/bloods" },

  { id: "order_map", phase: "Get insights",
    title: "Request your EndoMe Map test",
    desc: "An at-home urine test that maps your hormone pathways end-to-end.",
    why: "Why this matters",
    details: "Bloods give you a snapshot. The Map gives you the full hormone pathway: oestrogen, progesterone, androgens and their metabolites measured in urine over 24 hours. It's the test that explains why two people on the same pill have totally different experiences, and it's the data most endo specialists wish they had at the first visit.",
    icon: "🗺️", type: "action",
    actionLabel: "Request EndoMe Map", actionEndpoint: "/api/me/order/map" },
  { id: "map_results", phase: "Get insights",
    title: "Upload your Map results",
    desc: "Collect your sample at home, post it back, then upload the report here.",
    why: "Why uploading matters",
    details: "Map results sharpen everything: which hormones are dominant, which metabolite pathways are overactive, and which supplements or interventions actually fit your physiology. Uploading puts it side-by-side with your bloods and DNA in one view.",
    icon: "📊", type: "action", requires: "order_map",
    actionLabel: "Upload results", actionEndpoint: "/api/me/results/map" },

  { id: "log_14_days", phase: "Get insights",
    title: "Log symptoms for 14 days",
    desc: "Two weeks of patterns is enough to start seeing your story.",
    why: "Why 14 days",
    details: "Most cycles are 21 to 35 days, so a fortnight of logs catches at least half of yours including the days that tend to flare. We use these two weeks to build the first version of your timeline and to give your GP something concrete instead of \"it hurts most months\". After that, every extra day makes the pattern clearer.",
    icon: "📈", type: "auto", autoLabel: "Tracks automatically" },

  // Phase 2 — Talk to your doctor
  { id: "prepare_gp", phase: "Talk to your doctor", phaseDesc: "Bring the receipts. The right preparation changes how this conversation goes.",
    title: "Prepare for your GP visit",
    desc: "Pull together your symptom history, your DNA results, and a list of questions.",
    why: "Why preparation matters",
    details: "The average GP visit is about 12 minutes. Walking in with a short symptom summary, your test results and a written list of questions is the single biggest thing you can do to avoid being dismissed. The community has watched too many people get told \"that's just period pain\" — preparation is how you stop that happening to you.",
    icon: "📝", type: "manual" },

  { id: "talk_gp", phase: "Talk to your doctor",
    title: "Talk to your GP about endometriosis",
    desc: "Share what you've tracked. Be specific: pain, cycle, what you've already tried.",
    why: "Why this conversation matters",
    details: "Your GP is the gatekeeper to a specialist. Be specific: pain score, how many days a month it stops you doing normal things, what painkillers you've already tried, what's failed. Use the word endometriosis explicitly — it changes how the consult is documented and makes referrals much easier.",
    icon: "👩‍⚕️", type: "manual" },

  { id: "referral", phase: "Talk to your doctor",
    title: "Get a specialist referral",
    desc: "Ask for a gynaecologist who specifically works with endometriosis patients.",
    why: "Why the right specialist matters",
    details: "Not every gynaecologist is an endo expert. Endo care is sub-specialised — laparoscopic excision surgeons, advanced pelvic ultrasonographers and pain specialists all live under \"gynae\". Ask your GP to refer specifically to someone who treats endometriosis as a focus, even if it means a longer wait.",
    icon: "📋", type: "manual" },

  // Phase 3 — Diagnosis
  { id: "specialist", phase: "Diagnosis", phaseDesc: "The path to answers — gather everything, then bring it together.",
    title: "See an endo specialist",
    desc: "Bring your records, your DNA results, and the questions you prepared.",
    why: "Why the first visit counts",
    details: "Specialists make a plan in the first 30 minutes that often holds for years. Bring everything: your symptom logs, DNA, bloods, Map, prior scans, and a written list of what you want answered. If anything wasn't asked, send it as a follow-up — it goes into the notes.",
    icon: "🏥", type: "manual" },

  { id: "imaging", phase: "Diagnosis",
    title: "Get pelvic imaging",
    desc: "Pelvic ultrasound or MRI as recommended by your specialist.",
    why: "Why imaging matters",
    details: "A skilled pelvic ultrasound or MRI can pick up endometriomas, deep infiltrating lesions and adhesions without surgery. It also helps surgeons plan: knowing what's there before going in changes the operating time and the outcome. Insist on an operator who specifically scans for endo — generic pelvic ultrasounds often miss it.",
    icon: "🔬", type: "manual" },

  { id: "diagnosis", phase: "Diagnosis",
    title: "Receive your diagnosis",
    desc: "Formal diagnosis (or ruling out) from your specialist. Whatever it says, you're not alone.",
    why: "Why a written diagnosis matters",
    details: "A formal diagnosis on paper unlocks treatments, insurance claims, employer accommodations and surgical pathways that otherwise feel out of reach. If your specialist suspects endo but won't write the word, ask why, ask what would change their mind, and consider a second opinion.",
    icon: "📜", type: "manual" },

  // Phase 4 — Live well
  { id: "treatment", phase: "Live well", phaseDesc: "Beyond diagnosis. This is the day-to-day work that adds up.",
    title: "Agree a treatment plan",
    desc: "Lifestyle, hormonal options, pain management, surgery — discuss the right mix with your specialist.",
    why: "Why a plan matters",
    details: "A treatment plan is rarely one thing. It's usually a stack: pain management for the worst days, a hormonal strategy to reduce flares, lifestyle moves that support both, and a clear trigger for when to escalate to surgery. Agree it in writing so you and any new clinician can pick up where you left off.",
    icon: "💊", type: "manual" },

  { id: "habits", phase: "Live well",
    title: "Build daily habits that help",
    desc: "Sleep, gentle movement, anti-inflammatory eating, stress care. Small things, repeated.",
    why: "Why the boring stuff actually works",
    details: "Sleep, movement, anti-inflammatory eating and stress care don't sound like medicine, but they are: each one shifts the hormonal and inflammatory environment endo thrives in. Consistency beats intensity. Aim for 80% adherence rather than a perfect week followed by burnout.",
    icon: "🌿", type: "manual" },

  { id: "community", phase: "Live well",
    title: "Connect with the EndoMe community",
    desc: "Share your story with others who get it — when you're ready.",
    why: "Why community matters",
    details: "Endo is exhausting on its own. The community on EndoMe is people who already know what a flare feels like, who don't need it explained, and who have already tried the things you're about to try. You don't have to share everything. Even reading what other people are doing is enough to feel less alone.",
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

  // Test orders + results — drive each order_* and *_results story step.
  try {
    const cols = Object.values(TESTS).flatMap((t) => [t.orderedCol, t.resultsCol]);
    const u = await env.DB.prepare(
      `SELECT ${cols.join(", ")} FROM users WHERE id = ?`
    ).bind(user.id).first();
    for (const [id, t] of Object.entries(TESTS)) {
      if (u?.[t.orderedCol]) await markStoryStep(env, user.id, `order_${id}`,   "auto");
      if (u?.[t.resultsCol]) await markStoryStep(env, user.id, `${id}_results`, "auto");
    }
  } catch (err) {
    console.warn("reconcile test steps failed:", err?.message || err);
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
  // Be tolerant of a fresh DB where migration 0004 hasn't been applied:
  // if the insert fails because the table is missing, create it and retry
  // once. This makes the checklist "just work" for new installs.
  try {
    await insertStoryProgress(env, user, stepId);
  } catch (err) {
    const msg = String(err?.message || "");
    if (/no such table/i.test(msg)) {
      await ensureStoryTable(env);
      try {
        await insertStoryProgress(env, user, stepId);
      } catch (err2) {
        console.error("checkStory retry failed:", err2?.message || err2);
        return json({ error: "Couldn't save your checklist right now." }, 500);
      }
    } else {
      console.error("checkStory insert failed:", err?.message || err);
      return json({ error: "Couldn't save your checklist right now." }, 500);
    }
  }
  return getStory(env, user);
}

async function insertStoryProgress(env, user, stepId) {
  await env.DB.prepare(
    "INSERT INTO story_progress (user_id, step_id, completed_at, completed_by) " +
    "VALUES (?, ?, ?, 'manual') " +
    "ON CONFLICT(user_id, step_id) DO NOTHING"
  ).bind(user.id, stepId, nowSec()).run();
}

// Create the story_progress table if migration 0004 was never applied.
// Safe to call repeatedly.
async function ensureStoryTable(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS story_progress (" +
      "  user_id      TEXT    NOT NULL," +
      "  step_id      TEXT    NOT NULL," +
      "  completed_at INTEGER NOT NULL," +
      "  completed_by TEXT    NOT NULL DEFAULT 'manual'," +
      "  PRIMARY KEY (user_id, step_id)" +
      ")"
    ).run();
  } catch (err) {
    console.warn("ensureStoryTable failed:", err?.message || err);
  }
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

// --- Test order + results upload (generic across DNA / Bloods / Map) -----
async function postTestOrder(_request, env, user, testId) {
  if (!TEST_IDS.has(testId)) return json({ error: "Unknown test" }, 400);
  const t = TESTS[testId];
  const now = nowSec();
  await env.DB.prepare(
    `UPDATE users SET ${t.orderedCol} = COALESCE(${t.orderedCol}, ?) WHERE id = ?`
  ).bind(now, user.id).run();
  await markStoryStep(env, user.id, `order_${testId}`, "auto");
  return json({ ok: true, test: testId, ordered_at: now });
}

async function postTestResults(_request, env, user, testId) {
  if (!TEST_IDS.has(testId)) return json({ error: "Unknown test" }, 400);
  const t = TESTS[testId];
  const u = await env.DB.prepare(
    `SELECT ${t.orderedCol} AS ordered_at FROM users WHERE id = ?`
  ).bind(user.id).first();
  if (!u?.ordered_at) {
    return json({ error: `Order your ${t.name} test first.` }, 400);
  }
  const now = nowSec();
  await env.DB.prepare(
    `UPDATE users SET ${t.resultsCol} = COALESCE(${t.resultsCol}, ?) WHERE id = ?`
  ).bind(now, user.id).run();
  await markStoryStep(env, user.id, `${testId}_results`, "auto");
  return json({ ok: true, test: testId, results_at: now });
}

// --- Stripe Checkout for a specific test --------------------------------
// Creates a Stripe Checkout session and returns the URL the browser
// should redirect to. The actual order timestamp is set when the
// webhook fires (handleStripeWebhook → recordTestOrder).
async function postTestCheckout(env, user, testId) {
  if (!TEST_IDS.has(testId)) return json({ error: "Unknown test" }, 400);
  const t = TESTS[testId];

  const priceId = env[t.priceEnv];
  if (!priceId) {
    return json({
      error: `${t.name} pricing isn't configured yet — set ${t.priceEnv} in the Worker secrets.`,
    }, 503);
  }
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Payments aren't configured yet — set STRIPE_SECRET_KEY." }, 503);
  }

  // Pull the user's email so Stripe Checkout pre-fills + a receipt goes
  // to the right address.
  const userRow = await env.DB.prepare(
    "SELECT email FROM users WHERE id = ?"
  ).bind(user.id).first().catch(() => null);
  const email = userRow?.email || null;

  const siteUrl = (env.SITE_URL || "https://endome.com").replace(/\/$/, "");

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", `${siteUrl}/tests?checkout=success&test=${testId}&session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url",  `${siteUrl}/tests?checkout=cancelled&test=${testId}`);
  form.set("allow_promotion_codes", "true");
  form.set("billing_address_collection", "required");
  form.set("shipping_address_collection[allowed_countries][0]", "AU");
  form.set("shipping_address_collection[allowed_countries][1]", "NZ");
  form.set("client_reference_id", user.id);
  form.set("metadata[user_id]", user.id);
  form.set("metadata[test_id]", testId);
  if (email) form.set("customer_email", email);

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
    return json({ error: "Couldn't start checkout. Try again in a moment." }, 502);
  }
  const session = await res.json();
  return json({ ok: true, url: session.url });
}

// Internal: record a paid order against the user, mark the story step,
// and send the confirmation email. Idempotent.
async function recordTestOrder(env, userId, testId, customerEmail) {
  if (!TEST_IDS.has(testId)) return;
  const t = TESTS[testId];
  const now = nowSec();
  try {
    await env.DB.prepare(
      `UPDATE users SET ${t.orderedCol} = COALESCE(${t.orderedCol}, ?) WHERE id = ?`
    ).bind(now, userId).run();
  } catch (err) {
    console.error("recordTestOrder users update failed:", err?.message || err);
  }
  try {
    await env.DB.prepare(
      "INSERT INTO story_progress (user_id, step_id, completed_at, completed_by) " +
      "VALUES (?, ?, ?, 'auto') ON CONFLICT(user_id, step_id) DO NOTHING"
    ).bind(userId, `order_${testId}`, now).run();
  } catch (err) {
    console.error("recordTestOrder story update failed:", err?.message || err);
  }
  if (customerEmail) {
    await sendTestOrderEmail(env, customerEmail, t).catch((err) =>
      console.error("test order email failed:", err?.message || err)
    );
  }
}

async function sendTestOrderEmail(env, email, t) {
  if (!env.MANDRILL_API_KEY) return;
  const siteUrl = env.SITE_URL || "https://endome.com";
  const html = renderEmail({
    siteUrl,
    preheader: `${t.name} is on its way.`,
    headline: `${t.name} ordered ${t.icon}`,
    body: `
      <p style="margin:0 0 16px;color:#3a2330;font-size:16px;line-height:1.65">
        Your <strong style="color:#ff4e8a">${t.name}</strong> is on its way. We'll send another note when it ships, and again when it's time to upload your results.
      </p>
      <p style="margin:0 0 16px;color:#5a3a48;font-size:15px;line-height:1.6">
        While you wait, keep logging in EndoMe — the more your story builds, the more useful your results will be alongside it.
      </p>`,
    ctaText: "Track in your story",
    ctaUrl:  `${siteUrl}/story`,
  });
  const text =
    `${t.name} ordered\n\n` +
    `Your ${t.name} is on its way. We'll send another note when it ships, and again when it's time to upload your results.\n\n` +
    `${siteUrl}/story\n`;
  await mandrillSend(env, {
    to: [{ email, type: "to" }],
    subject: `${t.name} ordered ${t.icon}`,
    from_email: env.NEWSLETTER_FROM_EMAIL || FROM_EMAIL_DEFAULT,
    from_name:  env.NEWSLETTER_FROM_NAME || "EndoMe",
    headers: { "Reply-To": env.NOTIFY_EMAIL || FROM_EMAIL_DEFAULT },
    html, text,
  });
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
    colorSeed: pet.color_seed || 0,
    hasPoop: petHasPoop(pet),
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

// =============================================================================
// ENDOPET ECONOMY — Glow Points, lifecycle, regression, shop, inventory.
// All behaviour configuration-driven so it's easy to tune later.
// =============================================================================

const ENDOPET_STAGES = [
  { key: "egg",        label: "Glow Egg",         minLevel: 0,  minDays: 0,  copy: "Something gentle is growing." },
  { key: "hatchling",  label: "Dotling",          minLevel: 1,  minDays: 1,  copy: "Tiny bounces, big heart." },
  { key: "child",      label: "Sprout Sprite",    minLevel: 4,  minDays: 4,  copy: "Curious and collecting sparkles." },
  { key: "teen",       label: "Flare Companion",  minLevel: 8,  minDays: 8,  copy: "Expressive, loyal, learning their rhythms." },
  { key: "adult",      label: "Guardian Glowpet", minLevel: 16, minDays: 19, copy: "Celebrates patterns, brings tiny gifts." },
  { key: "elder",      label: "Wise Glowkeeper",  minLevel: 30, minDays: 46, copy: "Cosy, reflective, full of soft light." },
];

// Reward configs. xp powers levels (existing system), glow is the spendable
// currency. Keep modest and let the streak/repeat-day pattern win.
const ENDOPET_REWARDS = {
  morning_checkin:   { xp: 15, glow: 20, label: "Morning check-in" },
  evening_checkin:   { xp: 15, glow: 20, label: "Evening reflection" },
  symptom:           { xp: 25, glow: 30, label: "Symptom logged" },
  flare:             { xp: 20, glow: 25, label: "Flare logged" },
  // Backfill counts less. Note: not currently used (we don't allow editing
  // dates), but the field is here so it doesn't need refactoring later.
  backfill:          { xp: 8,  glow: 10, label: "Backfilled" },
};
const ENDOPET_DAILY_XP_CAP   = 100;
const ENDOPET_DAILY_GLOW_CAP = 120;
const ENDOPET_FIRST_LOG_BONUS = { xp: 10, glow: 15, label: "First log of the day" };

// Items: id → { name, category, price, rarity, icon, slot?, consumable?, equippable?, stageRequirement?, effect? }
const ENDOPET_ITEMS = {
  // --- Food (consumable, lifts nourishment + small comfort/joy) ---------
  moonberry_snack:   { name: "Moonberry Snack",    category: "food",   price: 30,  rarity: "common",   icon: "🫐", consumable: true, effect: { nourishment: 25, comfort: 5 } },
  ginger_biscuit:    { name: "Ginger Tea Biscuit", category: "food",   price: 35,  rarity: "common",   icon: "🍪", consumable: true, effect: { nourishment: 22, comfort: 10 } },
  cozy_soup:         { name: "Cozy Soup",          category: "food",   price: 50,  rarity: "uncommon", icon: "🍲", consumable: true, effect: { nourishment: 40, comfort: 15 } },
  starfruit_jelly:   { name: "Starfruit Jelly",    category: "food",   price: 75,  rarity: "uncommon", icon: "🟡", consumable: true, effect: { nourishment: 30, joy: 20 } },

  // --- Comfort (mix of consumable + permanent) --------------------------
  tiny_heat_pad:     { name: "Tiny Heat Pad",         category: "comfort", price: 90,  rarity: "uncommon", icon: "♨️",  consumable: false, equippable: true, slot: "wear_back" },
  cloud_blanket:     { name: "Cloud Blanket",         category: "comfort", price: 140, rarity: "rare",     icon: "☁️",  consumable: false, equippable: true, slot: "wear_back" },
  moon_pillow:       { name: "Moon Pillow",           category: "comfort", price: 70,  rarity: "common",   icon: "🌙",  consumable: false, equippable: true, slot: "decor_floor" },
  warm_bath_bubbles: { name: "Warm Bath Bubbles",     category: "comfort", price: 60,  rarity: "common",   icon: "🛁",  consumable: true, effect: { comfort: 30 } },

  // --- Toys --------------------------------------------------------------
  symptom_star_ball: { name: "Symptom Star Ball",     category: "toy",   price: 45,  rarity: "common",   icon: "⭐",  consumable: false, effect: { joy: 25 } },
  crinkle_leaf:      { name: "Crinkle Leaf",          category: "toy",   price: 30,  rarity: "common",   icon: "🍃",  consumable: false, effect: { joy: 15 } },
  bubble_wand:       { name: "Bubble Wand",           category: "toy",   price: 70,  rarity: "uncommon", icon: "🫧",  consumable: false, effect: { joy: 30 } },
  tiny_journal:      { name: "Tiny Journal",          category: "toy",   price: 90,  rarity: "uncommon", icon: "📓",  consumable: false, effect: { joy: 20, sparkle: 10 } },

  // --- Decor (room background) ------------------------------------------
  lavender_lamp:     { name: "Lavender Lamp",         category: "decor", price: 110, rarity: "uncommon", icon: "💡",  consumable: false, equippable: true, slot: "decor_light" },
  cloud_rug:         { name: "Cloud Rug",             category: "decor", price: 85,  rarity: "common",   icon: "☁️",  consumable: false, equippable: true, slot: "decor_floor" },
  moon_window:       { name: "Moon Window",           category: "decor", price: 180, rarity: "rare",     icon: "🪟",  consumable: false, equippable: true, slot: "decor_wall" },
  herbal_shelf:      { name: "Herbal Shelf",          category: "decor", price: 140, rarity: "uncommon", icon: "🪴",  consumable: false, equippable: true, slot: "decor_shelf" },
  stardust_paper:    { name: "Stardust Wallpaper",    category: "decor", price: 230, rarity: "rare",     icon: "🌌",  consumable: false, equippable: true, slot: "decor_wall" },

  // --- Wearables (pet display) ------------------------------------------
  tiny_scarf:        { name: "Tiny Scarf",            category: "wear",  price: 80,  rarity: "common",   icon: "🧣",  consumable: false, equippable: true, slot: "wear_neck" },
  sleepy_beanie:     { name: "Sleepy Beanie",         category: "wear",  price: 100, rarity: "uncommon", icon: "🎀",  consumable: false, equippable: true, slot: "wear_head" },
  star_cape:         { name: "Star Cape",             category: "wear",  price: 180, rarity: "rare",     icon: "✨",  consumable: false, equippable: true, slot: "wear_back", stageRequirement: 3 },
  warrior_ribbon:    { name: "Warrior Ribbon",        category: "wear",  price: 200, rarity: "rare",     icon: "🎗️",  consumable: false, equippable: true, slot: "wear_head", stageRequirement: 3 },

  // --- Special -----------------------------------------------------------
  flare_care_kit:    { name: "Flare Care Kit",        category: "special", price: 300, rarity: "rare",      icon: "🎁",  consumable: true, effect: { comfort: 50, energy: 30 } },
  memory_seed:       { name: "Memory Seed",           category: "special", price: 500, rarity: "legendary", icon: "🌱",  consumable: false, equippable: true, slot: "decor_shelf", stageRequirement: 4 },
  legacy_lantern:    { name: "Legacy Lantern",        category: "special", price: 750, rarity: "legendary", icon: "🏮",  consumable: false, equippable: true, slot: "decor_light", stageRequirement: 5 },
  mini_companion:    { name: "Mini Companion Plush",  category: "special", price: 400, rarity: "rare",      icon: "🧸",  consumable: false, equippable: true, slot: "decor_friend" },
};
const ENDOPET_ITEM_KEYS = new Set(Object.keys(ENDOPET_ITEMS));

// Lifecycle ---------------------------------------------------------------
function endopetBaseStageIndex(level, distinctDays) {
  let idx = 0;
  for (let i = 0; i < ENDOPET_STAGES.length; i++) {
    if (level >= ENDOPET_STAGES[i].minLevel && distinctDays >= ENDOPET_STAGES[i].minDays) {
      idx = i;
    }
  }
  return idx;
}

// Regression returns how many stages we should shift DOWN from the base.
// 0 for the first 14 days of absence (the pet just gets sleepy / cocoons in
// its current stage); each subsequent 14-day window removes one stage.
function endopetRegressionLevels(pet) {
  const now = nowSec();
  if (pet.rest_mode_until && pet.rest_mode_until > now) return 0;
  if (!pet.last_meaningful_log_at) return 0;
  const days = (now - pet.last_meaningful_log_at) / 86400;
  if (days < 14) return 0;
  return Math.min(ENDOPET_STAGES.length - 1, Math.floor((days - 14) / 14) + 1);
}

function endopetEffectiveStage(pet) {
  const baseIdx = endopetBaseStageIndex(pet.level || 0, pet.distinct_log_days || 0);
  const regress = endopetRegressionLevels(pet);
  const idx = Math.max(0, baseIdx - regress);
  return { stage: ENDOPET_STAGES[idx], baseIdx, idx, regress };
}

// Mood derives from happiness / activity / rest mode / regression.
function endopetMood(pet) {
  const now = nowSec();
  if (pet.rest_mode_until && pet.rest_mode_until > now) return "cosy";
  const daysSince = pet.last_meaningful_log_at ? (now - pet.last_meaningful_log_at) / 86400 : 0;
  if (daysSince >= 14) return "cocooning";
  if (daysSince >= 3) return "sleepy";
  if ((pet.happiness || 0) >= 80) return "sparkly";
  if ((pet.happiness || 0) >= 60) return "celebrating";
  if ((pet.happiness || 0) < 35) return "sleepy";
  return "curious";
}

// =============================================================================
// REWARD LEDGER — idempotent point grants
// =============================================================================
async function endopetGrantReward(env, userId, sourceType, sourceId, opts = {}) {
  const cfg = ENDOPET_REWARDS[sourceType];
  if (!cfg) return null;
  const now = nowSec();

  // Idempotency check — ledger has UNIQUE(user_id, source_type, source_id).
  try {
    const existing = await env.DB.prepare(
      "SELECT 1 FROM endopet_reward_ledger WHERE user_id = ? AND source_type = ? AND source_id = ?"
    ).bind(userId, sourceType, String(sourceId)).first();
    if (existing) return null;
  } catch (err) {
    // Ledger table missing? Skip silently — we'll grant nothing rather than
    // double-award later when the migration arrives.
    console.warn("endopet ledger lookup failed:", err?.message || err);
    return null;
  }

  // Daily cap check
  const localDate = new Date().toISOString().slice(0, 10);
  const todayStart = Math.floor(Date.parse(`${localDate}T00:00:00Z`) / 1000);
  const todayTotal = await env.DB.prepare(
    "SELECT COALESCE(SUM(xp_awarded),0) AS x, COALESCE(SUM(glow_awarded),0) AS g, COUNT(*) AS n " +
    "FROM endopet_reward_ledger WHERE user_id = ? AND created_at >= ?"
  ).bind(userId, todayStart).first().catch(() => ({ x: 0, g: 0, n: 0 }));

  const xpRoom   = Math.max(0, ENDOPET_DAILY_XP_CAP   - (todayTotal.x || 0));
  const glowRoom = Math.max(0, ENDOPET_DAILY_GLOW_CAP - (todayTotal.g || 0));
  let xpAward   = Math.min(cfg.xp,   xpRoom);
  let glowAward = Math.min(cfg.glow, glowRoom);

  // First-log-of-day bonus, applied IN ADDITION to the regular reward.
  let firstLogBonus = false;
  if ((todayTotal.n || 0) === 0) {
    xpAward   += Math.min(ENDOPET_FIRST_LOG_BONUS.xp,   Math.max(0, xpRoom   - xpAward));
    glowAward += Math.min(ENDOPET_FIRST_LOG_BONUS.glow, Math.max(0, glowRoom - glowAward));
    firstLogBonus = true;
  }

  if (xpAward === 0 && glowAward === 0) return null;

  // Welcome-back bonus on returning after 3+ / 7+ days
  let welcomeBack = 0;
  try {
    const pet = await env.DB.prepare("SELECT last_meaningful_log_at FROM pets WHERE user_id = ?")
      .bind(userId).first();
    if (pet?.last_meaningful_log_at) {
      const daysGone = (now - pet.last_meaningful_log_at) / 86400;
      if (daysGone >= 7) welcomeBack = 40;
      else if (daysGone >= 3) welcomeBack = 20;
    }
  } catch {}
  if (welcomeBack > 0) glowAward += welcomeBack;

  // Persist ledger entry FIRST so we never double-grant on retries.
  try {
    await env.DB.prepare(
      "INSERT INTO endopet_reward_ledger (user_id, source_type, source_id, xp_awarded, glow_awarded, reason, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      userId, sourceType, String(sourceId),
      xpAward, glowAward,
      cfg.label + (firstLogBonus ? " + first-log bonus" : "") + (welcomeBack > 0 ? " + welcome back" : ""),
      now
    ).run();
  } catch (err) {
    // UNIQUE violation? Means another concurrent request already inserted.
    console.warn("endopet ledger insert failed:", err?.message || err);
    return null;
  }

  // Update pet: glow_points + last_meaningful_log_at + distinct_log_days.
  // distinct_log_days only ticks when this is the first reward of a new day.
  try {
    const incDay = (todayTotal.n || 0) === 0 ? 1 : 0;
    await env.DB.prepare(
      "UPDATE pets SET " +
      "  glow_points = COALESCE(glow_points,0) + ?, " +
      "  last_meaningful_log_at = ?, " +
      "  distinct_log_days = COALESCE(distinct_log_days,0) + ? " +
      "WHERE user_id = ?"
    ).bind(glowAward, now, incDay, userId).run();
  } catch (err) {
    console.warn("endopet pet update failed:", err?.message || err);
  }

  return { xpAward, glowAward, firstLogBonus, welcomeBack };
}

// =============================================================================
// SHOP / INVENTORY / REST MODE
// =============================================================================
async function getEndopetShop(env, user) {
  // Pet is needed to know what's locked by stage.
  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?").bind(user.id).first();
  const { idx: stageIdx } = endopetEffectiveStage(pet || {});
  // Inventory keys we already own.
  let owned = new Set();
  let equipped = new Set();
  try {
    const inv = await env.DB.prepare(
      "SELECT item_key, quantity, equipped FROM endopet_inventory WHERE user_id = ?"
    ).bind(user.id).all();
    for (const row of inv.results || []) {
      if ((row.quantity || 0) > 0) owned.add(row.item_key);
      if (row.equipped) equipped.add(row.item_key);
    }
  } catch (err) {
    console.warn("endopet inventory lookup failed:", err?.message || err);
  }

  const items = Object.entries(ENDOPET_ITEMS).map(([key, def]) => ({
    key,
    ...def,
    locked: (def.stageRequirement || 0) > stageIdx,
    owned: owned.has(key),
    equipped: equipped.has(key),
  }));
  return json({
    glowPoints: pet?.glow_points || 0,
    stageIdx,
    items,
  });
}

async function postEndopetBuy(request, env, user) {
  const body = await readJsonSafe(request);
  const itemKey = typeof body?.itemKey === "string" ? body.itemKey : null;
  if (!itemKey || !ENDOPET_ITEM_KEYS.has(itemKey)) {
    return json({ error: "Unknown item" }, 400);
  }
  const item = ENDOPET_ITEMS[itemKey];

  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?").bind(user.id).first();
  if (!pet) return json({ error: "No pet" }, 404);

  const { idx: stageIdx } = endopetEffectiveStage(pet);
  if ((item.stageRequirement || 0) > stageIdx) {
    return json({ error: `Unlocks at ${ENDOPET_STAGES[item.stageRequirement]?.label || "a later stage"}.` }, 400);
  }
  if ((pet.glow_points || 0) < item.price) {
    return json({ error: "Not enough Glow Points yet." }, 400);
  }

  const now = nowSec();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE pets SET glow_points = COALESCE(glow_points,0) - ? WHERE user_id = ?"
      ).bind(item.price, user.id),
      env.DB.prepare(
        "INSERT INTO endopet_inventory (user_id, item_key, quantity, acquired_at) " +
        "VALUES (?, ?, 1, ?) " +
        "ON CONFLICT(user_id, item_key) DO UPDATE SET quantity = quantity + 1"
      ).bind(user.id, itemKey, now),
    ]);
  } catch (err) {
    console.error("endopet buy failed:", err?.message || err);
    return json({ error: "Couldn't complete the purchase." }, 500);
  }

  await endopetRunAllChecks(env, user.id);
  return getEndopetState(env, user);
}

async function postEndopetEquip(request, env, user) {
  const body = await readJsonSafe(request);
  const itemKey = typeof body?.itemKey === "string" ? body.itemKey : null;
  if (!itemKey || !ENDOPET_ITEM_KEYS.has(itemKey)) {
    return json({ error: "Unknown item" }, 400);
  }
  const item = ENDOPET_ITEMS[itemKey];
  if (!item.equippable) return json({ error: "This item isn't equippable." }, 400);

  // Confirm owned
  const inv = await env.DB.prepare(
    "SELECT quantity, equipped FROM endopet_inventory WHERE user_id = ? AND item_key = ?"
  ).bind(user.id, itemKey).first();
  if (!inv || (inv.quantity || 0) === 0) {
    return json({ error: "You don't own this item." }, 400);
  }

  const willEquip = !inv.equipped;
  try {
    if (willEquip && item.slot) {
      // Unequip anything else in the same slot first.
      const sameSlotKeys = Object.entries(ENDOPET_ITEMS)
        .filter(([_, def]) => def.slot === item.slot)
        .map(([k]) => k);
      if (sameSlotKeys.length > 0) {
        const placeholders = sameSlotKeys.map(() => "?").join(",");
        await env.DB.prepare(
          `UPDATE endopet_inventory SET equipped = 0 WHERE user_id = ? AND item_key IN (${placeholders})`
        ).bind(user.id, ...sameSlotKeys).run();
      }
    }
    await env.DB.prepare(
      "UPDATE endopet_inventory SET equipped = ? WHERE user_id = ? AND item_key = ?"
    ).bind(willEquip ? 1 : 0, user.id, itemKey).run();
  } catch (err) {
    console.error("endopet equip failed:", err?.message || err);
    return json({ error: "Couldn't equip the item." }, 500);
  }

  return getEndopetState(env, user);
}

async function postEndopetUse(request, env, user) {
  const body = await readJsonSafe(request);
  const itemKey = typeof body?.itemKey === "string" ? body.itemKey : null;
  if (!itemKey || !ENDOPET_ITEM_KEYS.has(itemKey)) {
    return json({ error: "Unknown item" }, 400);
  }
  const item = ENDOPET_ITEMS[itemKey];
  if (!item.consumable) return json({ error: "This item isn't consumable." }, 400);

  const inv = await env.DB.prepare(
    "SELECT quantity FROM endopet_inventory WHERE user_id = ? AND item_key = ?"
  ).bind(user.id, itemKey).first();
  if (!inv || (inv.quantity || 0) < 1) return json({ error: "You're out of this item." }, 400);

  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?").bind(user.id).first();
  if (!pet) return json({ error: "No pet" }, 404);

  const eff = item.effect || {};
  const newHappy   = Math.max(0, Math.min(100, (pet.happiness || 100) + (eff.joy || 0) + (eff.comfort || 0)));
  const newHunger  = Math.max(0, Math.min(100, (pet.hunger || 0)   - (eff.nourishment || 0)));
  const now = nowSec();

  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE endopet_inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_key = ?"
      ).bind(user.id, itemKey),
      env.DB.prepare(
        "UPDATE pets SET happiness = ?, hunger = ?, last_fed_at = ?, last_played_at = ?, updated_at = ? WHERE user_id = ?"
      ).bind(newHappy, newHunger, eff.nourishment ? now : pet.last_fed_at, eff.joy ? now : pet.last_played_at, now, user.id),
    ]);
  } catch (err) {
    console.error("endopet use failed:", err?.message || err);
    return json({ error: "Couldn't use the item." }, 500);
  }

  return getEndopetState(env, user);
}

async function postEndopetRest(request, env, user) {
  const body = await readJsonSafe(request);
  const days = clampInt(body?.days, 1, 7) || 1;
  const until = nowSec() + days * 86400;
  try {
    await env.DB.prepare(
      "UPDATE pets SET rest_mode_until = ?, updated_at = ? WHERE user_id = ?"
    ).bind(until, nowSec(), user.id).run();
  } catch (err) {
    console.error("endopet rest failed:", err?.message || err);
    return json({ error: "Couldn't activate Rest Mode." }, 500);
  }
  await endopetRunAllChecks(env, user.id, { restActivated: true });
  return getEndopetState(env, user);
}

async function postEndopetRestEnd(_request, env, user) {
  try {
    await env.DB.prepare("UPDATE pets SET rest_mode_until = NULL WHERE user_id = ?").bind(user.id).run();
  } catch {}
  return getEndopetState(env, user);
}

// Aggregate state: pet + inventory + recent rewards. Used by /pet page.
async function getEndopetState(env, user) {
  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?").bind(user.id).first();
  if (!pet) return json({ error: "No pet" }, 404);

  let inv = { results: [] };
  try {
    inv = await env.DB.prepare(
      "SELECT item_key, quantity, equipped, acquired_at FROM endopet_inventory WHERE user_id = ? ORDER BY acquired_at DESC"
    ).bind(user.id).all();
  } catch {}

  let recentLedger = { results: [] };
  try {
    recentLedger = await env.DB.prepare(
      "SELECT source_type, xp_awarded, glow_awarded, reason, created_at FROM endopet_reward_ledger " +
      "WHERE user_id = ? ORDER BY created_at DESC LIMIT 12"
    ).bind(user.id).all();
  } catch {}

  // Achievements (unlocked vs locked) + quest progress are computed here
  // so the pet page just consumes them.
  let unlockedAch = new Set();
  try {
    const rows = await env.DB.prepare(
      "SELECT achievement_key, unlocked_at FROM endopet_achievements WHERE user_id = ?"
    ).bind(user.id).all();
    unlockedAch = new Map((rows.results || []).map((r) => [r.achievement_key, r.unlocked_at]));
  } catch {}
  const achievements = Object.entries(ACHIEVEMENTS).map(([key, def]) => ({
    key, name: def.name, icon: def.icon, desc: def.desc, reward: def.reward || 0,
    unlocked: unlockedAch instanceof Map ? unlockedAch.has(key) : false,
    unlockedAt: unlockedAch instanceof Map ? (unlockedAch.get(key) || null) : null,
  }));

  let questCompletions = new Set();
  try {
    const todayPeriod = periodDaily();
    const weekPeriod  = periodWeekly();
    const rows = await env.DB.prepare(
      "SELECT quest_key, period FROM endopet_quest_completions WHERE user_id = ? AND period IN (?, ?)"
    ).bind(user.id, todayPeriod, weekPeriod).all();
    questCompletions = new Set((rows.results || []).map((r) => `${r.quest_key}:${r.period}`));
  } catch {}

  async function questBlock(defs, period) {
    const out = [];
    for (const [key, def] of Object.entries(defs)) {
      let p = { current: 0, target: 1 };
      try { p = await def.progress(env, user.id); } catch {}
      out.push({
        key, name: def.name, icon: def.icon, desc: def.desc, reward: def.reward,
        current: Math.min(p.current, p.target),
        target:  p.target,
        completed: questCompletions.has(`${key}:${period}`) || p.current >= p.target,
      });
    }
    return out;
  }
  const dailyQuests  = await questBlock(DAILY_QUESTS,  periodDaily());
  const weeklyQuests = await questBlock(WEEKLY_QUESTS, periodWeekly());

  const inventory = (inv.results || []).map((row) => ({
    key: row.item_key,
    quantity: row.quantity,
    equipped: !!row.equipped,
    acquiredAt: row.acquired_at,
    item: ENDOPET_ITEMS[row.item_key] || { name: row.item_key, icon: "?" },
  }));

  const eff = endopetEffectiveStage(pet);
  const nextIdx = Math.min(ENDOPET_STAGES.length - 1, eff.baseIdx + 1);
  const nextStage = ENDOPET_STAGES[nextIdx];
  const now = nowSec();
  const restActive = !!(pet.rest_mode_until && pet.rest_mode_until > now);

  return json({
    pet: {
      ...petFullResponse(pet),
      glowPoints: pet.glow_points || 0,
      distinctLogDays: pet.distinct_log_days || 0,
      lastMeaningfulLogAt: pet.last_meaningful_log_at || null,
      stageKey:   eff.stage.key,
      stageLabel: eff.stage.label,
      stageCopy:  eff.stage.copy,
      stageIdx:   eff.idx,
      baseStageIdx: eff.baseIdx,
      regressionLevels: eff.regress,
      mood: endopetMood(pet),
      restModeUntil: pet.rest_mode_until || null,
      restActive,
      nextStageLabel: nextStage.label,
      nextStageMinLevel: nextStage.minLevel,
      nextStageMinDays:  nextStage.minDays,
    },
    inventory,
    recentRewards: (recentLedger.results || []).map((r) => ({
      sourceType: r.source_type, xp: r.xp_awarded, glow: r.glow_awarded, reason: r.reason, at: r.created_at,
    })),
    achievements,
    dailyQuests,
    weeklyQuests,
    stages: ENDOPET_STAGES.map((s) => ({ key: s.key, label: s.label, minLevel: s.minLevel, minDays: s.minDays })),
  });
}

// =============================================================================
// ACHIEVEMENTS — milestone badges that unlock once and pay out Glow Points
// =============================================================================

const ACHIEVEMENTS = {
  first_hatch: {
    name: "First Hatch", icon: "🥚",
    desc: "Your tiny companion stepped out of their shell.",
    reward: 30,
    check: async (env, userId, pet) => !!pet?.hatched_at,
  },
  five_logs: {
    name: "Five Gentle Check-ins", icon: "🌸",
    desc: "Logged on five different days.",
    reward: 50,
    check: async (env, userId, pet) => (pet?.distinct_log_days || 0) >= 5,
  },
  pattern_finder: {
    name: "Pattern Finder", icon: "🔍",
    desc: "Logged on 14 different days in a single month.",
    reward: 100,
    check: async (env, userId) => {
      try {
        const monthStart = new Date();
        monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
        const start = Math.floor(monthStart.getTime() / 1000);
        const row = await env.DB.prepare(
          "SELECT COUNT(DISTINCT date(created_at,'unixepoch')) AS d " +
          "FROM endopet_reward_ledger WHERE user_id = ? AND created_at >= ?"
        ).bind(userId, start).first();
        return (row?.d || 0) >= 14;
      } catch { return false; }
    },
  },
  flare_buddy: {
    name: "Flare Buddy", icon: "🤗",
    desc: "Logged a flare and let your pet care for you.",
    reward: 40,
    check: async (env, userId, pet) => {
      try {
        const flare = await env.DB.prepare(
          "SELECT 1 FROM endopet_reward_ledger WHERE user_id = ? AND source_type = 'flare' LIMIT 1"
        ).bind(userId).first();
        return !!flare && !!pet?.rest_mode_until;
      } catch { return false; }
    },
  },
  rest_is_care: {
    name: "Rest Is Care", icon: "🌙",
    desc: "Activated Rest Mode when you needed softness.",
    reward: 30,
    check: async (env, userId, pet, ctx) => ctx?.restActivated === true || !!pet?.rest_mode_until,
  },
  welcome_back: {
    name: "Welcome Back", icon: "💖",
    desc: "Returned to your pet after time away.",
    reward: 50,
    check: async (env, userId, pet, ctx) => (ctx?.welcomeBack || 0) >= 40,
  },
  cozy_collector: {
    name: "Cozy Collector", icon: "🎒",
    desc: "Gathered 10 items in your stash.",
    reward: 75,
    check: async (env, userId) => {
      try {
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM endopet_inventory WHERE user_id = ? AND quantity > 0"
        ).bind(userId).first();
        return (row?.n || 0) >= 10;
      } catch { return false; }
    },
  },
  moon_garden: {
    name: "Moon Garden", icon: "🪴",
    desc: "Unlocked three decor items for the room.",
    reward: 75,
    check: async (env, userId) => {
      try {
        const decorKeys = Object.entries(ENDOPET_ITEMS)
          .filter(([_, def]) => def.category === "decor").map(([k]) => k);
        if (!decorKeys.length) return false;
        const placeholders = decorKeys.map(() => "?").join(",");
        const row = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM endopet_inventory WHERE user_id = ? AND quantity > 0 AND item_key IN (${placeholders})`
        ).bind(userId, ...decorKeys).first();
        return (row?.n || 0) >= 3;
      } catch { return false; }
    },
  },
  tiny_archivist: {
    name: "Tiny Archivist", icon: "📓",
    desc: "Added notes to 10 logs.",
    reward: 100,
    check: async (env, userId) => {
      try {
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM symptoms WHERE user_id = ? AND notes IS NOT NULL AND LENGTH(notes) > 0"
        ).bind(userId).first();
        return (row?.n || 0) >= 10;
      } catch { return false; }
    },
  },
  elder_glow: {
    name: "Elder Glow", icon: "✨",
    desc: "Reached the Wise Glowkeeper stage.",
    reward: 200,
    check: async (env, userId, pet) => {
      const stageIdx = endopetBaseStageIndex(pet?.level || 0, pet?.distinct_log_days || 0);
      return stageIdx >= 5;
    },
  },
};

async function endopetCheckAchievements(env, userId, ctx = {}) {
  let already = new Set();
  try {
    const rows = await env.DB.prepare(
      "SELECT achievement_key FROM endopet_achievements WHERE user_id = ?"
    ).bind(userId).all();
    already = new Set((rows.results || []).map((r) => r.achievement_key));
  } catch { return []; }

  const pet = await env.DB.prepare("SELECT * FROM pets WHERE user_id = ?")
    .bind(userId).first().catch(() => null);

  const newly = [];
  for (const [key, def] of Object.entries(ACHIEVEMENTS)) {
    if (already.has(key)) continue;
    let met = false;
    try { met = await def.check(env, userId, pet, ctx); } catch { met = false; }
    if (!met) continue;

    try {
      await env.DB.prepare(
        "INSERT INTO endopet_achievements (user_id, achievement_key, unlocked_at, glow_reward) " +
        "VALUES (?, ?, ?, ?) ON CONFLICT(user_id, achievement_key) DO NOTHING"
      ).bind(userId, key, nowSec(), def.reward || 0).run();
      if (def.reward) {
        await env.DB.prepare(
          "UPDATE pets SET glow_points = COALESCE(glow_points,0) + ? WHERE user_id = ?"
        ).bind(def.reward, userId).run();
      }
      newly.push({ key, ...def });
    } catch (err) {
      console.warn("endopet ach insert failed:", err?.message || err);
    }
  }
  return newly;
}

// =============================================================================
// QUESTS — daily & weekly, auto-claimed when conditions met
// =============================================================================

function periodDaily()  { return new Date().toISOString().slice(0, 10); }   // YYYY-MM-DD
function periodWeekly() {
  // ISO-ish week stamp YYYY-Www based on UTC.
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  // Move to Thursday of this week (ISO week pivots there) so year boundaries work.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d - start) / 86400000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
function weekStartTs() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return Math.floor(d.getTime() / 1000);
}
function dayStartTs() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

const DAILY_QUESTS = {
  daily_checkin: {
    name: "Gentle check-in", icon: "🌅", reward: 25,
    desc: "Do one morning or evening check-in today.",
    progress: async (env, userId) => {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM endopet_reward_ledger WHERE user_id = ? AND created_at >= ? AND source_type IN ('morning_checkin','evening_checkin')"
      ).bind(userId, dayStartTs()).first().catch(() => null);
      return { current: row?.n || 0, target: 1 };
    },
  },
  daily_log_anything: {
    name: "Log something soft", icon: "📝", reward: 20,
    desc: "Log any symptom today.",
    progress: async (env, userId) => {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM endopet_reward_ledger WHERE user_id = ? AND created_at >= ? AND source_type IN ('symptom','flare')"
      ).bind(userId, dayStartTs()).first().catch(() => null);
      return { current: row?.n || 0, target: 1 };
    },
  },
  daily_pet_love: {
    name: "Give your pet love", icon: "💖", reward: 20,
    desc: "Feed, play with, or pat your pet today.",
    progress: async (env, userId) => {
      const ds = dayStartTs();
      const pet = await env.DB.prepare(
        "SELECT last_fed_at, last_played_at FROM pets WHERE user_id = ?"
      ).bind(userId).first().catch(() => null);
      const today =
        ((pet?.last_fed_at    || 0) >= ds ? 1 : 0) +
        ((pet?.last_played_at || 0) >= ds ? 1 : 0);
      return { current: Math.min(today, 1), target: 1 };
    },
  },
};

const WEEKLY_QUESTS = {
  weekly_five_days: {
    name: "Five different days", icon: "📅", reward: 75,
    desc: "Check in on five distinct days this week.",
    progress: async (env, userId) => {
      const row = await env.DB.prepare(
        "SELECT COUNT(DISTINCT date(created_at,'unixepoch')) AS d FROM endopet_reward_ledger WHERE user_id = ? AND created_at >= ?"
      ).bind(userId, weekStartTs()).first().catch(() => null);
      return { current: row?.d || 0, target: 5 };
    },
  },
  weekly_morning: {
    name: "Three morning check-ins", icon: "☀️", reward: 50,
    desc: "Morning check-in three times this week.",
    progress: async (env, userId) => {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM endopet_reward_ledger WHERE user_id = ? AND created_at >= ? AND source_type = 'morning_checkin'"
      ).bind(userId, weekStartTs()).first().catch(() => null);
      return { current: row?.n || 0, target: 3 };
    },
  },
  weekly_one_note: {
    name: "One note for future-you", icon: "📓", reward: 40,
    desc: "Add a note to one symptom log this week.",
    progress: async (env, userId) => {
      const ws = weekStartTs();
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM symptoms WHERE user_id = ? AND logged_at >= ? AND notes IS NOT NULL AND LENGTH(notes) > 0"
      ).bind(userId, ws).first().catch(() => null);
      return { current: row?.n || 0, target: 1 };
    },
  },
};

async function endopetCheckQuests(env, userId) {
  const today = periodDaily();
  const thisWeek = periodWeekly();
  const newly = [];

  for (const [key, def] of Object.entries(DAILY_QUESTS)) {
    const p = await def.progress(env, userId);
    if (p.current >= p.target) {
      const inserted = await tryCompleteQuest(env, userId, key, today, def.reward);
      if (inserted) newly.push({ key, name: def.name, icon: def.icon, reward: def.reward, kind: "daily" });
    }
  }
  for (const [key, def] of Object.entries(WEEKLY_QUESTS)) {
    const p = await def.progress(env, userId);
    if (p.current >= p.target) {
      const inserted = await tryCompleteQuest(env, userId, key, thisWeek, def.reward);
      if (inserted) newly.push({ key, name: def.name, icon: def.icon, reward: def.reward, kind: "weekly" });
    }
  }
  return newly;
}

async function tryCompleteQuest(env, userId, key, period, reward) {
  try {
    const existing = await env.DB.prepare(
      "SELECT 1 FROM endopet_quest_completions WHERE user_id = ? AND quest_key = ? AND period = ?"
    ).bind(userId, key, period).first();
    if (existing) return false;
    await env.DB.prepare(
      "INSERT INTO endopet_quest_completions (user_id, quest_key, period, completed_at, glow_reward) " +
      "VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, quest_key, period) DO NOTHING"
    ).bind(userId, key, period, nowSec(), reward || 0).run();
    if (reward) {
      await env.DB.prepare(
        "UPDATE pets SET glow_points = COALESCE(glow_points,0) + ? WHERE user_id = ?"
      ).bind(reward, userId).run();
    }
    return true;
  } catch (err) {
    console.warn("quest complete failed:", err?.message || err);
    return false;
  }
}

// Convenience: run both checks together. Returns combined newly-unlocked list.
async function endopetRunAllChecks(env, userId, ctx = {}) {
  const ach = await endopetCheckAchievements(env, userId, ctx).catch(() => []);
  const qst = await endopetCheckQuests(env, userId).catch(() => []);
  return { achievements: ach, quests: qst };
}

// =============================================================================
// COMMUNITY — Support Circles, posts, replies, reactions, member tiers.
// =============================================================================

// Tier thresholds based on distinct logged days. Easy to tune later.
// Tier thresholds based on distinct logged days. Tiers are still surfaced in
// the UI for status, but circle creation is open to everyone — newbies
// included. We cap how many an individual can create below (see
// MAX_CIRCLES_PER_USER) to prevent runaway spam.
const COMMUNITY_TIERS = [
  { key: "newcomer", label: "Newcomer", minDays: 0,  canCreateCircle: true },
  { key: "active",   label: "Active",   minDays: 7,  canCreateCircle: true },
  { key: "trusted",  label: "Trusted",  minDays: 30, canCreateCircle: true },
];
const MAX_CIRCLES_PER_USER = 5;

function communityTier(pet) {
  const days = pet?.distinct_log_days || 0;
  let tier = COMMUNITY_TIERS[0];
  for (const t of COMMUNITY_TIERS) if (days >= t.minDays) tier = t;
  return { ...tier, distinctLogDays: days };
}

function communityNextTier(currentKey) {
  const idx = COMMUNITY_TIERS.findIndex((t) => t.key === currentKey);
  return idx >= 0 && idx < COMMUNITY_TIERS.length - 1 ? COMMUNITY_TIERS[idx + 1] : null;
}

// Generate a URL-safe slug. Falls back to "circle" if name has no letters.
function communitySlug(name) {
  const base = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return base || "circle";
}

async function communityFindFreeSlug(env, base) {
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const row = await env.DB.prepare("SELECT 1 FROM circles WHERE slug = ?")
      .bind(candidate).first();
    if (!row) return candidate;
  }
  return `${base}-${Math.floor(Math.random() * 100000)}`;
}

// Ensure the official EndoMe circle exists. Idempotent.
// Best-effort schema bootstrap for the five community tables. SQLite has no
// IF NOT EXISTS for ADD COLUMN but every statement below is CREATE TABLE
// IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so this is safe to call on
// every request. Runs once per worker boot.
let _communitySchemaChecked = false;
async function ensureCommunitySchema(env) {
  if (_communitySchemaChecked) return;
  _communitySchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS circles (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  slug TEXT NOT NULL UNIQUE," +
    "  name TEXT NOT NULL," +
    "  description TEXT," +
    "  creator_user_id TEXT," +
    "  is_official INTEGER NOT NULL DEFAULT 0," +
    "  is_open INTEGER NOT NULL DEFAULT 1," +
    "  created_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_circles_official ON circles(is_official, created_at DESC)",
    "CREATE TABLE IF NOT EXISTS circle_members (" +
    "  circle_id INTEGER NOT NULL," +
    "  user_id TEXT NOT NULL," +
    "  role TEXT NOT NULL DEFAULT 'member'," +
    "  joined_at INTEGER NOT NULL," +
    "  PRIMARY KEY (circle_id, user_id)" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_circle_members_user ON circle_members(user_id)",
    "CREATE TABLE IF NOT EXISTS circle_posts (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  circle_id INTEGER NOT NULL," +
    "  user_id TEXT NOT NULL," +
    "  body TEXT NOT NULL," +
    "  is_question INTEGER NOT NULL DEFAULT 0," +
    "  created_at INTEGER NOT NULL," +
    "  updated_at INTEGER NOT NULL," +
    "  deleted_at INTEGER" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_circle_posts_circle_recent ON circle_posts(circle_id, created_at DESC)",
    "CREATE TABLE IF NOT EXISTS circle_replies (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  post_id INTEGER NOT NULL," +
    "  user_id TEXT NOT NULL," +
    "  body TEXT NOT NULL," +
    "  parent_reply_id INTEGER," +
    "  created_at INTEGER NOT NULL," +
    "  deleted_at INTEGER" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_circle_replies_post ON circle_replies(post_id, created_at)",
    "CREATE TABLE IF NOT EXISTS circle_reactions (" +
    "  target_type TEXT NOT NULL," +
    "  target_id INTEGER NOT NULL," +
    "  user_id TEXT NOT NULL," +
    "  reaction TEXT NOT NULL DEFAULT 'heart'," +
    "  created_at INTEGER NOT NULL," +
    "  PRIMARY KEY (target_type, target_id, user_id, reaction)" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_circle_reactions_target ON circle_reactions(target_type, target_id)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch (err) {
    console.warn("ensureCommunitySchema stmt failed:", err?.message || err);
  } }
}

async function ensureOfficialCircle(env) {
  await ensureCommunitySchema(env);
  try {
    const existing = await env.DB.prepare(
      "SELECT id FROM circles WHERE slug = 'endome' LIMIT 1"
    ).first();
    if (existing) return existing.id;

    const adminUser = await env.DB.prepare(
      "SELECT id FROM users WHERE username = ? LIMIT 1"
    ).bind((env.AUTH_USERNAME || "endome").toLowerCase()).first().catch(() => null);

    const now = nowSec();
    const res = await env.DB.prepare(
      "INSERT INTO circles (slug, name, description, creator_user_id, is_official, is_open, created_at) " +
      "VALUES ('endome', 'EndoMe', " +
      "'The home for everyone here. Share stories, ask questions, lift each other up.', " +
      "?, 1, 1, ?)"
    ).bind(adminUser?.id || null, now).run();

    const circleId = res.meta?.last_row_id || null;
    if (circleId && adminUser?.id) {
      await env.DB.prepare(
        "INSERT INTO circle_members (circle_id, user_id, role, joined_at) " +
        "VALUES (?, ?, 'admin', ?) ON CONFLICT DO NOTHING"
      ).bind(circleId, adminUser.id, now).run();
    }
    return circleId;
  } catch (err) {
    console.warn("ensureOfficialCircle failed:", err?.message || err);
    return null;
  }
}

// Auto-join EndoMe on user creation. Best-effort — never blocks signup.
async function autoJoinOfficialCircle(env, userId) {
  try {
    const circleId = await ensureOfficialCircle(env);
    if (!circleId) return;
    await env.DB.prepare(
      "INSERT INTO circle_members (circle_id, user_id, role, joined_at) " +
      "VALUES (?, ?, 'member', ?) ON CONFLICT DO NOTHING"
    ).bind(circleId, userId, nowSec()).run();
  } catch (err) {
    console.warn("autoJoinOfficialCircle failed:", err?.message || err);
  }
}

// --- /api/me/community ---------------------------------------------------
// Hub view: my circles + discover (open circles I'm not in) + my tier.
async function getCommunityHub(env, user) {
  // Make sure the official circle exists and the user is in it.
  await ensureOfficialCircle(env);
  await autoJoinOfficialCircle(env, user.id);

  const pet = await env.DB.prepare("SELECT distinct_log_days FROM pets WHERE user_id = ?")
    .bind(user.id).first().catch(() => null);
  const tier = communityTier(pet);
  const next = communityNextTier(tier.key);

  let myCircles = { results: [] };
  let discover  = { results: [] };
  try {
    myCircles = await env.DB.prepare(
      "SELECT c.id, c.slug, c.name, c.description, c.is_official, c.created_at, " +
      "       cm.role, " +
      "       (SELECT COUNT(*) FROM circle_members m2 WHERE m2.circle_id = c.id) AS member_count, " +
      "       (SELECT COUNT(*) FROM circle_posts p WHERE p.circle_id = c.id AND p.deleted_at IS NULL) AS post_count " +
      "FROM circles c JOIN circle_members cm ON cm.circle_id = c.id " +
      "WHERE cm.user_id = ? " +
      "ORDER BY c.is_official DESC, c.created_at DESC"
    ).bind(user.id).all();
  } catch (err) { console.warn("hub myCircles:", err?.message || err); }

  try {
    discover = await env.DB.prepare(
      "SELECT c.id, c.slug, c.name, c.description, c.is_official, c.created_at, " +
      "       (SELECT COUNT(*) FROM circle_members m2 WHERE m2.circle_id = c.id) AS member_count " +
      "FROM circles c " +
      "WHERE c.is_open = 1 AND c.id NOT IN (SELECT circle_id FROM circle_members WHERE user_id = ?) " +
      "ORDER BY c.created_at DESC LIMIT 24"
    ).bind(user.id).all();
  } catch (err) { console.warn("hub discover:", err?.message || err); }

  return json({
    tier: {
      key: tier.key, label: tier.label,
      distinctLogDays: tier.distinctLogDays,
      canCreateCircle: tier.canCreateCircle,
      nextLabel: next?.label || null,
      nextMinDays: next?.minDays || null,
    },
    myCircles: myCircles.results || [],
    discover:  discover.results  || [],
  });
}

// --- /api/me/community/stats ---------------------------------------------
// Aggregate dashboard for the community landing page. One round-trip per
// metric — each tolerant of missing tables so a fresh DB doesn't 500 us.
async function getCommunityStats(env, user) {
  await ensureOfficialCircle(env);
  await autoJoinOfficialCircle(env, user.id);

  const weekAgo = nowSec() - 7 * 86400;

  const safe = async (sql, binds = []) => {
    try {
      return await env.DB.prepare(sql).bind(...binds).first();
    } catch (err) {
      console.warn("stats query failed:", err?.message || err);
      return null;
    }
  };
  const safeAll = async (sql, binds = []) => {
    try {
      return (await env.DB.prepare(sql).bind(...binds).all())?.results || [];
    } catch (err) {
      console.warn("stats list failed:", err?.message || err);
      return [];
    }
  };

  const [
    users, circleCounts, postCounts, replyCount, heartCount,
    activeWeek, postsWeek, distinctCircleMembers,
  ] = await Promise.all([
    safe("SELECT COUNT(*) AS n FROM users"),
    safe(
      "SELECT COUNT(*) AS total, " +
      "       SUM(CASE WHEN is_open = 1 THEN 1 ELSE 0 END) AS open_count, " +
      "       SUM(CASE WHEN is_open = 0 THEN 1 ELSE 0 END) AS private_count " +
      "FROM circles"
    ),
    safe("SELECT COUNT(*) AS n FROM circle_posts WHERE deleted_at IS NULL"),
    safe("SELECT COUNT(*) AS n FROM circle_replies WHERE deleted_at IS NULL"),
    safe("SELECT COUNT(*) AS n FROM circle_reactions WHERE reaction = 'heart'"),
    safe(
      "SELECT COUNT(DISTINCT user_id) AS n FROM (" +
      "  SELECT user_id FROM circle_posts WHERE created_at >= ? AND deleted_at IS NULL " +
      "  UNION " +
      "  SELECT user_id FROM circle_replies WHERE created_at >= ? AND deleted_at IS NULL" +
      ")",
      [weekAgo, weekAgo]
    ),
    safe(
      "SELECT COUNT(*) AS n FROM circle_posts WHERE created_at >= ? AND deleted_at IS NULL",
      [weekAgo]
    ),
    safe("SELECT COUNT(DISTINCT user_id) AS n FROM circle_members"),
  ]);

  const topCircles = await safeAll(
    "SELECT c.id, c.slug, c.name, c.description, c.is_official, c.is_open, " +
    "       (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id) AS member_count, " +
    "       (SELECT COUNT(*) FROM circle_posts p WHERE p.circle_id = c.id AND p.deleted_at IS NULL) AS post_count " +
    "FROM circles c ORDER BY c.is_official DESC, member_count DESC, post_count DESC LIMIT 4"
  );

  const recentActivity = await safeAll(
    "SELECT p.id, p.body, p.created_at, p.is_question, " +
    "       c.slug AS circle_slug, c.name AS circle_name, c.is_official, " +
    "       COALESCE(u.alias, u.display_name) AS author_name, u.username AS author_username, u.avatar AS author_avatar, u.alias AS author_alias " +
    "FROM circle_posts p " +
    "JOIN circles c ON c.id = p.circle_id " +
    "LEFT JOIN users u ON u.id = p.user_id " +
    "WHERE p.deleted_at IS NULL " +
    "ORDER BY p.created_at DESC LIMIT 6"
  );

  return json({
    totals: {
      members:       users?.n || 0,
      circleMembers: distinctCircleMembers?.n || 0,
      circles:       circleCounts?.total || 0,
      openCircles:   circleCounts?.open_count || 0,
      privateCircles: circleCounts?.private_count || 0,
      posts:         postCounts?.n || 0,
      replies:       replyCount?.n || 0,
      hearts:        heartCount?.n || 0,
      stories:       0, // Community Stories aren't writeable yet — wired up when they go live.
    },
    thisWeek: {
      activeMembers: activeWeek?.n || 0,
      posts:         postsWeek?.n || 0,
    },
    topCircles: topCircles.map((c) => ({
      id: c.id, slug: c.slug, name: c.name, description: c.description,
      isOfficial: !!c.is_official, isOpen: !!c.is_open,
      memberCount: c.member_count || 0, postCount: c.post_count || 0,
    })),
    recentActivity: recentActivity.map((p) => ({
      id: p.id,
      body: String(p.body || "").slice(0, 200),
      createdAt: p.created_at,
      isQuestion: !!p.is_question,
      circleSlug: p.circle_slug,
      circleName: p.circle_name,
      circleOfficial: !!p.is_official,
      authorName: p.author_name || p.author_username || "Someone",
      authorUsername: p.author_username || null,
      authorAvatar: p.author_avatar || null,
    })),
  });
}

// --- POST /api/me/community/circles --------------------------------------
async function postCreateCircle(request, env, user) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  // Soft per-user cap — keeps the place from filling up with empty circles.
  const owned = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM circles WHERE creator_user_id = ? AND is_official = 0"
  ).bind(user.id).first().catch(() => ({ n: 0 }));
  if ((owned?.n || 0) >= MAX_CIRCLES_PER_USER) {
    return json({
      error: `You've already created ${MAX_CIRCLES_PER_USER} circles. Tidy one up before starting another.`,
    }, 403);
  }

  const name = sanitizeText(body.name, 60);
  const description = sanitizeText(body.description, 400) || null;
  const isOpen = body.isOpen === false ? 0 : 1; // default open, "Open" or "Private"
  if (!name || name.length < 3) {
    return json({ error: "Circle name needs at least 3 characters." }, 400);
  }
  const slug = await communityFindFreeSlug(env, communitySlug(name));
  const now = nowSec();

  try {
    const res = await env.DB.prepare(
      "INSERT INTO circles (slug, name, description, creator_user_id, is_official, is_open, created_at) " +
      "VALUES (?, ?, ?, ?, 0, ?, ?)"
    ).bind(slug, name, description, user.id, isOpen, now).run();
    const circleId = res.meta?.last_row_id;
    await env.DB.prepare(
      "INSERT INTO circle_members (circle_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)"
    ).bind(circleId, user.id, now).run();
    return json({ ok: true, slug, name });
  } catch (err) {
    console.error("create circle failed:", err?.message || err);
    return json({ error: "Couldn't create the circle." }, 500);
  }
}

// --- GET /api/me/community/circles/:slug ---------------------------------
async function getCircleDetail(env, user, slug) {
  let circle = null;
  try {
    circle = await env.DB.prepare(
      "SELECT c.*, " +
      "       (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id) AS member_count, " +
      "       (SELECT COUNT(*) FROM circle_posts p WHERE p.circle_id = c.id AND p.deleted_at IS NULL) AS posts_count, " +
      "       (SELECT role FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = ?) AS my_role " +
      "FROM circles c WHERE c.slug = ? LIMIT 1"
    ).bind(user.id, slug).first();
  } catch (err) { console.warn("getCircleDetail:", err?.message); }

  if (!circle) return json({ error: "Circle not found" }, 404);

  // The official EndoMe circle is for everyone — auto-join newbies the moment
  // they open it, so they can post immediately without an extra "Join" tap.
  if (circle.is_official && !circle.my_role) {
    try {
      await env.DB.prepare(
        "INSERT INTO circle_members (circle_id, user_id, role, joined_at) " +
        "VALUES (?, ?, 'member', ?) ON CONFLICT DO NOTHING"
      ).bind(circle.id, user.id, nowSec()).run();
      circle.my_role = "member";
      circle.member_count = (circle.member_count || 0) + 1;
    } catch (err) { console.warn("auto-join official circle:", err?.message); }
  }

  let posts = { results: [] };
  try {
    posts = await env.DB.prepare(
      "SELECT p.id, p.body, p.is_question, p.created_at, p.user_id, " +
      "       COALESCE(u.alias, u.display_name) AS author_name, u.username AS author_username, u.avatar AS author_avatar, u.alias AS author_alias, " +
      "       (SELECT COUNT(*) FROM circle_reactions r WHERE r.target_type='post' AND r.target_id=p.id AND r.reaction='heart') AS heart_count, " +
      "       (SELECT COUNT(*) FROM circle_replies r WHERE r.post_id=p.id AND r.deleted_at IS NULL) AS reply_count, " +
      "       EXISTS(SELECT 1 FROM circle_reactions r WHERE r.target_type='post' AND r.target_id=p.id AND r.user_id=? AND r.reaction='heart') AS i_hearted " +
      "FROM circle_posts p LEFT JOIN users u ON u.id = p.user_id " +
      "WHERE p.circle_id = ? AND p.deleted_at IS NULL " +
      "ORDER BY p.created_at DESC LIMIT 50"
    ).bind(user.id, circle.id).all();
  } catch (err) { console.warn("posts:", err?.message); }

  return json({
    circle: {
      id: circle.id, slug: circle.slug, name: circle.name,
      description: circle.description, isOfficial: !!circle.is_official,
      isOpen: !!circle.is_open, createdAt: circle.created_at,
      memberCount: circle.member_count || 0,
      postsCount:  circle.posts_count || 0,
      myRole: circle.my_role || null, // null if not a member
    },
    posts: (posts.results || []).map((p) => ({
      id: p.id, body: p.body, isQuestion: !!p.is_question, createdAt: p.created_at,
      authorId: p.user_id, authorName: p.author_name || p.author_username || "Someone",
      authorUsername: p.author_username || null,
      authorAvatar: p.author_avatar || null,
      heartCount: p.heart_count || 0, replyCount: p.reply_count || 0,
      iHearted: !!p.i_hearted, mine: p.user_id === user.id,
    })),
  });
}

// --- POST /api/me/community/circles/:slug/join ---------------------------
async function postJoinCircle(env, user, slug) {
  const circle = await env.DB.prepare("SELECT id, is_open FROM circles WHERE slug = ?")
    .bind(slug).first().catch(() => null);
  if (!circle) return json({ error: "Circle not found" }, 404);
  if (!circle.is_open) return json({ error: "This circle isn't open to join." }, 403);
  try {
    await env.DB.prepare(
      "INSERT INTO circle_members (circle_id, user_id, role, joined_at) " +
      "VALUES (?, ?, 'member', ?) ON CONFLICT DO NOTHING"
    ).bind(circle.id, user.id, nowSec()).run();
  } catch (err) {
    console.error("join circle failed:", err?.message || err);
    return json({ error: "Couldn't join right now." }, 500);
  }
  return json({ ok: true });
}

// --- POST /api/me/community/circles/:slug/leave --------------------------
async function postLeaveCircle(env, user, slug) {
  const circle = await env.DB.prepare("SELECT id, is_official FROM circles WHERE slug = ?")
    .bind(slug).first().catch(() => null);
  if (!circle) return json({ error: "Circle not found" }, 404);
  if (circle.is_official) return json({ error: "You can't leave the official EndoMe circle." }, 400);
  try {
    await env.DB.prepare(
      "DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?"
    ).bind(circle.id, user.id).run();
  } catch (err) {
    console.error("leave circle failed:", err?.message || err);
    return json({ error: "Couldn't leave right now." }, 500);
  }
  return json({ ok: true });
}

// --- POST /api/me/community/circles/:slug/posts --------------------------
async function postCreatePost(request, env, user, slug) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const text = sanitizeText(body.body, 2000);
  if (!text || text.length < 1) return json({ error: "Post can't be empty." }, 400);
  const isQuestion = body.isQuestion ? 1 : 0;

  const circle = await env.DB.prepare(
    "SELECT c.id, m.user_id AS membership FROM circles c " +
    "LEFT JOIN circle_members m ON m.circle_id = c.id AND m.user_id = ? " +
    "WHERE c.slug = ? LIMIT 1"
  ).bind(user.id, slug).first().catch(() => null);
  if (!circle) return json({ error: "Circle not found" }, 404);
  if (!circle.membership) return json({ error: "Join this circle first." }, 403);

  const now = nowSec();
  try {
    const res = await env.DB.prepare(
      "INSERT INTO circle_posts (circle_id, user_id, body, is_question, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(circle.id, user.id, text, isQuestion, now, now).run();
    return json({ ok: true, postId: res.meta?.last_row_id });
  } catch (err) {
    console.error("create post failed:", err?.message || err);
    return json({ error: "Couldn't post right now." }, 500);
  }
}

// --- DELETE /api/me/community/posts/:id ----------------------------------
async function deletePost(env, user, postId) {
  const row = await env.DB.prepare(
    "SELECT p.id, p.user_id AS author_id, p.circle_id, " +
    "       (SELECT role FROM circle_members m WHERE m.circle_id = p.circle_id AND m.user_id = ?) AS my_role " +
    "FROM circle_posts p WHERE p.id = ?"
  ).bind(user.id, postId).first().catch(() => null);
  if (!row) return json({ error: "Post not found" }, 404);
  const canDelete = row.author_id === user.id || ["admin", "moderator"].includes(row.my_role);
  if (!canDelete) return json({ error: "You can't delete this post." }, 403);
  await env.DB.prepare(
    "UPDATE circle_posts SET deleted_at = ? WHERE id = ?"
  ).bind(nowSec(), postId).run();
  return json({ ok: true });
}

// --- POST /api/me/community/posts/:id/react ------------------------------
async function reactPost(env, user, postId) {
  const post = await env.DB.prepare(
    "SELECT p.id, p.circle_id, m.user_id AS membership FROM circle_posts p " +
    "LEFT JOIN circle_members m ON m.circle_id = p.circle_id AND m.user_id = ? " +
    "WHERE p.id = ? AND p.deleted_at IS NULL"
  ).bind(user.id, postId).first().catch(() => null);
  if (!post) return json({ error: "Post not found" }, 404);
  if (!post.membership) return json({ error: "Join the circle to react." }, 403);

  const existing = await env.DB.prepare(
    "SELECT 1 FROM circle_reactions WHERE target_type='post' AND target_id=? AND user_id=? AND reaction='heart'"
  ).bind(postId, user.id).first().catch(() => null);
  if (existing) {
    await env.DB.prepare(
      "DELETE FROM circle_reactions WHERE target_type='post' AND target_id=? AND user_id=? AND reaction='heart'"
    ).bind(postId, user.id).run();
    return json({ ok: true, hearted: false });
  }
  await env.DB.prepare(
    "INSERT INTO circle_reactions (target_type, target_id, user_id, reaction, created_at) VALUES ('post', ?, ?, 'heart', ?)"
  ).bind(postId, user.id, nowSec()).run();
  return json({ ok: true, hearted: true });
}

// --- GET /api/me/community/posts/:id/replies -----------------------------
async function getReplies(env, user, postId) {
  let rows = { results: [] };
  try {
    rows = await env.DB.prepare(
      "SELECT r.id, r.body, r.created_at, r.parent_reply_id, r.user_id, " +
      "       COALESCE(u.alias, u.display_name) AS author_name, u.username AS author_username, u.avatar AS author_avatar, u.alias AS author_alias, " +
      "       (SELECT COUNT(*) FROM circle_reactions x WHERE x.target_type='reply' AND x.target_id=r.id AND x.reaction='heart') AS heart_count, " +
      "       EXISTS(SELECT 1 FROM circle_reactions x WHERE x.target_type='reply' AND x.target_id=r.id AND x.user_id=? AND x.reaction='heart') AS i_hearted " +
      "FROM circle_replies r LEFT JOIN users u ON u.id = r.user_id " +
      "WHERE r.post_id = ? AND r.deleted_at IS NULL ORDER BY r.created_at ASC LIMIT 200"
    ).bind(user.id, postId).all();
  } catch (err) { console.warn("getReplies:", err?.message); }
  return json({
    replies: (rows.results || []).map((r) => ({
      id: r.id, body: r.body, createdAt: r.created_at,
      parentReplyId: r.parent_reply_id,
      authorId: r.user_id, authorName: r.author_name || r.author_username || "Someone",
      authorUsername: r.author_username || null,
      authorAvatar: r.author_avatar || null,
      heartCount: r.heart_count || 0, iHearted: !!r.i_hearted,
      mine: r.user_id === user.id,
    })),
  });
}

// --- POST /api/me/community/posts/:id/replies ----------------------------
async function postCreateReply(request, env, user, postId) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const text = sanitizeText(body.body, 1000);
  if (!text) return json({ error: "Reply can't be empty." }, 400);
  const parentReplyId = body.parentReplyId ? clampInt(body.parentReplyId, 1, 9_999_999_999) : null;

  const post = await env.DB.prepare(
    "SELECT p.id, p.circle_id, m.user_id AS membership FROM circle_posts p " +
    "LEFT JOIN circle_members m ON m.circle_id = p.circle_id AND m.user_id = ? " +
    "WHERE p.id = ? AND p.deleted_at IS NULL"
  ).bind(user.id, postId).first().catch(() => null);
  if (!post) return json({ error: "Post not found" }, 404);
  if (!post.membership) return json({ error: "Join the circle to reply." }, 403);

  const now = nowSec();
  try {
    const res = await env.DB.prepare(
      "INSERT INTO circle_replies (post_id, user_id, body, parent_reply_id, created_at) " +
      "VALUES (?, ?, ?, ?, ?)"
    ).bind(postId, user.id, text, parentReplyId, now).run();
    return json({ ok: true, replyId: res.meta?.last_row_id });
  } catch (err) {
    console.error("reply failed:", err?.message || err);
    return json({ error: "Couldn't reply right now." }, 500);
  }
}

// --- POST /api/me/community/replies/:id/react ----------------------------
async function reactReply(env, user, replyId) {
  const reply = await env.DB.prepare(
    "SELECT r.id, p.circle_id, m.user_id AS membership FROM circle_replies r " +
    "JOIN circle_posts p ON p.id = r.post_id " +
    "LEFT JOIN circle_members m ON m.circle_id = p.circle_id AND m.user_id = ? " +
    "WHERE r.id = ? AND r.deleted_at IS NULL"
  ).bind(user.id, replyId).first().catch(() => null);
  if (!reply) return json({ error: "Reply not found" }, 404);
  if (!reply.membership) return json({ error: "Join the circle to react." }, 403);

  const existing = await env.DB.prepare(
    "SELECT 1 FROM circle_reactions WHERE target_type='reply' AND target_id=? AND user_id=? AND reaction='heart'"
  ).bind(replyId, user.id).first().catch(() => null);
  if (existing) {
    await env.DB.prepare(
      "DELETE FROM circle_reactions WHERE target_type='reply' AND target_id=? AND user_id=? AND reaction='heart'"
    ).bind(replyId, user.id).run();
    return json({ ok: true, hearted: false });
  }
  await env.DB.prepare(
    "INSERT INTO circle_reactions (target_type, target_id, user_id, reaction, created_at) VALUES ('reply', ?, ?, 'heart', ?)"
  ).bind(replyId, user.id, nowSec()).run();
  return json({ ok: true, hearted: true });
}

// =============================================================================
// PROFILE & FRIENDS — alias, avatar, bio + a simple friends graph.
// =============================================================================

// Avatars are picked from a curated emoji set (kept in sync with profile.js).
// We accept anything 1-4 chars to stay flexible if the set grows, but we
// scrub control chars + length-cap defensively.
const MAX_ALIAS_LEN = 32;
const MAX_BIO_LEN = 280;
const MAX_AVATAR_LEN = 8;

// Best-effort schema bootstrap. SQLite has no `ADD COLUMN IF NOT EXISTS`, so
// we swallow the duplicate-column errors. Run once per worker boot.
let _profileSchemaChecked = false;
async function ensureProfileSchema(env) {
  if (_profileSchemaChecked) return;
  _profileSchemaChecked = true;
  const tries = [
    "ALTER TABLE users ADD COLUMN alias TEXT",
    "ALTER TABLE users ADD COLUMN avatar TEXT",
    "ALTER TABLE users ADD COLUMN bio TEXT",
    "CREATE TABLE IF NOT EXISTS friendships (" +
    "  user_id_a    TEXT    NOT NULL," +
    "  user_id_b    TEXT    NOT NULL," +
    "  requested_by TEXT    NOT NULL," +
    "  status       TEXT    NOT NULL DEFAULT 'pending'," + // pending | accepted
    "  created_at   INTEGER NOT NULL," +
    "  updated_at   INTEGER NOT NULL," +
    "  PRIMARY KEY (user_id_a, user_id_b)" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships(user_id_a, status)",
    "CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_id_b, status)",
  ];
  for (const sql of tries) {
    try { await env.DB.prepare(sql).run(); } catch { /* already there */ }
  }
}

// Friendships are stored with a stable (a, b) pair where a < b lexicographically.
// That gives us one row per relationship regardless of who initiated it.
function friendPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// Public-facing display name: alias if set, else display_name, else username.
function publicName(row) {
  if (!row) return "Someone";
  return row.alias || row.display_name || row.username || "Someone";
}

function profileResponse(row, extras = {}) {
  return {
    id:          row.id,
    username:    row.username,
    displayName: row.display_name || null,
    alias:       row.alias || null,
    name:        publicName(row),
    avatar:      row.avatar || null,
    bio:         row.bio || null,
    createdAt:   row.created_at || null,
    ...extras,
  };
}

// --- GET /api/me/profile -------------------------------------------------
// --- POST /api/me/password — change your own password ------------------
async function postChangePassword(request, env, user) {
  if (!env.SESSION_SECRET) return json({ error: "Authentication not configured" }, 503);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next    = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!current || !next) return json({ error: "Both current and new passwords are required." }, 400);
  if (next.length < 10) return json({ error: "New password must be at least 10 characters." }, 400);
  if (next.length > MAX_PASSWORD_LEN) return json({ error: "New password is too long." }, 400);
  if (next === current) return json({ error: "Choose a new password different from the current one." }, 400);

  // Only DB-backed accounts can change their password — env-var admin
  // logins are managed via wrangler secrets, not this endpoint.
  const row = await env.DB.prepare(
    "SELECT id, password_hash, password_salt FROM users WHERE id = ?"
  ).bind(user.id).first().catch(() => null);
  if (!row?.password_hash || !row?.password_salt) {
    return json({
      error: "This account doesn't support password change here. Admin logins are managed via Cloudflare secrets.",
    }, 400);
  }

  const ok = await verifyPassword(current, row.password_hash, row.password_salt);
  if (!ok) {
    await sleep(LOGIN_FAIL_DELAY_MS);
    return json({ error: "Current password is incorrect." }, 401);
  }

  // Re-hash with a fresh salt — keeps the hash impossible to predict
  // even if an old salt ever leaks.
  const { hash, salt } = await hashPassword(next);
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?"
  ).bind(hash, salt, user.id).run();

  // Invalidate every existing OTP challenge tied to this user so a stale
  // one can't be used to mint a session after a password change.
  try {
    await env.DB.prepare(
      "UPDATE login_otp SET used_at = COALESCE(used_at, ?) WHERE user_id = ?"
    ).bind(nowSec(), user.id).run();
  } catch { /* table may not exist on a very fresh install */ }

  return json({ ok: true });
}

// --- DELETE /api/me/account — irreversible account wipe -----------------
async function deleteMyAccount(request, env, user) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const confirm = typeof body.confirm === "string" ? body.confirm : "";
  if (confirm !== "DELETE") {
    return json({ error: 'Type "DELETE" exactly to confirm.' }, 400);
  }

  // For DB users, also verify their password first so a hijacked session
  // can't nuke the account.
  const row = await env.DB.prepare(
    "SELECT id, password_hash, password_salt FROM users WHERE id = ?"
  ).bind(user.id).first().catch(() => null);
  if (row?.password_hash) {
    const pw = typeof body.password === "string" ? body.password : "";
    if (!pw) return json({ error: "Password required to delete this account." }, 400);
    const ok = await verifyPassword(pw, row.password_hash, row.password_salt);
    if (!ok) {
      await sleep(LOGIN_FAIL_DELAY_MS);
      return json({ error: "Password is incorrect." }, 401);
    }
  }

  // All user-owned tables have ON DELETE CASCADE → one row removes
  // everything. (Documents in R2 are left behind by design — clean those
  // up via the documents page first, or via an admin job.)
  try { await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run(); }
  catch (err) { console.error("account delete failed:", err?.message); return json({ error: "Couldn't delete right now." }, 500); }

  // Clear the session cookie on the way out.
  const headers = new Headers(JSON_HEADERS);
  headers.append("Set-Cookie", buildCookie(SESSION_COOKIE, "", request, 0));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function getMyProfile(env, user) {
  await ensureProfileSchema(env);
  const row = await env.DB.prepare(
    "SELECT id, username, display_name, alias, avatar, bio, created_at FROM users WHERE id = ?"
  ).bind(user.id).first().catch(() => null);
  if (!row) return json({ error: "Profile not found" }, 404);

  const stats = await profileStatsFor(env, row.id);
  return json({ profile: profileResponse(row, stats) });
}

// --- PUT /api/me/profile -------------------------------------------------
async function putMyProfile(request, env, user) {
  await ensureProfileSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  // Each field is optional — only update what was sent. `null` explicitly
  // clears it (e.g. removing your alias to fall back to your real name).
  const fields = [];
  const binds  = [];
  if ("alias" in body) {
    let v = sanitizeText(body.alias, MAX_ALIAS_LEN);
    if (v && !/^[\p{L}\p{N} _'\-.]+$/u.test(v)) return json({ error: "Alias has invalid characters." }, 400);
    fields.push("alias = ?"); binds.push(v || null);
  }
  if ("avatar" in body) {
    let v = sanitizeText(body.avatar, MAX_AVATAR_LEN);
    fields.push("avatar = ?"); binds.push(v || null);
  }
  if ("bio" in body) {
    let v = sanitizeText(body.bio, MAX_BIO_LEN);
    fields.push("bio = ?"); binds.push(v || null);
  }
  if (!fields.length) return json({ error: "Nothing to update." }, 400);

  binds.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).bind(...binds).run();
  return getMyProfile(env, user);
}

async function profileStatsFor(env, userId) {
  const safe = async (sql, ...b) => {
    try { return await env.DB.prepare(sql).bind(...b).first(); } catch { return null; }
  };
  const [posts, circles, friends, pending] = await Promise.all([
    safe("SELECT COUNT(*) AS n FROM circle_posts WHERE user_id = ? AND deleted_at IS NULL", userId),
    safe("SELECT COUNT(*) AS n FROM circle_members WHERE user_id = ?", userId),
    safe(
      "SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (user_id_a = ? OR user_id_b = ?)",
      userId, userId
    ),
    safe(
      "SELECT COUNT(*) AS n FROM friendships WHERE status = 'pending' AND requested_by != ? AND (user_id_a = ? OR user_id_b = ?)",
      userId, userId, userId
    ),
  ]);
  return {
    postCount:    posts?.n    || 0,
    circleCount:  circles?.n  || 0,
    friendCount:  friends?.n  || 0,
    pendingCount: pending?.n  || 0,
  };
}

// --- GET /api/users/:username — viewing someone else's profile -----------
async function getPublicProfile(env, viewer, target) {
  await ensureProfileSchema(env);
  // `target` can be username or alias-equivalent — try username first.
  const t = target.toLowerCase().trim();
  if (!t || t.length > 200) return json({ error: "User not found" }, 404);
  const row = await env.DB.prepare(
    "SELECT id, username, display_name, alias, avatar, bio, created_at FROM users " +
    "WHERE LOWER(username) = ? OR LOWER(alias) = ? LIMIT 1"
  ).bind(t, t).first().catch(() => null);
  if (!row) return json({ error: "User not found" }, 404);

  const isSelf = row.id === viewer.id;
  let friendStatus = "none"; // none | pending_outgoing | pending_incoming | friends | self
  if (isSelf) friendStatus = "self";
  else {
    const [a, b] = friendPair(viewer.id, row.id);
    const f = await env.DB.prepare(
      "SELECT status, requested_by FROM friendships WHERE user_id_a = ? AND user_id_b = ?"
    ).bind(a, b).first().catch(() => null);
    if (f) {
      if (f.status === "accepted") friendStatus = "friends";
      else if (f.status === "pending") {
        friendStatus = f.requested_by === viewer.id ? "pending_outgoing" : "pending_incoming";
      }
    }
  }

  const stats = await profileStatsFor(env, row.id);
  return json({ profile: profileResponse(row, { ...stats, friendStatus, isSelf }) });
}

// --- GET /api/me/friends -------------------------------------------------
async function getMyFriends(env, user) {
  await ensureProfileSchema(env);
  const friends = await env.DB.prepare(
    "SELECT u.id, u.username, u.display_name, u.alias, u.avatar, u.bio, f.updated_at " +
    "FROM friendships f " +
    "JOIN users u ON u.id = CASE WHEN f.user_id_a = ? THEN f.user_id_b ELSE f.user_id_a END " +
    "WHERE f.status = 'accepted' AND (f.user_id_a = ? OR f.user_id_b = ?) " +
    "ORDER BY f.updated_at DESC LIMIT 200"
  ).bind(user.id, user.id, user.id).all().catch(() => ({ results: [] }));

  // Incoming requests = pending where someone else requested.
  const incoming = await env.DB.prepare(
    "SELECT u.id, u.username, u.display_name, u.alias, u.avatar, u.bio, f.created_at " +
    "FROM friendships f " +
    "JOIN users u ON u.id = f.requested_by " +
    "WHERE f.status = 'pending' AND f.requested_by != ? AND (f.user_id_a = ? OR f.user_id_b = ?) " +
    "ORDER BY f.created_at DESC LIMIT 50"
  ).bind(user.id, user.id, user.id).all().catch(() => ({ results: [] }));

  // Outgoing requests = pending where you requested.
  const outgoing = await env.DB.prepare(
    "SELECT u.id, u.username, u.display_name, u.alias, u.avatar, u.bio, f.created_at " +
    "FROM friendships f " +
    "JOIN users u ON u.id = CASE WHEN f.user_id_a = ? THEN f.user_id_b ELSE f.user_id_a END " +
    "WHERE f.status = 'pending' AND f.requested_by = ? " +
    "ORDER BY f.created_at DESC LIMIT 50"
  ).bind(user.id, user.id).all().catch(() => ({ results: [] }));

  return json({
    friends:  (friends.results  || []).map((r) => profileResponse(r)),
    incoming: (incoming.results || []).map((r) => profileResponse(r)),
    outgoing: (outgoing.results || []).map((r) => profileResponse(r)),
  });
}

// --- POST /api/me/friends/:otherId — send a friend request ---------------
async function postFriendRequest(env, user, otherId) {
  await ensureProfileSchema(env);
  if (otherId === user.id) return json({ error: "You can't friend yourself." }, 400);
  const other = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(otherId).first().catch(() => null);
  if (!other) return json({ error: "User not found." }, 404);

  const [a, b] = friendPair(user.id, otherId);
  const now = nowSec();
  const existing = await env.DB.prepare(
    "SELECT status, requested_by FROM friendships WHERE user_id_a = ? AND user_id_b = ?"
  ).bind(a, b).first().catch(() => null);
  if (existing) {
    if (existing.status === "accepted") return json({ ok: true, status: "friends" });
    if (existing.requested_by === user.id) return json({ ok: true, status: "pending_outgoing" });
    // The other side already requested → accept it instead of duplicating.
    await env.DB.prepare(
      "UPDATE friendships SET status = 'accepted', updated_at = ? WHERE user_id_a = ? AND user_id_b = ?"
    ).bind(now, a, b).run();
    return json({ ok: true, status: "friends" });
  }
  await env.DB.prepare(
    "INSERT INTO friendships (user_id_a, user_id_b, requested_by, status, created_at, updated_at) " +
    "VALUES (?, ?, ?, 'pending', ?, ?)"
  ).bind(a, b, user.id, now, now).run();
  return json({ ok: true, status: "pending_outgoing" });
}

// --- POST /api/me/friends/:otherId/accept --------------------------------
async function postFriendAccept(env, user, otherId) {
  await ensureProfileSchema(env);
  const [a, b] = friendPair(user.id, otherId);
  const row = await env.DB.prepare(
    "SELECT status, requested_by FROM friendships WHERE user_id_a = ? AND user_id_b = ?"
  ).bind(a, b).first().catch(() => null);
  if (!row) return json({ error: "No request to accept." }, 404);
  if (row.status === "accepted") return json({ ok: true, status: "friends" });
  if (row.requested_by === user.id) return json({ error: "You sent this request — wait for them to accept." }, 400);
  await env.DB.prepare(
    "UPDATE friendships SET status = 'accepted', updated_at = ? WHERE user_id_a = ? AND user_id_b = ?"
  ).bind(nowSec(), a, b).run();
  return json({ ok: true, status: "friends" });
}

// --- POST /api/me/friends/:otherId/decline -------------------------------
async function postFriendDecline(env, user, otherId) {
  await ensureProfileSchema(env);
  const [a, b] = friendPair(user.id, otherId);
  // Only the recipient can decline; the requester should DELETE instead.
  const row = await env.DB.prepare(
    "SELECT status, requested_by FROM friendships WHERE user_id_a = ? AND user_id_b = ?"
  ).bind(a, b).first().catch(() => null);
  if (!row) return json({ error: "No request to decline." }, 404);
  if (row.status !== "pending") return json({ error: "Only pending requests can be declined." }, 400);
  if (row.requested_by === user.id) return json({ error: "Use DELETE to cancel a request you sent." }, 400);
  await env.DB.prepare(
    "DELETE FROM friendships WHERE user_id_a = ? AND user_id_b = ?"
  ).bind(a, b).run();
  return json({ ok: true });
}

// --- DELETE /api/me/friends/:otherId — unfriend or cancel outgoing -------
async function deleteFriendship(env, user, otherId) {
  await ensureProfileSchema(env);
  const [a, b] = friendPair(user.id, otherId);
  await env.DB.prepare(
    "DELETE FROM friendships WHERE user_id_a = ? AND user_id_b = ?"
  ).bind(a, b).run();
  return json({ ok: true });
}

// =============================================================================
// MEDICATIONS — what the user takes + dose-cooldown reminders.
// =============================================================================

const ALLOWED_MED_KINDS = new Set(["medication", "vitamin", "supplement", "herbal"]);
const ALLOWED_MED_FREQS = new Set([
  "as_needed", "once_daily", "twice_daily", "three_times_daily", "every_6h", "every_8h", "every_12h", "weekly", "other",
]);
const MAX_MEDS_PER_USER = 40;

// Insights pulled from generic OTC + endo-aware guidance. Light, factual,
// non-prescriptive — and shown alongside a "talk to your doctor" hint.
const MED_INSIGHTS = [
  { match: /ibuprofen|nurofen|advil/i, summary:
    "NSAID. Blocks prostaglandins, which drive period cramps and inflammation. Often the first thing tried for endo pain; works best taken at the very first sign of pain. Watch for stomach upset — take with food." },
  { match: /naproxen|naprogesic|aleve/i, summary:
    "Long-acting NSAID. Lasts 8–12 hours so fewer doses needed than ibuprofen. Same anti-prostaglandin mechanism — useful for sustained period pain." },
  { match: /paracetamol|panadol|acetaminophen|tylenol/i, summary:
    "Pain reliever, not an anti-inflammatory. Often layered with an NSAID for endo flares. Maximum 4g per day in healthy adults." },
  { match: /mefenamic|ponstan/i, summary:
    "NSAID specifically licensed in many countries for period pain. Useful when ibuprofen isn't enough." },
  { match: /norethisterone|primolut/i, summary:
    "Progestin used to delay periods or manage heavy bleeding linked to endo. Suppresses ovulation when taken continuously." },
  { match: /dienogest|visanne/i, summary:
    "Progestin specifically approved for endometriosis. Suppresses endo lesion activity and reduces pelvic pain over months of use." },
  { match: /tranexamic|cyklokapron/i, summary:
    "Reduces heavy menstrual bleeding. Doesn't change pain, but can make heavy periods more manageable." },
  { match: /magnesium/i, summary:
    "Muscle relaxant. Some evidence it eases cramps and improves sleep. Glycinate or citrate forms are gentler on the gut than oxide." },
  { match: /vitamin\s*d|cholecalciferol/i, summary:
    "Many people with endo are low in vitamin D. Supports immune balance, mood and bone health. Get a blood level before high-dose supplementing." },
  { match: /vitamin\s*c|ascorbic/i, summary:
    "Antioxidant + supports iron absorption — useful alongside iron supplements if heavy periods leave you low. Aim for natural sources too." },
  { match: /vitamin\s*b|b\-?complex|b12|folate|folic/i, summary:
    "Energy, nerve and red-blood-cell support. B6 may help PMS; folate matters if you might conceive." },
  { match: /iron|ferrous|maltofer/i, summary:
    "Replaces iron lost to heavy periods. Take with vitamin C and away from tea/coffee for better absorption. Constipation is the most common side effect." },
  { match: /omega|fish\s*oil|epa|dha/i, summary:
    "Anti-inflammatory fatty acids. A small evidence base for reducing period pain over consistent use of 3+ months." },
  { match: /turmeric|curcumin/i, summary:
    "Plant-based anti-inflammatory. Use a formulation with piperine or a lipid carrier for absorption. Talk to your doctor if you're on blood thinners." },
  { match: /probiotic/i, summary:
    "Gut health is closely tied to immune + hormone balance. May help endo-belly bloating for some — give it 8+ weeks to judge." },
  { match: /melatonin/i, summary:
    "Sleep regulator. Small studies suggest it may reduce chronic pelvic pain in endometriosis. Start low — even 0.5 mg can help." },
  { match: /zoladex|goserelin|lupron|leuprolide/i, summary:
    "GnRH agonist — induces a temporary 'medical menopause' to shrink endo lesions. Add-back therapy is usually needed to manage menopausal side effects." },
];

function medInsightFor(name) {
  if (!name) return null;
  for (const i of MED_INSIGHTS) if (i.match.test(name)) return i.summary;
  return null;
}

// Best-effort schema bootstrap for medications + medication_logs.
let _medSchemaChecked = false;
async function ensureMedSchema(env) {
  if (_medSchemaChecked) return;
  _medSchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS medications (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  name TEXT NOT NULL," +
    "  kind TEXT," +
    "  dose TEXT," +
    "  dose_mg REAL," +
    "  frequency TEXT," +
    "  min_hours_between REAL," +
    "  brand TEXT," +
    "  link TEXT," +
    "  notes TEXT," +
    "  is_active INTEGER NOT NULL DEFAULT 1," +
    "  created_at INTEGER NOT NULL," +
    "  updated_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_medications_user ON medications(user_id, is_active)",
    "CREATE TABLE IF NOT EXISTS medication_logs (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  medication_id INTEGER NOT NULL," +
    "  taken_at INTEGER NOT NULL," +
    "  dose_text TEXT," +
    "  notes TEXT" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_medlogs_med ON medication_logs(medication_id, taken_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_medlogs_user ON medication_logs(user_id, taken_at DESC)",
    // Community ratings: one row per (user, normalised med name).
    "CREATE TABLE IF NOT EXISTS med_reactions (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  med_key TEXT NOT NULL," +              // lower-cased name for grouping
    "  reaction TEXT NOT NULL," +              // 'love' | 'down'
    "  updated_at INTEGER NOT NULL," +
    "  UNIQUE(user_id, med_key)" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_medreact_key ON med_reactions(med_key, reaction)",
    // Recurring schedules: 0+ rows per medication. Each row is a single
    // weekly slot (days bitmask + HH:MM local time).
    "CREATE TABLE IF NOT EXISTS medication_schedules (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  medication_id INTEGER NOT NULL," +
    "  days_mask INTEGER NOT NULL," +          // Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64
    "  time_of_day TEXT NOT NULL," +           // 'HH:MM' 24h local
    "  created_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_medsched_user ON medication_schedules(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_medsched_med ON medication_schedules(medication_id)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

function medRow(r, lastTakenAt = null) {
  const next = lastTakenAt && r.min_hours_between
    ? lastTakenAt + Math.round(r.min_hours_between * 3600)
    : null;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind || "medication",
    dose: r.dose || null,
    doseMg: r.dose_mg || null,
    frequency: r.frequency || "as_needed",
    minHoursBetween: r.min_hours_between || null,
    brand: r.brand || null,
    link: r.link || null,
    notes: r.notes || null,
    insight: medInsightFor(r.name),
    isActive: !!r.is_active,
    createdAt: r.created_at,
    lastTakenAt,
    nextAllowedAt: next,
  };
}

async function getMedications(env, user) {
  await ensureMedSchema(env);
  const meds = await env.DB.prepare(
    "SELECT m.*, " +
    "       (SELECT MAX(taken_at) FROM medication_logs WHERE medication_id = m.id) AS last_taken_at " +
    "FROM medications m " +
    "WHERE m.user_id = ? AND m.is_active = 1 " +
    "ORDER BY m.created_at DESC"
  ).bind(user.id).all().catch(() => ({ results: [] }));
  const rows = meds.results || [];

  // Side-load schedules + community stats so the page paints in one round-trip.
  const ids = rows.map((r) => r.id);
  let schedByMed = {};
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    try {
      const s = await env.DB.prepare(
        `SELECT id, medication_id, days_mask, time_of_day
         FROM medication_schedules WHERE user_id = ? AND medication_id IN (${ph})
         ORDER BY time_of_day ASC, id ASC`
      ).bind(user.id, ...ids).all();
      for (const r of (s.results || [])) {
        (schedByMed[r.medication_id] = schedByMed[r.medication_id] || [])
          .push({ id: r.id, daysMask: r.days_mask, timeOfDay: r.time_of_day });
      }
    } catch {}
  }

  const keys = [...new Set(rows.map((r) => medKey(r.name)).filter(Boolean))];
  const stats = await getMedCommunityStats(env, keys);
  const mine = {};
  if (keys.length) {
    const ph = keys.map(() => "?").join(",");
    try {
      const r = await env.DB.prepare(
        `SELECT med_key, reaction FROM med_reactions WHERE user_id = ? AND med_key IN (${ph})`
      ).bind(user.id, ...keys).all();
      for (const row of (r.results || [])) mine[row.med_key] = row.reaction;
    } catch {}
  }

  return json({
    medications: rows.map((r) => {
      const key = medKey(r.name);
      const base = medRow(r, r.last_taken_at);
      return {
        ...base,
        schedules: schedByMed[r.id] || [],
        community: stats[key] || { loves: 0, downs: 0, users: 0 },
        myReaction: mine[key] || null,
      };
    }),
  });
}

async function createMedication(request, env, user) {
  await ensureMedSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  const owned = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM medications WHERE user_id = ? AND is_active = 1"
  ).bind(user.id).first().catch(() => ({ n: 0 }));
  if ((owned?.n || 0) >= MAX_MEDS_PER_USER) {
    return json({ error: "You've reached the medication limit. Remove an old one first." }, 403);
  }

  const fields = parseMedFields(body);
  if (!fields.name) return json({ error: "Medication name is required." }, 400);

  const now = nowSec();
  const res = await env.DB.prepare(
    "INSERT INTO medications (user_id, name, kind, dose, dose_mg, frequency, min_hours_between, brand, link, notes, is_active, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
  ).bind(
    user.id, fields.name, fields.kind, fields.dose, fields.doseMg,
    fields.frequency, fields.minHoursBetween, fields.brand, fields.link, fields.notes,
    now, now
  ).run();
  return json({ ok: true, id: res.meta?.last_row_id });
}

async function updateMedication(request, env, user, id) {
  await ensureMedSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const fields = parseMedFields(body);
  // Confirm ownership.
  const owned = await env.DB.prepare(
    "SELECT id FROM medications WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!owned) return json({ error: "Medication not found" }, 404);

  const sets = [];
  const binds = [];
  for (const [k, col] of [
    ["name", "name"], ["kind", "kind"], ["dose", "dose"], ["doseMg", "dose_mg"],
    ["frequency", "frequency"], ["minHoursBetween", "min_hours_between"],
    ["brand", "brand"], ["link", "link"], ["notes", "notes"],
  ]) {
    if (k in fields) { sets.push(`${col} = ?`); binds.push(fields[k]); }
  }
  if (!sets.length) return json({ error: "Nothing to update." }, 400);
  sets.push("updated_at = ?");
  binds.push(nowSec(), id, user.id);
  await env.DB.prepare(
    `UPDATE medications SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`
  ).bind(...binds).run();
  return json({ ok: true });
}

async function deleteMedication(env, user, id) {
  await ensureMedSchema(env);
  await env.DB.prepare(
    "UPDATE medications SET is_active = 0, updated_at = ? WHERE id = ? AND user_id = ?"
  ).bind(nowSec(), id, user.id).run();
  return json({ ok: true });
}

async function logMedicationDose(request, env, user, id) {
  await ensureMedSchema(env);
  const body = await readJsonSafe(request) || {};
  const med = await env.DB.prepare(
    "SELECT id, name, min_hours_between FROM medications WHERE id = ? AND user_id = ? AND is_active = 1"
  ).bind(id, user.id).first().catch(() => null);
  if (!med) return json({ error: "Medication not found" }, 404);

  // Cooldown check — only enforce if min_hours_between is set.
  if (med.min_hours_between) {
    const last = await env.DB.prepare(
      "SELECT taken_at FROM medication_logs WHERE medication_id = ? ORDER BY taken_at DESC LIMIT 1"
    ).bind(id).first().catch(() => null);
    if (last) {
      const next = last.taken_at + med.min_hours_between * 3600;
      if (next > nowSec()) {
        const mins = Math.ceil((next - nowSec()) / 60);
        return json({ error: `Too soon — wait ${mins} more minute${mins===1?"":"s"} before the next dose.` }, 409);
      }
    }
  }
  const doseText = sanitizeText(body.doseText, 60);
  const notes    = sanitizeText(body.notes, 500);
  await env.DB.prepare(
    "INSERT INTO medication_logs (user_id, medication_id, taken_at, dose_text, notes) VALUES (?, ?, ?, ?, ?)"
  ).bind(user.id, id, nowSec(), doseText, notes).run();
  return json({ ok: true, name: med.name });
}

async function getMedicationLogs(env, user, id) {
  await ensureMedSchema(env);
  const logs = await env.DB.prepare(
    "SELECT id, taken_at, dose_text, notes FROM medication_logs " +
    "WHERE medication_id = ? AND user_id = ? ORDER BY taken_at DESC LIMIT 100"
  ).bind(id, user.id).all().catch(() => ({ results: [] }));
  return json({ logs: logs.results || [] });
}

// =============================================================================
// MEDICATION COMMUNITY ENGAGEMENT — hearts / thumbs-down + usage counts per
// medication name. Aggregated across all users so the community can see what
// is working and what isn't.
// =============================================================================
function medKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Stats for a list of meds in one round-trip. Returns map keyed by med_key.
async function getMedCommunityStats(env, keys) {
  if (!keys.length) return {};
  await ensureMedSchema(env);
  const out = {};
  for (const k of keys) out[k] = { loves: 0, downs: 0, users: 0 };

  const ph = keys.map(() => "?").join(",");
  // Reaction counts
  try {
    const reacts = await env.DB.prepare(
      `SELECT med_key, reaction, COUNT(*) AS n FROM med_reactions
       WHERE med_key IN (${ph}) GROUP BY med_key, reaction`
    ).bind(...keys).all();
    for (const r of (reacts.results || [])) {
      const bucket = out[r.med_key]; if (!bucket) continue;
      if (r.reaction === "love") bucket.loves = r.n;
      else if (r.reaction === "down") bucket.downs = r.n;
    }
  } catch {}

  // Distinct active users per med name
  try {
    const usage = await env.DB.prepare(
      `SELECT LOWER(TRIM(name)) AS med_key, COUNT(DISTINCT user_id) AS n
       FROM medications WHERE is_active = 1 AND LOWER(TRIM(name)) IN (${ph})
       GROUP BY LOWER(TRIM(name))`
    ).bind(...keys).all();
    for (const r of (usage.results || [])) {
      if (out[r.med_key]) out[r.med_key].users = r.n;
    }
  } catch {}
  return out;
}

async function getCommunityStatsForCatalog(request, env, user) {
  // POST {names: [...]} to fetch the engagement stats + the caller's own reactions.
  const body = await readJsonSafe(request) || {};
  const names = Array.isArray(body.names) ? body.names.slice(0, 200) : [];
  const keys = [...new Set(names.map(medKey).filter(Boolean))];
  const stats = await getMedCommunityStats(env, keys);

  // Caller's own votes
  const mine = {};
  if (keys.length) {
    try {
      const ph = keys.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT med_key, reaction FROM med_reactions WHERE user_id = ? AND med_key IN (${ph})`
      ).bind(user.id, ...keys).all();
      for (const r of (rows.results || [])) mine[r.med_key] = r.reaction;
    } catch {}
  }
  return json({ stats, mine });
}

async function postMedReaction(request, env, user) {
  await ensureMedSchema(env);
  const body = await readJsonSafe(request) || {};
  const key = medKey(body.name);
  const reaction = body.reaction === "love" ? "love"
                 : body.reaction === "down" ? "down"
                 : body.reaction === null ? null : null;
  if (!key) return json({ error: "Medication name required." }, 400);

  if (reaction === null) {
    // Clear vote
    await env.DB.prepare(
      "DELETE FROM med_reactions WHERE user_id = ? AND med_key = ?"
    ).bind(user.id, key).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO med_reactions (user_id, med_key, reaction, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(user_id, med_key) DO UPDATE SET reaction = excluded.reaction, updated_at = excluded.updated_at"
    ).bind(user.id, key, reaction, nowSec()).run();
  }

  const stats = (await getMedCommunityStats(env, [key]))[key] || { loves: 0, downs: 0, users: 0 };
  return json({ ok: true, key, reaction, stats });
}

// Top-ranked picks for the right sidebar. Ranked by (loves - downs) with a
// minimum sample so a single user can't dominate, falling back to most-used.
async function getMedTopPicks(env) {
  await ensureMedSchema(env);
  const out = { medication: null, vitamin: null };

  // 1) Aggregate vote scores across med_reactions
  let voteRows = { results: [] };
  try {
    voteRows = await env.DB.prepare(
      "SELECT med_key, " +
      "  SUM(CASE WHEN reaction='love' THEN 1 ELSE 0 END) AS loves, " +
      "  SUM(CASE WHEN reaction='down' THEN 1 ELSE 0 END) AS downs " +
      "FROM med_reactions GROUP BY med_key"
    ).all();
  } catch {}

  // 2) Pull usage counts grouped by lower(name) + kind
  let usageRows = { results: [] };
  try {
    usageRows = await env.DB.prepare(
      "SELECT LOWER(TRIM(name)) AS med_key, MIN(name) AS display_name, " +
      "       kind, COUNT(DISTINCT user_id) AS users " +
      "FROM medications WHERE is_active = 1 GROUP BY LOWER(TRIM(name)), kind"
    ).all();
  } catch {}

  const voteMap = new Map();
  for (const r of (voteRows.results || [])) voteMap.set(r.med_key, { loves: +r.loves || 0, downs: +r.downs || 0 });

  const ranked = (usageRows.results || []).map((r) => {
    const v = voteMap.get(r.med_key) || { loves: 0, downs: 0 };
    const score = v.loves - v.downs;
    return {
      key: r.med_key,
      name: r.display_name,
      kind: r.kind || "medication",
      users: r.users || 0,
      loves: v.loves,
      downs: v.downs,
      score,
    };
  });

  function pick(kinds) {
    const pool = ranked.filter((r) => kinds.includes(r.kind));
    if (!pool.length) return null;
    pool.sort((a, b) => {
      // Score first, then usage, then alphabetical for determinism.
      if (b.score !== a.score) return b.score - a.score;
      if (b.users !== a.users) return b.users - a.users;
      return a.name.localeCompare(b.name);
    });
    return pool[0];
  }

  out.medication = pick(["medication"]);
  out.vitamin    = pick(["vitamin", "supplement", "herbal"]);
  return json(out);
}

// =============================================================================
// MEDICATION SCHEDULES — recurring weekly slots + computed weekly timetable.
// =============================================================================
const DOW_MAX = 127; // 7-bit bitmask (Sun..Sat)

function sanitizeTimeOfDay(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const h = String(+m[1]).padStart(2, "0");
  return `${h}:${m[2]}`;
}

async function getMedicationSchedules(env, user, medId) {
  await ensureMedSchema(env);
  const rows = await env.DB.prepare(
    "SELECT id, medication_id, days_mask, time_of_day, created_at " +
    "FROM medication_schedules WHERE user_id = ? AND medication_id = ? " +
    "ORDER BY time_of_day ASC, id ASC"
  ).bind(user.id, medId).all().catch(() => ({ results: [] }));
  return json({
    schedules: (rows.results || []).map((r) => ({
      id: r.id, medicationId: r.medication_id, daysMask: r.days_mask,
      timeOfDay: r.time_of_day, createdAt: r.created_at,
    })),
  });
}

async function createMedicationSchedule(request, env, user, medId) {
  await ensureMedSchema(env);
  // Confirm ownership
  const owned = await env.DB.prepare(
    "SELECT id FROM medications WHERE id = ? AND user_id = ? AND is_active = 1"
  ).bind(medId, user.id).first().catch(() => null);
  if (!owned) return json({ error: "Medication not found" }, 404);

  const body = await readJsonSafe(request) || {};
  const daysMask = Math.max(1, Math.min(DOW_MAX, +body.daysMask || 0));
  const time = sanitizeTimeOfDay(body.timeOfDay);
  if (!time) return json({ error: "Pick a valid time (HH:MM)." }, 400);
  if (!daysMask) return json({ error: "Pick at least one day." }, 400);

  const res = await env.DB.prepare(
    "INSERT INTO medication_schedules (user_id, medication_id, days_mask, time_of_day, created_at) " +
    "VALUES (?, ?, ?, ?, ?)"
  ).bind(user.id, medId, daysMask, time, nowSec()).run();
  return json({ ok: true, id: res.meta?.last_row_id });
}

async function deleteMedicationSchedule(env, user, medId, schedId) {
  await ensureMedSchema(env);
  await env.DB.prepare(
    "DELETE FROM medication_schedules WHERE id = ? AND medication_id = ? AND user_id = ?"
  ).bind(schedId, medId, user.id).run();
  return json({ ok: true });
}

// Returns the full weekly grid with all of the user's scheduled doses + the
// most recent log for each slot so the UI can mark "taken" / "skipped".
async function getMedicationTimetable(env, user) {
  await ensureMedSchema(env);
  const rows = await env.DB.prepare(
    "SELECT s.id AS schedule_id, s.medication_id, s.days_mask, s.time_of_day, " +
    "       m.name, m.kind, m.dose " +
    "FROM medication_schedules s " +
    "JOIN medications m ON m.id = s.medication_id AND m.is_active = 1 " +
    "WHERE s.user_id = ? ORDER BY s.time_of_day ASC"
  ).bind(user.id).all().catch(() => ({ results: [] }));

  // For each (medication_id, day), include the latest log within ±2 hours
  // of the slot — so the UI can show whether it's been taken today.
  const todayStart = Math.floor(Date.now() / 1000) - 14 * 86400;
  const logRows = await env.DB.prepare(
    "SELECT medication_id, taken_at FROM medication_logs " +
    "WHERE user_id = ? AND taken_at >= ?"
  ).bind(user.id, todayStart).all().catch(() => ({ results: [] }));

  return json({
    slots: (rows.results || []).map((r) => ({
      scheduleId: r.schedule_id,
      medicationId: r.medication_id,
      name: r.name,
      kind: r.kind || "medication",
      dose: r.dose || null,
      daysMask: r.days_mask,
      timeOfDay: r.time_of_day,
    })),
    recentLogs: (logRows.results || []).map((r) => ({
      medicationId: r.medication_id, takenAt: r.taken_at,
    })),
  });
}

function parseMedFields(body) {
  const out = {};
  if ("name" in body)              out.name = sanitizeText(body.name, 120) || null;
  if ("kind" in body)              out.kind = ALLOWED_MED_KINDS.has(body.kind) ? body.kind : "medication";
  if ("dose" in body)              out.dose = sanitizeText(body.dose, 40) || null;
  if ("doseMg" in body)            out.doseMg = (body.doseMg == null || body.doseMg === "") ? null : Math.max(0, Math.min(10000, +body.doseMg || 0));
  if ("frequency" in body)         out.frequency = ALLOWED_MED_FREQS.has(body.frequency) ? body.frequency : "as_needed";
  if ("minHoursBetween" in body)   out.minHoursBetween = (body.minHoursBetween == null || body.minHoursBetween === "") ? null : Math.max(0, Math.min(168, +body.minHoursBetween || 0));
  if ("brand" in body)             out.brand = sanitizeText(body.brand, 80) || null;
  if ("link" in body)              out.link  = sanitizeUrl(body.link);
  if ("notes" in body)             out.notes = sanitizeText(body.notes, 1000) || null;
  return out;
}

// Allow http/https only; reject anything that could be a javascript: or data: URL.
function sanitizeUrl(v) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (trimmed.length > 500) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch { return null; }
}

// =============================================================================
// RECIPES — community cookbook. Recipes have hearts and thumbs-down. Every
// thumbs-down must come with a useful comment that lands in the moderation
// queue, so no one can just flame a post anonymously. Each recipe stores its
// ingredient list using a snapshot of the food name + quantity + unit, with
// an optional pointer at the shared food catalog so the future food tracker
// can join on the same entries.
// =============================================================================
const RECIPE_CATEGORIES = [
  { id: "breakfast",   label: "Breakfast",     emoji: "🥣" },
  { id: "lunch",       label: "Lunch",         emoji: "🥗" },
  { id: "dinner",      label: "Dinner",        emoji: "🍽" },
  { id: "family_meal", label: "Family meals",  emoji: "👨‍👩‍👧" },
  { id: "quick_fast",  label: "Quick & fast",  emoji: "⚡" },
  { id: "dessert",     label: "Desserts",      emoji: "🍰" },
  { id: "snack",       label: "Snacks",        emoji: "🍪" },
  { id: "drink",       label: "Drinks",        emoji: "🥤" },
  { id: "other",       label: "Other",         emoji: "🍳" },
];
const RECIPE_CATEGORY_IDS = new Set(RECIPE_CATEGORIES.map((c) => c.id));
const RECIPE_FOOD_CATEGORIES = new Set([
  "protein", "vegetable", "fruit", "grain", "dairy", "fat", "sweetener",
  "herb", "spice", "fluid", "legume", "nut_seed", "other",
]);
const RECIPE_FOOD_UNITS = new Set([
  "g", "kg", "mg", "ml", "l", "tsp", "tbsp", "cup", "piece", "slice",
  "clove", "pinch", "to_taste", "stalk", "bunch", "can", "packet",
]);
const MAX_RECIPES_PER_USER = 200;

function getRecipeCategories() {
  return json({ categories: RECIPE_CATEGORIES });
}

let _recipeSchemaChecked = false;
async function ensureRecipeSchema(env) {
  if (_recipeSchemaChecked) return;
  _recipeSchemaChecked = true;
  const stmts = [
    // Shared food catalog. user_id=NULL marks a global entry. Anyone can read
    // every entry; the future food tracker joins on this table.
    "CREATE TABLE IF NOT EXISTS recipe_foods (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT," +
    "  name TEXT NOT NULL," +
    "  category TEXT," +
    "  default_unit TEXT," +
    "  notes TEXT," +
    "  created_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_recipe_foods_name ON recipe_foods(LOWER(name))",
    "CREATE TABLE IF NOT EXISTS recipes (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  title TEXT NOT NULL," +
    "  category TEXT," +
    "  summary TEXT," +
    "  body TEXT," +
    "  servings INTEGER," +
    "  prep_minutes INTEGER," +
    "  cook_minutes INTEGER," +
    "  is_active INTEGER NOT NULL DEFAULT 1," +
    "  created_at INTEGER NOT NULL," +
    "  updated_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_recipes_user ON recipes(user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_recipes_cat  ON recipes(category, created_at DESC)",
    "CREATE TABLE IF NOT EXISTS recipe_ingredients (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  recipe_id INTEGER NOT NULL," +
    "  food_id INTEGER," +
    "  food_name TEXT NOT NULL," +
    "  quantity REAL," +
    "  unit TEXT," +
    "  notes TEXT" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_recipe_ing_recipe ON recipe_ingredients(recipe_id)",
    "CREATE TABLE IF NOT EXISTS recipe_reactions (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  recipe_id INTEGER NOT NULL," +
    "  reaction TEXT NOT NULL," +
    "  comment TEXT," +
    "  created_at INTEGER NOT NULL," +
    "  UNIQUE(user_id, recipe_id)" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_recipe_react_recipe ON recipe_reactions(recipe_id, reaction)",
    "CREATE TABLE IF NOT EXISTS recipe_mod_queue (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  recipe_id INTEGER NOT NULL," +
    "  user_id TEXT NOT NULL," +
    "  comment TEXT NOT NULL," +
    "  reaction_id INTEGER," +
    "  status TEXT NOT NULL DEFAULT 'pending'," +
    "  created_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_recipe_mod_status ON recipe_mod_queue(status, created_at DESC)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }

  // Seed a small catalog of generic foods on first boot so the page isn't
  // empty for the first poster. Skipped silently if the table already has rows.
  try {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM recipe_foods").first();
    if ((n || 0) === 0) await seedRecipeFoods(env);
  } catch {}
}

async function seedRecipeFoods(env) {
  const now = nowSec();
  const seed = [
    // proteins
    ["Chicken breast","protein","g"], ["Salmon fillet","protein","g"],
    ["Eggs","protein","piece"], ["Greek yoghurt","protein","g"],
    ["Tofu","protein","g"], ["Tempeh","protein","g"], ["Tuna","protein","can"],
    ["Lean beef mince","protein","g"], ["Prawns","protein","g"],
    // veg
    ["Spinach","vegetable","cup"], ["Kale","vegetable","cup"],
    ["Broccoli","vegetable","g"], ["Sweet potato","vegetable","piece"],
    ["Onion","vegetable","piece"], ["Garlic","vegetable","clove"],
    ["Carrot","vegetable","piece"], ["Capsicum","vegetable","piece"],
    ["Tomato","vegetable","piece"], ["Cucumber","vegetable","piece"],
    ["Zucchini","vegetable","piece"], ["Mushrooms","vegetable","g"],
    ["Avocado","fat","piece"],
    // fruit
    ["Blueberries","fruit","cup"], ["Banana","fruit","piece"],
    ["Apple","fruit","piece"], ["Lemon","fruit","piece"],
    ["Lime","fruit","piece"], ["Strawberries","fruit","cup"],
    // grain / legume
    ["Rolled oats","grain","cup"], ["Brown rice","grain","cup"],
    ["Quinoa","grain","cup"], ["Wholegrain bread","grain","slice"],
    ["Chickpeas","legume","can"], ["Lentils","legume","cup"],
    ["Black beans","legume","can"],
    // dairy / fat / sweetener
    ["Olive oil","fat","tbsp"], ["Coconut oil","fat","tbsp"],
    ["Almonds","nut_seed","g"], ["Walnuts","nut_seed","g"],
    ["Chia seeds","nut_seed","tbsp"], ["Flax seeds","nut_seed","tbsp"],
    ["Almond milk","dairy","cup"], ["Cottage cheese","dairy","g"],
    ["Honey","sweetener","tsp"], ["Maple syrup","sweetener","tbsp"],
    ["Dark chocolate","other","g"],
    // herbs / spices
    ["Turmeric","spice","tsp"], ["Cinnamon","spice","tsp"],
    ["Ginger","spice","g"], ["Basil","herb","bunch"],
    ["Parsley","herb","bunch"], ["Mint","herb","bunch"],
    ["Black pepper","spice","pinch"], ["Sea salt","spice","pinch"],
    // fluids
    ["Water","fluid","cup"], ["Bone broth","fluid","cup"],
  ];
  for (const [name, cat, unit] of seed) {
    try {
      await env.DB.prepare(
        "INSERT INTO recipe_foods (user_id, name, category, default_unit, notes, created_at) " +
        "VALUES (NULL, ?, ?, ?, NULL, ?)"
      ).bind(name, cat, unit, now).run();
    } catch {}
  }
}

async function listRecipes(request, env, user) {
  await ensureRecipeSchema(env);
  const url = new URL(request.url);
  const cat = (url.searchParams.get("category") || "").toLowerCase();
  const q   = (url.searchParams.get("q") || "").trim().toLowerCase();
  const mineOnly = url.searchParams.get("scope") === "mine";

  const where = ["r.is_active = 1"];
  const binds = [];
  if (mineOnly) { where.push("r.user_id = ?"); binds.push(user.id); }
  if (cat && RECIPE_CATEGORY_IDS.has(cat)) { where.push("r.category = ?"); binds.push(cat); }
  if (q) {
    where.push("(LOWER(r.title) LIKE ? OR LOWER(r.summary) LIKE ? OR LOWER(r.body) LIKE ?)");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    binds.push(like, like, like);
  }

  const rows = await env.DB.prepare(
    "SELECT r.*, u.display_name AS author_display, u.username AS author_username, " +
    "  (SELECT COUNT(*) FROM recipe_reactions WHERE recipe_id = r.id AND reaction='love') AS loves, " +
    "  (SELECT COUNT(*) FROM recipe_reactions WHERE recipe_id = r.id AND reaction='down') AS downs, " +
    "  (SELECT reaction FROM recipe_reactions WHERE recipe_id = r.id AND user_id = ?) AS mine " +
    "FROM recipes r LEFT JOIN users u ON u.id = r.user_id " +
    `WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC LIMIT 200`
  ).bind(user.id, ...binds).all().catch(() => ({ results: [] }));

  return json({
    recipes: (rows.results || []).map((r) => ({
      id: r.id, title: r.title, category: r.category, summary: r.summary,
      servings: r.servings, prepMinutes: r.prep_minutes, cookMinutes: r.cook_minutes,
      createdAt: r.created_at,
      author: r.author_display || r.author_username || "Member",
      authorUsername: r.author_username,
      isMine: r.user_id === user.id,
      loves: r.loves || 0, downs: r.downs || 0,
      myReaction: r.mine || null,
    })),
  });
}

async function getRecipe(env, user, id) {
  await ensureRecipeSchema(env);
  const r = await env.DB.prepare(
    "SELECT r.*, u.display_name AS author_display, u.username AS author_username " +
    "FROM recipes r LEFT JOIN users u ON u.id = r.user_id " +
    "WHERE r.id = ? AND r.is_active = 1"
  ).bind(id).first();
  if (!r) return json({ error: "Recipe not found" }, 404);

  const ings = await env.DB.prepare(
    "SELECT id, food_id, food_name, quantity, unit, notes FROM recipe_ingredients " +
    "WHERE recipe_id = ? ORDER BY id ASC"
  ).bind(id).all().catch(() => ({ results: [] }));

  const tally = await env.DB.prepare(
    "SELECT reaction, COUNT(*) AS n FROM recipe_reactions WHERE recipe_id = ? GROUP BY reaction"
  ).bind(id).all().catch(() => ({ results: [] }));
  let loves = 0, downs = 0;
  for (const t of (tally.results || [])) {
    if (t.reaction === "love") loves = t.n;
    else if (t.reaction === "down") downs = t.n;
  }
  const mine = await env.DB.prepare(
    "SELECT reaction, comment FROM recipe_reactions WHERE recipe_id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);

  // Public down-comments (the moderation queue stores the same text but we
  // also surface them on the recipe so visitors can see what people object
  // to). Strip user_id from the wire to keep it lightly anonymous.
  const downComments = await env.DB.prepare(
    "SELECT comment, created_at FROM recipe_reactions " +
    "WHERE recipe_id = ? AND reaction = 'down' AND comment IS NOT NULL " +
    "ORDER BY created_at DESC LIMIT 30"
  ).bind(id).all().catch(() => ({ results: [] }));

  return json({
    recipe: {
      id: r.id, title: r.title, category: r.category, summary: r.summary,
      body: r.body, servings: r.servings, prepMinutes: r.prep_minutes,
      cookMinutes: r.cook_minutes, createdAt: r.created_at,
      author: r.author_display || r.author_username || "Member",
      authorUsername: r.author_username,
      isMine: r.user_id === user.id,
      ingredients: (ings.results || []).map((i) => ({
        id: i.id, foodId: i.food_id, foodName: i.food_name,
        quantity: i.quantity, unit: i.unit, notes: i.notes,
      })),
      loves, downs,
      myReaction: mine?.reaction || null,
      myComment: mine?.comment || null,
      downComments: (downComments.results || []).map((c) => ({ comment: c.comment, createdAt: c.created_at })),
    },
  });
}

async function createRecipe(request, env, user) {
  await ensureRecipeSchema(env);
  const owned = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM recipes WHERE user_id = ? AND is_active = 1"
  ).bind(user.id).first().catch(() => ({ n: 0 }));
  if ((owned?.n || 0) >= MAX_RECIPES_PER_USER) {
    return json({ error: "You've reached the recipe limit." }, 403);
  }

  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  const title = sanitizeText(body.title, 140);
  if (!title) return json({ error: "Title is required." }, 400);
  const category = RECIPE_CATEGORY_IDS.has(body.category) ? body.category : "other";
  const summary  = sanitizeText(body.summary, 500) || null;
  const bodyText = sanitizeText(body.body, 8000) || null;
  const servings = clampIntOrNull(body.servings, 1, 30);
  const prep     = clampIntOrNull(body.prepMinutes, 0, 600);
  const cook     = clampIntOrNull(body.cookMinutes, 0, 600);
  const ingredients = Array.isArray(body.ingredients) ? body.ingredients.slice(0, 60) : [];
  if (!ingredients.length) return json({ error: "Add at least one ingredient." }, 400);

  const now = nowSec();
  const res = await env.DB.prepare(
    "INSERT INTO recipes (user_id, title, category, summary, body, servings, prep_minutes, cook_minutes, is_active, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)"
  ).bind(user.id, title, category, summary, bodyText, servings, prep, cook, now, now).run();
  const recipeId = res.meta?.last_row_id;

  for (const ing of ingredients) {
    const foodName = sanitizeText(ing.foodName || ing.name, 120);
    if (!foodName) continue;
    const foodId   = ing.foodId ? (+ing.foodId || null) : null;
    const quantity = (ing.quantity == null || ing.quantity === "") ? null : Math.max(0, Math.min(99999, +ing.quantity || 0));
    const unit     = RECIPE_FOOD_UNITS.has(ing.unit) ? ing.unit : (ing.unit ? sanitizeText(ing.unit, 20) : null);
    const notes    = sanitizeText(ing.notes, 200) || null;
    try {
      await env.DB.prepare(
        "INSERT INTO recipe_ingredients (recipe_id, food_id, food_name, quantity, unit, notes) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(recipeId, foodId, foodName, quantity, unit, notes).run();
    } catch {}
  }

  return json({ ok: true, id: recipeId });
}

async function deleteRecipe(env, user, id) {
  await ensureRecipeSchema(env);
  // Owner-only soft delete.
  const owned = await env.DB.prepare(
    "SELECT id FROM recipes WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!owned) return json({ error: "Recipe not found" }, 404);
  await env.DB.prepare(
    "UPDATE recipes SET is_active = 0, updated_at = ? WHERE id = ?"
  ).bind(nowSec(), id).run();
  return json({ ok: true });
}

async function postRecipeReaction(request, env, user, id) {
  await ensureRecipeSchema(env);
  // Confirm recipe exists.
  const r = await env.DB.prepare(
    "SELECT id FROM recipes WHERE id = ? AND is_active = 1"
  ).bind(id).first().catch(() => null);
  if (!r) return json({ error: "Recipe not found" }, 404);

  const body = await readJsonSafe(request) || {};
  const wanted = body.reaction;
  if (wanted === null) {
    await env.DB.prepare(
      "DELETE FROM recipe_reactions WHERE user_id = ? AND recipe_id = ?"
    ).bind(user.id, id).run();
    return json({ ok: true, reaction: null });
  }
  if (wanted !== "love" && wanted !== "down") {
    return json({ error: "Pick love or down." }, 400);
  }
  let comment = null;
  if (wanted === "down") {
    // Thumbs-down must come with a real, useful comment. Bare gripes get
    // bounced; anything 10+ chars goes through and lands in the mod queue.
    comment = sanitizeText(body.comment, 800);
    if (!comment || comment.length < 10) {
      return json({ error: "Add a comment (at least 10 characters) explaining what didn't work. Useful feedback only — it goes to the moderation queue." }, 400);
    }
  }

  const now = nowSec();
  await env.DB.prepare(
    "INSERT INTO recipe_reactions (user_id, recipe_id, reaction, comment, created_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_id, recipe_id) DO UPDATE SET reaction = excluded.reaction, comment = excluded.comment, created_at = excluded.created_at"
  ).bind(user.id, id, wanted, comment, now).run();

  if (wanted === "down" && comment) {
    const reactRow = await env.DB.prepare(
      "SELECT id FROM recipe_reactions WHERE user_id = ? AND recipe_id = ?"
    ).bind(user.id, id).first().catch(() => null);
    try {
      await env.DB.prepare(
        "INSERT INTO recipe_mod_queue (recipe_id, user_id, comment, reaction_id, status, created_at) " +
        "VALUES (?, ?, ?, ?, 'pending', ?)"
      ).bind(id, user.id, comment, reactRow?.id || null, now).run();
    } catch {}
  }

  const tally = await env.DB.prepare(
    "SELECT reaction, COUNT(*) AS n FROM recipe_reactions WHERE recipe_id = ? GROUP BY reaction"
  ).bind(id).all().catch(() => ({ results: [] }));
  let loves = 0, downs = 0;
  for (const t of (tally.results || [])) {
    if (t.reaction === "love") loves = t.n;
    else if (t.reaction === "down") downs = t.n;
  }
  return json({ ok: true, reaction: wanted, loves, downs });
}

async function listRecipeFoods(request, env, user) {
  await ensureRecipeSchema(env);
  const url = new URL(request.url);
  const q   = (url.searchParams.get("q") || "").trim().toLowerCase();
  const cat = url.searchParams.get("category");
  const where = [];
  const binds = [];
  if (q) { where.push("LOWER(name) LIKE ?"); binds.push(`%${q.replace(/[%_]/g,"")}%`); }
  if (cat && RECIPE_FOOD_CATEGORIES.has(cat)) { where.push("category = ?"); binds.push(cat); }
  const sql = "SELECT id, user_id, name, category, default_unit, notes FROM recipe_foods" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY name ASC LIMIT 300";
  const rows = await env.DB.prepare(sql).bind(...binds).all().catch(() => ({ results: [] }));
  return json({
    foods: (rows.results || []).map((r) => ({
      id: r.id, name: r.name, category: r.category, defaultUnit: r.default_unit,
      notes: r.notes, isMine: r.user_id === user.id, isGlobal: !r.user_id,
    })),
  });
}

async function createRecipeFood(request, env, user) {
  await ensureRecipeSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const name = sanitizeText(body.name, 100);
  if (!name) return json({ error: "Name required" }, 400);
  const category = RECIPE_FOOD_CATEGORIES.has(body.category) ? body.category : "other";
  const unit = RECIPE_FOOD_UNITS.has(body.defaultUnit) ? body.defaultUnit : (body.defaultUnit ? sanitizeText(body.defaultUnit, 20) : null);
  const notes = sanitizeText(body.notes, 200) || null;
  // De-dupe by lowercased name so we don't end up with 200 versions of "Eggs".
  const existing = await env.DB.prepare(
    "SELECT id FROM recipe_foods WHERE LOWER(name) = LOWER(?) LIMIT 1"
  ).bind(name).first().catch(() => null);
  if (existing) return json({ ok: true, id: existing.id, deduped: true });

  const res = await env.DB.prepare(
    "INSERT INTO recipe_foods (user_id, name, category, default_unit, notes, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(user.id, name, category, unit, notes, nowSec()).run();
  return json({ ok: true, id: res.meta?.last_row_id });
}

function clampIntOrNull(v, lo, hi) {
  if (v == null || v === "") return null;
  const n = +v;
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// =============================================================================
// DOCUMENTS — private file storage backed by Cloudflare R2.
// Each user can only ever see their own. R2 keys are namespaced under
// `users/<user_id>/...` so accidental cross-user reads are not possible.
// =============================================================================

const MAX_DOC_BYTES = 20 * 1024 * 1024;   // 20 MB upload cap
const ALLOWED_DOC_KINDS = new Set(["ultrasound", "report", "lab", "image", "scan", "letter", "prescription", "other"]);
const ALLOWED_DOC_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/heic", "image/heif",
  "application/pdf",
  "text/plain", "text/csv",
]);

let _docSchemaChecked = false;
async function ensureDocSchema(env) {
  if (_docSchemaChecked) return;
  _docSchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS documents (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  r2_key TEXT NOT NULL UNIQUE," +
    "  filename TEXT NOT NULL," +
    "  content_type TEXT," +
    "  size_bytes INTEGER," +
    "  kind TEXT," +
    "  notes TEXT," +
    "  uploaded_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, uploaded_at DESC)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

function requireDocsBinding(env) {
  return !!env.DOCS && typeof env.DOCS.put === "function";
}

async function listDocuments(env, user) {
  await ensureDocSchema(env);
  const rows = await env.DB.prepare(
    "SELECT id, filename, content_type, size_bytes, kind, notes, uploaded_at " +
    "FROM documents WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 200"
  ).bind(user.id).all().catch(() => ({ results: [] }));
  return json({
    ok: true,
    storageReady: requireDocsBinding(env),
    documents: (rows.results || []).map((r) => ({
      id: r.id, filename: r.filename, contentType: r.content_type,
      sizeBytes: r.size_bytes, kind: r.kind, notes: r.notes,
      uploadedAt: r.uploaded_at,
    })),
  });
}

async function uploadDocument(request, env, user) {
  await ensureDocSchema(env);
  if (!requireDocsBinding(env)) {
    return json({
      error: "Document storage isn't configured yet. An admin needs to add an R2 bucket binding called `DOCS` to wrangler.toml.",
    }, 503);
  }

  // Pull metadata from headers — the body is the raw file bytes.
  const filename = sanitizeText(request.headers.get("x-filename") || "", 200) || "upload.bin";
  const kindRaw  = (request.headers.get("x-kind") || "other").toLowerCase();
  const kind     = ALLOWED_DOC_KINDS.has(kindRaw) ? kindRaw : "other";
  const notes    = sanitizeText(request.headers.get("x-notes") || "", 500);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  if (!ALLOWED_DOC_TYPES.has(contentType.split(";")[0].trim())) {
    return json({ error: "Unsupported file type. Use PDF, images, or plain text." }, 415);
  }
  const declared = +request.headers.get("content-length") || 0;
  if (declared && declared > MAX_DOC_BYTES) {
    return json({ error: "File too big — max 20 MB per upload." }, 413);
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return json({ error: "File is empty." }, 400);
  if (buf.byteLength > MAX_DOC_BYTES) return json({ error: "File too big — max 20 MB per upload." }, 413);

  // Generate a random, unguessable key namespaced under the user. Means a
  // hostile party can't enumerate someone else's docs even if R2 were ever
  // misconfigured for public reads.
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "upload";
  const r2Key = `users/${user.id}/${nowSec()}-${rand}-${safeName}`;

  await env.DOCS.put(r2Key, buf, {
    httpMetadata: { contentType },
    customMetadata: { userId: user.id, filename, kind, uploadedAt: String(nowSec()) },
  });

  const res = await env.DB.prepare(
    "INSERT INTO documents (user_id, r2_key, filename, content_type, size_bytes, kind, notes, uploaded_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(user.id, r2Key, filename, contentType, buf.byteLength, kind, notes, nowSec()).run();
  return json({ ok: true, id: res.meta?.last_row_id, filename, kind, sizeBytes: buf.byteLength });
}

async function streamDocument(env, user, id) {
  await ensureDocSchema(env);
  if (!requireDocsBinding(env)) return json({ error: "Document storage not configured" }, 503);
  const row = await env.DB.prepare(
    "SELECT r2_key, filename, content_type FROM documents WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!row) return new Response("Not found", { status: 404 });

  const obj = await env.DOCS.get(row.r2_key);
  if (!obj) return new Response("File missing", { status: 404 });

  const headers = new Headers({
    "Content-Type":        row.content_type || "application/octet-stream",
    "Content-Disposition": `inline; filename="${row.filename.replace(/"/g, '')}"`,
    "Cache-Control":       "private, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy":     "no-referrer",
  });
  return new Response(obj.body, { status: 200, headers });
}

async function deleteDocument(env, user, id) {
  await ensureDocSchema(env);
  const row = await env.DB.prepare(
    "SELECT r2_key FROM documents WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!row) return json({ error: "Document not found" }, 404);
  if (requireDocsBinding(env)) {
    try { await env.DOCS.delete(row.r2_key); } catch (err) { console.warn("R2 delete:", err?.message || err); }
  }
  await env.DB.prepare("DELETE FROM documents WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}

// =============================================================================
// DONATIONS — Stripe Checkout for endo-research crowdfunding.
// Milestones are constants on the server so the roadmap is stable across
// reloads. Anyone can donate (signed-in or not); the leaderboard names
// only what the donor chose to share.
// =============================================================================

const DONATION_CURRENCY = "aud";
const DONATION_MIN_CENTS = 200;      // $2 floor — keeps spam + Stripe fees sensible
const DONATION_MAX_CENTS = 50000000; // $500k ceiling per single donation
const MAX_DONOR_NAME_LEN = 60;
const MAX_DONOR_MSG_LEN  = 240;

// The roadmap. Plain-English steps so anyone can follow the path from "AI
// turned on" to "first patient trial". Amounts mirror real AU/UK academic
// research costs: salaries with on-costs, wet-lab assays, contract research,
// and small investigator-led repurposed-drug pilots.
const DONATION_MILESTONES = [
  { key: "ai-engine",     targetCents:   1000000, emoji: "🤖", title: "Switch on the AI engine",
    summary: "We turn on an always-on AI that reads every new endometriosis paper, trial and patient log around the clock. The legwork no single researcher could keep up with. Donations keep it running, paying for the compute, tooling and hosting." },
  { key: "subproblems",   targetCents:   2500000, emoji: "🧩", title: "Break endo into its sub-problems",
    summary: "The engine breaks endometriosis down into its main moving parts — inflammation, excess oestrogen, immune confusion, nerve sensitisation — and ranks the biggest, most fixable opportunities to attack each one. The first plain-English map of what's actually broken." },
  { key: "dashboard",     targetCents:   5000000, emoji: "📊", title: "Public research dashboard",
    summary: "A simple website where anyone can see what the engine has found: which inflammation pathways look most fixable, which oestrogen targets are weakest in endo, and which existing drugs already hit those targets elsewhere. Every claim cited to a source study. Free for everyone, forever." },
  { key: "scientist-yr",  targetCents:   7500000, emoji: "🧪", title: "Hire a research scientist for a year",
    summary: "We pay a research scientist their full salary for 12 months. Their only job: take the engine's top findings, turn them into real lab experiments, and line up the partners who can run them." },
  { key: "wet-lab",       targetCents:  20000000, emoji: "🔬", title: "Test 10 candidate drugs in the lab",
    summary: "We partner with an academic lab to test the engine's top 10 candidate drugs against actual endometrial tissue, in petri dishes. The first real-world answer to: does this drug touch the disease?" },
  { key: "animal-study",  targetCents:  50000000, emoji: "🐭", title: "Animal study on the strongest leads",
    summary: "We take the top one or two candidates from the lab and run a proper preclinical animal study. This is the standard last step before any treatment can be tested in humans." },
  { key: "first-trial",   targetCents: 100000000, emoji: "🏥", title: "First-in-patient pilot trial",
    summary: "About 30 patients, recruited transparently from the EndoMe community, get the most promising drug in a multi-site open-label pilot. Every protocol and every result published in public. The doorway to a real treatment." },
];

let _donationsSchemaChecked = false;
async function ensureDonationsSchema(env) {
  if (_donationsSchemaChecked) return;
  _donationsSchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS donations (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT," +
    "  donor_name TEXT," +
    "  donor_message TEXT," +
    "  amount_cents INTEGER NOT NULL," +
    "  currency TEXT NOT NULL DEFAULT 'aud'," +
    "  stripe_session_id TEXT," +
    "  status TEXT NOT NULL DEFAULT 'pending'," + // pending | succeeded | failed
    "  created_at INTEGER NOT NULL," +
    "  completed_at INTEGER" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_donations_status  ON donations(status, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_donations_user    ON donations(user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_donations_session ON donations(stripe_session_id)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

// Compute milestone status + progress from the running total.
function donationRoadmap(totalCents) {
  let cumulative = 0;
  let activeIndex = -1;
  const out = DONATION_MILESTONES.map((m, i) => {
    cumulative += m.targetCents;
    const reached = totalCents >= cumulative;
    if (!reached && activeIndex < 0) activeIndex = i;
    const baseline = cumulative - m.targetCents;
    const progressInThisStep = Math.max(0, Math.min(m.targetCents, totalCents - baseline));
    return {
      key:        m.key,
      emoji:      m.emoji,
      title:      m.title,
      summary:    m.summary,
      targetCents: m.targetCents,
      cumulativeCents: cumulative,
      reached,
      progress:   Math.round((progressInThisStep / m.targetCents) * 100),
    };
  });
  return { milestones: out, activeIndex, totalGoalCents: cumulative };
}

async function getDonationTotals(env) {
  await ensureDonationsSchema(env);
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total FROM donations WHERE status = 'succeeded'"
  ).first().catch(() => ({ n: 0, total: 0 }));
  const totalCents = row?.total || 0;
  const roadmap = donationRoadmap(totalCents);
  return json({
    currency: DONATION_CURRENCY.toUpperCase(),
    totalCents,
    donationCount: row?.n || 0,
    milestones: roadmap.milestones,
    activeIndex: roadmap.activeIndex,
    totalGoalCents: roadmap.totalGoalCents,
  });
}

async function getDonationLeaderboard(env) {
  await ensureDonationsSchema(env);
  const rows = await env.DB.prepare(
    "SELECT donor_name, donor_message, amount_cents, completed_at " +
    "FROM donations WHERE status = 'succeeded' " +
    "ORDER BY amount_cents DESC, completed_at DESC LIMIT 25"
  ).all().catch(() => ({ results: [] }));
  return json({
    currency: DONATION_CURRENCY.toUpperCase(),
    donors: (rows.results || []).map((r) => ({
      name:    r.donor_name || "Anonymous",
      message: r.donor_message || null,
      amountCents: r.amount_cents,
      at: r.completed_at,
    })),
  });
}

async function postDonationCheckout(request, env, viewer) {
  await ensureDonationsSchema(env);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Donations aren't configured yet." }, 503);

  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  const cents = Math.round(Number(body.amountCents) || 0);
  if (!Number.isFinite(cents) || cents < DONATION_MIN_CENTS) {
    return json({ error: `Minimum donation is $${(DONATION_MIN_CENTS / 100).toFixed(2)} ${DONATION_CURRENCY.toUpperCase()}.` }, 400);
  }
  if (cents > DONATION_MAX_CENTS) {
    return json({ error: "That's incredibly generous — please contact us directly for large donations." }, 400);
  }
  const donorName    = sanitizeText(body.donorName, MAX_DONOR_NAME_LEN) || (viewer ? null : null);
  const donorMessage = sanitizeText(body.donorMessage, MAX_DONOR_MSG_LEN);
  const anonymous    = body.anonymous === true || body.anonymous === "true";

  // If viewer is signed in and didn't blank out / opt-out, default their alias.
  let displayName = donorName;
  if (!displayName && viewer && !anonymous) {
    try {
      const row = await env.DB.prepare(
        "SELECT alias, display_name, username FROM users WHERE id = ?"
      ).bind(viewer.id).first();
      displayName = (row?.alias || row?.display_name || row?.username) || null;
    } catch {}
  }
  if (anonymous) displayName = "Anonymous";

  const now = nowSec();
  const ins = await env.DB.prepare(
    "INSERT INTO donations (user_id, donor_name, donor_message, amount_cents, currency, status, created_at) " +
    "VALUES (?, ?, ?, ?, ?, 'pending', ?)"
  ).bind(viewer?.id || null, displayName, donorMessage, cents, DONATION_CURRENCY, now).run();
  const donationId = ins.meta?.last_row_id;

  const siteUrl = (env.SITE_URL || "https://endome.com").replace(/\/$/, "");
  // returnTo lets the client choose which page Stripe redirects back to —
  // homepage, public /donate, or the signed-in /research view. Locked to a
  // small allowlist so we can't be turned into an open redirect.
  const safeReturns = new Set(["/", "/donate", "/research"]);
  const requestedReturn = typeof body.returnTo === "string" ? body.returnTo : "";
  const returnTo = safeReturns.has(requestedReturn) ? requestedReturn : "/donate";
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][price_data][currency]", DONATION_CURRENCY);
  form.set("line_items[0][price_data][product_data][name]", "EndoMe research donation");
  form.set("line_items[0][price_data][product_data][description]", "Funds endometriosis research via the EndoMe roadmap.");
  form.set("line_items[0][price_data][unit_amount]", String(cents));
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", `${siteUrl}${returnTo}?donation=success&session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url",  `${siteUrl}${returnTo}?donation=cancelled`);
  form.set("allow_promotion_codes", "false");
  form.set("submit_type", "donate");
  form.set("metadata[donation_id]", String(donationId));
  form.set("metadata[user_id]", viewer?.id || "");

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
    console.error("donation checkout failed", res.status, text);
    return json({ error: "Couldn't start checkout. Try again in a moment." }, 502);
  }
  const data = await res.json();
  // Store the session id so the webhook can match the donation back.
  try {
    await env.DB.prepare("UPDATE donations SET stripe_session_id = ? WHERE id = ?")
      .bind(data.id, donationId).run();
  } catch {}
  return json({ ok: true, url: data.url, donationId });
}

// Called from handleStripeWebhook when a checkout session completes with
// metadata.donation_id set. Marks the donation succeeded and timestamps it.
async function completeDonation(env, session) {
  await ensureDonationsSchema(env);
  const donationId = session.metadata?.donation_id ? +session.metadata.donation_id : null;
  if (!donationId) return false;
  const amount = session.amount_total ?? 0;
  await env.DB.prepare(
    "UPDATE donations SET status = 'succeeded', completed_at = ?, amount_cents = ? WHERE id = ?"
  ).bind(nowSec(), amount || 0, donationId).run();
  return true;
}

// =============================================================================
// ADMIN CONTROL PANEL (/acp) — env-var admin only.
// Lists users + circles, sets per-circle member roles, adds/removes members.
// =============================================================================

const ACP_CIRCLE_ROLES = new Set(["member", "moderator", "admin"]);

function isAdminSession(env, session) {
  const cfgUser = (env.AUTH_USERNAME || "").toLowerCase();
  if (!cfgUser || !session?.u) return false;
  return timingSafeEqual(String(session.u).toLowerCase(), cfgUser);
}

async function handleAcp(request, env, url) {
  const path = url.pathname.slice("/api/acp".length); // e.g. "/users"

  if (path === "/me" && request.method === "GET") {
    return json({ ok: true, admin: true });
  }

  // Force-run the schema bootstrap and report per-step results. Useful
  // after pulling a release that adds new tables on a host you don't
  // have CLI access to.
  if (path === "/bootstrap" && request.method === "POST") {
    return await adminBootstrapSchema(env);
  }

  if (path === "/users" && request.method === "GET") {
    return await acpListUsers(env, url);
  }

  if (path === "/circles" && request.method === "GET") {
    return await acpListCircles(env);
  }

  const circleMembers = path.match(/^\/circles\/(\d+)\/members$/);
  if (circleMembers && request.method === "GET") {
    return await acpListMembers(env, +circleMembers[1]);
  }
  if (circleMembers && request.method === "POST") {
    return await acpAddMember(request, env, +circleMembers[1]);
  }

  const memberRole = path.match(/^\/circles\/(\d+)\/members\/([^\/]+)$/);
  if (memberRole && request.method === "PUT") {
    return await acpSetRole(request, env, +memberRole[1], decodeURIComponent(memberRole[2]));
  }
  if (memberRole && request.method === "DELETE") {
    return await acpRemoveMember(env, +memberRole[1], decodeURIComponent(memberRole[2]));
  }

  return json({ error: "Not found" }, 404);
}

async function acpListUsers(env, url) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 60);
  let rows = { results: [] };
  try {
    if (q) {
      const like = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
      rows = await env.DB.prepare(
        "SELECT u.id, u.username, u.email, u.display_name, u.created_at, " +
        "       (SELECT COUNT(*) FROM circle_members m WHERE m.user_id = u.id) AS circle_count, " +
        "       (SELECT COUNT(*) FROM symptoms s WHERE s.user_id = u.id) AS symptom_count " +
        "FROM users u " +
        "WHERE LOWER(u.username) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\' OR LOWER(u.display_name) LIKE ? ESCAPE '\\' " +
        "ORDER BY u.created_at DESC LIMIT 200"
      ).bind(like, like, like).all();
    } else {
      rows = await env.DB.prepare(
        "SELECT u.id, u.username, u.email, u.display_name, u.created_at, " +
        "       (SELECT COUNT(*) FROM circle_members m WHERE m.user_id = u.id) AS circle_count, " +
        "       (SELECT COUNT(*) FROM symptoms s WHERE s.user_id = u.id) AS symptom_count " +
        "FROM users u ORDER BY u.created_at DESC LIMIT 200"
      ).all();
    }
  } catch (err) {
    console.warn("acpListUsers:", err?.message || err);
  }
  return json({
    users: (rows.results || []).map((u) => ({
      id: u.id, username: u.username, email: u.email || null,
      displayName: u.display_name || null, createdAt: u.created_at,
      circleCount: u.circle_count || 0, symptomCount: u.symptom_count || 0,
    })),
  });
}

async function acpListCircles(env) {
  let rows = { results: [] };
  try {
    rows = await env.DB.prepare(
      "SELECT c.id, c.slug, c.name, c.description, c.is_official, c.is_open, c.created_at, " +
      "       (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id = c.id) AS member_count, " +
      "       (SELECT COUNT(*) FROM circle_posts p WHERE p.circle_id = c.id AND p.deleted_at IS NULL) AS post_count " +
      "FROM circles c ORDER BY c.is_official DESC, c.created_at DESC LIMIT 200"
    ).all();
  } catch (err) {
    console.warn("acpListCircles:", err?.message || err);
  }
  return json({
    circles: (rows.results || []).map((c) => ({
      id: c.id, slug: c.slug, name: c.name, description: c.description,
      isOfficial: !!c.is_official, isOpen: !!c.is_open, createdAt: c.created_at,
      memberCount: c.member_count || 0, postCount: c.post_count || 0,
    })),
  });
}

async function acpListMembers(env, circleId) {
  const circle = await env.DB.prepare(
    "SELECT id, slug, name FROM circles WHERE id = ?"
  ).bind(circleId).first().catch(() => null);
  if (!circle) return json({ error: "Circle not found" }, 404);

  let rows = { results: [] };
  try {
    rows = await env.DB.prepare(
      "SELECT m.user_id, m.role, m.joined_at, u.username, u.display_name, u.email " +
      "FROM circle_members m LEFT JOIN users u ON u.id = m.user_id " +
      "WHERE m.circle_id = ? " +
      "ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, m.joined_at ASC " +
      "LIMIT 500"
    ).bind(circleId).all();
  } catch (err) { console.warn("acpListMembers:", err?.message || err); }
  return json({
    circle: { id: circle.id, slug: circle.slug, name: circle.name },
    members: (rows.results || []).map((m) => ({
      userId: m.user_id, role: m.role, joinedAt: m.joined_at,
      username: m.username, displayName: m.display_name || null, email: m.email || null,
    })),
  });
}

async function acpAddMember(request, env, circleId) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const userId = sanitizeText(body.userId, 200);
  const role = ACP_CIRCLE_ROLES.has(body.role) ? body.role : "member";
  if (!userId) return json({ error: "userId is required" }, 400);

  const circle = await env.DB.prepare("SELECT id FROM circles WHERE id = ?")
    .bind(circleId).first().catch(() => null);
  if (!circle) return json({ error: "Circle not found" }, 404);

  const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(userId).first().catch(() => null);
  if (!user) return json({ error: "User not found" }, 404);

  await env.DB.prepare(
    "INSERT INTO circle_members (circle_id, user_id, role, joined_at) " +
    "VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(circle_id, user_id) DO UPDATE SET role = excluded.role"
  ).bind(circleId, userId, role, nowSec()).run();
  return json({ ok: true });
}

async function acpSetRole(request, env, circleId, userId) {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const role = ACP_CIRCLE_ROLES.has(body.role) ? body.role : null;
  if (!role) return json({ error: "role must be member/moderator/admin" }, 400);

  const existing = await env.DB.prepare(
    "SELECT 1 FROM circle_members WHERE circle_id = ? AND user_id = ?"
  ).bind(circleId, userId).first().catch(() => null);
  if (!existing) return json({ error: "User is not in this circle. Add them first." }, 404);

  await env.DB.prepare(
    "UPDATE circle_members SET role = ? WHERE circle_id = ? AND user_id = ?"
  ).bind(role, circleId, userId).run();
  return json({ ok: true, role });
}

async function acpRemoveMember(env, circleId, userId) {
  // Don't strand official circles without any admin — but allow if other admins exist.
  const circle = await env.DB.prepare(
    "SELECT id, is_official FROM circles WHERE id = ?"
  ).bind(circleId).first().catch(() => null);
  if (!circle) return json({ error: "Circle not found" }, 404);

  if (circle.is_official) {
    const otherAdmins = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM circle_members WHERE circle_id = ? AND role = 'admin' AND user_id != ?"
    ).bind(circleId, userId).first().catch(() => ({ n: 0 }));
    const meRow = await env.DB.prepare(
      "SELECT role FROM circle_members WHERE circle_id = ? AND user_id = ?"
    ).bind(circleId, userId).first().catch(() => null);
    if (meRow?.role === "admin" && (otherAdmins?.n || 0) === 0) {
      return json({ error: "Can't remove the last admin of an official circle." }, 400);
    }
  }

  await env.DB.prepare(
    "DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?"
  ).bind(circleId, userId).run();
  return json({ ok: true });
}
