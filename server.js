const { createApp } = require("./src/app");
const { ensureSchema } = require("./src/database");
const { config } = require("./src/config");

ensureSchema();

const app = createApp();

app.listen(config.port, () => {
  console.log(`Gestor de Atas disponível em http://0.0.0.0:${config.port}`);
});
