# Portal PET C3

Sistema interno em **Node.js + Express + Nunjucks** para:
- Gestor de Atas
- Relatórios Quinzenais (com calendário integrado)
- Planner
- Almoxarifado
- Controle de Presença
- Manutenção de Usuários (admin)

Stack atual:
- Banco: **PostgreSQL (Neon)**
- Deploy: **Render**
- Mídias (foto/logo): **Cloudinary** (recomendado em produção)

## Início rápido (local)

```bash
npm install
cp .env.example .env
# edite DATABASE_URL e SECRET_KEY
npm run create-user
npm run dev
```

Acesso local: `http://127.0.0.1:3000`

## Variáveis de ambiente

Obrigatórias:
- `DATABASE_URL`
- `SECRET_KEY`

Recomendadas:
- `NODE_ENV=development|production`
- `PORT=3000`
- `SESSION_MAX_AGE_HOURS=1`
- `APP_TIMEZONE=America/Sao_Paulo`
- `PRESENCE_WORKBOOK_PATH=planilha_presenca.xlsx`

Cloudinary:
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER=pet-c3`

Bootstrap opcional de admin:
- `BOOTSTRAP_ADMIN=true|false`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

## Regras operacionais importantes

- Tarefa com data/hora passada não pode ser criada.
- Status inicial da tarefa é automático pela data:
  - agora/atrasada: `Em Execução`
  - futura: `A Fazer`
- Relatórios e Planner usam vínculo por tarefa (`planner_task_id`) para manter consistência.
- Tarefas podem migrar para **Não feitas (48h)** e então seguem fluxo controlado (feito com atraso / estender prazo).
- Auditoria de tarefas em `task_audit_log`.

## Permissões (resumo)

- `admin`: gestão total.
- `coordenador`: gestão contextual no(s) projeto(s) que coordena.
- `comum`: escopo próprio por módulo.

Fonte de verdade: `MATRIZ_PERMISSOES.md`.

## Comandos úteis

```bash
npm run dev
npm start
npm run create-user
npm run verify
```

`npm run verify` exige `DATABASE_URL` válido.

## Deploy no Render (resumo)

- Build Command: `npm install`
- Start Command: `npm start`
- Definir variáveis de ambiente do app
- Se usar presença via planilha no Render, manter caminho persistente para `PRESENCE_WORKBOOK_PATH`

## Documentação

- `MAPA_PROJETO.txt` -> onde alterar cada funcionalidade
- `MATRIZ_PERMISSOES.md` -> permissões por ação
- `GUIA_ARQUITETURA.md` -> visão técnica por camadas
- `MODELAGEM_BANCO.md` -> schema e relações
- `RUNBOOK_PRODUCAO.md` -> deploy, backup, incidentes
- `DOCUMENTACAO_TECNICA_COMPLETA.md` -> manutenção e checklist
