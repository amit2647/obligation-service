const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");

/*
 * Verifies a bearer token from Ory Hydra and returns its claims. Copied
 * unchanged into every service, with the same test beside each copy; keep the
 * copies identical.
 *
 * Only Hydra's tokens are accepted: RS256, signed by a key from Hydra's JWKS
 * (HYDRA_JWKS_URL), issued by HYDRA_ISSUER, for an audience that includes
 * OAUTH_AUDIENCE. There is no shared signing secret any more (auth-hardening
 * P2): any other algorithm, including the old HS256 tokens, is refused before
 * a key is looked up. Failures throw jsonwebtoken's own errors, so the callers'
 * error handling is unchanged.
 */

const DEFAULT_AUDIENCE = "omnicore-api";

let keys = null;
let keysFor = null;

function hydraKeys(jwksUri) {
  if (!keys || keysFor !== jwksUri) {
    keys = jwksClient({
      jwksUri,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000,
      // An unknown kid (a rotated key) refetches, at most this often.
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      timeout: 5000,
    });
    keysFor = jwksUri;
  }
  return keys;
}

function invalid(message) {
  return new jwt.JsonWebTokenError(message);
}

async function verifyToken(token, env = process.env) {
  const jwksUri = env.HYDRA_JWKS_URL;
  const issuer = env.HYDRA_ISSUER;

  if (!jwksUri || !issuer) {
    throw invalid("HYDRA_JWKS_URL or HYDRA_ISSUER is not set");
  }

  const decoded = jwt.decode(token, { complete: true });

  if (!decoded || !decoded.header) {
    throw invalid("malformed token");
  }

  if (decoded.header.alg !== "RS256") {
    throw invalid("only RS256 tokens are accepted");
  }

  if (!decoded.header.kid) {
    throw invalid("token has no key id");
  }

  let publicKey;

  try {
    publicKey = (await hydraKeys(jwksUri).getSigningKey(decoded.header.kid)).getPublicKey();
  } catch {
    throw invalid("signing key not found");
  }

  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer,
    audience: env.OAUTH_AUDIENCE || DEFAULT_AUDIENCE,
  });
}

module.exports = verifyToken;
