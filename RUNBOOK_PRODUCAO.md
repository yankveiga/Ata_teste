# Runbook de Produção - Portal PET C3

Objetivo: operação prática em Render + Neon + Cloudinary.
Última revisão: **25/04/2026**.

## 1) Pré-deploy

Validar variáveis no Render:
- `NODE_ENV=production`
- `PORT` (opcional; Render injeta quando necessário)
- `SECRET_KEY`
- `DATABASE_URL`
- `SESSION_MAX_AGE_HOURS`
- `APP_TIMEZONE=America/Sao_Paulo`
- `PRESENCE_WORKBOOK_PATH` (se presença em XLSX estiver ativa)
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`

Bootstrap inicial de admin (apenas primeiro boot, opcional):
- `BOOTSTRAP_ADMIN=true`
- após criar o admin inicial -> voltar para `BOOTSTRAP_ADMIN=false`

## 2) Deploy

- Build Command: `npm install`
- Start Command: `npm start`

Smoke test mínimo pós-deploy:
1. Login e logout
2. Relatórios (abrir, criar tarefa, editar/concluir)
3. Planner (abrir no relatório, alternar Projeto/Individual)
4. Atas (criar + baixar PDF)
5. Projetos (criar/editar)
6. Almoxarifado (abrir e listar itens)
7. Upload de foto/logo

## 3) Verificação técnica

No ambiente com `DATABASE_URL` válido:
```bash
npm run verify
```

Esperado: `Verificação concluída com sucesso.`

## 4) Backup

Banco (semanal):
```bash
pg_dump "$DATABASE_URL" -Fc -f backup_$(date +%F).dump
```

Retenção recomendada:
- 4 backups semanais
- 3 backups mensais

Se presença em planilha estiver ativa:
- copiar `planilha_presenca.xlsx` semanalmente

## 5) Restore

Banco:
```bash
pg_restore -d "$DATABASE_URL" --clean --if-exists backup_YYYY-MM-DD.dump
```

Ordem sugerida:
1. abrir janela de manutenção
2. executar restore
3. reiniciar serviço no Render
4. rodar smoke test completo

## 6) Incidentes comuns

### A) Processo caiu com `SIGTERM`
- Verificar histórico de deploy/restart no Render
- Verificar saúde do Neon
- Reiniciar e revalidar fluxos críticos

### B) Falha de conexão com banco
- Conferir `DATABASE_URL`
- Conferir host/credenciais no Neon
- SSL: preferir `sslmode=verify-full` quando possível

### C) Upload falhando
- Validar `CLOUDINARY_*`
- Testar upload de imagem pequena
- Verificar se arquivo remoto foi persistido

### D) Erro 500 em tela específica
- Capturar `requestId` no log
- Mapear rota
- Identificar consulta/validação quebrada
- Corrigir e redeploy

## 7) Rollback

1. Voltar ao último deploy estável no Render
2. Validar login + módulo crítico impactado
3. Se necessário, restaurar backup

## 8) Pós-incidente

Registrar:
- causa raiz
- impacto
- correção aplicada
- ação preventiva

Atualizar docs relacionados:
- `DOCUMENTACAO_TECNICA_COMPLETA.md`
- `GUIA_ARQUITETURA.md`
- `MATRIZ_PERMISSOES.md` (se afetar autorização)
