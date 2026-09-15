// Thrown from inside route handlers (and Prisma transactions, where an early `return
// res.status(...)` isn't possible) — app.js's error handler turns it into a JSON response.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// `Number("abc")` is NaN, which Prisma rejects with a generic 500 — treat any id that
// isn't a positive integer as simply not found.
function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new HttpError(404, "Not found");
  }
  return id;
}

module.exports = { HttpError, parseId };
