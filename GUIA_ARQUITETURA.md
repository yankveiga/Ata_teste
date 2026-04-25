# Guia de Arquitetura - Portal PET C3

Última revisão: **25/04/2026**.

## 1) Visão geral

Arquitetura em camadas:
1. Boot e processo HTTP: `server.js`
2. Composição da app e middlewares: `src/app.js`
3. Rotas por domínio: `src/routes/*`
4. Serviços de regra de negócio: `src/services/*`
5. Validadores: `src/validators/*`
6. Persistência e schema: `src/database.js`
7. UI server-side: `app/templates/*` + `app/static/*`

## 2) Fluxo de request

1. `server.js` inicia app e chama `database.ensureSchema()`.
2. `src/app.js` aplica sessão, CSRF, contexto do usuário, flash e helpers.
3. Rota do domínio valida entrada e autorização.
4. Regras de negócio são executadas.
5. `src/database.js` executa SQL no Postgres (bridge síncrona).
6. Resposta HTML (Nunjucks) ou JSON.

## 3) Módulos de rota

- `src/routes/auth.js`
  - login/logout, home, planner, presença, manutenção de usuários.
- `src/routes/reports.js`
  - painel quinzenal, metas, ações de atraso, PDF mensal.
- `src/routes/members.js`
  - CRUD de membros.
- `src/routes/projects.js`
  - CRUD de projetos + vínculo de membros + coordenação contextual.
- `src/routes/atas.js`
  - criar/baixar/excluir atas.
- `src/routes/almox.js`
  - interface + APIs do almoxarifado.

## 4) Módulo principal e navegação

- Página inicial autenticada: redireciona para `/relatorios`.
- Sidebar principal: Relatórios, Almoxarifado, Atas, Membros, Projetos, Presença, Sair, tema.
- Planner é usado em modo dedicado (`/planner`) e embutido (iframe/modal no Relatório).

## 5) Domínio de tarefas (Planner + Relatórios)

Entidades:
- `planner_task` (fonte operacional)
- `report_week_goal` (visão quinzenal)

Sincronização:
- vínculo por `report_week_goal.planner_task_id`
- atualizações no Planner refletem no Relatório e vice-versa, conforme regra

Estados:
- Planner: `status` (`todo`, `in_progress`, `done`) + `workflow_state` (`active`, `missed`)
- Relatório: `is_completed` + `task_state`

Fluxo de atraso:
- ciclo automático considera janela de 48h e pode marcar `missed`
- nesse estado, ações controladas: `feito com atraso` e `estender prazo`

Auditoria:
- `task_audit_log` (ações de ciclo de vida)
- `report_week_goal_deletion_log` (remoção de concluídas)

## 6) Permissões (arquitetura)

Helpers centrais em `src/app.js`:
- `requireAuth`, `requireAdminPage`, `requireAdminApi`
- `canManageProject`
- `canManageReportGoal`
- `canDeleteCompletedGoalFromOthers`

Regra prática vigente em **Projetos**:
- qualquer autenticado pode criar/editar projeto e membros;
- apenas admin/coordenador pode definir coordenadores;
- excluir projeto segue admin-only.

Fonte oficial por ação: `MATRIZ_PERMISSOES.md`.

## 7) Sessão, segurança e tempo

- Sessão: `cookie-session`
- Expiração por inatividade: `SESSION_MAX_AGE_HOURS`
- CSRF: token em sessão (`ensureCsrfToken`/`verifyCsrf`)
- Fuso principal: `America/Sao_Paulo`

## 8) Dados e integrações

- Banco: Postgres/Neon (`DATABASE_URL`)
- Presença: XLSX (`PRESENCE_WORKBOOK_PATH`)
- Upload de imagens: Cloudinary opcional
- PDFs: `src/pdf.js`

## 9) Princípios de evolução

- SQL apenas em `src/database.js`
- Migração sempre idempotente (`ensureSchema` + `ensureColumn`)
- Mudou regra funcional -> atualizar docs no mesmo ciclo:
  - `README.md`
  - `MAPA_PROJETO.txt`
  - `MATRIZ_PERMISSOES.md`
  - `MODELAGEM_BANCO.md`
  - `DOCUMENTACAO_TECNICA_COMPLETA.md`
