# Guia de Operacao

Ultima revisao: 19/09/2026

Este guia e para quem precisa rodar, publicar, testar, monitorar ou resolver problema no Portal PET C3.

## Ambientes

Producao atual/alvo:

- App web: Render
- Banco: PostgreSQL/Neon
- Midia: local ou Cloudinary
- Email: Brevo opcional

Local:

- Node.js
- `.env`
- PostgreSQL remoto ou base de teste
- `npm run dev`

Temporario em casa:

- App local em `localhost:3000`
- Cloudflare Tunnel ou ngrok
- Recomendado para teste curto, nao para operacao permanente

## Variaveis essenciais

Obrigatorias:

- `DATABASE_URL`
- `SECRET_KEY`

Recomendadas em producao:

- `NODE_ENV=production`
- `PORT`
- `APP_BASE_URL`
- `SESSION_MAX_AGE_HOURS`
- `APP_TIMEZONE=America/Sao_Paulo`
- `REPORTS_TIMEZONE=America/Sao_Paulo`

Uploads:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`

Email:

- `EMAIL_PROVIDER`
- `BREVO_API_KEY`
- `EMAIL_FROM`
- `EMAIL_FROM_NAME`
- `EMAIL_REPLY_TO`
- `NOTIFICATION_SWEEP_INTERVAL_MS`

Tecnicas:

- `REQUEST_LOGS`
- `DB_SYNC_QUERY_TIMEOUT_MS`
- `PG_CONNECTION_TIMEOUT_MS`

Bootstrap:

- `BOOTSTRAP_ADMIN`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`

Use bootstrap somente quando precisar criar usuario inicial. Remova/desative depois.

## Deploy no Render

Build:

```bash
npm install
```

Start:

```bash
npm start
```

Healthcheck:

```text
GET /healthz
```

Resposta esperada:

```text
ok
```

## Smoke test depois de deploy

1. Abrir `/healthz`.
2. Fazer login.
3. Abrir `/relatorios`.
4. Trocar membro no seletor.
5. Criar/editar uma meta simples em base de teste.
6. Abrir planner pelo atalho.
7. Abrir `/home` e baixar uma ata existente, se houver.
8. Abrir `/almoxarifado`.
9. Abrir `/presenca/eventos`, `/presenca/ouvintes` e `/presenca/check-in`.
10. Abrir `/mensagens`.
11. Sair e entrar novamente.

Se algum passo travar, olhar logs do Render e status do banco.

## Rodar localmente

```bash
npm install
npm run dev
```

URL:

```text
http://127.0.0.1:3000
```

Verificacao tecnica:

```bash
npm run verify
```

Criar usuario inicial:

```bash
npm run create-user
```

Rodar notificacoes uma vez:

```bash
npm run notify:run-once
```

## Tunel temporario local

Use para mostrar o sistema temporariamente sem deploy.

1. Rode o app:

```powershell
npm start
```

2. Em outro terminal, na pasta do `cloudflared`:

```powershell
.\cloudflared-windows-amd64.exe tunnel --url http://localhost:3000
```

3. Compartilhe a URL `https://...trycloudflare.com`.

Cuidados:

- O computador precisa ficar ligado.
- O terminal do tunnel precisa ficar aberto.
- Nao deixe publico por muito tempo.
- Nao use como producao definitiva.
- Se usar banco real, qualquer pessoa com login valido pode acessar pela URL.

## Operacao por modulo

### Relatorios

Rota:

- `/relatorios`

Operacoes comuns:

- selecionar membro;
- filtrar projeto;
- criar/meta da quinzena;
- usar planner embutido;
- abrir advertencias atuais;
- acessar mais acoes: executadas, exclusoes, historico de tarefas e PDF.

Pontos de atencao:

- Relatorios dependem de membros ativos.
- Advertencias aparecem ao lado do nome.
- O acompanhamento de 365 dias calcula dias restantes na leitura, sem job diario.

### Advertencias

Onde operar:

- `/relatorios`, no painel do membro.

Quem altera:

- membros do projeto `Administrativo`.

Fluxos:

- `+ Nova advertencia`: adiciona uma advertencia.
- `Ver advertencias atuais`: abre historico e acoes de editar/excluir.
- Ao atingir 3: mensagem administrativa automatica para todos.
- Em 01/01 e 02/07: ciclo automatico ao abrir relatorios.

Conferir se deu certo:

- numero ao lado do membro;
- modal de historico;
- conversa administrativa no chat quando atinge 3;
- indicador de 365 dias quando aplicavel.

### Planner

Rota:

- `/planner`

Pontos de atencao:

- tarefas atrasadas e concluidas geram logs;
- relatorios podem abrir planner embutido;
- lentidao geralmente vem de consultas amplas ou banco remoto frio.

### Atas

Rotas:

- `/home`
- `/atas/nova`

Operacoes:

- criar ata;
- gerar PDF;
- baixar ata recente;
- excluir se permitido.

### Almoxarifado

Rota:

- `/almoxarifado`

Abas:

