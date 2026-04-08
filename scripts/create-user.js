/*
 * ARQUIVO: scripts/create-user.js
 * FUNCAO: utilitario de linha de comando para criar usuarios no banco local (admin/comum).
 * IMPACTO DE MUDANCAS:
 * - Alterar validacoes de entrada impacta a seguranca e qualidade dos dados cadastrados.
 * - Alterar argumentos CLI exige atualizar documentacao e processo operacional da equipe.
 */
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

const bcrypt = require("bcryptjs");

const database = require("../src/database");

// SECAO: parse simples de argumentos CLI (--username, --password, etc.).

function parseArgument(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

// SECAO: fluxo principal interativo para criacao de usuario no banco local.

async function main() {
  database.ensureSchema();

  let username = parseArgument("--username");
  let password = parseArgument("--password");
  let name = parseArgument("--name");
  let role = parseArgument("--role");

  if (!username || !password || !name) {
    const rl = readline.createInterface({ input, output });

    try {
      if (!name) {
        name = (await rl.question("Nome completo: ")).trim();
      }

      if (!username) {
        username = (await rl.question("Nome de usuário: ")).trim();
      }

      if (!password) {
        password = (await rl.question("Senha: ")).trim();
      }

      if (!role) {
        role = (await rl.question("Perfil (admin/comum): ")).trim();
      }
    } finally {
      rl.close();
    }
  }

  if (!name || !username || !password) {
    console.error("Nome, usuário e senha são obrigatórios.");
    process.exitCode = 1;
    return;
  }

  role = role === "common" || role === "comum" ? "common" : "admin";

  if (database.getUserByUsername(username)) {
    console.error(`Erro: Usuário "${username}" já existe.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  database.createUser(username, passwordHash, { name, role });
  console.log(`Usuário "${username}" criado com sucesso como ${role}.`);
}

main().catch((error) => {
  console.error("Erro ao criar usuário:", error);
  process.exitCode = 1;
});
