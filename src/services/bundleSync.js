const crypto = require("crypto");

/*
 * How a bundle install treats each item it ships (a service, a role, an email
 * template…), so that upgrades keep a firm's own edits.
 *
 * Copied into every service that has a bundle install endpoint, like the auth
 * middleware; keep the copies identical. Each row a bundle installed records
 * `source_checksum`, the hash of the content as shipped. Comparing the row's
 * current content with it tells whether the firm has edited the row since.
 *
 *   insert     — no such row yet
 *   unchanged  — the row already holds exactly what is shipped
 *   update     — the firm has not touched it: take the shipped content
 *   keep       — the firm edited it: leave it, and flag the newer version when
 *                the bundle's content has moved on (update_available_version)
 */

// JSON with sorted keys, so equal content always hashes the same.
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value === undefined ? null : value);
}

function checksum(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

/*
 * existing: null, or { content, sourceChecksum } for the row already there.
 * shipped:  the content the bundle ships for it.
 */
function decide(existing, shipped) {
  const shippedChecksum = checksum(shipped);

  if (!existing) {
    return { action: "insert", shippedChecksum, flag: false };
  }

  const current = checksum(existing.content);

  if (current === shippedChecksum) {
    return { action: "unchanged", shippedChecksum, flag: false };
  }

  if (existing.sourceChecksum && current === existing.sourceChecksum) {
    return { action: "update", shippedChecksum, flag: false };
  }

  // Edited by the firm (or a pre-existing row the bundle adopted). Flag only
  // when the bundle now ships something other than what this row came from.
  return { action: "keep", shippedChecksum, flag: existing.sourceChecksum !== shippedChecksum };
}

module.exports = { canonical, checksum, decide };
