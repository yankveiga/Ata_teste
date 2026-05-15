# Guia de Dados e Permissoes

Ultima revisao: 14/05/2026

Se precisar entender modelagem e acesso, use este guia.

## Modelagem (resumo por dominio)

- Identidade: `member`, `user`
- Projetos: `project`, `project_members`
- Atas: `ata`, `ata_present_members`, `ata_absent_justification`
- Relatorios: `report_entry`, `report_week_goal`, `report_week_goal_deletion_log`
- Planner: `planner_task`, `planner_task_completion_log`, `task_audit_log`
- Almoxarifado: `estoque`, `pedido`, `inventory_category`, `inventory_location`, `inventory_loan`
- Escrita complementar: `writing_general_entry`, `writing_tutor_private_entry`, `report_fortnight_tutor_note`, `report_fortnight_member_note`
- Chat/notificacao: `chat_conversation`, `chat_conversation_participant`, `chat_message`, `notification_email_delivery`

Fonte de verdade: `src/database.js`.

## Relacoes centrais

- `user.member_id -> member.id`
- `project_members` (PK: `project_id`, `member_id`)
- `planner_task.project_id -> project.id`
- `planner_task.assigned_member_id -> member.id`
- `report_week_goal.planner_task_id -> planner_task.id`
- `inventory_loan.item_id -> estoque.id`
- `chat_message.conversation_id -> chat_conversation.id`

## Regras de schema

- Toda alteracao deve ser idempotente
- Se adicionar coluna/tabela:
  1. incluir em `CREATE TABLE IF NOT EXISTS` quando aplicavel
  2. reforcar com `ensureColumn`
  3. atualizar mapeadores `map*`
  4. validar rotas impactadas

## Permissoes

Perfis:

- `admin`
- `tutor`
- `common`
- `coordenador contextual` (`project_members.is_coordinator = 1`)

Regra importante do codigo atual:

- `tutor` e tratado como `is_admin=true` nas guardas `requireAdminPage` e `requireAdminApi`.

## Guardas e helpers centrais

Em `src/app.js`:

- `requireAuth`
- `requireAdminPage`
- `requireAdminApi`
- `canManageProject`
- `canManageReportGoal`
- `canDeleteCompletedGoalFromOthers`

## Matriz pratica (resumo)

- Manutencao de usuarios/membros: admin e tutor
- Projetos: qualquer autenticado cria/edita; excluir projeto exige admin/tutor
- Coordenacao: controlada por regra contextual de coordenador/admin/tutor
- Relatorios/planner: membro do projeto atua no proprio escopo; coordenador/admin/tutor ampliam gestao
- Almoxarifado: cadastros/API admin para admin/tutor; movimentos basicos por autenticado
- Escrita privada: exige `role === tutor`

## Onde revisar quando mudar permissao

- `src/app.js`
- `src/routes/projects.js`
- `src/routes/reports.js`
- `src/routes/auth.js`
- `src/routes/almox.js`
- `src/routes/writing.js`
