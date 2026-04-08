/*
 * ARQUIVO: src/config.js
 * FUNCAO: centraliza configuracoes da aplicacao (diretorios, porta, segredo de sessao e caminho do banco).
 * IMPACTO DE MUDANCAS:
 * - Alterar paths pode quebrar carga de estaticos, templates, uploads e acesso ao SQLite.
 * - Alterar SECRET/porta impacta sessao de usuarios, execucao local e ambiente de producao.
 */
const path = require("node:path");

// SECAO: resolucao do diretorio-base para montar caminhos absolutos do projeto.

const baseDir = path.resolve(__dirname, "..");

// SECAO: configuracoes centrais (porta, segredo, paths de estaticos/templates/uploads/banco).

const config = {
  appName: "Gestor de Atas",
  baseDir,
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  sessionSecret:
    process.env.SECRET_KEY ||
    "uma-chave-secreta-muito-dificil-de-adivinhar",
  databasePath:
    process.env.DATABASE_PATH ||
    path.join(baseDir, "instance", "ata.sqlite3"),
  staticDir: path.join(baseDir, "app", "static"),
  viewsDir: path.join(baseDir, "app", "templates"),
  uploadDir: path.join(baseDir, "app", "static", "uploads"),
};

// SECAO: exportacao da configuracao consumida por app, banco e scripts.

module.exports = { config };
