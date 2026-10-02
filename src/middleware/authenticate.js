const jwt = require("jsonwebtoken");

const { mergeAccessGrants } = require("./accessGrants");

async function authenticate(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  const parts = authorization.split(" ");

  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return res.status(401).json({
      error: "Invalid authorization header",
    });
  }

  const token = parts[1];

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET,
      {
        issuer: process.env.JWT_ISSUER || "omnicore-identity-service",
      },
    );

    req.auth = {
      userId: Number(decoded.sub),
      organizationId: Number(decoded.organizationId),
      role: decoded.role,
      permissions: Array.isArray(decoded.permissions)
        ? decoded.permissions
        : [],
    };

    // Live lookup: a revoked grant must stop working immediately, not
    // when the eight-hour token happens to expire.
    await mergeAccessGrants(req.auth);

    next();
  } catch (error) {
    console.error("[AUTH] Invalid JWT:", error.message);

    return res.status(401).json({
      error: "Invalid authentication token",
    });
  }
}

module.exports = authenticate;
