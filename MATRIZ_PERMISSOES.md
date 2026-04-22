# Matriz de Permissões - Portal PET C3

Fonte oficial de permissões por perfil.
Última revisão: **22/04/2026**.

Perfis:
- `admin`
- `coordenador` (apenas no projeto em que `project_members.is_coordinator = 1`)
- `comum`

## Regras globais

- Rotas internas exigem autenticação (`requireAuth`), exceto login/logout.
- `admin` tem gestão total.
- `coordenador` tem gestão contextual apenas no(s) projeto(s) que coordena.
- `comum` atua no próprio escopo, conforme cada módulo.

## Matriz por módulo

| Módulo | Ação | Admin | Coordenador | Comum |
|---|---|---:|---:|---:|
| Manutenção de Usuários | Acessar aba/página | Sim | Não | Não |
| Membros | Criar/editar/desativar membro | Sim | Não | Não |
| Projetos | Criar/editar/excluir projeto | Sim | Não | Não |
| Projetos | Vincular membros/coordenadores | Sim | Sim (no próprio projeto) | Não |
| Atas | Criar ata no projeto | Sim | Sim (se vinculado ao projeto) | Sim (se vinculado ao projeto) |
| Atas | Excluir ata | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Visualizar painel | Sim | Sim | Sim |
| Relatórios | Criar meta para si | Sim | Sim | Sim (se membro do projeto) |
| Relatórios | Criar/editar meta de outro membro | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Excluir meta concluída de outro membro | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Ações em “Não feitas (48h)” (feito com atraso / estender prazo) | Sim | Sim (no próprio projeto) | Sim (nas próprias metas) |
| Planner | Visualizar tarefas | Sim | Sim (projetos acessíveis) | Sim (somente projetos em que é membro) |
| Planner | Criar tarefa | Sim | Sim (no próprio projeto) | Não |
| Planner | Criar tarefa para outro membro pelo Planner | Não (usar perfil do membro em Relatórios) | Não (usar perfil do membro em Relatórios) | Não |
| Planner | Mover status / concluir / excluir tarefa | Sim | Sim (no próprio projeto) | Sim (se atribuída ao próprio membro) |
| Almoxarifado | Gestão administrativa (telas e APIs) | Sim | Não | Não |
| Presença | Registrar presença | Sim | Sim | Sim |

## Regras funcionais importantes

- Planner:
  - bloqueia criação com data/hora no passado;
  - define status inicial automaticamente pela data (`agora = Em Execução`, `futuro = A Fazer`).
- Relatórios:
  - tarefas atrasadas podem migrar para “Não feitas (48h)” por regra automática;
  - exclusão de atividade concluída gera trilha em `report_week_goal_deletion_log`;
  - ciclo de vida de tarefas (criação/edição/status/atraso/extensão/exclusão) gera trilha em `task_audit_log`.

## Pontos de implementação no código

- Guardas centrais em `src/app.js`:
  - `requireAuth`, `requireAdminPage`, `requireAdminApi`
  - `canManageProject`
  - `canManageReportGoal`
  - `canDeleteCompletedGoalFromOthers`
- Regras por módulo:
  - `src/routes/auth.js` (planner, presença, manutenção de usuários)
  - `src/routes/reports.js`
  - `src/routes/projects.js`
  - `src/routes/members.js`
  - `src/routes/atas.js`
  - `src/routes/almox.js`

## Regra de atualização

Mudou permissão no código -> atualizar este arquivo no mesmo commit.
