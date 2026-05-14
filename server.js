/*
 * ARQUIVO: server.js
 * FUNCAO: ponto de entrada da aplicacao. Garante o schema do banco, cria o app Express e inicia o servidor HTTP.
 * IMPACTO DE MUDANCAS:
 * - Alterar a ordem de inicializacao pode impedir o banco de preparar tabelas antes das rotas serem usadas.
 * - Alterar host/porta ou forma de start afeta deploy, logs e disponibilidade do sistema.
 */
const { createApp } = require("./src/app");
const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");
const database = require("./src/database");
const { config } = require("./src/config");
const { createNotificationService } = require("./src/services/notificationService");

// SECAO: bootstrap do servidor HTTP com garantia de schema antes do listen.

// FUNCAO: sleep.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// FUNCAO: isRetryableDatabaseStartupError.
function isRetryableDatabaseStartupError(error) {
  if (!error) {
    return false;
  }
  const code = String(error.code || "").toUpperCase();
  const message = String(error.message || "").toLowerCase();
  return (
    code === "XX000"
    || code === "57P01"
    || code === "53300"
    || code === "08006"
    || message.includes("control plane request failed")
    || message.includes("terminating connection due to administrator command")
    || message.includes("connection terminated unexpectedly")
    || message.includes("timeout")
    || message.includes("econnreset")
  );
}

// FUNCAO: ensureSchemaWithRetry.
async function ensureSchemaWithRetry(maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      database.ensureSchema();
      return;
    } catch (error) {
      const canRetry = isRetryableDatabaseStartupError(error) && attempt < maxAttempts;
      if (!canRetry) {
        throw error;
      }
      const waitMs = Math.min(1000 * (2 ** (attempt - 1)), 8000);
      console.warn(
        `Banco indisponivel na inicializacao (tentativa ${attempt}/${maxAttempts}). Nova tentativa em ${waitMs}ms...`,
      );
      await sleep(waitMs);
    }
  }
}

async function startServer() {
  await ensureSchemaWithRetry();

  const defaultWorkbookPath = path.join(config.baseDir, "planilha_presenca.xlsx");
  if (
    config.presenceWorkbookPath !== defaultWorkbookPath
    && !fs.existsSync(config.presenceWorkbookPath)
    && fs.existsSync(defaultWorkbookPath)
  ) {
    fs.mkdirSync(path.dirname(config.presenceWorkbookPath), { recursive: true });
    fs.copyFileSync(defaultWorkbookPath, config.presenceWorkbookPath);
  }

  if (config.bootstrapAdmin.enabled) {
    const { username, password, name } = config.bootstrapAdmin;
    if (username && password && !database.getUserByUsername(username)) {
      const passwordHash = bcrypt.hashSync(password, 12);
      database.createUser(username, passwordHash, { name, role: "admin" });
      console.log(`Admin bootstrap criado: ${username}`);
    }
  }

  console.log("Banco: PostgreSQL/Neon");
  console.log(`Planilha presenca: ${config.presenceWorkbookPath}`);

  const app = createApp();
  const notificationService = createNotificationService({ database, config });
  const notificationSweepIntervalMs = Math.max(
    30_000,
    Number(process.env.NOTIFICATION_SWEEP_INTERVAL_MS || 300000),
  );
  notificationService.startDeadlineScheduler({
    intervalMs: notificationSweepIntervalMs,
    runOnStart: true,
  });

  const server = app.listen(config.port, () => {
    console.log(`Gestor de Atas disponivel em http://0.0.0.0:${config.port}`);
  });

  let shuttingDown = false;
  const gracefulShutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Sinal ${signal} recebido. Encerrando servidor...`);
    server.close(() => {
      console.log("Servidor HTTP encerrado.");
      process.exit(0);
    });

    const forceExitTimer = setTimeout(() => {
      console.warn("Encerramento forcado por timeout.");
      process.exit(0);
    }, 10000);
    if (typeof forceExitTimer.unref === "function") {
      forceExitTimer.unref();
    }
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

startServer().catch((error) => {
  console.error("Falha ao iniciar aplicacao:", error);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("Erro nao tratado (uncaughtException):", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Promise rejeitada sem tratamento (unhandledRejection):", reason);
});