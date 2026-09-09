# CLAUDE.md — Campus Event Management & Booking API

Context file for AI assistants (Claude Code, etc.) working on this repo.
Course: **CSX4110 Backend Application Development**, Semester 1/2026.
This is "Option 3" of four class project options, in a mandatory peer-API ring
with three other student teams.

⚠️ **[docs/proposal.md](docs/proposal.md)** (and `docs/proposal.docx`) is the submitted,
teacher-facing proposal — it is **authoritative** over this file wherever they conflict.
This file is working notes; the proposal is the actual commitment. Group: Thar Lin Htet
(6642062), Honey Linn (6726113), Mi Hsu Myat Win Wyint (6726115).

---

## 1. Project Concept

A platform where university organizations create events and students book seats.

- **Organizer flow**: logs in via university Microsoft account → creates events (venue,
  schedule, capacity), can mark one as a large conference, manages only their own events
- **Student flow**: logs in via university Microsoft account → browses published events,
  RSVPs (or joins the waitlist once full), cancels their own bookings
- **Admin**: manages users/roles, issues/revokes peer API keys, sees all events/bookings
- Venue address is validated and a static map is generated via Geoapify
- A **large conference** event automatically triggers a call to the Merch team's API to
  pre-order 50 blank university lanyards

---

## 2. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node.js + Express | Reusing the proven pattern from the weekly lab series (`backend-crud-api`) rather than the Go alternative |
| Database | Relational (MySQL/PostgreSQL) via **Prisma ORM** | Migrations required. **Pin `prisma@6` + `@prisma/client@6` explicitly** — v7 breaks the `new PrismaClient()` instantiation pattern used throughout the lab series |
| Auth | JWT + RBAC, backed by **Microsoft Entra ID (AD)** via MSAL / OAuth2 / OIDC | Self-provisioned tenant (see §4) |
| Secrets | **Azure Key Vault**, fetched at runtime | No `.env` secrets in production — `.env` only holds non-secret bootstrap config (tenant ID, client ID, vault URL) |
| External API | **Geoapify** (venue address validation + static map links) | Switched from Mapbox → Geoapify for a zero-cost, no-card-required free tier |
| Peer integration | REST, `x-api-key` header auth | See §5 |
| Hosting | Same VPS as the existing lab/WordPress stack | New URL path, must not break existing routes (see §3) |
| Source control | GitHub | Automated deploy via script or Docker Compose |

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
- Nginx `/events` block is **deployed and live** (config tested + reloaded 2026-09-09; pre-change config backed up on the VM as `azure-proxy.bak.20260909072045`). Currently 502s since no app is deployed to port 3001 yet — that's expected until the Node process is running there (e.g. via PM2, matching `crud-api`'s pattern).
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
  - Secrets are **not yet populated** — `database-url`, `geoapify-api-key`, `merch-peer-api-key` (names expected by `src/config/keyvault.js`) don't exist yet; none of those values exist yet either. No `jwt-signing-key` secret — auth is Entra JWKS-validated, not self-issued JWTs, so there's no shared signing secret to store. The HelpDesk peer key is **not** a Key Vault secret either — see §5, it's issued through `/events/api/admin/api-keys` and stored hashed in the `ApiKey` table.
