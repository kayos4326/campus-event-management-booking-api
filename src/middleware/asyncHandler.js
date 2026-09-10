// Express 4 does not forward a rejected promise from an async route handler to the
// error-handling middleware automatically (that's an Express 5 feature) — without this,
// an unhandled rejection just hangs the request until Nginx's own timeout kicks in,
// returning a bare 504 instead of a proper error response. Confirmed directly: a real
// DB error during venue creation hung for the full Nginx timeout instead of returning
// a 500. Wrap every async route handler with this.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
