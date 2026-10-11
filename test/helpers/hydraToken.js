const crypto = require("crypto");
const http = require("http");
const jwt = require("jsonwebtoken");

/*
 * Tokens as Ory Hydra issues them, for unit tests (copied unchanged into
 * every service; keep the copies identical). A test key pair is served as a
 * JWKS on a local port, and HYDRA_JWKS_URL, HYDRA_ISSUER and OAUTH_AUDIENCE
 * point verifyToken at it. Wait for `ready` (before(() => hydra.ready))
 * before the first request: the port is known once the server listens.
 */

const ISSUER = "http://hydra.unit-test/";
const AUDIENCE = "omnicore-api";
const KID = "unit-test-key";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

process.env.HYDRA_ISSUER = ISSUER;
process.env.OAUTH_AUDIENCE = AUDIENCE;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ keys: [jwk] }));
});

const ready = new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    process.env.HYDRA_JWKS_URL = `http://127.0.0.1:${server.address().port}/.well-known/jwks.json`;
    resolve();
  });
});

// Never keeps a test process alive.
server.unref();

// claims: { sub, organizationId, role, permissions, ... }; sub becomes the
// token's subject, as Hydra's string user id.
function sign(claims = {}, { expiresIn = "5m", audience = [AUDIENCE], issuer = ISSUER, key = privateKey, kid = KID } = {}) {
  const { sub = 1, ...rest } = claims;
  return jwt.sign(rest, key, {
    algorithm: "RS256",
    keyid: kid,
    subject: String(sub),
    audience,
    issuer,
    ...(expiresIn ? { expiresIn } : {}),
  });
}

module.exports = { sign, ready, ISSUER, AUDIENCE, KID, privateKey, publicKey };