- Visao Geral
- Estoque
- Cadastro
- Retiradas
- Emprestimos
- Materiais Emprestados
- Historico

Pontos de atencao:

- A tela deve carregar por aba para nao ficar lenta.
- Retirada de estoque registra historico em `pedido`.
- Emprestimo de patrimonio registra `inventory_loan`.
- Devolucao precisa devolver quantidade ao item.

### Presenca

Rotas:

- `/presenca/eventos`
- `/presenca/ouvintes`
- `/presenca/check-in`
- `/presenca/crachas`

Fluxo recomendado:

1. Criar atividade em `/presenca/eventos`.
2. Importar/cadastrar ouvintes em `/presenca/ouvintes`.
3. Selecionar atividade e vincular ouvintes.
4. Abrir `/presenca/check-in`.
5. Fazer teste com alguns crachas.
6. Usar check-in no evento.
7. Exportar CSV da atividade ou XLSX geral.

CSV de importacao:

```csv
cracha,nome,cpf,email
A001,Joao Silva,000.000.000-00,joao@exemplo.com
```

CSV de exportacao:

```csv
CRACHA,NOME,CPF,EMAIL,PRESENTE,REGISTRADO_EM
```

Contingencia para evento:

- Tenha um CSV local com `cracha,nome,cpf,email,registrado_em`.
- Se internet/Render/Neon cair, continue registrando localmente.
- Depois reconcilie manualmente no sistema.
- Abra o sistema 10 minutos antes para evitar cold start.
- Tenha segundo notebook logado se o evento for importante.

### Chat

Rota:

- `/mensagens`

Pontos de atencao:

- Conversas administrativas podem ser somente leitura.
- Conversas de advertencia usam remetente `Administrativo`.
- Contador de nao lidas tem cache curto.

### Usuarios, membros e projetos

Rotas:

- `/manutencao-usuarios`
- `/members`
- `/projects`

Pontos de atencao:

- Desative usuarios/membros em vez de excluir quando houver historico.
- Vinculo `user.member_id` e importante para permissoes contextuais.
- Coordenadores sao definidos por projeto.

## Diagnostico de lentidao

1. Verificar se o Render esta frio/reiniciando.
2. Verificar latencia/status do Neon.
3. Habilitar temporariamente:

```env
REQUEST_LOGS=1
```

4. Reproduzir a tela lenta.
5. Ver nos logs qual rota demora.
6. Testar:

- `/relatorios`
- `/planner`
- `/almoxarifado`
- `/presenca/ouvintes`
- `/mensagens`

7. Desligar `REQUEST_LOGS` depois.

Checklist tecnico:

- A rota carregou dados de abas escondidas?
- Tem query em loop?
- Tem historico sem `LIMIT`?
- Alguma consulta usa `CAST` que ignora indice?
- Algum middleware global esta fazendo consulta desnecessaria?
- Static assets estao passando por sessao/DB?

## Backup e restore

Backup:

```bash
pg_dump "$DATABASE_URL" -Fc -f backup_YYYY-MM-DD.dump
```

Restore:

```bash
pg_restore -d "$DATABASE_URL" --clean --if-exists backup_YYYY-MM-DD.dump
```

Antes de grandes importacoes ou mudancas de schema, gere backup.

## Incidentes comuns

### Login falha

- Verificar se usuario esta ativo.
- Verificar `DATABASE_URL`.
- Verificar logs do Render.
- Verificar se `SECRET_KEY` mudou e invalidou sessoes.

### App abre mas paginas travam

- Habilitar `REQUEST_LOGS`.
- Conferir Neon.
- Conferir rota especifica lenta.
- Verificar se houve mudanca recente em middleware global.

### Almoxarifado lento

- Confirmar se a tela esta carregando somente dados da aba atual.
- Conferir consultas em `listInventoryItems`, `listInventoryLoans`, `listInventoryRequests`.
- Conferir indices de `estoque`, `pedido`, `inventory_loan`.

### Presenca falha no evento

- Conferir internet local.
- Conferir Render.
- Conferir Neon.
- Usar contingencia CSV se necessario.
- Depois registrar/reconciliar no sistema.

### Upload falha

- Conferir Cloudinary se estiver ativo.
- Conferir permissao de escrita local se Cloudinary nao estiver ativo.

### Email nao envia

- Conferir `BREVO_API_KEY`.
- Conferir `EMAIL_FROM`.
- Conferir `APP_BASE_URL`.
- Rodar `npm run notify:run-once`.

## Seguranca operacional

Nunca publicar:

- `.env`
- dumps de banco;
- planilhas reais;
- CSV com dados pessoais;
- uploads sensiveis;
- tokens e chaves.

Quando passar o projeto para outra pessoa:

```bash
git status --short
npm run verify
```

Prefira enviar um pacote limpo do Git em vez de compactar a pasta inteira.

## Rollback

1. Voltar para ultimo deploy estavel.
2. Validar `/healthz`.
3. Fazer login.
4. Testar modulo afetado.
5. Restaurar backup apenas se houve corrupcao/perda de dados.
6. Registrar o que aconteceu para evitar repeticao.
