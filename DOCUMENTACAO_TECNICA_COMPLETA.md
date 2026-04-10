# Documentacao Tecnica Completa (Server + src + app)

Este documento complementa os comentarios inline do codigo e funciona como guia de manutencao.
Objetivo: explicar de forma profissional o papel de cada arquivo e indicar onde adicionar novas funcionalidades.

## 1) Visao Geral da Arquitetura

- Entrada da aplicacao: `server.js`
- Composicao do app e injecao de dependencias: `src/app.js`
- Rotas HTTP por dominio: `src/routes/*.js`
- Persistencia de dados (Neon/PostgreSQL): `src/database.js`
- Padrao HTTP (requestId + erro JSON): `src/http.js`
- Servicos de negocio: `src/services/*.js`
- Validadores: `src/validators/*.js`
- Utilitarios globais (datas, csrf, rotas nomeadas): `src/utils.js`
- Geracao de PDF: `src/pdf.js`
- Configuracoes de ambiente: `src/config.js`
- Midia (Cloudinary/fallback local): `src/media.js`
- Interface web: `app/templates/*`
- Estilos: `app/static/css/*`
- Comportamento de frontend: `app/static/js/*`

## 2) Backend (server.js + src)

### `server.js`
- Responsabilidade: bootstrap da aplicacao.
- O que faz:
  - garante schema inicial do banco
  - copia planilha de presenca para path de runtime quando necessario
  - cria admin inicial via `BOOTSTRAP_ADMIN` (opcional)
  - sobe servidor HTTP na `PORT`
- Onde adicionar:
  - inicializacao de servicos globais no boot
  - logs de observabilidade da aplicacao

### `src/config.js`
- Responsabilidade: consolidar variaveis de ambiente e paths.
- Onde adicionar:
  - novas variaveis de ambiente (tokens, urls, flags)
  - novos diretórios globais de runtime

### `src/app.js`
- Responsabilidade: composicao principal do Express e wiring dos modulos.
- Blocos principais:
  - middlewares de sessao, csrf, parser de body
  - autenticacao/autorizacao base (helpers)
  - uploads de imagem
  - registro das rotas modulares (`register*Routes`)
- Onde adicionar:
  - nova rota HTTP: no modulo correspondente em `src/routes`
  - nova regra de permissao: helpers de autorizacao em `app.js`
  - validacao compartilhada: `src/validators`
  - nova pagina: rota + template em `app/templates`

### `src/routes/*.js`
- Responsabilidade: handlers HTTP por dominio.
- Modulos atuais:
  - `src/routes/auth.js`
  - `src/routes/reports.js`
  - `src/routes/members.js`
  - `src/routes/projects.js`
  - `src/routes/atas.js`
  - `src/routes/almox.js`
- Onde adicionar:
  - endpoints novos do dominio
  - regras de fluxo da tela/API daquele modulo

### `src/database.js`
- Responsabilidade: schema e operacoes de persistencia.
- Blocos principais:
  - `ensureSchema()`
  - CRUD de membros, projetos, atas, metas e almoxarifado
  - consultas de listagem e dashboard
  - auditorias e ordenacao de metas
- Onde adicionar:
  - nova tabela/indice: em `ensureSchema()`
  - nova consulta: nova funcao no modulo
  - nova regra de ordenacao: funcao de listagem correspondente

### `src/utils.js`
- Responsabilidade: funcoes reutilizaveis.
- Blocos principais:
  - rotas nomeadas (`urlFor`)
  - csrf/flash
  - parse de ids
  - formatacao de data e timezone (`America/Sao_Paulo`)
  - utilitarios de arquivo e validacoes
- Onde adicionar:
  - helper compartilhado por mais de uma rota/template
  - regras de formatacao global

### `src/http.js`
- Responsabilidade: padrao de request/erro para HTTP.
- O que faz:
  - gera `requestId` por requisicao
  - expoe `logError(req, ...)`
  - expoe `sendApiError(req, res, ...)` para respostas JSON padronizadas

### `src/services/*.js`
- `src/services/reportService.js`: regras de negocio de relatorios (permissao/exportacao mensal).
- `src/services/inventoryService.js`: mapeamentos/formatos do almoxarifado.

### `src/validators/*.js`
- `src/validators/reportValidators.js`: validacoes de metas semanais.
- `src/validators/inventoryValidators.js`: validacoes de estoque/categoria/local.

