# Guia de Arquitetura - Portal PET C3

## 1) Visão geral

Arquitetura em camadas com responsabilidades separadas:
1. Entrada HTTP e boot: `server.js`
2. Composição de app/middlewares/contexto: `src/app.js`
3. Rotas por domínio: `src/routes/*`
4. Serviços de regra de negócio: `src/services/*`
5. Validações: `src/validators/*`
6. Persistência SQL e schema: `src/database.js`
7. Renderização: `app/templates/*` + `app/static/*`

## 2) Fluxo de request

1. `server.js` sobe app e garante `ensureSchema()`.
2. `src/app.js` aplica sessão, CSRF, flash, auth, estáticos e contexto de template.
3. Rota do módulo processa entrada.
4. Regra de negócio/validação (quando aplicável).
5. `database.js` executa SQL no Postgres.
6. Resposta volta como HTML (Nunjucks) ou JSON.

## 3) Módulos de rota

- `src/routes/auth.js`
  - login/logout, services/home/presença, planner, manutenção de usuários.
- `src/routes/reports.js`
  - metas quinzenais, exclusão auditada, PDF mensal.
- `src/routes/members.js`
  - CRUD administrativo de membros.
- `src/routes/projects.js`
  - CRUD de projetos e gestão de vínculos/coordenadores.
- `src/routes/atas.js`
  - criar/baixar/excluir atas.
- `src/routes/almox.js`
  - interface + APIs do almoxarifado.

## 4) Autorização (estado atual)

Regras centrais em `src/app.js`:
- `requireAuth`, `requireAdminPage`, `requireAdminApi`
- `canManageProject`
- `canManageReportGoal`
- `canDeleteCompletedGoalFromOthers`

Modelo atual:
- Admin: total.
- Coordenador: gestão contextual no projeto que coordena.
- Comum: escopo limitado por módulo.

Fonte única detalhada: `MATRIZ_PERMISSOES.md`.

## 5) Sessão, segurança e tempo

- Sessão via `cookie-session`.
- CSRF por token de sessão (`ensureCsrfToken`/`verifyCsrf`).
- Expiração por inatividade com `SESSION_MAX_AGE_HOURS`.
- Timezone principal: `America/Sao_Paulo` (`APP_TIMEZONE` + uso em utilitários/relatórios).

## 6) Dados e integrações

- Banco: Postgres/Neon (`DATABASE_URL`).
- Presença: planilha XLSX em disco (`PRESENCE_WORKBOOK_PATH`).
- Mídia: local ou Cloudinary (quando configurado).
- PDF: `src/pdf.js`.

## 7) Frontend

- Shell global/menu/tema: `app/templates/base.html`.
- CSS base: `app/static/css/admin_dashboard_style.css`.
- CSS compartilhado e componentes: `app/static/css/custom_styles.css`.
- Telas por domínio em `app/templates/<modulo>/...`.

## 8) Princípios para evoluir sem regressão

- SQL somente em `src/database.js`.
- Regra de negócio repetida deve virar service/helper.
- Permissões novas devem passar pelos helpers centrais.
- Mudança de schema exige atualização de documentação.
- Mudança de fluxo deve atualizar `MAPA_PROJETO`, `README` e docs técnicas.
