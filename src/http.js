const crypto = require("node:crypto");

function requestContextMiddleware(req, res, next) {
  req.requestId = crypto.randomUUID();
  res.locals.requestId = req.requestId;
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

function logError(req, message, error) {
  const prefix = `[requestId=${req.requestId || "unknown"}]`;
  console.error(`${prefix} ${message}`, error);
}

function sendApiError(req, res, status, message, details = null) {
  const body = {
    error: message,
    requestId: req.requestId || null,
  };
  if (details) {
    body.details = details;
  }
  return res.status(status).json(body);
}

module.exports = {
  requestContextMiddleware,
  logError,
  sendApiError,
};
