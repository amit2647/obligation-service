const { installedBundle } = require("../services/bundleContext");

/*
 * Profession-bundle routes exist only for an organization with a bundle
 * installed; for any other they answer 404, so an organization without one
 * sees exactly the product it saw before. Puts the bundle on req.bundle.
 */
async function requireBundle(req, res, next) {
  try {
    const token = req.headers.authorization.split(" ")[1];
    const bundle = await installedBundle(req.auth.organizationId, token);

    if (!bundle) {
      return res.status(404).json({ error: "Not enabled: this organization has no profession bundle installed" });
    }

    req.bundle = bundle;
    return next();
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}

module.exports = requireBundle;
