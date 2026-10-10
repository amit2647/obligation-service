const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");

/*
 * Verifies a bearer token and returns its claims. Copied unchanged into every
 * service, with the same test beside each copy; keep the copies identical.
 *
 * Two kinds are accepted while sign-in moves onto Ory Hydra (auth-hardening
 * P1), each with its own pinned algorithm, key and checks:
 *
 *   Hydra     RS256 only, a key from Hydra's JWKS (HYDRA_JWKS_URL), `iss`
 *             HYDRA_ISSUER and `aud` including OAUTH_AUDIENCE
 *   legacy    HS256 only, JWT_SECRET and JWT_ISSUER, as before (removed in P2)
 *
 * The token header only picks which of the two to try. It never chooses the
 * algorithm or the key: an HS256 token always goes to JWT_SECRET, so an RSA
 * public key can never be used as an HMAC secret, and an RS256 token is only
 * checked against Hydra's keys. Failures throw jsonwebtoken's own errors, so
 * the callers' error handling is unchanged.
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

async function verifyHydraToken(token, header, env) {
  const jwksUri = env.HYDRA_JWKS_URL;
  const issuer = env.HYDRA_ISSUER;

  if (!jwksUri || !issuer) {
    throw invalid("Hydra tokens are not accepted: HYDRA_JWKS_URL or HYDRA_ISSUER is not set");
  }

  if (!header.kid) {
    throw invalid("token has no key id");
  }

  let publicKey;

  try {
    publicKey = (await hydraKeys(jwksUri).getSigningKey(header.kid)).getPublicKey();
  } catch {
    throw invalid("signing key not found");
  }

  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer,
    audience: env.OAUTH_AUDIENCE || DEFAULT_AUDIENCE,
  });
}

function verifyLegacyToken(token, env) {
  if (!env.JWT_SECRET) {
    throw invalid("JWT_SECRET is not configured");
  }

  return jwt.verify(token, env.JWT_SECRET, {
    algorithms: ["HS256"],
    issuer: env.JWT_ISSUER || "omnicore-identity-service",
  });
}

async function verifyToken(token, env = process.env) {
  const decoded = jwt.decode(token, { complete: true });

  if (!decoded || !decoded.header) {
    throw invalid("malformed token");
  }

  if (decoded.header.alg === "RS256") {
    return verifyHydraToken(token, decoded.header, env);
  }

  return verifyLegacyToken(token, env);
}

module.exports = verifyToken;
