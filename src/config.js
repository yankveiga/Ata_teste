/*
 * ARQUIVO: src/config.js
 * FUNCAO: centraliza configuracoes da aplicacao (diretorios, porta, segredo de sessao e parametros de ambiente).
 * IMPACTO DE MUDANCAS:
 * - Alterar paths pode quebrar carga de estaticos, templates e uploads.
 * - Alterar SECRET/porta impacta sessao de usuarios, execucao local e ambiente de producao.
 */
const path = require("node:path");
const fs = require("node:fs");

// SECAO: resolucao do diretorio-base para montar caminhos absolutos do projeto.

const baseDir = path.resolve(__dirname, "..");
const defaultWorkbookPath = path.join(baseDir, "planilha_presenca.xlsx");
const defaultEnvPath = path.join(baseDir, ".env");

function unquoteEnvValue(value) {
  if (!value) {
    return value;
  }
  const startsWithQuote = value.startsWith('"') || value.startsWith("'");
  const endsWithQuote = value.endsWith('"') || value.endsWith("'");
  if (startsWithQuote && endsWithQuote && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf-8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      return;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) {
      return;
    }

    process.env[key] = unquoteEnvValue(rawValue);
  });
}

loadEnvFile(defaultEnvPath);

function resolveFromBase(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }
  return path.isAbsolute(raw) ? raw : path.join(baseDir, raw);
}

// SECAO: configuracoes centrais (porta, segredo, paths de estaticos/templates/uploads).

const config = {
  appName: "Gestor de Atas",
  baseDir,
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  sessionSecret:
    process.env.SECRET_KEY ||
    "uma-chave-secreta-muito-dificil-de-adivinhar",
  sessionMaxAgeHours: Math.max(
    1,
    Number.parseInt(process.env.SESSION_MAX_AGE_HOURS || "1", 10) || 1,
  ),
  sessionIdleMaxAgeMs: 0,
  presenceWorkbookPath: resolveFromBase(
    process.env.PRESENCE_WORKBOOK_PATH,
    defaultWorkbookPath,
  ),
  bootstrapAdmin: {
    enabled: String(process.env.BOOTSTRAP_ADMIN || "").trim() === "true",
    username: String(process.env.BOOTSTRAP_ADMIN_USERNAME || "").trim(),
    password: String(process.env.BOOTSTRAP_ADMIN_PASSWORD || "").trim(),
    name: String(process.env.BOOTSTRAP_ADMIN_NAME || "").trim() || "Administrador",
  },
  cloudinary: {
    cloudName: String(process.env.CLOUDINARY_CLOUD_NAME || "").trim(),
    apiKey: String(process.env.CLOUDINARY_API_KEY || "").trim(),
    apiSecret: String(process.env.CLOUDINARY_API_SECRET || "").trim(),
    folder: String(process.env.CLOUDINARY_FOLDER || "pet-c3").trim(),
  },
  staticDir: path.join(baseDir, "app", "static"),
  viewsDir: path.join(baseDir, "app", "templates"),
  uploadDir: path.join(baseDir, "app", "static", "uploads"),
};

config.sessionIdleMaxAgeMs = config.sessionMaxAgeHours * 60 * 60 * 1000;

// SECAO: exportacao da configuracao consumida por app, banco e scripts.

module.exports = { config };
