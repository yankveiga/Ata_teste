# Portal PET C3

Sistema interno em **Node.js + Express + Nunjucks** com:
- Gestor de Atas
- Relatórios Quinzenais
- Planner
- Almoxarifado
- Controle de Presença
- Manutenção de Usuários (admin)

Stack atual:
- Banco: **PostgreSQL (Neon)**
- Mídias (foto/logo): **Cloudinary** (opcional, recomendado em produção)
- Deploy: **Render**

## Início rápido (local)

```bash
npm install
# configure o .env
npm run create-user
npm run dev
```

Acesso local: `http://127.0.0.1:3000`

## Variáveis de ambiente

Obrigatórias:
- `DATABASE_URL` (Neon/Postgres)
- `SECRET_KEY`

Recomendadas:
- `NODE_ENV=production|development`
- `PORT=3000`
- `SESSION_MAX_AGE_HOURS=1` (expiração da sessão por inatividade)
- `APP_TIMEZONE=America/Sao_Paulo`
- `PRESENCE_WORKBOOK_PATH=planilha_presenca.xlsx`

Cloudinary (produção):
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER=pet-c3`

Bootstrap opcional de admin:
- `BOOTSTRAP_ADMIN=true|false`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

## Permissões (resumo)

- `admin`: acesso total.
- `coordenador`: acesso contextual no próprio projeto.
- `comum`: acesso operacional limitado.

Detalhe completo: `MATRIZ_PERMISSOES.md`.

## Comandos úteis

```bash
npm run dev        # servidor com watch
npm start          # modo normal
npm run create-user
npm run verify     # verificação automatizada (exige DATABASE_URL)
```

## Deploy no Render (resumo)

- Build Command: `npm install`
- Start Command: `npm start`
- Definir variáveis (`DATABASE_URL`, `SECRET_KEY`, etc.)
- Se usar presença por planilha no Render, manter `PRESENCE_WORKBOOK_PATH` em disco persistente.

## Documentação do projeto

- `MAPA_PROJETO.txt` -> onde alterar cada funcionalidade
- `MATRIZ_PERMISSOES.md` -> fonte única de permissões por módulo/ação
- `GUIA_ARQUITETURA.md` -> visão técnica por camadas
- `MODELAGEM_BANCO.md` -> schema e relacionamentos reais
- `RUNBOOK_PRODUCAO.md` -> operação, backup, incidentes
- `DOCUMENTACAO_TECNICA_COMPLETA.md` -> manutenção e evolução
