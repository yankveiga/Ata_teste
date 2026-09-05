# Guia de Operacao

Ultima revisao: 05/09/2026

Se precisar operar deploy, incidente, backup, restore ou check-in de evento, use este guia.

## Ambiente de producao

- App web: Render
- Banco: Neon/PostgreSQL
- Midia: Cloudinary (opcional)
- Presenca: tabelas no PostgreSQL, com importacao/exportacao CSV
- Email: Brevo (opcional)

## Variaveis essenciais no Render

- `NODE_ENV=production`
- `SECRET_KEY`
- `DATABASE_URL`
- `APP_BASE_URL`
- `PORT`
- `SESSION_MAX_AGE_HOURS`
- `APP_TIMEZONE`
- `REPORTS_TIMEZONE`

Opcional:

- `CLOUDINARY_*`
- `EMAIL_PROVIDER`, `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`
- `NOTIFICATION_SWEEP_INTERVAL_MS`
- `BOOTSTRAP_ADMIN*` somente no bootstrap inicial

Recomendacao para PostgreSQL: usar `sslmode=verify-full` na `DATABASE_URL` quando o provedor suportar.

## Deploy

- Build: `npm install`
- Start: `npm start`
- Healthcheck: `GET /healthz` deve retornar `200 ok`

## Smoke test pos deploy

1. Login/logout
2. Relatorios: criar e atualizar meta
3. Planner: criar e concluir tarefa
4. Atas: criar e baixar PDF
5. Almoxarifado: criar item e listar
6. Mensagens: criar conversa e enviar mensagem
7. Projetos: criar/editar
8. Presenca: criar evento, importar CSV, registrar um check-in e exportar CSV

## Monitoramento de lentidao

Quando usuarios relatarem lentidao:

1. Conferir se o servico no Render estava frio ou reiniciando.
2. Conferir status e latencia do Neon/PostgreSQL.
3. Habilitar temporariamente `REQUEST_LOGS=1` e observar nos logs quais rotas passam de alguns segundos.
4. Testar paginas historicamente mais pesadas: `/relatorios`, `/planner`, `/projects`, `/almoxarifado` e `/mensagens`.
5. Desabilitar `REQUEST_LOGS` depois da investigacao para reduzir ruido de log.

Observacoes tecnicas:

- O schema e garantido no startup e nao deve repetir o pacote completo de migracoes durante o uso normal do app.
- Algumas consultas repetidas dentro da mesma requisicao usam cache local da propria requisicao.
- O contador de mensagens nao lidas usa cache curto e e atualizado quando conversas sao lidas ou novas mensagens sao enviadas.

## Presenca em evento

Fluxo recomendado antes do evento:

1. Criar a atividade/palestra/minicurso em `/presenca/eventos`.
2. Cadastrar/importar a lista geral de ouvintes em `/presenca/ouvintes` com CSV no formato `cracha,nome,cpf,email`.
3. Selecionar o evento em `/presenca/ouvintes` e vincular os ouvintes que pagaram/participam daquele evento.
4. Conferir a pre-visualizacao e resolver duplicados.
5. Abrir `/presenca/check-in` em um computador logado e selecionar o evento correto.
6. Fazer um teste com 2 ou 3 crachas antes da fila abrir.
7. Exportar CSV da atividade ou XLSX geral em `/presenca/exportar-geral.xlsx`.

Para uma fila de cerca de 100 pessoas, o fluxo atual deve ser tranquilo: cada bip gera uma requisicao pequena e uma gravacao simples no banco. O gargalo real costuma ser internet instavel, Render frio ou indisponibilidade temporaria do Neon.

## Contingencia simples para check-in

Tenha sempre um plano B pronto antes do evento:

- deixe um CSV aberto localmente com colunas `cracha,nome,cpf,email,registrado_em`;
- se a tela online falhar, continue bipando/digitando os codigos nesse CSV;
- quando o sistema voltar, confira os codigos no modulo Ouvintes e registre ou reconcilie os presentes;
- ao fim, exporte o CSV oficial do evento pelo sistema.

Para reduzir risco:

- abra a tela de check-in 10 minutos antes e mantenha a sessao ativa;
- evite depender de internet de celular sem teste previo;
- tenha um segundo notebook logado como reserva;
- nao deixe o servico acordar pela primeira vez quando a fila ja estiver formada;
- faca backup do banco antes de grandes importacoes.

## Verificacao tecnica

```bash
npm run verify
```

## Backup e restore do banco

Backup:

```bash
pg_dump "$DATABASE_URL" -Fc -f backup_YYYY-MM-DD.dump
```

Restore:

```bash
pg_restore -d "$DATABASE_URL" --clean --if-exists backup_YYYY-MM-DD.dump
```

## Incidentes comuns

- App cai apos login: validar logs, `DATABASE_URL` e schema no startup.
- Conexao DB instavel: validar Neon e timeouts (`PG_CONNECTION_TIMEOUT_MS`, `DB_SYNC_QUERY_TIMEOUT_MS`).
- Paginas lentas: habilitar `REQUEST_LOGS=1`, identificar rota lenta e conferir se o Neon esta respondendo com alta latencia.
- Upload falhando: revisar `CLOUDINARY_*` ou escrita local.
- Presenca falhando: verificar Render, Neon, internet local e usar contingencia CSV.
- Email falhando: validar `BREVO_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL`.

## Organizacao de arquivos operacionais

- `.env.example` documenta variaveis sem segredos.
- `docs/` guarda guias do projeto.
- `data/examples/` pode guardar exemplos sem dados reais sensiveis.
- Planilhas reais, dumps e backups devem ficar fora do Git.

## Rollback

1. Voltar para ultimo deploy estavel.
2. Validar `/healthz`.
3. Validar login e modulo afetado.
4. Restaurar backup se necessario.
