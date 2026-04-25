# Documentação Técnica Completa (Manutenção)

Objetivo: guia único para manutenção e evolução com baixo risco.
Última revisão: **25/04/2026**.

## 1) Estado atual

- Aplicação Node.js/Express com renderização Nunjucks.
- Banco principal: PostgreSQL (Neon).
- Uploads: local ou Cloudinary.
- Presença: planilha XLSX configurável.
- Rotas separadas por domínio em `src/routes/*`.
- Página inicial autenticada: `Relatórios`.

## 2) Estrutura por responsabilidade

- Boot: `server.js`
- Middlewares, auth e helpers: `src/app.js`
- Rotas: `src/routes/*`
- Serviços: `src/services/*`
- Validações: `src/validators/*`
- Banco e schema: `src/database.js`
- Frontend: `app/templates/*` e `app/static/*`

## 3) Permissões vigentes (resumo)

Perfis:
- `admin`
- `coordenador` (contextual por projeto)
- `comum`

Resumo operacional:
- admin: gestão total
- coordenador: gestão contextual de projeto
- comum: escopo próprio

Regra relevante (Projetos):
- qualquer autenticado cria/edita projeto e membros;
- somente admin/coordenador define coordenadores;
- excluir projeto continua admin-only.

Fonte oficial: `MATRIZ_PERMISSOES.md`.

## 4) Domínio de tarefas (Relatório + Planner)

- Fonte operacional: `planner_task`
- Projeção quinzenal: `report_week_goal`
- Sincronização: `report_week_goal.planner_task_id`
- Janela de atraso operacional: 48h (`missed`)
- Ações em `missed`:
  - feito com atraso
  - estender prazo
- Auditoria:
  - `task_audit_log`
  - `report_week_goal_deletion_log`

## 5) Convenções obrigatórias

1. Ajustar validação
2. Ajustar autorização
3. Ajustar persistência
4. Ajustar interface
5. Atualizar documentação

Padrões:
- SQL apenas em `src/database.js`
- Regras de permissão centralizadas e reutilizáveis
- Ações críticas com log de erro via `logError`
- Elementos interativos com acessibilidade mínima (`aria-label`, foco, contraste)

## 6) Checklist por módulo

### Relatórios
- Arquivos:
  - `src/routes/reports.js`
  - `src/services/reportService.js`
  - `app/templates/reports/index.html`
  - `src/database.js`
- Validar:
  - criar/editar/excluir meta
  - sincronização com planner
  - fluxo `missed`
  - logs de exclusão e auditoria
  - PDF mensal

### Planner
- Arquivos:
  - `src/routes/auth.js`
  - `app/templates/planner/index.html`
  - `src/database.js`
- Validar:
  - criação
  - status/conclusão/exclusão
  - recorrência
  - manutenção de modo embutido (`embedded=1`)

### Projetos e membros
- Arquivos:
  - `src/routes/projects.js`
  - `src/routes/members.js`
  - templates `projects/*` e `members/*`
- Validar:
  - criação/edição por autenticado
  - controle de coordenadores (admin/coordenador)
  - exclusão de projeto (admin)

### Almoxarifado
- Arquivos:
  - `src/routes/almox.js`
  - `src/services/inventoryService.js`
  - `app/templates/almoxarifado/index.html`
- Validar:
  - estoque
  - retirada
  - empréstimo/devolução/prorrogação

## 7) Validação antes de deploy

1. Subida da app:
```bash
node -e "const { createApp } = require('./src/app'); createApp(); console.log('app-ok');"
```

2. Verificação automatizada (com `DATABASE_URL`):
```bash
npm run verify
```

3. Teste manual dos fluxos alterados.
4. Teste de permissão (admin/coordenador/comum).
5. Atualização de documentação no mesmo ciclo.

## 8) Riscos operacionais conhecidos

- Presença depende de acesso de escrita ao XLSX.
- Exclusão de usuário exige atenção para FKs e histórico.
- Mudança de schema sem idempotência pode quebrar deploy.

## 9) Documentos complementares

- `README.md`
- `MAPA_PROJETO.txt`
- `MATRIZ_PERMISSOES.md`
- `GUIA_ARQUITETURA.md`
- `MODELAGEM_BANCO.md`
- `RUNBOOK_PRODUCAO.md`
