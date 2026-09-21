// Validate params, queries and bodies before the route handler runs.
// Clean values are stored in req.valid and errors use the same JSON format.
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
