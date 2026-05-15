# Guia de Operacao

Ultima revisao: 14/05/2026

Se precisar operar deploy, incidente, backup ou restore, use este guia.

## Ambiente de producao

- App web: Render
- Banco: Neon/PostgreSQL
- Midia: Cloudinary (opcional)
- Presenca: XLSX em caminho persistente
- Email: Brevo (opcional)

## Variaveis essenciais (Render)

- `NODE_ENV=production`
- `SECRET_KEY`
- `DATABASE_URL`
- `APP_BASE_URL`
- `PORT`
- `SESSION_MAX_AGE_HOURS`
- `APP_TIMEZONE`
- `REPORTS_TIMEZONE`
- `PRESENCE_WORKBOOK_PATH`

Opcional:

- `CLOUDINARY_*`
- `EMAIL_PROVIDER`, `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`
- `NOTIFICATION_SWEEP_INTERVAL_MS`
- `BOOTSTRAP_ADMIN*` (somente bootstrap inicial)

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
8. Presenca: registrar evento

## Verificacao tecnica

```bash
npm run verify
```

## Backup e restore

Backup:

```bash
pg_dump "$DATABASE_URL" -Fc -f backup_YYYY-MM-DD.dump
```

Restore:

```bash
pg_restore -d "$DATABASE_URL" --clean --if-exists backup_YYYY-MM-DD.dump
```

## Incidentes comuns

- App cai apos login: validar logs, `DATABASE_URL`, schema no startup
- Conexao DB instavel: validar Neon e timeouts (`PG_CONNECTION_TIMEOUT_MS`, `DB_SYNC_QUERY_TIMEOUT_MS`)
- Upload falhando: revisar `CLOUDINARY_*` ou escrita local
- Presenca falhando: validar escrita em `PRESENCE_WORKBOOK_PATH`
- Email falhando: validar `BREVO_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL`

## Rollback

1. Voltar para ultimo deploy estavel
2. Validar `/healthz`
3. Validar login e modulo afetado
4. Restaurar backup se necessario
