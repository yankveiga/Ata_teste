# Portal PET C3

Sistema interno em **Node.js + Express + Nunjucks** para gestão de:
- Relatórios Quinzenais (módulo principal)
- Planner (integrado ao Relatório)
- Atas
- Almoxarifado
- Presença
- Membros
- Projetos
- Manutenção de Usuários (admin)

Última revisão: **25/04/2026**.

## Stack atual

- Backend: Node.js + Express
- Templates: Nunjucks
- Banco: PostgreSQL (Neon)
- Deploy: Render
- Uploads de imagem: Cloudinary (produção recomendada)
- Presença: planilha XLSX (`planilha_presenca.xlsx`)

## Execução local

1. Instale dependências:
```bash
npm install
```

2. Crie/edite `.env` na raiz:
```env
NODE_ENV=development
PORT=3000
SECRET_KEY=troque-essa-chave
DATABASE_URL=postgresql://USUARIO:SENHA@HOST/DB?sslmode=require
SESSION_MAX_AGE_HOURS=1
APP_TIMEZONE=America/Sao_Paulo
PRESENCE_WORKBOOK_PATH=planilha_presenca.xlsx

# Opcional (Cloudinary)
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_FOLDER=pet-c3

# Opcional (bootstrap admin em primeiro boot)
BOOTSTRAP_ADMIN=false
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=
BOOTSTRAP_ADMIN_NAME=Administrador

# Opcional (notificacoes externas por e-mail via Brevo)
APP_BASE_URL=http://127.0.0.1:3000
EMAIL_PROVIDER=brevo
BREVO_API_KEY=
EMAIL_FROM=notificacoes@seu-dominio.com
EMAIL_FROM_NAME=Portal PET C3
EMAIL_REPLY_TO=
NOTIFICATION_SWEEP_INTERVAL_MS=300000
```

3. Crie usuário inicial (opcional):
```bash
npm run create-user
```

4. Rode a aplicação:
```bash
npm run dev
```

URL local: `http://127.0.0.1:3000`

## Scripts

```bash
npm run dev
npm start
npm run create-user
npm run verify
npm run notify:run-once
```

Observação: `npm run verify` exige `DATABASE_URL` válido.

## Regras funcionais importantes

- Fuso principal: `America/Sao_Paulo`.
- Sessão expira por inatividade conforme `SESSION_MAX_AGE_HOURS`.
- Planner e Relatórios são sincronizados por `report_week_goal.planner_task_id`.
- Tarefa com prazo no passado não pode ser criada.
- Estado inicial é automático pela data:
  - prazo agora/passado imediato: `Em Execução`
  - prazo futuro: `A Fazer`
- Após janela operacional (48h), tarefa pode migrar para `Não feitas`/`missed`.

## Permissões (resumo)

- `admin`: gestão total.
- `coordenador`: gestão contextual por projeto.
- `comum`: escopo próprio por módulo.

**Projetos (regra atual):**
- qualquer usuário autenticado pode criar/editar projeto e membros;
- apenas admin ou coordenador pode definir/remover coordenadores;
- excluir projeto continua restrito a admin.

Fonte oficial: `MATRIZ_PERMISSOES.md`.

## Deploy (Render) - resumo

- Build Command: `npm install`
- Start Command: `npm start`
- Definir variáveis de ambiente do app no painel
- Se usar presença em XLSX no Render, garantir caminho persistente para `PRESENCE_WORKBOOK_PATH`

## Documentação do projeto

- `MAPA_PROJETO.txt` -> mapa rápido de manutenção
- `MATRIZ_PERMISSOES.md` -> matriz de autorização por perfil
- `GUIA_ARQUITETURA.md` -> visão arquitetural por camadas
- `MODELAGEM_BANCO.md` -> modelagem e regras de dados
- `RUNBOOK_PRODUCAO.md` -> operação, backup e incidentes
- `DOCUMENTACAO_TECNICA_COMPLETA.md` -> checklist técnico de evolução
