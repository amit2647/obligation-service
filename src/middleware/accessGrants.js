const pool = require("../config/database");

const runQuery = (text, values) => pool.query(text, values);

/*
 * Merges any active just-in-time grants into the permissions carried by the
 * token.
 *
 * This is read live on every request rather than trusted from the JWT, because
 * permissions are baked in at login and tokens last 8 hours — a revoked grant
 * would otherwise keep working until the token expired.
 *
 * Grants are additive only, so if this lookup fails the request simply proceeds
 * with the token's own permissions. That errs toward denying access.
 */
async function mergeAccessGrants(auth) {
  if (!auth || !auth.userId) {
    return auth;
  }

  try {
    const result = await runQuery(
      `SELECT permission_code
       FROM access_grants
       WHERE user_id = $1
         AND organization_id = $2
         AND revoked_at IS NULL
         AND expires_at > NOW()`,
      [auth.userId, auth.organizationId],
    );

    if (result.rows.length > 0) {
      const granted = result.rows.map((row) => row.permission_code);

      auth.permissions = [...new Set([...auth.permissions, ...granted])];
      auth.grantedPermissions = granted;
    }
  } catch (error) {
    console.error("[AccessGrants] Lookup failed:", error.message);
  }

  return auth;
}

module.exports = { mergeAccessGrants };
