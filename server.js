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

// SECAO: bootstrap do servidor HTTP com garantia de schema antes do listen.

async function startServer() {
  database.ensureSchema();

  const defaultWorkbookPath = path.join(config.baseDir, "planilha_presenca.xlsx");
  if (
    config.presenceWorkbookPath !== defaultWorkbookPath &&
    !fs.existsSync(config.presenceWorkbookPath) &&
    fs.existsSync(defaultWorkbookPath)
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
  console.log(`Planilha presença: ${config.presenceWorkbookPath}`);

  const app = createApp();

  app.listen(config.port, () => {
    console.log(`Gestor de Atas disponível em http://0.0.0.0:${config.port}`);
  });
}

startServer().catch((error) => {
  console.error("Falha ao iniciar aplicação:", error);
  process.exit(1);
});
