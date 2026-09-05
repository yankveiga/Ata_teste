# Guia de Dados e Permissoes

Ultima revisao: 05/09/2026

Se precisar entender modelagem e acesso, use este guia.

## Modelagem (resumo por dominio)

- Identidade: `member`, `user`
- Projetos: `project`, `project_members`
- Atas: `ata`, `ata_present_members`, `ata_absent_justification`
- Relatorios: `report_entry`, `report_week_goal`, `report_week_goal_deletion_log`
- Planner: `planner_task`, `planner_task_completion_log`, `task_audit_log`
- Almoxarifado: `estoque`, `pedido`, `inventory_category`, `inventory_location`, `inventory_loan`
- Presenca: `attendee`, `event`, `event_attendee`, `event_attendance`
- Escrita complementar: `writing_general_entry`, `writing_tutor_private_entry`, `report_fortnight_tutor_note`, `report_fortnight_member_note`
- Chat/notificacao: `chat_conversation`, `chat_conversation_participant`, `chat_message`, `notification_email_delivery`

Fonte de verdade atual: `src/database.js`.

Observacao de manutencao: este arquivo ainda concentra schema e consultas. Se for dividido futuramente, preservar os nomes das funcoes exportadas ou atualizar todas as rotas impactadas.

Observacao de performance: como as rotas usam uma API sincrona de persistencia, reduza idas ao banco em telas grandes. Prefira consultas em lote para montar estruturas agregadas, como projetos com membros, e evite consultas em loop quando uma query com join resolver.

## Relacoes centrais

- `user.member_id -> member.id`
- `project_members` (PK: `project_id`, `member_id`)
- `planner_task.project_id -> project.id`
- `planner_task.assigned_member_id -> member.id`
- `report_week_goal.planner_task_id -> planner_task.id`
- `inventory_loan.item_id -> estoque.id`
- `event_attendee.event_id -> event.id`
- `event_attendance.event_id -> event.id`
- `event_attendance.attendee_id -> event_attendee.id`
- `chat_message.conversation_id -> chat_conversation.id`

## Presenca

Campos usados pela interface atual:

- Atividade/palestra/minicurso: `event.name`, `event.event_date`, `event.is_active`
- Ouvinte geral: `badge_code`, `name`, `cpf`, `email`
- Vínculo com evento: `event_attendee.event_id`, `event_attendee.attendee_id`
- Check-in: `event_id`, `attendee_id`, `checked_in_at`, `checked_in_by_user_id`, `method`

Regras:

- `attendee` usa `UNIQUE(badge_code)` para manter uma base geral de ouvintes.
- `event_attendee` usa `UNIQUE(event_id, badge_code)` e `UNIQUE(event_id, attendee_id)` para evitar duplicidade no mesmo evento.
- `event_attendance` usa `UNIQUE(event_id, attendee_id)` para impedir presenca duplicada.
- Importacao CSV aceita `cracha,nome,cpf,email`.
- Exportacao CSV usa `CRACHA,NOME,CPF,EMAIL,PRESENTE,REGISTRADO_EM`.
- Exportacao geral XLSX usa o modelo `CRACHA,NOME,CPF,E-MAIL,EVENTO_1...`, marcando presença com `X`.
- Colunas antigas de presenca podem existir por compatibilidade, mas nao fazem parte do fluxo operacional atual.

## Regras de schema

- Toda alteracao deve ser idempotente
- `ensureSchema()` pode ser chamado por scripts e pelo servidor, mas deve executar o trabalho completo apenas uma vez por processo.
- Se adicionar coluna/tabela:
  1. incluir em `CREATE TABLE IF NOT EXISTS` quando aplicavel
  2. reforcar com `ensureColumn`
  3. atualizar mapeadores `map*`
  4. validar rotas impactadas

## Caches e consistencia

- Cache por requisicao em `src/app.js`: usado para leituras repetidas de usuario, membro, projeto, lista de projetos por membro e permissoes projeto-membro. Nao atravessa requisicoes.
- Cache curto de mensagens nao lidas: fica em memoria por poucos segundos e e invalidado quando uma conversa e marcada como lida ou quando nova mensagem e criada.
- Nao guardar em cache global regras de permissao, membros de projeto ou dados administrativos sem TTL e invalidacao clara.

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
- Presenca: check-in por usuario autenticado; criar eventos, importar, editar e excluir ouvintes exige admin/tutor
- Escrita privada: exige `role === tutor`

## Onde revisar quando mudar permissao

- `src/app.js`
- `src/routes/projects.js`
- `src/routes/reports.js`
- `src/routes/auth.js`
- `src/routes/almox.js`
- `src/routes/presenca.js`
- `src/routes/writing.js`

## Organizacao relacionada

- Documentacao tecnica e operacional fica em `docs/`.
- Exemplos locais ficam em `data/examples/`.
- Arquivos com dados reais, dumps, planilhas de producao e `.env` nao devem ser versionados.
