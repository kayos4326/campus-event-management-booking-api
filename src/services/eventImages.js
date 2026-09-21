const crypto = require("crypto");

// The browser resizes photos before upload. The server still enforces a 2 MB limit.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Check the file signature instead of trusting the Content-Type header.
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

// Return the image URL without loading the image bytes into normal event responses.
function withImageUrl(event) {
  if (!event) return event;
  const { image, ...rest } = event;
  return { ...rest, imageUrl: imageUrl(event.id, image?.key) };
}

// Event queries only need the image key.
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
