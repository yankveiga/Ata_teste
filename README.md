# Portal PET C3

Aplicacao interna em Node.js + Express + Nunjucks para operacao do PET C3.

Ultima revisao: 14/05/2026

## O que o sistema faz

- Relatorios quinzenais (modulo principal)
- Planner integrado ao relatorio
- Atas (com geracao de PDF)
- Almoxarifado (estoque, patrimonio, emprestimos)
- Presenca via planilha XLSX
- Mensagens privadas entre usuarios
- Espacos de escrita (geral e privado de tutor)
- CRUD de membros e projetos
- Manutencao de usuarios (area administrativa)

Observacao: o modulo PETrello nao faz parte da versao atual.

## Stack atual

- Backend: Node.js + Express
- Views: Nunjucks
- Banco: PostgreSQL (Neon)
- Sessao: cookie-session
- Uploads: local ou Cloudinary
- PDF: PDFKit
- Deploy alvo: Render

## Requisitos

- Node.js 18+
- NPM 9+
- Banco PostgreSQL acessivel por `DATABASE_URL`

## Como rodar localmente

1. Instale dependencias:

```bash
npm install
```

2. Crie `.env` na raiz (exemplo minimo):

```env
NODE_ENV=development
PORT=3000
SECRET_KEY=troque-esta-chave
DATABASE_URL=postgresql://USUARIO:SENHA@HOST/DB?sslmode=require
SESSION_MAX_AGE_HOURS=1
APP_TIMEZONE=America/Sao_Paulo
PRESENCE_WORKBOOK_PATH=planilha_presenca.xlsx
APP_BASE_URL=http://127.0.0.1:3000
```

3. (Opcional) crie usuario inicial:

```bash
npm run create-user
```

4. Inicie a aplicacao:

```bash
npm run dev
```

URL local padrao: `http://127.0.0.1:3000`

## Scripts

```bash
npm run dev
npm start
npm run create-user
npm run verify
npm run notify:run-once
```

## Variaveis de ambiente

### Obrigatorias

- `DATABASE_URL`
- `SECRET_KEY`

### Recomendadas

- `NODE_ENV`
- `PORT`
- `SESSION_MAX_AGE_HOURS`
- `APP_BASE_URL`
- `APP_TIMEZONE`
- `REPORTS_TIMEZONE`
- `PRESENCE_WORKBOOK_PATH`

### Bootstrap inicial (opcional)

- `BOOTSTRAP_ADMIN`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

### Upload (opcional)

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`

### Email/Notificacoes (opcional)

- `EMAIL_PROVIDER` (padrao: `brevo`)
- `BREVO_API_KEY`
- `EMAIL_FROM`
- `EMAIL_FROM_NAME`
- `EMAIL_REPLY_TO`
- `NOTIFICATION_SWEEP_INTERVAL_MS`

### Ajustes tecnicos (opcional)

- `REQUEST_LOGS=1` (liga logs HTTP)
- `DB_SYNC_QUERY_TIMEOUT_MS`
- `PG_CONNECTION_TIMEOUT_MS`

## Regras importantes

- Fuso principal: `America/Sao_Paulo`
- Pagina inicial autenticada: `/relatorios`
- Healthcheck: `/healthz`
- Sincronizacao Relatorio x Planner via `report_week_goal.planner_task_id`

## Documentacao do projeto (enxuta)

- [GUIA_OPERACAO.md](./GUIA_OPERACAO.md) - deploy, incidentes, backup e restore
- [GUIA_DESENVOLVIMENTO.md](./GUIA_DESENVOLVIMENTO.md) - arquitetura e alteracao segura
- [GUIA_DADOS_E_PERMISSOES.md](./GUIA_DADOS_E_PERMISSOES.md) - modelagem e acesso
