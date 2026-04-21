# Matriz de Permissões - Portal PET C3

Fonte oficial de permissões por perfil.
Última revisão: 21/04/2026.

Perfis:
- `admin`
- `coordenador` (somente no projeto em que `project_members.is_coordinator = 1`)
- `comum`

## Regras globais

- Rotas internas exigem autenticação (`requireAuth`), exceto login/logout.
- `admin` possui acesso total de gestão.
- `coordenador` possui gestão contextual apenas no(s) projeto(s) que coordena.
- `comum` atua no próprio escopo e no que cada módulo liberar explicitamente.

## Matriz por módulo

| Módulo | Ação | Admin | Coordenador | Comum |
|---|---|---:|---:|---:|
| Manutenção de Usuários | Acessar aba/página | Sim | Não | Não |
| Membros | Criar/editar/desativar membro | Sim | Não | Não |
| Projetos | Criar projeto | Sim | Não | Não |
| Projetos | Editar nome/cor/logo | Sim | Não | Não |
| Projetos | Vincular membros/coordenadores | Sim | Sim (no próprio projeto) | Não |
| Projetos | Excluir projeto | Sim | Não | Não |
| Atas | Criar ata em projeto | Sim | Sim (se vinculado ao projeto) | Sim (se vinculado ao projeto) |
| Atas | Excluir ata | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Visualizar painel | Sim | Sim | Sim |
| Relatórios | Criar meta para si | Sim | Sim | Sim (se for membro do projeto da meta) |
| Relatórios | Criar/editar meta de outro membro | Sim | Sim (no próprio projeto) | Não |
| Relatórios | Excluir meta concluída | Sim | Sim (no próprio projeto) | Não |
| Planner | Visualizar modo Projeto | Sim | Sim (projetos acessíveis) | Sim (somente projetos em que é membro) |
| Planner | Visualizar modo Individual | Sim | Sim (próprio) | Sim (próprio) |
| Planner | Criar tarefa | Sim | Sim (no próprio projeto) | Não |
| Planner | Mover status / Concluir / Excluir tarefa | Sim | Sim (no próprio projeto) | Sim (se a tarefa estiver atribuída ao próprio membro) |
| Almoxarifado | Gestão administrativa (telas e APIs) | Sim | Não | Não |
| Presença | Registrar presença | Sim | Sim | Sim |

## Regras funcionais importantes

- Planner:
  - Não permite criar tarefa com data/hora no passado.
  - Status inicial é automático pela data (`agora = Em Execução`, `futuro = A Fazer`).
- Relatórios:
  - Exclusão de atividade concluída gera auditoria (quem apagou e quando).

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
