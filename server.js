/*
 * ARQUIVO: server.js
 * FUNCAO: ponto de entrada da aplicacao. Garante o schema do banco, cria o app Express e inicia o servidor HTTP.
 * IMPACTO DE MUDANCAS:
 * - Alterar a ordem de inicializacao pode impedir o banco de preparar tabelas antes das rotas serem usadas.
 * - Alterar host/porta ou forma de start afeta deploy, logs e disponibilidade do sistema.
 */
const { createApp } = require("./src/app");
const { ensureSchema } = require("./src/database");
const { config } = require("./src/config");

// SECAO: bootstrap do servidor HTTP com garantia de schema antes do listen.

async function startServer() {
  ensureSchema();
  console.log("Presença usando planilha local.");

  const app = createApp();

  app.listen(config.port, () => {
    console.log(`Gestor de Atas disponível em http://0.0.0.0:${config.port}`);
  });
}

startServer().catch((error) => {
  console.error("Falha ao iniciar aplicação:", error);
  process.exit(1);
});
