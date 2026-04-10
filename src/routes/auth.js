function registerAuthRoutes(ctx) {
  const {
    app,
    bcrypt,
    database,
    urlFor,
    render,
    renderLogin,
    requireAuth,
    canManageProject,
    ensureValidCsrf,
    ensureCsrfToken,
    verifyCsrf,
    safeRedirectPath,
    registerPresenceInWorkbook,
    logError,
    sendApiError,
  } = ctx;

app.get("/login", (req, res) => {
    if (req.currentUser) {
      return res.redirect(urlFor("services"));
    }

    return renderLogin(res, {
      formData: {
        username: "",
        next: String(req.query.next || ""),
      },
      errors: {},
    });
  });

  // DETALHE: Rota POST /login: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/login", (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    if (req.currentUser) {
      return res.redirect(urlFor("services"));
    }

    const formData = {
      username: String(req.body.username || "").trim(),
      next: String(req.body.next || ""),
    };
    const password = String(req.body.password || "");
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const errors = {};

    if (!formData.username) {
      errors.username = ["Nome de usuário é obrigatório."];
    }

    if (!password) {
      errors.password = ["Senha é obrigatória."];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(errors).length > 0) {
      return renderLogin(res, { formData, errors });
    }

    const user = database.getUserByUsername(formData.username);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      req.flash("danger", "Usuário ou senha inválidos.");
      const nextQuery = formData.next
        ? `?next=${encodeURIComponent(formData.next)}`
        : "";
      return res.redirect(`${urlFor("login")}${nextQuery}`);
    }

    req.session.userId = user.id;
    req.flash("success", "Login realizado com sucesso!");

    const nextPath = safeRedirectPath(
      req.body.next,
      urlFor("services"),
    );
    return res.redirect(nextPath);
  });

  // DETALHE: Rota GET /logout: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/logout", requireAuth, (req, res) => {
    req.session = {
      flashes: [
        {
          category: "info",
          message: "Você saiu da sua conta.",
        },
      ],
    };
    ensureCsrfToken(req);
    return res.redirect(urlFor("login"));
  });

  // DETALHE: Rota GET /: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/", requireAuth, (req, res) => {
    return res.redirect(urlFor("services"));
  });

    // SECAO: rotas gerais de navegacao (services/home/presenca).

// DETALHE: Rota GET /services: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/services", requireAuth, (req, res) => {
    return render(res, "services.html", {
      title: "Serviços",
      activeSection: "services",
    });
  });

  // DETALHE: Rota GET /home: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/home", requireAuth, (req, res) => {
    const tab = req.query.tab || "home";
    const recentAtas = database.listRecentAtas(5).map((ata) => ({
      ...ata,
      canDelete: canManageProject(req, ata.project),
    }));

    return render(res, "home.html", {
      title: "Atas",
      activeSection: "home",
      activeAtaTab: tab,
      recentAtas,
    });
  });

  // DETALHE: Rota GET /presenca: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/presenca", requireAuth, (req, res) => {
    return render(res, "presenca/index.html", {
      title: "Controle de Presença",
      activeSection: "presenca",
    });
  });

  // DETALHE: Rota POST /presenca/registrar: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/presenca/registrar", requireAuth, (req, res) => {
    if (!verifyCsrf(req)) {
      const nextToken = ensureCsrfToken(req);
      return sendApiError(
        req,
        res,
        403,
        "CSRF token inválido ou expirado.",
        { csrfToken: nextToken },
      );
    }

    try {
      const result = registerPresenceInWorkbook(req.body.cracha, req.body.evento);
      return res.json(result);
    } catch (error) {
      logError(req, "Erro ao registrar presença:", error);
      return sendApiError(req, res, 500, "Erro interno ao registrar presença.");
    }
  });
}

module.exports = { registerAuthRoutes };
