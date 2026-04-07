const fs = require("node:fs");
const path = require("node:path");

const bcrypt = require("bcryptjs");
const cookieSession = require("cookie-session");
const express = require("express");
const multer = require("multer");
const nunjucks = require("nunjucks");
const XLSX = require("xlsx");

const { config } = require("./config");
const database = require("./database");
const { generateAtaPdf } = require("./pdf");
const {
  addFlash,
  consumeFlashes,
  defaultMeetingDateTimeInput,
  ensureCsrfToken,
  formatDatePt,
  formatDateTimePt,
  isAllowedImage,
  isUniqueConstraintError,
  parseId,
  parseIdArray,
  safeRedirectPath,
  safeUnlink,
  sanitizeFilename,
  toDateTimeLocalValue,
  toSqlDateTime,
  trimToNull,
  urlFor,
  verifyCsrf,
} = require("./utils");

const ALMOX_TABS = new Set([
  "overview",
  "users",
  "stock",
  "manage",
  "withdraw",
  "borrow",
  "borrowed",
  "requests",
]);
const INVENTORY_ITEM_TYPES = new Set(["stock", "patrimony"]);

function normalizeAlmoxTab(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ALMOX_TABS.has(normalized) ? normalized : "overview";
}

function normalizeInventoryItemType(value) {
  return INVENTORY_ITEM_TYPES.has(value) ? value : "stock";
}

