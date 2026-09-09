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
- ❌ **Separate Entra tenant: not possible on the KMUTT "Azure for Students" subscription.** Attempted via the portal's "Create a tenant" wizard — the subscription picker returns zero eligible subscriptions (Microsoft's known restriction on free/promotional subscription offers). No tenant was created.
- ⚠️ **First attempt (2026-09-09, superseded — see below): registered the app in KMUTT's tenant.** Reasoning at the time: real users log in via *actual* university AD, and KMUTT was the tenant already being used for Azure provisioning, so registering there (rather than a fresh empty tenant) seemed to satisfy "logs in via university AD." **This was wrong** — the real target users are **AU** students/organizers (this project's own team + classmates), not KMUTT ones. KMUTT was only ever being used because the KMUTT account had Azure subscription credit; auth has nothing to do with which subscription pays for hosting. The KMUTT app registration (Client ID `6426aa53-...`) has been **deleted** (2026-09-09) once this was caught.
- ✅ **App registered 2026-09-09 in AU's own tenant instead** (`c1f3dc23-b7f8-48d3-9b5d-2b12f158f01f`, "Assumption University"), signed in as `u6642062@au.edu` (Thar Lin Htet). AU's tenant has no Azure *subscription* attached (`az login` needs `--allow-no-subscriptions`) — but app registration doesn't need one; it's a free Entra ID operation, unrelated to subscription billing. This is the actual fix for "AU students should log in, not KMUTT":
  - Display name: `campus-event-api`, Client ID (App ID): `f581260c-6bc3-4f8c-a711-ac2ca274f56b`
  - Sign-in audience: `AzureADMyOrg` (AU accounts only)
  - Identifier URI: `api://f581260c-6bc3-4f8c-a711-ac2ca274f56b`
  - Same 3 app roles as before: `Organizer` (`ORGANIZER`), `Student` (`STUDENT`), `Admin` (`ADMIN`) — matches the Prisma `Role` enum
  - Service principal (enterprise app) created so it's sign-in-able
  - `TENANT_ID`/`CLIENT_ID` updated in `.env.example` to the AU values
  - **Not yet done**: no client secret (still not needed — JWT/JWKS validation, no confidential-client flow yet); no redirect URI (no frontend exists yet)
- ✅ **Role assignment 2026-09-09**: `u6642062@au.edu` → **all three** app roles (`Admin`, `Organizer`, `Student`) on the AU-tenant `campus-event-api`. `src/middleware/auth.js`'s role-priority resolution (`ADMIN` > `ORGANIZER` > `STUDENT`) means this account resolves to `ADMIN` in practice. `u6726113@au.edu` (Honey Linn) is presumably also in AU's tenant and could be assigned roles the same way — not yet done.
- **Key Vault stays on KMUTT** (§ above) — that's purely about who's paying for the VM/vault compute, and is unrelated to the auth tenant. No change needed there; `khinezar.chi1@kmutt.ac.th`'s Key Vault Secrets Officer role and the VM's managed identity are unaffected by the auth tenant switch.
- ⚠️ **Also briefly attempted, then reverted**: switched auth to the labs' homegrown pattern (bcrypt + self-issued JWT + custom `users` table) to match what's actually *taught*, before realizing the submitted proposal explicitly commits to Entra ID/OIDC — reverted before committing. The proposal is authoritative over what the labs teach; see the note at the top of this file.
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
- [x] Whether the capstone-specific Entra tenant + Key Vault have been provisioned yet → Key Vault: yes, on KMUTT (§4, hosting-only). Auth app registration: in **AU's own tenant** (§4) — first tried KMUTT, corrected 2026-09-09 since the real users are AU students. A wholly separate new tenant (neither KMUTT nor AU) remains infeasible on the KMUTT subscription.
- [ ] Geoapify API key — obtained or not (code is ready in `src/services/geoapify.js`, reads `GEOAPIFY_API_KEY`)
- [ ] Merch team's peer order-creation endpoint — final request/response shape, and `MERCH_API_URL` (code is ready in `src/services/merch.js`)
- [x] Repo scaffold — done, see `src/`, `prisma/schema.prisma`, `Dockerfile`
- [x] Assign test users to the app roles on `campus-event-api` (§4) → `u6642062@au.edu` (Thar Lin Htet) has all three roles (`Admin`/`Organizer`/`Student`). `u6726113@au.edu` (Honey Linn) not yet assigned — should be straightforward now since she's presumably already in AU's tenant too, no guest invite needed (that was only a concern under the old, now-abandoned KMUTT-tenant plan).
- [ ] Populate the Key Vault secrets (`database-url`, `geoapify-api-key`, `merch-peer-api-key` — see §4) — none of the underlying values exist yet (no DB provisioned)
- [ ] No MySQL database actually provisioned yet — schema is written and validated (`prisma validate`/`generate` pass) but never run against a real `DATABASE_URL`, so it's unverified against an actual server
- [ ] HelpDesk vs. "Ticketing" naming mismatch between the old draft and the submitted proposal (§5) — not confirmed which is correct / whether they're the same team
- [ ] Whether "Admin" is a real day-to-day role for this project or just used for the demo/grading — nobody holds it yet
