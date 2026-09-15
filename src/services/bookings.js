const { prisma } = require("./prisma");
const { HttpError } = require("../utils/http");

// Every operation that changes who holds a seat (booking, cancelling, changing capacity,
// cancelling an event) runs in a transaction that first locks the event's row. That
// serializes seat changes per event, so two students can't both grab the last seat by
// counting "4 of 5 taken" at the same moment. READ COMMITTED makes each query after the
// lock see whatever the previous transaction just committed.
const TX_OPTIONS = { isolationLevel: "ReadCommitted" };

function withEventTransaction(fn) {
  return prisma.$transaction(fn, TX_OPTIONS);
}

async function lockEvent(tx, eventId) {
  await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId} FOR UPDATE`;
}

// Promotes waitlisted bookings, oldest first, into any open seats. Returns promoted ids.
async function fillOpenSeats(tx, event) {
  const confirmed = await tx.booking.count({
    where: { eventId: event.id, status: "CONFIRMED" },
  });
  const openSeats = event.capacity - confirmed;
  if (openSeats <= 0) return [];

  const next = await tx.booking.findMany({
    where: { eventId: event.id, status: "WAITLISTED" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: openSeats,
    select: { id: true },
  });
  const ids = next.map((b) => b.id);
  if (ids.length > 0) {
    await tx.booking.updateMany({ where: { id: { in: ids } }, data: { status: "CONFIRMED" } });
  }
  return ids;
}

async function cancelActiveBookings(tx, eventId) {
  await tx.booking.updateMany({
    where: { eventId, status: { in: ["CONFIRMED", "WAITLISTED"] } },
    data: { status: "CANCELLED" },
  });
}

// Adds `seats: { confirmed, waitlisted }` to each event, in one grouped query, so the
// frontend can show capacity bars without an extra request per event.
async function withSeatCounts(events) {
  if (events.length === 0) return events;

  const groups = await prisma.booking.groupBy({
    by: ["eventId", "status"],
    where: { eventId: { in: events.map((e) => e.id) }, status: { in: ["CONFIRMED", "WAITLISTED"] } },
    _count: { _all: true },
  });

  return events.map((event) => {
    const seats = { confirmed: 0, waitlisted: 0 };
    for (const group of groups) {
      if (group.eventId === event.id) seats[group.status.toLowerCase()] = group._count._all;
    }
    return { ...event, seats };
  });
}

function bookSeat(eventId, studentId) {
  return withEventTransaction(async (tx) => {
    await lockEvent(tx, eventId);

    const event = await tx.event.findUnique({ where: { id: eventId } });
    if (!event || event.status !== "PUBLISHED") {
      throw new HttpError(404, "Event not found");
    }

    // The (eventId, studentId) unique constraint means a cancelled booking's row is
    // still there — booking again reuses it instead of failing as a duplicate.
    const existing = await tx.booking.findUnique({
      where: { eventId_studentId: { eventId, studentId } },
    });
    if (existing && existing.status !== "CANCELLED") {
      throw new HttpError(409, "You have already booked this event");
    }

    const confirmed = await tx.booking.count({ where: { eventId, status: "CONFIRMED" } });
    const status = confirmed >= event.capacity ? "WAITLISTED" : "CONFIRMED";

    if (existing) {
      // createdAt is the waitlist queue position — rebooking goes to the back of the line.
      return tx.booking.update({
        where: { id: existing.id },
        data: { status, createdAt: new Date() },
      });
    }
    return tx.booking.create({ data: { eventId, studentId, status } });
  });
}

function cancelBooking(bookingId, studentId) {
  return withEventTransaction(async (tx) => {
    const found = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!found || found.studentId !== studentId) {
      throw new HttpError(404, "Booking not found");
    }

    await lockEvent(tx, found.eventId);
    // Re-read under the lock: a concurrent cancellation may have just promoted this
    // booking from WAITLISTED to CONFIRMED.
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    if (booking.status === "CANCELLED") return booking;

    const cancelled = await tx.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELLED" },
    });

    if (booking.status === "CONFIRMED") {
      const event = await tx.event.findUnique({ where: { id: booking.eventId } });
      if (event && event.status === "PUBLISHED") {
        await fillOpenSeats(tx, event);
      }
    }
    return cancelled;
  });
}

module.exports = {
  withEventTransaction,
  lockEvent,
  fillOpenSeats,
  cancelActiveBookings,
  withSeatCounts,
  bookSeat,
  cancelBooking,
};
