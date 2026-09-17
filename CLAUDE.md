# CLAUDE.md — Campus Event Management & Booking API

Context file for AI assistants (Claude Code, etc.) working on this repo.
Course: **CSX4110 Backend Application Development**, Semester 1/2026.
This is "Option 3" of four class project options. Originally in a mandatory peer-API
ring with three other student teams — **that requirement was dropped 2026-09-10** in
favor of one genuine public API integration; see §5.

⚠️ **[docs/proposal.md](docs/proposal.md)** (and `docs/proposal.docx`) is the submitted,
teacher-facing proposal — it is **authoritative** over this file wherever they conflict,
**except** the peer-API-ring design in its §"Peer API Integration", which a verbal
teacher instruction changed on 2026-09-10 — see §5 below for the amendment (this file is
working notes, so it's where a verbal change like this gets tracked; the proposal
document itself is left untouched as the historical record of what was submitted).
Group: Thar Lin Htet (6642062), Honey Linn (6726113), Mi Hsu Myat Win Wyint (6726115).

---

## 1. Project Concept

A platform where university organizations create events and students book seats.

- **Organizer flow**: logs in via university Microsoft account → creates events (venue,
  schedule, capacity), can mark one as a large conference, manages only their own events
- **Student flow**: logs in via university Microsoft account → browses published events,
  RSVPs (or joins the waitlist once full), cancels their own bookings
- **Admin**: manages users/roles, issues/revokes peer API keys, sees all events/bookings
- Venue locations are set by dropping a pin on a map (Leaflet + OpenStreetMap); Geoapify turns that pin into an address and powers place search — see §9
- An event can carry a **cover image** the organizer uploads, shown behind the date on the student's event card — see §9
- An organizer can attach a **supply order** to an event (what to order, how many — e.g.
  "200 × Blank lanyards"), which is posted to a Discord channel when the event is
  published (see §5 — originally this called a classmate team's API for a fixed 50
  lanyards; amended 2026-09-10 to a genuine public API, and made organizer-chosen
  2026-09-16)

---

## 2. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node.js + Express | Reusing the proven pattern from the weekly lab series (`backend-crud-api`) rather than the Go alternative |
| Database | Relational (MySQL/PostgreSQL) via **Prisma ORM** | Migrations required. **Pin `prisma@6` + `@prisma/client@6` explicitly** — v7 breaks the `new PrismaClient()` instantiation pattern used throughout the lab series |
| Auth | JWT + RBAC, backed by **Microsoft Entra ID (AD)** via MSAL / OAuth2 / OIDC | Self-provisioned tenant (see §4) |
| Secrets | **Azure Key Vault**, fetched at runtime | No `.env` secrets in production — `.env` only holds non-secret bootstrap config (tenant ID, client ID, vault URL) |
| External API | **Geoapify** (place search + turning a map pin into an address) | Switched from Mapbox → Geoapify for a zero-cost, no-card-required free tier. Reworked 2026-09-16 — see §9 |
| Maps | **Leaflet + OpenStreetMap tiles** | Added 2026-09-16. Free, no API key, no billing account — organizers drop a pin, everyone else gets a real draggable map |
| External API (consume) | Discord webhook | Replaced a classmate-team peer API per 2026-09-10 amendment — see §5 |
| Exposed endpoint | REST, `x-api-key` header auth | Generic, not tied to a specific consumer team — see §5 |
| Containers | `Dockerfile` + `docker-compose.yml` (app + MySQL) | Reworked and actually verified 2026-09-16 — see §3. Production still deploys natively (PM2 + Nginx), like the lab's `crud-api` |
| Hosting | Same VPS as the existing lab/WordPress stack | New URL path, must not break existing routes (see §3) |
| Source control | GitHub | Not pushed yet (§11). CI in `.github/workflows/ci.yml` runs once it is — see §3 |
| Deploys | `deploy.sh` → release directories on the VM, pre-flight check, DB backup, automatic + manual rollback | Reworked 2026-09-18 — see §3 |
| Request validation | `zod` schemas in `src/validation/`, one middleware | Added 2026-09-18 — see §4 |
| Background delivery | Transactional outbox (`outbox_jobs`), worker in the app process | Added 2026-09-18 — see §5 |
| Frontend | React + Vite, `@azure/msal-react` for real login | Added 2026-09-10, matches the lab's own frontend pattern — see §9 |
| API hardening | `helmet` (CSP + headers), `cors` allow-list, `express-rate-limit` | Added 2026-09-16 — see §4 |
| Testing | Jest + Supertest, `npm test` (204 tests) | Added 2026-09-10 — Prisma/auth/Geoapify/Discord all mocked, no live dependencies needed — see §8. Plus e2e suites in `tests/e2e/` and a deploy test in `tests/deploy/` |

---

## 3. Deployment Target (shared VPS)

This app deploys **alongside existing infrastructure on the same VPS** — it does not get its own box.

- VM: `bad-vps-01` @ `chaotic-hell.eastasia.cloudapp.azure.com`
- SSH: `ssh -i ~/.ssh/bad-vps-01_key.pem azureuser@chaotic-hell.eastasia.cloudapp.azure.com` (confirmed working)
- System Node on the VM is **v18.19.1** (not v20) — this app's `package.json` targets `>=18.18.0` to match, rather than requiring an nvm install alongside the system Node used by `crud-api`
- Existing routes that **must not break**:
  - `/content` → WordPress (proxied to `127.0.0.1:8080`)
  - `/api` → existing lab CRUD API (`backend-crud-api`, run under PM2 as `crud-api`, on `127.0.0.1:3000`)
