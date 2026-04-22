# Guia de Arquitetura - Portal PET C3

Última revisão: **22/04/2026**.

## 1) Visão geral

Arquitetura em camadas:
1. Boot e HTTP: `server.js`
2. Composição do app, middlewares e helpers: `src/app.js`
3. Rotas por domínio: `src/routes/*`
4. Serviços de regra: `src/services/*`
5. Validação: `src/validators/*`
6. Persistência e schema: `src/database.js`
7. UI server-side: `app/templates/*` + `app/static/*`

## 2) Fluxo de request

1. `server.js` inicia app e chama `database.ensureSchema()`.
2. `src/app.js` aplica sessão, CSRF, autenticação, flash e contexto global.
3. Rota do domínio valida entrada e autorização.
4. Regras de negócio e sync de domínio são aplicados.
5. `src/database.js` executa SQL no Postgres (via worker).
6. Resposta em HTML (Nunjucks) ou JSON.

## 3) Módulos de rota

- `src/routes/auth.js`
  - login/logout, home, presença, planner, manutenção de usuários.
- `src/routes/reports.js`
  - metas quinzenais, calendário integrado, ações de atraso e PDF mensal.
- `src/routes/members.js`
  - CRUD administrativo de membros.
- `src/routes/projects.js`
  - CRUD de projetos e vínculos/coordenadores.
- `src/routes/atas.js`
  - criar/baixar/excluir atas.
- `src/routes/almox.js`
  - interface + APIs do almoxarifado.

## 4) Domínio de tarefas (Planner + Relatórios)

- Entidades principais:
  - `planner_task` (operação)
  - `report_week_goal` (visão quinzenal)
- Vínculo de consistência:
  - `report_week_goal.planner_task_id` (1:1 quando tarefa vem do planner)
- Regra de atraso:
  - ciclo automático marca `workflow_state/task_state = missed` após janela operacional (48h)
- Estados críticos:
  - Planner: `status` (`todo`, `in_progress`, `done`) + `workflow_state` (`active`, `missed`)
  - Relatório: `is_completed` + `task_state`
- Ações de recuperação para `missed`:
  - `feito com atraso`
  - `estender prazo`
- Auditoria:
  - `task_audit_log` para criação/edição/status/atraso/extensão/exclusão
  - `report_week_goal_deletion_log` para exclusão de metas concluídas

## 5) Autorização

Helpers centrais em `src/app.js`:
- `requireAuth`, `requireAdminPage`, `requireAdminApi`
- `canManageProject`
- `canManageReportGoal`
- `canDeleteCompletedGoalFromOthers`

Modelo:
- `admin`: gestão total.
- `coordenador`: gestão contextual por projeto.
- `comum`: escopo próprio por módulo.

Fonte única de regra funcional: `MATRIZ_PERMISSOES.md`.

## 6) Sessão, segurança e tempo

- Sessão: `cookie-session`
- CSRF: token de sessão (`ensureCsrfToken` / `verifyCsrf`)
- Expiração por inatividade: `SESSION_MAX_AGE_HOURS`
- Timezone principal: `America/Sao_Paulo`

## 7) Dados e integrações

- Banco: Postgres/Neon (`DATABASE_URL`)
- Presença: XLSX local (`PRESENCE_WORKBOOK_PATH`)
- Mídia: local ou Cloudinary
- PDF: `src/pdf.js`

## 8) Frontend

- Base e navegação: `app/templates/base.html`
- CSS global/layout: `app/static/css/admin_dashboard_style.css`
- CSS compartilhado e componentes: `app/static/css/custom_styles.css`
- Relatórios: `app/templates/reports/index.html`
- Planner: `app/templates/planner/index.html`

## 9) Princípios de evolução

- SQL somente em `src/database.js`.
- Mudança de permissão passa pelos helpers centrais.
- Mudança de schema deve ser idempotente.
- Mudou fluxo funcional -> atualizar `README`, `MAPA_PROJETO`, `MODELAGEM_BANCO`, `MATRIZ_PERMISSOES`.