- ❌ **Separate Entra tenant: not possible on this subscription.** Attempted via the portal's "Create a tenant" wizard (Governed Workforce config, tenant name `campus-event-api`, domain `campuseventapi.onmicrosoft.com`, Thailand/Asia Pacific). The account (`khinezar.chi1@kmutt.ac.th`) does have tenant-creation rights in the parent KMUTT directory (the wizard itself is reachable), but **the "Azure for Students" subscription is not eligible to host a new tenant** — its subscription picker returns zero options even with an explicit advanced filter scoped to just that subscription. This matches Microsoft's known restriction on free/promotional subscription offers (fraud prevention), not a UI bug. No tenant was created; the wizard was closed without submitting.
- ✅ **App registered 2026-09-09** in the KMUTT tenant (distinct from the lab's `backend-api-identity`):
  - Display name: `campus-event-api`, Client ID (App ID): `6426aa53-6a89-4319-8393-af36cbd48712`
  - Sign-in audience: `AzureADMyOrg` (KMUTT accounts only, matching "logs in via university AD")
  - Identifier URI: `api://6426aa53-6a89-4319-8393-af36cbd48712`
  - App roles defined (drive the `roles` claim `src/middleware/auth.js` resolves into a single DB `role`): `Organizer` (`ORGANIZER`), `Student` (`STUDENT`), and `Admin` (`ADMIN`, added 2026-09-09 to match the proposal's 3-role model) — matches the Prisma `Role` enum
  - Service principal (enterprise app) created so it's sign-in-able
  - `TENANT_ID`/`CLIENT_ID` filled into `.env.example`
  - **Not yet done**: no client secret created (not needed for JWT/JWKS validation as currently implemented — only add one if the backend needs to act as a confidential client later); no redirect URI configured (no frontend exists yet in this repo)
- ✅ **Role assignment 2026-09-09**: `khinezar.chi1@kmutt.ac.th` → `Organizer` app role on `campus-event-api` (via Microsoft Graph `appRoleAssignments`, since this account is a KMUTT member). Note: the other two team accounts seen signed into the browser, `u6642062@au.edu` (Thar Lin Htet) and `u6726113@au.edu` (Honey Linn), are **AU accounts, not KMUTT** — since sign-in audience is `AzureADMyOrg` (KMUTT-only), neither can sign in or hold a role here unless first invited as a B2B guest into the KMUTT tenant. Not yet done. No one holds `Student` or `Admin` yet.
- ⚠️ **Briefly attempted, then reverted**: switched auth to the labs' homegrown pattern (bcrypt + self-issued JWT + custom `users` table) to match what's actually *taught*, before realizing the submitted proposal explicitly commits to Entra ID/OIDC — reverted before committing. The proposal is authoritative over what the labs teach; see the note at the top of this file.
- `src/middleware/auth.js`'s `requireAuth` upserts a local `User` row on first sign-in, keyed by the token's `oid` claim (`adObjectId`). Role is set from the token's `roles` claim **only at creation** — an existing user's role is never overwritten on later logins, since Admins manage roles through `/events/api/admin/users/:id/role` and Entra App Role assignment shouldn't silently clobber that.

---

## 5. Peer API Ring

Class-wide structure: **Ticketing → Events (this project) → Merch → EduCore → Ticketing**
(the formal 4-team ring). The team we actually expose an endpoint to runs a **HelpDesk**
ticketing system — the proposal names them "HelpDesk," not "Ticketing"; both terms may
refer to the same team, unconfirmed. Every team must both expose an endpoint and consume
a partner's endpoint, all secured with `x-api-key`.

### Consume (this app → Merch team, Option 1)
- Purpose: auto pre-order 50 blank university lanyards when a large-conference event is created — `src/services/merch.js`
- Auth: static `x-api-key` issued **by** the Merch team, stored in Key Vault as `merch-peer-api-key` (this is a key issued *to* us, so it belongs in the vault, unlike the key below)
- Request/response per the proposal's documented example: `POST {MERCH_API_URL}/orders`, `x-api-key: <merch-peer-api-key>`, body `{item: "lanyard", quantity: 50, reference: "<eventId>"}`. Result recorded in the `MerchPreorder` table (`PENDING`→`CONFIRMED`/`FAILED`).
- Status: Merch team originally only exposed `GET /api/products/available` (read-only, no ordering). They've **agreed to add a peer order-creation endpoint** to close this gap — exact contract, and `MERCH_API_URL`, not yet finalized on their side (§8).

### Expose (HelpDesk team, Option 2 → this app)
- Endpoint: `GET /events/api/peer/events/active?room=<number>` — `src/routes/peer.js` (path includes `/events` because Nginx's `/events` block forwards the full URI unchanged, same as the taught `/api` block — see §3)
- Auth: `x-api-key` issued **by this app**, generated via `POST /events/api/admin/api-keys` (Admin-only) and stored **hashed** (SHA-256) in the `ApiKey` table — not a static env var / Key Vault secret, per the proposal ("the key is stored as a hash in our database")
- Response shape per the proposal: `{active, eventId, title, endsAt}` when an event is currently running in that room (`startsAt <= now <= endsAt`), else `{active: false}`
- Consequence: `Venue` model needs a `room_number` column to support this query param
- Note: the old draft's "Ticketing" proposal also documented a ticket-creation endpoint intended for this Events system — **not needed**, since Merch is the consume partner, not this team

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
- [x] URL path for this app on `bad-vps-01` → `/events` (see §3) — Nginx block deployed and live (502 until the app itself is running on :3001)
- [x] Whether the capstone-specific Entra tenant + Key Vault have been provisioned yet → Key Vault: yes (§4). Separate tenant: dropped as unneeded/infeasible — app registered directly in the KMUTT tenant instead (§4)
- [ ] Geoapify API key — obtained or not (code is ready in `src/services/geoapify.js`, reads `GEOAPIFY_API_KEY`)
- [ ] Merch team's peer order-creation endpoint — final request/response shape, and `MERCH_API_URL` (code is ready in `src/services/merch.js`)
- [x] Repo scaffold — done, see `src/`, `prisma/schema.prisma`, `Dockerfile`
- [x] Assign test users to the app roles on `campus-event-api` (§4) → `khinezar.chi1@kmutt.ac.th` has `Organizer`. Nobody has `Student` or `Admin` yet. Whether/how to get the AU-account teammates (Thar Lin Htet, Honey Linn) into the KMUTT tenant as guests so they can hold roles too — not yet decided
- [ ] Populate the Key Vault secrets (`database-url`, `geoapify-api-key`, `merch-peer-api-key` — see §4) — none of the underlying values exist yet (no DB provisioned)
- [ ] No MySQL database actually provisioned yet — schema is written and validated (`prisma validate`/`generate` pass) but never run against a real `DATABASE_URL`, so it's unverified against an actual server
- [ ] HelpDesk vs. "Ticketing" naming mismatch between the old draft and the submitted proposal (§5) — not confirmed which is correct / whether they're the same team
- [ ] Whether "Admin" is a real day-to-day role for this project or just used for the demo/grading — nobody holds it yet
