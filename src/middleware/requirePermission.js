function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    if (!req.auth.permissions.includes(permission)) {
      return res.status(403).json({
        error: "Insufficient permissions",
        requiredPermission: permission,
      });
    }

    next();
  };
}

module.exports = requirePermission;
