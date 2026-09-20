# Portal PET C3

Aplicacao interna em Node.js + Express + Nunjucks para centralizar rotinas do PET C3: relatorios, planner, atas, almoxarifado, presenca, mensagens e manutencao administrativa.

Ultima revisao: 19/09/2026

## Modulos principais

- Relatorios quinzenais por membro e projeto.
- Planner integrado aos relatorios.
- Sistema de advertencias por membro, com auditoria e acompanhamento de 365 dias.
- Atas com geracao de PDF.
- Almoxarifado: estoque, patrimonio, retiradas, emprestimos e historico.
- Presenca por eventos: atividades, ouvintes, importacao CSV, check-in e exportacao.
- Mensagens privadas e conversas administrativas somente leitura.
- Escrita geral e escrita privada de tutor.
- CRUD de membros, projetos e usuarios.

Observacao: o modulo PETrello nao faz parte da versao atual.

## Stack

- Backend: Node.js + Express
- Templates: Nunjucks
- Banco: PostgreSQL, normalmente Neon
- Sessao: `cookie-session`
- Uploads: local ou Cloudinary
- PDF: PDFKit
- XLSX/CSV: `exceljs` e geracao manual de CSV
- Deploy atual/alvo: Render, podendo rodar localmente com tunel temporario

## Requisitos

- Node.js 18+
- NPM 9+
- PostgreSQL acessivel por `DATABASE_URL`

## Como rodar localmente

1. Instale dependencias:

```bash
npm install
```

2. Crie um `.env` na raiz. Exemplo minimo:

```env
NODE_ENV=development
PORT=3000
SECRET_KEY=troque-esta-chave
DATABASE_URL=postgresql://USUARIO:SENHA@HOST/DB?sslmode=verify-full
SESSION_MAX_AGE_HOURS=1
APP_TIMEZONE=America/Sao_Paulo
REPORTS_TIMEZONE=America/Sao_Paulo
APP_BASE_URL=http://127.0.0.1:3000
```

3. Opcionalmente, crie um usuario inicial:

```bash
npm run create-user
```

4. Inicie a aplicacao:

```bash
npm run dev
```

URL local padrao:

```text
http://127.0.0.1:3000
```

## Scripts

```bash
npm run dev
npm start
npm run create-user
npm run verify
npm run notify:run-once
```

`npm run verify` carrega a aplicacao e valida fluxos principais. Use preferencialmente uma base de teste.

## Rotas importantes

- `/login`: entrada do sistema.
- `/relatorios`: pagina inicial autenticada.
- `/planner`: planner.
- `/home`: atas recentes.
- `/atas/nova`: criacao de ata.
- `/almoxarifado`: almoxarifado.
- `/presenca/check-in`: check-in por cracha.
- `/presenca/eventos`: atividades de presenca.
- `/presenca/ouvintes`: cadastro/importacao de ouvintes.
- `/mensagens`: chat.
- `/projects`: projetos.
- `/members`: membros.
- `/manutencao-usuarios`: usuarios e senhas.
- `/healthz`: healthcheck.

## Regras importantes

- Fuso principal: `America/Sao_Paulo`.
- Pagina inicial autenticada: `/relatorios`.
- Usuarios sao desativados logicamente, nao apagados fisicamente, para preservar historico.
- Membros inativos deixam de aparecer nas listas operacionais.
- Relatorios quinzenais possuem tolerancia de 2 dias:
  - primeira quinzena: ate o fim do dia 17;
  - segunda quinzena: ate o fim do dia 02 do mes seguinte.
- O planner e os relatorios se conectam por `report_week_goal.planner_task_id`.
- Advertencias sao historicas e append-only: nao apagar historico.
- Presenca usa PostgreSQL como fonte de verdade; CSV local e apenas contingencia.
- Ouvintes de presenca usam `cracha,nome,cpf,email`.

## Performance

- `src/database.js` expoe API sincrona para as rotas, mas executa SQL em worker interno.
- Evite adicionar consultas em middleware global.
- Evite consultas dentro de loops quando uma query com join resolver.
- Telas grandes devem carregar apenas o necessario para a aba/visao atual.
- Assets estaticos ficam em `/static` e devem passar antes de middlewares caros.
- Para investigar lentidao:

```env
REQUEST_LOGS=1
```

Depois veja os tempos das rotas nos logs e compare com a latencia do banco.

## Variaveis de ambiente

Obrigatorias:

- `DATABASE_URL`
- `SECRET_KEY`

Recomendadas:

- `NODE_ENV`
- `PORT`
- `SESSION_MAX_AGE_HOURS`
- `APP_BASE_URL`
- `APP_TIMEZONE`
- `REPORTS_TIMEZONE`

Bootstrap opcional:

- `BOOTSTRAP_ADMIN`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

Uploads opcionais:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`

Email/notificacoes opcionais:

- `EMAIL_PROVIDER`
- `BREVO_API_KEY`
- `EMAIL_FROM`
- `EMAIL_FROM_NAME`
- `EMAIL_REPLY_TO`
- `NOTIFICATION_SWEEP_INTERVAL_MS`

Ajustes tecnicos opcionais:

- `REQUEST_LOGS`
- `DB_SYNC_QUERY_TIMEOUT_MS`
- `PG_CONNECTION_TIMEOUT_MS`

## Hospedagem temporaria local

Para expor o app local temporariamente:

```powershell
npm start
```

Em outro terminal:

```powershell
.\cloudflared-windows-amd64.exe tunnel --url http://localhost:3000
```

O Cloudflare gera uma URL temporaria `trycloudflare.com`. Mantenha o terminal aberto enquanto precisar do tunel.

## Documentacao

Leia os guias em `docs/` antes de mexer:

- [GUIA_DESENVOLVIMENTO.md](./docs/GUIA_DESENVOLVIMENTO.md): arquitetura, mapa de arquivos e como alterar com seguranca.
- [GUIA_DADOS_E_PERMISSOES.md](./docs/GUIA_DADOS_E_PERMISSOES.md): tabelas, regras, permissoes e advertencias.
- [GUIA_OPERACAO.md](./docs/GUIA_OPERACAO.md): deploy, ambiente, incidentes, backup, presenca em evento e tunel local.

## Antes de compartilhar a pasta

Nao envie:

- `.env`
- `node_modules/`
- arquivos `.log`
- dumps/backups de banco
- CSVs ou planilhas com dados reais
- uploads com dados pessoais
- tokens, chaves privadas ou credenciais

Antes de entregar para outra pessoa:

```bash
npm run verify
git status --short
```
