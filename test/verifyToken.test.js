const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const jwt = require("jsonwebtoken");

const verifyToken = require("../src/middleware/verifyToken");

/*
 * Bearer token verification, copied unchanged into every service. Only
 * Hydra's RS256 tokens are accepted, checked against a stubbed JWKS served
 * from a test key pair. There is no shared secret: HS256 tokens, the old
 * development secret's included, are refused.
 */

const ISSUER = "http://localhost:8080/";
// The development default every service used to verify with (P1 and before).
const OLD_DEV_SECRET = "omnicore-development-secret-change-this";

const hydraKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";

let server;
let env;

before(async () => {
  const jwk = { ...hydraKey.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
  server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  env = {
    HYDRA_JWKS_URL: `http://127.0.0.1:${server.address().port}/.well-known/jwks.json`,
    HYDRA_ISSUER: ISSUER,
    OAUTH_AUDIENCE: "omnicore-api",
  };
});

after(() => server.close());

const CLAIMS = { sub: "7", organizationId: 3, role: "SALES_REP", permissions: ["leads.read"], username: "Asha" };

function hydraToken(overrides = {}, { key = hydraKey.privateKey, kid = KID, audience = ["omnicore-api"], issuer = ISSUER, expiresIn = "5m" } = {}) {
  return jwt.sign({ ...CLAIMS, ...overrides }, key, { algorithm: "RS256", keyid: kid, audience, issuer, ...(expiresIn ? { expiresIn } : {}) });
}


describe("Hydra's tokens (RS256)", () => {
  test("a token signed by Hydra's key, for this audience and issuer, is accepted", async () => {
    const claims = await verifyToken(hydraToken(), env);

    assert.equal(claims.sub, "7");
    assert.equal(claims.organizationId, 3);
    assert.deepEqual(claims.permissions, ["leads.read"]);
  });

  test("the audience must include omnicore-api", async () => {
    await assert.rejects(verifyToken(hydraToken({}, { audience: ["someone-else"] }), env), { name: "JsonWebTokenError" });
    await assert.rejects(verifyToken(hydraToken({}, { audience: [] }), env), { name: "JsonWebTokenError" });
    assert.equal((await verifyToken(hydraToken({}, { audience: ["other", "omnicore-api"] }), env)).sub, "7");
  });

  test("another issuer is refused", async () => {
    await assert.rejects(verifyToken(hydraToken({}, { issuer: "http://evil.example/" }), env), { name: "JsonWebTokenError" });
  });

  test("an expired token is refused as expired", async () => {
    const expired = hydraToken({ exp: Math.floor(Date.now() / 1000) - 60 }, { expiresIn: null });
    await assert.rejects(verifyToken(expired, env), { name: "TokenExpiredError" });
  });

  test("a token signed by another key under Hydra's key id is refused", async () => {
    await assert.rejects(verifyToken(hydraToken({}, { key: strangerKey.privateKey }), env), { name: "JsonWebTokenError" });
  });

  test("an unknown key id, or none, is refused", async () => {
    await assert.rejects(verifyToken(hydraToken({}, { kid: "not-a-key" }), env), { name: "JsonWebTokenError" });
    const noKid = jwt.sign(CLAIMS, hydraKey.privateKey, { algorithm: "RS256", audience: "omnicore-api", issuer: ISSUER });
    await assert.rejects(verifyToken(noKid, env), { name: "JsonWebTokenError" });
  });

  test("without HYDRA_JWKS_URL or HYDRA_ISSUER, RS256 tokens are refused (fail closed)", async () => {
    await assert.rejects(verifyToken(hydraToken(), { ...env, HYDRA_JWKS_URL: "" }), { name: "JsonWebTokenError" });
    await assert.rejects(verifyToken(hydraToken(), { ...env, HYDRA_ISSUER: "" }), { name: "JsonWebTokenError" });
  });
});

describe("the header cannot choose the key or algorithm", () => {
  test("HS256 signed with Hydra's public key as the secret, under Hydra's kid, is refused", async () => {
    const publicPem = hydraKey.publicKey.export({ format: "pem", type: "spki" });
    // jsonwebtoken refuses to sign HS256 with a PEM, so build the token by hand.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: KID })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ ...CLAIMS, iss: ISSUER, aud: ["omnicore-api"], exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
    const signature = crypto.createHmac("sha256", publicPem).update(`${header}.${payload}`).digest("base64url");

    await assert.rejects(verifyToken(`${header}.${payload}.${signature}`, env), { name: "JsonWebTokenError" });
  });

  test("an unsigned token (alg none) is refused", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ ...CLAIMS, iss: "omnicore-identity-service" })).toString("base64url");

    await assert.rejects(verifyToken(`${header}.${payload}.`, env), { name: "JsonWebTokenError" });
  });

  test("garbage is refused", async () => {
    await assert.rejects(verifyToken("not.a.token", env), { name: "JsonWebTokenError" });
  });
});

describe("the shared secret is gone (P2)", () => {
  test("an HS256 token signed with the old development secret is refused", async () => {
    const legacy = jwt.sign({ ...CLAIMS, sub: 7 }, OLD_DEV_SECRET, { algorithm: "HS256", issuer: "omnicore-identity-service", expiresIn: "5m" });
    await assert.rejects(verifyToken(legacy, env), { name: "JsonWebTokenError" });
  });

  test("even with Hydra's issuer, audience and key id, HS256 is refused", async () => {
    const forged = jwt.sign(CLAIMS, OLD_DEV_SECRET, { algorithm: "HS256", issuer: ISSUER, audience: "omnicore-api", keyid: KID, expiresIn: "5m" });
    await assert.rejects(verifyToken(forged, env), { name: "JsonWebTokenError" });
  });
});
