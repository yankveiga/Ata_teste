# Documentação Técnica Completa (Manutenção)

Objetivo: servir como guia único para manutenção diária e evolução sem regressão.

## 1) Estado atual do projeto

- Aplicação monolítica modular em Node.js/Express.
- Banco principal: Postgres (Neon).
- Uploads: local ou Cloudinary.
- Presença: planilha XLSX no servidor.
- Renderização server-side com Nunjucks.

## 2) Estrutura por responsabilidade

- Entrada/boot: `server.js`
- Middlewares + helpers de autorização + contexto global: `src/app.js`
- Rotas por domínio: `src/routes/*`
- Regras de negócio reutilizáveis: `src/services/*`
- Validações: `src/validators/*`
- Persistência e schema: `src/database.js`
- Frontend (templates/CSS/JS): `app/templates/*`, `app/static/*`

## 3) Regras de permissão vigentes

Perfis:
- `admin`
- `common`
- `coordenador` (contextual por projeto via `project_members.is_coordinator`)

Fonte única de regras por módulo/ação: `MATRIZ_PERMISSOES.md`.

Resumo operacional (21/04/2026):
- `admin`: gestão total.
- `coordenador`: gestão do próprio projeto (planner, relatórios, atas e vínculos de membros/coordenadores no projeto).
- `comum`: ações no próprio escopo (inclusive tarefas do planner atribuídas a si).

Regras do Planner:
- criação de tarefa: somente admin/coordenador do projeto;
- data/hora passada: bloqueada;
- status inicial: automático por data (`agora = Em Execução`, `futuro = A Fazer`).

## 4) Convenções de alteração

Sempre seguir esta ordem:
1. Ajustar validação.
2. Ajustar regra/autorização.
3. Ajustar persistência se necessário.
4. Ajustar interface.
5. Atualizar documentação.

Padrões obrigatórios:
- Não escrever SQL fora de `src/database.js`.
- Não duplicar regra de permissão em múltiplos lugares sem helper.
- Em botões de ícone, manter `aria-label`.
- Erros críticos devem usar `logError`.

## 5) Checklist de mudança por módulo

### Relatórios
- Arquivos: `src/routes/reports.js`, `src/services/reportService.js`, `src/database.js`, `app/templates/reports/index.html`.
- Validar: criação/edição/meta concluída, atraso, log de exclusão, PDF mensal.

### Planner
- Arquivos: `src/routes/auth.js`, `src/database.js`, `app/templates/planner/index.html`.
- Validar: criação, status, conclusão, recorrência (fila), exclusão.

### Projetos e membros
- Arquivos: `src/routes/projects.js`, `src/routes/members.js`, `src/database.js`, templates de `projects/` e `members/`.
- Validar: permissões de admin/coordenador e consistência do vínculo em `project_members`.

### Almoxarifado
- Arquivos: `src/routes/almox.js`, `src/services/inventoryService.js`, `src/database.js`, `app/templates/almoxarifado/index.html`.
- Validar: estoque, retirada, empréstimo, devolução, prorrogação e APIs.

## 6) Fluxo de validação antes de deploy

1. `node -c` nos arquivos alterados.
2. Teste manual do fluxo principal afetado.
3. Teste manual de permissão (admin/coordenador/comum).
4. Teste de erro esperado (CSRF, validação, permissão negada).
5. Atualização de docs (`README`, `MAPA`, `GUIA`, `MODELAGEM`) quando necessário.

## 7) Riscos conhecidos (operacionais)

- Presença depende de arquivo XLSX acessível no servidor.
- Exclusão de usuário exige cuidado por FKs/histórico; usar fluxo da aplicação.
- Alterações de schema devem ser idempotentes em `ensureSchema()`.

## 8) Documentos complementares

- `README.md` (entrada rápida)
- `MAPA_PROJETO.txt` (atalho de manutenção)
- `MATRIZ_PERMISSOES.md` (fonte única de autorização)
- `GUIA_ARQUITETURA.md` (desenho técnico)
- `MODELAGEM_BANCO.md` (schema)
- `RUNBOOK_PRODUCAO.md` (operação)
