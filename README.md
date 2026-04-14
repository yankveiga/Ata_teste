# Portal PET C3

Sistema web interno em **Node.js + Express + Nunjucks** com:
- Gestor de Atas
- Relatórios Semanais
- Almoxarifado
- Controle de Presença

Banco principal: **PostgreSQL (Neon)**  
Mídia em produção: **Cloudinary**  
Deploy: **Render**

## Começo rápido (local)

```bash
npm install
# preencher .env (DATABASE_URL e SECRET_KEY)
npm run create-user
npm start
```

Acesso local: `http://127.0.0.1:3000`

## Variáveis essenciais

- `DATABASE_URL`
- `SECRET_KEY`
- `SESSION_MAX_AGE_HOURS=1`
- `APP_TIMEZONE=America/Sao_Paulo`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_FOLDER`

## Deploy (resumo)

Render:
- Build: `npm install`
- Start: `npm start`
- Configurar variáveis de ambiente (incluindo `DATABASE_URL`)

## Estrutura principal

- `server.js`: bootstrap da aplicação
- `src/app.js`: middlewares e registro de rotas
- `src/routes/*`: rotas por domínio
- `src/services/*`: regras de negócio
- `src/database.js`: schema e queries
- `app/templates/*`: páginas
- `app/static/css/*`: estilos

## Documentação (sem redundância)

- `MAPA_PROJETO.txt` -> onde editar cada funcionalidade (atalho rápido)
- `GUIA_ARQUITETURA.md` -> visão técnica de camadas e módulos
- `RUNBOOK_PRODUCAO.md` -> deploy, backup, restore e incidentes
- `DOCUMENTACAO_TECNICA_COMPLETA.md` -> guia de manutenção e evolução
- `MODELAGEM_BANCO.md` -> modelagem do banco

## Verificação rápida

```bash
npm run verify
```
