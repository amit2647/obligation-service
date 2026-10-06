/*
 * The organization's installed profession bundle, as bundle-service shares
 * it (GET /bundles/installed): vocabulary, profile schemas, identifiers,
 * people roles. Asked with the caller's own token, like every other
 * cross-service call here.
 *
 * Installed bundles are cached briefly per organization. "No bundle" is
 * never cached, so an organization sees its bundle as soon as an install
 * finishes.
 */

const BUNDLE_SERVICE_URL = process.env.BUNDLE_SERVICE_URL || "http://bundle-service:4008";
const TTL_MS = 60 * 1000;

const cache = new Map();

async function installedBundle(organizationId, token) {
  const cached = cache.get(organizationId);

  if (cached && cached.expires > Date.now()) {
    return cached.bundle;
  }

  const response = await fetch(`${BUNDLE_SERVICE_URL}/bundles/installed`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10 * 1000),
  });

  if (!response.ok) {
    const error = new Error("The organization's profession bundle could not be read");
    error.statusCode = 503;
    throw error;
  }

  const { bundle } = await response.json();

  if (bundle) {
    cache.set(organizationId, { bundle, expires: Date.now() + TTL_MS });
  }

  return bundle || null;
}

function forget(organizationId) {
  cache.delete(organizationId);
}

module.exports = { installedBundle, forget };
