# Guia de Desenvolvimento

Ultima revisao: 14/05/2026

Se precisar entender arquitetura e alterar codigo com seguranca, este e o guia principal.

## Arquitetura (resumo)

Camadas:

1. Entrada: `server.js`
2. Composicao e middlewares: `src/app.js`
3. Rotas: `src/routes/*`
4. Servicos: `src/services/*`
5. Validadores: `src/validators/*`
6. Persistencia/schema: `src/database.js`
7. UI: `app/templates/*` e `app/static/*`

## Modulos ativos

- auth, reports, atas, almox, projects, members, chat, writing
- Home autenticada: `/relatorios`
- Healthcheck: `/healthz`

## Mapa rapido de alteracao

- Sessao/auth/CSRF: `src/app.js`, `src/config.js`, `src/utils.js`, `src/routes/auth.js`
- Relatorios: `src/routes/reports.js`, `app/templates/reports/index.html`, `src/database.js`
- Planner: `src/routes/auth.js`, `app/templates/planner/index.html`, `src/database.js`
- Atas: `src/routes/atas.js`, `app/templates/atas/*`, `src/pdf.js`
- Almoxarifado: `src/routes/almox.js`, `src/services/inventoryService.js`, `app/templates/almoxarifado/*`
- Mensagens: `src/routes/chat.js`, `app/templates/chat/index.html`, `src/database.js`
- Escrita: `src/routes/writing.js`, `app/templates/writing/index.html`, `src/routes/reports.js`
- Projetos/membros: `src/routes/projects.js`, `src/routes/members.js`, templates correspondentes

## Checklist de mudanca segura

1. Definir impacto funcional
2. Atualizar validacao
3. Atualizar autorizacao
4. Atualizar persistencia
5. Atualizar interface
6. Rodar verificacao automatica
7. Fazer smoke test manual
8. Atualizar docs

## Comandos uteis

```bash
npm run dev
npm run verify
npm run notify:run-once
node -e "const { createApp } = require('./src/app'); createApp(); console.log('app-ok');"
```

## Regras de evolucao

- SQL so em `src/database.js`
- Mudancas de schema idempotentes (`ensureSchema` + `ensureColumn`)
- Mudou permissao/regra -> atualizar `GUIA_DADOS_E_PERMISSOES.md`
- Nao existe modulo PETrello na versao atual
