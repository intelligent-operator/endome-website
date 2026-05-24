# EndoMe website

Marketing site for EndoMe — an endometriosis support community powered by DNA
testing, symptom tracking, and AI-driven support plans.

Stack:

| Concern         | Service                                                |
| --------------- | ------------------------------------------------------ |
| Hosting         | Cloudflare Workers + Static Assets (single deploy)     |
| DNS + SSL       | Cloudflare (free, auto-renew)                          |
| Inbound email   | Cloudflare Email Routing → M365 inbox                  |
| Outbound email  | Mandrill (Mailchimp Transactional)                     |
| Payments        | Stripe Checkout (hosted)                               |
| Source / CI     | GitHub → Cloudflare auto-deploys on push to `main`     |
| Config          | `wrangler.toml` (repo) + secrets (Cloudflare dashboard)|
| Local dev       | `wrangler` CLI                                         |

## Repo layout

```
├── public/             # Static assets served by Workers Assets
│   ├── index.html
│   ├── styles.css
│   └── app.js          # Wires form + CTAs to /api/*
├── src/
│   └── worker.js       # /api/subscribe, /api/checkout, /api/stripe-webhook, /api/contact
├── wrangler.toml       # Cloudflare config (non-secret)
├── .dev.vars.example   # Template for local secrets
└── package.json
```

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in test keys
npm run dev                       # http://localhost:8787
```

`wrangler dev` serves the `public/` directory and runs the Worker for any
request that doesn't match a static asset (e.g. `/api/subscribe`).

## Deploy

The repo is wired to Cloudflare's GitHub integration: every push to `main`
triggers a production deploy, and PR branches deploy to a preview URL.

You can also deploy manually:

```sh
npm run deploy            # production
npm run deploy:preview    # preview env
```

## One-time Cloudflare setup

1. **Create the Worker**
   - Cloudflare Dashboard → Workers & Pages → *Create* → *Connect to Git* → pick
     this repo. Cloudflare detects `wrangler.toml` and configures the build.
2. **Add the custom domain**
   - Add `endome.app` (or whichever zone) to Cloudflare → update registrar
     nameservers. SSL provisions automatically.
   - In the Worker → *Settings* → *Domains & Routes* → *Add Custom Domain*
     → `endome.app`. Uncomment the `[[routes]]` block in `wrangler.toml`
     to manage this from code instead.
3. **Email Routing (inbound)**
   - Cloudflare Dashboard → *Email* → *Email Routing* → enable for the zone.
   - Add destination address: your M365 inbox (e.g. `team@endome.onmicrosoft.com`),
     verify the confirmation email.
   - Create routing rules:
     - `hello@endome.app` → M365 inbox
     - `support@endome.app` → M365 inbox
     - Catch-all → M365 inbox (or drop)
4. **Mandrill (outbound)**
   - Mailchimp → Transactional → *Sending Domains* → add `endome.app`.
   - Add the SPF/DKIM TXT records it gives you to Cloudflare DNS.
   - Generate an API key.
5. **Stripe**
   - Create a *Product* (e.g. "EndoMe DNA Test Kit") with a one-time price.
     Copy the `price_…` ID into `STRIPE_DNA_PRICE_ID` in `wrangler.toml`.
   - Webhooks → *Add endpoint* → `https://endome.app/api/stripe-webhook`,
     subscribe to `checkout.session.completed`. Copy the signing secret.

## Storage (D1) — one-time setup

EndoMe uses **Cloudflare D1** (managed serverless SQLite at the edge) for all
user health data. D1 is the right fit because we need relational queries
(JOINs across users, daily_logs, symptoms; aggregations for trend charts;
date-range filters; future tables for medications, appointments, labs).

### Browser route (recommended)

1. Cloudflare dashboard → **Storage & Databases** → **D1** → **Create database**.
2. Name it `endome-db` → **Create**.
3. Copy the **Database ID** shown on the database page.
4. Open `wrangler.toml`, replace `REPLACE_WITH_YOUR_DATABASE_ID` under
   `[[d1_databases]]` with that id. Commit + push.
5. Apply the schema:
   - Open `migrations/0001_init.sql` on GitHub → **Raw** → copy everything.
   - In the dashboard go to the new database → **Console** tab → paste → **Execute**.
   - You should see "Success" and no errors.

That's it — Cloudflare's next auto-deploy creates the `DB` binding and the
worker starts writing real data.

### CLI route

```sh
wrangler d1 create endome-db
# copy the returned database_id into wrangler.toml under [[d1_databases]]

git add wrangler.toml && git commit -m "wire D1 database" && git push

wrangler d1 migrations apply endome-db --remote      # production
wrangler d1 migrations apply endome-db --local       # local dev DB
```

### Schema layout

| Table | Holds |
|---|---|
| `users`         | account records (id, username, display_name, timezone) |
| `daily_logs`    | one row per (user, calendar day) — morning + evening + cycle + points |
| `symptoms`      | individual symptom events; many per day per user |
| `pets`          | EndoPet state per user (level, xp, mood, streak) |
| `notifications` | server-generated notifications for the bell dropdown |

The schema lives in `migrations/0001_init.sql`. To evolve it later, add
`0002_*.sql`, `0003_*.sql` etc. and re-run `migrations apply`.

## Secrets

Set in the Cloudflare dashboard (Worker → *Settings* → *Variables and Secrets*)
or via CLI. Never commit real values.

```sh
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put MANDRILL_API_KEY
```

Required:

| Name                    | Source                              |
| ----------------------- | ----------------------------------- |
| `STRIPE_SECRET_KEY`     | Stripe → Developers → API keys      |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → endpoint        |
| `MANDRILL_API_KEY`      | Mailchimp Transactional → SMTP & API|

Public vars (in `wrangler.toml`): `SITE_URL`, `NEWSLETTER_FROM_EMAIL`,
`NEWSLETTER_FROM_NAME`, `NOTIFY_EMAIL`, `STRIPE_DNA_PRICE_ID`.

## API endpoints

| Method | Path                  | Purpose                                       |
| ------ | --------------------- | --------------------------------------------- |
| POST   | `/api/subscribe`      | Newsletter signup → Mandrill welcome email    |
| POST   | `/api/checkout`       | Creates Stripe Checkout session, returns URL  |
| POST   | `/api/stripe-webhook` | Stripe webhook → order confirmation email     |
| POST   | `/api/contact`        | Optional contact form → forwards to inbox     |