function createApp() {
  fs.mkdirSync(config.uploadDir, { recursive: true });

  const app = express();
  app.set("trust proxy", 1);
  app.set("view engine", "html");

  const env = nunjucks.configure(config.viewsDir, {
    autoescape: true,
    express: app,
    noCache: config.nodeEnv !== "production",
  });

  env.addGlobal("urlFor", urlFor);
  env.addGlobal("url_for", urlFor);
  env.addFilter("formatDateTime", formatDateTimePt);
  env.addFilter("formatDate", formatDatePt);
  env.addFilter("dateTimeLocal", toDateTimeLocalValue);

  app.use(
    cookieSession({
      name: "ata_session",
      keys: [config.sessionSecret],
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    }),
  );

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/static", express.static(config.staticDir));

  app.use((req, res, next) => {
    ensureCsrfToken(req);
    req.flash = (category, message) => addFlash(req, category, message);
    req.currentUser = req.session?.userId
      ? database.getUserById(req.session.userId)
      : null;

    res.locals.currentUser = req.currentUser;
    res.locals.isAdmin = Boolean(req.currentUser?.is_admin);
    res.locals.flashMessages = consumeFlashes(req);
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.title = "";
    res.locals.activeSection = "";
    next();
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, callback) => {
        callback(null, sanitizeFilename(file.originalname));
      },
    }),
    fileFilter: (req, file, callback) => {
      if (!isAllowedImage(file.originalname)) {
        callback(
          new Error(
            "Apenas imagens (jpg, png, jpeg, gif) são permitidas!",
          ),
        );
        return;
      }

      callback(null, true);
    },
  });

  function runLogoUpload(req, res, next) {
    upload.single("logo")(req, res, (error) => {
      if (error) {
        req.uploadError = error.message;
      }
      next();
    });
  }

  function almoxPath(tab = "overview") {
    return `${urlFor("almox_home")}?tab=${normalizeAlmoxTab(tab)}`;
  }

  function adminDeniedRedirect(req) {
    if (req.path.startsWith("/almoxarifado")) {
      return almoxPath(req.body?.tab || req.query?.tab);
    }

    if (req.path.startsWith("/members")) {
      return urlFor("list_members");
    }

    if (req.path.startsWith("/projects")) {
      return urlFor("list_projects");
    }

    return urlFor("services");
  }

  function requireAuth(req, res, next) {
    if (req.currentUser) {
      return next();
    }

    req.flash("info", "Por favor, faça login para acessar esta página.");
    const nextPath = encodeURIComponent(req.originalUrl || urlFor("services"));
    return res.redirect(`${urlFor("login")}?next=${nextPath}`);
  }

  function requireAdminPage(req, res, next) {
    if (req.currentUser?.is_admin) {
      return next();
    }

    req.flash(
      "warning",
      "Seu perfil não tem permissão para executar esta ação administrativa.",
    );
    return res.redirect(adminDeniedRedirect(req));
  }

  function requireAdminApi(req, res, next) {
    if (req.currentUser?.is_admin) {
      return next();
    }

    return res.status(403).json({
      error: "Seu perfil não tem permissão para executar esta ação administrativa.",
    });
  }

  function ensureValidCsrf(req, res) {
    if (verifyCsrf(req)) {
      return true;
    }

    req.flash("danger", "A sessão do formulário expirou. Tente novamente.");
    res.redirect(req.get("referer") || urlFor("services"));
    return false;
  }

  function ensureValidApiCsrf(req, res) {
    if (verifyCsrf(req)) {
      return true;
    }

    res.status(403).json({
      error: "CSRF token inválido ou expirado.",
    });
    return false;
  }

  function render(res, template, data = {}) {
    res.render(template, {
      title: data.title || "",
      activeSection: data.activeSection || "",
      ...data,
    });
  }

  function notFound(res) {
    return res.status(404).render("errors/404.html", {
      title: "Página Não Encontrada",
      activeSection: "",
    });
  }

  function renderLogin(res, { formData = {}, errors = {} } = {}) {
    return render(res, "login.html", {
      title: "Entrar",
      formData,
      errors,
      next: formData.next || "",
    });
  }

  function renderMemberForm(res, data) {
    return render(res, "members/form.html", {
      title: data.title,
      activeSection: "members",
      formData: data.formData,
      errors: data.errors || {},
      actionLabel: data.actionLabel,
      member: data.member || null,
    });
  }

  function renderProjectForm(res, data) {
    return render(res, "projects/form.html", {
      title: data.title,
      activeSection: "projects",
      formData: data.formData,
      errors: data.errors || {},
      actionLabel: data.actionLabel,
      activeMembers: database.listActiveMembers(),
      project: data.project || null,
    });
  }

  function renderAtaForm(res, data) {
    const selectedProjectId = parseId(data.formData.projectId);
    const selectedProject = selectedProjectId
      ? database.getProjectById(selectedProjectId)
      : null;
    const selectedProjectMembers = selectedProject
      ? selectedProject.active_members
      : [];
    const normalizedFormData = {
      ...data.formData,
      projectId: selectedProjectId || "",
    };

    return render(res, "atas/create_form.html", {
      title: data.title || "Criar Nova Ata",
      activeSection: "atas",
      formData: normalizedFormData,
      errors: data.errors || {},
      projects: database.listProjectsBasic(),
      selectedProject,
      selectedProjectMembers,
    });
  }

  function renderAlmox(res, data = {}) {
    const activeTab = normalizeAlmoxTab(data.activeTab);

    return render(res, "almoxarifado/index.html", {
      title: "Almoxarifado",
      activeSection: "almox",
      activeTab,
      dashboard: database.getInventoryDashboardData(),
      users: database.listUsers(),
      inventoryItems: database.listInventoryItems(),
      stockItems: database.listInventoryItems({ type: "stock" }),
      patrimonyItems: database.listInventoryItems({ type: "patrimony" }),
      categories: database.listInventoryCategories(),
      locations: database.listInventoryLocations(),
      requests: database.listInventoryRequests(),
      activeLoans: database.listInventoryLoans({ status: "active" }),
      returnedLoans: database.listInventoryLoans({ status: "returned", limit: 12 }),
      overdueLoans: database.listInventoryLoans({ status: "overdue" }),
      userFormData: {
        name: "",
        username: "",
        password: "",
        role: "common",
        ...(data.userFormData || {}),
      },
      userErrors: data.userErrors || {},
      itemFormData: {
        name: "",
        itemType: "stock",
        categoryId: "",
        categoryName: "",
        locationId: "",
        locationName: "",
        quantity: "",
        description: "",
        ...(data.itemFormData || {}),
      },
      itemErrors: data.itemErrors || {},
      categoryFormData: {
        name: "",
        ...(data.categoryFormData || {}),
      },
      categoryErrors: data.categoryErrors || {},
      locationFormData: {
        name: "",
        ...(data.locationFormData || {}),
      },
      locationErrors: data.locationErrors || {},
      withdrawFormData: {
        nameOrCode: "",
        quantity: "",
        ...(data.withdrawFormData || {}),
      },
      withdrawErrors: data.withdrawErrors || {},
      loanFormData: {
        nameOrCode: "",
        quantity: "1",
        ...(data.loanFormData || {}),
      },
      loanErrors: data.loanErrors || {},
      loanExtendDefaults: {
        extraDays: "7",
      },
    });
  }

  function parseInventoryPayload(source = {}) {
    const quantityValue =
      source.quantity ??
      source.quantidade ??
      source.amount ??
      "";

    return {
      name: String(source.name || source.nome || "").trim(),
      itemType: normalizeInventoryItemType(
        String(source.item_type || source.itemType || source.tipo || "stock")
          .trim()
          .toLowerCase(),
      ),
      categoryId: parseId(source.category_id || source.categoryId || source.categoria_id),
      category: trimToNull(
        source.category_name || source.category || source.categoria_nome || source.categoria,
      ),
      locationId: parseId(source.location_id || source.locationId || source.local_id),
      location: trimToNull(
        source.location_name || source.location || source.local_nome || source.local,
      ),
      quantity: String(quantityValue).trim(),
      description: String(source.description || source.descricao || "").trim(),
    };
  }

  function validateInventoryPayload(payload) {
    const errors = {};
    const quantity = Number(payload.quantity);

    if (!payload.name) {
      errors.name = ["O nome do item é obrigatório."];
    } else if (payload.name.length < 2 || payload.name.length > 120) {
      errors.name = ["O nome deve ter entre 2 e 120 caracteres."];
    }

    if (!INVENTORY_ITEM_TYPES.has(payload.itemType)) {
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

  app.post("/login", (req, res) => {
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
    const errors = {};

    if (!formData.username) {
      errors.username = ["Nome de usuário é obrigatório."];
    }

    if (!password) {
      errors.password = ["Senha é obrigatória."];
    }

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

  app.get("/", requireAuth, (req, res) => {
    return res.redirect(urlFor("services"));
  });

  app.get("/services", requireAuth, (req, res) => {
    return render(res, "services.html", {
      title: "Serviços",
      activeSection: "services",
    });
  });

  app.get("/home", requireAuth, (req, res) => {
    const tab = req.query.tab || 'home';
    return render(res, "home.html", {
      title: "Atas",
      activeSection: "home",
      activeAtaTab: tab,
      recentAtas: database.listRecentAtas(5),
    });
  });

  app.get("/presenca", requireAuth, (req, res) => {
    return render(res, "presenca/index.html", {
      title: "Controle de Presença",
      activeSection: "presenca",
    });
  });

  app.post("/presenca/registrar", requireAuth, (req, res) => {
    if (!verifyCsrf(req)) {
      const nextToken = ensureCsrfToken(req);
      return res.status(403).json({
        success: false,
        error: "CSRF token inválido ou expirado.",
        csrfToken: nextToken,
      });
    }

    const crachaValue = String(req.body.cracha || "").trim();
    const eventoValue = String(req.body.evento || "").trim();

    if (!crachaValue) {
      return res.json({ success: false, message: 'Informe o número do crachá.', error: 'Crachá obrigatório.' });
    }

    if (!eventoValue) {
      return res.json({ success: false, message: 'Selecione o evento.', error: 'Evento obrigatório.' });
    }

    const workbook = XLSX.readFile('planilha_presenca.xlsx');
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const header = rawData[0];
    const data = rawData.slice(1).map((row) => {
      const obj = {};
      header.forEach((col, i) => {
        obj[col] = row[i] || '';
      });
      return obj;
    });

    const row = data.find((r) => String(r.CRACHA || '').trim() === crachaValue);
    if (!row) {
      return res.json({ success: false, message: 'Crachá não encontrado.' });
    }

    const nome = row.NOME || 'Participante';
    const eventoCol = eventoValue.toUpperCase();
    if (!header.includes(eventoCol)) {
      return res.json({ success: false, message: 'Evento inválido.' });
    }

    const eventLabel = eventoValue.replace(/evento_/i, 'Evento ').replace(/_/g, ' ');

    if (row[eventoCol]) {
      return res.json({
        success: false,
        message: `${nome} já foi registrado para ${eventLabel}.`,
      });
    }

    row[eventoCol] = 'X';

    const updatedRaw = [header, ...data.map((obj) => header.map((col) => obj[col] || ''))];
    const newSheet = XLSX.utils.aoa_to_sheet(updatedRaw);
    workbook.Sheets[sheetName] = newSheet;
    XLSX.writeFile(workbook, 'planilha_presenca.xlsx');

    return res.json({
      success: true,
      message: `${nome} foi registrado para ${eventLabel}.`,
    });
  });

  app.get("/members", requireAuth, (req, res) => {
    return render(res, "members/list.html", {
      title: "Membros Ativos",
      activeSection: "members",
      members: database.listActiveMembers(),
    });
  });

  app.get("/members/add", requireAuth, requireAdminPage, (req, res) => {
    return renderMemberForm(res, {
      title: "Adicionar Membro",
      actionLabel: "Adicionar",
      formData: {
        name: "",
      },
      errors: {},
    });
  });

  app.post("/members/add", requireAuth, requireAdminPage, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const formData = {
      name: String(req.body.name || "").trim(),
    };
    const errors = {};

    if (!formData.name) {
      errors.name = ["Nome é obrigatório."];
    } else if (formData.name.length < 2 || formData.name.length > 100) {
      errors.name = ["Nome deve ter entre 2 e 100 caracteres."];
    }

    if (Object.keys(errors).length > 0) {
      return renderMemberForm(res, {
        title: "Adicionar Membro",
        actionLabel: "Adicionar",
        formData,
        errors,
      });
    }

    try {
      const member = database.createMember(formData.name);
      req.flash("success", `Membro "${member.name}" adicionado com sucesso!`);
      return res.redirect(urlFor("list_members"));
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        errors.name = ["Já existe um membro com este nome."];
        return renderMemberForm(res, {
          title: "Adicionar Membro",
          actionLabel: "Adicionar",
          formData,
          errors,
        });
      }

      console.error("Erro ao adicionar membro:", error);
      req.flash("danger", `Erro ao adicionar membro: ${error.message}`);
      return renderMemberForm(res, {
        title: "Adicionar Membro",
        actionLabel: "Adicionar",
        formData,
        errors,
      });
    }
  });

  app.get("/members/edit/:id", requireAuth, requireAdminPage, (req, res) => {
    const member = database.getMemberById(parseId(req.params.id));
    if (!member) {
      return notFound(res);
    }

    return renderMemberForm(res, {
      title: `Editar Membro: ${member.name} ${member.is_active ? "(Ativo)" : "(Inativo)"}`,
      actionLabel: "Salvar Alterações",
      formData: {
        name: member.name,
      },
      errors: {},
      member,
    });
  });

  app.post("/members/edit/:id", requireAuth, requireAdminPage, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const memberId = parseId(req.params.id);
    const member = database.getMemberById(memberId);
    if (!member) {
      return notFound(res);
    }

    const formData = {
      name: String(req.body.name || "").trim(),
    };
    const errors = {};

    if (!formData.name) {
      errors.name = ["Nome é obrigatório."];
    } else if (formData.name.length < 2 || formData.name.length > 100) {
      errors.name = ["Nome deve ter entre 2 e 100 caracteres."];
    }

    if (Object.keys(errors).length > 0) {
      return renderMemberForm(res, {
        title: `Editar Membro: ${member.name} ${member.is_active ? "(Ativo)" : "(Inativo)"}`,
        actionLabel: "Salvar Alterações",
        formData,
        errors,
        member,
      });
    }

    try {
      database.updateMember(memberId, formData.name);
      req.flash("success", `Membro "${formData.name}" atualizado com sucesso!`);
      return res.redirect(urlFor("list_members"));
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        errors.name = ["Já existe um membro com este nome."];
      } else {
        console.error("Erro ao editar membro:", error);
        req.flash("danger", `Erro ao editar membro: ${error.message}`);
      }

      return renderMemberForm(res, {
        title: `Editar Membro: ${member.name} ${member.is_active ? "(Ativo)" : "(Inativo)"}`,
        actionLabel: "Salvar Alterações",
        formData,
        errors,
        member,
      });
    }
  });

  app.post("/members/delete/:id", requireAuth, requireAdminPage, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const memberId = parseId(req.params.id);
    const member = database.getMemberById(memberId);
    if (!member) {
      return notFound(res);
    }

    if (!member.is_active) {
      req.flash("info", `Membro "${member.name}" já está inativo.`);
      return res.redirect(urlFor("list_members"));
    }

    try {
      database.deactivateMember(memberId);
      req.flash(
        "success",
        `Membro "${member.name}" desativado com sucesso e removido dos projetos!`,
      );
    } catch (error) {
      console.error("Erro ao desativar membro:", error);
      req.flash("danger", `Erro ao desativar membro: ${error.message}`);
    }

    return res.redirect(urlFor("list_members"));
  });

  app.get("/projects", requireAuth, (req, res) => {
    return render(res, "projects/list.html", {
      title: "Projetos",
      activeSection: "projects",
      projects: database.listProjectsWithMembers(),
    });
  });

  app.get("/projects/add", requireAuth, requireAdminPage, (req, res) => {
    return renderProjectForm(res, {
      title: "Adicionar Projeto",
      actionLabel: "Adicionar",
      formData: {
        name: "",
        memberIds: [],
        logoClear: false,
      },
      errors: {},
    });
  });

  app.post(
    "/projects/add",
    requireAuth,
    requireAdminPage,
    runLogoUpload,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return;
      }

      const memberIds = parseIdArray(req.body.members);
      const formData = {
        name: String(req.body.name || "").trim(),
        memberIds,
        logoClear: false,
      };
      const errors = {};

      if (!formData.name) {
        errors.name = ["Nome do projeto é obrigatório."];
      } else if (formData.name.length < 3 || formData.name.length > 150) {
        errors.name = ["Nome do projeto deve ter entre 3 e 150 caracteres."];
      }

      if (req.uploadError) {
        errors.logo = [req.uploadError];
      }

      const validMemberIds = new Set(
        database.listActiveMembers().map((member) => member.id),
      );
      const invalidMemberIds = memberIds.filter(
        (memberId) => !validMemberIds.has(memberId),
      );
      if (invalidMemberIds.length > 0) {
        errors.members = ["Há membros inválidos na seleção."];
      }

      if (Object.keys(errors).length > 0) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return renderProjectForm(res, {
          title: "Adicionar Projeto",
          actionLabel: "Adicionar",
          formData,
          errors,
        });
      }

      try {
        const project = database.createProject({
          name: formData.name,
          logo: req.file ? req.file.filename : null,
          memberIds,
        });
        req.flash("success", `Projeto "${project.name}" adicionado com sucesso!`);
        return res.redirect(urlFor("list_projects"));
      } catch (error) {
        if (req.file) {
          safeUnlink(req.file.path);
        }

        if (isUniqueConstraintError(error)) {
          errors.name = ["Já existe um projeto com este nome."];
        } else {
          console.error("Erro ao adicionar projeto:", error);
          req.flash("danger", `Erro ao adicionar projeto: ${error.message}`);
        }

        return renderProjectForm(res, {
          title: "Adicionar Projeto",
          actionLabel: "Adicionar",
          formData,
          errors,
        });
      }
    },
  );

  app.get("/projects/edit/:id", requireAuth, requireAdminPage, (req, res) => {
    const project = database.getProjectById(parseId(req.params.id));
    if (!project) {
      return notFound(res);
    }

    return renderProjectForm(res, {
      title: "Editar Projeto",
      actionLabel: "Salvar Alterações",
      formData: {
        name: project.name,
        memberIds: project.active_member_ids,
        logoClear: false,
      },
      errors: {},
      project,
    });
  });

  app.post(
    "/projects/edit/:id",
    requireAuth,
    requireAdminPage,
    runLogoUpload,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return;
      }

      const projectId = parseId(req.params.id);
      const project = database.getProjectById(projectId);
      if (!project) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return notFound(res);
      }

      const memberIds = parseIdArray(req.body.members);
      const formData = {
        name: String(req.body.name || "").trim(),
        memberIds,
        logoClear: Boolean(req.body["logo-clear"]),
      };
      const errors = {};

      if (!formData.name) {
        errors.name = ["Nome do projeto é obrigatório."];
      } else if (formData.name.length < 3 || formData.name.length > 150) {
        errors.name = ["Nome do projeto deve ter entre 3 e 150 caracteres."];
      }

      if (req.uploadError) {
        errors.logo = [req.uploadError];
      }

      const validMemberIds = new Set(
        database.listActiveMembers().map((member) => member.id),
      );
      const invalidMemberIds = memberIds.filter(
        (memberId) => !validMemberIds.has(memberId),
      );
      if (invalidMemberIds.length > 0) {
        errors.members = ["Há membros inválidos na seleção."];
      }

      if (Object.keys(errors).length > 0) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return renderProjectForm(res, {
          title: "Editar Projeto",
          actionLabel: "Salvar Alterações",
          formData,
          errors,
          project,
        });
      }

      let logo = project.logo;
      let uploadedIsNew = false;

      if (req.file) {
        logo = req.file.filename;
        uploadedIsNew = logo !== project.logo;
        if (project.logo && uploadedIsNew) {
          safeUnlink(path.join(config.uploadDir, project.logo));
        }
      } else if (formData.logoClear) {
        if (project.logo) {
          safeUnlink(path.join(config.uploadDir, project.logo));
        }
        logo = null;
      }

      try {
        const updated = database.updateProject(projectId, {
          name: formData.name,
          logo,
          memberIds,
        });
        req.flash("success", `Projeto "${updated.name}" atualizado com sucesso!`);
        return res.redirect(urlFor("list_projects"));
      } catch (error) {
        if (req.file && uploadedIsNew) {
          safeUnlink(req.file.path);
        }

        if (isUniqueConstraintError(error)) {
          errors.name = ["Já existe um projeto com este nome."];
        } else {
          console.error("Erro ao editar projeto:", error);
          req.flash("danger", `Erro ao editar projeto: ${error.message}`);
        }

        return renderProjectForm(res, {
          title: "Editar Projeto",
          actionLabel: "Salvar Alterações",
          formData,
          errors,
          project: {
            ...project,
            logo,
          },
        });
      }
    },
  );

  app.post("/projects/delete/:id", requireAuth, requireAdminPage, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const projectId = parseId(req.params.id);
    const project = database.getProjectById(projectId);
    if (!project) {
      return notFound(res);
    }

    try {
      database.deleteProject(projectId);
      if (project.logo) {
        safeUnlink(path.join(config.uploadDir, project.logo));
      }
      req.flash(
        "success",
        `Projeto "${project.name}" e suas atas associadas foram excluídos com sucesso!`,
      );
    } catch (error) {
      console.error("Erro ao excluir projeto:", error);
      req.flash("danger", `Erro ao excluir projeto: ${error.message}`);
    }

    return res.redirect(urlFor("list_projects"));
  });

  app.get("/atas/create", requireAuth, (req, res) => {
    return renderAtaForm(res, {
      title: "Criar Nova Ata",
      formData: {
        projectId: "",
        meetingDatetime: defaultMeetingDateTimeInput(),
        notes: "",
        presentMemberIds: [],
        justifications: {},
      },
      errors: {},
    });
  });

  app.get("/atas/create/for/:project_id", requireAuth, (req, res) => {
    const projectId = parseId(req.params.project_id);
    const project = database.getProjectById(projectId);
    if (!project) {
      return notFound(res);
    }

    return renderAtaForm(res, {
      title: "Criar Nova Ata",
      formData: {
        projectId: String(projectId),
        meetingDatetime: defaultMeetingDateTimeInput(),
        notes: "",
        presentMemberIds: [],
        justifications: {},
      },
      errors: {},
    });
  });

  app.post(
    ["/atas/create", "/atas/create/for/:project_id"],
    requireAuth,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const formData = {
        projectId: String(req.body.project || req.body.projectId || ""),
        meetingDatetime: String(req.body.meeting_datetime || "").trim(),
        notes: String(req.body.notes || ""),
        presentMemberIds: parseIdArray(req.body.present_members),
        justifications: {},
      };

      const errors = {};
      const projectId = parseId(formData.projectId);
      const project = projectId ? database.getProjectById(projectId) : null;

      if (!project) {
        errors.project = ["É necessário selecionar um projeto válido."];
      }

      const meetingDateTime = toSqlDateTime(formData.meetingDatetime);
      if (!meetingDateTime) {
        errors.meeting_datetime = ["Data e hora são obrigatórias."];
      }

      if (!formData.notes.trim()) {
        errors.notes = ["É necessário registrar o que foi tratado."];
      } else if (formData.notes.trim().length < 10) {
        errors.notes = ["O campo deve ter pelo menos 10 caracteres."];
      }

      let validProjectMemberIds = new Set();
      let activeProjectMembers = [];
      if (project) {
        validProjectMemberIds = new Set(project.members.map((member) => member.id));
        activeProjectMembers = project.active_members;
      }

      const invalidPresentMembers = formData.presentMemberIds.filter(
        (memberId) => !validProjectMemberIds.has(memberId),
      );
      if (invalidPresentMembers.length > 0 && project) {
        errors.present_members = [
          `Os seguintes membros selecionados não pertencem ao projeto "${project.name}".`,
        ];
      }

      activeProjectMembers.forEach((member) => {
        const fieldName = `justification_${member.id}`;
        const justification = trimToNull(req.body[fieldName]);
        if (justification) {
          formData.justifications[member.id] = justification;
        }
      });

      if (Object.keys(errors).length > 0) {
        return renderAtaForm(res, {
          title: "Criar Nova Ata",
          formData,
          errors,
        });
      }

      const presentMemberIds = new Set(formData.presentMemberIds);
      const justificationsToSave = {};

      activeProjectMembers.forEach((member) => {
        if (!presentMemberIds.has(member.id)) {
          const justification = trimToNull(formData.justifications[member.id]);
          if (justification) {
            justificationsToSave[member.id] = justification;
          }
        }
      });

      try {
        database.createAta({
          projectId,
          meetingDateTime,
          notes: formData.notes.trim(),
          presentMemberIds: [...presentMemberIds],
          justifications: justificationsToSave,
        });
        req.flash("success", "Ata criada com sucesso!");
        return res.redirect(urlFor("home"));
      } catch (error) {
        console.error("Erro ao criar ata:", error);
        req.flash("danger", `Erro ao criar ata: ${error.message}`);
        return renderAtaForm(res, {
          title: "Criar Nova Ata",
          formData,
          errors,
        });
      }
    },
  );

  app.get("/atas/download/:id", requireAuth, async (req, res) => {
    const ata = database.getAtaById(parseId(req.params.id));
    if (!ata) {
      return notFound(res);
    }

    try {
      const pdf = await generateAtaPdf(ata);
      const datePart = formatDatePt(ata.meeting_datetime).replace(/\//g, "");
      const safeProjectName = ata.project.name.replace(/\s+/g, "_");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Ata_${safeProjectName}_${datePart}.pdf"`,
      );
      return res.send(pdf);
    } catch (error) {
      console.error("Erro ao gerar PDF:", error);
      req.flash(
        "danger",
        `Ocorreu um erro ao gerar o PDF da ata: ${error.message}`,
      );
      return res.redirect(urlFor("home"));
    }
  });

  app.post("/atas/delete/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const ataId = parseId(req.params.id);
    const ata = database.getAtaById(ataId);
    if (!ata) {
      return notFound(res);
    }

    try {
      database.deleteAta(ataId);
      req.flash("success", "Ata excluída com sucesso!");
    } catch (error) {
      console.error("Erro ao excluir ata:", error);
      req.flash("danger", `Erro ao excluir a ata: ${error.message}`);
    }

    return res.redirect(urlFor("home"));
  });

  app.get("/almoxarifado", requireAuth, (req, res) => {
    return renderAlmox(res, {
      activeTab: req.query.tab,
    });
  });

  app.post(
    "/almoxarifado/users/create",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "users";
      const userFormData = {
        name: String(req.body.name || "").trim(),
        username: String(req.body.username || "").trim(),
        password: "",
        role: String(req.body.role || "common").trim().toLowerCase(),
      };
      const rawPassword = String(req.body.password || "");
      const userErrors = {};

      if (!userFormData.name) {
        userErrors.name = ["O nome completo é obrigatório."];
      } else if (userFormData.name.length < 3 || userFormData.name.length > 120) {
        userErrors.name = ["O nome deve ter entre 3 e 120 caracteres."];
      }

      if (!userFormData.username) {
        userErrors.username = ["O nome de usuário é obrigatório."];
      } else if (!/^[a-zA-Z0-9._-]{3,40}$/.test(userFormData.username)) {
        userErrors.username = [
          "Use de 3 a 40 caracteres com letras, números, ponto, traço ou sublinhado.",
        ];
      }

      if (!rawPassword) {
        userErrors.password = ["A senha é obrigatória."];
      } else if (rawPassword.length < 6) {
        userErrors.password = ["A senha deve ter pelo menos 6 caracteres."];
      }

      if (!["admin", "common"].includes(userFormData.role)) {
        userFormData.role = "common";
      }

      if (Object.keys(userErrors).length > 0) {
        return renderAlmox(res, {
          activeTab,
          userFormData,
          userErrors,
        });
      }

      try {
        const passwordHash = bcrypt.hashSync(rawPassword, 12);
        const createdUser = database.createUser(userFormData.username, passwordHash, {
          name: userFormData.name,
          role: userFormData.role,
        });

        req.flash(
          "success",
          `Usuário "${createdUser.username}" criado com sucesso como ${createdUser.role === "admin" ? "administrador" : "comum"}.`,
        );
        return res.redirect(almoxPath(activeTab));
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          userErrors.username = ["Já existe um usuário com esse nome de acesso."];
        } else {
          console.error("Erro ao criar usuário:", error);
          req.flash("danger", `Erro ao criar usuário: ${error.message}`);
        }

        return renderAlmox(res, {
          activeTab,
          userFormData,
          userErrors,
        });
      }
    },
  );

  app.post(
    "/almoxarifado/inventory/create",
    requireAuth,
    requireAdminPage,
    (req, res) => {
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
          `Material "${createdItem.name}" (${createdItem.item_type === "patrimony" ? "patrimônio" : "estoque"}) adicionado com sucesso.`,
        );
        return res.redirect(almoxPath(activeTab));
      } catch (error) {
        console.error("Erro ao adicionar item ao estoque:", error);
        req.flash("danger", `Erro ao adicionar item: ${error.message}`);
        return renderAlmox(res, {
          activeTab,
          itemFormData,
          itemErrors,
        });
      }
    },
  );

  app.post(
    "/almoxarifado/categories/create",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "manage";
      const { normalized, errors } = validateCatalogName(
        req.body.name,
        "nome da categoria",
      );

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
          errors.name = ["Já existe uma categoria com esse nome."];
        } else {
          console.error("Erro ao criar categoria:", error);
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

  app.post(
    "/almoxarifado/categories/delete/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const categoryId = parseId(req.params.id);
      if (!categoryId) {
        req.flash("warning", "Categoria inválida.");
        return res.redirect(almoxPath("manage"));
      }

      try {
        const deleted = database.deleteInventoryCategory(categoryId);
        if (!deleted) {
          req.flash("warning", "Categoria não encontrada.");
        } else {
          req.flash("success", `Categoria "${deleted.name}" removida com sucesso.`);
        }
      } catch (error) {
        console.error("Erro ao remover categoria:", error);
        req.flash("danger", `Erro ao remover categoria: ${error.message}`);
      }

      return res.redirect(almoxPath("manage"));
    },
  );

  app.post(
    "/almoxarifado/locations/create",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "manage";
      const { normalized, errors } = validateCatalogName(
        req.body.name,
        "nome do local",
      );

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
          errors.name = ["Já existe um local com esse nome."];
        } else {
          console.error("Erro ao criar local:", error);
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

  app.post(
    "/almoxarifado/locations/delete/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const locationId = parseId(req.params.id);
      if (!locationId) {
        req.flash("warning", "Local inválido.");
        return res.redirect(almoxPath("manage"));
      }

      try {
        const deleted = database.deleteInventoryLocation(locationId);
        if (!deleted) {
          req.flash("warning", "Local não encontrado.");
        } else {
          req.flash("success", `Local "${deleted.name}" removido com sucesso.`);
        }
      } catch (error) {
        console.error("Erro ao remover local:", error);
        req.flash("danger", `Erro ao remover local: ${error.message}`);
      }

      return res.redirect(almoxPath("manage"));
    },
  );

  app.post(
    "/almoxarifado/inventory/delete/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const itemId = parseId(req.params.id);
      if (!itemId) {
        req.flash("warning", "Produto inválido para exclusão.");
        return res.redirect(almoxPath(req.body.tab || "stock"));
      }

      try {
        const deletedItem = database.deleteInventoryItem(itemId);

        if (!deletedItem) {
          req.flash("warning", "Produto não encontrado.");
        } else {
          req.flash(
            "success",
            `Produto "${deletedItem.name}" removido do almoxarifado com sucesso.`,
          );
        }
      } catch (error) {
        console.error("Erro ao excluir item do estoque:", error);
        req.flash("danger", `Erro ao excluir item: ${error.message}`);
      }

      return res.redirect(almoxPath(req.body.tab || "stock"));
    },
  );

  app.post("/almoxarifado/inventory/withdraw", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const activeTab = "withdraw";
    const withdrawFormData = {
      nameOrCode: String(req.body.name_or_code || "").trim(),
      quantity: String(req.body.quantity || "").trim(),
    };
    const withdrawErrors = {};
    const quantity = Number(withdrawFormData.quantity);

    if (!withdrawFormData.nameOrCode) {
      withdrawErrors.nameOrCode = ["Informe o nome exato ou o ID do produto."];
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      withdrawErrors.quantity = ["Informe uma quantidade inteira maior que zero."];
    }

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

  app.post("/almoxarifado/inventory/borrow", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const activeTab = "borrow";
    const loanFormData = {
      nameOrCode: String(req.body.name_or_code || "").trim(),
      quantity: String(req.body.quantity || "").trim(),
    };
    const loanErrors = {};
    const quantity = Number(loanFormData.quantity);

    if (!loanFormData.nameOrCode) {
      loanErrors.nameOrCode = ["Informe o nome exato ou o ID do patrimônio."];
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      loanErrors.quantity = ["Informe uma quantidade inteira maior que zero."];
    }

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

  app.post("/almoxarifado/loans/return/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const loanId = parseId(req.params.id);
    if (!loanId) {
      req.flash("warning", "Empréstimo inválido.");
      return res.redirect(almoxPath("borrowed"));
    }

    const loan = database.getInventoryLoanById(loanId);
    if (!loan) {
      req.flash("warning", "Empréstimo não encontrado.");
      return res.redirect(almoxPath("borrowed"));
    }

    if (!req.currentUser.is_admin && loan.user_id !== req.currentUser.id) {
      req.flash(
        "warning",
        "Você só pode registrar a devolução dos empréstimos feitos no seu usuário.",
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

  app.post(
    "/almoxarifado/loans/extend/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const loanId = parseId(req.params.id);
      const extraDays = Number(req.body.extra_days);

      if (!loanId) {
        req.flash("warning", "Empréstimo inválido.");
        return res.redirect(almoxPath("borrowed"));
      }

      if (!Number.isInteger(extraDays) || extraDays <= 0 || extraDays > 90) {
        req.flash(
          "warning",
          "Informe uma prorrogação válida entre 1 e 90 dias.",
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

  app.get("/almoxarifado/api/itens", requireAuth, (req, res) => {
    return res.json(
      database.listInventoryItems().map((item) => ({
        id: item.id,
        nome: item.name,
        tipo: item.item_type,
        descricao: item.description,
        categoria: item.category,
        categoria_id: item.category_id,
        local: item.location,
        local_id: item.location_id,
        quantidade: item.amount,
      })),
    );
  });

  app.post(
    "/almoxarifado/api/itens",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const parsed = parseInventoryPayload(req.body);
      const { errors, normalized } = validateInventoryPayload(parsed);
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: "Dados inválidos.", details: errors });
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
        console.error("Erro ao criar item via API:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.put(
    "/almoxarifado/api/itens/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const itemId = parseId(req.params.id);
      if (!itemId) {
        return res.status(400).json({ error: "Item inválido." });
      }

      const parsed = parseInventoryPayload(req.body);
      const { errors, normalized } = validateInventoryPayload(parsed);
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: "Dados inválidos.", details: errors });
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
          return res.status(404).json({ error: "Item não encontrado." });
        }

        return res.json(updated);
      } catch (error) {
        console.error("Erro ao atualizar item via API:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.delete(
    "/almoxarifado/api/itens/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const itemId = parseId(req.params.id);
      if (!itemId) {
        return res.status(400).json({ error: "Item inválido." });
      }

      try {
        const deleted = database.deleteInventoryItem(itemId);
        if (!deleted) {
          return res.status(404).json({ error: "Item não encontrado." });
        }

        return res.json({
          mensagem: "Item removido com sucesso.",
          item: deleted,
        });
      } catch (error) {
        console.error("Erro ao remover item via API:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.get("/almoxarifado/api/categorias", requireAuth, (req, res) => {
    return res.json(
      database.listInventoryCategories().map((category) => ({
        id: category.id,
        nome: category.name,
      })),
    );
  });

  app.post(
    "/almoxarifado/api/categorias",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome da categoria",
      );
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: "Dados inválidos.", details: errors });
      }

      try {
        const category = database.createInventoryCategory(normalized);
        return res.status(201).json({ id: category.id, nome: category.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return res.status(400).json({ error: "Categoria já cadastrada." });
        }
        console.error("Erro ao criar categoria via API:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.put(
    "/almoxarifado/api/categorias/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const categoryId = parseId(req.params.id);
      if (!categoryId) {
        return res.status(400).json({ error: "Categoria inválida." });
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome da categoria",
      );
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: "Dados inválidos.", details: errors });
      }

      try {
        const category = database.updateInventoryCategory(categoryId, normalized);
        if (!category) {
          return res.status(404).json({ error: "Categoria não encontrada." });
        }

        return res.json({ id: category.id, nome: category.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return res.status(400).json({ error: "Categoria já cadastrada." });
        }
        console.error("Erro ao atualizar categoria via API:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.delete(
    "/almoxarifado/api/categorias/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const categoryId = parseId(req.params.id);
      if (!categoryId) {
        return res.status(400).json({ error: "Categoria inválida." });
      }

      try {
        const deleted = database.deleteInventoryCategory(categoryId);
        if (!deleted) {
          return res.status(404).json({ error: "Categoria não encontrada." });
        }

        return res.json({
          mensagem: "Categoria removida com sucesso.",
          categoria: { id: deleted.id, nome: deleted.name },
        });
      } catch (error) {
        console.error("Erro ao remover categoria via API:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.get("/almoxarifado/api/locais", requireAuth, (req, res) => {
    return res.json(
      database.listInventoryLocations().map((location) => ({
        id: location.id,
        nome: location.name,
      })),
    );
  });

  app.post(
    "/almoxarifado/api/locais",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome do local",
      );
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: "Dados inválidos.", details: errors });
      }

      try {
        const location = database.createInventoryLocation(normalized);
        return res.status(201).json({ id: location.id, nome: location.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return res.status(400).json({ error: "Local já cadastrado." });
        }
        console.error("Erro ao criar local via API:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.put(
    "/almoxarifado/api/locais/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const locationId = parseId(req.params.id);
      if (!locationId) {
        return res.status(400).json({ error: "Local inválido." });
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome do local",
      );
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ error: "Dados inválidos.", details: errors });
      }

      try {
        const location = database.updateInventoryLocation(locationId, normalized);
        if (!location) {
          return res.status(404).json({ error: "Local não encontrado." });
        }

        return res.json({ id: location.id, nome: location.name });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return res.status(400).json({ error: "Local já cadastrado." });
        }
        console.error("Erro ao atualizar local via API:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.delete(
    "/almoxarifado/api/locais/:id",
    requireAuth,
    requireAdminApi,
    (req, res) => {
      if (!ensureValidApiCsrf(req, res)) {
        return;
      }

      const locationId = parseId(req.params.id);
      if (!locationId) {
        return res.status(400).json({ error: "Local inválido." });
      }

      try {
        const deleted = database.deleteInventoryLocation(locationId);
        if (!deleted) {
          return res.status(404).json({ error: "Local não encontrado." });
        }

        return res.json({
          mensagem: "Local removido com sucesso.",
          local: { id: deleted.id, nome: deleted.name },
        });
      } catch (error) {
        console.error("Erro ao remover local via API:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  app.get("/api/project/:project_id/members", requireAuth, (req, res) => {
    const projectId = parseId(req.params.project_id);
    const project = projectId ? database.getProjectById(projectId) : null;

    if (!project) {
      return res.status(404).json({ error: "Projeto não encontrado." });
    }

    return res.json({
      members: project.active_members.map((member) => ({
        id: member.id,
        name: member.name,
      })),
    });
  });

  app.use((req, res) => {
    return notFound(res);
  });

  app.use((error, req, res, next) => {
    console.error("Erro interno do servidor:", error);
    res.status(500).render("errors/500.html", {
      title: "Erro Interno",
      activeSection: "",
    });
  });

  return app;
}

module.exports = { createApp };
