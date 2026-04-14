# Documentação Técnica Completa (Guia de Manutenção)

Este arquivo é o **guia de manutenção do código**.
Ele evita dúvidas de "onde colocar" cada mudança no dia a dia.

## 1) Regra de ouro

Sempre separar por responsabilidade:
- rota HTTP -> `src/routes/*`
- regra de negócio -> `src/services/*`
- validação -> `src/validators/*`
- persistência SQL -> `src/database.js`
- interface -> `app/templates/*` + `app/static/css/*`

## 2) Onde adicionar cada tipo de mudança

### Nova rota
- criar/editar no módulo certo em `src/routes/*`
- registrar no `src/app.js` (se necessário)

### Nova regra de negócio
- criar função em `src/services/*`
- chamar na rota

### Nova validação
- colocar em `src/validators/*`
- usar antes de persistir

### Nova tabela/campo/query
- alterar `src/database.js` (`ensureSchema` + funções CRUD/consulta)
- atualizar `MODELAGEM_BANCO.md`

### Novo bloco de tela
- editar template do módulo em `app/templates/*`
- estilizar no CSS correspondente
- incluir acessibilidade mínima (`label`, `aria-*`, foco)

### Novo PDF
- implementar em `src/pdf.js`
- chamar pela rota do módulo

## 3) Convenções de manutenção

- não duplicar regra de autorização em vários pontos
- evitar query SQL fora de `src/database.js`
- manter mensagens de erro consistentes
- para botões só com ícone, usar `aria-label`
- para feedback dinâmico, usar `aria-live`

## 4) Fluxo seguro para alteração

1. localizar arquivos pelo `MAPA_PROJETO.txt`
2. alterar backend + frontend do mesmo fluxo
3. validar cenário feliz e cenário de erro
4. atualizar docs impactadas

## 5) Checklist antes de subir

- fluxo principal do módulo funcionando
- permissões corretas (admin/common/coordenador)
- sem regressão visual grave
- sem erro 500 no log
- docs atualizadas se mudou arquitetura/operacao

## 6) Documentos complementares

- `README.md`: entrada rápida do projeto
- `MAPA_PROJETO.txt`: atalho de onde editar
- `GUIA_ARQUITETURA.md`: desenho técnico por camadas
- `RUNBOOK_PRODUCAO.md`: operação em produção
- `MODELAGEM_BANCO.md`: schema e relacionamentos
