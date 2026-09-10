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
- Venue address is validated and a static map is generated via Geoapify
- A **large conference** event automatically triggers a Discord webhook notification
  requesting 50 blank university lanyards be prepped (see §5 — originally this called a
  classmate team's API; amended 2026-09-10 to a genuine public API instead)

---

## 2. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node.js + Express | Reusing the proven pattern from the weekly lab series (`backend-crud-api`) rather than the Go alternative |
| Database | Relational (MySQL/PostgreSQL) via **Prisma ORM** | Migrations required. **Pin `prisma@6` + `@prisma/client@6` explicitly** — v7 breaks the `new PrismaClient()` instantiation pattern used throughout the lab series |
| Auth | JWT + RBAC, backed by **Microsoft Entra ID (AD)** via MSAL / OAuth2 / OIDC | Self-provisioned tenant (see §4) |
| Secrets | **Azure Key Vault**, fetched at runtime | No `.env` secrets in production — `.env` only holds non-secret bootstrap config (tenant ID, client ID, vault URL) |
| External API | **Geoapify** (venue address validation + static map links) | Switched from Mapbox → Geoapify for a zero-cost, no-card-required free tier |
| External API (consume) | Discord webhook | Replaced a classmate-team peer API per 2026-09-10 amendment — see §5 |
| Exposed endpoint | REST, `x-api-key` header auth | Generic, not tied to a specific consumer team — see §5 |
| Hosting | Same VPS as the existing lab/WordPress stack | New URL path, must not break existing routes (see §3) |
| Source control | GitHub | Automated deploy via script or Docker Compose |
| Frontend | React + Vite, `@azure/msal-react` for real login | Added 2026-09-10, matches the lab's own frontend pattern — see §9 |

---

## 3. Deployment Target (shared VPS)

This app deploys **alongside existing infrastructure on the same VPS** — it does not get its own box.

- VM: `bad-vps-01` @ `chaotic-hell.eastasia.cloudapp.azure.com`
- SSH: `ssh -i ~/.ssh/bad-vps-01_key.pem azureuser@chaotic-hell.eastasia.cloudapp.azure.com` (confirmed working)
- System Node on the VM is **v18.19.1** (not v20) — this app's `package.json` targets `>=18.18.0` to match, rather than requiring an nvm install alongside the system Node used by `crud-api`
- Existing routes that **must not break**:
  - `/content` → WordPress (proxied to `127.0.0.1:8080`)
  - `/api` → existing lab CRUD API (`backend-crud-api`, run under PM2 as `crud-api`, on `127.0.0.1:3000`)
- **This app's path: `/events`**, proxied to `127.0.0.1:3001` (matches the scaffold's default `PORT`) — single Nginx site `azure-proxy` at `/etc/nginx/sites-available/azure-proxy`, single Certbot cert covering the whole domain (expires 2026-09-22, auto-renewed)
- Nginx `/events` block is **deployed and live** (config tested + reloaded 2026-09-09; pre-change config backed up on the VM as `azure-proxy.bak.20260909072045`).
- ✅ **App deployed 2026-09-09**, running under PM2 as `campus-event-api` on port 3001, alongside `crud-api`. Deployed via `deploy.sh` (root of this repo) — matches the taught pattern (scp source, `npm install` natively on the VM, `prisma generate` + `prisma migrate deploy`, `pm2 restart`/`start`, `pm2 save`). `GET /events/api/venues` through Nginx correctly returns `401 Missing bearer token` (full chain verified: Nginx → app → route → auth middleware). `/content` and `/api` unaffected (regression-checked).
  - Non-secret bootstrap config lives in `~/campus-event-api/.env` **on the VM only** (copied from `.env.example`, never committed) — `PORT`, `TENANT_ID`, `CLIENT_ID`, `KEY_VAULT_URL`.
  - `deploy.sh` fetches `DATABASE_URL` from Key Vault locally (already authenticated to KMUTT's subscription) and passes it only to the remote `prisma migrate deploy` step — never written to `.env` or disk on the VM, since `migrate deploy` is a standalone CLI command that doesn't go through the app's own Key-Vault bootstrap.
  - **Three real bugs found and fixed across deployment** (all committed):
    1. `globalThis.crypto` is `undefined` when Node 18.19.1 runs a file directly (`node src/server.js`) but present when run via `node -e` — a genuine Node 18.x quirk, confirmed by direct testing on the VM, not a config mistake. `@azure/identity`'s HTTP pipeline needs `globalThis.crypto.randomUUID()` and crashed on every boot. Fixed with a `node:crypto` `webcrypto` polyfill as the very first lines of `src/server.js`.
    2. `src/config/keyvault.js`'s `loadSecrets()` used a single `Promise.all` over all secret names, so a missing *optional* secret made the **entire app** fail to boot, not just the features that need it. Fixed: required secrets throw if missing, optional ones are fetched independently and just log a warning + stay unset if missing.
    3. **Found 2026-09-10, more serious than it looked**: `src/server.js` required `./app` (which transitively requires `services/prisma.js`, constructing `new PrismaClient()`) *before* calling `loadSecrets()`. Confirmed directly by testing: Prisma reads and **caches** `DATABASE_URL` at construction time, not per-query — so a client built before the env var is set fails on every later query with "Environment variable not found: DATABASE_URL", even after the var gets set. This meant **every DB query in the deployed app was broken** the whole time, just never triggered because no request had gotten past auth into an actual query yet. Fixed by deferring `require("./app")` until after `await loadSecrets()` inside `bootstrapServer()` — matches the taught pattern (Week 9's lab constructs `PrismaClient` inside `bootstrapServer()`, after the secret fetch, not as a top-level import). Verified end-to-end afterward with a real Prisma query and the full `preorderLanyards` flow (see §5) — both succeeded.
- ~~Unrelated pre-existing issue noticed during deploy: `/content` (WordPress) was returning 502~~ — **fixed 2026-09-09**. Root cause: WordPress runs via Apache + PHP (not Docker — no Docker is installed on this VM) from `/srv/www/wordpress`, listening on `:8080` per `/etc/apache2/ports.conf`. The VM rebooted at 07:12:59 UTC and `apache2.service` was not enabled for boot, so it stayed down. Fixed with `sudo systemctl enable --now apache2`; verified `/content` now returns 200 (after its normal redirect). MySQL (the WP DB) was unaffected throughout.

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
  - **Not yet done**: no client secret (still not needed — JWT/JWKS validation, no confidential-client flow yet); no redirect URI (no frontend exists yet)
- ✅ **Role assignment 2026-09-09**: `u6642062@au.edu` → **all three** app roles (`Admin`, `Organizer`, `Student`) on the AU-tenant `campus-event-api`. `src/middleware/auth.js`'s role-priority resolution (`ADMIN` > `ORGANIZER` > `STUDENT`) means this account resolves to `ADMIN` in practice. `u6726113@au.edu` (Honey Linn) is presumably also in AU's tenant and could be assigned roles the same way — not yet done.
- **Key Vault stays on KMUTT** (§ above) — that's purely about who's paying for the VM/vault compute, and is unrelated to the auth tenant. No change needed there; `khinezar.chi1@kmutt.ac.th`'s Key Vault Secrets Officer role and the VM's managed identity are unaffected by the auth tenant switch.
- ⚠️ **Also briefly attempted, then reverted**: switched auth to the labs' homegrown pattern (bcrypt + self-issued JWT + custom `users` table) to match what's actually *taught*, before realizing the submitted proposal explicitly commits to Entra ID/OIDC — reverted before committing. The proposal is authoritative over what the labs teach; see the note at the top of this file.
- `src/middleware/auth.js`'s `requireAuth` upserts a local `User` row on first sign-in, keyed by the token's `oid` claim (`adObjectId`). Role is set from the token's `roles` claim **only at creation** — an existing user's role is never overwritten on later logins, since Admins manage roles through `/events/api/admin/users/:id/role` and Entra App Role assignment shouldn't silently clobber that.

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
- Purpose unchanged: auto-notify that 50 blank lanyards are needed when a large-conference event is created — `src/services/merch.js` (filename kept — same business feature, different fulfillment mechanism; `MerchPreorder` DB model also kept as-is, just repurposed)
- **Chosen because**: free, no signup friction beyond what most students already have (a Discord account/server), and — unlike a pure lookup API (e.g. Geoapify) — a webhook POST is a genuine *action* with a trackable response, structurally analogous to what "placing an order" was supposed to demonstrate
- Mechanics: `POST {DISCORD_WEBHOOK_URL}?wait=true` with `{content: "..."}` — `?wait=true` makes Discord return the created message object (with its `id`) instead of a bare 204, so we have something real to store
- Auth: the webhook URL itself functions as the credential (anyone with it can post) — stored in Key Vault as `discord-webhook-url`. **Obtained and wired up 2026-09-10** (a new "CSX4110 Project" Discord server + channel, incoming webhook added). Verified end-to-end: created a throwaway large-conference test event directly against the deployed app, called `preorderLanyards()`, got back `status: "CONFIRMED"` with a real Discord message id as `peerOrderRef`, then cleaned up the test data.
- Result recorded in the `MerchPreorder` table (`PENDING`→`CONFIRMED`/`FAILED`), `peerOrderRef` now holds the Discord message id instead of a Merch order ref

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
- [x] Assign test users to the app roles on `campus-event-api` (§4) → `u6642062@au.edu` (Thar Lin Htet) has all three roles (`Admin`/`Organizer`/`Student`). `u6726113@au.edu` (Honey Linn) **deliberately not assigned yet** — decided to hold off until she's actually working against the API or a multi-user demo is needed; not blocked on anything technical.
- [x] **MySQL provisioned 2026-09-09**, following the lab's pattern (MySQL running directly on `bad-vps-01`, same server as WordPress's and `crud-api`'s databases — not a separate managed Azure DB service):
  - Database `campus_events`, dedicated user `campus_events_user`@`localhost` (bound to localhost only — the app runs on the same VM, no need for `api_user`-style `%` remote access)
  - Initial migration generated + applied: `prisma/migrations/20260909084726_init/` (all 6 tables — `users`, `venues`, `events`, `bookings`, `merch_preorders`, `api_keys` — confirmed present via `SHOW TABLES`)
  - Generated on the VM itself via a throwaway bootstrap (`package.json` + `prisma/schema.prisma` copied over, `npm install`, `npx prisma migrate dev`, migration copied back into the repo, bootstrap dir deleted) — avoided opening MySQL port 3306 publicly (unlike the Week 4 lab's local-dev pattern), since the app doesn't need remote DB access in this Zero-Trust design
  - Needed a temporary, narrowly-scoped grant (`` `prisma_migrate_shadow_db_%`.* ``) for `migrate dev`'s shadow database, **revoked immediately after** — `campus_events_user` now only has privileges on `campus_events` itself
  - `database-url` Key Vault secret populated: `mysql://campus_events_user:<password>@127.0.0.1:3306/campus_events`
- [x] Populate the `database-url` Key Vault secret — done above. `geoapify-api-key` and `merch-peer-api-key` still not populated (real values don't exist yet — see next two items)
- [x] HelpDesk vs. "Ticketing" naming mismatch → **moot**, dropped 2026-09-10 — the exposed endpoint is no longer scoped to any specific team (§5)
- [x] **Full flow tested end-to-end with a real Entra token, 2026-09-10** — see the new subsection at the end of §4. Found and fixed 5 more real bugs beyond the ones already listed here (a critical v1.0-vs-v2.0 token mismatch that would have blocked every real login, a Prisma column-length error, a systemic Express-4 async-error-hanging issue across every route, a falsy-value validation bug, and an unhandled duplicate-booking error). This is the first time the actual HTTP request → auth → business logic → DB path was exercised for real, rather than in pieces.
- [ ] Whether "Admin" is a real day-to-day role for this project or just used for the demo/grading — nobody holds it yet

---

## 9. Frontend (`frontend-ui/`) — added 2026-09-10

React + Vite, matching the lab's own frontend pattern (`npm create vite@latest ... --
template react`, built and served by Express — see §7) rather than a separate hosting
setup. Live at `https://chaotic-hell.eastasia.cloudapp.azure.com/events/`.

- **Real Microsoft login**, not a mock — `@azure/msal-browser` + `@azure/msal-react`, `loginRedirect`/`logoutRedirect` (see below for why not `loginPopup`)
- `vite.config.js` sets `base: '/events/'` — required since the build is served from under that path, not domain root
- `src/app.js` serves `frontend-ui/dist` as static files, mounted **after** all `/events/api/*` routes so the API is never shadowed by the frontend catch-all
- `deploy.sh` now builds the frontend (`npm run build` in `frontend-ui/`) as its first step and ships `dist/` alongside the backend — `dist/` itself is gitignored (lab convention: built fresh at deploy time, not committed)
- Added `cors` middleware (`app.use(cors())`, no origin restriction) so `npm run dev` on `localhost:5173` can call the deployed API directly — `frontend-ui/.env.development` points local dev at the live backend, since there's no separate local backend+DB to run against
- Added `GET /events/api/me` (`src/routes/me.js`) so the frontend can learn the logged-in user's **DB-authoritative** role (not the token's `roles` claim, which isn't updated after Admin-managed role changes — see §4) — `req.user` in `requireAuth` now also carries `email`/`displayName` from the DB row, not raw token claims
- Added `GET /events/api/events?mine=true` (in `src/routes/events.js`) so an Organizer can see their own events including drafts — the original proposal only specified the public PUBLISHED-only browse view and admin's see-everything view; there was no "my own events" endpoint until the frontend needed one

**App registration changes needed for browser-based login** (separate from the device-code setup used for the earlier CLI-driven token tests — a browser SPA needs its own platform config):
- Added a "Single-page application" platform with redirect URIs: `https://chaotic-hell.eastasia.cloudapp.azure.com/events/` (production) and `http://localhost:5173/` (local dev)
- `instance.loginPopup(...)` **does not work** in the sandboxed browser environment used to test this (`BrowserAuthError: popup_window_error` — likely a `window.open()` restriction in that specific sandbox). Switched to `instance.loginRedirect(...)`/`logoutRedirect(...)`, which is also just more robust in general (no popup-blocker dependency) — confirmed working end-to-end afterward with a real login as `u6642062@au.edu`

**Bug found via real browser click-testing** (not just curl): changing your own role away from Admin in the Admin panel correctly updates the DB, but the panel's own subsequent data reload then fails (you're no longer authorized for `/admin/*`) — and since `AdminPanel.jsx`'s `loadAll()` had no `.catch()`, that failure was silent: the table just went stale with zero indication anything was wrong. Same missing-`.catch()` gap existed in `OrganizerPanel.jsx`'s venue/event loaders. Fixed: proper error messages on all of them. (Thar's role was manually restored to `ADMIN` afterward via direct DB update, since he'd locked himself out of the Admin panel testing this.)

**Verified working end-to-end in a real browser**: login → redirect through Microsoft
→ back to the app → `/me` resolves the correct role → role-appropriate tabs render →
Admin panel loads real (empty, post-cleanup) data correctly.
