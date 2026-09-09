const axios = require("axios");
const { prisma } = require("./prisma");

// docs/proposal.md: large-conference events auto pre-order 50 blank lanyards from the
// Merch team's API. Exact request/response shape is theirs (CLAUDE.md §5, §8 — not yet
// finalized on their side), so this follows the proposal's documented example.
async function preorderLanyards(eventId) {
  const preorder = await prisma.merchPreorder.create({
    data: { eventId, quantity: 50, status: "PENDING" },
  });

  try {
    const { data } = await axios.post(
      `${process.env.MERCH_API_URL}/orders`,
      { item: "lanyard", quantity: 50, reference: String(eventId) },
      { headers: { "x-api-key": process.env.MERCH_PEER_API_KEY } }
    );
    await prisma.merchPreorder.update({
      where: { id: preorder.id },
      data: { status: "CONFIRMED", peerOrderRef: data.orderRef ?? data.reference ?? null },
    });
  } catch (err) {
    await prisma.merchPreorder.update({
      where: { id: preorder.id },
      data: { status: "FAILED" },
    });
  }
}

module.exports = { preorderLanyards };
