// One place where request input is checked. Each route declares what it accepts (see
// ./schemas.js); this runs before the handler, rejects anything malformed with a
// consistent response, and hands the handler clean, typed values on `req.valid`.
//
// Response on failure:
//   400 { error: "The event must end after it starts", details: [{ field, message }] }
// `error` is the first problem, worded for people — the frontend shows it as-is.
// A malformed id in the URL names nothing, so it's a 404, the same as a missing record.
// Unknown body fields are dropped, so a client can't slip in e.g. `organizerId`.
function validate(schemas) {
  return (req, res, next) => {
    const valid = {};
    for (const part of ["params", "query", "body"]) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        const [first] = result.error.issues;
        const status = first.params?.status ?? (part === "params" ? 404 : 400);
        if (status === 404) return res.status(404).json({ error: first.message });
        return res.status(status).json({
          error: first.message,
          details: result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
        });
      }
      valid[part] = result.data;
    }
    req.valid = valid;
    next();
  };
}

module.exports = { validate };
