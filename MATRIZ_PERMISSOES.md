# Matriz de Permissões - Portal PET C3

Fonte de verdade de permissões funcionais por perfil.

Perfis:
- `admin`
- `coordenador` (contextual: apenas no projeto em que `project_members.is_coordinator = 1`)
- `comum`

## Regras globais

- Todas as rotas internas exigem autenticação (`requireAuth`), salvo login/logout.
- `admin` tem acesso total.
- `coordenador` atua somente no escopo do próprio projeto.
- `comum` atua no próprio escopo (ou no que a regra de módulo liberar).

## Matriz por módulo

| Módulo | Ação | Admin | Coordenador | Comum |
|---|---|---:|---:|---:|
| Membros | Criar/editar/desativar membro | Sim | Não | Não |
| Projetos | Criar projeto | Sim | Não | Não |
| Projetos | Excluir projeto | Sim | Não | Não |
| Projetos | Editar nome/cor/logo do projeto | Sim | Não | Não |
| Projetos | Vincular membros e coordenadores no projeto | Sim | Sim (no próprio projeto) | Não |
| Atas | Criar ata em projeto | Sim | Sim (como membro/coordenador do projeto) | Sim (se membro do projeto) |
| Atas | Excluir ata | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Criar meta para si | Sim | Sim | Sim (se membro do projeto) |
| Relatórios | Criar meta para outro membro | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Editar meta | Sim | Sim (no próprio projeto) | Sim (nas próprias metas, dentro do projeto) |
| Relatórios | Excluir meta concluída de outro membro | Sim | Sim (no próprio projeto) | Não |
| Planner | Criar tarefa | Sim | Sim (no próprio projeto) | Não |
| Planner | Mover status de tarefa | Sim | Sim (no próprio projeto) | Sim (se for tarefa atribuída a ele) |
| Planner | Concluir tarefa | Sim | Sim (no próprio projeto) | Sim (se for tarefa atribuída a ele) |
| Planner | Excluir tarefa | Sim | Sim (no próprio projeto) | Sim (se for tarefa atribuída a ele) |
| Almoxarifado | Gestão administrativa (cadastros e APIs admin) | Sim | Não | Não |
| Presença | Registrar presença | Sim | Sim | Sim |
| Manutenção de Usuários | Acessar página/aba | Sim | Não | Não |

## Pontos de implementação no código

- Guardas centrais: `src/app.js`
  - `requireAuth`, `requireAdminPage`, `requireAdminApi`
  - `canManageProject`
  - `canManageReportGoal`
  - `canDeleteCompletedGoalFromOthers`
- Regras por módulo:
  - `src/routes/projects.js`
  - `src/routes/members.js`
  - `src/routes/reports.js`
  - `src/routes/auth.js` (planner, manutenção de usuários, presença)
  - `src/routes/atas.js`
  - `src/routes/almox.js`

## Regra de atualização

Mudou permissão no código -> atualizar este arquivo no mesmo PR/commit.
