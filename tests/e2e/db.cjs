// Test data setup / cleanup / inspection against the live DB.
// Everything created is tagged: users by adObjectId "e2e-…", venues/events/api keys by an
// "[E2E]" prefix. Cleanup only ever deletes tagged rows.
const path = require("path");
const APP_DIR = process.env.APP_DIR;
if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;

const USERS = [
  ["e2e-admin", "E2E Admin", "ADMIN"],
  ["e2e-org", "E2E Organizer", "ORGANIZER"],
  ["e2e-org2", "E2E Organizer Two", "ORGANIZER"],
  ...Array.from({ length: 12 }, (_, i) => [`e2e-s${i + 1}`, `E2E Student ${i + 1}`, "STUDENT"]),
  ["e2e-rolechange", "E2E Role Change", "STUDENT"],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    require(path.join(APP_DIR, "node_modules/dotenv")).config({ path: path.join(APP_DIR, ".env") });
    await require(path.join(APP_DIR, "src/config/keyvault")).loadSecrets();
  }
  const { prisma } = require(path.join(APP_DIR, "src/services/prisma"));
  const cmd = process.argv[2];

  const e2eUsers = () => prisma.user.findMany({ where: { adObjectId: { startsWith: "e2e-" } } });

  if (cmd === "setup") {
    for (const [oid, name, role] of USERS) {
      await prisma.user.upsert({
        where: { adObjectId: oid },
        create: { adObjectId: oid, displayName: name, email: `${oid}@e2e.invalid`, role },
        update: { role, displayName: name },
      });
    }
    console.log("users:", (await e2eUsers()).map((u) => `${u.adObjectId}#${u.id}:${u.role}`).join(" "));
  }

  if (cmd === "cleanup") {
    const users = await e2eUsers();
    const userIds = users.map((u) => u.id);
    const events = await prisma.event.findMany({
      where: { OR: [{ organizerId: { in: userIds } }, { title: { startsWith: "[E2E]" } }] },
      select: { id: true },
    });
    const eventIds = events.map((e) => e.id);
    const b = await prisma.booking.deleteMany({ where: { OR: [{ eventId: { in: eventIds } }, { studentId: { in: userIds } }] } });
    const m = await prisma.merchPreorder.deleteMany({ where: { eventId: { in: eventIds } } });
    const e = await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    const v = await prisma.venue.deleteMany({ where: { name: { startsWith: "[E2E]" }, events: { none: {} } } });
    const k = await prisma.apiKey.deleteMany({ where: { ownerLabel: { startsWith: "[E2E]" } } });
    // Audit rows would otherwise linger in the real Admin activity view.
    const a = await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: userIds } }, { summary: { contains: "[E2E]" } }, { actorLabel: { startsWith: "E2E " } }] },
    });
    const u = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    console.log(`deleted bookings=${b.count} preorders=${m.count} events=${e.count} venues=${v.count} apiKeys=${k.count} audit=${a.count} users=${u.count}`);
  }

  if (cmd === "inspect") {
    const users = await e2eUsers();
    const events = await prisma.event.findMany({
      where: { organizerId: { in: users.map((u) => u.id) } },
      include: { bookings: true, preorder: true },
    });
    const bad = [];
    for (const ev of events) {
      const confirmed = ev.bookings.filter((x) => x.status === "CONFIRMED").length;
      const waitlisted = ev.bookings.filter((x) => x.status === "WAITLISTED").length;
      // Invariants: never over capacity; nobody waits while a seat is free (published events).
      if (confirmed > ev.capacity) bad.push(`#${ev.id} over capacity ${confirmed}/${ev.capacity}`);
      if (ev.status === "PUBLISHED" && waitlisted > 0 && confirmed < ev.capacity) bad.push(`#${ev.id} waitlist with free seats ${confirmed}/${ev.capacity} +${waitlisted}`);
      if (ev.status === "CANCELLED" && confirmed + waitlisted > 0) bad.push(`#${ev.id} cancelled event still has active bookings`);
      console.log(`#${ev.id} ${ev.status} cap=${ev.capacity} confirmed=${confirmed} waitlisted=${waitlisted} cancelled=${ev.bookings.length - confirmed - waitlisted} "${ev.title}"${ev.preorder ? ` supplies=${ev.preorder.quantity}x${ev.preorder.item}:${ev.preorder.status}:${ev.preorder.peerOrderRef}` : ""}`);
    }
    console.log(bad.length ? `INVARIANT VIOLATIONS:\n  ${bad.join("\n  ")}` : `invariants OK across ${events.length} events`);
  }

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
