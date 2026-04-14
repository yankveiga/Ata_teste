# Guia de Arquitetura - Portal PET C3

Objetivo: explicar como o sistema está dividido, para evoluir sem quebrar fluxo.

## 1) Visão geral

Camadas:
1. Entrada HTTP (`server.js` + `src/app.js`)
2. Rotas por domínio (`src/routes/*`)
3. Regras de negócio (`src/services/*`)
4. Validações (`src/validators/*`)
5. Persistência SQL (`src/database.js`)
6. Renderização (`app/templates/*` + `app/static/css/*`)

## 2) Fluxo de request (resumo)

1. Request entra em `server.js` -> app Express
2. `src/app.js` aplica sessão, auth, CSRF e contexto
3. Rota do domínio processa entrada
4. (Opcional) serviço aplica regra
5. `src/database.js` lê/escreve no banco
6. resposta retorna como HTML (Nunjucks) ou JSON

## 3) Módulos de rota

- `auth.js`: login/logout, serviços iniciais, presença
- `atas.js`: criação/download/exclusão de atas
- `reports.js`: metas semanais, scrum, PDF mensal
- `members.js`: CRUD de membros
- `projects.js`: CRUD de projetos e coordenação
- `almox.js`: almoxarifado + APIs internas

## 4) Permissões

Perfis base:
- `admin`: gestão completa
- `common`: operação com restrições

Permissão contextual:
- coordenador atua apenas nos projetos que coordena

Ponto central:
- helpers de autorização em `src/app.js`

## 5) Fronteiras importantes

- **Schema/queries**: só em `src/database.js`
- **Regras reutilizáveis**: `src/services/*`
- **Validação de payload/form**: `src/validators/*`
- **Padrão de erro/log API**: `src/http.js`

## 6) Frontend

- shell/layout global: `base.html` + `admin_dashboard_style.css`
- componentes compartilhados e UX/A11y: `custom_styles.css`
- telas por domínio: `app/templates/<modulo>/*`

## 7) Princípios de evolução

1. Mudou regra -> ajustar rota + serviço + teste manual
2. Mudou dado -> ajustar `database.js` e documentação
3. Mudou interface -> template + CSS + acessibilidade
4. Sempre atualizar docs afetados (`MAPA`, `RUNBOOK`, README)
