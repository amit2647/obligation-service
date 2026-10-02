function requestLogger(req, res, next) {
  const startedAt = Date.now();

  console.log(`[REQUEST] ${req.method} ${req.originalUrl} started`);

  res.on("finish", () => {
    const duration = Date.now() - startedAt;

    console.log(
      `[REQUEST] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`,
    );
  });

  next();
}

module.exports = requestLogger;
