const axios = require("axios");
const { prisma } = require("./prisma");
const outbox = require("./outbox");

// Supplies an event needs ("200 x Blank lanyards"). The original design called a
// classmate team's Merch API for this; per a 2026-09-10 instruction change, peer-to-
// classmate integrations were dropped in favour of a genuine public API — see CLAUDE.md
// §5. This posts the request to a Discord channel via an incoming webhook, with the
// returned Discord message id stored as the order reference.
//
// Until 2026-09-16 this was hard-coded to 50 lanyards (the number in the course brief).
// Organizers now choose the item and the amount, because an event may need t-shirts,
// water bottles or 600 lanyards.
//
// The order row is created with its event, in one transaction (routes/events.js). Sending
// it goes through the outbox (services/outbox.js): until 2026-09-18 it was a fire-and-
// forget call after the response, so a Discord hiccup or a restart lost it for good.

const JOB_TYPE = "supply.send";
const DISCORD_TIMEOUT_MS = 10000;

// Queues the order to be sent. Call inside the transaction that creates or publishes the
// event — a draft may never happen, so nothing is ordered until the event is live.
async function enqueueSupplyRequest(tx, preorder) {
  // Already sent? Don't order twice (publish → unpublish → publish again).
  if (!preorder || preorder.status === "CONFIRMED") return null;
  // A send that was given up on gets a fresh set of attempts when the event is published again.
  if (preorder.status === "FAILED") {
    await tx.merchPreorder.update({ where: { id: preorder.id }, data: { status: "PENDING" } });
  }
  return outbox.enqueue(tx, JOB_TYPE, { preorderId: preorder.id }, { dedupeKey: `supply:${preorder.id}` });
}

function supplyMessage(preorder, event) {
  return `📦 Supply request: ${preorder.quantity} × ${preorder.item} for "${event.title}" (event #${event.id}, ${event.capacity} seats).`;
}

// Returns the Discord message id. Errors say whether retrying makes sense; none of them
// include the webhook URL, which is a credential.
async function postToDiscord(content) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  // Retryable on purpose: fixing the secret and restarting should let queued orders through.
  if (!webhook) throw new Error("DISCORD_WEBHOOK_URL isn't set");

  const url = new URL(webhook);
  // `?wait=true` makes Discord return the created message (with its id) instead of 204.
  url.searchParams.set("wait", "true");

  try {
    const { data } = await axios.post(url.toString(), { content }, { timeout: DISCORD_TIMEOUT_MS });
    return data?.id ?? null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      // Discord says how long to wait, in seconds (body for webhooks, header otherwise).
      const seconds = Number(err.response.data?.retry_after ?? err.response.headers?.["retry-after"]);
      throw new outbox.RetryLaterError("Discord rate limit (HTTP 429)", Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined);
    }
    if (status >= 400 && status < 500) {
      // A deleted webhook (404) or a malformed message (400) fails the same way every time.
      throw new outbox.PermanentError(`Discord refused the message (HTTP ${status})`);
    }
    throw new Error(status ? `Discord answered HTTP ${status}` : `Couldn't reach Discord (${err.code || "network error"})`);
  }
}

// The outbox handler. Re-reads the order first, so a retry never sends one that already went.
async function deliverSupplyRequest({ preorderId }) {
  const preorder = await prisma.merchPreorder.findUnique({ where: { id: preorderId }, include: { event: true } });
  if (!preorder) return "skipped: the supply order no longer exists";
  if (preorder.status === "CONFIRMED") return "skipped: already sent";
  // Unpublished or cancelled while the job waited. Publishing again queues a new one.
  if (preorder.event.status !== "PUBLISHED") return `skipped: the event is ${preorder.event.status.toLowerCase()}`;

  const messageId = await postToDiscord(supplyMessage(preorder, preorder.event));
  await prisma.merchPreorder.update({
    where: { id: preorder.id },
    data: { status: "CONFIRMED", peerOrderRef: messageId },
  });
  return `sent: Discord message ${messageId}`;
}

// Given up on: the organizer's list shows "(not sent)", and publishing again retries.
async function markSupplyRequestFailed({ preorderId }) {
  await prisma.merchPreorder.updateMany({
    where: { id: preorderId, status: { not: "CONFIRMED" } },
    data: { status: "FAILED" },
  });
}

outbox.registerHandler(JOB_TYPE, { run: deliverSupplyRequest, onDead: markSupplyRequestFailed });

module.exports = { JOB_TYPE, enqueueSupplyRequest, deliverSupplyRequest, markSupplyRequestFailed, postToDiscord };
