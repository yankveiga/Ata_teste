# Guia de Desenvolvimento

Ultima revisao: 15/08/2026

Se precisar entender arquitetura e alterar codigo com seguranca, este e o guia principal.

## Arquitetura

Camadas:

1. Entrada: `server.js`
2. Composicao e middlewares: `src/app.js`
3. Rotas: `src/routes/*`
4. Servicos: `src/services/*`
5. Validadores: `src/validators/*`
6. Persistencia/schema: `src/database.js`
7. UI: `app/templates/*` e `app/static/*`

## Organizacao de diretorios

- `src/`: backend da aplicacao.
- `src/routes/`: rotas HTTP por dominio.
- `src/services/`: regras reutilizaveis fora da camada HTTP.
- `src/validators/`: validacoes compartilhadas.
- `app/templates/`: telas Nunjucks.
- `app/templates/partials/`: trechos reutilizaveis de telas.
- `app/static/`: CSS, JS e uploads publicos.
- `scripts/`: rotinas executadas via npm.
- `docs/`: documentacao operacional e tecnica.
- `data/examples/`: exemplos locais que nao devem conter dados reais sensiveis.
- `assets/misc/`: arquivos visuais soltos ou de referencia.

## Modulos ativos

- Auth e usuarios
- Relatorios quinzenais
- Planner
- Atas e PDF
- Almoxarifado
- Projetos e membros
- Chat
- Escrita geral e privada de tutor
- Presenca por eventos

Home autenticada: `/relatorios`

Healthcheck: `/healthz`

## Mapa rapido de alteracao

- Sessao/auth/CSRF: `src/app.js`, `src/config.js`, `src/utils.js`, `src/routes/auth.js`
- Relatorios: `src/routes/reports.js`, `app/templates/reports/index.html`, `src/database.js`
- Planner: `src/routes/auth.js`, `app/templates/planner/index.html`, `src/database.js`
- Atas: `src/routes/atas.js`, `app/templates/atas/*`, `src/pdf.js`
- Almoxarifado: `src/routes/almox.js`, `src/services/inventoryService.js`, `app/templates/almoxarifado/*`
- Mensagens: `src/routes/chat.js`, `app/templates/chat/index.html`, `src/database.js`
- Escrita: `src/routes/writing.js`, `app/templates/writing/index.html`, `src/routes/reports.js`
- Projetos/membros: `src/routes/projects.js`, `src/routes/members.js`, templates correspondentes
- Presenca: `src/routes/presenca.js`, `app/templates/presenca/*`, `app/templates/partials/presenca_tabs.html`, `src/database.js`, `src/utils.js`

## Presenca

Rotas principais:

- `/presenca/eventos`
- `/presenca/ouvintes`
- `/presenca/check-in`
- `/presenca/registrar`
- `/presenca/eventos/:id/exportar.csv`

Modelo funcional:

- Evento: nome, data e status ativo.
- Ouvinte: cadastro geral com cracha, nome, CPF e email.
- Atividade/palestra/minicurso: recebe vínculos da base geral de ouvintes.
- Check-in: seleciona evento, recebe codigo do cracha e registra horario no banco somente para ouvintes vinculados ao evento.
- Planilha geral: `/presenca/exportar-geral.xlsx`, no modelo de `data/examples/planilha_presenca.xlsx`.
- Importacao: CSV com `cracha,nome,cpf,email`, pre-visualizacao, duplicados e confirmacao.
- Exportacao: CSV com `CRACHA,NOME,CPF,EMAIL,PRESENTE,REGISTRADO_EM`.

As tabelas antigas podem manter colunas extras para compatibilidade, mas a interface atual nao deve depender de local, descricao, matricula, curso ou instituicao para presenca.

## Checklist de mudanca segura

1. Definir impacto funcional.
2. Atualizar validacao.
3. Atualizar autorizacao.
4. Atualizar persistencia.
5. Atualizar interface.
6. Rodar verificacao automatica.
7. Fazer smoke test manual.
8. Atualizar docs.

## Comandos uteis

```bash
npm run dev
npm run verify
npm run notify:run-once
node -e "const { createApp } = require('./src/app'); createApp(); console.log('app-ok');"
```

## Regras de evolucao

- SQL fica em `src/database.js`.
- Mudancas de schema devem ser idempotentes (`CREATE TABLE IF NOT EXISTS` e `ensureColumn` quando aplicavel).
- Mudou permissao/regra: atualizar `docs/GUIA_DADOS_E_PERMISSOES.md`.
- Mudou fluxo operacional: atualizar `docs/GUIA_OPERACAO.md`.
- Nao existe modulo PETrello na versao atual.

## Melhorias pendentes recomendadas

- Quebrar `src/database.js` por dominio sem alterar contratos publicos.
- Mover helpers grandes de `src/app.js` para modulos menores.
- Dividir templates grandes, especialmente `reports/index.html`, em partials.
- Adicionar lint/format e testes focados em validators/services.
