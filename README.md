# Portal PET C3

Aplicação web em **Node.js + Express + Nunjucks** que unifica dois serviços no mesmo sistema:

- **Gestor de Atas**
- **Almoxarifado / Patrimônio**

O projeto usa **login único**, **sessão compartilhada** e **PostgreSQL (Neon)** como banco.

## O que o sistema faz

- autenticação centralizada para os dois serviços
- tela de seleção entre **Atas** e **Almoxarifado**
- gestão de membros e projetos
- criação e download de atas em PDF
- controle de patrimônio, categorias, locais e retiradas
- histórico de movimentações do almoxarifado
- controle de permissão por perfil de usuário

## Perfis de acesso

- `admin`: pode gerenciar membros, projetos, usuários, itens de patrimônio, categorias e locais
- `common`: pode usar os dois serviços, criar atas, consultar estoque e registrar retiradas, mas sem ações administrativas

## Stack atual

- **Backend:** Node.js + Express
- **Views:** Nunjucks
- **Banco:** PostgreSQL (Neon)
- **Auth:** cookie-session + bcryptjs
- **PDF:** PDFKit

## Banco de dados

O sistema usa `DATABASE_URL` para conectar no PostgreSQL (Neon).  
O schema é criado/atualizado automaticamente na inicialização.

## Rodando localmente

1. Instale as dependências:

```bash
npm install
```

2. Crie o primeiro usuário:

```bash
npm run create-user
```

3. Inicie a aplicação:

```bash
npm start
```

4. Acesse:

```bash
http://127.0.0.1:3000
```

## Scripts úteis

```bash
npm start
npm run dev
npm run create-user
npm run verify
```

## Variáveis de ambiente

```bash
PORT=3000
SECRET_KEY=sua-chave-secreta
DATABASE_URL=postgresql://USUARIO:SENHA@HOST/DBNAME?sslmode=require
PRESENCE_WORKBOOK_PATH=planilha_presenca.xlsx
BOOTSTRAP_ADMIN=false
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=sua-senha
BOOTSTRAP_ADMIN_NAME=Administrador
```

## Presença

O sistema registra presença diretamente na planilha local `planilha_presenca.xlsx`.

Modelo de dados da presença:

- `user`: usuários do sistema (login/senha/role `admin` ou `common`)
- `planilha_presenca.xlsx`: participantes por crachá e marcações por evento (`EVENTO_1` a `EVENTO_16`)

## Deploy rápido (Render + Neon)

1. No Render, crie um Web Service apontando para este repositório.
2. Configure:
   - Build Command: `npm install`
   - Start Command: `npm start`
3. Em **Environment Variables** no Render, defina:
   - `SECRET_KEY`
   - `NODE_ENV=production`
   - `DATABASE_URL` (string de conexão do Neon)
   - `PRESENCE_WORKBOOK_PATH` (exemplo: `/var/data/planilha_presenca.xlsx`)
4. Faça deploy.

### Bootstrap do primeiro admin no Render (opcional)

Para criar o primeiro admin automaticamente no primeiro boot:

```bash
BOOTSTRAP_ADMIN=true
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=sua-senha-forte
BOOTSTRAP_ADMIN_NAME=Administrador
```

Depois de criar o admin, volte `BOOTSTRAP_ADMIN=false`.

## Estratégia atual

O projeto já está preparado para rodar com Neon/Postgres diretamente.

## Estrutura principal

- `server.js`: ponto de entrada da aplicação
- `src/app.js`: rotas, sessão, autenticação e permissões
- `src/database.js`: schema PostgreSQL e regras de persistência
- `src/pdf.js`: geração das atas em PDF
- `src/utils.js`: helpers de rota, datas, CSRF e utilidades gerais
- `scripts/create-user.js`: criação manual de usuários `admin` ou `common`
- `scripts/verify-app.js`: verificação automatizada do sistema
- `app/templates/`: templates Nunjucks
- `app/static/`: CSS, JS e imagens

## Mapa rápido (10 linhas)

- Alterar tela de Relatórios: `app/templates/reports/index.html`
- Alterar estilo de Relatórios: `app/static/css/custom_styles.css`
- Alterar lógica/permissão de Relatórios: `src/app.js`
- Alterar persistência/ordenação de metas: `src/database.js`
- Alterar base visual global (sidebar/layout): `app/static/css/admin_dashboard_style.css`
- Alterar página de serviços: `app/templates/services.html` e `app/static/css/services.css`
- Alterar base de todas as páginas (head/nav/shell): `app/templates/base.html`
- Alterar módulo de Membros: `app/templates/members/*` + `src/app.js` + `src/database.js`
- Alterar módulo de Projetos: `app/templates/projects/*` + `src/app.js` + `src/database.js`
- Alterar helpers comuns (CSRF/data/rotas utilitárias): `src/utils.js`

## Verificação

Para validar a aplicação sem mexer no banco principal:

```bash
npm run verify
```

Esse comando verifica fluxos principais da aplicação (rotas, renderizações e regras de domínio).

- renderização das páginas principais
- rotas do portal integrado
- criação e leitura de atas
- geração de PDF
- fluxo do almoxarifado com categorias, locais e retiradas

## Deploy

O projeto já possui arquivos para deploy com Docker:

- `Dockerfile`
- `render.yaml`

## Observação

Esta é a versão integrada e consolidada do sistema. O repositório não depende mais da antiga base Flask nem das pastas legadas que foram usadas durante a migração.
