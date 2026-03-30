# Portal PET C3

Aplicação web em **Node.js + Express + Nunjucks** que unifica dois serviços no mesmo sistema:

- **Gestor de Atas**
- **Almoxarifado / Patrimônio**

O projeto usa **login único**, **sessão compartilhada** e **SQLite** como banco local.

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
- **Banco:** SQLite
- **Auth:** cookie-session + bcryptjs
- **PDF:** PDFKit

## Banco de dados

Por padrão, o banco fica em:

```bash
instance/ata.sqlite3
```

Ele é criado e atualizado automaticamente pela aplicação.

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
DATABASE_PATH=instance/ata.sqlite3
```

## Estrutura principal

- `server.js`: ponto de entrada da aplicação
- `src/app.js`: rotas, sessão, autenticação e permissões
- `src/database.js`: schema SQLite e regras de persistência
- `src/pdf.js`: geração das atas em PDF
- `src/utils.js`: helpers de rota, datas, CSRF e utilidades gerais
- `scripts/create-user.js`: criação manual de usuários `admin` ou `common`
- `scripts/verify-app.js`: verificação automatizada do sistema
- `app/templates/`: templates Nunjucks
- `app/static/`: CSS, JS e imagens

## Verificação

Para validar a aplicação sem mexer no banco principal:

```bash
npm run verify
```

Esse comando usa uma cópia temporária do SQLite e verifica, entre outras coisas:

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
