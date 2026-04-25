# Matriz de Permissões - Portal PET C3

Fonte oficial de permissões por perfil.
Última revisão: **25/04/2026**.

Perfis:
- `admin`
- `coordenador` (contextual, quando `project_members.is_coordinator = 1`)
- `comum`

## Regras globais

- Rotas internas exigem autenticação (`requireAuth`), exceto login/logout.
- `admin` tem gestão total.
- `coordenador` tem gestão contextual por projeto.
- `comum` atua no próprio escopo por módulo.

## Matriz por módulo

| Módulo | Ação | Admin | Coordenador | Comum |
|---|---|---:|---:|---:|
| Manutenção de Usuários | Acessar página | Sim | Não | Não |
| Membros | Criar/editar/desativar membro | Sim | Não | Não |
| Projetos | Criar projeto | Sim | Sim | Sim |
| Projetos | Editar nome/cor/logo do projeto | Sim | Sim | Sim |
| Projetos | Vincular/remover membros do projeto | Sim | Sim | Sim |
| Projetos | Definir/remover coordenadores | Sim | Sim | Não |
| Projetos | Excluir projeto | Sim | Não | Não |
| Atas | Criar ata no projeto | Sim | Sim (se vinculado ao projeto) | Sim (se vinculado ao projeto) |
| Atas | Excluir ata | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Visualizar painel | Sim | Sim | Sim |
| Relatórios | Criar meta para si | Sim | Sim | Sim (se membro do projeto) |
| Relatórios | Criar/editar meta de outro membro | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Excluir meta concluída de outro membro | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Resolver “Não feitas” (feito com atraso / estender prazo) | Sim | Sim (no próprio projeto) | Sim (nas próprias metas) |
| Planner | Visualizar tarefas | Sim | Sim (projetos acessíveis) | Sim (projetos em que é membro) |
| Planner | Criar tarefa | Sim | Sim (no próprio projeto) | Não |
| Planner | Criar tarefa para outro membro pelo Planner | Não (usar perfil do membro em Relatórios) | Não (usar perfil do membro em Relatórios) | Não |
| Planner | Mover status / concluir / excluir tarefa | Sim | Sim (no próprio projeto) | Sim (se atribuída ao próprio membro) |
| Almoxarifado | Gestão administrativa (telas/APIs) | Sim | Não | Não |
| Presença | Registrar presença | Sim | Sim | Sim |

## Notas importantes de Projetos

- A edição de coordenadores é controlada no backend.
- Usuário comum pode salvar projeto e membros, mas não altera coordenadores.
- Coordenador pode alterar coordenação quando tiver escopo de coordenação.

## Pontos de implementação no código

- Guardas centrais: `src/app.js`
  - `requireAuth`, `requireAdminPage`, `requireAdminApi`
  - `canManageProject`
  - `canManageReportGoal`
  - `canDeleteCompletedGoalFromOthers`
- Regras por domínio:
  - `src/routes/projects.js`
  - `src/routes/reports.js`
  - `src/routes/auth.js` (planner/presença/manutenção de usuários)
  - `src/routes/members.js`
  - `src/routes/atas.js`
  - `src/routes/almox.js`

## Regra de atualização

Mudou permissão no código -> atualizar este arquivo no mesmo ciclo.
