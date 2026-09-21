// The error middleware turns this into a JSON response.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Clean up names received from the AU directory.
function cleanNameOf(user) {
  const raw = (user?.displayName || user?.email || "System").replace(/[\s-]+$/, "").trim();
  if (raw && raw === raw.toUpperCase()) {
    return raw.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  }
  return raw;
}

module.exports = { HttpError, cleanNameOf };
