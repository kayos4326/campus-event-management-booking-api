// Live-DB API + race tests. Talks HTTP to the e2e server (real app, real MySQL).
// ONLY=race runs just the race section (used against the pre-fix code for comparison).
const BASE = process.env.BASE || "http://127.0.0.1:3998";
const API = `${BASE}/events/api`;
const ONLY = process.env.ONLY;
const ROUNDS = Number(process.env.ROUNDS || 5);

const results = [];
let section = "";
const check = (name, ok, detail) => {
  results.push({ section, name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} [${section}] ${name}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};

async function api(as, method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (as) headers.authorization = `Bearer ${as}`;
  let payload;
  if (opts.raw !== undefined) { headers["content-type"] = "application/json"; payload = opts.raw; }
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch((opts.base || API) + url, { method, headers, body: payload });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const S = (n) => `e2e-s${n}`;
const at = (days, hours = 10, minutes = 0) => {
  const d = new Date(Date.now() + days * 864e5);
  d.setUTCHours(hours, minutes, 0, 0);
  return d.toISOString();
};
let seq = 0;
const newEvent = async (overrides = {}) => {
  seq += 1;
  const res = await api("e2e-org", "POST", "/events", {
    title: `[E2E] Event ${seq}`, description: "Automated test event", capacity: 2,
    startsAt: at(30 + seq), endsAt: at(30 + seq, 12), venueId: VENUE_ID, status: "PUBLISHED", ...overrides,
  });
  if (res.status !== 201) throw new Error(`event create failed ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
};
const roster = async (eventId) => {
  const res = await api("e2e-org", "GET", `/events/${eventId}/bookings`);
  const byStudent = {};
  for (const b of res.data) byStudent[b.student.email.split("@")[0]] = b.status;
  const count = (s) => res.data.filter((b) => b.status === s).length;
  return { byStudent, confirmed: count("CONFIRMED"), waitlisted: count("WAITLISTED"), cancelled: count("CANCELLED"), rows: res.data };
};
const book = (student, eventId) => api(student, "POST", "/bookings", { eventId });
const cancel = (student, bookingId) => api(student, "PATCH", `/bookings/${bookingId}/cancel`);

let VENUE_ID;
const ROOM = "E2E-901";

const CAMPUS = { latitude: 13.6138, longitude: 100.8338 }; // AU Suvarnabhumi

async function setupVenue() {
  section = "venues";
  if (ONLY !== "race") {
    check("student cannot create a venue (403)", (await api(S(1), "POST", "/venues", { name: "[E2E] x", ...CAMPUS })).status === 403);
    const noPin = await api("e2e-org", "POST", "/venues", { name: "[E2E] No pin", addressRaw: "Assumption University" });
    check("no pin → 400 (a typed address is no longer enough)", noPin.status === 400 && /pin/i.test(noPin.data.error), noPin);
    const badPin = await api("e2e-org", "POST", "/venues", { name: "[E2E] Nowhere", latitude: 0, longitude: 0 });
    check("pin in the middle of the ocean → 422", badPin.status === 422, badPin);
    check("impossible coordinates → 400", (await api("e2e-org", "POST", "/venues", { name: "[E2E] x", latitude: 999, longitude: 0 })).status === 400);

    // Regression test: unbiased, this search returned Assumption University in Massachusetts.
    const search = await api("e2e-org", "GET", "/venues/geocode?q=assumption%20university");
    const first = search.data?.[0];
    check("place search finds the AU campus in Thailand, not the US one",
      search.status === 200 && /Assumption University/i.test(first?.formatted) && Math.abs(first.latitude - 13.61) < 0.2 && Math.abs(first.longitude - 100.83) < 0.2, first);
    check("short search query → 400", (await api("e2e-org", "GET", "/venues/geocode?q=au")).status === 400);
    check("student cannot use place search (403)", (await api(S(1), "GET", "/venues/geocode?q=assumption")).status === 403);
  }

  const real = await api("e2e-org", "POST", "/venues", { name: "[E2E] Test Hall", roomNumber: ROOM, ...CAMPUS });
  check("pinned venue → 201, coordinates stored, address filled in from the pin",
    real.status === 201 && real.data.latitude === CAMPUS.latitude && real.data.longitude === CAMPUS.longitude &&
    real.data.isVerified && typeof real.data.addressRaw === "string" && real.data.addressRaw.length > 3, real);
  check("venue response no longer carries a Geoapify map URL (key not exposed)", !("staticMapUrl" in real.data), Object.keys(real.data));
  VENUE_ID = real.data.id;
  if (ONLY !== "race") {
    const labelled = await api("e2e-org", "POST", "/venues", { name: "[E2E] Labelled Hall", addressRaw: "AU Grand Hall, Building D", ...CAMPUS });
    check("organizer's own address label is kept", labelled.data.addressRaw === "AU Grand Hall, Building D", labelled.data);
    const list = await api(S(1), "GET", "/venues");
    check("GET /venues lists it", list.status === 200 && list.data.some((v) => v.id === VENUE_ID));
  }
}

async function authTests() {
  section = "auth";
  check("no token → 401", (await api(null, "GET", "/me")).status === 401);
  check("unknown token → 401", (await api("not-a-user", "GET", "/me")).status === 401);
  const me = await api(S(1), "GET", "/me");
  check("GET /me returns DB role", me.status === 200 && me.data.role === "STUDENT" && me.data.email === "e2e-s1@e2e.invalid", me);
  check("student → /admin/users 403", (await api(S(1), "GET", "/admin/users")).status === 403);
  check("organizer → /admin/users 403", (await api("e2e-org", "GET", "/admin/users")).status === 403);
  check("admin → /admin/users 200", (await api("e2e-admin", "GET", "/admin/users")).status === 200);
  check("/health 200", (await api(null, "GET", "/health", undefined, { base: BASE })).status === 200);
  check("malformed JSON → 400 (not 500)", (await api(S(1), "POST", "/bookings", undefined, { raw: "{nope" })).status === 400);
}

async function eventCreateTests() {
  section = "events:create";
  const base = { title: "[E2E] Validation", capacity: 10, startsAt: at(40), endsAt: at(40, 12), venueId: VENUE_ID };
  const cases = [
    ["missing title", { ...base, title: undefined }, /missing/i],
    ["capacity 0", { ...base, capacity: 0 }, /capacity/i],
    ["capacity 1.5", { ...base, capacity: 1.5 }, /capacity/i],
    ["capacity \"5\" (string)", { ...base, capacity: "5" }, /capacity/i],
    ["capacity -3", { ...base, capacity: -3 }, /capacity/i],
    ["ends before start", { ...base, endsAt: at(40, 8) }, /must end after it starts/],
    ["ends == start", { ...base, endsAt: base.startsAt }, /must end after it starts/],
    ["garbage date", { ...base, startsAt: "next week" }, /start time/i],
    ["unknown venue", { ...base, venueId: 99999999 }, /venue/i],
    ["non-numeric venue", { ...base, venueId: "abc" }, /venue/i],
    ["status LIVE", { ...base, status: "LIVE" }, /status/],
    ["status CANCELLED on create", { ...base, status: "CANCELLED" }, /status/],
  ];
  for (const [name, body, msg] of cases) {
    const res = await api("e2e-org", "POST", "/events", body);
    check(`${name} → 400 with clear message`, res.status === 400 && msg.test(res.data.error), res);
  }
  check("student cannot create an event (403)", (await api(S(1), "POST", "/events", base)).status === 403);
  const noStatus = await api("e2e-org", "POST", "/events", base);
  check("no status → created as DRAFT", noStatus.status === 201 && noStatus.data.status === "DRAFT", noStatus);
  const strVenue = await api("e2e-org", "POST", "/events", { ...base, venueId: String(VENUE_ID), status: "PUBLISHED" });
  check("numeric-string venueId accepted", strVenue.status === 201 && strVenue.data.venueId === VENUE_ID, strVenue);
  return { draft: noStatus.data, published: strVenue.data };
}

async function visibilityTests({ draft, published }) {
  section = "events:visibility";
  const list = await api(S(1), "GET", "/events");
  check("public list excludes drafts", !list.data.some((e) => e.id === draft.id));
  const pub = list.data.find((e) => e.id === published.id);
  check("public list includes published with venue + seats", pub && pub.venue?.id === VENUE_ID && pub.seats?.confirmed === 0 && pub.seats?.waitlisted === 0, pub);
  const starts = list.data.map((e) => new Date(e.startsAt).getTime());
  check("public list sorted by start time", starts.every((t, i) => i === 0 || starts[i - 1] <= t));
  const mine = await api("e2e-org", "GET", "/events?mine=true");
  check("?mine=true includes own draft", mine.data.some((e) => e.id === draft.id) && mine.data.every((e) => e.organizerId === draft.organizerId));
  const mine2 = await api("e2e-org2", "GET", "/events?mine=true");
  check("another organizer's ?mine=true excludes it", !mine2.data.some((e) => e.id === draft.id));
  check("student GET draft by id → 404", (await api(S(1), "GET", `/events/${draft.id}`)).status === 404);
  check("other organizer GET draft by id → 404", (await api("e2e-org2", "GET", `/events/${draft.id}`)).status === 404);
  check("owner GET draft by id → 200", (await api("e2e-org", "GET", `/events/${draft.id}`)).status === 200);
  check("admin GET draft by id → 200", (await api("e2e-admin", "GET", `/events/${draft.id}`)).status === 200);
  check("GET /events/abc → 404", (await api(S(1), "GET", "/events/abc")).status === 404);
  check("GET /events/99999999 → 404", (await api(S(1), "GET", "/events/99999999")).status === 404);
  check("booking a draft → 404", (await book(S(1), draft.id)).status === 404);
}

async function patchTests({ draft }) {
  section = "events:update";
  check("other organizer PATCH → 403", (await api("e2e-org2", "PATCH", `/events/${draft.id}`, { title: "hijack" })).status === 403);
  check("other organizer DELETE → 403", (await api("e2e-org2", "DELETE", `/events/${draft.id}`)).status === 403);
  check("student PATCH → 403", (await api(S(1), "PATCH", `/events/${draft.id}`, { title: "x" })).status === 403);
  const adminEdit = await api("e2e-admin", "PATCH", `/events/${draft.id}`, { title: "[E2E] Admin edited" });
  check("admin can edit any event", adminEdit.status === 200 && adminEdit.data.title === "[E2E] Admin edited", adminEdit);
  for (const [name, body] of [
    ["capacity 0", { capacity: 0 }], ["capacity \"abc\"", { capacity: "abc" }], ["status LIVE", { status: "LIVE" }],
    ["empty title", { title: "  " }], ["garbage startsAt", { startsAt: "soon" }], ["endsAt before existing start", { endsAt: at(1) }],
  ]) {
    const res = await api("e2e-org", "PATCH", `/events/${draft.id}`, body);
    check(`PATCH ${name} → 400`, res.status === 400, res);
  }
  const moved = await api("e2e-org", "PATCH", `/events/${draft.id}`, { startsAt: at(50), endsAt: at(50, 11) });
  check("PATCH both dates together → 200", moved.status === 200, moved);
  check("PATCH /events/abc → 404", (await api("e2e-org", "PATCH", "/events/abc", { title: "x" })).status === 404);
  const pub = await api("e2e-org", "PATCH", `/events/${draft.id}`, { status: "PUBLISHED" });
  check("publish a draft", pub.status === 200 && pub.data.status === "PUBLISHED");
  check("published draft now visible to students", (await api(S(1), "GET", `/events/${draft.id}`)).status === 200);
}

async function raceTests() {
  section = "race";
  const summary = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const capacity = round % 2 ? 1 : 3;
    const students = Array.from({ length: 12 }, (_, i) => S(i + 1));
    const ev = await newEvent({ capacity, title: `[E2E] Race round ${round} (cap ${capacity})` });
    const t0 = Date.now();
    const responses = await Promise.all(students.map((s) => book(s, ev.id)));
    const ms = Date.now() - t0;
    const r = await roster(ev.id);
    const created = responses.filter((x) => x.status === 201).length;
    summary.push(`round ${round}: cap ${capacity}, 12 simultaneous → ${r.confirmed} confirmed / ${r.waitlisted} waitlisted in ${ms}ms`);
    check(`round ${round}: all 12 requests succeed (201)`, created === 12, responses.map((x) => x.status));
    check(`round ${round}: exactly ${capacity} confirmed, ${12 - capacity} waitlisted (cap ${capacity})`, r.confirmed === capacity && r.waitlisted === 12 - capacity, { confirmed: r.confirmed, waitlisted: r.waitlisted });
    const listed = (await api(S(1), "GET", "/events")).data.find((e) => e.id === ev.id);
    if (ONLY !== "race") check(`round ${round}: seat counts in /events match`, listed?.seats?.confirmed === capacity && listed?.seats?.waitlisted === 12 - capacity, listed?.seats);
  }
  console.log(`  ${summary.join("\n  ")}`);
}

async function duplicateTests() {
  section = "duplicates";
  const ev = await newEvent({ capacity: 5, title: "[E2E] Duplicate storm" });
  const responses = await Promise.all(Array.from({ length: 8 }, () => book(S(11), ev.id)));
  const codes = responses.map((x) => x.status).sort();
  check("same student, 8 simultaneous RSVPs → exactly one 201, seven 409", codes.filter((c) => c === 201).length === 1 && codes.filter((c) => c === 409).length === 7, codes);
  const r = await roster(ev.id);
  check("only one booking row exists", r.rows.length === 1 && r.confirmed === 1, r.rows.length);
  check("409 message is clear", responses.find((x) => x.status === 409)?.data.error === "You have already booked this event");
}

async function promotionTests() {
  section = "cancel+promotion";
  const ev = await newEvent({ capacity: 2, title: "[E2E] Promotion queue" });
  const ids = {};
  for (const n of [1, 2, 3, 4, 5]) {
    const res = await book(S(n), ev.id);
    ids[n] = res.data.id;
  }
  let r = await roster(ev.id);
  check("setup: s1,s2 confirmed; s3,s4,s5 waitlisted", r.byStudent["e2e-s1"] === "CONFIRMED" && r.byStudent["e2e-s2"] === "CONFIRMED" && ["e2e-s3", "e2e-s4", "e2e-s5"].every((s) => r.byStudent[s] === "WAITLISTED"), r.byStudent);

  const c3 = await cancel(S(3), ids[3]);
  r = await roster(ev.id);
  check("waitlisted s3 cancels → nobody promoted", c3.status === 200 && c3.data.status === "CANCELLED" && r.confirmed === 2 && r.waitlisted === 2, r.byStudent);

  await cancel(S(1), ids[1]);
  r = await roster(ev.id);
  check("confirmed s1 cancels → oldest waitlisted (s4) promoted, s5 still waiting", r.byStudent["e2e-s4"] === "CONFIRMED" && r.byStudent["e2e-s5"] === "WAITLISTED" && r.confirmed === 2, r.byStudent);

  const again = await cancel(S(1), ids[1]);
  r = await roster(ev.id);
  check("cancelling again is a harmless no-op", again.status === 200 && r.confirmed === 2 && r.waitlisted === 1, r.byStudent);

  check("s2 cannot cancel s5's booking (404)", (await cancel(S(2), ids[5])).status === 404);
  check("cancel /bookings/abc → 404", (await cancel(S(2), "abc")).status === 404);

  const rebook = await book(S(1), ev.id);
  check("s1 rebooks after cancelling → 201 WAITLISTED (event full), same row reused", rebook.status === 201 && rebook.data.status === "WAITLISTED" && rebook.data.id === ids[1], rebook.data);

  await cancel(S(2), ids[2]);
  r = await roster(ev.id);
  check("next promotion goes to s5 (waited longer), not the rebooked s1", r.byStudent["e2e-s5"] === "CONFIRMED" && r.byStudent["e2e-s1"] === "WAITLISTED", r.byStudent);

  const rebook3 = await book(S(3), ev.id);
  check("s3 rebooks → WAITLISTED behind s1", rebook3.data.status === "WAITLISTED");

  const both = await Promise.all([cancel(S(4), ids[4]), cancel(S(5), ids[5])]);
  r = await roster(ev.id);
  check("s4 and s5 cancel at the same moment → s1 and s3 both promoted, never over capacity", both.every((x) => x.status === 200) && r.byStudent["e2e-s1"] === "CONFIRMED" && r.byStudent["e2e-s3"] === "CONFIRMED" && r.confirmed === 2 && r.waitlisted === 0, r.byStudent);

  const mine = await api(S(1), "GET", "/bookings/mine");
  const mb = mine.data.find((b) => b.eventId === ev.id);
  check("/bookings/mine shows the booking with event + venue", mine.status === 200 && mb?.status === "CONFIRMED" && mb?.event?.venue?.id === VENUE_ID, mb);
  check("organizer cannot use /bookings/mine (403)", (await api("e2e-org", "GET", "/bookings/mine")).status === 403);
  check("organizer cannot book (403)", (await book("e2e-org", ev.id)).status === 403);
}

async function capacityTests() {
  section = "capacity";
  const ev = await newEvent({ capacity: 2, title: "[E2E] Capacity changes" });
  for (const n of [1, 2, 3, 4, 5]) await book(S(n), ev.id);
  const lower = await api("e2e-org", "PATCH", `/events/${ev.id}`, { capacity: 1 });
  check("lower capacity below 2 confirmed → 409 with count", lower.status === 409 && /2 seats already confirmed/.test(lower.data.error), lower);
  let r = await roster(ev.id);
  check("…and nothing changed", r.confirmed === 2 && r.waitlisted === 3);
  await api("e2e-org", "PATCH", `/events/${ev.id}`, { capacity: 3 });
  r = await roster(ev.id);
  check("raise 2→3 → s3 promoted", r.byStudent["e2e-s3"] === "CONFIRMED" && r.confirmed === 3 && r.waitlisted === 2, r.byStudent);
  check("lower 3→3 (same) → 200", (await api("e2e-org", "PATCH", `/events/${ev.id}`, { capacity: 3 })).status === 200);
  await api("e2e-org", "PATCH", `/events/${ev.id}`, { capacity: 10 });
  r = await roster(ev.id);
  check("raise 3→10 → everyone waiting promoted", r.confirmed === 5 && r.waitlisted === 0, r.byStudent);
  const lowerOk = await api("e2e-org", "PATCH", `/events/${ev.id}`, { capacity: 5 });
  check("lower 10→5 (exactly the confirmed count) → 200", lowerOk.status === 200, lowerOk);

  const ev2 = await newEvent({ capacity: 2, title: "[E2E] Capacity raise during rush" });
  const [raise, ...bookings] = await Promise.all([
    api("e2e-org", "PATCH", `/events/${ev2.id}`, { capacity: 4 }),
    ...[6, 7, 8, 9, 10, 11].map((n) => book(S(n), ev2.id)),
  ]);
  r = await roster(ev2.id);
  check("raise to 4 while 6 students book at once → exactly 4 confirmed, 2 waitlisted", raise.status === 200 && bookings.every((b) => b.status === 201) && r.confirmed === 4 && r.waitlisted === 2, { confirmed: r.confirmed, waitlisted: r.waitlisted });
}

async function statusTests() {
  section = "draft/cancel";
  const ev = await newEvent({ capacity: 1, title: "[E2E] Unpublish and republish" });
  const b1 = await book(S(1), ev.id);
  await book(S(2), ev.id);
  await api("e2e-org", "PATCH", `/events/${ev.id}`, { status: "DRAFT" });
  check("unpublished event can't be booked (404)", (await book(S(3), ev.id)).status === 404);
  await cancel(S(1), b1.data.id);
  let r = await roster(ev.id);
  check("seat freed while in DRAFT → no promotion yet", r.byStudent["e2e-s2"] === "WAITLISTED" && r.confirmed === 0, r.byStudent);
  await api("e2e-org", "PATCH", `/events/${ev.id}`, { status: "PUBLISHED" });
  r = await roster(ev.id);
  check("republishing fills the open seat from the waitlist", r.byStudent["e2e-s2"] === "CONFIRMED", r.byStudent);

  const ev2 = await newEvent({ capacity: 2, title: "[E2E] Cancelled by organizer" });
  for (const n of [1, 2, 3]) await book(S(n), ev2.id);
  const del = await api("e2e-org", "DELETE", `/events/${ev2.id}`);
  r = await roster(ev2.id);
  check("DELETE → event CANCELLED, all 3 bookings cancelled", del.status === 200 && del.data.status === "CANCELLED" && r.cancelled === 3 && r.confirmed + r.waitlisted === 0, r.byStudent);
  check("cancelled event not in public list", !(await api(S(1), "GET", "/events")).data.some((e) => e.id === ev2.id));
  check("cancelled event can't be booked (404)", (await book(S(4), ev2.id)).status === 404);
  const mine = (await api(S(3), "GET", "/bookings/mine")).data.find((b) => b.eventId === ev2.id);
  check("student sees CANCELLED booking on a CANCELLED event", mine?.status === "CANCELLED" && mine?.event?.status === "CANCELLED", mine);
  check("DELETE again → still 200", (await api("e2e-org", "DELETE", `/events/${ev2.id}`)).status === 200);

  const ev3 = await newEvent({ capacity: 1, title: "[E2E] Cancelled via PATCH" });
  await book(S(1), ev3.id); await book(S(2), ev3.id);
  await api("e2e-org", "PATCH", `/events/${ev3.id}`, { status: "CANCELLED" });
  r = await roster(ev3.id);
  check("PATCH status CANCELLED cascades to bookings too", r.cancelled === 2, r.byStudent);
}

async function attendeeTests() {
  section = "attendees";
  const ev = await newEvent({ capacity: 3, title: "[E2E] Attendee list" });
  await book(S(1), ev.id);
  const own = await api("e2e-org", "GET", `/events/${ev.id}/bookings`);
  check("owner sees attendees with name + email", own.status === 200 && own.data[0]?.student?.displayName === "E2E Student 1" && own.data[0]?.student?.email);
  check("attendee rows don't leak adObjectId", own.data.every((b) => !("adObjectId" in b.student)));
  check("other organizer → 403", (await api("e2e-org2", "GET", `/events/${ev.id}/bookings`)).status === 403);
  check("student → 403", (await api(S(1), "GET", `/events/${ev.id}/bookings`)).status === 403);
  check("admin → 200", (await api("e2e-admin", "GET", `/events/${ev.id}/bookings`)).status === 200);
  check("unknown event → 404", (await api("e2e-org", "GET", "/events/99999999/bookings")).status === 404);
}

async function adminTests() {
  section = "admin";
  const users = await api("e2e-admin", "GET", "/admin/users");
  const target = users.data.find((u) => u.email === "e2e-rolechange@e2e.invalid");
  const self = users.data.find((u) => u.email === "e2e-admin@e2e.invalid");
  check("users list has e2e users and no adObjectId", target && self && users.data.every((u) => !("adObjectId" in u)));
  const promote = await api("e2e-admin", "PATCH", `/admin/users/${target.id}/role`, { role: "ORGANIZER" });
  const me = await api("e2e-rolechange", "GET", "/me");
  check("role change takes effect immediately for that user", promote.status === 200 && me.data.role === "ORGANIZER", me.data);
  await api("e2e-admin", "PATCH", `/admin/users/${target.id}/role`, { role: "STUDENT" });
  const selfDemote = await api("e2e-admin", "PATCH", `/admin/users/${self.id}/role`, { role: "STUDENT" });
  check("admin can't demote themselves (400)", selfDemote.status === 400 && /own Admin role/.test(selfDemote.data.error), selfDemote);
  check("admin setting own role to ADMIN (no-op) is allowed", (await api("e2e-admin", "PATCH", `/admin/users/${self.id}/role`, { role: "ADMIN" })).status === 200);
  check("invalid role → 400", (await api("e2e-admin", "PATCH", `/admin/users/${target.id}/role`, { role: "GOD" })).status === 400);
  check("unknown user id → 404", (await api("e2e-admin", "PATCH", "/admin/users/99999999/role", { role: "STUDENT" })).status === 404);
  check("non-numeric user id → 404", (await api("e2e-admin", "PATCH", "/admin/users/abc/role", { role: "STUDENT" })).status === 404);

  const evs = await api("e2e-admin", "GET", "/admin/events");
  const anE2e = evs.data.find((e) => e.title?.startsWith("[E2E]"));
  check("admin events list includes seats + organizer (no adObjectId)", anE2e?.seats && anE2e?.organizer?.displayName && !("adObjectId" in anE2e.organizer), anE2e?.organizer);
  const bks = await api("e2e-admin", "GET", "/admin/bookings");
  check("admin bookings list includes student + event (no adObjectId)", bks.status === 200 && bks.data.length > 0 && bks.data.every((b) => b.student && b.event && !("adObjectId" in b.student)));
}

async function peerTests() {
  section = "room-status API";
  check("issue key without label → 400", (await api("e2e-admin", "POST", "/admin/api-keys", { scope: "room-status:read" })).status === 400);
  check("organizer can't issue keys (403)", (await api("e2e-org", "POST", "/admin/api-keys", { ownerLabel: "[E2E] x", scope: "room-status:read" })).status === 403);
  const key = await api("e2e-admin", "POST", "/admin/api-keys", { ownerLabel: "[E2E] Room display", scope: "room-status:read" });
  check("issue key → 201 with 64-hex raw key", key.status === 201 && /^[0-9a-f]{64}$/.test(key.data.key), key);
  check("issue response has no hash", !("keyHash" in key.data));
  const wrongScope = await api("e2e-admin", "POST", "/admin/api-keys", { ownerLabel: "[E2E] Wrong scope", scope: "other:read" });
  const peer = (k, room = ROOM) => api(null, "GET", `/peer/events/active${room === null ? "" : `?room=${encodeURIComponent(room)}`}`, undefined, { headers: k ? { "x-api-key": k } : {} });

  check("no key → 401", (await peer(null)).status === 401);
  check("wrong key → 401", (await peer("deadbeef")).status === 401);
  check("key with the wrong scope → 401", (await peer(wrongScope.data.key)).status === 401);
  check("missing room → 400", (await peer(key.data.key, null)).status === 400);
  const idle = await peer(key.data.key);
  check("no event running in room → {active:false}", idle.status === 200 && idle.data.active === false, idle.data);

  const now = Date.now();
  const live = await newEvent({ title: "[E2E] Happening now", startsAt: new Date(now - 10 * 60e3).toISOString(), endsAt: new Date(now + 50 * 60e3).toISOString() });
  const active = await peer(key.data.key);
  check("event running now → active:true with id + title", active.data.active === true && active.data.eventId === live.id && active.data.title === "[E2E] Happening now", active.data);
  check("other room unaffected", (await peer(key.data.key, "E2E-NOPE")).data.active === false);
  await api("e2e-org", "PATCH", `/events/${live.id}`, { status: "DRAFT" });
  check("running DRAFT event is not reported", (await peer(key.data.key)).data.active === false);
  await api("e2e-org", "PATCH", `/events/${live.id}`, { status: "PUBLISHED" });
  await api("e2e-org", "DELETE", `/events/${live.id}`);
  check("cancelled event is not reported", (await peer(key.data.key)).data.active === false);

  const revoke = await api("e2e-admin", "DELETE", `/admin/api-keys/${key.data.id}`);
  check("revoke → 200 isActive:false", revoke.status === 200 && revoke.data.isActive === false, revoke.data);
  check("revoke response does not contain the key hash", !("keyHash" in revoke.data), Object.keys(revoke.data));
  const list = await api("e2e-admin", "GET", "/admin/api-keys");
  const listed = list.data.find((k) => k.id === key.data.id);
  check("GET /admin/api-keys lists the revoked key", list.status === 200 && listed?.isActive === false, listed);
  check("key list never contains hashes or raw keys", list.data.every((k) => !("keyHash" in k) && !("key" in k)));
  check("key list is newest first", list.data.every((k, i) => i === 0 || new Date(list.data[i - 1].createdAt) >= new Date(k.createdAt)));
  check("organizer can't list keys (403)", (await api("e2e-org", "GET", "/admin/api-keys")).status === 403);
  check("revoked key → 401", (await peer(key.data.key)).status === 401);
  check("revoke unknown key id → 404", (await api("e2e-admin", "DELETE", "/admin/api-keys/99999999")).status === 404);
  check("revoke non-numeric key id → 404", (await api("e2e-admin", "DELETE", "/admin/api-keys/abc")).status === 404);
  await api("e2e-admin", "DELETE", `/admin/api-keys/${wrongScope.data.id}`);
}

async function discordTest() {
  section = "large conference → Discord";
  const ev = await newEvent({ title: "[E2E] Large conference (automated test)", isLargeConference: true, capacity: 300 });
  check("large-conference event created", ev.isLargeConference === true);
  console.log(`  large-conference event #${ev.id} — preorder status checked in the DB inspection step`);
}

const t0 = Date.now();
await setupVenue();
if (ONLY === "race") {
  await raceTests();
} else {
  await authTests();
  const created = await eventCreateTests();
  await visibilityTests(created);
  await patchTests(created);
  await raceTests();
  await duplicateTests();
  await promotionTests();
  await capacityTests();
  await statusTests();
  await attendeeTests();
  await adminTests();
  await peerTests();
  await discordTest();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed.length) { console.log("FAILED:"); failed.forEach((f) => console.log(`  [${f.section}] ${f.name}`)); }
