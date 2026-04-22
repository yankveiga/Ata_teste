# Documentação Técnica Completa (Manutenção)

Objetivo: guia único de manutenção e evolução sem regressão.
Última revisão: **22/04/2026**.

## 1) Estado atual

- Aplicação Node.js/Express renderizada por Nunjucks.
- Banco principal: Postgres (Neon).
- Uploads: local ou Cloudinary.
- Presença: planilha XLSX no servidor.
- Módulos em rotas separadas (`src/routes/*`).

## 2) Estrutura por responsabilidade

- Boot: `server.js`
- Middlewares/autorização/contexto: `src/app.js`
- Rotas: `src/routes/*`
- Serviços: `src/services/*`
- Validações: `src/validators/*`
- Persistência/schema: `src/database.js`
- Frontend: `app/templates/*`, `app/static/*`

## 3) Permissões vigentes

Perfis:
- `admin`
- `common`
- `coordenador` (contextual por projeto via `project_members.is_coordinator`)

Fonte única: `MATRIZ_PERMISSOES.md`.

Resumo operacional:
- `admin`: gestão total.
- `coordenador`: gestão do próprio projeto.
- `comum`: ações no próprio escopo.

## 4) Domínio de tarefas (relatório + planner)

- Fonte operacional: `planner_task`.
- Projeção quinzenal: `report_week_goal`.
- Sincronização: vínculo por `planner_task_id`.
- Atraso operacional:
  - tarefa pode migrar para `missed` após janela de 48h;
  - nesse estado, edição direta é bloqueada;
  - ações permitidas: `feito com atraso` e `estender prazo`.
- Auditoria:
  - `task_audit_log` (criação, edição, mudança de status, atraso, extensão, exclusão)
  - `report_week_goal_deletion_log` (remoção de metas concluídas)

## 5) Convenções obrigatórias

1. Ajustar validação.
2. Ajustar autorização/regra.
3. Ajustar persistência.
4. Ajustar interface.
5. Atualizar documentação.

Padrões:
- Não escrever SQL fora de `src/database.js`.
- Não duplicar regra de permissão sem helper.
- `aria-label` obrigatório em botões de ícone.
- Erros críticos via `logError`.

## 6) Checklist por módulo

### Relatórios
- Arquivos: `src/routes/reports.js`, `src/services/reportService.js`, `src/database.js`, `app/templates/reports/index.html`.
- Validar:
  - criação/edição/exclusão de meta;
  - sincronização com planner;
  - fluxo `missed` (48h);
  - histórico de exclusão;
  - histórico de auditoria;
  - PDF mensal.

### Planner
- Arquivos: `src/routes/auth.js`, `src/database.js`, `app/templates/planner/index.html`.
- Validar:
  - criação;
  - status/conclusão/exclusão;
  - recorrência;
  - sincronização com relatório.

### Projetos e membros
- Arquivos: `src/routes/projects.js`, `src/routes/members.js`, `src/database.js`, templates `projects/` e `members/`.
- Validar coordenação contextual em `project_members`.

### Almoxarifado
- Arquivos: `src/routes/almox.js`, `src/services/inventoryService.js`, `src/database.js`, `app/templates/almoxarifado/index.html`.
- Validar estoque, retirada, empréstimo, devolução, prorrogação.

## 7) Validação antes de deploy

1. `node -c` nos arquivos alterados.
2. `npm run verify` com `DATABASE_URL` válido.
3. Teste manual do fluxo alterado.
4. Teste de permissão (admin/coordenador/comum).
5. Teste de erro esperado (CSRF, validação, permissão negada).
6. Atualizar docs do mesmo commit.

## 8) Riscos operacionais conhecidos

- Presença depende de XLSX acessível no servidor.
- Exclusão de usuário exige cuidado com histórico/FKs.
- Mudança de schema deve ser idempotente em `ensureSchema()`.

## 9) Documentos complementares

- `README.md`
- `MAPA_PROJETO.txt`
- `MATRIZ_PERMISSOES.md`
- `GUIA_ARQUITETURA.md`
- `MODELAGEM_BANCO.md`
- `RUNBOOK_PRODUCAO.md`
