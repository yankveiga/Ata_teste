/*
 * ARQUIVO: src/services/reportService.js
 * FUNCAO: regras de negocio puras para relatorios.
 * IMPACTO DE MUDANCAS:
 * - Alterar verificacao de permissao mensal impacta seguranca de acesso aos PDFs.
 */
function canGenerateMonthlyReport(req, currentMember, targetMember) {
  return Boolean(
    req.currentUser?.is_admin
    || (currentMember?.is_active && currentMember.id === targetMember?.id),
  );
}

function buildMonthlyPdfFilename(memberName, monthKey) {
  const safeMemberName = String(memberName || "membro")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return `Relatorio_Mensal_${safeMemberName || "membro"}_${monthKey}.pdf`;
}

module.exports = {
  canGenerateMonthlyReport,
  buildMonthlyPdfFilename,
};
