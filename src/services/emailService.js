/*
 * ARQUIVO: src/services/emailService.js
 * FUNCAO: envio transacional de e-mails via Brevo (HTTP API).
 */
const https = require("node:https");

function normalizeEmail(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return null;
  }
  return text;
}

function isValidEmail(value) {
  const normalized = normalizeEmail(value);
  if (!normalized) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function createEmailService(config) {
  const provider = String(config?.email?.provider || "brevo").trim().toLowerCase();
  const apiKey = String(config?.email?.brevoApiKey || "").trim();
  const from = String(config?.email?.from || "").trim();
  const fromName = String(config?.email?.fromName || "").trim();
  const replyTo = String(config?.email?.replyTo || "").trim();
  const enabled = provider === "brevo" && Boolean(apiKey && from);

  function buildSender() {
    const sender = { email: from };
    if (fromName) {
      sender.name = fromName;
    }
    return sender;
  }

  function sendWithBrevo({ to, subject, text, html }) {
    return new Promise((resolve, reject) => {
      const textContent = String(text || "").trim();
      const htmlContent = String(html || "").trim();
      const payload = {
        sender: buildSender(),
        to: [{ email: to }],
        subject: String(subject || "").trim(),
      };
      if (htmlContent) {
        payload.htmlContent = htmlContent;
      } else {
        payload.textContent = textContent;
      }
      if (replyTo) {
        payload.replyTo = { email: replyTo };
      }
      const body = JSON.stringify(payload);

      const request = https.request(
        {
          method: "POST",
          hostname: "api.brevo.com",
          path: "/v3/smtp/email",
          headers: {
            accept: "application/json",
            "api-key": apiKey,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (response) => {
          let payload = "";
          response.on("data", (chunk) => {
            payload += chunk;
          });
          response.on("end", () => {
            const status = Number(response.statusCode || 0);
            if (status >= 200 && status < 300) {
              resolve({ ok: true, status });
              return;
            }
            reject(new Error(`Brevo respondeu com status ${status}: ${payload}`));
          });
        },
      );

      request.on("timeout", () => {
        request.destroy(new Error("Tempo limite ao enviar e-mail (Brevo)."));
      });
      request.on("error", reject);
      request.write(body);
      request.end();
    });
  }

  async function sendEmail({ to, subject, text, html }) {
    const recipient = normalizeEmail(to);
    if (!enabled) {
      return { ok: false, skipped: true, reason: "email_disabled" };
    }
    if (!isValidEmail(recipient)) {
      return { ok: false, skipped: true, reason: "invalid_recipient" };
    }
    if (!String(subject || "").trim()) {
      return { ok: false, skipped: true, reason: "missing_subject" };
    }
    if (!String(text || "").trim()) {
      return { ok: false, skipped: true, reason: "missing_text" };
    }

    if (provider === "brevo") {
      await sendWithBrevo({ to: recipient, subject, text, html });
      return { ok: true, skipped: false };
    }

    return { ok: false, skipped: true, reason: "unsupported_provider" };
  }

  return {
    enabled,
    isValidEmail,
    normalizeEmail,
    sendEmail,
  };
}

module.exports = { createEmailService, isValidEmail, normalizeEmail };
