// E2E test server: the REAL Express app (real routes, real validation, real Prisma
// transactions, real MySQL) with only Entra token verification replaced.
// Safety: a "token" is just the adObjectId of a test user, and ONLY users whose
// adObjectId starts with "e2e-" can be used — real accounts can't be impersonated.
// Listens on 127.0.0.1 only.
const path = require("path");
const APP_DIR = process.env.APP_DIR;
const PORT = Number(process.env.PORT || 3998);

if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;

async function main() {
  if (!process.env.DATABASE_URL) {
    require(path.join(APP_DIR, "node_modules/dotenv")).config({ path: path.join(APP_DIR, ".env") });
    await require(path.join(APP_DIR, "src/config/keyvault")).loadSecrets();
  }

  const auth = require(path.join(APP_DIR, "src/middleware/auth"));
  const { asyncHandler } = require(path.join(APP_DIR, "src/middleware/asyncHandler"));
  const { prisma } = require(path.join(APP_DIR, "src/services/prisma"));

  auth.requireAuth = asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Missing bearer token" });
    const token = header.slice(7);
    if (!token.startsWith("e2e-")) return res.status(401).json({ error: "Invalid token" });
    const user = await prisma.user.findUnique({ where: { adObjectId: token } });
    if (!user) return res.status(401).json({ error: "Invalid token" });
    req.user = { oid: user.adObjectId, id: user.id, role: user.role, email: user.email, displayName: user.displayName };
    next();
  });

  const { createApp } = require(path.join(APP_DIR, "src/app"));
  createApp().listen(PORT, "127.0.0.1", () => console.log(`e2e server (${APP_DIR}) on 127.0.0.1:${PORT}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
