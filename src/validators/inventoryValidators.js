function validateInventoryPayload(payload, validTypes = new Set(["stock", "patrimony"])) {
  const errors = {};
  const quantity = Number(payload.quantity);

  if (!payload.name) {
    errors.name = ["O nome do item é obrigatório."];
  } else if (payload.name.length < 2 || payload.name.length > 120) {
    errors.name = ["O nome deve ter entre 2 e 120 caracteres."];
  }

  if (!validTypes.has(payload.itemType)) {
    errors.itemType = ["Selecione um tipo válido para o material."];
  }

  if (!payload.categoryId && !payload.category) {
    errors.category = ["Selecione uma categoria ou informe uma nova categoria."];
  }

  if (!payload.locationId && !payload.location) {
    errors.location = ["Selecione um local ou informe um novo local."];
  }

  if (!Number.isInteger(quantity) || quantity < 0) {
    errors.quantity = ["Informe uma quantidade inteira igual ou maior que zero."];
  }

  if (!payload.description) {
    errors.description = ["A descrição é obrigatória."];
  } else if (payload.description.length < 4 || payload.description.length > 240) {
    errors.description = ["A descrição deve ter entre 4 e 240 caracteres."];
  }

  return {
    errors,
    normalized: {
      ...payload,
      quantity,
    },
  };
}

function validateCatalogName(name, entityLabel = "nome") {
  const normalized = String(name || "").trim();
  const errors = {};

  if (!normalized) {
    errors.name = [`O ${entityLabel} é obrigatório.`];
  } else if (normalized.length < 2 || normalized.length > 80) {
    errors.name = [`O ${entityLabel} deve ter entre 2 e 80 caracteres.`];
  }

  return {
    normalized,
    errors,
  };
}

module.exports = {
  validateInventoryPayload,
  validateCatalogName,
};
