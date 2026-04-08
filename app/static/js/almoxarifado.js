/*
 * ARQUIVO: almoxarifado.js
 * FUNCAO: interacoes da tela de almoxarifado (abas, filtros locais e atualizacao de URL sem recarregar pagina).
 * IMPACTO DE MUDANCAS:
 * - Alterar data-attributes exige sincronia com o template da pagina e classes CSS de estado ativo.
 * - Alterar filtro de tabela muda a visibilidade de registros para o usuario final.
 */
// SECAO: inicializacao das interacoes da tela de almoxarifado apos carregar o DOM.

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("almox-page");
  if (!root) {
    return;
  }

  const links = Array.from(root.querySelectorAll("[data-tab-link]"));
  const panels = Array.from(root.querySelectorAll("[data-tab-panel]"));

  // SECAO: controle de abas com sincronizacao visual e atualizacao de URL.
  function setActiveTab(tabName, href = null) {
    links.forEach((link) => {
      link.classList.toggle("is-active", link.dataset.tabLink === tabName);
    });

    panels.forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.tabPanel === tabName);
    });

    if (href) {
      window.history.replaceState({}, "", href);
    }
  }

  links.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      setActiveTab(link.dataset.tabLink, link.href);
    });
  });

  setActiveTab(root.dataset.activeTab || "overview");

  // SECAO: filtro textual local para tabelas sem requisicao ao servidor.
  document.querySelectorAll("[data-filter-target]").forEach((input) => {
    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      const table = document.getElementById(input.dataset.filterTarget);
      if (!table) {
        return;
      }

      const rows = table.querySelectorAll("tbody tr");
      rows.forEach((row) => {
        const text = row.textContent.toLowerCase();
        row.hidden = query ? !text.includes(query) : false;
      });
    });
  });
});
