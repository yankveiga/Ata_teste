const path = require("node:path");

const baseDir = path.resolve(__dirname, "..");

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

module.exports = { config };
