/*
 * ARQUIVO: admin_dashboard_script.js
 * FUNCAO: comportamento da navegacao lateral (item ativo por hover e toggle responsivo do menu).
 * IMPACTO DE MUDANCAS:
 * - Alterar seletores/classes exige manter consistencia com HTML e CSS da estrutura de layout.
 * - Alterar a logica de toggle pode quebrar usabilidade em telas menores.
 */
// add hovered class to selected list item
// SECAO: seletores da navegacao lateral e estados interativos de hover.

let list = document.querySelectorAll(".navigation li");

// SECAO: realce visual do item atualmente percorrido na sidebar.

function activeLink() {
  list.forEach((item) => {
    item.classList.remove("hovered");
  });
  this.classList.add("hovered");
}

list.forEach((item) => item.addEventListener("mouseover", activeLink));

// Menu Toggle
// SECAO: toggle responsivo da barra lateral (expande/recolhe layout principal).

let toggle = document.querySelector(".toggle");
let navigation = document.querySelector(".navigation");
let main = document.querySelector(".main");

toggle.onclick = function () {
  navigation.classList.toggle("active");
  main.classList.toggle("active");
};
