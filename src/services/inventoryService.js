function mapInventoryApiItem(item) {
  return {
    id: item.id,
    nome: item.name,
    tipo: item.item_type,
    descricao: item.description,
    categoria: item.category,
    categoria_id: item.category_id,
    local: item.location,
    local_id: item.location_id,
    quantidade: item.amount,
  };
}

module.exports = {
  mapInventoryApiItem,
};
