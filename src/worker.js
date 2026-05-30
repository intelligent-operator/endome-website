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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- API routes ---------------------------------------------------------
    if (url.pathname.startsWith("/api/")) {
      try {
        // Public image fetches sit at the very top of the API handler so
        // they're never swallowed by the unmatched-route 404 below. They
        // don't need auth — anyone can pull a user's avatar or a recipe
        // photo so posts, circles and recipe cards can embed them freely.
        const avatarMatch = url.pathname.match(/^\/api\/u\/([^/]+)\/avatar$/);
        if (avatarMatch && request.method === "GET") {
          return withSecurityHeaders(await serveAvatar(env, decodeURIComponent(avatarMatch[1])));
        }
        const recipeImgMatch = url.pathname.match(/^\/api\/r\/(\d+)\/image$/);
        if (recipeImgMatch && request.method === "GET") {
          return withSecurityHeaders(await serveRecipeImage(env, +recipeImgMatch[1]));
        }

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
          if (url.pathname === "/api/me/med-prefs" && request.method === "GET") {
            return jsonHeaders(await getMedPrefs(env, user));
          }
          if (url.pathname === "/api/me/med-prefs" && request.method === "PUT") {
            return jsonHeaders(await updateMedPrefs(request, env, user));
          }
          if (url.pathname === "/api/me/doses-due" && request.method === "GET") {
            return jsonHeaders(await getDosesDue(env, user));
          }

          // --- Food diary --------------------------------------------------
          if (url.pathname === "/api/me/foods" && request.method === "GET")  return jsonHeaders(await listFoods(env, user));
          if (url.pathname === "/api/me/foods" && request.method === "POST") return jsonHeaders(await createFood(request, env, user));
          const foodMatch = url.pathname.match(/^\/api\/me\/foods\/(\d+)$/);
          if (foodMatch) {
            const fid = +foodMatch[1];
            if (request.method === "PUT")    return jsonHeaders(await updateFood(request, env, user, fid));
            if (request.method === "DELETE") return jsonHeaders(await deleteFood(env, user, fid));
          }
          if (url.pathname === "/api/me/food-logs" && request.method === "POST") return jsonHeaders(await logFood(request, env, user));
          if (url.pathname === "/api/me/food-logs/week" && request.method === "GET") return jsonHeaders(await getFoodWeek(env, user));
          if (url.pathname === "/api/me/food-logs" && request.method === "GET") {
            return jsonHeaders(await getFoodDay(env, user, url.searchParams.get("date")));
          }
          const flogMatch = url.pathname.match(/^\/api\/me\/food-logs\/(\d+)$/);
          if (flogMatch && request.method === "DELETE") return jsonHeaders(await deleteFoodLog(env, user, +flogMatch[1]));
          if (url.pathname === "/api/me/food-plans" && request.method === "GET")  return jsonHeaders(await listFoodPlans(env, user));
          if (url.pathname === "/api/me/food-plans" && request.method === "POST") return jsonHeaders(await createFoodPlan(request, env, user));
          const fplanMatch = url.pathname.match(/^\/api\/me\/food-plans\/(\d+)$/);
          if (fplanMatch && request.method === "DELETE") return jsonHeaders(await deleteFoodPlan(env, user, +fplanMatch[1]));
          if (url.pathname === "/api/me/food-prefs" && request.method === "GET") return jsonHeaders(await getFoodPrefs(env, user));
          if (url.pathname === "/api/me/food-prefs" && request.method === "PUT") return jsonHeaders(await updateFoodPrefs(request, env, user));
          if (url.pathname === "/api/me/cravings" && request.method === "GET")  return jsonHeaders(await listCravings(env, user));
          if (url.pathname === "/api/me/cravings" && request.method === "POST") return jsonHeaders(await logCraving(request, env, user));
          const cravingMatch = url.pathname.match(/^\/api\/me\/cravings\/(\d+)$/);
          if (cravingMatch && request.method === "DELETE") return jsonHeaders(await deleteCraving(env, user, +cravingMatch[1]));
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
            if (action === "miss" && request.method === "POST") return jsonHeaders(await missMedicationDose(request, env, user, id));
            if (action === "logs" && request.method === "GET")  return jsonHeaders(await getMedicationLogs(env, user, id));
          }

          // --- Appointments (calendar + reminders) -----------------------
          if (url.pathname === "/api/me/appointments" && request.method === "GET") {
            return jsonHeaders(await listAppointments(request, env, user));
          }
          if (url.pathname === "/api/me/appointments" && request.method === "POST") {
            return jsonHeaders(await createAppointment(request, env, user, ctx));
          }
          if (url.pathname === "/api/me/appointments/upcoming" && request.method === "GET") {
            return jsonHeaders(await listUpcomingAppointments(env, user));
          }
          const apptMatch = url.pathname.match(/^\/api\/me\/appointments\/(\d+)$/);
          if (apptMatch) {
            const id = +apptMatch[1];
            if (request.method === "GET")    return jsonHeaders(await getAppointment(env, user, id));
            if (request.method === "PUT")    return jsonHeaders(await updateAppointment(request, env, user, id, ctx));
            if (request.method === "DELETE") return jsonHeaders(await deleteAppointment(env, user, id));
          }

          // --- Recipes (community cookbook) ------------------------------
          if (url.pathname === "/api/me/recipes" && request.method === "GET") {
            return jsonHeaders(await listRecipes(request, env, user));
          }
          if (url.pathname === "/api/me/recipes" && request.method === "POST") {
            return jsonHeaders(await createRecipe(request, env, user));
          }
          if (url.pathname === "/api/me/recipes/top" && request.method === "GET") {
            return jsonHeaders(await listTopRecipes(env, user));
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
            if (!action     && request.method === "PUT")    return jsonHeaders(await updateRecipe(request, env, user, id));
            if (!action     && request.method === "DELETE") return jsonHeaders(await deleteRecipe(env, user, id));
            if (action === "react" && request.method === "POST") return jsonHeaders(await postRecipeReaction(request, env, user, id));
            if (action === "image" && request.method === "POST")   return jsonHeaders(await uploadRecipeImage(request, env, user, id));
            if (action === "image" && request.method === "DELETE") return jsonHeaders(await deleteRecipeImage(env, user, id));
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
            return jsonHeaders(await getMeToday(request, env, user, ctx));
          }
          if (url.pathname === "/api/me/checkin/morning" && request.method === "POST") {
            return jsonHeaders(await postMorningCheckin(request, env, user));
          }
          if (url.pathname === "/api/me/checkin/afternoon" && request.method === "POST") {
            return jsonHeaders(await postAfternoonCheckin(request, env, user));
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
          if (url.pathname === "/api/me/body-pain-map" && request.method === "GET") {
            return jsonHeaders(await getBodyPainMap(env, user));
          }
          if (url.pathname === "/api/me/week" && request.method === "GET") {
            return jsonHeaders(await getMeWeek(env, user));
          }
          if (url.pathname === "/api/me/notifications" && request.method === "GET") {
            return jsonHeaders(await getNotifications(env, user, ctx));
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
          if (url.pathname === "/api/me/endo" && request.method === "GET")  return jsonHeaders(await getEndoStatus(env, user));
          if (url.pathname === "/api/me/endo" && request.method === "PUT")  return jsonHeaders(await updateEndoStatus(request, env, user));
          if (url.pathname === "/api/me/early-dx-watch" && request.method === "GET") return jsonHeaders(await getEndoPatternWatch(env, user));
          if (url.pathname === "/api/me/cycle-correlation" && request.method === "GET") return jsonHeaders(await computeCycleCorrelation(env, user));

          // --- Buddy chatbot ----------------------------------------------
          if (url.pathname === "/api/me/buddy/conversations" && request.method === "GET")  return jsonHeaders(await listBuddyConversations(env, user));
          if (url.pathname === "/api/me/buddy/conversations" && request.method === "POST") return jsonHeaders(await createBuddyConversation(env, user));
          const buddyConvMatch = url.pathname.match(/^\/api\/me\/buddy\/conversations\/(\d+)$/);
          if (buddyConvMatch) {
            const cid = +buddyConvMatch[1];
            if (request.method === "GET")    return jsonHeaders(await getBuddyConversation(env, user, cid));
            if (request.method === "DELETE") return jsonHeaders(await deleteBuddyConversation(env, user, cid));
          }
          const buddyMsgMatch = url.pathname.match(/^\/api\/me\/buddy\/conversations\/(\d+)\/messages$/);
          if (buddyMsgMatch && request.method === "POST") return jsonHeaders(await sendBuddyMessage(request, env, user, +buddyMsgMatch[1]));
          if (url.pathname === "/api/me/avatar" && request.method === "POST") {
            return jsonHeaders(await uploadAvatar(request, env, user));
          }
          if (url.pathname === "/api/me/avatar" && request.method === "DELETE") {
            return jsonHeaders(await deleteAvatar(env, user));
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
          if (url.pathname === "/api/me/test-results" && request.method === "GET") {
            return jsonHeaders(await listTestResults(env, user));
          }
          const trMatch = url.pathname.match(/^\/api\/me\/test-results\/(\d+)$/);
          if (trMatch && request.method === "GET") {
            return jsonHeaders(await getTestResult(env, user, +trMatch[1]));
          }
          // --- AI insights (Claude on Bedrock) -------------------------------
          if (url.pathname === "/api/me/insights" && request.method === "GET") {
            return jsonHeaders(await listInsights(env, user));
          }
          const insightRunMatch = url.pathname.match(/^\/api\/me\/insights\/([a-z0-9-]+)\/run$/);
          if (insightRunMatch && request.method === "POST") {
            return jsonHeaders(await runInsight(env, user, insightRunMatch[1], ctx));
          }
          const dismissMatch = url.pathname.match(/^\/api\/me\/notifications\/(\d+)\/dismiss$/);
          if (dismissMatch && request.method === "POST") {
            return jsonHeaders(await dismissNotification(env, user, +dismissMatch[1]));
          }
          if (url.pathname === "/api/me/notifications/read-all" && request.method === "POST") {
            return jsonHeaders(await markAllNotificationsRead(env, user));
          }
          const readMatch = url.pathname.match(/^\/api\/me\/notifications\/([^/]+)\/read$/);
          if (readMatch && request.method === "POST") {
            return jsonHeaders(await markNotificationRead(env, user, decodeURIComponent(readMatch[1])));
          }
          const virtDismissMatch = url.pathname.match(/^\/api\/me\/notifications\/([^/]+)\/dismiss$/);
          if (virtDismissMatch && request.method === "POST") {
            return jsonHeaders(await dismissVirtualNotification(env, user, decodeURIComponent(virtDismissMatch[1])));
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
      url.pathname === "/food"        || url.pathname.startsWith("/food/") ||
      url.pathname === "/buddy"       || url.pathname.startsWith("/buddy/") ||
      url.pathname === "/documents"   || url.pathname.startsWith("/documents/") ||
      url.pathname === "/security"    || url.pathname.startsWith("/security/") ||
      url.pathname === "/research"    || url.pathname.startsWith("/research/") ||
      url.pathname === "/recipes"     || url.pathname.startsWith("/recipes/") ||
      url.pathname === "/appointments" || url.pathname.startsWith("/appointments/") ||
      url.pathname === "/results"     || url.pathname.startsWith("/results/") ||
      url.pathname === "/my-insights" || url.pathname.startsWith("/my-insights/") ||
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

  // Cloudflare cron entrypoint — see [triggers] in wrangler.toml.
  // Two crons share this one handler; we dispatch on event.cron.
  async scheduled(event, env, ctx) {
    if (event.cron === "0 7 1 * *") {
      // 1st of month, 07:00 UTC — regenerate the "monthly-summary" insight
      // for every active user so it's fresh next time they open the page.
      ctx.waitUntil(runMonthlyInsightsForAllUsers(env, ctx, event));
      return;
    }
    if (event.cron === "*/15 * * * *") {
      // Every 15 min — for users on the "assume taken" policy, log any
      // scheduled doses whose time has passed within the last 15 min.
      ctx.waitUntil(autoMarkScheduledDoses(env, ctx));
      return;
    }
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
  // specific moods (replaced the generic "mood" chip in 2026-05)
  "mood_happy", "mood_sad", "mood_angry", "mood_anxious", "mood_irritable", "mood_numb",
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
const ALLOWED_RELIEF   = new Set(["heat","tens","rest","medication","hydration","movement","massage","bath","sleep","none"]);
const ALLOWED_EVENING_SYMPTOMS = new Set([
  // Original light tags
  "bloating", "ovulation_pain", "nausea", "fatigue", "headaches",
  "dizziness", "pms", "skin_breakout",
  // Expanded body-check tags so morning / midday / evening can share one
  // allow-list. Mirrors the symptom logger so taps feel consistent.
  "cramps", "pelvic_pain", "back_pain", "endo_belly", "breast_tender",
  "hot_flash", "brain_fog", "mood", "anxiety", "spotting",
  "painful_urination", "painful_bowel", "painful_sex",
  "joint_pain", "muscle_aches", "constipation",
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
      ensureFoodSchema(env),
      ensureBuddySchema(env),
      ensureAppointmentSchema(env),
      ensureReadSchema(env),
      ensureEmailLogSchema(env),
      ensureTestResultsSchema(env),
      ensureInsightSchema(env),
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
  await run("appointments", ensureAppointmentSchema);
  await run("read_state",   ensureReadSchema);
  await run("email_log",    ensureEmailLogSchema);
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
async function getMeToday(request, env, user, ctx) {
  const url = new URL(request.url);
  const date = normaliseDate(url.searchParams.get("date"));
  // Fire any due email reminders in the background so the page response is
  // never gated by Mandrill latency.
  dispatchDueAppointmentEmails(env, ctx, user).catch(() => {});

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
    user: {
      displayName: user.display_name,
      username: user.username,
      avatar: userRow?.avatar || null,
      avatarUrl: userRow?.avatar_image_key
        ? `/api/u/${encodeURIComponent(user.id)}/avatar`
        : null,
    },
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
    // Suggested values for the morning check-in when the user hasn't
    // logged today yet — keeps cycle day rolling without re-entry.
    cycleSuggested: await suggestCycleForDate(env, user.id, date).catch(() => null),
    symptoms: symptoms.results || [],
    pointsToday: daily?.points_total || 0,
    pet: petResponse(pet),
    tests,
    notifications: [
      ...(notifs.results || []),
      ...(await computeMedReminders(env, user).catch(() => [])),
      ...(await computeAppointmentReminders(env, user).catch(() => [])),
    ],
  });
}

// Suggest a cycle day + phase for `date` based on the most recent past
// daily log that has a cycle_day. We carry yesterday's value forward by
// the number of elapsed days (capped at 60 to avoid silly numbers if the
// last entry was months ago). Phase is suggested only if the inferred
// day still falls in a plausible window for the last logged phase.
async function suggestCycleForDate(env, userId, date) {
  const prior = await env.DB.prepare(
    "SELECT log_date, cycle_day, cycle_phase FROM daily_logs " +
    "WHERE user_id = ? AND log_date < ? AND cycle_day IS NOT NULL " +
    "ORDER BY log_date DESC LIMIT 1"
  ).bind(userId, date).first().catch(() => null);
  if (!prior || !prior.cycle_day) return null;
  // Days elapsed between prior log and target date (UTC, no DST math needed).
  const ms = Date.UTC(...date.split("-").map((s, i) => i === 1 ? +s - 1 : +s))
           - Date.UTC(...prior.log_date.split("-").map((s, i) => i === 1 ? +s - 1 : +s));
  const elapsed = Math.round(ms / 86400000);
  if (elapsed < 1 || elapsed > 60) return null;
  const day = Math.min(60, prior.cycle_day + elapsed);
  return { day, phase: prior.cycle_phase || null };
}

// =============================================================================
// EARLY-DIAGNOSIS PATTERN WATCH
//
// For users on the "not yet diagnosed, please watch" path (endo_status =
// 'unknown' AND wants_early_dx_support = 1), compare their last 60 days of
// logged data against the recognised endometriosis symptom cluster. Each
// marker is a deterministic check the user can audit. If 3+ are present
// over a meaningful window, we surface "What we're noticing" — a card on
// /dashboard, a payload Buddy reads, and a narrative insight Claude writes.
//
// Markers (10) are drawn from clinical reviews of endo presentation:
//   - cyclical pelvic pain         - painful periods
//   - heavy bleeding               - painful urination
//   - painful bowel movements      - painful sex
//   - chronic fatigue              - bloating / endo belly
//   - back pain                    - cyclical GI symptoms
//
// NOT a diagnosis — explicitly framed as "patterns we're seeing".
// =============================================================================
const ENDO_PATTERN_DEFINITIONS = [
  { key: "pelvic_pain_recurring", label: "Recurring pelvic pain",
    why: "Pelvic pain logged on multiple days is the hallmark presentation of endo." },
  { key: "severe_pain",            label: "Severe pain episodes",
    why: "High-severity pain (4-5/5) on more than one day suggests this isn't a one-off." },
  { key: "cyclical_pain",          label: "Pain clustering around your period",
    why: "Pain concentrated in the menstrual phase is one of the strongest endo signals." },
  { key: "heavy_bleeding",         label: "Heavy menstrual bleeding",
    why: "Heavy flow alongside pelvic pain is a recognised endo pattern." },
  { key: "painful_urination",      label: "Painful urination",
    why: "Endometriosis can affect the bladder; painful urination is a known marker." },
  { key: "painful_bowel",          label: "Painful bowel movements",
    why: "Endo can affect the bowel; painful BMs (especially cyclical) are a known marker." },
  { key: "painful_sex",            label: "Painful sex (dyspareunia)",
    why: "Deep painful intercourse is one of the most specific endo symptoms." },
  { key: "chronic_fatigue",        label: "Chronic fatigue",
    why: "Persistent fatigue (beyond what your sleep/iron explain) is common with endo." },
  { key: "endo_belly_bloating",    label: "Bloating / 'endo belly'",
    why: "Recurring abdominal distension that worsens through the day fits the endo pattern." },
  { key: "back_pain",              label: "Recurring lower back pain",
    why: "Cyclical lower-back pain often accompanies pelvic endo." },
];

async function computeEndoPatternWatch(env, user) {
  // Eligibility — only run for users on the "watching" path.
  const u = await env.DB.prepare(
    "SELECT endo_status, wants_early_dx_support FROM users WHERE id = ?"
  ).bind(user.id).first().catch(() => null);
  const eligible = u && u.endo_status === "unknown" && u.wants_early_dx_support === 1;

  const sinceSec = nowSec() - 60 * 86400;
  const sinceDate = new Date(sinceSec * 1000).toISOString().slice(0, 10);

  // Two cheap pulls — symptoms + daily logs over the window.
  const [sympRes, dailyRes] = await Promise.all([
    env.DB.prepare(
      "SELECT log_date, symptom, severity, triggers " +
      "FROM symptoms WHERE user_id = ? AND logged_at >= ?"
    ).bind(user.id, sinceSec).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      "SELECT log_date, cycle_phase, flow, morning_pain, afternoon_pain, evening_overall " +
      "FROM daily_logs WHERE user_id = ? AND log_date >= ?"
    ).bind(user.id, sinceDate).all().catch(() => ({ results: [] })),
  ]);
  const symps = sympRes.results || [];
  const dailies = dailyRes.results || [];
  const totalSyms = symps.length;
  const totalDailies = dailies.length;

  // --- Marker detection -------------------------------------------------
  const hits = (key) => symps.filter((s) => s.symptom === key);
  const distinctDays = (rows) => new Set(rows.map((r) => r.log_date)).size;
  const markers = new Set();

  // 1. Pelvic pain on >= 3 distinct days OR cramps on >= 3 days.
  if (distinctDays(hits("pelvic_pain")) >= 3 || distinctDays(hits("cramps")) >= 3) {
    markers.add("pelvic_pain_recurring");
  }
  // 2. Severe pain (severity 4 or 5 on a 1-5 scale).
  const severeRows = symps.filter((s) =>
    ["pelvic_pain", "cramps", "back_pain", "painful_urination", "painful_bowel", "painful_sex"].includes(s.symptom)
    && (s.severity || 0) >= 4
  );
  if (distinctDays(severeRows) >= 2) markers.add("severe_pain");
  // 3. Cyclical pain — pain symptoms on menstrual-phase days.
  const menstrualDates = new Set(dailies.filter((d) => d.cycle_phase === "menstrual").map((d) => d.log_date));
  const painOnMenstrual = symps.filter((s) =>
    ["pelvic_pain", "cramps", "back_pain"].includes(s.symptom) && menstrualDates.has(s.log_date)
  );
  if (menstrualDates.size >= 2 && distinctDays(painOnMenstrual) >= 2) markers.add("cyclical_pain");
  // 4. Heavy bleeding on >= 2 days.
  if (dailies.filter((d) => d.flow === "heavy").length >= 2) markers.add("heavy_bleeding");
  // 5. Painful urination ever.
  if (hits("painful_urination").length >= 1) markers.add("painful_urination");
  // 6. Painful bowel ever.
  if (hits("painful_bowel").length >= 1) markers.add("painful_bowel");
  // 7. Painful sex ever.
  if (hits("painful_sex").length >= 1) markers.add("painful_sex");
  // 8. Chronic fatigue — fatigue on >= 6 distinct days (~1/wk) in 60d.
  if (distinctDays(hits("fatigue")) >= 6) markers.add("chronic_fatigue");
  // 9. Bloating / endo belly on >= 3 days.
  if (distinctDays(hits("endo_belly")) >= 3 || distinctDays(hits("bloating")) >= 4) {
    markers.add("endo_belly_bloating");
  }
  // 10. Back pain on >= 3 distinct days.
  if (distinctDays(hits("back_pain")) >= 3) markers.add("back_pain");

  const detected = ENDO_PATTERN_DEFINITIONS.filter((p) => markers.has(p.key));
  const score = detected.length;

  return {
    eligible: !!eligible,
    score,
    threshold: 3,
    flagged: eligible && score >= 3,
    sample: { symptomCount: totalSyms, dailyLogCount: totalDailies, windowDays: 60 },
    markers: detected,
    candidateMarkers: ENDO_PATTERN_DEFINITIONS,
    generatedAt: nowSec(),
  };
}

async function getEndoPatternWatch(env, user) {
  return json(await computeEndoPatternWatch(env, user));
}

// =============================================================================
// SYMPTOM-BY-CYCLE CORRELATION
//
// For each cycle day, average the user's symptom severity across the most
// recent cycles on file (default last 3). Returns a per-day series the
// frontend can chart — pain, fatigue, bloating, mood-low, energy-low —
// plus a "cycle days covered" indicator so the user knows how much data
// is behind each point.
//
// All computed deterministically — no Bedrock call, no admin tuning needed.
// Lives at GET /api/me/cycle-correlation.
// =============================================================================
const CYCLE_CORR_TRACKED = [
  // group key      -> list of symptom slugs that aggregate into it
  { key: "pain",     label: "Pain",       color: "#ff4e8a", slugs: ["pelvic_pain","cramps","back_pain","headache","painful_urination","painful_bowel","painful_sex","endo_belly"] },
  { key: "fatigue",  label: "Fatigue",    color: "#9b4f9c", slugs: ["fatigue","brain_fog"] },
  { key: "bloating", label: "Bloating",   color: "#ffb380", slugs: ["bloating","endo_belly","nausea"] },
  { key: "mood",     label: "Mood low",   color: "#a3174f", slugs: ["mood_sad","mood_angry","mood_anxious","mood_irritable","mood_numb","anxiety"] },
];

async function computeCycleCorrelation(env, user) {
  // Pull the last 120 days — enough for ~3-4 cycles of data.
  const since = nowSec() - 120 * 86400;
  const sinceDate = new Date(since * 1000).toISOString().slice(0, 10);

  const [sympRes, dailyRes] = await Promise.all([
    env.DB.prepare(
      "SELECT log_date, symptom, severity FROM symptoms " +
      "WHERE user_id = ? AND logged_at >= ?"
    ).bind(user.id, since).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      "SELECT log_date, cycle_day, cycle_phase, flow, " +
      "       morning_pain, afternoon_pain, evening_overall, " +
      "       morning_energy, afternoon_energy, morning_mood, afternoon_mood " +
      "FROM daily_logs WHERE user_id = ? AND log_date >= ?"
    ).bind(user.id, sinceDate).all().catch(() => ({ results: [] })),
  ]);

  // Map log_date -> cycle_day. Carry the cycle day forward from the most
  // recent daily log that has one if a given date is missing one — same
  // heuristic the morning-modal prefill uses, so the chart matches what
  // the user has been doing manually.
  const cycleDayByDate = new Map();
  const orderedDailies = (dailyRes.results || [])
    .filter((d) => d.cycle_day != null)
    .sort((a, b) => a.log_date.localeCompare(b.log_date));
  for (const d of orderedDailies) cycleDayByDate.set(d.log_date, d.cycle_day);

  // Aggregator: per cycle day -> per group -> { sum, count }.
  const empty = () => Object.fromEntries(CYCLE_CORR_TRACKED.map((g) => [g.key, { sum: 0, count: 0 }]));
  const buckets = new Map(); // cycleDay -> empty()

  function ensure(day) {
    if (!buckets.has(day)) buckets.set(day, empty());
    return buckets.get(day);
  }

  // Symptoms — severity is 1-5; rescale to 0-100 for charting (sev 1 -> 20).
  for (const s of (sympRes.results || [])) {
    const day = cycleDayByDate.get(s.log_date);
    if (!day || day < 1 || day > 45) continue;
    const sev = Math.max(0, Math.min(100, ((+s.severity || 0) / 5) * 100));
    const bucket = ensure(day);
    for (const g of CYCLE_CORR_TRACKED) {
      if (g.slugs.includes(s.symptom)) {
        bucket[g.key].sum += sev;
        bucket[g.key].count += 1;
      }
    }
  }

  // Daily check-in pain/energy/mood (1-5) folded in too — gives us a
  // signal even on days without a discrete symptom entry.
  for (const d of (dailyRes.results || [])) {
    if (d.cycle_day == null || d.cycle_day < 1 || d.cycle_day > 45) continue;
    const bucket = ensure(d.cycle_day);
    // Pain — average of morning/afternoon/evening overall as a proxy.
    const painVals = [d.morning_pain, d.afternoon_pain].filter((v) => v != null);
    if (painVals.length) {
      const avg = painVals.reduce((a, v) => a + v, 0) / painVals.length;
      bucket.pain.sum += (avg / 5) * 100;
      bucket.pain.count += 1;
    }
    // Mood low — invert mood (5=high -> 0 mood-low; 1=low -> 100 mood-low).
    const moodVals = [d.morning_mood, d.afternoon_mood].filter((v) => v != null);
    if (moodVals.length) {
      const avg = moodVals.reduce((a, v) => a + v, 0) / moodVals.length;
      bucket.mood.sum += ((5 - avg) / 4) * 100;
      bucket.mood.count += 1;
    }
    // Fatigue — invert energy.
    const enVals = [d.morning_energy, d.afternoon_energy].filter((v) => v != null);
    if (enVals.length) {
      const avg = enVals.reduce((a, v) => a + v, 0) / enVals.length;
      bucket.fatigue.sum += ((5 - avg) / 4) * 100;
      bucket.fatigue.count += 1;
    }
  }

  // Build a per-day series for the typical cycle range (day 1-35).
  const days = [];
  for (let day = 1; day <= 35; day++) {
    const bucket = buckets.get(day) || empty();
    const out = { day };
    for (const g of CYCLE_CORR_TRACKED) {
      const b = bucket[g.key];
      out[g.key] = b.count ? Math.round(b.sum / b.count) : null;
    }
    days.push(out);
  }

  // Identify the user's "typical" cycle length from the most recent cycles
  // by finding the max day with non-null pain readings — gives the chart
  // a meaningful "you're here" line.
  const maxLoggedDay = days.reduce((m, d) =>
    Object.values(d).some((v) => typeof v === "number" && v > 0) && d.day > m ? d.day : m, 1);

  // What phase corresponds to each day (rough, fixed-window estimate —
  // realistic enough for charting; user's own logged phases take priority
  // wherever they exist).
  const phaseFor = (day) => {
    if (day <= 5) return "menstrual";
    if (day <= 13) return "follicular";
    if (day <= 16) return "ovulation";
    return "luteal";
  };

  // Group counts so we can render a "based on N cycles" caption.
  const cyclesCovered = new Set(orderedDailies.map((d) =>
    d.cycle_day === 1 ? d.log_date : null).filter(Boolean)).size;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const todayCycleDay = cycleDayByDate.get(todayStr) || null;

  return json({
    groups: CYCLE_CORR_TRACKED.map((g) => ({ key: g.key, label: g.label, color: g.color })),
    days: days.map((d) => ({ ...d, phase: phaseFor(d.day) })),
    cyclesCovered: Math.max(1, cyclesCovered),
    maxLoggedDay,
    todayCycleDay,
    sampleSize: {
      symptoms: (sympRes.results || []).length,
      dailyLogs: (dailyRes.results || []).length,
      windowDays: 120,
    },
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

  const dismissed = await getDismissedReminderKeys(env, user);

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
    const key = `med:${s.medication_id}:${s.time_of_day}`;
    if (dismissed.has(key)) continue;
    out.push({
      id: key,
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
  await ensureDailyExtras(env);
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
  // Optional morning body-check multi-select (shares the evening allow-list).
  const morningSymptoms = tagList(body.morningSymptoms, ALLOWED_EVENING_SYMPTOMS);

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
       morning_sleep_hours, morning_sleep_quality, morning_notes, morning_symptoms, morning_logged_at,
       cycle_day, cycle_phase, flow, bbt, cervical_mucus, breast_tenderness,
       points_total)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       morning_mood          = excluded.morning_mood,
       morning_energy        = excluded.morning_energy,
       morning_pain          = excluded.morning_pain,
       morning_sleep_hours   = excluded.morning_sleep_hours,
       morning_sleep_quality = excluded.morning_sleep_quality,
       morning_notes         = excluded.morning_notes,
       morning_symptoms      = excluded.morning_symptoms,
       morning_logged_at     = COALESCE(daily_logs.morning_logged_at, excluded.morning_logged_at),
       cycle_day             = COALESCE(excluded.cycle_day,         daily_logs.cycle_day),
       cycle_phase           = COALESCE(excluded.cycle_phase,       daily_logs.cycle_phase),
       flow                  = COALESCE(excluded.flow,              daily_logs.flow),
       bbt                   = COALESCE(excluded.bbt,               daily_logs.bbt),
       cervical_mucus        = COALESCE(excluded.cervical_mucus,    daily_logs.cervical_mucus),
       breast_tenderness     = COALESCE(excluded.breast_tenderness, daily_logs.breast_tenderness),
       points_total          = daily_logs.points_total + ?17`
  ).bind(
    user.id, date,
    mood, energy, pain,
    sleepHours, sleepQuality, notes, morningSymptoms, now,
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
  await ensureDailyExtras(env);
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
  const relief    = tagList(body.relief, ALLOWED_RELIEF);
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
       evening_symptoms, evening_relief, appetite,
       points_total)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
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
       evening_relief     = COALESCE(excluded.evening_relief,   daily_logs.evening_relief),
       appetite           = COALESCE(excluded.appetite,         daily_logs.appetite),
       points_total       = daily_logs.points_total + ?17`
  ).bind(
    user.id, date,
    overall, reflection, gratitude, now,
    water, movement, bowelCnt, bowelTyp, stress, intimacy, meds,
    evenSyms, relief, appetite,
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

// --- /api/me/body-pain-map ------------------------------------------------
// Aggregate the last 30 days of symptom entries by body region so the
// dashboard's interactive figure can glow red where things hurt.
// Locations are stored as comma-separated free text — we match against the
// fixed vocabulary in the symptom modal.
const BODY_MAP_REGIONS = [
  "Lower abdomen","Pelvis","Ovaries","Uterus","Lower back","Legs","Rectum","Bladder","Other",
];
async function getBodyPainMap(env, user) {
  const today = normaliseDate(null);
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  const startISO = start.toISOString().slice(0, 10);
  let rows = { results: [] };
  try {
    rows = await env.DB.prepare(
      "SELECT log_date, logged_at, symptom, severity, location " +
      "FROM symptoms WHERE user_id = ? AND log_date BETWEEN ? AND ? " +
      "AND location IS NOT NULL AND location <> '' " +
      "ORDER BY logged_at DESC LIMIT 500"
    ).bind(user.id, startISO, today).all();
  } catch (_) { /* table missing — empty */ }

  const regions = {};
  for (const k of BODY_MAP_REGIONS) regions[k] = { count: 0, maxSeverity: 0, lastDate: null, lastSymptom: null };
  for (const r of rows.results || []) {
    const parts = String(r.location || "").split(",").map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      const key = BODY_MAP_REGIONS.find((k) => k.toLowerCase() === p.toLowerCase());
      if (!key) continue;
      const slot = regions[key];
      slot.count += 1;
      if (r.severity > slot.maxSeverity) slot.maxSeverity = r.severity;
      if (!slot.lastDate || r.log_date > slot.lastDate) {
        slot.lastDate = r.log_date;
        slot.lastSymptom = r.symptom;
      }
    }
  }
  return json({ regions, since: startISO });
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
async function getNotifications(env, user, ctx) {
  dispatchDueAppointmentEmails(env, ctx, user).catch(() => {});
  const res = await env.DB
    .prepare(
      "SELECT id, type, title, body, action_url, created_at, read_at " +
      "FROM notifications WHERE user_id = ? AND dismissed_at IS NULL " +
      "ORDER BY created_at DESC LIMIT 50"
    )
    .bind(user.id).all();
  const meds  = await computeMedReminders(env, user).catch(() => []);
  const appts = await computeAppointmentReminders(env, user).catch(() => []);
  return json({ notifications: [...(res.results || []), ...meds, ...appts] });
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
// While the user has put the pet into rest mode, stats are FROZEN — no
// hunger, no happiness loss. The rest START + END endpoints both bump
// last_fed_at / last_played_at to nowSec() so decay doesn't immediately
// "catch up" on the elapsed rest period when the pet wakes.
function liveStats(pet) {
  const now = nowSec();
  if (pet.rest_mode_until && pet.rest_mode_until > now) {
    return {
      hunger: pet.hunger || 0,
      happiness: pet.happiness == null ? 100 : pet.happiness,
    };
  }
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
  const now = nowSec();
  const until = now + days * 86400;
  try {
    // Bump last_fed_at + last_played_at to NOW alongside enabling rest.
    // liveStats() freezes decay during rest mode, so without this the
    // moment rest ends decay would catch up on every elapsed hour.
    await env.DB.prepare(
      "UPDATE pets SET rest_mode_until = ?, last_fed_at = ?, last_played_at = ?, updated_at = ? WHERE user_id = ?"
    ).bind(until, now, now, now, user.id).run();
  } catch (err) {
    console.error("endopet rest failed:", err?.message || err);
    return json({ error: "Couldn't activate Rest Mode." }, 500);
  }
  await endopetRunAllChecks(env, user.id, { restActivated: true });
  return getEndopetState(env, user);
}

async function postEndopetRestEnd(_request, env, user) {
  const now = nowSec();
  try {
    // Bumping last_fed_at + last_played_at on the way out of rest means
    // decay restarts from "now", not from before rest began — pet wakes
    // refreshed rather than instantly hungry from elapsed rest time.
    await env.DB.prepare(
      "UPDATE pets SET rest_mode_until = NULL, last_fed_at = ?, last_played_at = ?, updated_at = ? WHERE user_id = ?"
    ).bind(now, now, now, user.id).run();
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
    "       COALESCE(u.alias, u.display_name) AS author_name, u.username AS author_username, u.avatar AS author_avatar, u.avatar_image_key AS author_avatar_key, u.id AS author_id, u.alias AS author_alias " +
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
      authorAvatarUrl: p.author_avatar_key
        ? "/api/u/" + encodeURIComponent(p.author_id) + "/avatar"
        : null,
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
      "       COALESCE(u.alias, u.display_name) AS author_name, u.username AS author_username, u.avatar AS author_avatar, u.avatar_image_key AS author_avatar_key, u.id AS author_id, u.alias AS author_alias, " +
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
      authorAvatarUrl: p.author_avatar_key
        ? "/api/u/" + encodeURIComponent(p.author_id) + "/avatar"
        : null,
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
      "       COALESCE(u.alias, u.display_name) AS author_name, u.username AS author_username, u.avatar AS author_avatar, u.avatar_image_key AS author_avatar_key, u.id AS author_id, u.alias AS author_alias, " +
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
      authorAvatarUrl: r.author_avatar_key
        ? "/api/u/" + encodeURIComponent(r.author_id) + "/avatar"
        : null,
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
    "ALTER TABLE users ADD COLUMN avatar_image_key TEXT",
    "ALTER TABLE users ADD COLUMN bio TEXT",
    // Endometriosis status — captured during onboarding, editable in /profile.
    // status: 'diagnosed' | 'unknown' (or NULL if user skipped onboarding)
    // stage:  'stage_1' .. 'stage_4' | 'unsure' | NULL
    // wants_early_dx_support: 1 = opt-in to the pattern-based early-flag flow
    "ALTER TABLE users ADD COLUMN endo_status TEXT",
    "ALTER TABLE users ADD COLUMN endo_stage TEXT",
    "ALTER TABLE users ADD COLUMN wants_early_dx_support INTEGER NOT NULL DEFAULT 0",
    // Research consent — opt-in only. ZERO data leaves EndoMe; researchSharedAt
    // records the moment of consent so the consent record is auditable.
    "ALTER TABLE users ADD COLUMN research_share_consent INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN research_consent_at INTEGER",
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
    avatarUrl:   row.avatar_image_key
      ? `/api/u/${encodeURIComponent(row.id)}/avatar`
      : null,
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

// =============================================================================
// BUDDY — health-focused chatbot. Each user has many conversations; each
// conversation has many messages. System prompt is sourced from the
// insight_configs row with slug='buddy-system' so admins can tune it
// through the same /acp UI that drives insight prompts.
// =============================================================================
const BUDDY_DEFAULT_SYSTEM_PROMPT =
  "You are Buddy — a knowledgeable, warm EndoMe companion for someone living with (or investigating) endometriosis. " +
  "Your job is to give SPECIFIC, PRACTICAL, EVIDENCE-AWARE guidance grounded in the user's own logged data and in " +
  "what is known from endometriosis research. You help directly with what you know — you do NOT defer the user " +
  "elsewhere.\n\n" +

  "=== HOW TO HELP (this is the most important part) ===\n" +
  "Every answer must leave the user with something concrete they can act on TODAY. When they describe a problem, " +
  "explain the likely mechanism in plain language, then give 2-4 specific, named options ranked from easiest to most " +
  "involved, with the reasoning and typical doses/approach. Draw confidently on the endometriosis evidence base. " +
  "Examples of the depth and SPECIFICITY expected:\n" +
  "  • Pain / flares → endo pain is largely driven by inflammation and pelvic-floor muscle guarding. Concrete help: " +
  "NAC (N-acetylcysteine) ~600mg 2-3x/day has clinical-trial evidence in endo for reducing inflammation, lesion size " +
  "and pain; heat (heat patch / wheat bag) is as effective as NSAIDs for period pain in studies; magnesium glycinate " +
  "200-400mg for muscle relaxation; omega-3 (EPA/DHA ~2g/day) and curcumin+piperine to lower inflammation; a TENS " +
  "machine; gentle daily mobility, diaphragmatic breathing and pelvic-floor down-training (relaxation, not Kegels).\n" +
  "  • Inflammation → NAC, omega-3, curcumin, vitamin D if low, and cutting ultra-processed food, alcohol and high " +
  "omega-6 seed oils; a lower-FODMAP / anti-inflammatory eating trial when bloating ('endo belly') is prominent.\n" +
  "  • Fatigue → iron/ferritin is commonly depleted by heavy periods (iron-rich food + vitamin C to absorb it), " +
  "vitamin D, B12; pacing and a consistent sleep window.\n" +
  "  • Cyclical pattern → name exactly where in the cycle their flares cluster and have them start anti-inflammatory " +
  "measures 2-3 days BEFORE that window to get ahead of it.\n" +
  "  • Bowel/bladder pain → explain endo can affect the bowel/bladder; give fibre, hydration and bladder-irritant " +
  "(caffeine/alcohol) tactics they can trial now.\n" +
  "Always personalise to what they actually logged (\"your data shows pain spiking around cycle day 26 three months " +
  "running — that luteal pattern is classic, so let's get ahead of it next cycle\").\n\n" +

  "=== TONE + FRAMING ===\n" +
  "- Be the knowledgeable friend who has read the research and helps them act. Confident and specific: real names, " +
  "typical dose ranges, and the 'why'. Short paragraphs or tight bullet lists. Warm but direct. Usually 4-8 sentences.\n" +
  "- Frame as evidence-informed options people with endo use (\"the evidence suggests\", \"many find\", \"worth trying\"), " +
  "not commands. It's fine to mention checking supplement dosing with a pharmacist, but do NOT redirect the user to a " +
  "doctor/GP/gynaecologist/specialist/clinician as 'the answer'. Help them with what you and the research know.\n" +
  "- The ONLY exception is a genuine medical emergency or red flag (fainting, very heavy/uncontrolled bleeding, " +
  "severe sudden new pain, fever with pelvic pain, signs of pregnancy complication) — only then advise urgent care.\n\n" +

  "=== SCOPE ===\n" +
  "Stay on the user's health, endometriosis, the EndoMe app (logging, insights, food, meds, pet, community, tests), " +
  "and their path to feeling better. If they ask something clearly off-topic (coding, news, general life advice, etc.), " +
  "warmly redirect: \"I'm here for your endo journey and EndoMe — what's going on for you health-wise?\" and don't " +
  "answer the off-topic part.\n\n" +

  "Ground everything in the user's logged data provided below. Cite real entries (dates, severities, triggers). " +
  "Never invent data. End with one clear, doable next step.";

// Previously-shipped defaults. ensureBuddySchema auto-upgrades the live
// 'buddy-system' row to the newest default whenever it still matches one of
// these (i.e. the admin hasn't customised it). Admin edits are preserved.
const BUDDY_PRIOR_DEFAULTS = [
  // v2 — first "tangible guidance" prompt; still mentioned clinicians.
  "You are Buddy — a knowledgeable, warm EndoMe companion for someone living with (or investigating) endometriosis. " +
  "Your job is to give SPECIFIC, PRACTICAL, EVIDENCE-AWARE guidance grounded in the user's own logged data — " +
  "not vague reassurance, and not a reflexive \"see your doctor\".\n\n" +
  "=== HOW TO HELP (this is the most important part) ===\n" +
  "Every answer should leave the user with something they can actually DO or TRY. When they describe a problem, " +
  "connect it to a likely mechanism, then offer 2-4 concrete, named options ranked from easiest to most involved. " +
  "Draw on the well-established evidence base for endometriosis self-management. Examples of the SPECIFICITY expected:\n" +
  "  • Severe pelvic pain → endo pain is largely inflammatory and often involves pelvic-floor muscle guarding. " +
  "Concrete options: a pelvic-floor physiotherapist or pelvic osteopath (one of the highest-yield referrals for " +
  "persistent pelvic pain); heat (heat patch / wheat bag) which is as effective as NSAIDs for period pain in trials; " +
  "magnesium glycinate (200-400mg) for muscle relaxation; a TENS machine; gentle daily mobility / stretching.\n" +
  "  • Inflammation / flares → NAC (N-acetylcysteine) has small RCTs in endo showing reduced lesion size and pain; " +
  "omega-3 (EPA/DHA ~2g/day); curcumin (with piperine for absorption); reducing ultra-processed food, alcohol and " +
  "high omega-6 seed oils; an anti-inflammatory / lower-FODMAP trial if bloating ('endo belly') is prominent.\n" +
  "  • Fatigue → check ferritin/iron (heavy periods deplete it), vitamin D, B12; pacing; sleep-window consistency.\n" +
  "  • Cyclical pattern → flag where in the cycle their flares cluster and suggest pre-emptive action 2-3 days before.\n" +
  "  • Bowel/bladder pain → mention these can be endo on the bowel/bladder and are worth a referral, plus practical " +
  "fibre / hydration / bladder-irritant tactics.\n" +
  "Always personalise to what they actually logged (\"your data shows pain spiking around cycle day 26 three months " +
  "running — that luteal pattern is classic, so let's get ahead of it\").\n\n" +
  "=== SAFETY + TONE ===\n" +
  "- Frame suggestions as evidence-informed options many people with endo try — NOT prescriptions. Use phrasing like " +
  "\"worth trying\", \"many find\", \"the evidence suggests\", \"ask your pharmacist about dosing\".\n" +
  "- Mention a clinician ONLY when it genuinely adds value: prescription decisions, surgery/laparoscopy, new or " +
  "rapidly worsening symptoms, or red flags (fever, fainting, very heavy bleeding, severe sudden pain, pregnancy). " +
  "Do not end every message with \"see your doctor\" — that's what we're replacing.\n" +
  "- Be specific with names, doses (as typical ranges), and the reasoning. Short paragraphs or tight bullet lists. " +
  "Warm but direct. Typically 4-8 sentences.\n" +
  "- You are not a diagnosis. You're a smart, well-read friend who knows endo deeply and helps them act.\n\n" +
  "=== SCOPE ===\n" +
  "Stay on the user's health, endometriosis, the EndoMe app (logging, insights, food, meds, pet, community, tests), " +
  "and their path to feeling better / finding a cure. If they ask something clearly off-topic (coding, news, general " +
  "life advice, etc.), warmly redirect: \"I'm here for your endo journey and EndoMe — what's going on for you " +
  "health-wise?\" and don't answer the off-topic part.\n\n" +
  "Ground everything in the user's logged data provided below. Cite real entries (dates, severities, triggers). " +
  "Never invent data. End with one clear, doable next step.",
  // v1 — original vague prompt.
  "You are Buddy — an EndoMe companion focused entirely on the user's health, " +
  "the EndoMe app, and endometriosis specifically.\n\n" +
  "Stay strictly on these topics:\n" +
  "  • the user's symptoms, cycle, daily check-ins, medications, food, test results\n" +
  "  • endometriosis — what it is, how it presents, how it's diagnosed, treatment options\n" +
  "  • how to use EndoMe (logging, insights, story progress, pet, community)\n" +
  "  • supporting the user in finding their next clinical step or partnering with their doctor\n" +
  "  • the EndoMe research mission to find a cure\n\n" +
  "If the user asks about anything else — coding, math, news, recipes for fun, " +
  "general life advice, celebrity gossip, etc. — politely redirect: " +
  "\"I'm here for your endometriosis journey and the EndoMe app — let's stay on that. " +
  "What's on your mind health-wise today?\" Do not answer off-topic questions.\n\n" +
  "Be warm, plain-spoken, and concise (3-6 sentences typical). Never diagnose, " +
  "never prescribe; suggest discussing things with a clinician where appropriate. " +
  "Use the user's own logged data when it's relevant.",
];

let _buddySchemaChecked = false;
async function ensureBuddySchema(env) {
  if (_buddySchemaChecked) return;
  _buddySchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS buddy_conversations (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  title TEXT," +
    "  created_at INTEGER NOT NULL," +
    "  updated_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_buddy_conv_user ON buddy_conversations(user_id, updated_at DESC)",
    "CREATE TABLE IF NOT EXISTS buddy_messages (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  conversation_id INTEGER NOT NULL," +
    "  role TEXT NOT NULL," +                      // 'user' | 'assistant'
    "  content TEXT NOT NULL," +
    "  input_tokens INTEGER," +
    "  output_tokens INTEGER," +
    "  created_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_buddy_msg_conv ON buddy_messages(conversation_id, created_at)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
  // Seed the system-prompt row in insight_configs so admins can edit it via
  // /acp → Insights → Configure. We re-use that table to keep the prompt
  // admin surface in one place.
  try { await ensureInsightSchema(env); } catch {}
  const now = nowSec();
  try {
    await env.DB.prepare(
      "INSERT INTO insight_configs (slug, title, emoji, description, prompt_template, " +
      "  data_scope_json, refresh_hours, model, sort_order, enabled, created_at, updated_at) " +
      "VALUES ('buddy-system', 'Buddy — chatbot guardrails + style', '💬', " +
      "  'The full system prompt that drives the Buddy chatbot. Edit this to change how Buddy responds — its scope, tone, and how specific/practical its health guidance is.', " +
      "  ?, '[]', 24, NULL, 1000, 1, ?, ?) ON CONFLICT(slug) DO NOTHING"
    ).bind(BUDDY_DEFAULT_SYSTEM_PROMPT, now, now).run();

    // Auto-upgrade: if the stored prompt is still one of our prior shipped
    // defaults (admin hasn't customised it), replace it with the newest
    // default so improvements ship without manual copy-paste. Custom edits
    // are left untouched. Also refresh the helper title/description.
    for (const prior of BUDDY_PRIOR_DEFAULTS) {
      await env.DB.prepare(
        "UPDATE insight_configs SET prompt_template = ?, " +
        "  title = 'Buddy — chatbot guardrails + style', " +
        "  description = 'The full system prompt that drives the Buddy chatbot. Edit this to change how Buddy responds — its scope, tone, and how specific/practical its health guidance is.', " +
        "  updated_at = ? " +
        "WHERE slug = 'buddy-system' AND prompt_template = ?"
      ).bind(BUDDY_DEFAULT_SYSTEM_PROMPT, now, prior).run();
    }
  } catch {}
}

async function buddyGetSystemPrompt(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT prompt_template, model FROM insight_configs WHERE slug = 'buddy-system'"
    ).first();
    return {
      prompt: row?.prompt_template || BUDDY_DEFAULT_SYSTEM_PROMPT,
      model:  row?.model || null,
    };
  } catch {
    return { prompt: BUDDY_DEFAULT_SYSTEM_PROMPT, model: null };
  }
}

async function listBuddyConversations(env, user) {
  await ensureBuddySchema(env);
  const r = await env.DB.prepare(
    "SELECT c.id, c.title, c.created_at, c.updated_at, " +
    "       (SELECT COUNT(*) FROM buddy_messages WHERE conversation_id = c.id) AS message_count " +
    "FROM buddy_conversations c WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50"
  ).bind(user.id).all().catch(() => ({ results: [] }));
  return json({
    conversations: (r.results || []).map((c) => ({
      id: c.id, title: c.title || "New chat", messageCount: c.message_count,
      createdAt: c.created_at, updatedAt: c.updated_at,
    })),
  });
}
async function createBuddyConversation(env, user) {
  await ensureBuddySchema(env);
  const now = nowSec();
  const r = await env.DB.prepare(
    "INSERT INTO buddy_conversations (user_id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)"
  ).bind(user.id, now, now).run();
  return json({ id: r.meta?.last_row_id, ok: true });
}
async function getBuddyConversation(env, user, id) {
  await ensureBuddySchema(env);
  const conv = await env.DB.prepare(
    "SELECT id, title, created_at, updated_at FROM buddy_conversations WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!conv) return json({ error: "Not found" }, 404);
  const msgs = await env.DB.prepare(
    "SELECT id, role, content, input_tokens, output_tokens, created_at " +
    "FROM buddy_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200"
  ).bind(id).all().catch(() => ({ results: [] }));
  return json({
    conversation: { id: conv.id, title: conv.title, createdAt: conv.created_at, updatedAt: conv.updated_at },
    messages: (msgs.results || []).map((m) => ({
      id: m.id, role: m.role, content: m.content,
      inputTokens: m.input_tokens || null, outputTokens: m.output_tokens || null,
      createdAt: m.created_at,
    })),
  });
}
async function deleteBuddyConversation(env, user, id) {
  await ensureBuddySchema(env);
  // Verify ownership first to keep DELETE scoped.
  const own = await env.DB.prepare(
    "SELECT 1 FROM buddy_conversations WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!own) return json({ error: "Not found" }, 404);
  await env.DB.prepare("DELETE FROM buddy_messages WHERE conversation_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM buddy_conversations WHERE id = ?").bind(id).run();
  return json({ ok: true });
}
async function sendBuddyMessage(request, env, user, id) {
  await ensureBuddySchema(env);
  const body = await readJsonSafe(request);
  const text = sanitizeText(body?.content, 4000);
  if (!text) return json({ error: "Empty message" }, 400);

  const conv = await env.DB.prepare(
    "SELECT id, title FROM buddy_conversations WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!conv) return json({ error: "Conversation not found" }, 404);

  // Persist the user message first so the conversation feels responsive even
  // if the model call fails.
  const now = nowSec();
  await env.DB.prepare(
    "INSERT INTO buddy_messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)"
  ).bind(id, text, now).run();

  // Auto-title the conversation from the first user message (first 60 chars).
  if (!conv.title) {
    const newTitle = text.replace(/\s+/g, " ").slice(0, 60);
    await env.DB.prepare("UPDATE buddy_conversations SET title = ?, updated_at = ? WHERE id = ?")
      .bind(newTitle, now, id).run();
  } else {
    await env.DB.prepare("UPDATE buddy_conversations SET updated_at = ? WHERE id = ?").bind(now, id).run();
  }

  // Pull the user's actual data + status. The data block goes into the
  // system prompt where Claude weighs it heavily — concatenating it into
  // a user turn (as we did before) made it easy for the model to claim
  // "no data" because prior assistant messages in history said as much.
  const sys = await buddyGetSystemPrompt(env);
  const dataContext = await buildInsightContext(env, user, [
    "symptoms_30d", "daily_logs_30d", "medications",
    "medication_logs_30d", "food_logs_30d", "cravings_30d", "test_results", "appointments_60d",
  ]).catch(() => "(data lookup failed)");

  // The companion speaks AS the user's EndoPet — using the name they chose
  // at onboarding — so it feels like one continuous friend across the app.
  let petPersona = "";
  try {
    const p = await env.DB.prepare(
      "SELECT pet_name, pet_type FROM pets WHERE user_id = ?"
    ).bind(user.id).first();
    const petName = (p?.pet_name || "").trim();
    if (petName) {
      petPersona = `Your name is ${petName} — you ARE the user's EndoPet, the little companion they named when they joined EndoMe. ` +
        `Speak as ${petName} in the first person, warm and familiar, like a friend who's been by their side the whole journey. ` +
        `Sign off naturally as ${petName} only if it fits; don't force it. Never call yourself "Buddy" — your name is ${petName}.`;
    }
  } catch {}

  let endoLine = "";
  try {
    const e = await env.DB.prepare(
      "SELECT endo_status, endo_stage, wants_early_dx_support, research_share_consent " +
      "FROM users WHERE id = ?"
    ).bind(user.id).first();
    if (e) {
      const bits = [];
      if (e.endo_status === "diagnosed") bits.push(`diagnosed${e.endo_stage ? ` (${e.endo_stage.replace("_"," ")})` : ""}`);
      else if (e.endo_status === "unknown") bits.push("not yet diagnosed" + (e.wants_early_dx_support ? ", opted into early-dx pattern watch" : ""));
      if (e.research_share_consent) bits.push("contributing anonymised data to EndoMe research");
      if (bits.length) endoLine = "User status: " + bits.join("; ") + ".";
    }
  } catch {}

  // Early-diagnosis pattern watch — if the user is on the "watching" path
  // and we've flagged 3+ endo markers in their data, tell Buddy explicitly
  // so they can bring it up proactively in conversation (warm, not alarming).
  let watchLine = "";
  try {
    const w = await computeEndoPatternWatch(env, user);
    if (w.eligible && w.flagged) {
      const names = w.markers.map((m) => m.label).join("; ");
      watchLine = `Early-dx pattern watch (flagged): ${w.score} of 10 known endometriosis markers detected in their last 60 days — ${names}. ` +
        `Bring this up GENTLY when relevant (\"I've been noticing a pattern in your logs…\"), be specific about which markers and which entries support each, and frame as something WORTH knowing — not a diagnosis.`;
    }
  } catch {}

  // Per-turn data freshness check — figure out whether the user actually
  // has anything logged so we can tell Claude "yes, they do" definitively.
  // Without this Claude tends to play it safe and say "I can't see your
  // data". The cheap check is whether dataContext contains real entries
  // (every empty slice produces "Nothing logged.").
  const hasAnyData = !/^(### .+\n(Nothing logged|None tracked|None yet|None\.))(\n\n### .+\n(Nothing logged|None tracked|None yet|None\.))*$/m.test(dataContext)
    && dataContext !== "(no data logged yet)"
    && dataContext !== "(data lookup failed)";

  // Build a strict system prompt: guardrails + status + the actual data
  // block, with explicit instructions to use it and override any earlier
  // hedging. Claude on Bedrock supports a top-level `system` field —
  // content here is weighted as instructions, not chat content.
  const systemBlock = [
    sys.prompt,
    petPersona,
    endoLine,
    watchLine,
    "",
    "=== The user's CURRENT logged EndoMe data ===",
    hasAnyData
      ? "The user HAS data logged below. You DO have access to it. " +
        "Read every section carefully and quote specific entries when relevant " +
        "(e.g. \"on 2026-05-24 you logged painful_urination at severity 3 with stress as a trigger\"). " +
        "Use real dates, severities and notes from the data. Never invent entries. " +
        "Only a section that literally says \"Nothing logged.\" is empty — speak to that section honestly."
      : "The user has no entries yet in any section below. Gently encourage them " +
        "to do a daily check-in, and offer to walk them through it.",
    "",
    dataContext,
    "",
    "=== Data-grounding rules (the editable prompt above governs tone, scope + safety) ===",
    "- NEVER say \"I don't see your data\" or \"I can't see your data\" when the block above contains entries.",
    "- If earlier messages in this conversation said you had no data, that was wrong — the data is right above. Correct course in your next reply.",
    "- Quote the user's real entries (dates, severities, triggers) and never invent data.",
  ].filter(Boolean).join("\n");

  // Conversation as a proper role-aware messages array (the right shape
  // for Claude). Skip empty content and any leading assistant turn — the
  // API requires the first message to be 'user' AND the last to be 'user'.
  // Fetch the LATEST 40 (not the oldest 40) so the user's just-sent message
  // is always included even in long conversations.
  const history = await env.DB.prepare(
    "SELECT role, content FROM buddy_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 40"
  ).bind(id).all().catch(() => ({ results: [] }));
  const rawMsgs = (history.results || [])
    .reverse()    // back to chronological order
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content || "").trim() }))
    .filter((m) => m.content);
  while (rawMsgs.length && rawMsgs[0].role !== "user") rawMsgs.shift();
  // Drop any trailing assistant turn so the array ends with the user's most
  // recent message (otherwise Bedrock 400s on "last message must be user").
  while (rawMsgs.length && rawMsgs[rawMsgs.length - 1].role !== "user") rawMsgs.pop();
  // Collapse consecutive same-role messages so the array strictly alternates,
  // which is what the Anthropic API expects.
  const messages = [];
  for (const m of rawMsgs) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else messages.push(m);
  }
  if (!messages.length) messages.push({ role: "user", content: text });

  let res;
  try {
    res = await invokeClaude(env, null, {
      model: sys.model,
      system: systemBlock,
      messages,
      maxTokens: 2000,
    });
  } catch (err) {
    console.error("[buddy] invokeClaude threw:", err?.message || err);
    res = { ok: false, error: "engine_exception: " + (err?.message || String(err)) };
  }
  if (!res.ok) {
    // Surface the real failure reason in the assistant bubble — silent
    // "couldn't reach the engine" hides whether it's a missing prerequisite,
    // an oversized prompt, or a model-access error.
    const detail = String(res.error || "Engine error").slice(0, 600);
    console.warn("[buddy] engine call failed:", detail);
    const errText = `Hmm, I hit a snag reaching the EndoMe engine — please try again. (${detail})`;
    await env.DB.prepare(
      "INSERT INTO buddy_messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)"
    ).bind(id, errText, nowSec()).run();
    return json({ ok: false, error: res.error || "Engine error", reply: errText });
  }
  let reply = String(res.text || "").trim();
  // Bedrock can return success-but-empty (content filter, refusal,
  // max-tokens hit on first token). Fall back to something useful so the
  // user doesn't see a blank bubble.
  if (!reply) {
    reply = "Sorry — I didn't have a good answer for that one. Try asking again, maybe with a bit more detail about what you're feeling?";
    console.warn("[buddy] empty Claude reply (tokens in/out:", res.inputTokens, "/", res.outputTokens, ")");
  }
  await env.DB.prepare(
    "INSERT INTO buddy_messages (conversation_id, role, content, input_tokens, output_tokens, created_at) " +
    "VALUES (?, 'assistant', ?, ?, ?, ?)"
  ).bind(id, reply, res.inputTokens || null, res.outputTokens || null, nowSec()).run();
  await env.DB.prepare("UPDATE buddy_conversations SET updated_at = ? WHERE id = ?").bind(nowSec(), id).run();
  return json({ ok: true, reply, inputTokens: res.inputTokens, outputTokens: res.outputTokens });
}


const ENDO_STATUSES = new Set(["diagnosed", "unknown"]);
const ENDO_STAGES = new Set(["stage_1", "stage_2", "stage_3", "stage_4", "unsure"]);

async function getEndoStatus(env, user) {
  await ensureProfileSchema(env);
  const row = await env.DB.prepare(
    "SELECT endo_status, endo_stage, wants_early_dx_support, " +
    "       research_share_consent, research_consent_at FROM users WHERE id = ?"
  ).bind(user.id).first().catch(() => null);
  return json({
    status:                row?.endo_status || null,
    stage:                 row?.endo_stage  || null,
    wantsEarlyDxSupport:   row?.wants_early_dx_support ? 1 : 0,
    researchShareConsent:  row?.research_share_consent ? 1 : 0,
    researchConsentAt:     row?.research_consent_at || null,
  });
}
async function updateEndoStatus(request, env, user) {
  await ensureProfileSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  // Status / stage / early-dx — only updated when the request actually
  // names them, so the profile + research-consent forms can each save
  // independently without clobbering the other's fields.
  const sets = []; const binds = [];
  if ("status" in body) {
    const status = body.status && ENDO_STATUSES.has(body.status) ? body.status : null;
    sets.push("endo_status = ?");           binds.push(status);
    sets.push("endo_stage = ?");            binds.push(status === "diagnosed" && ENDO_STAGES.has(body.stage) ? body.stage : null);
    sets.push("wants_early_dx_support = ?"); binds.push(status === "unknown" && body.wantsEarlyDxSupport ? 1 : 0);
  }
  if ("researchShareConsent" in body) {
    const consent = body.researchShareConsent ? 1 : 0;
    sets.push("research_share_consent = ?"); binds.push(consent);
    // Stamp the consent moment when granting; null it when withdrawing,
    // so the audit row only reflects an *active* consent timestamp.
    sets.push("research_consent_at = ?");    binds.push(consent ? nowSec() : null);
  }
  if (!sets.length) return json({ error: "Nothing to update" }, 400);
  binds.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return getEndoStatus(env, user);
}

async function getMyProfile(env, user) {
  await ensureProfileSchema(env);
  const row = await env.DB.prepare(
    "SELECT id, username, display_name, alias, avatar, avatar_image_key, bio, created_at FROM users WHERE id = ?"
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
    "SELECT id, username, display_name, alias, avatar, avatar_image_key, bio, created_at FROM users " +
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
    "  notes TEXT," +
    "  status TEXT NOT NULL DEFAULT 'taken'," +     // 'taken' | 'auto_taken' | 'missed'
    "  scheduled_for INTEGER" +                     // unix sec of the scheduled slot, if any
    ")",
    "CREATE INDEX IF NOT EXISTS idx_medlogs_med ON medication_logs(medication_id, taken_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_medlogs_user ON medication_logs(user_id, taken_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_medlogs_slot ON medication_logs(medication_id, scheduled_for)",
    // Existing installs need the new columns. SQLite errors silently if the
    // column already exists, which the catch-block swallows.
    "ALTER TABLE medication_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'taken'",
    "ALTER TABLE medication_logs ADD COLUMN scheduled_for INTEGER",
    // Community ratings: one row per (user, normalised med name).
    "CREATE TABLE IF NOT EXISTS med_reactions (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  med_key TEXT NOT NULL," +              // lower-cased name for grouping
    "  reaction TEXT NOT NULL," +              // 'love' | 'down'
    "  comment TEXT," +                        // required for 'down'
    "  updated_at INTEGER NOT NULL," +
    "  UNIQUE(user_id, med_key)" +
    ")",
    // Best-effort ALTER for installs that already had med_reactions without
    // the comment column. The CREATE above no-ops if the table exists.
    "ALTER TABLE med_reactions ADD COLUMN comment TEXT",
    "CREATE INDEX IF NOT EXISTS idx_medreact_key ON med_reactions(med_key, reaction)",
    // Moderation queue for medication thumbs-down comments. Same pattern as
    // recipe_mod_queue: every 👎 must come with a useful comment, which lands
    // here for human review and is shown alongside the medication.
    "CREATE TABLE IF NOT EXISTS med_mod_queue (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  med_key TEXT NOT NULL," +
    "  user_id TEXT NOT NULL," +
    "  comment TEXT NOT NULL," +
    "  status TEXT NOT NULL DEFAULT 'pending'," +
    "  created_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_medmod_key ON med_mod_queue(med_key, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_medmod_status ON med_mod_queue(status, created_at DESC)",
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
    // Per-user behaviour: how should scheduled doses be handled when the
    // user doesn't tap "taken" themselves? Two flags, mutually informative
    // (the UI presents them as one of two policies).
    "CREATE TABLE IF NOT EXISTS user_med_prefs (" +
    "  user_id TEXT PRIMARY KEY," +
    "  auto_mark_taken INTEGER NOT NULL DEFAULT 0," +   // 1 = assume taken once scheduled time passes
    "  notify_at_dose  INTEGER NOT NULL DEFAULT 1," +   // 1 = surface a notification asking taken/missed
    "  updated_at INTEGER NOT NULL" +
    ")",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

async function getMedPrefs(env, user) {
  await ensureMedSchema(env);
  const r = await env.DB.prepare(
    "SELECT auto_mark_taken, notify_at_dose FROM user_med_prefs WHERE user_id = ?"
  ).bind(user.id).first().catch(() => null);
  return json({
    autoMarkTaken: r?.auto_mark_taken ? 1 : 0,
    notifyAtDose:  r ? (r.notify_at_dose ? 1 : 0) : 1, // default ON
  });
}

async function updateMedPrefs(request, env, user) {
  await ensureMedSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const auto = body.autoMarkTaken ? 1 : 0;
  const notify = body.notifyAtDose ? 1 : 0;
  const now = nowSec();
  await env.DB.prepare(
    "INSERT INTO user_med_prefs (user_id, auto_mark_taken, notify_at_dose, updated_at) " +
    "VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET auto_mark_taken = ?, notify_at_dose = ?, updated_at = ?"
  ).bind(user.id, auto, notify, now, auto, notify, now).run();
  return json({ ok: true, autoMarkTaken: auto, notifyAtDose: notify });
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
  // Honour `scheduledFor` if the client knows which slot it's confirming —
  // lets the doses-due UI mark the right slot taken without dupes.
  const scheduledFor = Number.isFinite(+body.scheduledFor) ? +body.scheduledFor : null;
  await env.DB.prepare(
    "INSERT INTO medication_logs (user_id, medication_id, taken_at, dose_text, notes, status, scheduled_for) " +
    "VALUES (?, ?, ?, ?, ?, 'taken', ?)"
  ).bind(user.id, id, nowSec(), doseText, notes, scheduledFor).run();
  return json({ ok: true, name: med.name });
}

// User explicitly marks a scheduled dose as missed. Writes a row with
// status='missed' so adherence stats can distinguish "forgot" from
// "haven't logged yet". Idempotent per scheduled slot — repeated calls
// for the same scheduledFor are a no-op.
async function missMedicationDose(request, env, user, id) {
  await ensureMedSchema(env);
  const body = await readJsonSafe(request) || {};
  const med = await env.DB.prepare(
    "SELECT id, name FROM medications WHERE id = ? AND user_id = ? AND is_active = 1"
  ).bind(id, user.id).first().catch(() => null);
  if (!med) return json({ error: "Medication not found" }, 404);

  const scheduledFor = Number.isFinite(+body.scheduledFor) ? +body.scheduledFor : null;
  if (!scheduledFor) return json({ error: "scheduledFor required" }, 400);

  // De-dupe: if a row already exists for this slot, leave it alone.
  const existing = await env.DB.prepare(
    "SELECT id, status FROM medication_logs WHERE medication_id = ? AND scheduled_for = ? LIMIT 1"
  ).bind(id, scheduledFor).first().catch(() => null);
  if (existing) return json({ ok: true, alreadyLogged: existing.status });

  await env.DB.prepare(
    "INSERT INTO medication_logs (user_id, medication_id, taken_at, status, scheduled_for) " +
    "VALUES (?, ?, ?, 'missed', ?)"
  ).bind(user.id, id, nowSec(), scheduledFor).run();
  return json({ ok: true, name: med.name });
}

// Build today's dose roster for the signed-in user. Returns one entry per
// scheduled slot today, each with its status (taken / auto_taken / missed /
// pending / upcoming). The dashboard banner + bell rely on this.
//
// "Pending" = scheduled time has passed (or is within 30 min) but no log
// row exists. These are the ones users need to act on.
// "Upcoming" = later today; shown for context but not nagged about.
async function getDosesDue(env, user) {
  await ensureMedSchema(env);
  const now = nowSec();
  const today = new Date(now * 1000);
  const todayStart = Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000);
  const todayEnd = todayStart + 86400;
  const dayBit = 1 << today.getDay();

  // Schedules that fire today (days_mask has today's bit set).
  const slots = await env.DB.prepare(
    "SELECT s.id AS sched_id, s.medication_id, s.time_of_day, " +
    "       m.name, m.dose, m.kind " +
    "FROM medication_schedules s JOIN medications m ON m.id = s.medication_id " +
    "WHERE s.user_id = ? AND m.is_active = 1 AND (s.days_mask & ?) != 0"
  ).bind(user.id, dayBit).all().catch(() => ({ results: [] }));

  // Today's existing logs, keyed by scheduled_for so we can pair them up.
  const logs = await env.DB.prepare(
    "SELECT medication_id, scheduled_for, status, taken_at FROM medication_logs " +
    "WHERE user_id = ? AND taken_at >= ? AND taken_at < ?"
  ).bind(user.id, todayStart, todayEnd).all().catch(() => ({ results: [] }));
  const logByKey = new Map();
  for (const l of (logs.results || [])) {
    if (l.scheduled_for) logByKey.set(`${l.medication_id}:${l.scheduled_for}`, l);
  }

  const out = [];
  for (const s of (slots.results || [])) {
    const [h, m] = String(s.time_of_day).split(":").map((n) => parseInt(n, 10));
    const slotAt = todayStart + (h || 0) * 3600 + (m || 0) * 60;
    const log = logByKey.get(`${s.medication_id}:${slotAt}`);
    let status;
    if (log) status = log.status;
    else if (slotAt > now + 30 * 60) status = "upcoming";   // > 30 min away
    else status = "pending";                                // due now or overdue
    out.push({
      medicationId: s.medication_id,
      scheduleId: s.sched_id,
      name: s.name,
      kind: s.kind || "medication",
      dose: s.dose || null,
      timeOfDay: s.time_of_day,
      scheduledFor: slotAt,
      status,
    });
  }
  out.sort((a, b) => a.scheduledFor - b.scheduledFor);

  // Pull med-prefs so the UI knows the user's chosen policy.
  const prefs = await env.DB.prepare(
    "SELECT auto_mark_taken, notify_at_dose FROM user_med_prefs WHERE user_id = ?"
  ).bind(user.id).first().catch(() => null);

  return json({
    doses: out,
    pendingCount: out.filter((d) => d.status === "pending").length,
    prefs: {
      autoMarkTaken: prefs?.auto_mark_taken ? 1 : 0,
      notifyAtDose:  prefs ? (prefs.notify_at_dose ? 1 : 0) : 1,
    },
  });
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
  for (const k of keys) out[k] = { loves: 0, downs: 0, users: 0, downComments: [] };

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

  // Down-comments — anonymous in payload, capped per med for the UI thread.
  try {
    const comments = await env.DB.prepare(
      `SELECT med_key, comment, updated_at FROM med_reactions
       WHERE med_key IN (${ph}) AND reaction='down' AND comment IS NOT NULL
       ORDER BY updated_at DESC LIMIT 200`
    ).bind(...keys).all();
    for (const r of (comments.results || [])) {
      const bucket = out[r.med_key]; if (!bucket) continue;
      if (bucket.downComments.length < 10) {
        bucket.downComments.push({ comment: r.comment, createdAt: r.updated_at });
      }
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
    const stats = (await getMedCommunityStats(env, [key]))[key] || { loves: 0, downs: 0, users: 0 };
    return json({ ok: true, key, reaction: null, stats });
  }

  let comment = null;
  if (reaction === "down") {
    // Thumbs-down requires a useful comment. Drive-by negativity gets
    // bounced; meaningful feedback (≥10 chars) is saved and copied to the
    // moderation queue so admins can review borderline language.
    comment = sanitizeText(body.comment, 800);
    if (!comment || comment.length < 10) {
      return json({
        error: "Add a comment (at least 10 characters) explaining why this didn't work. Constructive feedback only — it goes to the moderation queue.",
      }, 400);
    }
  }

  await env.DB.prepare(
    "INSERT INTO med_reactions (user_id, med_key, reaction, comment, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(user_id, med_key) DO UPDATE SET reaction = excluded.reaction, comment = excluded.comment, updated_at = excluded.updated_at"
  ).bind(user.id, key, reaction, comment, nowSec()).run();

  if (reaction === "down" && comment) {
    try {
      await env.DB.prepare(
        "INSERT INTO med_mod_queue (med_key, user_id, comment, status, created_at) " +
        "VALUES (?, ?, ?, 'pending', ?)"
      ).bind(key, user.id, comment, nowSec()).run();
    } catch {}
  }

  const stats = (await getMedCommunityStats(env, [key]))[key] || { loves: 0, downs: 0, users: 0 };
  // Bubble the public down-comment list back so the UI can refresh.
  let downComments = [];
  try {
    const rows = await env.DB.prepare(
      "SELECT comment, updated_at FROM med_reactions " +
      "WHERE med_key = ? AND reaction='down' AND comment IS NOT NULL " +
      "ORDER BY updated_at DESC LIMIT 20"
    ).bind(key).all();
    downComments = (rows.results || []).map((r) => ({ comment: r.comment, createdAt: r.updated_at }));
  } catch {}
  return json({ ok: true, key, reaction, comment, stats, downComments });
}

// Top-ranked picks for the right sidebar. Ranked by ❤ count: the medication
// with the most loves wins, even if it's only one. Vote-only entries (loved
// from the glossary by someone who doesn't take it) and usage-only entries
// (everyone takes it but no one's voted yet) both surface.
async function getMedTopPicks(env) {
  await ensureMedSchema(env);
  const out = { medication: null, vitamin: null };

  // 1) Aggregate vote counts per med name.
  let voteRows = { results: [] };
  try {
    voteRows = await env.DB.prepare(
      "SELECT med_key, " +
      "  SUM(CASE WHEN reaction='love' THEN 1 ELSE 0 END) AS loves, " +
      "  SUM(CASE WHEN reaction='down' THEN 1 ELSE 0 END) AS downs " +
      "FROM med_reactions GROUP BY med_key"
    ).all();
  } catch {}

  // 2) Pull usage counts (and the original-cased name + kind) per med name.
  let usageRows = { results: [] };
  try {
    usageRows = await env.DB.prepare(
      "SELECT LOWER(TRIM(name)) AS med_key, MIN(name) AS display_name, " +
      "       kind, COUNT(DISTINCT user_id) AS users " +
      "FROM medications WHERE is_active = 1 GROUP BY LOWER(TRIM(name)), kind"
    ).all();
  } catch {}

  const byKey = new Map();
  for (const r of (usageRows.results || [])) {
    byKey.set(r.med_key, {
      key: r.med_key,
      name: r.display_name,
      kind: r.kind || "medication",
      users: r.users || 0,
      loves: 0, downs: 0,
    });
  }
  for (const v of (voteRows.results || [])) {
    const existing = byKey.get(v.med_key);
    if (existing) {
      existing.loves = +v.loves || 0;
      existing.downs = +v.downs || 0;
    } else {
      // Vote came from the glossary on something nobody is taking yet — still
      // worth surfacing. We don't know the canonical kind, so fall back to
      // looking it up in the catalog payload via a guess; otherwise classify
      // as 'medication' and rely on the catalog client-side for the label.
      byKey.set(v.med_key, {
        key: v.med_key,
        name: prettyMedName(v.med_key),
        kind: "medication",
        users: 0,
        loves: +v.loves || 0,
        downs: +v.downs || 0,
      });
    }
  }

  function pick(kinds) {
    const pool = [...byKey.values()].filter((r) => kinds.includes(r.kind));
    // Drop entries with zero engagement entirely so the empty sidebar copy
    // shows instead of an arbitrary med.
    const ranked = pool.filter((r) => r.loves > 0 || r.users > 0);
    if (!ranked.length) return null;
    ranked.sort((a, b) => {
      // Highest love count wins first — that's the "high score".
      if (b.loves !== a.loves) return b.loves - a.loves;
      // Then most-used as tiebreaker.
      if (b.users !== a.users) return b.users - a.users;
      // Fewer downs is better.
      if (a.downs !== b.downs) return a.downs - b.downs;
      return a.name.localeCompare(b.name);
    });
    return ranked[0];
  }

  out.medication = pick(["medication"]);
  out.vitamin    = pick(["vitamin", "supplement", "herbal"]);
  return json(out);
}

// Best-effort title casing for a med name that we only have lower-cased.
function prettyMedName(key) {
  return String(key || "").split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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

  // Pull every log in the last 14 days INCLUDING status + scheduled_for so
  // the calendar can colour each weekly slot — taken/auto_taken = green,
  // missed = red, future = uncoloured. We send the raw rows; the client
  // pairs them to slots by (medication_id, scheduled_for).
  const lookbackStart = Math.floor(Date.now() / 1000) - 14 * 86400;
  const logRows = await env.DB.prepare(
    "SELECT medication_id, taken_at, status, scheduled_for FROM medication_logs " +
    "WHERE user_id = ? AND taken_at >= ?"
  ).bind(user.id, lookbackStart).all().catch(() => ({ results: [] }));

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
      status: r.status || "taken", scheduledFor: r.scheduled_for || null,
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
    // Best-effort ALTER for the recipe photo column. Existing tables won't
    // have it; the duplicate-column error is swallowed below.
    "ALTER TABLE recipes ADD COLUMN image_key TEXT",
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

// =============================================================================
// FOOD DIARY — calorie + macro logging with weekly meal plan.
// `foods` are the user's saved entries (one per food they eat often).
// `food_logs` are individual eat events. `food_plans` are recurring slots
// like "oatmeal every weekday for breakfast". `user_food_prefs` holds the
// daily calorie / macro targets.
// =============================================================================
const FOOD_MEALS = new Set(["breakfast", "lunch", "dinner", "snack"]);
let _foodSchemaChecked = false;
async function ensureFoodSchema(env) {
  if (_foodSchemaChecked) return;
  _foodSchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS foods (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  name TEXT NOT NULL," +
    "  calories INTEGER," +                  // per serving
    "  protein_g REAL," +
    "  carbs_g REAL," +
    "  fat_g REAL," +
    "  fiber_g REAL," +
    "  serving_size TEXT," +                 // e.g. "1 cup", "100g"
    "  brand TEXT," +
    "  notes TEXT," +
    "  is_active INTEGER NOT NULL DEFAULT 1," +
    "  created_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_foods_user ON foods(user_id, is_active)",

    "CREATE TABLE IF NOT EXISTS food_logs (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  food_id INTEGER," +                    // nullable — quick free-text logs are OK
    "  name TEXT NOT NULL," +                 // snapshot
    "  meal TEXT NOT NULL," +                 // breakfast | lunch | dinner | snack
    "  calories INTEGER," +
    "  protein_g REAL," +
    "  carbs_g REAL," +
    "  fat_g REAL," +
    "  fiber_g REAL," +
    "  servings REAL NOT NULL DEFAULT 1," +
    "  log_date TEXT NOT NULL," +             // YYYY-MM-DD local
    "  logged_at INTEGER NOT NULL," +
    "  notes TEXT" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_foodlogs_user_date ON food_logs(user_id, log_date)",

    "CREATE TABLE IF NOT EXISTS food_plans (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  food_id INTEGER NOT NULL," +
    "  meal TEXT NOT NULL," +
    "  days_mask INTEGER NOT NULL," +         // Sun=1 .. Sat=64 (same as meds)
    "  servings REAL NOT NULL DEFAULT 1," +
    "  created_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_foodplans_user ON food_plans(user_id)",

    "CREATE TABLE IF NOT EXISTS user_food_prefs (" +
    "  user_id TEXT PRIMARY KEY," +
    "  daily_calorie_target INTEGER NOT NULL DEFAULT 2000," +
    "  protein_target_g INTEGER," +
    "  carbs_target_g INTEGER," +
    "  fat_target_g INTEGER," +
    "  updated_at INTEGER NOT NULL" +
    ")",
    // Fast cravings log — semantically distinct from food eaten, captured
    // in one tap. Luteal-phase cravings (salty, fatty, carbs) are a strong
    // endo-adjacent signal; Buddy + insights can correlate to cycle day.
    "CREATE TABLE IF NOT EXISTS cravings (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  craving TEXT NOT NULL," +              // salty | sweet | fatty | carbs | chocolate | spicy | protein | cold | other
    "  intensity INTEGER NOT NULL DEFAULT 3," + // 1-5
    "  satisfied INTEGER," +                  // 0/1 nullable
    "  notes TEXT," +
    "  log_date TEXT NOT NULL," +             // YYYY-MM-DD
    "  logged_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_cravings_user_date ON cravings(user_id, log_date)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

const CRAVINGS_ALLOWED = new Set([
  "salty","sweet","fatty","carbs","chocolate","spicy","protein","cold","sour","other",
]);
async function logCraving(request, env, user) {
  await ensureFoodSchema(env);
  const body = await readJsonSafe(request);
  const craving = String(body?.craving || "").toLowerCase();
  if (!CRAVINGS_ALLOWED.has(craving)) return json({ error: "Invalid craving" }, 400);
  const intensity = Math.max(1, Math.min(5, +(body?.intensity || 3) | 0));
  const satisfied = body?.satisfied == null ? null : (body.satisfied ? 1 : 0);
  const notes = sanitizeText(body?.notes, 300);
  const now = nowSec();
  const date = new Date(now * 1000).toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    "INSERT INTO cravings (user_id, craving, intensity, satisfied, notes, log_date, logged_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(user.id, craving, intensity, satisfied, notes, date, now).run();
  return json({ id: r.meta?.last_row_id, ok: true });
}
async function listCravings(env, user) {
  await ensureFoodSchema(env);
  const r = await env.DB.prepare(
    "SELECT id, craving, intensity, satisfied, notes, log_date, logged_at FROM cravings " +
    "WHERE user_id = ? ORDER BY logged_at DESC LIMIT 60"
  ).bind(user.id).all().catch(() => ({ results: [] }));
  return json({ cravings: r.results || [] });
}
async function deleteCraving(env, user, id) {
  await ensureFoodSchema(env);
  await env.DB.prepare("DELETE FROM cravings WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}

function foodRow(r) {
  return {
    id: r.id, name: r.name,
    calories: r.calories || null,
    proteinG: r.protein_g != null ? +r.protein_g : null,
    carbsG:   r.carbs_g   != null ? +r.carbs_g   : null,
    fatG:     r.fat_g     != null ? +r.fat_g     : null,
    fiberG:   r.fiber_g   != null ? +r.fiber_g   : null,
    servingSize: r.serving_size || null,
    brand: r.brand || null,
    notes: r.notes || null,
  };
}
function foodLogRow(r) {
  return {
    id: r.id, foodId: r.food_id || null, name: r.name, meal: r.meal,
    servings: +r.servings || 1,
    calories: r.calories != null ? Math.round(r.calories * (+r.servings || 1)) : null,
    proteinG: r.protein_g != null ? +(r.protein_g * (+r.servings || 1)).toFixed(1) : null,
    carbsG:   r.carbs_g   != null ? +(r.carbs_g   * (+r.servings || 1)).toFixed(1) : null,
    fatG:     r.fat_g     != null ? +(r.fat_g     * (+r.servings || 1)).toFixed(1) : null,
    fiberG:   r.fiber_g   != null ? +(r.fiber_g   * (+r.servings || 1)).toFixed(1) : null,
    logDate: r.log_date, loggedAt: r.logged_at, notes: r.notes || null,
  };
}

async function listFoods(env, user) {
  await ensureFoodSchema(env);
  const r = await env.DB.prepare(
    "SELECT * FROM foods WHERE user_id = ? AND is_active = 1 ORDER BY name COLLATE NOCASE"
  ).bind(user.id).all().catch(() => ({ results: [] }));
  return json({ foods: (r.results || []).map(foodRow) });
}
async function createFood(request, env, user) {
  await ensureFoodSchema(env);
  const body = await readJsonSafe(request);
  if (!body?.name) return json({ error: "Name required" }, 400);
  const now = nowSec();
  const r = await env.DB.prepare(
    "INSERT INTO foods (user_id, name, calories, protein_g, carbs_g, fat_g, fiber_g, " +
    "  serving_size, brand, notes, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    user.id,
    sanitizeText(body.name, 120),
    Number.isFinite(+body.calories) ? Math.max(0, Math.min(5000, +body.calories)) : null,
    Number.isFinite(+body.proteinG) ? +(+body.proteinG).toFixed(2) : null,
    Number.isFinite(+body.carbsG)   ? +(+body.carbsG).toFixed(2)   : null,
    Number.isFinite(+body.fatG)     ? +(+body.fatG).toFixed(2)     : null,
    Number.isFinite(+body.fiberG)   ? +(+body.fiberG).toFixed(2)   : null,
    sanitizeText(body.servingSize, 60),
    sanitizeText(body.brand, 60),
    sanitizeText(body.notes, 500),
    now,
  ).run();
  return json({ id: r.meta?.last_row_id, ok: true });
}
async function updateFood(request, env, user, id) {
  await ensureFoodSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const owned = await env.DB.prepare(
    "SELECT 1 FROM foods WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!owned) return json({ error: "Not found" }, 404);
  const sets = []; const binds = [];
  const numField = (k, col, max) => {
    if (k in body) { sets.push(`${col} = ?`); binds.push(Number.isFinite(+body[k]) ? +(+body[k]).toFixed(2) : null); }
  };
  if ("name" in body)         { sets.push("name = ?"); binds.push(sanitizeText(body.name, 120)); }
  if ("calories" in body)     { sets.push("calories = ?"); binds.push(Number.isFinite(+body.calories) ? Math.max(0, Math.min(5000, +body.calories)) : null); }
  numField("proteinG", "protein_g");
  numField("carbsG",   "carbs_g");
  numField("fatG",     "fat_g");
  numField("fiberG",   "fiber_g");
  if ("servingSize" in body)  { sets.push("serving_size = ?"); binds.push(sanitizeText(body.servingSize, 60)); }
  if ("brand" in body)        { sets.push("brand = ?"); binds.push(sanitizeText(body.brand, 60)); }
  if ("notes" in body)        { sets.push("notes = ?"); binds.push(sanitizeText(body.notes, 500)); }
  if (!sets.length) return json({ error: "Nothing to update" }, 400);
  binds.push(id, user.id);
  await env.DB.prepare(`UPDATE foods SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...binds).run();
  return json({ ok: true });
}
async function deleteFood(env, user, id) {
  await ensureFoodSchema(env);
  await env.DB.prepare("UPDATE foods SET is_active = 0 WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}

async function logFood(request, env, user) {
  await ensureFoodSchema(env);
  const body = await readJsonSafe(request);
  if (!body?.name) return json({ error: "Name required" }, 400);
  const meal = String(body.meal || "snack").toLowerCase();
  if (!FOOD_MEALS.has(meal)) return json({ error: "Invalid meal" }, 400);
  const now = nowSec();
  const date = normaliseDate(body.logDate) || new Date(now * 1000).toISOString().slice(0, 10);
  // If a food_id was supplied and it's the user's, copy its nutrition snapshot.
  let snap = {
    name: sanitizeText(body.name, 120),
    calories: Number.isFinite(+body.calories) ? +body.calories : null,
    proteinG: Number.isFinite(+body.proteinG) ? +body.proteinG : null,
    carbsG:   Number.isFinite(+body.carbsG)   ? +body.carbsG   : null,
    fatG:     Number.isFinite(+body.fatG)     ? +body.fatG     : null,
    fiberG:   Number.isFinite(+body.fiberG)   ? +body.fiberG   : null,
  };
  if (body.foodId) {
    const f = await env.DB.prepare(
      "SELECT name, calories, protein_g, carbs_g, fat_g, fiber_g FROM foods WHERE id = ? AND user_id = ?"
    ).bind(+body.foodId, user.id).first().catch(() => null);
    if (f) {
      snap = {
        name: f.name, calories: f.calories,
        proteinG: f.protein_g, carbsG: f.carbs_g, fatG: f.fat_g, fiberG: f.fiber_g,
      };
    }
  }
  const servings = Number.isFinite(+body.servings) && +body.servings > 0 ? +body.servings : 1;
  const r = await env.DB.prepare(
    "INSERT INTO food_logs (user_id, food_id, name, meal, calories, protein_g, carbs_g, fat_g, fiber_g, " +
    "  servings, log_date, logged_at, notes) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    user.id, body.foodId ? +body.foodId : null, snap.name, meal,
    snap.calories, snap.proteinG, snap.carbsG, snap.fatG, snap.fiberG,
    servings, date, now, sanitizeText(body.notes, 500),
  ).run();
  return json({ id: r.meta?.last_row_id, ok: true });
}
async function deleteFoodLog(env, user, id) {
  await ensureFoodSchema(env);
  await env.DB.prepare("DELETE FROM food_logs WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}
async function getFoodDay(env, user, date) {
  await ensureFoodSchema(env);
  const d = normaliseDate(date) || new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    "SELECT * FROM food_logs WHERE user_id = ? AND log_date = ? ORDER BY logged_at ASC"
  ).bind(user.id, d).all().catch(() => ({ results: [] }));
  const logs = (r.results || []).map(foodLogRow);
  // Totals
  const totals = logs.reduce((acc, l) => {
    acc.calories += l.calories || 0;
    acc.proteinG += l.proteinG || 0;
    acc.carbsG   += l.carbsG   || 0;
    acc.fatG     += l.fatG     || 0;
    acc.fiberG   += l.fiberG   || 0;
    return acc;
  }, { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 });
  totals.proteinG = +totals.proteinG.toFixed(1);
  totals.carbsG   = +totals.carbsG.toFixed(1);
  totals.fatG     = +totals.fatG.toFixed(1);
  totals.fiberG   = +totals.fiberG.toFixed(1);
  return json({ date: d, logs, totals });
}
async function getFoodWeek(env, user) {
  await ensureFoodSchema(env);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  // One round-trip query for the week's calorie sums.
  const r = await env.DB.prepare(
    "SELECT log_date, " +
    "       SUM(calories * servings) AS calories, " +
    "       SUM(protein_g * servings) AS protein_g, " +
    "       SUM(carbs_g * servings) AS carbs_g, " +
    "       SUM(fat_g * servings) AS fat_g " +
    "FROM food_logs WHERE user_id = ? AND log_date BETWEEN ? AND ? " +
    "GROUP BY log_date"
  ).bind(user.id, days[0], days[6]).all().catch(() => ({ results: [] }));
  const byDate = new Map((r.results || []).map((row) => [row.log_date, row]));
  return json({
    days: days.map((d) => {
      const row = byDate.get(d) || {};
      return {
        date: d,
        calories: Math.round(row.calories || 0),
        proteinG: row.protein_g != null ? +(+row.protein_g).toFixed(1) : 0,
        carbsG:   row.carbs_g   != null ? +(+row.carbs_g).toFixed(1)   : 0,
        fatG:     row.fat_g     != null ? +(+row.fat_g).toFixed(1)     : 0,
      };
    }),
  });
}
async function listFoodPlans(env, user) {
  await ensureFoodSchema(env);
  const r = await env.DB.prepare(
    "SELECT p.id, p.food_id, p.meal, p.days_mask, p.servings, f.name, f.calories, " +
    "       f.protein_g, f.carbs_g, f.fat_g " +
    "FROM food_plans p JOIN foods f ON f.id = p.food_id " +
    "WHERE p.user_id = ? AND f.is_active = 1"
  ).bind(user.id).all().catch(() => ({ results: [] }));
  return json({
    plans: (r.results || []).map((p) => ({
      id: p.id, foodId: p.food_id, name: p.name, meal: p.meal,
      daysMask: p.days_mask, servings: +p.servings,
      calories: p.calories != null ? Math.round(p.calories * (+p.servings || 1)) : null,
    })),
  });
}
async function createFoodPlan(request, env, user) {
  await ensureFoodSchema(env);
  const body = await readJsonSafe(request);
  if (!body?.foodId || !body?.meal || !body?.daysMask) {
    return json({ error: "foodId, meal, daysMask required" }, 400);
  }
  const meal = String(body.meal).toLowerCase();
  if (!FOOD_MEALS.has(meal)) return json({ error: "Invalid meal" }, 400);
  const owned = await env.DB.prepare("SELECT 1 FROM foods WHERE id = ? AND user_id = ?")
    .bind(+body.foodId, user.id).first().catch(() => null);
  if (!owned) return json({ error: "Food not found" }, 404);
  const servings = Number.isFinite(+body.servings) && +body.servings > 0 ? +body.servings : 1;
  const r = await env.DB.prepare(
    "INSERT INTO food_plans (user_id, food_id, meal, days_mask, servings, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(user.id, +body.foodId, meal, +body.daysMask, servings, nowSec()).run();
  return json({ id: r.meta?.last_row_id, ok: true });
}
async function deleteFoodPlan(env, user, id) {
  await ensureFoodSchema(env);
  await env.DB.prepare("DELETE FROM food_plans WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}
async function getFoodPrefs(env, user) {
  await ensureFoodSchema(env);
  const r = await env.DB.prepare(
    "SELECT * FROM user_food_prefs WHERE user_id = ?"
  ).bind(user.id).first().catch(() => null);
  return json({
    dailyCalorieTarget: r?.daily_calorie_target || 2000,
    proteinTargetG: r?.protein_target_g || null,
    carbsTargetG:   r?.carbs_target_g   || null,
    fatTargetG:     r?.fat_target_g     || null,
  });
}
async function updateFoodPrefs(request, env, user) {
  await ensureFoodSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const cal = Number.isFinite(+body.dailyCalorieTarget) ? Math.max(800, Math.min(8000, +body.dailyCalorieTarget)) : 2000;
  const p = Number.isFinite(+body.proteinTargetG) ? Math.max(0, Math.min(500, +body.proteinTargetG)) : null;
  const c = Number.isFinite(+body.carbsTargetG)   ? Math.max(0, Math.min(800, +body.carbsTargetG))   : null;
  const f = Number.isFinite(+body.fatTargetG)     ? Math.max(0, Math.min(400, +body.fatTargetG))     : null;
  const now = nowSec();
  await env.DB.prepare(
    "INSERT INTO user_food_prefs (user_id, daily_calorie_target, protein_target_g, carbs_target_g, fat_target_g, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET " +
    "  daily_calorie_target = ?, protein_target_g = ?, carbs_target_g = ?, fat_target_g = ?, updated_at = ?"
  ).bind(user.id, cal, p, c, f, now, cal, p, c, f, now).run();
  return json({ ok: true, dailyCalorieTarget: cal, proteinTargetG: p, carbsTargetG: c, fatTargetG: f });
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
    "SELECT r.id AS id, r.user_id, r.title, r.category, r.summary, r.body, r.servings, r.prep_minutes, r.cook_minutes, r.image_key, r.is_active, r.created_at, r.updated_at, " +
    "  u.display_name AS author_display, u.username AS author_username, " +
    "  u.avatar_image_key AS author_avatar_key, u.avatar AS author_avatar, " +
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
      imageUrl: r.image_key ? `/api/r/${r.id}/image?v=${r.updated_at || r.created_at || 0}` : null,
      author: r.author_display || r.author_username || "Member",
      authorAvatar: r.author_avatar || null,
      authorAvatarUrl: r.author_avatar_key
        ? "/api/u/" + encodeURIComponent(r.user_id) + "/avatar"
        : null,
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
    "SELECT r.*, u.display_name AS author_display, u.username AS author_username, " +
    "  u.avatar_image_key AS author_avatar_key, u.avatar AS author_avatar " +
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
      imageUrl: r.image_key ? `/api/r/${r.id}/image?v=${r.updated_at || r.created_at || 0}` : null,
      author: r.author_display || r.author_username || "Member",
      authorAvatar: r.author_avatar || null,
      authorAvatarUrl: r.author_avatar_key
        ? "/api/u/" + encodeURIComponent(r.user_id) + "/avatar"
        : null,
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

  // --- Insight configs (Claude prompt management) ------------------------
  if (path === "/insights" && request.method === "GET") {
    return await listInsightConfigs(env);
  }
  const insightMatch = path.match(/^\/insights\/([a-z0-9-]+)$/);
  if (insightMatch && request.method === "PUT") {
    return await updateInsightConfig(request, env, insightMatch[1]);
  }

  // Temporary diagnostic — fires a 1-line prompt at the engine and returns
  // the raw response so admins can sanity-check the Bedrock connection
  // without having to interpret a real insight's "error" string. Safe to
  // remove once the integration is stable.
  if (path === "/insights/test" && request.method === "POST") {
    return await testInsightEngine(env);
  }
  if (path === "/insights/profiles" && request.method === "GET") {
    return await listBedrockInferenceProfiles(env);
  }
  if (path === "/insights/runs" && request.method === "GET") {
    return await listRecentInsightRuns(env);
  }

  if (path === "/dashboard" && request.method === "GET") {
    return await getAdminDashboard(env);
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
    const cols =
      "u.id, u.username, u.email, u.display_name, u.created_at, " +
      "u.endo_status, u.endo_stage, u.research_share_consent, " +
      "(SELECT COUNT(*) FROM circle_members m WHERE m.user_id = u.id) AS circle_count, " +
      "(SELECT COUNT(*) FROM symptoms s WHERE s.user_id = u.id) AS symptom_count";
    if (q) {
      const like = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
      rows = await env.DB.prepare(
        "SELECT " + cols + " FROM users u " +
        "WHERE LOWER(u.username) LIKE ? ESCAPE '\\' OR LOWER(u.email) LIKE ? ESCAPE '\\' OR LOWER(u.display_name) LIKE ? ESCAPE '\\' " +
        "ORDER BY u.created_at DESC LIMIT 200"
      ).bind(like, like, like).all();
    } else {
      rows = await env.DB.prepare(
        "SELECT " + cols + " FROM users u ORDER BY u.created_at DESC LIMIT 200"
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
      endoStatus:           u.endo_status || null,
      endoStage:            u.endo_stage  || null,
      researchShareConsent: u.research_share_consent ? 1 : 0,
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

// =============================================================================
// APPOINTMENTS — medical calendar entries with per-appointment reminder
// preferences. Reminders surface in the in-app notification feed when the
// configured lead time hits; email is stored as a preference for the
// future SMTP worker (no SMTP wired yet).
// =============================================================================
const APPT_KINDS = new Set([
  "general", "gp", "specialist", "surgery", "test", "therapy", "imaging",
  "physio", "scan", "follow_up", "other",
]);
const APPT_REMIND_PRESETS = new Set([
  0, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080,
]);

let _apptSchemaChecked = false;
async function ensureAppointmentSchema(env) {
  if (_apptSchemaChecked) return;
  _apptSchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS appointments (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  title TEXT NOT NULL," +
    "  kind TEXT," +
    "  doctor TEXT," +
    "  location TEXT," +
    "  notes TEXT," +
    "  starts_at INTEGER NOT NULL," +
    "  ends_at INTEGER," +
    "  all_day INTEGER NOT NULL DEFAULT 0," +
    "  color TEXT," +
    "  remind_in_app INTEGER NOT NULL DEFAULT 1," +
    "  remind_email INTEGER NOT NULL DEFAULT 0," +
    "  remind_minutes_before INTEGER NOT NULL DEFAULT 60," +
    "  created_at INTEGER NOT NULL," +
    "  updated_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_appts_user_start ON appointments(user_id, starts_at)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

function parseApptFields(body) {
  const out = {};
  if ("title" in body)    out.title = sanitizeText(body.title, 200);
  if ("kind" in body)     out.kind = APPT_KINDS.has(body.kind) ? body.kind : "general";
  if ("doctor" in body)   out.doctor = sanitizeText(body.doctor, 120) || null;
  if ("location" in body) out.location = sanitizeText(body.location, 240) || null;
  if ("notes" in body)    out.notes = sanitizeText(body.notes, 2000) || null;
  if ("startsAt" in body) {
    const n = Math.floor(+body.startsAt || 0);
    if (n > 0 && n < 4102444800) out.starts_at = n;
  }
  if ("endsAt" in body) {
    if (body.endsAt == null || body.endsAt === "") out.ends_at = null;
    else {
      const n = Math.floor(+body.endsAt || 0);
      if (n > 0 && n < 4102444800) out.ends_at = n;
    }
  }
  if ("allDay" in body)   out.all_day = body.allDay ? 1 : 0;
  if ("color" in body && typeof body.color === "string")
    out.color = body.color.slice(0, 16) || null;
  if ("remindInApp" in body) out.remind_in_app = body.remindInApp ? 1 : 0;
  if ("remindEmail" in body) out.remind_email = body.remindEmail ? 1 : 0;
  if ("remindMinutesBefore" in body) {
    const m = Math.max(0, Math.min(20160, +body.remindMinutesBefore || 0));
    out.remind_minutes_before = APPT_REMIND_PRESETS.has(m) ? m : m;
  }
  return out;
}

function apptRow(r) {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind || "general",
    doctor: r.doctor || null,
    location: r.location || null,
    notes: r.notes || null,
    startsAt: r.starts_at,
    endsAt: r.ends_at || null,
    allDay: !!r.all_day,
    color: r.color || null,
    remindInApp: !!r.remind_in_app,
    remindEmail: !!r.remind_email,
    remindMinutesBefore: r.remind_minutes_before || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function listAppointments(request, env, user) {
  await ensureAppointmentSchema(env);
  const url = new URL(request.url);
  const from = Math.floor(+url.searchParams.get("from") || 0);
  const to   = Math.floor(+url.searchParams.get("to") || 0);
  const where = ["user_id = ?"];
  const binds = [user.id];
  if (from > 0) { where.push("starts_at >= ?"); binds.push(from); }
  if (to > 0)   { where.push("starts_at <= ?"); binds.push(to); }
  const rows = await env.DB.prepare(
    `SELECT * FROM appointments WHERE ${where.join(" AND ")} ORDER BY starts_at ASC LIMIT 500`
  ).bind(...binds).all().catch(() => ({ results: [] }));
  return json({ appointments: (rows.results || []).map(apptRow) });
}

async function listUpcomingAppointments(env, user) {
  await ensureAppointmentSchema(env);
  const now = nowSec();
  const horizon = now + 14 * 86400; // 2 weeks ahead
  const rows = await env.DB.prepare(
    "SELECT * FROM appointments WHERE user_id = ? AND starts_at BETWEEN ? AND ? " +
    "ORDER BY starts_at ASC LIMIT 50"
  ).bind(user.id, now - 3600, horizon).all().catch(() => ({ results: [] }));
  return json({ appointments: (rows.results || []).map(apptRow) });
}

async function getAppointment(env, user, id) {
  await ensureAppointmentSchema(env);
  const r = await env.DB.prepare(
    "SELECT * FROM appointments WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!r) return json({ error: "Appointment not found" }, 404);
  return json({ appointment: apptRow(r) });
}

async function createAppointment(request, env, user, ctx) {
  await ensureAppointmentSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const fields = parseApptFields(body);
  if (!fields.title) return json({ error: "Title is required." }, 400);
  if (!fields.starts_at) return json({ error: "Start time is required." }, 400);
  // Defaults so simple POSTs work without specifying every field.
  if (fields.remind_in_app == null) fields.remind_in_app = 1;
  if (fields.remind_email == null)  fields.remind_email = 0;
  if (fields.remind_minutes_before == null) fields.remind_minutes_before = 60;
  if (fields.all_day == null) fields.all_day = 0;
  if (!fields.kind) fields.kind = "general";

  const now = nowSec();
  const res = await env.DB.prepare(
    "INSERT INTO appointments (user_id, title, kind, doctor, location, notes, " +
    "  starts_at, ends_at, all_day, color, remind_in_app, remind_email, " +
    "  remind_minutes_before, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    user.id, fields.title, fields.kind, fields.doctor || null, fields.location || null,
    fields.notes || null, fields.starts_at, fields.ends_at || null, fields.all_day,
    fields.color || null, fields.remind_in_app, fields.remind_email,
    fields.remind_minutes_before, now, now
  ).run();
  // Kick off any email reminder whose window is already open (e.g. user
  // schedules a "remind 1 day before" for tomorrow morning — we send now).
  dispatchDueAppointmentEmails(env, ctx, user).catch(() => {});
  return json({ ok: true, id: res.meta?.last_row_id });
}

async function updateAppointment(request, env, user, id, ctx) {
  await ensureAppointmentSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const owned = await env.DB.prepare(
    "SELECT id FROM appointments WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!owned) return json({ error: "Appointment not found" }, 404);

  const fields = parseApptFields(body);
  const sets = [], binds = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (!sets.length) return json({ error: "Nothing to update" }, 400);
  sets.push("updated_at = ?");
  binds.push(nowSec(), id, user.id);
  await env.DB.prepare(
    `UPDATE appointments SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`
  ).bind(...binds).run();
  // If the user just turned email reminders on (or the lead time changed
  // and put the window into the present), fire any newly-due sends now.
  dispatchDueAppointmentEmails(env, ctx, user).catch(() => {});
  return json({ ok: true });
}

async function deleteAppointment(env, user, id) {
  await ensureAppointmentSchema(env);
  await env.DB.prepare(
    "DELETE FROM appointments WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).run();
  return json({ ok: true });
}

// Virtual notifications: any upcoming appointment whose reminder window is
// currently open (now is between starts_at - leadMinutes and starts_at + 1h)
// shows up in the bell. Mirror of the medication reminder pattern so the same
// dashboard surface picks them up.
async function computeAppointmentReminders(env, user) {
  await ensureAppointmentSchema(env);
  const now = nowSec();
  const rows = await env.DB.prepare(
    "SELECT id, title, kind, location, starts_at, remind_in_app, remind_minutes_before " +
    "FROM appointments WHERE user_id = ? AND remind_in_app = 1 AND starts_at BETWEEN ? AND ? " +
    "ORDER BY starts_at ASC LIMIT 30"
  ).bind(user.id, now - 3600, now + 14 * 86400).all().catch(() => ({ results: [] }));

  const dismissed = await getDismissedReminderKeys(env, user);

  const out = [];
  for (const r of (rows.results || [])) {
    const lead = (r.remind_minutes_before || 0) * 60;
    const windowOpens = r.starts_at - lead;
    const windowCloses = r.starts_at + 3600;
    if (now < windowOpens) continue;
    if (now > windowCloses) continue;
    const key = `appt:${r.id}`;
    if (dismissed.has(key)) continue;
    const minsAway = Math.max(0, Math.round((r.starts_at - now) / 60));
    out.push({
      id: key,
      type: "appointment_due",
      title: `📅 ${r.title}`,
      body: minsAway === 0
        ? (r.location ? `Starting now · ${r.location}` : "Starting now")
        : `In ${humanMins(minsAway)}${r.location ? " · " + r.location : ""}`,
      action_url: `/appointments?id=${r.id}`,
      created_at: windowOpens,
      read_at: null,
    });
  }
  return out;
}

function humanMins(m) {
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

// =============================================================================
// NOTIFICATION READ STATE — for both real notification rows (read_at column)
// and the synthetic reminders we build for med schedules and appointments. We
// can't add a read_at to something we didn't store, so virtual reminders get
// their own dismissed_reminders row instead. Both endpoints accept any id.
// =============================================================================

let _readSchemaChecked = false;
async function ensureReadSchema(env) {
  if (_readSchemaChecked) return;
  _readSchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS dismissed_reminders (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  reminder_key TEXT NOT NULL," +
    "  read_at INTEGER NOT NULL," +
    "  UNIQUE(user_id, reminder_key)" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_dismissed_reminders_user ON dismissed_reminders(user_id, read_at DESC)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

async function markNotificationRead(env, user, id) {
  await ensureReadSchema(env);
  // Numeric id → real notification row; anything else (med:…, appt:…) is a
  // synthetic reminder and we dismiss by key.
  if (/^\d+$/.test(id)) {
    try {
      await env.DB.prepare(
        "UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?"
      ).bind(nowSec(), +id, user.id).run();
    } catch {}
  } else {
    try {
      await env.DB.prepare(
        "INSERT INTO dismissed_reminders (user_id, reminder_key, read_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(user_id, reminder_key) DO UPDATE SET read_at = excluded.read_at"
      ).bind(user.id, id, nowSec()).run();
    } catch {}
  }
  return json({ ok: true });
}

async function dismissVirtualNotification(env, user, key) {
  // Same effect as marking read — once dismissed, the reminder no longer
  // surfaces in the feed until the underlying record changes (new schedule
  // slot, rescheduled appointment).
  return markNotificationRead(env, user, key);
}

async function markAllNotificationsRead(env, user) {
  await ensureReadSchema(env);
  const now = nowSec();
  // Real DB rows
  try {
    await env.DB.prepare(
      "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL"
    ).bind(now, user.id).run();
  } catch {}
  // Virtual reminders that are currently active: persist their keys so the
  // bell shows zero until something new pops up.
  try {
    const [meds, appts] = await Promise.all([
      computeMedReminders(env, user).catch(() => []),
      computeAppointmentReminders(env, user).catch(() => []),
    ]);
    const all = [...meds, ...appts];
    for (const r of all) {
      try {
        await env.DB.prepare(
          "INSERT INTO dismissed_reminders (user_id, reminder_key, read_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(user_id, reminder_key) DO UPDATE SET read_at = excluded.read_at"
        ).bind(user.id, r.id, now).run();
      } catch {}
    }
  } catch {}
  return json({ ok: true });
}

// Pull the set of dismissed reminder keys that are still "fresh" — we ignore
// dismissals older than 24h so a reminder for tomorrow's appointment isn't
// silenced because the user dismissed yesterday's identical one.
async function getDismissedReminderKeys(env, user) {
  await ensureReadSchema(env);
  const since = nowSec() - 24 * 3600;
  try {
    const rows = await env.DB.prepare(
      "SELECT reminder_key FROM dismissed_reminders WHERE user_id = ? AND read_at >= ?"
    ).bind(user.id, since).all();
    return new Set((rows.results || []).map((r) => r.reminder_key));
  } catch { return new Set(); }
}

// =============================================================================
// EMAIL REMINDERS — sends a branded EndoMe email for any upcoming appointment
// that has remind_email=1 once its reminder window opens. We track sent
// emails in email_log so we never double-send, then use ctx.waitUntil so
// /api/me/today doesn't block on Mandrill.
// =============================================================================
let _emailLogSchemaChecked = false;
async function ensureEmailLogSchema(env) {
  if (_emailLogSchemaChecked) return;
  _emailLogSchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS email_log (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  kind TEXT NOT NULL," +
    "  ref_key TEXT NOT NULL," +
    "  sent_at INTEGER NOT NULL," +
    "  UNIQUE(user_id, kind, ref_key)" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log(user_id, sent_at DESC)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

// Find appointments whose email reminder is due AND hasn't been sent yet,
// then send each one async. The ref_key encodes the appointment id + start
// time + lead minutes so rescheduling the same appointment produces a fresh
// send opportunity.
async function dispatchDueAppointmentEmails(env, ctx, user) {
  if (!env.MANDRILL_API_KEY) return;
  await ensureEmailLogSchema(env);
  await ensureAppointmentSchema(env);
  const now = nowSec();
  const rows = await env.DB.prepare(
    "SELECT id, title, kind, doctor, location, notes, starts_at, all_day, " +
    "       remind_email, remind_minutes_before " +
    "FROM appointments " +
    "WHERE user_id = ? AND remind_email = 1 AND starts_at BETWEEN ? AND ? " +
    "ORDER BY starts_at ASC LIMIT 30"
  ).bind(user.id, now - 600, now + 14 * 86400).all().catch(() => ({ results: [] }));
  if (!(rows.results || []).length) return;

  // Get the user's email + display name for the To: field. We can't send
  // anywhere without it.
  const userRow = await env.DB.prepare(
    "SELECT email, display_name FROM users WHERE id = ?"
  ).bind(user.id).first().catch(() => null);
  if (!userRow?.email) return;

  for (const r of rows.results) {
    const lead = (r.remind_minutes_before || 0) * 60;
    const opens = r.starts_at - lead;
    const closes = r.starts_at + 3600;  // an hour after start: too late to email
    if (now < opens || now > closes) continue;

    const refKey = `appt:${r.id}:${r.starts_at}:${r.remind_minutes_before || 0}`;
    // Skip if we've already sent this exact reminder.
    const seen = await env.DB.prepare(
      "SELECT id FROM email_log WHERE user_id = ? AND kind = 'appt_remind' AND ref_key = ?"
    ).bind(user.id, refKey).first().catch(() => null);
    if (seen) continue;

    // Reserve the slot first so concurrent requests can't double-send.
    let inserted = false;
    try {
      await env.DB.prepare(
        "INSERT INTO email_log (user_id, kind, ref_key, sent_at) VALUES (?, 'appt_remind', ?, ?)"
      ).bind(user.id, refKey, now).run();
      inserted = true;
    } catch { /* unique conflict — another worker won the race */ }
    if (!inserted) continue;

    const job = (async () => {
      try {
        await sendAppointmentReminderEmail(env, userRow, r);
      } catch (err) {
        console.warn("appt email failed:", err?.message);
        // Roll back so we'll retry next request.
        try {
          await env.DB.prepare(
            "DELETE FROM email_log WHERE user_id = ? AND kind = 'appt_remind' AND ref_key = ?"
          ).bind(user.id, refKey).run();
        } catch {}
      }
    })();
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  }
}

async function sendAppointmentReminderEmail(env, userRow, appt) {
  const siteUrl = env.SITE_URL || "https://endome.com";
  const safeName = sanitizeForHtml(userRow.display_name || "there");
  const safeTitle = sanitizeForHtml(appt.title);
  const safeDoctor = appt.doctor ? sanitizeForHtml(appt.doctor) : null;
  const safeLocation = appt.location ? sanitizeForHtml(appt.location) : null;
  const safeNotes = appt.notes ? sanitizeForHtml(appt.notes) : null;
  const kindLabel = appointmentKindLabel(appt.kind);
  const kindEmoji = appointmentKindEmoji(appt.kind);

  const dt = new Date(appt.starts_at * 1000);
  // Server runs UTC. Print both the date+time and a relative-when line so the
  // user gets an immediate sense of urgency without having to mentally diff.
  const dateLine = dt.toUTCString().replace(" GMT", " UTC");
  const minsAway = Math.max(0, Math.round((appt.starts_at - nowSec()) / 60));
  const whenSoon = minsAway === 0 ? "Right now" :
    minsAway < 60 ? `In about ${minsAway} minute${minsAway === 1 ? "" : "s"}` :
    minsAway < 1440 ? `In about ${Math.round(minsAway / 60)} hour${minsAway >= 120 ? "s" : ""}` :
    minsAway < 2880 ? "Tomorrow" :
    `In ${Math.round(minsAway / 1440)} days`;

  const detailRow = (label, value) => value ? `
    <tr>
      <td valign="top" style="padding:4px 12px 4px 0;color:#7a5f6c;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">${label}</td>
      <td valign="top" style="padding:4px 0;color:#3a2330;font-size:15px;line-height:1.55">${value}</td>
    </tr>` : "";

  const html = renderEmail({
    siteUrl,
    preheader: `${whenSoon} · ${safeTitle}`,
    headline: `${kindEmoji} ${safeTitle}`,
    body: `
      <p style="margin:0 0 18px;color:#3a2330;font-size:16px;line-height:1.65">
        Hi ${safeName}, this is your reminder that you have an appointment coming up.
      </p>

      <!-- When card -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px">
        <tr><td bgcolor="#fff0f5" style="background-color:#fff0f5;border-left:4px solid #ff4e8a;padding:18px 22px;border-radius:0 14px 14px 0">
          <p style="margin:0 0 4px;color:#ff4e8a;font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase">
            ${sanitizeForHtml(whenSoon)}
          </p>
          <p style="margin:0;color:#3a2330;font-size:16px;line-height:1.5">
            ${sanitizeForHtml(dateLine)}
          </p>
        </td></tr>
      </table>

      <!-- Detail table -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 22px">
        ${detailRow("Type",     sanitizeForHtml(kindLabel))}
        ${detailRow("Doctor",   safeDoctor)}
        ${detailRow("Location", safeLocation)}
        ${detailRow("Notes",    safeNotes ? safeNotes.replace(/\n/g, "<br>") : null)}
      </table>

      <p style="margin:0 0 14px;color:#7a5f6c;font-size:13px;line-height:1.6">
        You're getting this email because you ticked "email me too" when you saved this appointment. You can change the reminder settings any time from the appointment editor.
      </p>`,
    ctaText: "Open in EndoMe",
    ctaUrl: `${siteUrl}/appointments?id=${appt.id}`,
  });

  const text =
    `${kindEmoji} ${appt.title}\n` +
    `${whenSoon} · ${dateLine}\n\n` +
    (appt.doctor   ? `Doctor: ${appt.doctor}\n`     : "") +
    (appt.location ? `Location: ${appt.location}\n` : "") +
    (appt.notes    ? `\nNotes: ${appt.notes}\n`     : "") +
    `\nOpen in EndoMe: ${siteUrl}/appointments?id=${appt.id}\n\n` +
    `You're getting this because email reminders are on for this appointment. Update them in the EndoMe appointment editor.`;

  await mandrillSend(env, {
    to: [{ email: userRow.email, type: "to" }],
    subject: `🔔 ${appt.title} — ${whenSoon.toLowerCase()}`,
    from_email: env.NEWSLETTER_FROM_EMAIL || FROM_EMAIL_DEFAULT,
    from_name: env.NEWSLETTER_FROM_NAME || "EndoMe",
    headers: { "Reply-To": env.NOTIFY_EMAIL || FROM_EMAIL_DEFAULT },
    html, text,
  });
}

function appointmentKindLabel(k) {
  return ({
    general: "General", gp: "GP visit", specialist: "Specialist",
    surgery: "Surgery", test: "Test", imaging: "Imaging", scan: "Scan",
    therapy: "Therapy", physio: "Physio", follow_up: "Follow-up",
    other: "Other",
  })[k] || "Appointment";
}
function appointmentKindEmoji(k) {
  return ({
    general: "📅", gp: "🩺", specialist: "👩‍⚕️", surgery: "🏥",
    test: "🧪", imaging: "🔬", scan: "📡", therapy: "🧠",
    physio: "🤸", follow_up: "🔁", other: "✨",
  })[k] || "📅";
}
function sanitizeForHtml(s) {
  return String(s ?? "").replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// =============================================================================
// DAILY LOG MIGRATIONS — best-effort ADD COLUMNs for the richer check-in
// flow (morning + midday body-check tags, evening relief tags). SQLite has
// no IF NOT EXISTS for ADD COLUMN so we swallow the duplicate-column errors.
// =============================================================================
let _dailyExtrasChecked = false;
async function ensureDailyExtras(env) {
  if (_dailyExtrasChecked) return;
  _dailyExtrasChecked = true;
  const stmts = [
    "ALTER TABLE daily_logs ADD COLUMN morning_symptoms TEXT",
    "ALTER TABLE daily_logs ADD COLUMN afternoon_logged_at INTEGER",
    "ALTER TABLE daily_logs ADD COLUMN afternoon_mood INTEGER",
    "ALTER TABLE daily_logs ADD COLUMN afternoon_energy INTEGER",
    "ALTER TABLE daily_logs ADD COLUMN afternoon_pain INTEGER",
    "ALTER TABLE daily_logs ADD COLUMN afternoon_symptoms TEXT",
    "ALTER TABLE daily_logs ADD COLUMN afternoon_notes TEXT",
    "ALTER TABLE daily_logs ADD COLUMN evening_relief TEXT",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

async function postAfternoonCheckin(request, env, user) {
  await ensureDailyExtras(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);

  const mood = clampInt(body.mood, 1, 5);
  const energy = clampInt(body.energy, 1, 5);
  const pain = clampInt(body.pain, 1, 5);
  if (mood == null || energy == null || pain == null) {
    return json({ error: "mood, energy and pain are required (1–5)" }, 400);
  }
  const symptoms = tagList(body.afternoonSymptoms, ALLOWED_EVENING_SYMPTOMS);
  const notes    = sanitizeText(body.notes, 1000);

  const date = normaliseDate(body.date);
  const now = nowSec();

  const existing = await env.DB
    .prepare("SELECT afternoon_logged_at FROM daily_logs WHERE user_id = ? AND log_date = ?")
    .bind(user.id, date).first().catch(() => null);

  const firstTime = !existing?.afternoon_logged_at;
  const pointsAwarded = firstTime ? 10 : 0;

  await env.DB.prepare(
    `INSERT INTO daily_logs (
       user_id, log_date,
       afternoon_mood, afternoon_energy, afternoon_pain,
       afternoon_symptoms, afternoon_notes, afternoon_logged_at,
       points_total)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       afternoon_mood       = excluded.afternoon_mood,
       afternoon_energy     = excluded.afternoon_energy,
       afternoon_pain       = excluded.afternoon_pain,
       afternoon_symptoms   = excluded.afternoon_symptoms,
       afternoon_notes      = excluded.afternoon_notes,
       afternoon_logged_at  = COALESCE(daily_logs.afternoon_logged_at, excluded.afternoon_logged_at),
       points_total         = daily_logs.points_total + ?9`
  ).bind(
    user.id, date,
    mood, energy, pain,
    symptoms, notes, now,
    pointsAwarded
  ).run();

  const pet = await awardXp(env, user.id, pointsAwarded, date);
  return json({ ok: true, pointsAwarded, pet });
}

// =============================================================================
// AVATAR IMAGES — uploaded portraits in the same R2 bucket the documents
// feature uses, namespaced under users/<id>/avatar.<ext>. GET is public so
// embedding in posts works; POST/DELETE require the owner's session.
// =============================================================================
const ALLOWED_AVATAR_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
]);
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;
const AVATAR_EXT_FOR = {
  "image/png":"png","image/jpeg":"jpg","image/jpg":"jpg","image/webp":"webp","image/gif":"gif",
};

async function uploadAvatar(request, env, user) {
  if (!env.DOCS) return json({ error: "Image storage not configured" }, 503);
  const ct = request.headers.get("content-type") || "";
  if (!ct.startsWith("multipart/form-data")) {
    return json({ error: "Upload must be multipart/form-data" }, 400);
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Missing file" }, 400);
  if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
    return json({ error: "Image must be PNG, JPG, WEBP or GIF." }, 400);
  }
  if (file.size <= 0 || file.size > MAX_AVATAR_BYTES) {
    return json({ error: `Image too large — max ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)} MB.` }, 413);
  }

  await ensureProfileSchema(env);
  const ext = AVATAR_EXT_FOR[file.type] || "jpg";
  const key = `users/${user.id}/avatar.${ext}`;
  const buf = await file.arrayBuffer();
  await env.DOCS.put(key, buf, {
    httpMetadata: { contentType: file.type, cacheControl: "public, max-age=86400" },
  });

  // Clean up the old image if its extension is different.
  try {
    const existing = await env.DB.prepare(
      "SELECT avatar_image_key FROM users WHERE id = ?"
    ).bind(user.id).first();
    if (existing?.avatar_image_key && existing.avatar_image_key !== key) {
      await env.DOCS.delete(existing.avatar_image_key);
    }
  } catch {}

  await env.DB.prepare(
    "UPDATE users SET avatar_image_key = ? WHERE id = ?"
  ).bind(key, user.id).run();

  return json({ ok: true, avatarUrl: `/api/u/${encodeURIComponent(user.id)}/avatar?v=${nowSec()}` });
}

async function deleteAvatar(env, user) {
  await ensureProfileSchema(env);
  try {
    const row = await env.DB.prepare(
      "SELECT avatar_image_key FROM users WHERE id = ?"
    ).bind(user.id).first();
    if (row?.avatar_image_key && env.DOCS) {
      await env.DOCS.delete(row.avatar_image_key).catch(() => {});
    }
  } catch {}
  await env.DB.prepare(
    "UPDATE users SET avatar_image_key = NULL WHERE id = ?"
  ).bind(user.id).run();
  return json({ ok: true });
}

async function serveAvatar(env, userId) {
  if (!env.DOCS) return new Response("no storage", { status: 404 });
  await ensureProfileSchema(env);
  const row = await env.DB.prepare(
    "SELECT avatar_image_key FROM users WHERE id = ?"
  ).bind(userId).first().catch(() => null);
  if (!row?.avatar_image_key) return new Response("not found", { status: 404 });
  const obj = await env.DOCS.get(row.avatar_image_key);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType || "image/jpeg");
  headers.set("cache-control", "public, max-age=3600");
  return new Response(obj.body, { headers });
}

// =============================================================================
// RECIPE EDIT + PHOTO — owners can update their own recipes and attach a
// hero image stored in R2 under recipes/<id>/cover.<ext>. The public GET
// route at /api/r/:id/image lets cards embed the photo without auth.
// =============================================================================
const ALLOWED_RECIPE_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp",
]);
const MAX_RECIPE_IMAGE_BYTES = 6 * 1024 * 1024;
const RECIPE_IMAGE_EXT_FOR = {
  "image/png":"png","image/jpeg":"jpg","image/jpg":"jpg","image/webp":"webp",
};

async function updateRecipe(request, env, user, id) {
  await ensureRecipeSchema(env);
  const owned = await env.DB.prepare(
    "SELECT id FROM recipes WHERE id = ? AND user_id = ? AND is_active = 1"
  ).bind(id, user.id).first().catch(() => null);
  if (!owned) return json({ error: "Recipe not found" }, 404);

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

  const now = nowSec();
  await env.DB.prepare(
    "UPDATE recipes SET title = ?, category = ?, summary = ?, body = ?, " +
    "servings = ?, prep_minutes = ?, cook_minutes = ?, updated_at = ? " +
    "WHERE id = ? AND user_id = ?"
  ).bind(
    title, category, summary, bodyText,
    servings, prep, cook, now, id, user.id
  ).run();

  // If the client supplied an ingredients array, replace the whole list. The
  // editor always sends the full list it intends to keep, so this is the
  // cleanest path and saves a per-row diff.
  if (Array.isArray(body.ingredients)) {
    await env.DB.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?")
      .bind(id).run();
    for (const ing of body.ingredients.slice(0, 60)) {
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
        ).bind(id, foodId, foodName, quantity, unit, notes).run();
      } catch {}
    }
  }
  return json({ ok: true });
}

async function uploadRecipeImage(request, env, user, id) {
  if (!env.DOCS) return json({ error: "Image storage not configured" }, 503);
  await ensureRecipeSchema(env);
  const owned = await env.DB.prepare(
    "SELECT id, image_key FROM recipes WHERE id = ? AND user_id = ? AND is_active = 1"
  ).bind(id, user.id).first().catch(() => null);
  if (!owned) return json({ error: "Recipe not found" }, 404);

  const ct = request.headers.get("content-type") || "";
  if (!ct.startsWith("multipart/form-data")) {
    return json({ error: "Upload must be multipart/form-data" }, 400);
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Missing file" }, 400);
  if (!ALLOWED_RECIPE_IMAGE_TYPES.has(file.type)) {
    return json({ error: "Image must be PNG, JPG or WEBP." }, 400);
  }
  if (file.size <= 0 || file.size > MAX_RECIPE_IMAGE_BYTES) {
    return json({ error: `Image too large — max ${Math.round(MAX_RECIPE_IMAGE_BYTES / 1024 / 1024)} MB.` }, 413);
  }

  const ext = RECIPE_IMAGE_EXT_FOR[file.type] || "jpg";
  const key = `recipes/${id}/cover.${ext}`;
  const buf = await file.arrayBuffer();
  await env.DOCS.put(key, buf, {
    httpMetadata: { contentType: file.type, cacheControl: "public, max-age=86400" },
  });
  // Old photo with a different extension would be orphaned otherwise.
  if (owned.image_key && owned.image_key !== key) {
    try { await env.DOCS.delete(owned.image_key); } catch {}
  }
  await env.DB.prepare(
    "UPDATE recipes SET image_key = ?, updated_at = ? WHERE id = ?"
  ).bind(key, nowSec(), id).run();
  return json({ ok: true, imageUrl: `/api/r/${id}/image?v=${nowSec()}` });
}

async function deleteRecipeImage(env, user, id) {
  await ensureRecipeSchema(env);
  const owned = await env.DB.prepare(
    "SELECT id, image_key FROM recipes WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!owned) return json({ error: "Recipe not found" }, 404);
  if (owned.image_key && env.DOCS) {
    try { await env.DOCS.delete(owned.image_key); } catch {}
  }
  await env.DB.prepare(
    "UPDATE recipes SET image_key = NULL, updated_at = ? WHERE id = ?"
  ).bind(nowSec(), id).run();
  return json({ ok: true });
}

async function serveRecipeImage(env, id) {
  if (!env.DOCS) return new Response("no storage", { status: 404 });
  await ensureRecipeSchema(env);
  const row = await env.DB.prepare(
    "SELECT image_key FROM recipes WHERE id = ? AND is_active = 1"
  ).bind(id).first().catch(() => null);
  if (!row?.image_key) return new Response("not found", { status: 404 });
  const obj = await env.DOCS.get(row.image_key);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType || "image/jpeg");
  headers.set("cache-control", "public, max-age=3600");
  return new Response(obj.body, { headers });
}

// =============================================================================
// TOP RECIPES — used by the right rail on /recipes. Ranked by ❤ count then
// recency. Cap small so it visually balances the calendar-style cards.
// =============================================================================
async function listTopRecipes(env, user) {
  await ensureRecipeSchema(env);
  const rows = await env.DB.prepare(
    "SELECT r.id, r.title, r.category, r.image_key, r.created_at, r.updated_at, r.user_id, " +
    "  u.display_name AS author_display, u.username AS author_username, " +
    "  (SELECT COUNT(*) FROM recipe_reactions WHERE recipe_id = r.id AND reaction='love') AS loves " +
    "FROM recipes r LEFT JOIN users u ON u.id = r.user_id " +
    "WHERE r.is_active = 1 " +
    "ORDER BY loves DESC, r.created_at DESC LIMIT 6"
  ).all().catch(() => ({ results: [] }));
  return json({
    recipes: (rows.results || []).map((r) => ({
      id: r.id, title: r.title, category: r.category,
      imageUrl: r.image_key ? `/api/r/${r.id}/image?v=${r.updated_at || r.created_at || 0}` : null,
      author: r.author_display || r.author_username || "Member",
      loves: r.loves || 0,
      isMine: r.user_id === user.id,
    })),
  });
}

// =============================================================================
// TEST RESULTS — once a user's EndoMe DNA / Bloods / Map test has been
// processed, the assessed dataset lands in `test_results`. The page at
// /tests reads from here to render the rich, infographic-style detail view.
// =============================================================================
const ALLOWED_TEST_KINDS = new Set(["dna", "bloods", "map", "hormone"]);

let _testResultsSchemaChecked = false;
async function ensureTestResultsSchema(env) {
  if (_testResultsSchemaChecked) return;
  _testResultsSchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS test_results (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  kind TEXT NOT NULL," +              // dna | bloods | map | hormone
    "  title TEXT NOT NULL," +
    "  summary TEXT," +
    "  data_json TEXT NOT NULL," +         // structured result + ranges
    "  assessed_at INTEGER NOT NULL," +
    "  created_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_test_results_user ON test_results(user_id, assessed_at DESC)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
}

// Seed a curated demo result of each kind for tom@bluerydge.com so the page
// has something to render out of the box. Runs once per user — checks for
// any existing test_results row before inserting.
async function seedDemoTestResults(env, user) {
  if (user.username !== "tom@bluerydge.com") return;
  await ensureTestResultsSchema(env);
  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM test_results WHERE user_id = ?"
  ).bind(user.id).first().catch(() => ({ n: 0 }));
  if ((existing?.n || 0) > 0) return;

  const now = nowSec();
  const oneMonthAgo = now - 30 * 86400;
  const twoMonthsAgo = now - 60 * 86400;
  const rows = [
    {
      kind: "dna", title: "EndoMe DNA — September panel",
      summary: "Your genetics suggest slower oestrogen clearance and reduced folate metabolism. Magnesium glycinate, methylfolate and NAC are the strongest leverage points.",
      assessed_at: now - 3 * 86400,
      data: demoDnaResult(),
    },
    {
      kind: "bloods", title: "EndoMe Bloods — August draw",
      summary: "Vitamin D and ferritin are running low and inflammation is mildly elevated. Iron + vitamin D supplementation and an anti-inflammatory week recommended.",
      assessed_at: oneMonthAgo,
      data: demoBloodsResult(),
    },
    {
      kind: "map", title: "EndoMe Map — July hormone profile",
      summary: "Oestrogen-dominant pattern with sluggish 2-OH clearance and a flattened cortisol curve. The pattern matches early-luteal endo flares.",
      assessed_at: twoMonthsAgo,
      data: demoMapResult(),
    },
  ];

  for (const r of rows) {
    try {
      await env.DB.prepare(
        "INSERT INTO test_results (user_id, kind, title, summary, data_json, assessed_at, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(user.id, r.kind, r.title, r.summary, JSON.stringify(r.data), r.assessed_at, now).run();
    } catch (err) {
      console.warn("seed test result:", err?.message);
    }
  }
}

function demoDnaResult() {
  // Each marker is rendered as a stat bar in the UI. value is the user's
  // result; range is the population reference; cohort is a placeholder for
  // "average of other EndoMe users" so we can show the comparison line.
  return {
    overview: {
      themes: [
        { label: "Oestrogen processing", score: "slower than average", tone: "warn" },
        { label: "Inflammation tendency", score: "moderate", tone: "warn" },
        { label: "Detox pathways", score: "needs nutrient support", tone: "warn" },
        { label: "Nutrient absorption", score: "good — most pathways intact", tone: "ok" },
      ],
    },
    sections: [
      {
        title: "Hormone processing",
        metrics: [
          { name: "COMT (catechol-O-methyltransferase)", value: "Val/Met", status: "slow", note: "Slower oestrogen clearance. Magnesium glycinate + methylated B vitamins help." },
          { name: "CYP1A1", value: "Wild-type", status: "normal", note: "Phase 1 oestrogen metabolism running normally." },
          { name: "CYP1B1", value: "Variant", status: "warn", note: "Higher production of 4-OH oestrogen metabolites — pair with antioxidants." },
        ],
      },
      {
        title: "Inflammation + detox",
        metrics: [
          { name: "MTHFR C677T", value: "Heterozygous", status: "warn", note: "Reduced folate metabolism. Switch to methylfolate over folic acid." },
          { name: "GSTM1 / GSTT1", value: "Single deletion", status: "warn", note: "Reduced glutathione detox. NAC + cruciferous vegetables daily." },
          { name: "SOD2", value: "Variant", status: "warn", note: "Lower mitochondrial antioxidant capacity. CoQ10 + manganese support helps." },
        ],
      },
      {
        title: "Nutrient + energy",
        metrics: [
          { name: "VDR (vitamin D receptor)", value: "BsmI bb", status: "ok", note: "Standard vitamin D response. Aim for 1000–2000 IU daily." },
          { name: "FTO", value: "Wild-type", status: "ok", note: "No appetite-regulation variant." },
          { name: "MTRR A66G", value: "Heterozygous", status: "normal", note: "Slightly slower B12 recycling — methylcobalamin form preferred." },
        ],
      },
    ],
    actions: [
      { emoji: "💊", label: "Methylfolate 400mcg + methylcobalamin 1000mcg daily" },
      { emoji: "🍵", label: "NAC 600mg twice daily for 8 weeks" },
      { emoji: "🥦", label: "Cruciferous vegetables (broccoli, kale) at least 4 days/week" },
      { emoji: "🧴", label: "Magnesium glycinate 300mg at night" },
    ],
  };
}

function demoBloodsResult() {
  return {
    overview: {
      themes: [
        { label: "Inflammation", score: "mildly elevated", tone: "warn" },
        { label: "Iron status", score: "low — replenish", tone: "warn" },
        { label: "Vitamin D", score: "below target", tone: "warn" },
        { label: "Thyroid", score: "in range", tone: "ok" },
      ],
    },
    markers: [
      { name: "C-reactive protein (CRP)", value: 4.8, unit: "mg/L", low: 0, high: 3, cohort: 3.6, prev: 6.1, tone: "warn", note: "Mildly elevated — typical for endo flares. Anti-inflammatory diet + omega-3 recommended." },
      { name: "Ferritin", value: 18, unit: "ng/mL", low: 30, high: 200, cohort: 42, prev: 22, tone: "warn", note: "Below the floor of the healthy range. Heavy periods are likely the cause." },
      { name: "Iron (serum)", value: 9.2, unit: "umol/L", low: 11, high: 30, cohort: 16, prev: 10.4, tone: "warn", note: "Low. Pair iron supplements with vitamin C, away from coffee + tea." },
      { name: "Vitamin D (25-OH)", value: 42, unit: "nmol/L", low: 75, high: 200, cohort: 78, prev: 38, tone: "warn", note: "Below the optimal 75+ nmol/L target. 2000 IU/day for 12 weeks then re-test." },
      { name: "Vitamin B12", value: 412, unit: "pmol/L", low: 200, high: 900, cohort: 480, prev: 390, tone: "ok", note: "Comfortably in range." },
      { name: "TSH", value: 1.8, unit: "mIU/L", low: 0.4, high: 4, cohort: 2.1, prev: 1.7, tone: "ok", note: "Thyroid stimulating hormone in target range." },
      { name: "Free T4", value: 14.5, unit: "pmol/L", low: 12, high: 22, cohort: 15.6, prev: 14.2, tone: "ok", note: "Stable." },
      { name: "Estradiol (day 3)", value: 178, unit: "pmol/L", low: 90, high: 250, cohort: 165, prev: 192, tone: "ok", note: "Within follicular-phase reference range." },
      { name: "Progesterone (day 21)", value: 28, unit: "nmol/L", low: 16, high: 80, cohort: 38, prev: 24, tone: "ok", note: "Adequate ovulation marker." },
      { name: "AMH", value: 14.2, unit: "pmol/L", low: 7, high: 47, cohort: 18, prev: 15.4, tone: "ok", note: "Normal ovarian reserve for your age cohort." },
    ],
  };
}

function demoMapResult() {
  return {
    overview: {
      themes: [
        { label: "Oestrogen dominance", score: "elevated estradiol", tone: "warn" },
        { label: "2-OH clearance", score: "sluggish", tone: "warn" },
        { label: "Cortisol rhythm", score: "flattened curve", tone: "warn" },
        { label: "Progesterone", score: "ok", tone: "ok" },
      ],
    },
    estrogens: [
      { name: "Estradiol (E2)", value: 4.2, unit: "ng/mg Cr", low: 1, high: 3.5, cohort: 2.6, prev: 4.0, tone: "warn", note: "Elevated. Drives endometrial proliferation." },
      { name: "Estrone (E1)", value: 8.1, unit: "ng/mg Cr", low: 2, high: 7, cohort: 5.2, prev: 7.8, tone: "warn", note: "High. Often follows from elevated E2." },
      { name: "Estriol (E3)", value: 3.8, unit: "ng/mg Cr", low: 1, high: 5, cohort: 3.4, prev: 3.6, tone: "ok", note: "Within range — the protective metabolite." },
    ],
    metabolites: [
      { name: "2-OH oestrogen (protective)", value: 28, unit: "%", low: 60, high: 80, cohort: 62, prev: 30, tone: "warn", note: "Lower than ideal. NAC + DIM support this pathway." },
      { name: "4-OH oestrogen (risky)", value: 22, unit: "%", low: 0, high: 10, cohort: 8, prev: 20, tone: "warn", note: "Elevated. Pair with antioxidants (curcumin, NAC, glutathione)." },
      { name: "16-OH oestrogen (proliferative)", value: 50, unit: "%", low: 10, high: 30, cohort: 30, prev: 50, tone: "warn", note: "High. Cruciferous vegetables + fibre help shift the ratio." },
    ],
    progesterone: [
      { name: "Progesterone (24h)", value: 2.4, unit: "ng/mg Cr", low: 1.5, high: 5, cohort: 3.1, prev: 2.6, tone: "ok", note: "Within range." },
    ],
    cortisol: [
      { name: "Cortisol AM (waking)", value: 35, unit: "ng/mg Cr", low: 50, high: 120, cohort: 78, prev: 32, tone: "warn", note: "Low morning cortisol — often correlates with fatigue." },
      { name: "Cortisol noon", value: 38, unit: "ng/mg Cr", low: 25, high: 75, cohort: 42, prev: 36, tone: "ok", note: "Adequate." },
      { name: "Cortisol PM", value: 32, unit: "ng/mg Cr", low: 8, high: 25, cohort: 18, prev: 30, tone: "warn", note: "Elevated evening cortisol — disrupts sleep." },
    ],
    androgens: [
      { name: "DHEA-S", value: 142, unit: "ng/mg Cr", low: 50, high: 300, cohort: 165, prev: 138, tone: "ok", note: "Adequate adrenal androgen." },
      { name: "Testosterone", value: 0.42, unit: "ng/mg Cr", low: 0.1, high: 1, cohort: 0.55, prev: 0.40, tone: "ok", note: "Within range." },
    ],
  };
}

async function listTestResults(env, user) {
  await ensureTestResultsSchema(env);
  // Lazy-seed for the demo account on first list call.
  await seedDemoTestResults(env, user).catch(() => {});
  const rows = await env.DB.prepare(
    "SELECT id, kind, title, summary, assessed_at, created_at " +
    "FROM test_results WHERE user_id = ? ORDER BY assessed_at DESC LIMIT 100"
  ).bind(user.id).all().catch(() => ({ results: [] }));
  return json({
    results: (rows.results || []).map((r) => ({
      id: r.id, kind: r.kind, title: r.title, summary: r.summary,
      assessedAt: r.assessed_at, createdAt: r.created_at,
    })),
  });
}

async function getTestResult(env, user, id) {
  await ensureTestResultsSchema(env);
  const row = await env.DB.prepare(
    "SELECT * FROM test_results WHERE id = ? AND user_id = ?"
  ).bind(id, user.id).first().catch(() => null);
  if (!row) return json({ error: "Result not found" }, 404);
  let data = {};
  try { data = JSON.parse(row.data_json); } catch {}
  return json({
    result: {
      id: row.id, kind: row.kind, title: row.title, summary: row.summary,
      assessedAt: row.assessed_at, createdAt: row.created_at, data,
    },
  });
}

// =============================================================================
// AI INSIGHTS — aggregates the user's logged health data (symptoms, daily
// check-ins, medications, test results, appointments) and runs a per-insight
// Claude prompt against it via Anthropic on AWS Bedrock. Each insight has a
// configurable prompt template stored in `insight_configs` so the prompts
// can be tuned in the admin panel without redeploying.
// =============================================================================

let _insightSchemaChecked = false;
async function ensureInsightSchema(env) {
  if (_insightSchemaChecked) return;
  _insightSchemaChecked = true;
  const stmts = [
    "CREATE TABLE IF NOT EXISTS insight_configs (" +
    "  slug TEXT PRIMARY KEY," +
    "  title TEXT NOT NULL," +
    "  emoji TEXT," +
    "  description TEXT," +
    "  prompt_template TEXT NOT NULL," +
    "  data_scope_json TEXT NOT NULL," +
    "  refresh_hours INTEGER NOT NULL DEFAULT 24," +
    "  model TEXT," +
    "  sort_order INTEGER NOT NULL DEFAULT 100," +
    "  enabled INTEGER NOT NULL DEFAULT 1," +
    "  created_at INTEGER NOT NULL," +
    "  updated_at INTEGER NOT NULL" +
    ")",
    "CREATE TABLE IF NOT EXISTS insight_runs (" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
    "  user_id TEXT NOT NULL," +
    "  slug TEXT NOT NULL," +
    "  output_md TEXT," +
    "  status TEXT NOT NULL," +              // ok | error | empty | running
    "  error TEXT," +
    "  input_tokens INTEGER," +
    "  output_tokens INTEGER," +
    "  generated_at INTEGER NOT NULL" +
    ")",
    "CREATE INDEX IF NOT EXISTS idx_insight_runs_user ON insight_runs(user_id, slug, generated_at DESC)",
  ];
  for (const s of stmts) { try { await env.DB.prepare(s).run(); } catch {} }
  await seedInsightDefaults(env);
}

// One-time seeding of the starter insight pack. Re-running is safe — we only
// insert configs that aren't already present so admin edits aren't clobbered.
async function seedInsightDefaults(env) {
  const now = nowSec();
  const defaults = [
    {
      slug: "pattern-spotter", emoji: "🔍", sort_order: 10,
      title: "Pattern spotter",
      description: "Looks across the last 30 days of symptoms and highlights the patterns you might have missed.",
      data_scope: ["symptoms_30d", "daily_logs_30d"],
      prompt_template:
        "You are a careful, evidence-aware women's health analyst speaking with someone living with endometriosis. " +
        "Below is the user's logged symptom and daily check-in data for the past 30 days. " +
        "Identify the 3–5 strongest patterns you can see — symptom co-occurrences, times of day, days of cycle, severity clusters. " +
        "For each pattern, give a one-line evidence statement (what the data shows) and a one-line plain-English interpretation. " +
        "Be specific about what they logged. Never invent data they didn't enter. " +
        "End with one short paragraph about which pattern would be most useful to track more closely next month. " +
        "Render as markdown — short paragraphs, no big headings, bullet points where they help.\n\n" +
        "DATA:\n{context}",
    },
    {
      slug: "cycle-correlation", emoji: "🌀", sort_order: 20,
      title: "Cycle ↔ symptoms",
      description: "Maps symptom flares against your cycle phase so you can prepare for the days that get hardest.",
      data_scope: ["symptoms_30d", "daily_logs_30d"],
      prompt_template:
        "You are an analyst helping someone with endometriosis spot cycle patterns. " +
        "Below is their cycle + symptom log for the past 30 days. " +
        "For each cycle phase the data covers (menstrual, follicular, ovulation, luteal), summarise: " +
        "(1) what symptoms cluster there, (2) typical severity, (3) one tactical preparation that the data + endo literature suggest may help. " +
        "Be honest if you don't have enough data for a phase. " +
        "Render as markdown.\n\n" +
        "DATA:\n{context}",
    },
    {
      slug: "whats-working", emoji: "💚", sort_order: 30,
      title: "What's working",
      description: "Looks at the meds, supplements and lifestyle moves you've logged and ranks what seems to be helping.",
      data_scope: ["symptoms_30d", "medications", "medication_logs_30d", "daily_logs_30d", "food_logs_30d"],
      prompt_template:
        "You are reviewing the user's medications, supplements and what-helped tags from the last 30 days. " +
        "Rank the interventions by the strength of the apparent association with lower pain / better mood / better energy logs. " +
        "Be careful: this is correlation, not causation — say so. " +
        "Call out anything they're taking that doesn't appear to be helping. " +
        "If something is being taken too rarely to judge, say that. " +
        "End with one experiment they could run this month (e.g. 'try magnesium glycinate consistently for 21 days and re-check'). " +
        "Render as markdown.\n\n" +
        "DATA:\n{context}",
    },
    {
      slug: "endo-pattern-watch", emoji: "🔭", sort_order: 8,
      title: "What we're noticing",
      description: "For users on the early-diagnosis watch — flags the endo-pattern markers we can see in your logs and what they typically mean.",
      data_scope: ["symptoms_30d", "daily_logs_30d"],
      prompt_template:
        "You are EndoMe — a warm, knowledgeable companion writing the user's 'What we're noticing' report. " +
        "This user is on our early-diagnosis pattern watch (status: not yet diagnosed, opted-in). " +
        "Below is their last 30 days of symptoms + daily check-ins. The well-known endometriosis symptom cluster " +
        "includes: recurring pelvic pain, severe pain episodes, pain clustering around the period, heavy " +
        "menstrual bleeding, painful urination, painful bowel movements, painful sex (dyspareunia), chronic " +
        "fatigue, bloating / 'endo belly', and recurring lower-back pain. " +
        "Walk through which of those markers you can SEE in their data, citing real dates / severities / triggers. " +
        "Be honest about markers that AREN'T present. " +
        "Then explain in plain language why the present pattern is worth knowing — not as a diagnosis (you can't " +
        "diagnose), but as something to track + raise with their care team if they choose to. " +
        "End with 2-3 specific things they could log over the next month to sharpen the picture (e.g. flow level " +
        "during their period, bowel symptoms during menses, fatigue severity rating). " +
        "Warm, plain, specific. Render as markdown. Never alarmist.\n\n" +
        "DATA:\n{context}",
    },
    {
      slug: "food-flares", emoji: "🍽", sort_order: 35,
      title: "What's on your plate",
      description: "Pairs your food log with your symptoms to spot which foods seem to precede flare days.",
      data_scope: ["symptoms_30d", "food_logs_30d", "cravings_30d", "daily_logs_30d"],
      prompt_template:
        "You are reviewing the user's food log alongside their symptoms and daily check-ins for the past 30 days. " +
        "Endo flares are often driven by inflammatory + FODMAP-style food triggers — common offenders include " +
        "dairy, gluten, alcohol, refined sugar, ultra-processed food, high omega-6 seed oils, and high-FODMAP " +
        "vegetables/fruit/legumes for those with 'endo belly'. " +
        "Your job: pair flare days (higher pain, lower mood/energy, bloating, bowel symptoms) with what they ate " +
        "in the prior 24–48 hours. Call out specific patterns you can SEE in their data (e.g. \"every Sunday flare " +
        "this month followed Saturday-night alcohol\", \"dairy appeared in food log on 3 of the 4 worst pain days\"). " +
        "Then suggest ONE specific elimination trial worth running this month (e.g. \"cut dairy for 14 days, " +
        "we'll re-check the pattern\") with the mechanism in one sentence. " +
        "If the food log is sparse, say so honestly and encourage tracking. " +
        "Be evidence-aware, specific, warm, and never preach. Render as markdown.\n\n" +
        "DATA:\n{context}",
    },
    {
      slug: "next-steps", emoji: "🎯", sort_order: 40,
      title: "Your next 3 steps",
      description: "Cuts through everything you've logged + the results we have on file and gives you the 3 highest-leverage moves this month.",
      data_scope: ["symptoms_30d", "daily_logs_30d", "medications", "food_logs_30d", "test_results", "appointments_60d"],
      prompt_template:
        "You are an evidence-aware care navigator for someone with endometriosis. " +
        "Below is everything we have on them — symptoms, daily check-ins, current medications, recent test results, and upcoming appointments. " +
        "Synthesise the 3 highest-leverage actions for the next 30 days. " +
        "For each action, write a 2–3 sentence rationale grounded in the user's own data + endo literature. " +
        "Keep the language warm but direct — this is what the data is telling them, not vague wellness advice. " +
        "If a step is best taken with their clinician, say so explicitly. " +
        "Render as markdown.\n\n" +
        "DATA:\n{context}",
    },
    {
      slug: "monthly-summary", emoji: "📅", sort_order: 5,
      refresh_hours: 720,
      title: "This month in review",
      description: "A warm, narrative monthly write-up of how things are tracking — symptoms, daily check-ins, medications, food, results and what's coming up next.",
      data_scope: [
        "symptoms_30d", "daily_logs_30d", "medications", "medication_logs_30d",
        "food_logs_30d", "test_results", "appointments_60d",
      ],
      prompt_template:
        "You are EndoMe — a calm, evidence-aware companion writing a one-page monthly summary for someone living with endometriosis. " +
        "Below is everything they logged across the last month: symptoms, daily check-ins, current medications, dose adherence, test results on file, and recent + upcoming appointments. " +
        "Write a warm, plain-language overview titled \"This month in review\". " +
        "Cover, in this order: " +
        "(1) the headline — one sentence on how the month has gone overall; " +
        "(2) what stood out — 3 to 5 short bullets covering the most striking patterns in their symptoms, mood, energy, sleep and cycle; " +
        "(3) medications + supplements — what they're taking, how consistent the dosing has been, and any apparent association with how they felt; " +
        "(4) tests + results — anything new on file worth re-reading; " +
        "(5) the month ahead — upcoming appointments + two or three suggested focus areas grounded in their data. " +
        "Always speak directly to the user (\"you\"), be specific about what they actually logged, and never invent data. " +
        "If a section has too little data, say so kindly in a single line and move on. " +
        "Render as markdown — short paragraphs, soft headings (####), bullets where they help. Keep the whole thing under 500 words.\n\n" +
        "DATA:\n{context}",
    },
    {
      slug: "trigger-analysis", emoji: "⚡", sort_order: 50,
      title: "Trigger analysis",
      description: "Surfaces the triggers your logs flag most often and how strongly each one correlates with a flare.",
      data_scope: ["symptoms_30d"],
      prompt_template:
        "You are summarising the user's logged triggers from their symptom entries over the past 30 days. " +
        "List the top triggers by frequency, and for each give: " +
        "(1) how often it shows up, (2) the average severity of symptoms logged alongside it, " +
        "(3) a one-line plain-English interpretation (correlation, not causation). " +
        "If the data is thin, say so honestly. " +
        "Render as markdown.\n\n" +
        "DATA:\n{context}",
    },
  ];
  for (const d of defaults) {
    try {
      await env.DB.prepare(
        "INSERT INTO insight_configs (slug, title, emoji, description, prompt_template, " +
        "  data_scope_json, refresh_hours, model, sort_order, enabled, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) " +
        "ON CONFLICT(slug) DO NOTHING"
      ).bind(
        d.slug, d.title, d.emoji, d.description, d.prompt_template,
        JSON.stringify(d.data_scope), d.refresh_hours || 24, d.model || null,
        d.sort_order, now, now,
      ).run();
    } catch {}
  }
}

// =============================================================================
// AI INVOCATION — Anthropic on AWS Bedrock (preferred), with the Anthropic
// direct API as a fallback. Returns { ok, text, usage }.
// =============================================================================
const DEFAULT_BEDROCK_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-sonnet-20241022";

// Invoke Claude with either a single prompt OR a full conversation.
//   opts.model    — model id override
//   opts.system   — top-level system prompt (the right place for guardrails
//                   + grounding data — Claude weights it far higher than
//                   content concatenated into a user turn)
//   opts.messages — full [{role, content}, ...] array. Overrides `prompt`.
//   opts.maxTokens — response cap (default 1500)
async function invokeClaude(env, prompt, modelOrOpts, maybeSystem) {
  const opts = (modelOrOpts && typeof modelOrOpts === "object")
    ? modelOrOpts
    : { model: modelOrOpts, system: maybeSystem };
  const model = opts.model || null;
  const system = opts.system || null;
  const messages = opts.messages || (prompt != null ? [{ role: "user", content: String(prompt) }] : []);
  const maxTokens = opts.maxTokens || 1500;
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_BEDROCK_REGION) {
    return invokeBedrock(env, { messages, system, maxTokens }, model || env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL);
  }
  if (env.ANTHROPIC_API_KEY) {
    return invokeAnthropicDirect(env, { messages, system, maxTokens }, model || env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL);
  }
  return {
    ok: false,
    error: "The insights engine isn't connected yet. " +
           "Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_BEDROCK_REGION " +
           "(or ANTHROPIC_API_KEY) via `wrangler secret put`.",
  };
}

// Admin diagnostic — call the engine with a tiny prompt and surface the
// whole result (text, tokens, model id, backend) plus the env credentials
// it found, so we can tell at a glance what's connected and what's not.
async function testInsightEngine(env) {
  const hasBedrock = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_BEDROCK_REGION);
  const hasAnthropic = !!env.ANTHROPIC_API_KEY;
  const backend = hasBedrock ? "bedrock" : hasAnthropic ? "anthropic" : null;
  const modelAttempted = hasBedrock
    ? (env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL)
    : (env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL);

  const started = Date.now();
  const res = await invokeClaude(env, "Reply with exactly: pong");
  const elapsedMs = Date.now() - started;

  return json({
    ok: !!res.ok,
    backend,
    modelAttempted,
    region: env.AWS_BEDROCK_REGION || null,
    elapsedMs,
    text: res.text || null,
    error: res.error || null,
    inputTokens: res.inputTokens || null,
    outputTokens: res.outputTokens || null,
    creds: {
      AWS_ACCESS_KEY_ID: hasBedrock ? `${(env.AWS_ACCESS_KEY_ID || "").slice(0,4)}…${(env.AWS_ACCESS_KEY_ID || "").slice(-4)}` : null,
      AWS_BEDROCK_REGION: env.AWS_BEDROCK_REGION || null,
      AWS_SECRET_ACCESS_KEY: hasBedrock ? "present" : null,
      BEDROCK_MODEL_ID: env.BEDROCK_MODEL_ID || null,
      ANTHROPIC_API_KEY: hasAnthropic ? "present" : null,
    },
  });
}

// Admin diagnostic — calls the Bedrock control-plane ListInferenceProfiles
// API and returns every profile id available to this account in the
// configured region. This is the easiest way to find the EXACT model id
// string to put in BEDROCK_MODEL_ID (the console column "Inference profile
// ID" mirrors this list). Needs `bedrock:ListInferenceProfiles` IAM.
async function listBedrockInferenceProfiles(env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_BEDROCK_REGION) {
    return json({ ok: false, error: "Bedrock credentials not set." });
  }
  const region = env.AWS_BEDROCK_REGION;
  // ListInferenceProfiles lives on the bedrock CONTROL plane host, not
  // bedrock-runtime. Path is /inference-profiles, method GET, empty body.
  const host = `bedrock.${region}.amazonaws.com`;
  const path = "/inference-profiles";
  try {
    const headers = await sigv4Sign({
      method: "GET", host, path,
      service: "bedrock", region,
      accessKey: env.AWS_ACCESS_KEY_ID,
      secretKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN || null,
      payload: "", contentType: "application/json",
    });
    const res = await fetch(`https://${host}${path}`, { method: "GET", headers });
    const body = await res.text();
    if (!res.ok) {
      return json({ ok: false, status: res.status, error: body.slice(0, 600) });
    }
    const data = JSON.parse(body);
    const profiles = (data.inferenceProfileSummaries || []).map((p) => ({
      id: p.inferenceProfileId,
      name: p.inferenceProfileName,
      arn: p.inferenceProfileArn,
      status: p.status,
      type: p.type,
      models: (p.models || []).map((m) => m.modelArn),
    }));
    return json({ ok: true, region, count: profiles.length, profiles });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) });
  }
}

// Admin diagnostic — last N insight runs across all users so admins can
// see real-time engine health from /acp.
async function listRecentInsightRuns(env) {
  await ensureInsightSchema(env);
  const r = await env.DB.prepare(
    "SELECT r.id, r.user_id, r.slug, r.status, r.error, r.input_tokens, r.output_tokens, " +
    "       r.generated_at, u.username, u.display_name " +
    "FROM insight_runs r LEFT JOIN users u ON u.id = r.user_id " +
    "ORDER BY r.generated_at DESC LIMIT 50"
  ).all().catch(() => ({ results: [] }));
  return json({
    ok: true,
    runs: (r.results || []).map((x) => ({
      id: x.id, userId: x.user_id, username: x.username || null,
      displayName: x.display_name || null, slug: x.slug,
      status: x.status, error: x.error || null,
      inputTokens: x.input_tokens || null, outputTokens: x.output_tokens || null,
      generatedAt: x.generated_at,
    })),
  });
}

// Aggregate "how is the whole app doing" snapshot for /acp Overview.
// Cheap to compute — small COUNT(*) queries against existing tables — so
// the dashboard can fetch this on every page view without paginating or
// caching. Returns:
//   counts: totals + windowed (24h, 7d, 30d) for users, posts, symptoms,
//           daily logs, insight runs
//   ai:     run status breakdown for the last 24h + 7d + 30d, token totals
//   recentUsers:  last 10 sign-ups
//   recentErrors: last 10 insight runs with status='error'
//   aiCallsDaily: 14-day series — { date, ok, error } per day
async function getAdminDashboard(env) {
  await bootstrapSchema(env);
  const now = nowSec();
  const d1 = now - 86400;     // 24h
  const d7 = now - 7 * 86400;
  const d30 = now - 30 * 86400;

  const safe = async (q, ...binds) => {
    try { return (await env.DB.prepare(q).bind(...binds).first()) || {}; }
    catch (err) { return { _err: err?.message || String(err) }; }
  };
  const safeAll = async (q, ...binds) => {
    try { return (await env.DB.prepare(q).bind(...binds).all()).results || []; }
    catch (err) { return []; }
  };

  // --- Headline counts -------------------------------------------------
  const [
    uTotal, uNew24, uNew7d, uNew30d,
    sCount7d, dCount7d, pCount7d,
    rTotal30d, rOk30d, rErr30d, rOk24h, rErr24h, rOk7d, rErr7d,
    tokens30d,
  ] = await Promise.all([
    safe("SELECT COUNT(*) AS n FROM users"),
    safe("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", d1),
    safe("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", d7),
    safe("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", d30),
    safe("SELECT COUNT(*) AS n FROM symptoms WHERE logged_at >= ?", d7),
    safe("SELECT COUNT(*) AS n FROM daily_logs WHERE log_date >= ?",
         new Date(d7 * 1000).toISOString().slice(0, 10)),
    safe("SELECT COUNT(*) AS n FROM posts WHERE created_at >= ?", d7),
    safe("SELECT COUNT(*) AS n FROM insight_runs WHERE generated_at >= ?", d30),
    safe("SELECT COUNT(*) AS n FROM insight_runs WHERE status = 'ok'    AND generated_at >= ?", d30),
    safe("SELECT COUNT(*) AS n FROM insight_runs WHERE status = 'error' AND generated_at >= ?", d30),
    safe("SELECT COUNT(*) AS n FROM insight_runs WHERE status = 'ok'    AND generated_at >= ?", d1),
    safe("SELECT COUNT(*) AS n FROM insight_runs WHERE status = 'error' AND generated_at >= ?", d1),
    safe("SELECT COUNT(*) AS n FROM insight_runs WHERE status = 'ok'    AND generated_at >= ?", d7),
    safe("SELECT COUNT(*) AS n FROM insight_runs WHERE status = 'error' AND generated_at >= ?", d7),
    safe("SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM insight_runs WHERE generated_at >= ?", d30),
  ]);

  // --- Recent activity feeds ------------------------------------------
  const [recentUsers, recentErrors] = await Promise.all([
    safeAll(
      "SELECT id, username, display_name, email, created_at " +
      "FROM users ORDER BY created_at DESC LIMIT 10"
    ),
    safeAll(
      "SELECT r.id, r.slug, r.error, r.generated_at, r.user_id, u.username, u.display_name " +
      "FROM insight_runs r LEFT JOIN users u ON u.id = r.user_id " +
      "WHERE r.status = 'error' ORDER BY r.generated_at DESC LIMIT 10"
    ),
  ]);

  // --- 14-day AI call series ------------------------------------------
  const since14d = now - 14 * 86400;
  const series = await safeAll(
    "SELECT " +
    "  CAST((generated_at - ?) / 86400 AS INTEGER) AS bucket, " +
    "  SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok, " +
    "  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS err " +
    "FROM insight_runs WHERE generated_at >= ? GROUP BY bucket",
    since14d, since14d,
  );
  const seriesByBucket = new Map(series.map((r) => [r.bucket, r]));
  const aiCallsDaily = [];
  for (let i = 0; i < 14; i++) {
    const r = seriesByBucket.get(i) || { ok: 0, err: 0 };
    const date = new Date((since14d + i * 86400) * 1000).toISOString().slice(0, 10);
    aiCallsDaily.push({ date, ok: r.ok || 0, error: r.err || 0 });
  }

  return json({
    generatedAt: now,
    counts: {
      users:        { total: uTotal.n || 0, new24h: uNew24.n || 0, new7d: uNew7d.n || 0, new30d: uNew30d.n || 0 },
      symptoms7d:   sCount7d.n || 0,
      dailyLogs7d:  dCount7d.n || 0,
      posts7d:      pCount7d.n || 0,
    },
    ai: {
      runs:    { total30d: rTotal30d.n || 0, ok30d: rOk30d.n || 0, err30d: rErr30d.n || 0,
                 ok24h:    rOk24h.n || 0,    err24h: rErr24h.n || 0,
                 ok7d:     rOk7d.n || 0,     err7d: rErr7d.n || 0 },
      tokens:  { input30d: tokens30d.i || 0, output30d: tokens30d.o || 0 },
    },
    recentUsers: recentUsers.map((u) => ({
      id: u.id, username: u.username, displayName: u.display_name,
      email: u.email, createdAt: u.created_at,
    })),
    recentErrors: recentErrors.map((r) => ({
      id: r.id, slug: r.slug, userId: r.user_id,
      username: r.username, displayName: r.display_name,
      error: r.error, generatedAt: r.generated_at,
    })),
    aiCallsDaily,
  });
}

async function invokeAnthropicDirect(env, payload, model) {
  // Accept either the legacy string-prompt shape OR the new
  // { messages, system, maxTokens } object so existing callers keep working.
  const { messages, system, maxTokens } =
    (payload && typeof payload === "object" && !Array.isArray(payload) && "messages" in payload)
      ? payload
      : { messages: [{ role: "user", content: String(payload || "") }], system: null, maxTokens: 1500 };
  try {
    const reqBody = { model, max_tokens: maxTokens || 1500, messages };
    if (system) reqBody.system = system;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(reqBody),
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `Anthropic ${res.status}: ${t.slice(0, 400)}` };
    }
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return {
      ok: true,
      text,
      inputTokens: data.usage?.input_tokens || null,
      outputTokens: data.usage?.output_tokens || null,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// AWS Bedrock InvokeModel endpoint, signed with SigV4. The Bedrock body for
// an Anthropic model is the standard messages-shaped JSON with an extra
// "anthropic_version" field instead of the HTTP header.
async function invokeBedrock(env, payload, model) {
  const region = env.AWS_BEDROCK_REGION;
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(model)}/invoke`;
  // Accept either a legacy string prompt or { messages, system, maxTokens }.
  const { messages, system, maxTokens } =
    (payload && typeof payload === "object" && !Array.isArray(payload) && "messages" in payload)
      ? payload
      : { messages: [{ role: "user", content: String(payload || "") }], system: null, maxTokens: 1500 };
  const bodyObj = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens || 1500,
    messages,
  };
  if (system) bodyObj.system = system;
  const body = JSON.stringify(bodyObj);

  try {
    const headers = await sigv4Sign({
      method: "POST",
      host,
      path,
      service: "bedrock",
      region,
      accessKey: env.AWS_ACCESS_KEY_ID,
      secretKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN || null,
      payload: body,
      contentType: "application/json",
    });

    const res = await fetch(`https://${host}${path}`, {
      method: "POST", headers, body,
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `Bedrock ${res.status} (model=${model}, region=${region}): ${t.slice(0, 400)}` };
    }
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return {
      ok: true,
      text,
      inputTokens: data.usage?.input_tokens || null,
      outputTokens: data.usage?.output_tokens || null,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// Minimal AWS SigV4 implementation for the Bedrock InvokeModel call. Built
// on top of the Workers Web Crypto API so we don't need the AWS SDK.
async function sigv4Sign({ method, host, path, service, region, accessKey, secretKey, sessionToken, payload, contentType }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(payload);
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    (sessionToken ? `x-amz-security-token:${sessionToken}\n` : "") +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host" + (sessionToken ? ";x-amz-security-token" : "") + ";x-amz-content-sha256;x-amz-date";

  // Canonical URI for non-S3 SigV4 must be the request path with every
  // segment URI-encoded TWICE. Our `path` is already encoded once (e.g.
  // colons in the model id are now "%3A"), so we re-encode percent signs
  // to "%25" to get the double encoding AWS expects. Without this, the
  // model id "anthropic.claude-3-5-sonnet-20241022-v2:0" produces a
  // 403 "signature does not match" because we sign "%3A" and AWS
  // re-canonicalises to "%253A".
  const canonicalUri = path.replace(/%/g, "%25");
  const canonicalRequest = [
    method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm, amzDate, credentialScope, await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate    = await hmacRaw("AWS4" + secretKey, dateStamp);
  const kRegion  = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  const kSigning = await hmacRaw(kService, "aws4_request");
  const signature = bufToHex(await hmacRaw(kSigning, stringToSign));

  const authorization = `${algorithm} Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    "content-type": contentType,
    "host": host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "authorization": authorization,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  return headers;
}

async function sha256Hex(input) {
  const enc = new TextEncoder().encode(typeof input === "string" ? input : "");
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return bufToHex(hash);
}
async function hmacRaw(key, msg) {
  const keyBuf = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const msgBuf = new TextEncoder().encode(msg);
  const k = await crypto.subtle.importKey("raw", keyBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, msgBuf);
}
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// =============================================================================
// CONTEXT BUILDERS — turn the user's raw data into a tight text block we can
// drop into the prompt. Each scope token formats one slice of their history.
// =============================================================================
async function buildInsightContext(env, user, scope) {
  const parts = [];
  for (const s of (Array.isArray(scope) ? scope : [])) {
    let chunk = null;
    try {
      if (s === "symptoms_30d")        chunk = await ctxSymptoms(env, user, 30);
      else if (s === "daily_logs_30d") chunk = await ctxDailyLogs(env, user, 30);
      else if (s === "medications")    chunk = await ctxMedications(env, user);
      else if (s === "medication_logs_30d") chunk = await ctxMedLogs(env, user, 30);
      else if (s === "test_results")   chunk = await ctxTestResults(env, user);
      else if (s === "appointments_60d") chunk = await ctxAppointments(env, user, 60);
      else if (s === "food_logs_30d")  chunk = await ctxFoodLogs(env, user, 30);
      else if (s === "cravings_30d")   chunk = await ctxCravings(env, user, 30);
    } catch (err) {
      chunk = `(${s}: read failed — ${err?.message || "unknown"})`;
    }
    if (chunk) parts.push(chunk);
  }
  return parts.join("\n\n") || "(no data logged yet)";
}

async function ctxSymptoms(env, user, days) {
  const since = nowSec() - days * 86400;
  const r = await env.DB.prepare(
    "SELECT log_date, logged_at, symptom, severity, location, notes, triggers, relief, pain_type " +
    "FROM symptoms WHERE user_id = ? AND logged_at >= ? ORDER BY logged_at DESC LIMIT 400"
  ).bind(user.id, since).all().catch(() => ({ results: [] }));
  if (!(r.results || []).length) return `### Symptoms (last ${days} days)\nNothing logged.`;
  const lines = (r.results || []).map((s) =>
    `- ${s.log_date}: ${s.symptom} sev=${s.severity}${s.location ? ` loc=${s.location}` : ""}` +
    `${s.triggers ? ` triggers=${s.triggers}` : ""}${s.relief ? ` helped=${s.relief}` : ""}` +
    `${s.pain_type ? ` painType=${s.pain_type}` : ""}${s.notes ? ` note="${String(s.notes).slice(0,120)}"` : ""}`
  ).join("\n");
  return `### Symptoms (last ${days} days, ${r.results.length} entries)\n${lines}`;
}

async function ctxDailyLogs(env, user, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    "SELECT * FROM daily_logs WHERE user_id = ? AND log_date >= ? ORDER BY log_date DESC LIMIT 60"
  ).bind(user.id, since).all().catch(() => ({ results: [] }));
  if (!(r.results || []).length) return `### Daily check-ins (last ${days} days)\nNothing logged.`;
  const lines = (r.results || []).map((d) => {
    const bits = [
      d.morning_logged_at ? `morning mood=${d.morning_mood}/energy=${d.morning_energy}/pain=${d.morning_pain}/sleep=${d.morning_sleep_hours || "?"}h${d.morning_symptoms ? "/sym=" + d.morning_symptoms : ""}` : null,
      d.afternoon_logged_at ? `midday mood=${d.afternoon_mood}/energy=${d.afternoon_energy}/pain=${d.afternoon_pain}${d.afternoon_symptoms ? "/sym=" + d.afternoon_symptoms : ""}` : null,
      d.evening_logged_at ? `evening overall=${d.evening_overall}/stress=${d.stress_level || "?"}/water=${d.water_glasses || 0}/move=${d.movement_level || "?"}/sym=${d.evening_symptoms || "-"}${d.evening_relief ? "/helped=" + d.evening_relief : ""}` : null,
      d.cycle_day != null ? `cycleDay=${d.cycle_day}` : null,
      d.cycle_phase ? `phase=${d.cycle_phase}` : null,
      d.flow ? `flow=${d.flow}` : null,
    ].filter(Boolean);
    return `- ${d.log_date}: ${bits.join(" | ")}`;
  }).join("\n");
  return `### Daily check-ins (last ${days} days, ${r.results.length} days)\n${lines}`;
}

async function ctxMedications(env, user) {
  const r = await env.DB.prepare(
    "SELECT name, kind, dose, frequency, notes FROM medications WHERE user_id = ? AND is_active = 1"
  ).bind(user.id).all().catch(() => ({ results: [] }));
  if (!(r.results || []).length) return "### Current medications + supplements\nNone tracked.";
  const lines = (r.results || []).map((m) =>
    `- ${m.name} (${m.kind || "med"})${m.dose ? " " + m.dose : ""}${m.frequency ? " · " + m.frequency : ""}${m.notes ? ` · note="${String(m.notes).slice(0,100)}"` : ""}`
  ).join("\n");
  return `### Current medications + supplements (${r.results.length})\n${lines}`;
}

async function ctxMedLogs(env, user, days) {
  const since = nowSec() - days * 86400;
  const r = await env.DB.prepare(
    "SELECT m.name, l.taken_at FROM medication_logs l JOIN medications m ON m.id = l.medication_id " +
    "WHERE l.user_id = ? AND l.taken_at >= ? ORDER BY l.taken_at DESC LIMIT 200"
  ).bind(user.id, since).all().catch(() => ({ results: [] }));
  if (!(r.results || []).length) return `### Dose logs (last ${days} days)\nNothing logged.`;
  // Aggregate count per medication so the prompt sees adherence at a glance.
  const counts = new Map();
  for (const x of r.results) counts.set(x.name, (counts.get(x.name) || 0) + 1);
  const lines = [...counts.entries()].sort((a,b) => b[1] - a[1]).map(([n,c]) => `- ${n}: ${c} doses`).join("\n");
  return `### Dose adherence (last ${days} days)\n${lines}`;
}

// Food logs aren't just calories — for endo the value is spotting which
// foods cluster on flare days. We dump every meal entry chronologically
// (date + meal + name + macros) so Claude can pair them with symptom dates.
async function ctxFoodLogs(env, user, days) {
  await ensureFoodSchema(env);
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    "SELECT log_date, meal, name, calories, protein_g, carbs_g, fat_g, fiber_g, servings " +
    "FROM food_logs WHERE user_id = ? AND log_date >= ? " +
    "ORDER BY log_date DESC, logged_at ASC LIMIT 200"
  ).bind(user.id, since).all().catch(() => ({ results: [] }));
  if (!(r.results || []).length) return `### Food logs (last ${days} days)\nNothing logged.`;

  // Group by date for a compact, scannable layout.
  const byDate = new Map();
  let totalCal = 0;
  for (const f of r.results) {
    if (!byDate.has(f.log_date)) byDate.set(f.log_date, []);
    const mult = +f.servings || 1;
    const kcal = Math.round((f.calories || 0) * mult);
    totalCal += kcal;
    const macros = [
      f.protein_g != null ? `P${Math.round(f.protein_g * mult)}g` : null,
      f.carbs_g   != null ? `C${Math.round(f.carbs_g   * mult)}g` : null,
      f.fat_g     != null ? `F${Math.round(f.fat_g     * mult)}g` : null,
      f.fiber_g   != null ? `Fib${Math.round(f.fiber_g * mult)}g` : null,
    ].filter(Boolean).join(" ");
    byDate.get(f.log_date).push(
      `${f.meal}: ${f.name}${mult !== 1 ? ` ×${mult}` : ""}` +
      (kcal ? ` (${kcal}kcal${macros ? " " + macros : ""})` : "")
    );
  }
  const days7avg = Math.round(totalCal / Math.max(1, byDate.size));
  const lines = [...byDate.entries()].map(([date, entries]) =>
    `- ${date}:\n  ${entries.join("\n  ")}`
  ).join("\n");
  // Also pull the user's daily calorie target so prompts can frame % of target.
  const prefs = await env.DB.prepare(
    "SELECT daily_calorie_target FROM user_food_prefs WHERE user_id = ?"
  ).bind(user.id).first().catch(() => null);
  const target = prefs?.daily_calorie_target || 2000;
  return `### Food logs (last ${days} days, ${r.results.length} entries across ${byDate.size} days)\n` +
         `Daily average ~${days7avg}kcal (target ${target}kcal).\n${lines}`;
}

async function ctxCravings(env, user, days) {
  await ensureFoodSchema(env);
  const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    "SELECT log_date, craving, intensity, satisfied, notes FROM cravings " +
    "WHERE user_id = ? AND log_date >= ? ORDER BY logged_at DESC LIMIT 100"
  ).bind(user.id, sinceDate).all().catch(() => ({ results: [] }));
  if (!(r.results || []).length) return `### Cravings (last ${days} days)\nNothing logged.`;
  const lines = (r.results || []).map((c) =>
    `- ${c.log_date}: ${c.craving} (intensity ${c.intensity}/5)` +
    (c.satisfied != null ? ` · ${c.satisfied ? "gave in" : "didn't"}` : "") +
    (c.notes ? ` · "${String(c.notes).slice(0, 80)}"` : "")
  ).join("\n");
  return `### Cravings (last ${days} days, ${r.results.length} entries)\n` +
         `Worth pairing with cycle phase: cravings cluster in the luteal phase due to higher progesterone + slightly higher energy needs.\n${lines}`;
}

async function ctxTestResults(env, user) {
  await ensureTestResultsSchema(env);
  const r = await env.DB.prepare(
    "SELECT kind, title, summary, assessed_at FROM test_results WHERE user_id = ? ORDER BY assessed_at DESC LIMIT 10"
  ).bind(user.id).all().catch(() => ({ results: [] }));
  if (!(r.results || []).length) return "### Test results on file\nNone yet.";
  const lines = (r.results || []).map((t) => {
    const date = new Date(t.assessed_at * 1000).toISOString().slice(0, 10);
    return `- ${date} ${t.kind.toUpperCase()} — ${t.title}: ${t.summary || ""}`;
  }).join("\n");
  return `### Test results on file\n${lines}`;
}

async function ctxAppointments(env, user, days) {
  await ensureAppointmentSchema(env);
  const since = nowSec() - 7 * 86400;
  const until = nowSec() + days * 86400;
  const r = await env.DB.prepare(
    "SELECT title, kind, doctor, starts_at FROM appointments " +
    "WHERE user_id = ? AND starts_at BETWEEN ? AND ? ORDER BY starts_at ASC LIMIT 30"
  ).bind(user.id, since, until).all().catch(() => ({ results: [] }));
  if (!(r.results || []).length) return `### Appointments (past week + next ${days} days)\nNone.`;
  const lines = (r.results || []).map((a) => {
    const date = new Date(a.starts_at * 1000).toISOString().slice(0, 10);
    return `- ${date} ${a.kind || "general"} — ${a.title}${a.doctor ? " (" + a.doctor + ")" : ""}`;
  }).join("\n");
  return `### Appointments (past week + next ${days} days)\n${lines}`;
}

// =============================================================================
// INSIGHT ENDPOINTS
// =============================================================================
async function listInsights(env, user) {
  await ensureInsightSchema(env);
  // 'buddy-system' is the Buddy chatbot's system prompt — it lives in
  // insight_configs so admins can edit it from /acp but should never show
  // up on /my-insights as a card the user could try to "run".
  const cfgs = await env.DB.prepare(
    "SELECT slug, title, emoji, description, refresh_hours, sort_order, updated_at " +
    "FROM insight_configs WHERE enabled = 1 AND slug != 'buddy-system' " +
    "ORDER BY sort_order ASC, slug ASC"
  ).all().catch(() => ({ results: [] }));
  const slugs = (cfgs.results || []).map((c) => c.slug);
  let runs = { results: [] };
  if (slugs.length) {
    const ph = slugs.map(() => "?").join(",");
    try {
      runs = await env.DB.prepare(
        `SELECT r.* FROM insight_runs r
         JOIN (
           SELECT slug, MAX(generated_at) AS g FROM insight_runs
           WHERE user_id = ? AND slug IN (${ph}) GROUP BY slug
         ) latest ON r.slug = latest.slug AND r.generated_at = latest.g
         WHERE r.user_id = ?`
      ).bind(user.id, ...slugs, user.id).all();
    } catch {}
  }
  const runMap = new Map();
  for (const r of (runs.results || [])) runMap.set(r.slug, r);

  const aiConfigured = !!(env.AWS_ACCESS_KEY_ID || env.ANTHROPIC_API_KEY);

  // The "endo-pattern-watch" card only makes sense for users on the
  // early-diagnosis watching path. Hide it for everyone else.
  let showEndoWatch = false;
  try {
    const u = await env.DB.prepare(
      "SELECT endo_status, wants_early_dx_support FROM users WHERE id = ?"
    ).bind(user.id).first();
    showEndoWatch = !!(u && u.endo_status === "unknown" && u.wants_early_dx_support === 1);
  } catch {}

  return json({
    aiConfigured,
    aiBackend: env.AWS_ACCESS_KEY_ID && env.AWS_BEDROCK_REGION ? "bedrock"
             : env.ANTHROPIC_API_KEY ? "anthropic" : null,
    insights: (cfgs.results || [])
      .filter((c) => c.slug !== "endo-pattern-watch" || showEndoWatch)
      .map((c) => {
        const run = runMap.get(c.slug);
        return {
          slug: c.slug, title: c.title, emoji: c.emoji || "✨",
          description: c.description, refreshHours: c.refresh_hours,
          latest: run ? {
            status: run.status, outputMd: run.output_md || null,
            error: run.error || null, generatedAt: run.generated_at,
            inputTokens: run.input_tokens, outputTokens: run.output_tokens,
          } : null,
        };
      }),
  });
}

async function runInsight(env, user, slug, ctx) {
  await ensureInsightSchema(env);
  const cfg = await env.DB.prepare(
    "SELECT * FROM insight_configs WHERE slug = ? AND enabled = 1"
  ).bind(slug).first().catch(() => null);
  if (!cfg) return json({ error: "Insight not found" }, 404);

  const scope = (() => { try { return JSON.parse(cfg.data_scope_json); } catch { return []; } })();
  const context = await buildInsightContext(env, user, scope);
  const prompt = String(cfg.prompt_template || "").replace(/\{context\}/g, context);

  // Insert a "running" row immediately so the UI can show progress; we replace
  // it with the final row after the AI call completes.
  const now = nowSec();
  let runId = null;
  try {
    const r = await env.DB.prepare(
      "INSERT INTO insight_runs (user_id, slug, output_md, status, generated_at) " +
      "VALUES (?, ?, NULL, 'running', ?)"
    ).bind(user.id, slug, now).run();
    runId = r.meta?.last_row_id;
  } catch {}

  const job = (async () => {
    const res = await invokeClaude(env, prompt, cfg.model);
    try {
      await env.DB.prepare(
        "UPDATE insight_runs SET output_md = ?, status = ?, error = ?, input_tokens = ?, output_tokens = ?, generated_at = ? WHERE id = ?"
      ).bind(
        res.text || null,
        res.ok ? "ok" : "error",
        res.error || null,
        res.inputTokens || null,
        res.outputTokens || null,
        nowSec(),
        runId
      ).run();
    } catch {}
  })();
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return json({ ok: true, runId });
}

async function listInsightConfigs(env) {
  await ensureInsightSchema(env);
  const rows = await env.DB.prepare(
    "SELECT * FROM insight_configs ORDER BY sort_order ASC, slug ASC"
  ).all().catch(() => ({ results: [] }));
  return json({
    configs: (rows.results || []).map((c) => ({
      slug: c.slug, title: c.title, emoji: c.emoji, description: c.description,
      promptTemplate: c.prompt_template,
      dataScope: (() => { try { return JSON.parse(c.data_scope_json); } catch { return []; } })(),
      refreshHours: c.refresh_hours, model: c.model, sortOrder: c.sort_order,
      enabled: !!c.enabled, updatedAt: c.updated_at,
    })),
  });
}

// =============================================================================
// SCHEDULED / CRON — monthly "This month in review" generation
//
// Walks every user that has logged *something* in the last month and runs the
// monthly-summary insight for them. We rate-limit by sleeping briefly between
// invocations so we never burst against Bedrock; cron isolates have a generous
// CPU + wall-time budget and this routinely finishes well under it.
//
// Anything that fails for a single user is swallowed so one bad row doesn't
// poison the rest of the batch.
// =============================================================================
// 15-minute cron — for every user with `auto_mark_taken = 1`, walk their
// recurring schedules and insert a `status='auto_taken'` log row for any
// slot whose scheduled time has passed in the last hour and that doesn't
// already have a log. Bounded lookback so a long outage doesn't backfill
// the entire week.
async function autoMarkScheduledDoses(env, ctx) {
  if (!env.DB) return;
  try { await ensureMedSchema(env); } catch {}
  const now = nowSec();
  const lookbackSec = 60 * 60; // 1 hour
  const since = now - lookbackSec;

  // Today's bit (Sun=1 ... Sat=64).
  const today = new Date(now * 1000);
  const dayBit = 1 << today.getDay();
  const todayStart = Math.floor(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() / 1000);

  const candidates = await env.DB.prepare(
    "SELECT s.user_id, s.medication_id, s.time_of_day, m.name " +
    "FROM medication_schedules s " +
    "JOIN medications m ON m.id = s.medication_id AND m.is_active = 1 " +
    "JOIN user_med_prefs p ON p.user_id = s.user_id " +
    "WHERE (s.days_mask & ?) != 0 AND p.auto_mark_taken = 1"
  ).bind(dayBit).all().catch(() => ({ results: [] }));

  let inserted = 0;
  for (const c of (candidates.results || [])) {
    const [h, m] = String(c.time_of_day).split(":").map((n) => parseInt(n, 10));
    const slotAt = todayStart + (h || 0) * 3600 + (m || 0) * 60;
    // Only act on slots inside our look-back window (past hour, not future).
    if (slotAt > now || slotAt < since) continue;

    // Already logged? Skip.
    const existing = await env.DB.prepare(
      "SELECT 1 FROM medication_logs WHERE medication_id = ? AND scheduled_for = ? LIMIT 1"
    ).bind(c.medication_id, slotAt).first().catch(() => null);
    if (existing) continue;

    try {
      await env.DB.prepare(
        "INSERT INTO medication_logs (user_id, medication_id, taken_at, status, scheduled_for) " +
        "VALUES (?, ?, ?, 'auto_taken', ?)"
      ).bind(c.user_id, c.medication_id, now, slotAt).run();
      inserted++;
    } catch {}
  }
  if (inserted) console.log(`[auto-mark doses] inserted ${inserted} auto_taken rows`);
}

async function runMonthlyInsightsForAllUsers(env, ctx, event) {
  if (!env.DB) return;
  await ensureInsightSchema(env);

  // Skip silently if the engine isn't connected — no point burning cycles
  // writing "error" rows everyone will see next month.
  const engineReady = !!(
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_BEDROCK_REGION) ||
    env.ANTHROPIC_API_KEY
  );
  if (!engineReady) {
    console.warn("[monthly insights] skipped — engine credentials not set");
    return;
  }

  const cfg = await env.DB.prepare(
    "SELECT 1 FROM insight_configs WHERE slug = 'monthly-summary' AND enabled = 1"
  ).first().catch(() => null);
  if (!cfg) return;

  // Eligible = anyone with a symptom OR a daily log in the last ~35 days.
  // Anyone who's never logged would just get an empty write-up.
  const since = nowSec() - 35 * 86400;
  const sinceDate = new Date(since * 1000).toISOString().slice(0, 10);
  const rows = await env.DB.prepare(
    "SELECT DISTINCT u.id, u.username, u.email, u.timezone FROM users u " +
    "WHERE EXISTS (SELECT 1 FROM symptoms s WHERE s.user_id = u.id AND s.logged_at >= ?) " +
    "   OR EXISTS (SELECT 1 FROM daily_logs d WHERE d.user_id = u.id AND d.log_date >= ?)"
  ).bind(since, sinceDate).all().catch(() => ({ results: [] }));

  const users = rows.results || [];
  console.log(`[monthly insights] generating for ${users.length} active user(s)`);

  let ok = 0, fail = 0;
  for (const u of users) {
    try {
      // Pass a synthetic ctx with no waitUntil so runInsight awaits the call
      // inline — we want each user's row written before we move to the next.
      await runInsight(env, { id: u.id }, "monthly-summary", null);
      ok++;
    } catch (err) {
      fail++;
      console.warn(`[monthly insights] user=${u.id} failed: ${err?.message || err}`);
    }
    // Light back-off so we never hammer Bedrock — cron has minutes of CPU.
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`[monthly insights] done — ok=${ok} fail=${fail}`);
}

async function updateInsightConfig(request, env, slug) {
  await ensureInsightSchema(env);
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid body" }, 400);
  const sets = []; const binds = [];
  if ("title" in body)        { sets.push("title = ?");        binds.push(String(body.title).slice(0,140)); }
  if ("emoji" in body)        { sets.push("emoji = ?");        binds.push(String(body.emoji || "").slice(0,8)); }
  if ("description" in body)  { sets.push("description = ?");  binds.push(sanitizeText(body.description, 400)); }
  if ("promptTemplate" in body){ sets.push("prompt_template = ?"); binds.push(String(body.promptTemplate).slice(0,8000)); }
  if ("dataScope" in body)    { sets.push("data_scope_json = ?"); binds.push(JSON.stringify(body.dataScope || [])); }
  if ("refreshHours" in body) { sets.push("refresh_hours = ?"); binds.push(Math.max(1, Math.min(720, +body.refreshHours || 24))); }
  if ("model" in body)        { sets.push("model = ?");        binds.push(body.model ? String(body.model).slice(0,200) : null); }
  if ("sortOrder" in body)    { sets.push("sort_order = ?");   binds.push(+body.sortOrder || 100); }
  if ("enabled" in body)      { sets.push("enabled = ?");      binds.push(body.enabled ? 1 : 0); }
  if (!sets.length) return json({ error: "Nothing to update" }, 400);
  sets.push("updated_at = ?"); binds.push(nowSec(), slug);
  await env.DB.prepare(
    `UPDATE insight_configs SET ${sets.join(", ")} WHERE slug = ?`
  ).bind(...binds).run();
  return json({ ok: true });
}
