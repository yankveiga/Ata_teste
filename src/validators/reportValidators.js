/*
 * ARQUIVO: src/validators/reportValidators.js
 * FUNCAO: validacoes de entrada para metas quinzenais do modulo de relatorios.
 * IMPACTO DE MUDANCAS:
 * - Alterar limites de texto impacta criacao/edicao em formularios existentes.
 */
function validateWeekGoalForm(formData = {}) {
  const errors = {};
  const activity = String(formData.activity || "").trim();
  const description = String(formData.description || "").trim();
  const dueAt = String(formData.dueAt || "").trim();

  if (!activity) {
    errors.activity = ["Informe a atividade da meta quinzenal."];
  } else if (activity.length < 3 || activity.length > 180) {
    errors.activity = ["A atividade deve ter entre 3 e 180 caracteres."];
  }

  if (!description) {
    errors.description = ["Informe a descrição da tarefa."];
  } else if (description.length > 2000) {
    errors.description = ["A descrição pode ter no máximo 2000 caracteres."];
  }

  if (!dueAt) {
    errors.dueAt = ["Informe a data de entrega da tarefa."];
  }

  return {
    errors,
    normalized: {
      ...formData,
      activity,
      description,
      dueAt,
    },
  };
}

module.exports = {
  validateWeekGoalForm,
};
