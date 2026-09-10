const axios = require("axios");
const { prisma } = require("./prisma");

// Large-conference events need 50 blank lanyards prepped. The original design called a
// classmate team's API for this; per a 2026-09-10 instruction change, peer-to-classmate
// integrations were dropped in favor of a genuine public API — see CLAUDE.md §5. This
// notifies a Discord channel via an incoming webhook (a real, public, third-party API)
// instead, with the returned Discord message id stored as the order reference.
// `?wait=true` makes Discord return the created message (with its id) instead of 204.
async function preorderLanyards(event) {
  const preorder = await prisma.merchPreorder.create({
    data: { eventId: event.id, quantity: 50, status: "PENDING" },
  });

  try {
    const { data } = await axios.post(`${process.env.DISCORD_WEBHOOK_URL}?wait=true`, {
      content: `📛 50 lanyards needed for large-conference event "${event.title}" (event #${event.id}).`,
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

module.exports = { preorderLanyards };
