const crypto = require("crypto");

// The browser downscales to ~1600px wide JPEG before uploading (frontend-ui/src/lib/image.js),
// which lands well under this — the cap is here for anything that doesn't go through the UI.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// A Content-Type header can claim anything, so the first bytes of the file decide what it
// actually is — otherwise "Content-Type: image/jpeg" would let anyone store arbitrary
// content that we'd later serve back with an image type.
const SIGNATURES = [
  { mimeType: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/png", matches: (b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) },
  {
    mimeType: "image/webp",
    matches: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  return SIGNATURES.find((signature) => signature.matches(buffer))?.mimeType ?? null;
}

const newImageKey = () => crypto.randomBytes(12).toString("hex");

const imageUrl = (eventId, key) => (key ? `/events/api/events/${eventId}/image/${key}` : null);

// Events go out to the frontend with a plain `imageUrl` instead of the image relation —
// an <img> tag can't send an Authorization header, so the unguessable key in the URL is
// what keeps a draft's poster private. Only call this on a query that included `image`.
function withImageUrl(event) {
  if (!event) return event;
  const { image, ...rest } = event;
  return { ...rest, imageUrl: imageUrl(event.id, image?.key) };
}

// `include` fragment for event queries: the key only, never the bytes.
const IMAGE_SELECT = { select: { key: true } };

module.exports = {
  MAX_IMAGE_BYTES,
  IMAGE_TYPES,
  IMAGE_SELECT,
  detectImageType,
  newImageKey,
  imageUrl,
  withImageUrl,
};
