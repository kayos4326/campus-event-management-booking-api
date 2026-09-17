# Live end-to-end tests

These tests run against the **real deployed code and the real MySQL database** on
`bad-vps-01`. The unit and integration tests in `tests/unit` and `tests/integration`
mock everything instead. The last full run was on 2026-09-15; results are in `CLAUDE.md` §8.

| Script | What it does |
|---|---|
| `server.cjs` | Runs the real Express app (routes, validation, Prisma transactions, MySQL). Only the Entra token check is replaced: the bearer token is a test user's `adObjectId`. |
| `db.cjs` | `setup` creates the `e2e-…` test users. `inspect` checks booking invariants on every test event. `cleanup` deletes all test data. |
| `api-test.mjs` | About 150 HTTP checks covering auth, validation, visibility, a 10-round **booking race**, duplicate storms, waitlist promotion order, capacity changes, cascade cancel, attendees, admin, the room-status API and the Discord trigger. |
| `image-test.mjs` | 32 checks on event cover images: upload, the bytes surviving the round trip through `LONGBLOB`, serving without a token, the unguessable key, rejecting a non-image, the 2 MB cap, who may upload, and the image being deleted with its event. |
| `image-ui-test.mjs` | Drives Chrome through picking a cover image in the event form and checks it renders — in the form, the organizer's list, the student's event card and their booking ticket. |
| `serve-frontend.mjs` | Builds the real frontend with MSAL swapped for `msal-react-mock.js` and serves it at `127.0.0.1:4173/events/`. |
| `ui-test.mjs` | Drives the **Google Chrome app** in a visible window through every screen as Student, Organizer and Admin. It also checks 390/768px layouts and dark mode, and saves screenshots to `ui-shots/`. |
| `prod-login-check.mjs` | Opens the live site with real MSAL, clicks "Sign in with Microsoft", and checks the redirect: tenant, client id, redirect URI, scope and PKCE. It never types credentials. |

## Safety

- Only users whose `adObjectId` starts with `e2e-` can be used as a token, so real accounts can't be impersonated.
- The server binds to `127.0.0.1` on the VM only. Reach it through an SSH tunnel.
- All test data is tagged: `e2e-…` users, and `[E2E] …` events, venues and API keys. `db.cjs cleanup` deletes only tagged rows.
- `api-test.mjs` creates one large-conference event, which posts a **real message** to the team Discord channel.

## Running it

```bash
# 1. Copy the server-side scripts to the VM, create the test users, start the test server
scp -i ~/.ssh/bad-vps-01_key.pem tests/e2e/{server.cjs,db.cjs,api-test.mjs} azureuser@chaotic-hell.eastasia.cloudapp.azure.com:/tmp/e2e/
# RATE_LIMIT_* are raised because the suite makes far more writes in five minutes than a
# person would — production keeps the real limits (see src/middleware/security.js).
ssh -i ~/.ssh/bad-vps-01_key.pem azureuser@chaotic-hell.eastasia.cloudapp.azure.com \
  'cd /tmp/e2e && export APP_DIR=$HOME/campus-event-api && node db.cjs setup && (PORT=3998 RATE_LIMIT_WRITES=100000 RATE_LIMIT_REQUESTS=100000 nohup node server.cjs > server.log 2>&1 &)'

# 2. API + race tests, run on the VM itself so timing matches production
ssh -i ~/.ssh/bad-vps-01_key.pem azureuser@chaotic-hell.eastasia.cloudapp.azure.com \
  'cd /tmp/e2e && ROUNDS=10 node api-test.mjs && APP_DIR=$HOME/campus-event-api node db.cjs inspect'

# 3. UI tests: tunnel to the test server, serve the test build, drive Chrome
ssh -i ~/.ssh/bad-vps-01_key.pem -N -L 127.0.0.1:3998:127.0.0.1:3998 azureuser@chaotic-hell.eastasia.cloudapp.azure.com &
(cd tests/e2e && npm i --no-save puppeteer-core@24)
node tests/e2e/serve-frontend.mjs &
node tests/e2e/ui-test.mjs
node tests/e2e/prod-login-check.mjs

# 4. Clean up: delete test data, stop the test server, close the tunnel
ssh -i ~/.ssh/bad-vps-01_key.pem azureuser@chaotic-hell.eastasia.cloudapp.azure.com \
  'cd /tmp/e2e && APP_DIR=$HOME/campus-event-api node db.cjs cleanup; pkill -f "node server.cjs"; rm -rf /tmp/e2e'
```

## Running it all locally instead

Everything above also runs against a throwaway MySQL on your own machine, which is how the
cover-image work was tested without touching production — no SSH tunnel, no live data:

```bash
docker run -d --name campus-mysql -p 3307:3306 -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=campus_events -e MYSQL_USER=campus_events_user -e MYSQL_PASSWORD=localdev mysql:8
export DATABASE_URL='mysql://campus_events_user:localdev@127.0.0.1:3307/campus_events' APP_DIR=$PWD
npx prisma migrate deploy && node tests/e2e/db.cjs setup
PORT=3998 RATE_LIMIT_WRITES=100000 RATE_LIMIT_REQUESTS=100000 node tests/e2e/server.cjs &
node tests/e2e/image-test.mjs
```

Venue creation calls Geoapify for real, so `api-test.mjs` and `ui-test.mjs` need
`GEOAPIFY_API_KEY` on the server (`az keyvault secret show --vault-name campus-event-api-kv
--name geoapify-api-key --query value -o tsv`). Leave `DISCORD_WEBHOOK_URL` unset and the two
supply-order checks fail on purpose — that's the price of not posting test messages into the
team's real channel.

To reproduce the **pre-fix race condition**, point `APP_DIR` at a copy of the code from commit
`01b4dcc` and run `ONLY=race node api-test.mjs` against it. On 2026-09-15, 12 simultaneous
bookings for a 1-seat event produced **12 confirmed seats**. The current code produced exactly
1 confirmed seat in every round.
