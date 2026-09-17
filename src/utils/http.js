// Thrown from inside route handlers (and Prisma transactions, where an early `return
// res.status(...)` isn't possible) — app.js's error handler turns it into a JSON response.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// AU directory names arrive as "THAR LIN HTET -"; audit entries read better tidied up.
function cleanNameOf(user) {
  const raw = (user?.displayName || user?.email || "System").replace(/[\s-]+$/, "").trim();
  if (raw && raw === raw.toUpperCase()) {
    return raw.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  }
  return raw;
}

module.exports = { HttpError, cleanNameOf };
