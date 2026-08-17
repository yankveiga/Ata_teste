# Portal PET C3

Aplicacao interna em Node.js + Express + Nunjucks para operacao do PET C3.

Ultima revisao: 15/08/2026

## O que o sistema faz

- Relatorios quinzenais e metas por membro/projeto
- Planner integrado aos relatorios
- Atas com geracao de PDF
- Almoxarifado: estoque, patrimonio, retiradas e emprestimos
- Presenca por eventos no banco, com check-in, importacao CSV e exportacao CSV
- Mensagens privadas entre usuarios
- Espacos de escrita geral e privado de tutor
- CRUD de membros e projetos
- Manutencao administrativa de usuarios do portal

Observacao: o modulo PETrello nao faz parte da versao atual.

## Regras importantes de negocio

- Fuso principal: `America/Sao_Paulo`
- Pagina inicial autenticada: `/relatorios`
- Healthcheck: `/healthz`
- Sincronizacao Relatorio x Planner via `report_week_goal.planner_task_id`
- Relatorios quinzenais possuem 2 dias de tolerancia:
  - entregas da primeira quinzena podem ser preenchidas ate o fim do dia 17;
  - entregas da segunda quinzena podem ser preenchidas ate o fim do dia 02 do mes seguinte;
  - dentro dessa janela, tarefas nao aparecem como atrasadas.
- Usuarios do portal sao desativados logicamente, nao apagados fisicamente, para preservar historico de chat, relatorios e auditoria.
- Membros inativos deixam de aparecer nas listas operacionais e nos relatorios atuais.
- Presenca de eventos usa o banco PostgreSQL como fonte de verdade; a planilha local nao deve ser usada para registrar cada bip.
- Ouvintes de evento usam o cadastro simples `CRACHA`, `NOME`, `CPF`, `EMAIL`.

## Stack atual

- Backend: Node.js + Express
- Views: Nunjucks
- Banco: PostgreSQL (Neon)
- Sessao: `cookie-session`
- Uploads: local ou Cloudinary
- PDF: PDFKit
- Importacao/exportacao: CSV
- Deploy alvo: Render

## Requisitos

- Node.js 18+
- NPM 9+
- Banco PostgreSQL acessivel por `DATABASE_URL`

## Como rodar localmente

1. Instale dependencias:

```bash
npm install
```

2. Crie `.env` na raiz a partir de `.env.example`. Exemplo minimo:

```env
NODE_ENV=development
PORT=3000
SECRET_KEY=troque-esta-chave
DATABASE_URL=postgresql://USUARIO:SENHA@HOST/DB?sslmode=verify-full
SESSION_MAX_AGE_HOURS=1
APP_TIMEZONE=America/Sao_Paulo
REPORTS_TIMEZONE=America/Sao_Paulo
APP_BASE_URL=http://127.0.0.1:3000
```

3. Opcionalmente, crie usuario inicial:

```bash
npm run create-user
```

4. Inicie a aplicacao:

```bash
npm run dev
```

URL local padrao: `http://127.0.0.1:3000`

## Scripts

```bash
npm run dev
npm start
npm run create-user
npm run verify
npm run notify:run-once
```

`npm run verify` usa `DATABASE_URL` e cria dados temporarios de verificacao; execute preferencialmente em uma base de teste.

## Presenca de eventos

Telas principais:

- `/presenca/eventos`: cria, edita, exclui e define evento ativo.
- `/presenca/ouvintes`: tabela de ouvintes, busca, edicao, importacao CSV e exportacao CSV.
- `/presenca/check-in`: tela para bipar ou digitar o codigo do cracha no dia do evento.

CSV de importacao:

```csv
cracha,nome,cpf,email
A001,Joao Silva,000.000.000-00,joao@exemplo.com
```

CSV de exportacao:

```csv
CRACHA,NOME,CPF,EMAIL,PRESENTE,REGISTRADO_EM
```

Para eventos presenciais com fila, mantenha um CSV local de contingencia com `cracha,nome,cpf,email,registrado_em` caso internet, Render ou Neon fiquem indisponiveis temporariamente.

## Variaveis de ambiente

### Obrigatorias

- `DATABASE_URL`
- `SECRET_KEY`

### Recomendadas

- `NODE_ENV`
- `PORT`
- `SESSION_MAX_AGE_HOURS`
- `APP_BASE_URL`
- `APP_TIMEZONE`
- `REPORTS_TIMEZONE`

### Bootstrap inicial opcional

- `BOOTSTRAP_ADMIN`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

### Upload opcional

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`

### Email e notificacoes opcionais

- `EMAIL_PROVIDER` (padrao: `brevo`)
- `BREVO_API_KEY`
- `EMAIL_FROM`
- `EMAIL_FROM_NAME`
- `EMAIL_REPLY_TO`
- `NOTIFICATION_SWEEP_INTERVAL_MS`

### Ajustes tecnicos opcionais

- `REQUEST_LOGS=1`
- `DB_SYNC_QUERY_TIMEOUT_MS`
- `PG_CONNECTION_TIMEOUT_MS`

## Seguranca antes de compartilhar a pasta

Antes de enviar este diretorio para outra pessoa, revise:

- nao inclua `.env`, dumps de banco, backups, logs ou chaves privadas;
- remova `node_modules/`, que pode ser recriado com `npm install`;
- evite enviar arquivos CSV com dados reais de ouvintes;
- revise `app/static/uploads/`, pois pode conter fotos, logos ou arquivos enviados por usuarios;
- gere um pacote a partir do Git limpo, de preferencia com `git archive`, em vez de compactar a pasta inteira;
- rode `npm audit` e corrija vulnerabilidades aplicaveis;
- troque `SECRET_KEY`, senhas bootstrap e tokens caso algum segredo tenha sido compartilhado por engano.

## Arquivos que normalmente nao devem ser enviados

- `.env`
- `node_modules/`
- `*.log`
- `*.db`, `*.sqlite`, `*.sqlite3`
- dumps ou backups de banco
- CSVs, planilhas ou exportacoes com dados pessoais
- uploads com dados sensiveis

## Documentacao do projeto

- [GUIA_OPERACAO.md](./docs/GUIA_OPERACAO.md) - deploy, incidentes, backup e restore
- [GUIA_DESENVOLVIMENTO.md](./docs/GUIA_DESENVOLVIMENTO.md) - arquitetura e alteracao segura
- [GUIA_DADOS_E_PERMISSOES.md](./docs/GUIA_DADOS_E_PERMISSOES.md) - modelagem e acesso
