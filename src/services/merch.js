const axios = require("axios");
const { prisma } = require("./prisma");

// Supplies an event needs ("200 x Blank lanyards"). The original design called a
// classmate team's Merch API for this; per a 2026-09-10 instruction change, peer-to-
// classmate integrations were dropped in favour of a genuine public API — see CLAUDE.md
// §5. This posts the request to a Discord channel via an incoming webhook, with the
// returned Discord message id stored as the order reference.
//
// Until 2026-09-16 this was hard-coded to 50 lanyards (the number in the course brief).
// Organizers now choose the item and the amount, because an event may need t-shirts,
// water bottles or 600 lanyards.

// The order itself is created with its event, in one transaction (routes/events.js).

// Sent when the event actually goes live — a draft may never happen, so ordering
// supplies for one would mean ordering for an event nobody can book.
// `?wait=true` makes Discord return the created message (with its id) instead of 204.
async function sendSupplyRequest(event) {
  const preorder = await prisma.merchPreorder.findUnique({ where: { eventId: event.id } });
  // Already sent? Don't order twice. FAILED is retried the next time it's published.
  if (!preorder || preorder.status === "CONFIRMED") return;

  try {
    const { data } = await axios.post(`${process.env.DISCORD_WEBHOOK_URL}?wait=true`, {
      content: `📦 Supply request: ${preorder.quantity} × ${preorder.item} for "${event.title}" (event #${event.id}, ${event.capacity} seats).`,
    });
    await prisma.merchPreorder.update({
      where: { id: preorder.id },
      data: { status: "CONFIRMED", peerOrderRef: data.id ?? null },
    });
  } catch (err) {
    await prisma.merchPreorder.update({
      where: { id: preorder.id },
      data: { status: "FAILED" },
    });
  }
}

module.exports = { sendSupplyRequest };