### `src/pdf.js`
- Responsabilidade: gerar PDFs (atas e relatorio mensal).
- Onde adicionar:
  - novo modelo de documento PDF
  - campos adicionais de exportacao

### `src/media.js`
- Responsabilidade: integracao com Cloudinary.
- O que faz:
  - detecta se Cloudinary esta habilitado
  - upload de imagem
  - remocao de imagem
  - identifica URL remota vs arquivo local
- Onde adicionar:
  - outro provider de storage (S3, Supabase Storage)
  - transformacoes de imagem no upload

## 3) Camada de Interface (app/templates)

### Estrutura base

#### `app/templates/base.html`
- Shell principal da aplicacao autenticada.
- Onde adicionar:
  - novos links de menu lateral
  - assets globais de front-end

#### `app/templates/partials/atas_tabs.html`
- Navegacao horizontal do modulo de Atas.
- Onde adicionar:
  - novas abas do modulo Atas.

### Modulos

#### Login
- `app/templates/login.html`
- Onde adicionar:
  - campos extras de autenticacao
  - textos institucionais da tela de login

#### Servicos
- `app/templates/services.html`
- Onde adicionar:
  - novo card de modulo na central

#### Atas
- `app/templates/home.html`
- `app/templates/atas/create_form.html`
- Onde adicionar:
  - novo campo no formulario de ata
  - novo resumo/indicador na home de atas

#### Membros
- `app/templates/members/list.html`
- `app/templates/members/form.html`
- Onde adicionar:
  - novos campos cadastrais do membro
  - novos botoes administrativos

#### Projetos
- `app/templates/projects/list.html`
- `app/templates/projects/form.html`
- Onde adicionar:
  - novo metadado de projeto
  - alteracao do fluxo de coordenacao

#### Presenca
- `app/templates/presenca/index.html`
- Onde adicionar:
  - novos eventos/campos de registro
  - regras visuais de feedback

#### Relatorios
- `app/templates/reports/index.html`
- Onde adicionar:
  - novos blocos do kanban/scrum
  - historico e auditoria visual
  - novos filtros de exportacao PDF

#### Almoxarifado
- `app/templates/almoxarifado/index.html`
- Onde adicionar:
  - novas abas operacionais
  - novos formularios/acoes por perfil

#### Erros
- `app/templates/errors/404.html`
- `app/templates/errors/500.html`
- Onde adicionar:
  - orientacoes de suporte para usuario final

## 4) Frontend JS (app/static/js)

### `app/static/js/admin_dashboard_script.js`
- Controle da sidebar e interacoes do shell.
- Onde adicionar:
  - novo comportamento global de navegacao

### `app/static/js/almoxarifado.js`
- Troca de abas e filtros locais do almoxarifado.
- Onde adicionar:
  - filtros de tabela adicionais
  - persistencia de estado de UI na URL

## 5) Frontend CSS (app/static/css)

### `admin_dashboard_style.css`
- Estilo base do layout autenticado.

### `custom_styles.css`
- Componentes compartilhados + relatorios/atas.

### `almoxarifado.css`
- Visual exclusivo do modulo Almoxarifado.

### `services.css`
- Visual da central de servicos.

### `login.css`
- Visual da tela de login.

## 6) Onde adicionar cada tipo de demanda (atalho rapido)

- Nova rota backend: `src/routes/<modulo>.js`
- Nova tabela/campo de banco: `src/database.js` (`ensureSchema` + CRUD)
- Nova permissao por perfil: helpers em `src/app.js` e aplicacao em `src/routes/*`
- Nova exportacao PDF: `src/pdf.js`
- Novo helper global: `src/utils.js`
- Novo erro padronizado de API: `src/http.js` (`sendApiError`)
- Nova integracao de midia: `src/media.js`
- Novo card/aba de tela: `app/templates/*` + `app/static/css/*`
- Novo comportamento JS da tela: `app/static/js/*`

## 7) Configuracao de producao (resumo)

- Banco Neon: `DATABASE_URL`
- Timezone do sistema: `APP_TIMEZONE=America/Sao_Paulo`
- Sessao: `SECRET_KEY`
- Midia persistente: `CLOUDINARY_*`
- Bootstrap admin (somente 1a subida): `BOOTSTRAP_ADMIN=true` e depois `false`

## 8) Regra pratica de manutencao

- Interface: template + css
- Regra de negocio: routes + services
- Persistencia/consultas: database.js
- Documentacao da mudanca: README + MAPA_PROJETO + este arquivo