- **This app's path: `/events`**, proxied to `127.0.0.1:3001` (matches the scaffold's default `PORT`) — single Nginx site `azure-proxy` at `/etc/nginx/sites-available/azure-proxy`, single Certbot cert covering the whole domain (renewed automatically by `certbot.timer`; valid to 2026-12-08 as of 2026-09-16)
- **VPS hardening** (course requirement #1), verified 2026-09-16: SSH is key-only (`passwordauthentication no`, `permitrootlogin no`), `ufw` active, `unattended-upgrades` active, and **`fail2ban` installed 2026-09-16** — the auth log had **3,707 failed SSH attempts** from bots, which also explains two brief "connection refused" failures during deploys (sshd throttling). `/etc/fail2ban/jail.local`: 5 failures in 10 minutes → 1 hour ban, loopback never banned, `backend = systemd` (Ubuntu 24.04 logs to journald). Verified end to end: a real bot (92.118.39.49) was banned automatically, and the ban is enforced by an nftables set that rejects the IP on port 22 — not just recorded.
- Nginx `/events` block is **deployed and live** (config tested + reloaded 2026-09-09; pre-change config backed up on the VM as `azure-proxy.bak.20260909072045`).
- ✅ **App deployed 2026-09-09**, running under PM2 as `campus-event-api` on port 3001, alongside `crud-api`. Deployed via `deploy.sh` (root of this repo) — matches the taught pattern (scp source, `npm install` natively on the VM, `prisma generate` + `prisma migrate deploy`, `pm2 restart`/`start`, `pm2 save`). **Superseded 2026-09-18 by release-based deploys — see "Release-based deploys" below.** `GET /events/api/venues` through Nginx correctly returns `401 Missing bearer token` (full chain verified: Nginx → app → route → auth middleware). `/content` and `/api` unaffected (regression-checked).
  - Non-secret bootstrap config lives in `~/campus-event-api/.env` (since 2026-09-18: `shared/.env`, linked into each release) **on the VM only** (copied from `.env.example`, never committed) — `PORT`, `TENANT_ID`, `CLIENT_ID`, `KEY_VAULT_URL`.
  - `deploy.sh` fetches `DATABASE_URL` from Key Vault locally (already authenticated to KMUTT's subscription) and passes it only to the remote `prisma migrate deploy` step — never written to `.env` or disk on the VM, since `migrate deploy` is a standalone CLI command that doesn't go through the app's own Key-Vault bootstrap.
  - **Three real bugs found and fixed across deployment** (all committed):
    1. `globalThis.crypto` is `undefined` when Node 18.19.1 runs a file directly (`node src/server.js`) but present when run via `node -e` — a genuine Node 18.x quirk, confirmed by direct testing on the VM, not a config mistake. `@azure/identity`'s HTTP pipeline needs `globalThis.crypto.randomUUID()` and crashed on every boot. Fixed with a `node:crypto` `webcrypto` polyfill as the very first lines of `src/server.js`.
    2. `src/config/keyvault.js`'s `loadSecrets()` used a single `Promise.all` over all secret names, so a missing *optional* secret made the **entire app** fail to boot, not just the features that need it. Fixed: required secrets throw if missing, optional ones are fetched independently and just log a warning + stay unset if missing.
    3. **Found 2026-09-10, more serious than it looked**: `src/server.js` required `./app` (which transitively requires `services/prisma.js`, constructing `new PrismaClient()`) *before* calling `loadSecrets()`. Confirmed directly by testing: Prisma reads and **caches** `DATABASE_URL` at construction time, not per-query — so a client built before the env var is set fails on every later query with "Environment variable not found: DATABASE_URL", even after the var gets set. This meant **every DB query in the deployed app was broken** the whole time, just never triggered because no request had gotten past auth into an actual query yet. Fixed by deferring `require("./app")` until after `await loadSecrets()` inside `bootstrapServer()` — matches the taught pattern (Week 9's lab constructs `PrismaClient` inside `bootstrapServer()`, after the secret fetch, not as a top-level import). Verified end-to-end afterward with a real Prisma query and the full `preorderLanyards` flow (see §5) — both succeeded.
- ~~Unrelated pre-existing issue noticed during deploy: `/content` (WordPress) was returning 502~~ — **fixed 2026-09-09**. Root cause: WordPress runs via Apache + PHP (not Docker — no Docker is installed on this VM) from `/srv/www/wordpress`, listening on `:8080` per `/etc/apache2/ports.conf`. The VM rebooted at 07:12:59 UTC and `apache2.service` was not enabled for boot, so it stayed down. Fixed with `sudo systemctl enable --now apache2`; verified `/content` now returns 200 (after its normal redirect). MySQL (the WP DB) was unaffected throughout.

### Release-based deploys, 2026-09-18 (Thar: "improve deployment rollback")

The old `deploy.sh` copied files over the running app: a bad deploy could only be fixed by
another deploy, and a crash on start meant the site was down until someone noticed. Now
(`deploy.sh` locally, `scripts/remote-deploy.sh` on the VM, uploaded each time):

- **Layout** under `~/campus-event-api`: `releases/<UTC time>-<commit>/` (each with its own `node_modules`), `current -> releases/<id>`, `shared/.env`, `shared/backups/`, `shared/logs/`, and `releases.log` (every release that went live *and passed its checks*, and every failure). The top-level `.env` is now a link to `shared/.env`.
- **Steps**: refuse uncommitted changes (`ALLOW_DIRTY=1` overrides) → build the frontend and pack the committed code → unpack as a new release, `npm install` (starting from the live release's `node_modules`), `prisma generate` → **pre-flight**: start the release on `:3002` with `OUTBOX_WORKER=off`, require `/health?deep=1` to report *its* release id with the database reachable, `/events/` → 200 and `/events/api/me` → 401, then stop it (users stay on the old release throughout) → if migrations are pending, **`mysqldump` to `shared/backups/<id>-before-migrate.sql.gz`** (credentials in a 600 temp file, dump chmod 600, last 10 kept), then `prisma migrate deploy` → **switch**: `pm2 delete` + `pm2 start` from the release directory (a PM2 restart would keep running the old path), same checks on `:3001` → on failure, switch straight back to the previous release. Keeps 5 releases.
- **Rollback**: `./deploy.sh rollback` → the release last live and healthy before the current one; `./deploy.sh rollback <id>`; `./deploy.sh releases`. **Code only** — migrations must stay compatible with the previous release (add; don't rename or drop in the same deploy).
- `/health` (only reachable on the VM — Nginx forwards `/events`, not `/health`) now returns `release` (from a `RELEASE` file written into each release) and, with `?deep=1`, a database check.
- **Two security fixes along the way**: the database URL used to be on the remote command line (visible in `ps`); it now goes over stdin. And PM2 copies the caller's environment into `~/.pm2/dump.pm2` on disk, so every `pm2` call runs with `DATABASE_URL` unset.
- **Tested** with `tests/deploy/test-deploy.sh`: the real `deploy.sh` over SSH against a throwaway VM in Docker (Node 18.19.1, PM2 7.0.3, sshd) and MySQL, starting from production's own code (`06c45a5`) in the old layout, with a DB password containing `@:/"\`. **41/41, twice**: adopting the old layout, backup + migration, rollback and forward, a rollback to a missing release changing nothing, a release that throws on start (stopped by pre-flight, live release untouched, its directory removed), the same release with `SKIP_PREFLIGHT=1` (switched, failed its check, rolled back automatically), pruning, and refusing uncommitted changes. Three real bugs were found by it: the pre-flight `node` was never killed (`cd && node … &` backgrounds the whole list, so `$!` was a subshell) which blocked every later deploy on `:3002`; `activate` logged a release as live *before* its check, so `rollback` could pick a broken release; and ShellCheck caught `local id="$2" log="…$id…"` expanding `$id` before it was set (it only worked because the caller also had an `id`).
- `mysqldump` was checked first on the real VM with the app's restricted user (MySQL 8.0.46 client, 84 KB gzipped) — MySQL 8's dump can need privileges that user lacks.
- ✅ **First real deploy 2026-09-17 17:16 UTC** (release `20260917-171608-6bdf478`): adopted the old layout as `legacy-20260917-171615`, backed up (84 KB, taken before `outbox_jobs` existed), applied `20260918090000_outbox_jobs`, pre-flight and live checks passed. A public probe every 0.5s saw 3 × 502 during the switch (~1.5s) and nothing else failing. Then **rolled back to legacy and forward again on production** (`./deploy.sh rollback` twice): both switches passed their checks, 5 × 502 in total. Afterwards: `/content` 301, `/api` 404 (as before), live sign-in redirect check 12/12, no `DATABASE_URL` in PM2's dump.
- The e2e instructions (`tests/e2e/README.md`) now use `APP_DIR=$HOME/campus-event-api/current`.

### Docker, 2026-09-16 — works locally, not used in production

The scaffold's `Dockerfile` (2026-09-09) was never revisited and **would have built a
broken image**: it didn't build `frontend-ui`, so the container would have served the API
with no UI. Rewritten and genuinely verified this time (`docker compose up --build` →
migrations applied, app serving, frontend assets 200, CSP headers present, all 8 tables
created; the whole stack was then torn down with `docker compose down -v`):
- Three stages: build the React app → install deps + `prisma generate` → slim runtime (`node` user, no dev dependencies, 604MB).
- `docker-compose.yml` runs the app **and** a throwaway MySQL, so the project runs on any machine with one command — useful for the demo and for a teammate who doesn't have the VM's access.
- `npm install`, not `npm ci`: the backend lockfile, written by npm 11 on macOS, left out `@emnapi/core`/`@emnapi/runtime` (peers of an optional wasm binding) and npm 10's `npm ci` refused it. **Fixed 2026-09-18** by regenerating it with Node 18's npm 10 (two entries added, no versions changed); `npm ci` now works on Linux/npm 10 and macOS/npm 11, and CI uses it. The Dockerfile still says `npm install`, which also works. ⚠️ If a teammate's `npm install` on a Mac drops those entries again, CI's `npm ci` will fail — regenerate with `docker run --rm -v "$PWD":/w -w /w node:18.19.1-bookworm-slim npm install --package-lock-only`.
- **`loadSecrets()` now prefers secrets already in the environment** and only calls Key Vault for what's missing (`src/config/keyvault.js`, 5 unit tests). A laptop has no managed identity; production sets none of these vars, so the VM still reads everything from the vault.
- **Production is unchanged**: PM2 + Nginx via `deploy.sh`. The VM has no Docker installed, and it also runs WordPress and the lab `crud-api`, so switching it to containers would risk a working deployment for no benefit.

---

## 4. Auth & Secrets — Rationale

The school does **not** issue AD or Key Vault credentials for the capstone project itself. Original plan was to self-provision a fully separate Entra tenant — **dropped 2026-09-09**: the "Azure for Students" subscription isn't eligible to host a new tenant (see below), and on reflection a separate tenant wasn't the right fit anyway — the concept doc has organizers/students logging in via *actual* university AD, which a fresh empty tenant wouldn't have. Actual plan:

- Register this app directly in the existing KMUTT tenant (same one already used for the lab's `backend-api-identity`), rather than a separate tenant
- Self-provision a separate **Azure Key Vault**, accessed via **VM managed identity**
- Reuse the *pattern* already proven working in the lab series' Key Vault week:
  ```
  bootstrapServer() {
    // DefaultAzureCredential + SecretClient
    // fetch secrets BEFORE app.listen()
  }
  ```
- Lab reference values (same pattern, **different resource** — do not assume these are reused for the capstone):
  - Vault: `thar-csx4110-kv`, resource group `BAD-2026-RG`
  - App registration: `backend-api-identity`
  - Tenant ID: `6f4432dc-20d2-441d-b1db-ac3380ba633d`
  - Client ID: `0840d62b-b6f2-43f1-99e3-8def7cc3455b`
  - RBAC split: self = *Key Vault Secrets Officer* (write), app identity = *Key Vault Secrets User* (read)
  - Note: East US region was blocked on the student subscription — needed a different region
- ✅ **Key Vault provisioned 2026-09-09** (via Azure CLI, signed in as `khinezar.chi1@kmutt.ac.th` on the KMUTT "Azure for Students" subscription — same tenant as the lab reference, `6f4432dc-20d2-441d-b1db-ac3380ba633d`):
  - Resource group: `campus-event-api-rg` (eastasia) — separate from `BAD-2026-RG`
  - Vault: `campus-event-api-kv`, RBAC authorization enabled, `https://campus-event-api-kv.vault.azure.net/`
  - `khinezar.chi1@kmutt.ac.th` → *Key Vault Secrets Officer* (write)
  - `bad-vps-01`'s new system-assigned managed identity (`6990ca31-49d4-46a1-8f5a-8d6bbc117f1b`) → *Key Vault Secrets User* (read)
  - Secrets: `database-url` ✅, `geoapify-api-key` ✅, `discord-webhook-url` ✅ — all three populated as of 2026-09-10. No `jwt-signing-key` secret — auth is Entra JWKS-validated, not self-issued JWTs, so there's no shared signing secret to store. The room-status endpoint's peer keys are **not** Key Vault secrets — see §5, they're issued through `/events/api/admin/api-keys` and stored hashed in the `ApiKey` table.
- ❌ **Separate Entra tenant: not possible on the KMUTT "Azure for Students" subscription.** Attempted via the portal's "Create a tenant" wizard — the subscription picker returns zero eligible subscriptions (Microsoft's known restriction on free/promotional subscription offers). No tenant was created.
- ⚠️ **First attempt (2026-09-09, superseded — see below): registered the app in KMUTT's tenant.** Reasoning at the time: real users log in via *actual* university AD, and KMUTT was the tenant already being used for Azure provisioning, so registering there (rather than a fresh empty tenant) seemed to satisfy "logs in via university AD." **This was wrong** — the real target users are **AU** students/organizers (this project's own team + classmates), not KMUTT ones. KMUTT was only ever being used because the KMUTT account had Azure subscription credit; auth has nothing to do with which subscription pays for hosting. The KMUTT app registration (Client ID `6426aa53-...`) has been **deleted** (2026-09-09) once this was caught.
- ✅ **App registered 2026-09-09 in AU's own tenant instead** (`c1f3dc23-b7f8-48d3-9b5d-2b12f158f01f`, "Assumption University"), signed in as `u6642062@au.edu` (Thar Lin Htet). AU's tenant has no Azure *subscription* attached (`az login` needs `--allow-no-subscriptions`) — but app registration doesn't need one; it's a free Entra ID operation, unrelated to subscription billing. This is the actual fix for "AU students should log in, not KMUTT":
  - Display name: `campus-event-api`, Client ID (App ID): `f581260c-6bc3-4f8c-a711-ac2ca274f56b`
  - Sign-in audience: `AzureADMyOrg` (AU accounts only)
  - Identifier URI: `api://f581260c-6bc3-4f8c-a711-ac2ca274f56b`
  - Same 3 app roles as before: `Organizer` (`ORGANIZER`), `Student` (`STUDENT`), `Admin` (`ADMIN`) — matches the Prisma `Role` enum
  - Service principal (enterprise app) created so it's sign-in-able
  - `TENANT_ID`/`CLIENT_ID` updated in `.env.example` to the AU values
  - **Added 2026-09-10** (needed to test with a real token — see the new subsection below): public client (device code) flow enabled; an exposed API scope `access_as_user` plus self-referencing `requiredResourceAccess`; `requestedAccessTokenVersion: 2` forced (was silently defaulting to v1.0 tokens, which would have broken every real login — see below)
  - **Also added 2026-09-10** (for the browser frontend — see §9): a "Single-page application" platform with redirect URIs for both production and local dev
  - **Not needed**: no client secret (JWT/JWKS validation, no confidential-client flow). Redirect URIs *were* added 2026-09-10 with the frontend — see §9
- ✅ **Role assignment 2026-09-09**: `u6642062@au.edu` → **all three** app roles (`Admin`, `Organizer`, `Student`) on the AU-tenant `campus-event-api`. `src/middleware/auth.js`'s role-priority resolution (`ADMIN` > `ORGANIZER` > `STUDENT`) means this account resolves to `ADMIN` in practice.
- ✅ **Role assignment 2026-09-10**: `u6726113@au.edu` (Honey Linn) confirmed to exist in AU's tenant (object id `27486aab-ce5f-4c1b-bb32-85e750f4572d`) → assigned `Organizer` and `Admin`. Same priority resolution means she'll also resolve to `ADMIN` on first login (role is set once at account creation — see below — so this is what her local `User` row gets from the start, not something that needs changing later).
- ⚠️ **What the database actually says, checked 2026-09-17** (the app's role lives in the `users` table, not in Entra — see below), which doesn't match the expectation above:
  - `u6642062@au.edu` Thar Lin Htet → `ADMIN`
  - `u6726113@au.edu` Honey Linn → `STUDENT`. First signed in 2026-09-16 and was `ORGANIZER` — not `ADMIN` as expected above; why wasn't investigated. The audit log shows **Thar changed her to `STUDENT` through the Admin panel on 2026-09-17 at 05:10 UTC**. If that wasn't meant to be permanent, change it back from the Admin panel.
  - `u6726115@au.edu` Mi Hsu Myat Win Wyint → `ORGANIZER`, first signed in 2026-09-16. Mi Hsu's Entra role assignment was never recorded here.
- **Key Vault stays on KMUTT** (§ above) — that's purely about who's paying for the VM/vault compute, and is unrelated to the auth tenant. No change needed there; `khinezar.chi1@kmutt.ac.th`'s Key Vault Secrets Officer role and the VM's managed identity are unaffected by the auth tenant switch.
- ⚠️ **Also briefly attempted, then reverted**: switched auth to the labs' homegrown pattern (bcrypt + self-issued JWT + custom `users` table) to match what's actually *taught*, before realizing the submitted proposal explicitly commits to Entra ID/OIDC — reverted before committing. The proposal is authoritative over what the labs teach; see the note at the top of this file.
- `src/middleware/auth.js`'s `requireAuth` upserts a local `User` row on first sign-in, keyed by the token's `oid` claim (`adObjectId`). Role is set from the token's `roles` claim **only at creation** — an existing user's role is never overwritten on later logins, since Admins manage roles through `/events/api/admin/users/:id/role` and Entra App Role assignment shouldn't silently clobber that.

### Endpoint hardening, 2026-09-16 (teacher asked that nobody can update or delete anything)

Authorization was already enforced — every write needs a valid Entra token, a role, and
(for events/bookings) ownership; `/admin/*` is Admin-only; and **nothing is ever hard
deleted**: "delete event" sets `CANCELLED`, cancelling a booking keeps the row, revoking a
key keeps the record. `src/middleware/security.js` closes the edges around that:
- **CORS allow-list** — only `https://chaotic-hell…/events/`, `localhost:5173` (dev) and `127.0.0.1:4173` (e2e) get CORS headers, so another website can't call the API from a logged-in student's browser. Requests with no `Origin` (curl, the room-status consumers) are unaffected — they're authenticated by bearer token or `x-api-key`. Override with `ALLOWED_ORIGINS`.
- **Security headers via helmet**, including a Content-Security-Policy tailored to this app (self scripts; Google Fonts; OpenStreetMap tiles; `login.microsoftonline.com` for MSAL's silent-refresh iframe), `frame-ancestors 'none'`, HSTS, `nosniff`, and no `X-Powered-By`. `cspDirectives` is exported so `tests/e2e/serve-frontend.mjs` serves the e2e build under the *same* policy — the 142-check UI run passes under it, which is how we know the policy doesn't break maps, fonts or API calls.
- **Rate limiting** per signed-in user (hashed credential, falling back to IP): 1000 requests and 200 writes per 5 minutes by default (`RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WRITES`). One noisy account can't lock others out, and reads keep working when a writer is throttled.
- `express.json({ limit: "100kb" })` and `trust proxy 1` (Nginx sets `X-Forwarded-For`).
- ❗ **This hardening broke the live maps (found 2026-09-17).** helmet's default `Referrer-Policy: no-referrer` stripped the Referer from tile requests, and OpenStreetMap refuses those — it serves an "Access blocked / 403" *picture* with HTTP **200** and `Cache-Control: no-cache`, so the tile "loads" fine. Every test passed anyway, for two reasons: `tests/e2e/serve-frontend.mjs` copied only the CSP header, not the referrer policy, so the test build still sent a Referer; and the UI checks only asked whether a `.leaflet-tile` existed. Fixed with `referrerPolicy: strict-origin-when-cross-origin` (other sites get our origin only — no path or query — and nothing over plain HTTP; it's the browser default), also set on Leaflet's tile layer. The test build now sends the same header, and `ui-test.mjs` inspects every OSM tile response: each must carry a Referer and none may be the no-cache blocked image (132 tiles checked, all real). The detection was first confirmed against the broken live site (4/4 tiles blocked), then again after the deploy.
- Covered by `tests/integration/security.test.js` (7 tests) and verified on the live site: headers present, a foreign origin gets no CORS headers, our own origin does.
- **Audit log added 2026-09-16** (was the last gap): `audit_logs` records who did what — event created/updated/cancelled, supplies ordered, venue added/archived/deleted, role changed, API key issued/revoked. Student bookings are deliberately *not* logged: they'd bury the organizer/admin actions this is for, and each booking row already records who booked and when. Written by `src/services/audit.js`, which swallows its own failures so a lost log line can never break the action it describes (covered by a test).
  - `GET /events/api/admin/audit` (Admin) → the **Activity** tab in the Admin panel.
  - `GET /events/api/events/:id/history` (owner or Admin) → the **History** button on each event, shown as a timeline ("capacity 5 → 8", "draft → published", who, when).

### Request validation and dependency updates, 2026-09-18

- **Express 4.22.2 → 4.22.3**, which pulls in `qs` 6.16.0 (≤ 6.15.3 had an array-limit bypass and an `isBuffer` DoS advisory). The one remaining `npm audit` finding is `deepmerge-ts` inside the `prisma` CLI's config loader (merges Prisma's own config files, not user input); its only fix is a Prisma downgrade marked breaking, so it's left while Prisma stays pinned at 6.19.3.
- **Centralized validation**: every route declares what it accepts in `src/validation/schemas.js` (`zod` 4); `src/validation/validate.js` checks params/query/body before the handler and puts clean, typed values on `req.valid`. Business rules that need stored data stay in routes (venue exists, capacity vs. confirmed seats, end vs. the stored start, self-demotion).
  - One error shape: `400 { error, details: [{ field, message }] }`; `error` is still the human sentence the frontend shows, and the existing messages were kept (30+ tests assert them).
  - A malformed id in a URL is a `404` that never reaches the database — including ids beyond MySQL `INT`, which used to be a 500. A malformed booking `eventId` stays a 404.
  - Unknown body fields are dropped: a client can't set `organizerId`, `venueId` on PATCH, or `isLargeConference`.
  - Lengths match the columns (a 192-character title was a Prisma `P2000` 500); a long reverse-geocoded address is cut to 191 characters. Repeated query parameters and non-object JSON bodies are 400s.
  - `parseId` (`src/utils/http.js`) was removed; nothing used it any more.

### Deleting things, 2026-09-16

Thar asked for a delete feature and what I'd recommend. The rule applied:
- **Venues**: deleted for real only when no event has ever used them (a mistyped or test venue). If events reference the venue, deleting it would destroy their history, so it is **archived** instead — hidden from the venue picker, still shown on existing events, and `GET /venues?includeArchived=true` still lists it. Trying to delete an archived-but-used venue is a `409`.
- **Events**: still cancel-only. Cancelling already frees the seats, tells students and keeps the record.
- **Bookings**: never deleted — they're the evidence of who booked what.
- The UI explains both outcomes before you confirm, and the toast says which one happened.

### Real end-to-end test with a real Entra token, 2026-09-10 — found several serious bugs

Everything up to this point had only ever been verified as a `401`/`404` on missing auth,
or via direct Prisma calls bypassing the HTTP layer entirely. Nobody had ever logged in
for real and walked a full request through `requireAuth` into an actual query. Doing that
surfaced problems that no amount of testing at the layers below would have caught.

**App registration changes needed just to acquire a token at all** (none of this existed
before — the app had no way to issue itself a token for testing without a frontend):
- `az ad app update --is-fallback-public-client true` — enables the device-code flow (no client secret exists)
- Added an exposed API scope (`api://<clientId>/access_as_user`) plus a **self-referencing** `requiredResourceAccess` (the app requesting a scope on itself, since there's no separate client app) — without this, token requests failed outright with `AADSTS650057: Invalid resource`
- ❗ **`requestedAccessTokenVersion` was never set, so Azure AD was issuing v1.0 tokens** (`ver: "1.0"`, issuer `sts.windows.net/...`) for this API resource — but `src/middleware/auth.js` was written expecting v2.0 tokens (issuer `login.microsoftonline.com/.../v2.0`, bare-GUID audience). **This meant no real user could ever have successfully authenticated against this API — every real login would have failed the issuer check.** Fixed with `az rest PATCH .../applications/{id}` setting `api.requestedAccessTokenVersion: 2`. Re-acquired a token afterward and confirmed `ver: "2.0"`, correct issuer, correct audience (`f581260c-...`, no `api://` prefix), `preferred_username` present.

**Bugs found once real requests actually reached the app** (all fixed, all committed):
1. **`static_map_url` column too short.** Prisma's default `String` → MySQL `VARCHAR(191)`; the generated Geoapify static-map URL is longer than that. Venue creation failed with Prisma error `P2000`. Fixed: `staticMapUrl String? @db.Text` (migration `20260910142109_fix_static_map_url_length`).
2. **That failure hung the request for a full minute instead of returning an error.** Express 4 does not forward a rejected promise from an async route handler to the error-handling middleware (that's an Express 5 feature) — an unhandled rejection just hangs until Nginx's own timeout fires, returning a bare `504`. This wasn't specific to venues — **every async route handler and every async middleware in the app had this problem**, including `requireAuth` and `requirePeerApiKey` themselves. Fixed with a small `asyncHandler` wrapper (`src/middleware/asyncHandler.js`) applied to all ~20 handlers across every route file and both auth middlewares.
3. **`capacity: 0` was rejected with a misleading "Missing required event fields."** Classic JS falsy-value bug: `!capacity` treats `0` as missing. Fixed with an explicit `Number.isInteger(capacity) && capacity >= 1` check and its own error message.
4. **Duplicate booking (re-booking an event you already booked) surfaced as a generic `500`.** The DB's unique constraint (`P2002` on `[eventId, studentId]`) was working correctly, just not caught. Fixed: catch `P2002` in the bookings POST route, return `409 "You have already booked this event"`.

**What was actually verified working, end-to-end, with a real token, against the live
deployed app** (all test data cleaned up afterward, Thar's role restored to `ADMIN`):
venue creation (real Geoapify call) → event creation as Organizer → a second, genuinely
distinct student (seeded directly, to test real multi-user isolation) fills an event's
capacity → the real account books the same event via HTTP and correctly lands in
`WAITLISTED` → duplicate-booking rejection → booking cancellation → cross-user booking
cancellation is correctly blocked (404, not 403 — doesn't leak existence) → organizer
event update/attendee-list/cancel, all ownership-checked → a large-conference event
correctly triggers the Discord webhook (real message id stored) → the room-status peer
endpoint correctly reflects the live event and correctly rejects a wrong/revoked API key
→ Admin-only routes correctly reject a non-Admin (`403`) and vice versa. Role switching
was done through `PATCH /admin/users/:id/role` (proper HTTP path) for Admin→Student, and
directly via Prisma for Student→Organizer (a Student can't call the Admin-only role
endpoint on themselves — expected, not a bug).

---

## 5. External/Public API Integration (amended 2026-09-10)

⚠️ **Scope change, verbal instruction from the instructor, 2026-09-10**: the original
peer-API-ring design (below, struck through) is dropped. Teacher wants **one genuine
public API** connected (not a classmate's), keeping the same two-sided shape — something
consumed automatically, and something exposed — but the consumed side no longer talks to
another student team, and the exposed side isn't scoped to a specific team either. No
written source for this instruction exists (verbal/chat only) — see git history around
2026-09-10 for the full back-and-forth that led to this design; it's the record if this
needs re-confirming with the instructor.

~~Class-wide structure: Ticketing → Events (this project) → Merch → EduCore → Ticketing.
Every team must both expose an endpoint and consume a partner's endpoint.~~ **Dropped.**

### Consume: Discord webhook (was: Merch team's API)
- Purpose: post a supply order to Discord for an event (originally a fixed 50 blank lanyards for a large-conference event; organizer-chosen item and amount since 2026-09-16 — see below) — `src/services/merch.js` (filename kept — same business feature, different fulfillment mechanism; `MerchPreorder` DB model also kept as-is, just repurposed)
- **Chosen because**: free, no signup friction beyond what most students already have (a Discord account/server), and — unlike a pure lookup API (e.g. Geoapify) — a webhook POST is a genuine *action* with a trackable response, structurally analogous to what "placing an order" was supposed to demonstrate
- Mechanics: `POST {DISCORD_WEBHOOK_URL}?wait=true` with `{content: "..."}` — `?wait=true` makes Discord return the created message object (with its `id`) instead of a bare 204, so we have something real to store
- Auth: the webhook URL itself functions as the credential (anyone with it can post) — stored in Key Vault as `discord-webhook-url`. **Obtained and wired up 2026-09-10** (a new "CSX4110 Project" Discord server + channel, incoming webhook added). Verified end-to-end: created a throwaway large-conference test event directly against the deployed app, called `preorderLanyards()`, got back `status: "CONFIRMED"` with a real Discord message id as `peerOrderRef`, then cleaned up the test data.
- Result recorded in the `MerchPreorder` table (`PENDING`→`CONFIRMED`/`FAILED`), `peerOrderRef` now holds the Discord message id instead of a Merch order ref

**Supply orders became organizer-chosen, 2026-09-16.** The course brief says "pre-order 50
blank university lanyards", so the first build hard-coded a `isLargeConference` switch →
50 lanyards. Thar pushed back: an event might need t-shirts or water bottles, and 50 is
arbitrary. Now:
- The event form has an optional *item* + *how many* (amount defaults to one per seat), instead of a switch. `POST /events` takes `supply: { item, quantity }`; `MerchPreorder.item` was added (migration `20260916120000_supply_request_item`) and the fixed `quantity` default dropped.
- `isLargeConference` is kept (it's in the proposal) but now simply records "this event has a supply order attached".
- **Drafts don't order anything.** The request is stored `PENDING` at creation and sent to Discord when the event is published, because ordering supplies for an event nobody can book yet is wrong. Re-publishing doesn't re-order; a `FAILED` send is retried on the next publish. The organizer's list refreshes itself once the Discord post lands. (Sending changed 2026-09-18 — see the outbox below.)
- Verified live: 143/143 API (including draft → publish → real Discord message, and republish not double-ordering) and 142/142 UI.

**Atomic creation and a durable outbox, 2026-09-18.**
- **The event and its supply order are one write** (nested create inside `prisma.$transaction`). Before, the order was a second insert: if it failed, the event was already saved and flagged as having supplies, and the organizer got a 500 inviting them to create it again.
- **Sending goes through an outbox** (`src/services/outbox.js`, table `outbox_jobs`, migration `20260918090000_outbox_jobs`) instead of a fire-and-forget call after the response, which marked the order `FAILED` for good on any Discord hiccup and lost it entirely on a restart.
  - The job row is written **in the same transaction** as the change that needs it (creating a published event, or publishing a draft), deduplicated per order (`dedupeKey: supply:<orderId>`).
  - A worker in the app process (started by `src/server.js`, and by `tests/e2e/server.cjs`; `OUTBOX_WORKER=off` disables it) claims due jobs with `SELECT … FOR UPDATE SKIP LOCKED` under READ COMMITTED, with a lease (`lockToken` + `lockedUntil`, 60s) — so separate processes never take the same job, and a crashed process's job is taken over when its lease runs out. The attempt is counted at claim time, so a job that kills the process still runs out of attempts. Requests kick the worker after committing, so delivery is immediate rather than waiting for the 5s poll.
  - Retries: exponential backoff from 15s, ±20% jitter, capped at 1h, 8 attempts; a Discord 429 waits exactly `retry_after`; other 4xx (a deleted webhook) are permanent. Giving up marks the job `DEAD` and the order `FAILED`; publishing again queues a fresh attempt.
  - The handler (`deliverSupplyRequest` in `src/services/merch.js`) re-reads the order first: never re-sends a `CONFIRMED` one, and skips an event unpublished or cancelled while the job waited. axios now has a 10s timeout. Error messages never include the webhook URL.
  - `SIGINT` (PM2 restart) stops the worker and exits inside PM2's 1.6s kill timeout.
  - **At-least-once**: if Discord accepts a message and the process dies before the job is marked done, it's sent again. Tunables: `OUTBOX_POLL_MS`, `OUTBOX_LEASE_MS`, `OUTBOX_BASE_DELAY_MS`, `OUTBOX_MAX_DELAY_MS`, `OUTBOX_MAX_ATTEMPTS`.
  - Production had no unsent orders when this shipped, so nothing old was posted.
- **Tested for real** with `tests/e2e/outbox-test.mjs` against MySQL, real app processes and a fake Discord that fails on command (**46/46, twice**): MySQL triggers force the order insert or the job insert to fail and prove nothing is left behind; transient 5xx then success; `retry_after`; 404 → `DEAD`/`FAILED` → republish succeeds; exhausting attempts; SIGKILL with the only worker, then a new process delivers; SIGKILL mid-request, not retried while the lease holds, then taken over; 24 orders queued during an outage with two worker processes, each posted once; 8 simultaneous claimers over 40 jobs never sharing one — **with the row lock removed that check reports 280 duplicate claims** (the two-process burst alone didn't catch it, which is why the simultaneous-claims check exists); and `src/server.js` delivering and exiting cleanly on SIGINT. The full API suite passed against this code with a local fake Discord (166/166).

### Expose: room-status check (generic, was: HelpDesk-specific)
- Endpoint: `GET /events/api/peer/events/active?room=<number>` — `src/routes/peer.js` (path includes `/events` because Nginx's `/events` block forwards the full URI unchanged, same as the taught `/api` block — see §3)
- Auth: `x-api-key` issued **by this app**, generated via `POST /events/api/admin/api-keys` (Admin-only) and stored **hashed** (SHA-256) in the `ApiKey` table — not a static env var / Key Vault secret
- Response shape: `{active, eventId, title, endsAt}` when an event is currently running in that room (`startsAt <= now <= endsAt`), else `{active: false}`
- **Not scoped to a specific consumer** as of this amendment — issue a key via the admin endpoint to whoever needs it (a demo script, a classmate, anyone); `ownerLabel` is just a free-text note, not an enforced identity
- Consequence unchanged: `Venue` model needs a `room_number` column to support this query param

---

## 6. Design Doc / Submission Conventions

- Format matches the fuller class-proposal template: problem statement, objectives, scope, functional/non-functional requirements, deployment diagram
- Title page: AU-crest style, student voice, matched to the Ticketing team's format
- Instructor: Arjan Dr. Chayapol Moemeng

---

## 7. Reusable Patterns from the Lab Series (same student, different project — `backend-crud-api`)

These aren't part of this repo, but are proven approaches worth mirroring:

- Prisma migrations workflow: introspect + baseline existing DB, then `prisma generate` + `migrate deploy` folded into `deploy.sh`
- JWT-protected CRUD pattern already built and deployed against a live Azure MySQL DB
- Redis cache-aside pattern (`ioredis`): check cache → fall back to Prisma/MySQL → write-through with TTL, invalidate on POST/PUT/DELETE
- Docker: multi-stage-friendly `Dockerfile` (`node:20-alpine`, `.dockerignore` excludes `.env`, `COPY package*.json` before `COPY .` for layer caching)
- Docker Hub account for image publishing: `kayostt`

---

## 8. Open Items (genuinely undecided — don't assume answers)

- [x] DB schema for events/venues/bookings → rebuilt 2026-09-09 to match `docs/proposal.md` exactly (`User`/`Venue`/`Event`/`Booking`/`MerchPreorder`/`ApiKey`, 3 roles, waitlist status). See `prisma/schema.prisma`.
- [x] URL path for this app on `bad-vps-01` → `/events` (see §3) — Nginx block deployed and live, app itself deployed and running on :3001 (see §3), verified end-to-end through Nginx
- [x] Whether the capstone-specific Entra tenant + Key Vault have been provisioned yet → Key Vault: yes, on KMUTT (§4, hosting-only). Auth app registration: in **AU's own tenant** (§4) — first tried KMUTT, corrected 2026-09-09 since the real users are AU students. A wholly separate new tenant (neither KMUTT nor AU) remains infeasible on the KMUTT subscription.
- [x] **Geoapify API key obtained and wired up 2026-09-09.** Stored as the `geoapify-api-key` Key Vault secret. App redeployed and confirmed picking it up.
  - **Bug found and fixed during verification**: `geocodeAddress()` originally rejected any match with `confidence < 0.5`, but empirical testing showed Geoapify's `confidence` score is not a reliable "does this exist" signal — a correctly `full_match`'d real place (a school, confirmed via OpenStreetMap data) scored `confidence: 0`, while genuinely bogus input ("asdkjaslkdj zzxxccvv...") correctly returned an **empty `results` array**. Fixed to check for the presence of any result at all, not a confidence threshold. Re-verified: a real address now resolves with coordinates + map URL, gibberish still correctly returns `null`.
- [x] Merch team's peer order-creation endpoint → **moot**, dropped 2026-09-10 per §5's amendment (no more classmate peer integration)
- [x] `discord-webhook-url` — obtained and wired up 2026-09-10, verified end-to-end (see §5)
- [x] Repo scaffold — done, see `src/`, `prisma/schema.prisma`, `Dockerfile`
- [x] Assign test users to the app roles on `campus-event-api` (§4) → `u6642062@au.edu` (Thar Lin Htet) has all three roles (`Admin`/`Organizer`/`Student`). `u6726113@au.edu` (Honey Linn) → `Organizer` + `Admin`, assigned 2026-09-10.
- [x] **MySQL provisioned 2026-09-09**, following the lab's pattern (MySQL running directly on `bad-vps-01`, same server as WordPress's and `crud-api`'s databases — not a separate managed Azure DB service):
  - Database `campus_events`, dedicated user `campus_events_user`@`localhost` (bound to localhost only — the app runs on the same VM, no need for `api_user`-style `%` remote access)
  - Initial migration generated + applied: `prisma/migrations/20260909084726_init/` (all 6 tables — `users`, `venues`, `events`, `bookings`, `merch_preorders`, `api_keys` — confirmed present via `SHOW TABLES`)
  - Generated on the VM itself via a throwaway bootstrap (`package.json` + `prisma/schema.prisma` copied over, `npm install`, `npx prisma migrate dev`, migration copied back into the repo, bootstrap dir deleted) — avoided opening MySQL port 3306 publicly (unlike the Week 4 lab's local-dev pattern), since the app doesn't need remote DB access in this Zero-Trust design
  - Needed a temporary, narrowly-scoped grant (`` `prisma_migrate_shadow_db_%`.* ``) for `migrate dev`'s shadow database, **revoked immediately after** — `campus_events_user` now only has privileges on `campus_events` itself
  - `database-url` Key Vault secret populated: `mysql://campus_events_user:<password>@127.0.0.1:3306/campus_events`
- [x] Populate the `database-url` Key Vault secret — done above. `geoapify-api-key` was populated 2026-09-09 and `discord-webhook-url` 2026-09-10; `merch-peer-api-key` was never needed once the peer API was dropped (§5)
- [x] HelpDesk vs. "Ticketing" naming mismatch → **moot**, dropped 2026-09-10 — the exposed endpoint is no longer scoped to any specific team (§5)
- [x] **Full flow tested end-to-end with a real Entra token, 2026-09-10** — see the new subsection at the end of §4. Found and fixed 5 more real bugs beyond the ones already listed here (a critical v1.0-vs-v2.0 token mismatch that would have blocked every real login, a Prisma column-length error, a systemic Express-4 async-error-hanging issue across every route, a falsy-value validation bug, and an unhandled duplicate-booking error). This is the first time the actual HTTP request → auth → business logic → DB path was exercised for real, rather than in pieces.
- [x] Whether "Admin" is a real day-to-day role → **decided 2026-09-10: real**, not just a demo/grading convenience. `u6642062@au.edu` continues to hold it day-to-day.
- [x] **Automated test suite added 2026-09-10.** Everything up to this point had been verified by hand (curl, real browser clicks) — thorough, but not repeatable. `npm test` (Jest + Supertest, `tests/unit/` + `tests/integration/`) ran 55 tests (89 as of 2026-09-15) with zero external dependencies — Prisma, `requireAuth`'s JWT verification, Geoapify, and Discord are all mocked (`tests/integration/testApp.js` keeps the *real* `requireRole` authorization logic, only the token-verification part of `requireAuth` is stubbed), so it needs no live DB, no Entra login, no network access at all. Several tests are direct regression tests for bugs found during the real end-to-end testing (§4, §8): the waitlist/duplicate-booking/`capacity: 0`/confidence-threshold bugs, plus ownership and role-gating checks across every route. `resolveRole` was exported from `auth.js` for direct unit testing (previously private).
- [x] **Booking/event business-logic review, 2026-09-15** — the architecture was solid but a code read turned up gaps a grader clicking around would hit. All fixed (89 tests now; 28 of the new/updated ones fail against the pre-fix routes):
  1. **Bug: a student who cancelled could never book that event again.** Cancel only sets `CANCELLED`, the row stays, and `@@unique([eventId, studentId])` made rebooking a `409`. Rebooking now reuses the cancelled row (and resets `createdAt`, which is the waitlist queue position, so rebooking goes to the back of the line).
  2. **The waitlist never moved.** Cancelling a `CONFIRMED` booking now promotes the oldest `WAITLISTED` one. Raising capacity (or re-publishing a draft) fills open seats the same way. Lowering capacity below the confirmed count is rejected with `409` — a confirmed student is never bumped back to the waitlist.
  3. **Last-seat race.** Booking was count-then-insert with no transaction, so two simultaneous RSVPs could both get the last seat. Every seat-changing operation now runs in a `READ COMMITTED` transaction that first takes `SELECT ... FOR UPDATE` on the event row (`src/services/bookings.js`). Proven on the live database 2026-09-15: the pre-fix code double-booked, this code never did — see the live E2E entry below.
  4. **Input validation**: event dates must be real dates with `endsAt > startsAt`; `venueId` must exist; `status` must be a valid enum value; `PATCH` now validates `capacity`/`status`/`title` too (it validated nothing before). Non-numeric ids, malformed JSON bodies, and Prisma `P2025` (record not found) now return `404`/`400` instead of a generic `500` (`src/utils/http.js` — `HttpError` + `parseId`, mapped in `app.js`'s error handler).
  5. **Draft leak**: `GET /events/:id` returned `DRAFT` events to any logged-in user — now `404` unless you're the organizer or an Admin.
  6. **Cancelling an event left its bookings `CONFIRMED`** — `DELETE` (and `PATCH status: CANCELLED`) now cancels all active bookings in the same transaction.
  7. **Thar's role found as `ORGANIZER` again (after being restored to `ADMIN` 2026-09-10 14:52).** The session log shows no script or tool changed it — the likeliest cause is a stray click in the Admin panel, whose role buttons acted on one click with no confirmation. Fixed on both sides: the API now refuses to let an Admin change their own role (another Admin must), and the panel asks for confirmation and hides the buttons on your own row. DB role restored to `ADMIN` 2026-09-15 (at Thar's request).
  8. **Admins had no "My Events" tab**, so anyone holding Organizer + Admin (Thar, Honey — Admin wins role priority) couldn't create events from the UI. `App.jsx` now gives Admins the Organizer panel too.
  - ✅ **Deployed 2026-09-15** — `/events/` serves the new frontend bundle, API returns `401` without a token as before, `/content` `200`, `crud-api` untouched (still up, 4-day uptime).
- [x] **Live end-to-end test run against the production DB, 2026-09-15** (user-approved; tooling + how to rerun in [tests/e2e/README.md](tests/e2e/README.md)). The real app ran on the VM with only Entra token checks swapped for tagged `e2e-` test users. All test rows were deleted afterward, and the DB was diffed against a pre-test snapshot: identical.
  - **Race condition, proven both ways.** The **pre-fix code** (commit `01b4dcc`) was given 12 simultaneous RSVPs for a 1-seat event and confirmed **12 seats** in 4 of 6 rounds (3-seat events: 12 confirmed). The **current code** confirmed exactly 1 or 3 in all 10 rounds, and the invariant scan found nothing over capacity or waiting while seats were free.
  - **API suite: 154/154** on the final code. Covers roles, every validation path, draft visibility, 10 race rounds, 8 simultaneous duplicate RSVPs → exactly one 201, waitlist promotion order (including a rebooked student going to the back), 2 simultaneous cancellations → both next students promoted, capacity raise during a booking rush, unpublish/republish, cascade cancel, attendee lists, admin role changes and self-demotion guard, room-status API with issue/scope/revoke. It also ran the real Geoapify check and posted a real Discord message (verified via Discord's API: the message exists in the channel).
  - **UI suite: 129/129** in a visible Google Chrome window on the production build (MSAL swapped for a test double), against the same real backend/DB, as Student, Organizer and Admin. Covers every dialog, filter, toast, empty state, error state, Escape/backdrop/stacked dialogs, clipboard copy, URL tabs with reload/Back/Forward, 390px + 768px layouts (no horizontal scroll) and dark mode. The only console messages were the 4 deliberate 4xx responses.
  - **Live site with real MSAL: 12/12.** New build, fonts and favicon load with no console errors. "Sign in with Microsoft" redirects to the AU tenant with the right client id, redirect URI, API scope and PKCE, and Microsoft shows its sign-in page (no AADSTS error). No credentials were entered.
  - **Found and fixed during the run** (all deployed):
    1. `DELETE /admin/api-keys/:id` returned the stored `keyHash`. It now selects safe fields only.
    2. Admins could only revoke keys issued since the page loaded. Added `GET /admin/api-keys` (no hashes), an "All keys" table, and a revoke confirmation.
    3. The API client was rebuilt whenever the MSAL account *object* changed, and every page refetches when that happens. With a non-memoized account that became an endless loop (**235 requests in 12s**). Production's real MSAL keeps the object stable (the nginx log shows ≤2 req/min), but `App.jsx` now keys the client on the account id.
    4. Reload always dropped you on Discover. The tab now lives in the URL hash (`#admin`, `#bookings`…), so refresh, Back/Forward and direct links work.
    5. A venue added from inside "Create an event" is now auto-selected in that form.
    6. The one-time API key overflowed its box (a grid track sizing issue). It now wraps, with Copy below on phones.
    7. On phones the 4 stat cards stacked into one tall column. They're now a compact 2×2 grid.
    8. API error messages leaked field names and lowercase text (`endsAt must be after startsAt`, `capacity can't be lower…`). They're now human-readable ("The event must end after it starts").
  - Noticed at the time: the VM's SSH log showed constant bot login attempts (`invalid user …`) and `fail2ban` was not running. **Installed 2026-09-16** — see §3.

---

## 9. Frontend (`frontend-ui/`) — added 2026-09-10

React + Vite, matching the lab's own frontend pattern (`npm create vite@latest ... --
template react`, built and served by Express — see §7) rather than a separate hosting
setup. Live at `https://chaotic-hell.eastasia.cloudapp.azure.com/events/`.

- **Real Microsoft login**, not a mock — `@azure/msal-browser` + `@azure/msal-react`, `loginRedirect`/`logoutRedirect` (see below for why not `loginPopup`)
- `vite.config.js` sets `base: '/events/'` — required since the build is served from under that path, not domain root
- `src/app.js` serves `frontend-ui/dist` as static files, mounted **after** all `/events/api/*` routes so the API is never shadowed by the frontend catch-all
- `deploy.sh` now builds the frontend (`npm run build` in `frontend-ui/`) as its first step and ships `dist/` alongside the backend — `dist/` itself is gitignored (lab convention: built fresh at deploy time, not committed)
- Added `cors` middleware so `npm run dev` on `localhost:5173` can call the deployed API directly (open to every origin at first; **narrowed to an allow-list 2026-09-16**, see §4) — `frontend-ui/.env.development` points local dev at the live backend, since there's no separate local backend+DB to run against
- Added `GET /events/api/me` (`src/routes/me.js`) so the frontend can learn the logged-in user's **DB-authoritative** role (not the token's `roles` claim, which isn't updated after Admin-managed role changes — see §4) — `req.user` in `requireAuth` now also carries `email`/`displayName` from the DB row, not raw token claims
- Added `GET /events/api/events?mine=true` (in `src/routes/events.js`) so an Organizer can see their own events including drafts — the original proposal only specified the public PUBLISHED-only browse view and admin's see-everything view; there was no "my own events" endpoint until the frontend needed one

**App registration changes needed for browser-based login** (separate from the device-code setup used for the earlier CLI-driven token tests — a browser SPA needs its own platform config):
- Added a "Single-page application" platform with redirect URIs: `https://chaotic-hell.eastasia.cloudapp.azure.com/events/` (production) and `http://localhost:5173/` (local dev)
- `instance.loginPopup(...)` **does not work** in the sandboxed browser environment used to test this (`BrowserAuthError: popup_window_error` — likely a `window.open()` restriction in that specific sandbox). Switched to `instance.loginRedirect(...)`/`logoutRedirect(...)`, which is also just more robust in general (no popup-blocker dependency) — confirmed working end-to-end afterward with a real login as `u6642062@au.edu`

**Bug found via real browser click-testing** (not just curl): changing your own role away from Admin in the Admin panel correctly updates the DB, but the panel's own subsequent data reload then fails (you're no longer authorized for `/admin/*`) — and since `AdminPanel.jsx`'s `loadAll()` had no `.catch()`, that failure was silent: the table just went stale with zero indication anything was wrong. Same missing-`.catch()` gap existed in `OrganizerPanel.jsx`'s venue/event loaders. Fixed: proper error messages on all of them. (Thar's role was manually restored to `ADMIN` afterward via direct DB update, since he'd locked himself out of the Admin panel testing this.)

**UI redesign, 2026-09-15** (the first version was plain forms and lists — "so basic"):
- Design system in `src/index.css`: CSS-variable tokens with automatic dark mode (`prefers-color-scheme`), Bricolage Grotesque headings + Inter body (Google Fonts, system-font fallback), ink-black primary buttons with one tangerine accent, semantic colors for booking statuses. Icons from `lucide-react` (the only new dependency). No CSS framework.
- Shared components in `src/components/ui.jsx` (native `<dialog>` modal + confirm dialog, toasts, status/role pills, capacity bar, date badge, segmented control, empty states); formatting helpers in `src/lib/format.js` (also tidies AU directory names like `"THAR LIN HTET -"` → `"Thar Lin Htet"`).
- Pages: split-screen sign-in; **Discover** (search, upcoming/all filter, event cards with the venue's Geoapify map (since replaced by a Directions link and the organizer's cover image — see below), capacity bar, and the student's own booking state on each card); **My bookings** as ticket cards (upcoming/past/cancelled, one-click "Book again"); **My events** dashboard (stats, status filter, create/edit/publish/cancel dialogs, attendee list, venue gallery); **Admin** (stats, people/events/bookings tables, API-key issuing with copy + example request). All `window.confirm` calls replaced with in-app dialogs.
- Features the old UI was missing: publishing a draft, editing an event, rebooking from My bookings.
- Backend support: `GET /events` (both views) and `/admin/events` now include `seats: { confirmed, waitlisted }` (one `groupBy` query, `withSeatCounts` in `src/services/bookings.js`) and are sorted by date; `/bookings/mine` includes the venue.
- Checked with headless-Chrome screenshots of every screen (mocked API + MSAL, preview files deleted afterward) at desktop width and at a true 390px phone width (via an iframe, since headless Chrome's minimum window is 500px) — no horizontal overflow on any screen.
- ~~⚠️ The Geoapify key is embedded in `staticMapUrl`, so it's visible to any logged-in user.~~ **Resolved 2026-09-16** — static map URLs are gone entirely (see below), so the key never reaches the browser.

**Venue locations: pin on a map, 2026-09-16.** Thar reported the maps "not showing correctly" and being useless because nothing could be clicked. Both complaints were real, and the cause was geocoding, not the map image:
- Typed addresses were geocoded blind. `"assumption university"` resolved to **Assumption University in Worcester, Massachusetts** (venue "Sala Thai" was pointing at the USA), and `"Assumption University, Bang Na, Samut Prakan"` matched no campus, so it fell back to the Samut Prakan province centroid ~30 km away ("AU Grand Hall"). Both rows were corrected in the DB to the real campus (13.6138, 100.8338).
- **Google Maps was considered and rejected**: every Google Maps key requires a Google Cloud billing account with a card, which is the same reason Mapbox was dropped in the first place. Leaflet + OpenStreetMap needs neither.
- **The pin is now required.** `POST /venues` takes `latitude`/`longitude` (validated ranges) instead of geocoding text; Geoapify *reverse* geocodes the pin into an address, which doubles as validation. Organizers can still type their own address label (e.g. "AU Grand Hall, Building D"); if they leave it empty the pin's address is stored.
- New `GET /venues/geocode?q=` (Organizer/Admin) powers type-ahead in the picker — searches are filtered to `countrycode:th` and biased toward the campus, which is what fixes the Massachusetts result.
- `frontend-ui/src/components/VenueMap.jsx` is both the picker (click/drag the pin, search to jump) and the read-only map on venue cards. Event cards and booking tickets now carry a "Directions" link that opens Google Maps at the venue's coordinates — no key needed for a plain maps link.
- Migration `20260916010000_drop_static_map_url` drops `venues.static_map_url`; `src/services/geoapify.js` no longer builds static map URLs, so the API key is no longer exposed anywhere.
- **Two bugs found by the live tests while building this** (both fixed): reverse geocoding a pin in the open sea returns `{ formatted: "Earth" }` rather than nothing, so "is this a real place?" now checks for a `country`; and it labels a pin with the *nearest landmark*, which put "Museum, …" on a campus pin 95 m away — that prefix is dropped when the landmark is more than 50 m from the pin.
- Verified live: API suite **139/139** (including pin validation and the Thailand-biased search), UI suite **138/138** in Chrome (dropping a pin, searching, the venue-card map, directions links, and a check that the string "geoapify" appears nowhere in the page), live site **12/12**.

**Event cover images, 2026-09-17.** Thar pointed at the empty panel behind the date badge on
the student's event card and asked for a picture to upload there. The organizer picks one in
the event form (drag-and-drop or a file picker); it shows on the event card, the booking
ticket and their own event list.
- **Stored in the database** (`event_images`, `LONGBLOB`, migration `20260917090000_event_cover_image`), not on the VM's disk: redeploys, container rebuilds and DB restores all keep the posters, and there's no filesystem to keep writable. Its own table, so listing events never reads the bytes — event queries pull `image: { select: { key: true } }` only.
- **The browser resizes first** (`frontend-ui/src/lib/image.js`): canvas downscale to ≤1600×1200, re-encode as JPEG at falling quality until it's under ~900 KB (a transparent PNG is flattened onto white first, or JPEG would render it black). A 4 MB phone photo lands at roughly 150 KB. The server caps what it will accept at 2 MB → `413`.
- **No multipart, no new dependency**: the raw file *is* the request body (`express.raw`, `Content-Type: image/jpeg`), and the frontend posts the Blob straight from the canvas.
- **The bytes decide the type, not the header** — a `Content-Type: image/jpeg` on a PHP script is rejected by a magic-number check (`src/services/eventImages.js`), because whatever is stored is served back under an image type later.
- **`GET /events/api/events/:id/image/:key` is the one endpoint with no token** — an `<img>` tag can't send an `Authorization` header. A random 96-bit `key`, minted fresh on every upload, stands in for one: the URL is unguessable (so a draft's poster isn't public), and it changes when the image does, which makes `Cache-Control: immutable` safe. It also sets `Cross-Origin-Resource-Policy: cross-origin`, overriding helmet's global `same-origin` — otherwise the image is blocked whenever the API isn't the page's own origin (`npm run dev`, the e2e build).
- **Two real bugs, both found only by running it for real** (neither is visible with mocks): Prisma 6 returns `Bytes` as a `Uint8Array`, so `res.send()` JSON-encoded the image into an array of numbers and served it as `image/png` — 527 bytes instead of 69; and the CORP header above. The offline test now mocks `bytes` as a `Uint8Array` for exactly this reason.
- Verified on a throwaway MySQL in Docker rather than production: **32/32** image API checks (`tests/e2e/image-test.mjs`), **16/16** in Chrome (`tests/e2e/image-ui-test.mjs` — a real 1200×675 file picked in the form, resized by the browser, uploaded, and rendering on the student's card), **164/166** api-test and **148/149** ui-test with no new failures (the 3 that fail are the Discord posts, deliberately disabled locally), and 164 offline tests.

**Lazy-loaded panels, 2026-09-18.** Everyone downloaded one 741 KB bundle (214 KB gzipped), including the organizer page, the admin page and Leaflet, which students never use.
- `OrganizerPanel` (178 KB, with Leaflet and the image tools) and `AdminPanel` (13 KB) load on demand (`src/lib/lazyPanel.jsx`). For organizers/admins they're fetched in the background as soon as `/me` returns the role, and a page whose code has arrived renders directly — React.lazy alone flashes its fallback for a frame even then, which also broke UI tests that looked right after switching tabs. Whether to use the fallback is decided once per mount, so a page is never remounted (losing an open dialog) when its code lands.
- `directionsUrl` moved to `src/lib/maps.js`: importing it from `VenueMap.jsx` had pulled Leaflet into the main bundle for Discover and My bookings.
- React and MSAL are their own chunks (`build.rolldownOptions.output.codeSplitting` in `vite.config.js`), because every deploy renames the app's files: a returning visitor re-downloads ~30 KB instead of 161 KB. Now: app 84 KB (30 KB gz), React 219 KB, MSAL 249 KB; no chunk-size warning.
- **A tab left open across a deploy** asks for files the new release doesn't have. `main.jsx` handles `vite:preloadError` by reloading once (session survives — it's in `sessionStorage`); if that happened in the last 10s it lets the error through to `PanelBoundary`, which says "Campus Events was just updated" with a Reload button (or "This page ran into a problem" for any other crash — there was no error boundary at all before, so a render error was a blank screen).
- The e2e build (`tests/e2e/serve-frontend.mjs`) now uses the project's own `vite.config.js`, so it chunks exactly like production.
- Tested: `tests/e2e/stale-release-test.mjs` builds two real releases and serves them from disk, holds the tab's background request until the second build has deleted the file, then lets it through (**13/13**: one reload onto the new release, still signed in; when the new code can't be fetched either, the message instead of a reload loop, and the button recovers) — with the reload handler disabled, 3 checks fail. Full UI suite **152/152** (165 map tiles, all real), cover-image UI **16/16**. The cover-image UI test was also fixed to act on its own event: it had been clicking the first "Edit" on the page and checking images before they loaded, and its cleanup didn't delete supply orders, so its event deletion failed silently.

**Shared-computer sign-in, 2026-09-16** (the teacher's concern: lab machines are shared, and
one student must not end up using another's account):
- MSAL cache stays `sessionStorage` **on purpose** — the session dies with the tab/browser. `localStorage` would share it across tabs and survive a browser restart; convenient, wrong here.
- `loginRequest.prompt = "select_account"`, because Microsoft's own cookie would otherwise sign the next student straight in as the previous one. (`"login"` would force the password every time — not enabled, ask first.)
- **New tabs don't ask you to sign in again** (the teacher's actual requirement, 2026-09-16): a starting tab asks any open tab for the session over a `BroadcastChannel` and copies it into its own `sessionStorage` (`src/lib/sessionHandoff.js`, called before MSAL initialises in `main.jsx`). Nothing is written to disk, so once every tab is closed — or the browser is — the session is gone and you sign in again. ⚠️ Browsers give tabs and windows the same storage and cookies, so "new window must sign in again" is **not achievable**; a new window behaves like a new tab while another tab is open. Verified in Chrome: `tests/e2e/tabs-test.mjs`, 5/5.
- Idle sign-out: `src/lib/useIdleTimeout.js` + a warning dialog in `App.jsx`. 15 minutes of no activity → `logoutRedirect()`, which also ends the Microsoft session. Mouse/keyboard activity pushes the deadline back, but once the warning shows only "Stay signed in" does — a passing mouse shouldn't keep a session alive. `VITE_IDLE_MINUTES` shortens it for tests (`tests/e2e/idle-test.mjs`, 5/5 passing).

**Verified working end-to-end in a real browser**: login → redirect through Microsoft
→ back to the app → `/me` resolves the correct role → role-appropriate tabs render →
Admin panel loads real (empty, post-cleanup) data correctly.

---

## 10. Course requirements checklist (teacher's written brief, pasted 2026-09-16)

The teacher's "Core Requirements to hit Course Objectives", and where this project stands:

| # | Requirement (short) | Status |
|---|---|---|
| 1 | Hardened Linux VPS | ✅ Azure `bad-vps-01`: key-only SSH, ufw, unattended-upgrades, fail2ban (§3) |
| 2 | Nginx reverse proxy + Let's Encrypt, own URL path, `/content` and `/api` unbroken | ✅ `/events` (§3) |
| 3 | Node.js (Express) or Go REST API | ✅ Express |
| 4 | MySQL/PostgreSQL via Prisma with migrations | ✅ MySQL, 6 migrations in `prisma/migrations` |
| 5 | JWT auth + RBAC, University Microsoft AD via MSAL/OAuth2/OIDC | ✅ Entra ID (AU tenant) issues RS256 JWTs; `src/middleware/auth.js` verifies them against Microsoft's public keys; roles ADMIN/ORGANIZER/STUDENT (§4) |
| 6 | No production secrets in `.env`; fetch them from the **Class** Azure Key Vault ("credentials will be provided") | ⚠️ Secrets are fetched at runtime from Key Vault, but **our own** vault (`campus-event-api-kv`, §4) — class credentials were never provided. There is no JWT secret to store, because Microsoft signs the tokens and the app only verifies them. |
| 7 | At least one external public API / AI service | ✅ Geoapify (§9) |
| 8 | Peer API with a classmate team: expose an `x-api-key` endpoint **and** consume theirs | ⚠️ Expose ✅ (room-status API, §5). Consume is the **Discord webhook**, not a classmate's API — on a verbal instruction from the teacher (2026-09-10, §5), which contradicts this written rule. |
| 9 | Code in a GitHub repository | ❌ Not yet: commits are local only, no remote (§11). CI is ready and runs on the first push |
| 10 | Automated deployment script or Docker Compose | ✅ Both: `deploy.sh` for production (release-based, with rollback), `docker-compose.yml` for local (§3) |

**Decided 2026-09-16 — don't reopen without Thar:** the two ⚠️ rows were raised as risks (switch to the
class vault if credentials arrive; get the Discord substitution confirmed in writing, or pair with a team
to consume a real peer API). Thar's answer was **"forget these two"**, so neither is being pursued.

---

## 11. Still to do (as of 2026-09-18)

- **GitHub** (requirement 9). Needs from Thar: a repo name, private or public, and Honey's and Mi Hsu's GitHub usernames to add as collaborators. The plan is for each teammate to push their own genuine remaining work from their own laptop, not to rewrite history to fake authorship.
- ~~README.md~~ — added 2026-09-18.
- **CI hasn't run on GitHub yet** — there's no remote. Every job's steps were run in Linux containers instead (§3), and actionlint passes, but check the first run's result after pushing.
- **Signing in from `npm run dev`**: `authConfig.js` sends `http://localhost:5173/events/` as the redirect address, while §9 records only `http://localhost:5173/` as registered on the Entra app. Microsoft only checks that after a real sign-in, so it's unverified — if local sign-in fails with AADSTS50011, add the `/events/` address to the app registration.
- **`docs/proposal.md` is out of date** in several places: Mapbox/static map links (now a pin on a map), a fixed 50 lanyards (now organizer-chosen), the Merch team's peer API (now Discord), a JWT signing secret and peer API keys stored in Key Vault (neither exists). It's the submitted document, so decide whether to amend it or explain the changes in the report.
- **Report / demo**: write-up, deployment diagram if asked for, a demo script and a rehearsal.
- **Thar, by hand**: delete the `[E2E]` test messages in the Discord channel (Claude doesn't delete messages), and restrict the Geoapify key to this site in the Geoapify dashboard.
- **Honey's role** — see §4: currently `STUDENT`.
- Known gaps, not planned: a venue can't be edited after creation; an event's venue and supply order can't be changed after creation; the Admin Activity tab shows the latest 100 entries with no "load more". (The ~740 KB bundle was split on 2026-09-18 — §9.)
