# Runbook de Produção - Portal PET C3

Objetivo: operação prática do ambiente Render + Neon + Cloudinary.

## 1) Pré-deploy

Confirmar no Render:
- `NODE_ENV=production`
- `SECRET_KEY`
- `DATABASE_URL`
- `APP_TIMEZONE=America/Sao_Paulo`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`
- `PRESENCE_WORKBOOK_PATH` (se usado)

Bootstrap inicial (somente 1º boot, opcional):
- `BOOTSTRAP_ADMIN=true`
- após criar admin: voltar para `BOOTSTRAP_ADMIN=false`

## 2) Deploy

- Build: `npm install`
- Start: `npm start`
- Fazer smoke test:
  - login
  - atas (criar + baixar PDF)
  - relatórios (criar/editar meta)
  - almoxarifado (carregar tela)
  - upload de foto/logo

## 3) Backup

Banco (semanal):
```bash
pg_dump "$DATABASE_URL" -Fc -f backup_$(date +%F).dump
```

Retenção mínima recomendada:
- 4 backups semanais

Planilha de presença (se ativa):
- copiar `planilha_presenca.xlsx` semanalmente

## 4) Restore

Banco:
```bash
pg_restore -d "$DATABASE_URL" --clean --if-exists backup_YYYY-MM-DD.dump
```

Ordem:
1. janela de manutenção
2. restore
3. restart do serviço
4. smoke test

## 5) Incidentes comuns

A) App caiu com `SIGTERM`
- verificar se houve restart/deploy no Render
- verificar evento no Neon
- reiniciar e validar fluxos críticos

B) Falha de conexão com banco
- revisar `DATABASE_URL`
- validar host/credenciais no Neon
- conferir SSL mode

C) Upload falhando
- revisar `CLOUDINARY_*`
- testar novo upload de imagem pequena

D) Erro 500 em módulo
- identificar rota no log
- verificar query/dado inconsistente
- aplicar correção e redeploy

## 6) Rollback

1. voltar para último deploy estável no Render
2. validar login + fluxo crítico
3. se necessário, restaurar backup
