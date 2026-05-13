/*
 * ARQUIVO: src/routes/almox.js
 * FUNCAO: registra rotas web e API interna do almoxarifado.
 * IMPACTO DE MUDANCAS:
 * - Alterar validacoes de estoque pode gerar inconsistencias de quantidade.
 * - Alterar respostas JSON impacta scripts/frontend que dependem dessas APIs.
 */
function registerAlmoxRoutes(ctx) {
  const {
    app,
    bcrypt,
    requireAuth,
    requireAdminPage,
    requireAdminApi,
    ensureValidCsrf,
    ensureValidApiCsrf,
    parseId,
    database,
    renderAlmox,
    renderUserMaintenance,
    almoxPath,
    urlFor,
    parseInventoryPayload,
    validateInventoryPayload,
    validateCatalogName,
    isUniqueConstraintError,
    canManageProject,
    canCreateAtaForProject,
    logError,
    sendApiError,
    mapInventoryApiItem,
  } = ctx;

  function userMaintenancePath(anchor = "user-access-list") {
    const suffix = anchor ? `#${anchor}` : "";
    return `${urlFor("user_maintenance")}${suffix}`;
  }

  function isValidEmail(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) {
      return false;
    }
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
  }

app.get("/almoxarifado", requireAuth, (req, res) => {
    return renderAlmox(res, {
      activeTab: req.query.tab,
    });
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/manutencao-usuarios/users/create",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userFormData = {
        name: String(req.body.name || "").trim(),
        username: String(req.body.username || "").trim(),
        email: String(req.body.email || "").trim().toLowerCase(),
        password: "",
        role: String(req.body.role || "common").trim().toLowerCase(),
        memberId: String(req.body.member_id || "").trim(),
      };
      const rawPassword = String(req.body.password || "");
      // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

      const userErrors = {};

      if (!userFormData.name) {
        userErrors.name = ["O nome completo Ã© obrigatÃ³rio."];
      } else if (userFormData.name.length < 3 || userFormData.name.length > 120) {
        userErrors.name = ["O nome deve ter entre 3 e 120 caracteres."];
      }

      if (!userFormData.username) {
        userErrors.username = ["O nome de usuÃ¡rio Ã© obrigatÃ³rio."];
      } else if (!/^[a-zA-Z0-9._-]{3,40}$/.test(userFormData.username)) {
        userErrors.username = [
          "Use de 3 a 40 caracteres com letras, nÃºmeros, ponto, traÃ§o ou sublinhado.",
        ];
      }

      if (!rawPassword) {
        userErrors.password = ["A senha Ã© obrigatÃ³ria."];
      } else if (rawPassword.length < 6) {
        userErrors.password = ["A senha deve ter pelo menos 6 caracteres."];
      }

      if (userFormData.email && !isValidEmail(userFormData.email)) {
        userErrors.email = ["Informe um e-mail vÃ¡lido."];
      }

      if (!["admin", "tutor", "common"].includes(userFormData.role)) {
        userFormData.role = "common";
      }

      const memberId = parseId(userFormData.memberId);
      if (userFormData.memberId && !memberId) {
        userErrors.memberId = ["Selecione um membro vÃ¡lido."];
      } else if (memberId) {
        const member = database.getMemberById(memberId);
        if (!member || !member.is_active) {
          userErrors.memberId = ["Selecione um membro ativo vÃ¡lido."];
        }
      }

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(userErrors).length > 0) {
        return renderUserMaintenance(res, {
          userFormData,
          userErrors,
        });
      }

      try {
        const passwordHash = bcrypt.hashSync(rawPassword, 12);
        const createdUser = database.createUser(userFormData.username, passwordHash, {
          name: userFormData.name,
          email: userFormData.email || null,
          role: userFormData.role,
          memberId: memberId || null,
        });

        req.flash(
          "success",
          `UsuÃ¡rio "${createdUser.username}" criado com sucesso como ${
            createdUser.role === "common"
              ? "comum"
              : createdUser.role === "tutor"
                ? "tutor"
                : "administrador"
          }.`,
        );
        return res.redirect(userMaintenancePath());
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          if (String(error.constraint || "").toLowerCase().includes("email")) {
            userErrors.email = ["Já existe um usuário com este e-mail."];
          } else {
            userErrors.username = ["Já existe um usuário com esse nome de acesso."];
          }
        } else {
          logError(req, "Erro ao criar usuÃ¡rio:", error);
          req.flash("danger", `Erro ao criar usuÃ¡rio: ${error.message}`);
        }

        return renderUserMaintenance(res, {
          userFormData,
          userErrors,
        });
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/manutencao-usuarios/users/link/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "UsuÃ¡rio invÃ¡lido para vinculaÃ§Ã£o.");
        return res.redirect(userMaintenancePath());
      }

      const user = database.getUserById(userId);
      if (!user) {
        req.flash("warning", "UsuÃ¡rio nÃ£o encontrado.");
        return res.redirect(userMaintenancePath());
      }

      const memberIdRaw = String(req.body.member_id || "").trim();
      const memberId = parseId(memberIdRaw);
      if (memberIdRaw && !memberId) {
        req.flash("warning", "Selecione um membro vÃ¡lido.");
        return res.redirect(userMaintenancePath());
      }

      if (memberId) {
        const member = database.getMemberById(memberId);
        if (!member || !member.is_active) {
          req.flash("warning", "Selecione um membro ativo vÃ¡lido.");
          return res.redirect(userMaintenancePath());
        }
      }

      try {
        const updatedUser = database.setUserMemberLink(userId, memberId || null);
        if (updatedUser?.member_name) {
          req.flash(
            "success",
            `UsuÃ¡rio @${updatedUser.username} vinculado ao membro ${updatedUser.member_name}.`,
          );
        } else {
          req.flash(
            "success",
            `VÃ­nculo de membro removido do usuÃ¡rio @${user.username}.`,
          );
        }
      } catch (error) {
        logError(req, "Erro ao vincular usuÃ¡rio ao membro:", error);
        req.flash("danger", `Erro ao vincular usuÃ¡rio: ${error.message}`);
      }

      return res.redirect(userMaintenancePath());
    },
  );

  app.post(
    "/manutencao-usuarios/users/reset-password/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "UsuÃ¡rio invÃ¡lido para redefiniÃ§Ã£o de senha.");
        return res.redirect(userMaintenancePath());
      }

      const user = database.getUserById(userId);
      if (!user) {
        req.flash("warning", "UsuÃ¡rio nÃ£o encontrado.");
        return res.redirect(userMaintenancePath());
      }

      const rawPassword = String(req.body.new_password || "");
      if (!rawPassword || rawPassword.length < 6) {
        req.flash("warning", "A nova senha deve ter pelo menos 6 caracteres.");
        return res.redirect(userMaintenancePath());
      }

      try {
        const passwordHash = bcrypt.hashSync(rawPassword, 12);
        database.updateUserPassword(userId, passwordHash);
        req.flash("success", `Senha de @${user.username} redefinida com sucesso.`);
      } catch (error) {
        logError(req, "Erro ao redefinir senha de usuÃ¡rio:", error);
        req.flash("danger", `Erro ao redefinir senha: ${error.message}`);
      }

      return res.redirect(userMaintenancePath());
    },
  );

  app.post(
    "/manutencao-usuarios/users/email/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "Usuário inválido para atualização de e-mail.");
        return res.redirect(userMaintenancePath());
      }

      const user = database.getUserById(userId);
      if (!user) {
        req.flash("warning", "Usuário não encontrado.");
        return res.redirect(userMaintenancePath());
      }

      const email = String(req.body.email || "").trim().toLowerCase();
      if (email && !isValidEmail(email)) {
        req.flash("warning", "Informe um e-mail válido.");
        return res.redirect(userMaintenancePath());
      }

      try {
        const updated = database.updateUserEmail(userId, email || null);
        if (!updated) {
          req.flash("warning", "Usuário não encontrado.");
          return res.redirect(userMaintenancePath());
        }
        if (updated.email) {
          req.flash("success", `E-mail de @${updated.username} atualizado com sucesso.`);
        } else {
          req.flash("success", `E-mail de @${updated.username} removido.`);
        }
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          req.flash("warning", "Este e-mail já está em uso por outro usuário.");
        } else {
          logError(req, "Erro ao atualizar e-mail do usuário:", error);
          req.flash("danger", `Erro ao atualizar e-mail: ${error.message}`);
        }
      }

      return res.redirect(userMaintenancePath());
    },
  );

  app.post(
    "/manutencao-usuarios/users/delete/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "UsuÃ¡rio invÃ¡lido para exclusÃ£o.");
        return res.redirect(userMaintenancePath());
      }

      if (req.currentUser?.id === userId) {
        req.flash("warning", "VocÃª nÃ£o pode excluir seu prÃ³prio usuÃ¡rio.");
        return res.redirect(userMaintenancePath());
      }

      try {
        const result = database.deleteUser(userId);
        if (!result?.deleted) {
          if (result?.reason === "not_found") {
            req.flash("warning", "UsuÃ¡rio nÃ£o encontrado.");
          } else if (result?.reason === "has_history") {
            req.flash(
              "warning",
              "NÃ£o Ã© possÃ­vel excluir usuÃ¡rio com histÃ³rico de retiradas ou emprÃ©stimos.",
            );
          } else {
            req.flash("warning", "NÃ£o foi possÃ­vel excluir o usuÃ¡rio.");
          }
          return res.redirect(userMaintenancePath());
        }

        req.flash("success", `UsuÃ¡rio @${result.user.username} excluÃ­do com sucesso.`);
      } catch (error) {
        logError(req, "Erro ao excluir usuÃ¡rio:", error);
        req.flash("danger", `Erro ao excluir usuÃ¡rio: ${error.message}`);
      }

      return res.redirect(userMaintenancePath());
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/inventory/create",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "manage";
      const parsed = parseInventoryPayload(req.body);
      const itemFormData = {
        name: parsed.name,
        itemType: parsed.itemType,
        categoryId: parsed.categoryId || "",
        categoryName: parsed.category || "",
        locationId: parsed.locationId || "",
        locationName: parsed.location || "",
        quantity: parsed.quantity,
        description: parsed.description,
      };
      const { errors: itemErrors, normalized } = validateInventoryPayload(parsed);

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(itemErrors).length > 0) {
        return renderAlmox(res, {
          activeTab,
          itemFormData,
          itemErrors,
        });
      }

      try {
        const createdItem = database.createInventoryItem({
          name: normalized.name,
          itemType: normalized.itemType,
          category: normalized.category,
          categoryId: normalized.categoryId,
          location: normalized.location,
          locationId: normalized.locationId,
          quantity: normalized.quantity,
          description: normalized.description,
        });

        req.flash(
          "success",
          `Material "${createdItem.name}" (${createdItem.item_type === "patrimony" ? "patrimÃ´nio" : "estoque"}) adicionado com sucesso.`,
        );
        return res.redirect(almoxPath(activeTab));
      } catch (error) {
        logError(req, "Erro ao adicionar item ao estoque:", error);
        req.flash("danger", `Erro ao adicionar item: ${error.message}`);
        return renderAlmox(res, {
          activeTab,
          itemFormData,
          itemErrors,
        });
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/categories/create",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "manage";
      const { normalized, errors } = validateCatalogName(
        req.body.name,
        "nome da categoria",
      );

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return renderAlmox(res, {
          activeTab,
          categoryFormData: { name: normalized },
          categoryErrors: errors,
        });
      }

      try {
        const category = database.createInventoryCategory(normalized);
        req.flash("success", `Categoria "${category.name}" criada com sucesso.`);
        return res.redirect(almoxPath(activeTab));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          errors.name = ["JÃ¡ existe uma categoria com esse nome."];
        } else {
          logError(req, "Erro ao criar categoria:", error);
          req.flash("danger", `Erro ao criar categoria: ${error.message}`);
        }

        return renderAlmox(res, {
          activeTab,
          categoryFormData: { name: normalized },
          categoryErrors: errors,
        });
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/categories/delete/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const categoryId = parseId(req.params.id);
      if (!categoryId) {
        req.flash("warning", "Categoria invÃ¡lida.");
        return res.redirect(almoxPath("manage"));
      }

      try {
        const deleted = database.deleteInventoryCategory(categoryId);
        if (!deleted) {
          req.flash("warning", "Categoria nÃ£o encontrada.");
        } else {
          req.flash("success", `Categoria "${deleted.name}" removida com sucesso.`);
        }
      } catch (error) {
        logError(req, "Erro ao remover categoria:", error);
        req.flash("danger", `Erro ao remover categoria: ${error.message}`);
      }

      return res.redirect(almoxPath("manage"));
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/locations/create",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "manage";
      const { normalized, errors } = validateCatalogName(
        req.body.name,
        "nome do local",
      );

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return renderAlmox(res, {
          activeTab,
          locationFormData: { name: normalized },
          locationErrors: errors,
        });
      }

      try {
        const location = database.createInventoryLocation(normalized);
        req.flash("success", `Local "${location.name}" criado com sucesso.`);
        return res.redirect(almoxPath(activeTab));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          errors.name = ["JÃ¡ existe um local com esse nome."];
        } else {
          logError(req, "Erro ao criar local:", error);
          req.flash("danger", `Erro ao criar local: ${error.message}`);
        }

        return renderAlmox(res, {
          activeTab,
          locationFormData: { name: normalized },
          locationErrors: errors,
        });
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/locations/delete/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const locationId = parseId(req.params.id);
      if (!locationId) {
        req.flash("warning", "Local invÃ¡lido.");
        return res.redirect(almoxPath("manage"));
      }

      try {
        const deleted = database.deleteInventoryLocation(locationId);
        if (!deleted) {
          req.flash("warning", "Local nÃ£o encontrado.");
        } else {
          req.flash("success", `Local "${deleted.name}" removido com sucesso.`);
        }
      } catch (error) {
        logError(req, "Erro ao remover local:", error);
        req.flash("danger", `Erro ao remover local: ${error.message}`);
      }

      return res.redirect(almoxPath("manage"));
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/inventory/delete/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const itemId = parseId(req.params.id);
      if (!itemId) {
        req.flash("warning", "Produto invÃ¡lido para exclusÃ£o.");
        return res.redirect(almoxPath(req.body.tab || "stock"));
      }

      try {
        const deletedItem = database.deleteInventoryItem(itemId);

        if (!deletedItem) {
          req.flash("warning", "Produto nÃ£o encontrado.");
        } else {
          req.flash(
            "success",
            `Produto "${deletedItem.name}" removido do almoxarifado com sucesso.`,
          );
        }
      } catch (error) {
        logError(req, "Erro ao excluir item do estoque:", error);
        req.flash("danger", `Erro ao excluir item: ${error.message}`);
      }

      return res.redirect(almoxPath(req.body.tab || "stock"));
    },
  );

  // DETALHE: Rota POST /almoxarifado/inventory/withdraw: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/almoxarifado/inventory/withdraw", requireAuth, (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const activeTab = "withdraw";
    const withdrawFormData = {
      nameOrCode: String(req.body.name_or_code || "").trim(),
      quantity: String(req.body.quantity || "").trim(),
    };
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const withdrawErrors = {};
    const quantity = Number(withdrawFormData.quantity);

    if (!withdrawFormData.nameOrCode) {
      withdrawErrors.nameOrCode = ["Informe o nome exato ou o ID do produto."];
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      withdrawErrors.quantity = ["Informe uma quantidade inteira maior que zero."];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(withdrawErrors).length > 0) {
      return renderAlmox(res, {
        activeTab,
        withdrawFormData,
        withdrawErrors,
      });
    }

    const result = database.withdrawInventoryItem({
      nameOrCode: withdrawFormData.nameOrCode,
      quantity,
      userId: req.currentUser.id,
    });

    if (!result.success) {
      return renderAlmox(res, {
        activeTab,
        withdrawFormData,
        withdrawErrors: {
          form: [result.message],
        },
      });
    }

    req.flash("success", result.message);
    return res.redirect(almoxPath("withdraw"));
  });

  // DETALHE: Rota POST /almoxarifado/inventory/borrow: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/almoxarifado/inventory/borrow", requireAuth, (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const activeTab = "borrow";
    const loanFormData = {
      nameOrCode: String(req.body.name_or_code || "").trim(),
      quantity: String(req.body.quantity || "").trim(),
    };
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const loanErrors = {};
    const quantity = Number(loanFormData.quantity);

    if (!loanFormData.nameOrCode) {
      loanErrors.nameOrCode = ["Informe o nome exato ou o ID do patrimÃ´nio."];
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      loanErrors.quantity = ["Informe uma quantidade inteira maior que zero."];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(loanErrors).length > 0) {
      return renderAlmox(res, {
        activeTab,
        loanFormData,
        loanErrors,
      });
    }

    const result = database.borrowInventoryItem({
      nameOrCode: loanFormData.nameOrCode,
      quantity,
      userId: req.currentUser.id,
    });

    if (!result.success) {
      return renderAlmox(res, {
        activeTab,
        loanFormData,
        loanErrors: {
          form: [result.message],
        },
      });
    }

    req.flash("success", result.message);
    return res.redirect(almoxPath("borrowed"));
  });

  // DETALHE: Rota POST /almoxarifado/loans/return/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/almoxarifado/loans/return/:id", requireAuth, (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const loanId = parseId(req.params.id);
    if (!loanId) {
      req.flash("warning", "EmprÃ©stimo invÃ¡lido.");
      return res.redirect(almoxPath("borrowed"));
    }

    const loan = database.getInventoryLoanById(loanId);
    if (!loan) {
      req.flash("warning", "EmprÃ©stimo nÃ£o encontrado.");
      return res.redirect(almoxPath("borrowed"));
    }

    if (!req.currentUser.is_admin && loan.user_id !== req.currentUser.id) {
      req.flash(
        "warning",
        "VocÃª sÃ³ pode registrar a devoluÃ§Ã£o dos emprÃ©stimos feitos no seu usuÃ¡rio.",
      );
      return res.redirect(almoxPath("borrowed"));
    }

    const result = database.returnInventoryLoan({
      loanId,
      actorUserId: req.currentUser.id,
    });

    if (!result.success) {
      req.flash("warning", result.message);
      return res.redirect(almoxPath("borrowed"));
    }

    req.flash("success", result.message);
    return res.redirect(almoxPath("borrowed"));
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/loans/extend/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const loanId = parseId(req.params.id);
      const extraDays = Number(req.body.extra_days);

      if (!loanId) {
        req.flash("warning", "EmprÃ©stimo invÃ¡lido.");
        return res.redirect(almoxPath("borrowed"));
      }

      if (!Number.isInteger(extraDays) || extraDays <= 0 || extraDays > 90) {
        req.flash(
          "warning",
          "Informe uma prorrogaÃ§Ã£o vÃ¡lida entre 1 e 90 dias.",
        );
        return res.redirect(almoxPath("borrowed"));
      }

      const result = database.extendInventoryLoan({
        loanId,
        extraDays,
        actorUserId: req.currentUser.id,
      });

      if (!result.success) {
        req.flash("warning", result.message);
        return res.redirect(almoxPath("borrowed"));
      }

      req.flash("success", result.message);
      return res.redirect(almoxPath("borrowed"));
    },
  );

  // DETALHE: Rota GET /almoxarifado/api/itens: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/almoxarifado/api/itens", requireAuth, (req, res) => {
    return res.json(database.listInventoryItems().map(mapInventoryApiItem));
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/api/itens",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const parsed = parseInventoryPayload(req.body);
      const { errors, normalized } = validateInventoryPayload(parsed);
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados invÃ¡lidos.", errors);
      }

      try {
        const item = database.createInventoryItem({
          name: normalized.name,
          itemType: normalized.itemType,
          category: normalized.category,
          categoryId: normalized.categoryId,
          location: normalized.location,
          locationId: normalized.locationId,
          quantity: normalized.quantity,
          description: normalized.description,
        });
        return res.status(201).json(item);
      } catch (error) {
        logError(req, "Erro ao criar item via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.put(
    "/almoxarifado/api/itens/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const itemId = parseId(req.params.id);
      if (!itemId) {
        return sendApiError(req, res, 400, "Item invÃ¡lido.");
      }

      const parsed = parseInventoryPayload(req.body);
      const { errors, normalized } = validateInventoryPayload(parsed);
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados invÃ¡lidos.", errors);
      }

      try {
        const updated = database.updateInventoryItem(itemId, {
          name: normalized.name,
          itemType: normalized.itemType,
          category: normalized.category,
          categoryId: normalized.categoryId,
          location: normalized.location,
          locationId: normalized.locationId,
          quantity: normalized.quantity,
          description: normalized.description,
        });

        if (!updated) {
          return sendApiError(req, res, 404, "Item nÃ£o encontrado.");
        }

        return res.json(updated);
      } catch (error) {
        logError(req, "Erro ao atualizar item via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.delete(
    "/almoxarifado/api/itens/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const itemId = parseId(req.params.id);
      if (!itemId) {
        return sendApiError(req, res, 400, "Item invÃ¡lido.");
      }

      try {
        const deleted = database.deleteInventoryItem(itemId);
        if (!deleted) {
          return sendApiError(req, res, 404, "Item nÃ£o encontrado.");
        }

        return res.json({
          mensagem: "Item removido com sucesso.",
          item: deleted,
        });
      } catch (error) {
        logError(req, "Erro ao remover item via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Rota GET /almoxarifado/api/categorias: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/almoxarifado/api/categorias", requireAuth, (req, res) => {
    return res.json(
      database.listInventoryCategories().map((category) => ({
        id: category.id,
        nome: category.name,
      })),
    );
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/api/categorias",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome da categoria",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados invÃ¡lidos.", errors);
      }

      try {
        const category = database.createInventoryCategory(normalized);
        return res.status(201).json({ id: category.id, nome: category.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendApiError(req, res, 400, "Categoria jÃ¡ cadastrada.");
        }
        logError(req, "Erro ao criar categoria via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.put(
    "/almoxarifado/api/categorias/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const categoryId = parseId(req.params.id);
      if (!categoryId) {
        return sendApiError(req, res, 400, "Categoria invÃ¡lida.");
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome da categoria",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados invÃ¡lidos.", errors);
      }

      try {
        const category = database.updateInventoryCategory(categoryId, normalized);
        if (!category) {
          return sendApiError(req, res, 404, "Categoria nÃ£o encontrada.");
        }

        return res.json({ id: category.id, nome: category.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendApiError(req, res, 400, "Categoria jÃ¡ cadastrada.");
        }
        logError(req, "Erro ao atualizar categoria via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.delete(
    "/almoxarifado/api/categorias/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const categoryId = parseId(req.params.id);
      if (!categoryId) {
        return sendApiError(req, res, 400, "Categoria invÃ¡lida.");
      }

      try {
        const deleted = database.deleteInventoryCategory(categoryId);
        if (!deleted) {
          return sendApiError(req, res, 404, "Categoria nÃ£o encontrada.");
        }

        return res.json({
          mensagem: "Categoria removida com sucesso.",
          categoria: { id: deleted.id, nome: deleted.name },
        });
      } catch (error) {
        logError(req, "Erro ao remover categoria via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Rota GET /almoxarifado/api/locais: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/almoxarifado/api/locais", requireAuth, (req, res) => {
    return res.json(
      database.listInventoryLocations().map((location) => ({
        id: location.id,
        nome: location.name,
      })),
    );
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/api/locais",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome do local",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados invÃ¡lidos.", errors);
      }

      try {
        const location = database.createInventoryLocation(normalized);
        return res.status(201).json({ id: location.id, nome: location.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendApiError(req, res, 400, "Local jÃ¡ cadastrado.");
        }
        logError(req, "Erro ao criar local via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.put(
    "/almoxarifado/api/locais/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const locationId = parseId(req.params.id);
      if (!locationId) {
        return sendApiError(req, res, 400, "Local invÃ¡lido.");
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome do local",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return sendApiError(req, res, 400, "Dados invÃ¡lidos.", errors);
      }

      try {
        const location = database.updateInventoryLocation(locationId, normalized);
        if (!location) {
          return sendApiError(req, res, 404, "Local nÃ£o encontrado.");
        }

        return res.json({ id: location.id, nome: location.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return sendApiError(req, res, 400, "Local jÃ¡ cadastrado.");
        }
        logError(req, "Erro ao atualizar local via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.delete(
    "/almoxarifado/api/locais/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      // DETALHE: Garante integridade de chamadas API protegidas por CSRF.

      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const locationId = parseId(req.params.id);
      if (!locationId) {
        return sendApiError(req, res, 400, "Local invÃ¡lido.");
      }

      try {
        const deleted = database.deleteInventoryLocation(locationId);
        if (!deleted) {
          return sendApiError(req, res, 404, "Local nÃ£o encontrado.");
        }

        return res.json({
          mensagem: "Local removido com sucesso.",
          local: { id: deleted.id, nome: deleted.name },
        });
      } catch (error) {
        logError(req, "Erro ao remover local via API:", error);
        return sendApiError(req, res, 500, error.message);
      }
    },
  );

    // SECAO: endpoints auxiliares para preencher formularios dinamicos no frontend.

// DETALHE: Rota GET /api/project/:project_id/members: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/api/project/:project_id/members", requireAuth, (req, res) => {
    const projectId = parseId(req.params.project_id);
    const project = projectId ? database.getProjectById(projectId) : null;

    if (!project) {
      return sendApiError(req, res, 404, "Projeto nÃ£o encontrado.");
    }

    if (!canCreateAtaForProject(req, project) && !canManageProject(req, project)) {
      return sendApiError(req, res, 403, "VocÃª nÃ£o tem acesso aos membros deste projeto.");
    }

    return res.json({
      members: project.active_members.map((member) => ({
        id: member.id,
        name: member.name,
      })),
    });
  });
}

module.exports = { registerAlmoxRoutes };

