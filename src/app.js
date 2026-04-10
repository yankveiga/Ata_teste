/*
 * ARQUIVO: src/app.js
 * FUNCAO: composicao principal da aplicacao (middlewares, autenticacao, validacoes e rotas HTTP).
 * IMPACTO DE MUDANCAS:
 * - Mudancas em middlewares globais alteram comportamento de todas as rotas (sessao, CSRF, flashes e parsing de formulario).
 * - Mudancas em regras de permissao ou validacao podem abrir acesso indevido ou bloquear fluxos legitimos.
 * - Mudancas nas rotas afetam formularios, links e consumo de dados nos templates.
 */
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
const { generateAtaPdf, generateMonthlyReportPdf } = require("./pdf");
const {
  isCloudinaryEnabled,
  isRemoteAssetUrl,
  uploadImageFromPath,
  deleteImageByUrl,
} = require("./media");
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

// SECAO: constantes de dominio usadas por validacoes e comportamento de modulos.

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
const DEFAULT_PROJECT_COLOR = "#0b6bcb";
const REPORTS_TIMEZONE = "America/Sao_Paulo";

function getDatePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const valueByType = {};
  parts.forEach((part) => {
    valueByType[part.type] = part.value;
  });
  return {
    year: Number(valueByType.year),
    month: Number(valueByType.month),
    day: Number(valueByType.day),
    weekday: valueByType.weekday,
  };
}

function formatYmd(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// SECAO: helpers de normalizacao de entrada (query/form).
// Mantem valores padrao quando entrada vier ausente ou invalida.

// DETALHE: Normaliza a aba solicitada para evitar estados invalidos na interface do almoxarifado.

function normalizeAlmoxTab(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ALMOX_TABS.has(normalized) ? normalized : "overview";
}

// DETALHE: Garante que o tipo de item fique restrito aos tipos reconhecidos pelo sistema.

function normalizeInventoryItemType(value) {
  return INVENTORY_ITEM_TYPES.has(value) ? value : "stock";
}

// DETALHE: Valida e padroniza cor hexadecimal; evita salvar valor invalido no banco.

function normalizeProjectColor(value, fallback = DEFAULT_PROJECT_COLOR) {
  const normalized = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : fallback;
}

// DETALHE: Calcula o inicio da semana (segunda-feira UTC) usado nos relatorios semanais.

function getCurrentWeekStartDate() {
  const now = new Date();
  const weekdayToOffset = {
    Mon: 0,
    Tue: -1,
    Wed: -2,
    Thu: -3,
    Fri: -4,
    Sat: -5,
    Sun: -6,
  };
  const parts = getDatePartsInTimeZone(now, REPORTS_TIMEZONE);
  const offset = weekdayToOffset[parts.weekday] ?? 0;
  const baseUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  baseUtc.setUTCDate(baseUtc.getUTCDate() + offset);
  return formatYmd(
    baseUtc.getUTCFullYear(),
    baseUtc.getUTCMonth() + 1,
    baseUtc.getUTCDate(),
  );
}

// DETALHE: Converte data recebida para a segunda-feira da semana correspondente.

function normalizeWeekStartDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }

  const date = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const weekdayToOffset = {
    Mon: 0,
    Tue: -1,
    Wed: -2,
    Thu: -3,
    Fri: -4,
    Sat: -5,
    Sun: -6,
  };
  const parts = getDatePartsInTimeZone(date, REPORTS_TIMEZONE);
  const offset = weekdayToOffset[parts.weekday] ?? 0;
  const baseUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  baseUtc.setUTCDate(baseUtc.getUTCDate() + offset);
  return formatYmd(
    baseUtc.getUTCFullYear(),
    baseUtc.getUTCMonth() + 1,
    baseUtc.getUTCDate(),
  );
}

// DETALHE: Normaliza status do relatorio e aplica fallback seguro quando vier invalido.

function normalizeReportStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["completed", "in_progress", "blocked"].includes(normalized)
    ? normalized
    : "in_progress";
}

// DETALHE: Monta querystring de filtros preservando contexto de navegacao na tela de relatorios.

function buildReportsQuery({ memberId = null, projectId = null, editId = null } = {}) {
  const params = new URLSearchParams();
  if (memberId) {
    params.set("member_id", String(memberId));
  }
  if (projectId) {
    params.set("project_id", String(projectId));
  }
  if (editId) {
    params.set("edit_id", String(editId));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function getCurrentMonthKeyInSaoPaulo() {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  const [year, month] = formatted.split("-");
  return `${year}-${month}`;
}

function normalizeMonthKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : null;
}

// SECAO: integracao com planilha de presenca (leitura/escrita de arquivo XLSX).

// DETALHE: Executa leitura, validacao e gravacao da presenca diretamente na planilha XLSX.

function registerPresenceInWorkbook(cracha, evento) {
  const crachaValue = String(cracha || "").trim();
  const eventoValue = String(evento || "").trim();

  if (!crachaValue) {
    return { success: false, message: "Informe o número do crachá." };
  }

  if (!fs.existsSync(config.presenceWorkbookPath)) {
    return {
      success: false,
      message: "Planilha de presença não encontrada no servidor.",
    };
  }

  const workbook = XLSX.readFile(config.presenceWorkbookPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const header = rawData[0];
  const data = rawData.slice(1).map((row) => {
    const obj = {};
    header.forEach((col, i) => {
      obj[col] = row[i] || "";
    });
    return obj;
  });

  const row = data.find((currentRow) => String(currentRow.CRACHA || "").trim() === crachaValue);
  if (!row) {
    return { success: false, message: "Crachá não encontrado." };
  }

  const nome = row.NOME || "Participante";
  const eventoCol = String(eventoValue || "").toUpperCase();
  if (!header.includes(eventoCol)) {
    return { success: false, message: "Evento inválido." };
  }

  const eventLabel = eventoValue.replace(/evento_/i, "Evento ").replace(/_/g, " ");
  if (row[eventoCol]) {
    return {
      success: false,
      message: `${nome} já foi registrado para ${eventLabel}.`,
    };
  }

  row[eventoCol] = "X";

  const updatedRaw = [header, ...data.map((obj) => header.map((col) => obj[col] || ""))];
  const newSheet = XLSX.utils.aoa_to_sheet(updatedRaw);
  workbook.Sheets[sheetName] = newSheet;
  XLSX.writeFile(workbook, config.presenceWorkbookPath);

  return {
    success: true,
    message: `${nome} foi registrado para ${eventLabel}.`,
  };
}

// SECAO: fabrica principal da aplicacao Express (middlewares, rotas e tratamento de erro).

// DETALHE: Ponto central de composicao: configura Express, middlewares, regras de acesso e rotas.

function createApp() {
  database.ensureSchema();
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
  env.addGlobal("mediaUrl", (value) => {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }
    if (isRemoteAssetUrl(text)) {
      return text;
    }
    return urlFor("static", { filename: `uploads/${text}` });
  });

    // SECAO: middlewares globais de sessao, parsers e contexto comum para templates/rotas.

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
    res.locals.currentMember = null;
    res.locals.flashMessages = consumeFlashes(req);
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.title = "";
    res.locals.activeSection = "";
    next();
  });

    // SECAO: upload de arquivos de logo com validacao de tipo e nome sanitizado.

const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, callback) => {
        callback(null, sanitizeFilename(file.originalname));
      },
    }),
    fileFilter: (req, file, callback) => {
      if (!isAllowedImage(file.originalname)) {
        // DETALHE: Rejeita arquivo invalido sem abortar parsing do multipart,
        // preservando campos de formulario (incluindo csrf_token) em req.body.
        req.uploadError = "Apenas imagens (jpg, jpeg, png, gif, webp, jfif) são permitidas!";
        callback(null, false);
        return;
      }

      callback(null, true);
    },
  });

  // DETALHE: Executa upload de logo e converte erro tecnico em mensagem amigavel para a tela.

  function runLogoUpload(req, res, next) {
    upload.single("logo")(req, res, (error) => {
      if (error) {
        req.uploadError = error.message;
      }
      next();
    });
  }

  // DETALHE: Executa upload de foto de membro e reutiliza mesma validacao de imagem.

  function runMemberPhotoUpload(req, res, next) {
    upload.single("photo")(req, res, (error) => {
      if (error) {
        req.uploadError = error.message;
      }
      next();
    });
  }

  async function persistUploadedImage(req, { folder }) {
    if (!req.file) {
      return null;
    }

    if (!isCloudinaryEnabled()) {
      return req.file.filename;
    }

    const uploaded = await uploadImageFromPath(req.file.path, { folder });
    safeUnlink(req.file.path);
    return uploaded.secureUrl;
  }

  async function deleteStoredImage(value) {
    const text = String(value || "").trim();
    if (!text) {
      return;
    }

    if (isRemoteAssetUrl(text)) {
      try {
        await deleteImageByUrl(text);
      } catch (error) {
        console.error(`Falha ao remover imagem remota: ${text}`, error);
      }
      return;
    }

    safeUnlink(path.join(config.uploadDir, text));
  }

  // DETALHE: Monta URL do almoxarifado preservando aba ativa para redirecionamentos.

  function almoxPath(tab = "overview") {
    return `${urlFor("almox_home")}?tab=${normalizeAlmoxTab(tab)}`;
  }

  // DETALHE: Define para onde redirecionar quando usuario sem permissao tenta acao administrativa.

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

    // SECAO: guardas de acesso (autenticacao, autorizacao e protecao CSRF).

// DETALHE: Middleware de autenticacao: bloqueia acesso anonimo e envia usuario para login.

function requireAuth(req, res, next) {
    if (req.currentUser) {
      return next();
    }

    req.flash("info", "Por favor, faça login para acessar esta página.");
    const nextPath = encodeURIComponent(req.originalUrl || urlFor("services"));
    return res.redirect(`${urlFor("login")}?next=${nextPath}`);
  }

  // DETALHE: Middleware para paginas administrativas com feedback via flash e redirect seguro.

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

  // DETALHE: Middleware para APIs administrativas retornando 403 em JSON.

  function requireAdminApi(req, res, next) {
    if (req.currentUser?.is_admin) {
      return next();
    }

    return res.status(403).json({
      error: "Seu perfil não tem permissão para executar esta ação administrativa.",
    });
  }

  // DETALHE: Resolve membro atual a partir da sessao e cacheia resultado no request.

  function getCurrentMember(req) {
    if (req.currentMemberResolved) {
      return req.currentMember || null;
    }

    req.currentMemberResolved = true;
    if (!req.currentUser) {
      req.currentMember = null;
      return null;
    }

    if (req.currentUser.member_id) {
      const linkedMember = database.getMemberById(req.currentUser.member_id);
      if (linkedMember) {
        req.currentMember = linkedMember;
        if (req.res?.locals) {
          req.res.locals.currentMember = req.currentMember;
        }
        return req.currentMember;
      }
    }

    const fromName = database.getMemberByName(req.currentUser.name);
    const fromUsername = database.getMemberByName(req.currentUser.username);
    req.currentMember = fromName || fromUsername || null;
    if (req.res?.locals) {
      req.res.locals.currentMember = req.currentMember;
    }
    return req.currentMember;
  }

  // DETALHE: Lista projetos acessiveis de acordo com perfil e vinculo de membro.

  function listAccessibleProjects(req) {
    if (req.currentUser?.is_admin) {
      return database.listProjectsBasic();
    }

    const currentMember = getCurrentMember(req);
    if (!currentMember?.is_active) {
      return [];
    }

    return database.listProjectsForMember(currentMember.id);
  }

  // DETALHE: Regra de autorizacao para criacao de ata em projeto especifico.

  function canCreateAtaForProject(req, project) {
    if (!project) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = getCurrentMember(req);
    if (!currentMember?.is_active) {
      return false;
    }

    return database.isProjectMember(project.id, currentMember.id);
  }

  // DETALHE: Regra de autorizacao para manutencao de projeto (coordenador/admin).

  function canManageProject(req, project) {
    if (!project) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = getCurrentMember(req);
    if (!currentMember?.is_active) {
      return false;
    }

    return database.isProjectCoordinator(project.id, currentMember.id);
  }

  // DETALHE: Regra de autorizacao para editar/excluir entradas de relatorio.

  function canManageReportEntry(req, reportEntry) {
    if (!reportEntry?.project) {
      return false;
    }
    return canManageProject(req, reportEntry.project);
  }

  // DETALHE: Regra de autorizacao para metas semanais por membro/projeto.

  function canManageReportGoal(req, { memberId, projectId }) {
    if (!memberId || !projectId) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = getCurrentMember(req);
    if (!currentMember?.is_active) {
      return false;
    }

    if (
      currentMember.id === memberId &&
      database.isProjectMember(projectId, currentMember.id)
    ) {
      return true;
    }

    return database.isProjectCoordinator(projectId, currentMember.id);
  }

  function canDeleteCompletedGoalFromOthers(req, goal) {
    if (!goal?.is_completed) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    if (!goal?.id || !goal?.project_id || !goal?.member_id) {
      return false;
    }

    const currentMember = getCurrentMember(req);
    if (!currentMember?.is_active) {
      return false;
    }

    return database.isProjectCoordinator(goal.project_id, currentMember.id);
  }

  // DETALHE: Valida token CSRF para formularios e interrompe fluxo quando invalido.

  function ensureValidCsrf(req, res) {
    if (verifyCsrf(req)) {
      return true;
    }

    req.flash("danger", "A sessão do formulário expirou. Tente novamente.");
    res.redirect(req.get("referer") || urlFor("services"));
    return false;
  }

  // DETALHE: Valida token CSRF para rotas API e responde erro padrao quando invalido.

  function ensureValidApiCsrf(req, res) {
    if (verifyCsrf(req)) {
      return true;
    }

    res.status(403).json({
      error: "CSRF token inválido ou expirado.",
    });
    return false;
  }

    // SECAO: helpers de renderizacao para reduzir repeticao entre telas.

// DETALHE: Wrapper de renderizacao para aplicar titulo/section padrao em todas as views.

function render(res, template, data = {}) {
    res.render(template, {
      title: data.title || "",
      activeSection: data.activeSection || "",
      ...data,
    });
  }

  // DETALHE: Resposta 404 padronizada para recursos inexistentes.

  function notFound(res) {
    return res.status(404).render("errors/404.html", {
      title: "Página Não Encontrada",
      activeSection: "",
    });
  }

  // DETALHE: Renderiza tela de login centralizando defaults de formulario e erros.

  function renderLogin(res, { formData = {}, errors = {} } = {}) {
    return render(res, "login.html", {
      title: "Entrar",
      formData,
      errors,
      next: formData.next || "",
    });
  }

  // DETALHE: Renderiza formulario de membro com dados e mensagens de validacao.

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

  // DETALHE: Renderiza formulario de projeto incluindo membros ativos e controle de permissao.

  function renderProjectForm(res, data) {
    const normalizedFormData = {
      name: "",
      primaryColor: DEFAULT_PROJECT_COLOR,
      memberIds: [],
      coordinatorIds: [],
      logoClear: false,
      ...(data.formData || {}),
    };

    return render(res, "projects/form.html", {
      title: data.title,
      activeSection: "projects",
      formData: normalizedFormData,
      errors: data.errors || {},
      actionLabel: data.actionLabel,
      activeMembers: database.listActiveMembers(),
      project: data.project || null,
      canManageProject: Boolean(data.canManageProject),
    });
  }

  // DETALHE: Renderiza formulario de ata conforme projeto selecionado e membros disponiveis.

  function renderAtaForm(req, res, data) {
    const availableProjects = data.projects || listAccessibleProjects(req);
    const availableProjectIds = new Set(availableProjects.map((project) => project.id));
    const selectedProjectId = parseId(data.formData.projectId);
    const selectedProject = selectedProjectId && availableProjectIds.has(selectedProjectId)
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
      projects: availableProjects,
      selectedProject,
      selectedProjectMembers,
    });
  }

  // DETALHE: Renderiza tela de relatorios com filtros, resumo, formulario e lista de entradas.

  function renderReportPage(req, res, data = {}) {
    const currentMember = getCurrentMember(req);
    const currentWeekStart = getCurrentWeekStartDate();
    const membersSummary = database.listReportMembersSummary();
    const requestedMemberId = parseId(data.selectedMemberId || req.query.member_id);
    const selectedMemberId =
      requestedMemberId ||
      currentMember?.id ||
      membersSummary.find((member) => member.total_entries > 0)?.id ||
      membersSummary[0]?.id ||
      null;

    const selectedMember =
      selectedMemberId && membersSummary.some((member) => member.id === selectedMemberId)
        ? database.getMemberById(selectedMemberId)
        : null;
    const requestedProjectId = parseId(data.selectedProjectId || req.query.project_id);
    const reportProjectOptions = selectedMember
      ? database.listProjectsForMember(selectedMember.id)
      : [];
    const validProjectIds = new Set(reportProjectOptions.map((project) => project.id));
    const selectedProjectId = requestedProjectId && validProjectIds.has(requestedProjectId)
      ? requestedProjectId
      : null;

    const reportGoals = selectedMember
      ? database.listReportWeekGoalsForMember(selectedMember.id, {
          projectId: selectedProjectId || null,
          currentWeekStart,
          limit: 400,
        }).map((goal) => ({
          ...goal,
          can_manage: canManageReportGoal(req, {
            memberId: goal.member_id,
            projectId: goal.project_id,
          }),
          can_delete_completed: canDeleteCompletedGoalFromOthers(req, goal),
        }))
      : [];
    const pendingGoals = reportGoals.filter((goal) => !goal.is_completed);
    const completedGoals = reportGoals.filter((goal) => goal.is_completed);
    const overduePendingGoals = pendingGoals.filter((goal) => goal.is_overdue);
    const openPendingGoals = pendingGoals.filter((goal) => !goal.is_overdue);
    const canCreateGoalsForSelectedMember = Boolean(
      selectedMember && (
        req.currentUser?.is_admin
        || (currentMember?.is_active && currentMember.id === selectedMember.id)
      ),
    );
    const deletionLogs = selectedMember
      ? database.listReportWeekGoalDeletionLogsForMember(selectedMember.id, {
          projectId: selectedProjectId || null,
          limit: 30,
        })
      : [];
    const goalsSummary = reportGoals.reduce(
      (summary, goal) => {
        summary.total += 1;
        if (goal.is_completed) {
          summary.completed += 1;
        } else if (goal.is_overdue) {
          summary.overdue += 1;
        } else {
          summary.pending += 1;
        }
        summary.projectIds.add(goal.project.id);
        summary.weekStarts.add(goal.week_start);
        return summary;
      },
      {
        total: 0,
        completed: 0,
        overdue: 0,
        pending: 0,
        projectIds: new Set(),
        weekStarts: new Set(),
      },
    );

    return render(res, "reports/index.html", {
      title: "Relatórios",
      activeSection: "reports",
      activeAtaTab: "reports",
      selectedMemberId: selectedMember ? selectedMember.id : null,
      selectedProjectId: selectedProjectId || "",
      selectedMember,
      membersSummary,
      reportProjectOptions,
      reportGoals,
      pendingGoals,
      completedGoals,
      deletionLogs,
      overduePendingGoals,
      openPendingGoals,
      canCreateGoalsForSelectedMember,
      currentWeekStart,
      currentMember,
      goalFormData: {
        projectId: selectedProjectId || "",
        activity: "",
        description: "",
        isCompleted: false,
        ...(data.goalFormData || {}),
      },
      goalFormErrors: data.goalFormErrors || {},
      monthlyReportForm: {
        memberId: String(
          data.monthlyReportForm?.memberId
            || selectedMember?.id
            || currentMember?.id
            || "",
        ),
        month: String(
          data.monthlyReportForm?.month || getCurrentMonthKeyInSaoPaulo(),
        ),
      },
      canGenerateMonthlyReportForAny: Boolean(req.currentUser?.is_admin),
      goalsSummary: {
        total: goalsSummary.total,
        completed: goalsSummary.completed,
        overdue: goalsSummary.overdue,
        pending: goalsSummary.pending,
        totalProjects: goalsSummary.projectIds.size,
        totalWeeks: goalsSummary.weekStarts.size,
      },
      currentReportsQuery: buildReportsQuery({
        memberId: selectedMember?.id || null,
        projectId: selectedProjectId || null,
      }),
    });
  }

  // DETALHE: Renderiza dashboard do almoxarifado com estado atual de abas e formularios.

  function renderAlmox(res, data = {}) {
    const activeTab = normalizeAlmoxTab(data.activeTab);

    return render(res, "almoxarifado/index.html", {
      title: "Almoxarifado",
      activeSection: "almox",
      activeTab,
      dashboard: database.getInventoryDashboardData(),
      users: database.listUsers(),
      members: database.listActiveMembers(),
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
        memberId: "",
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

  // DETALHE: Normaliza payload de inventario vindo de forms web ou API JSON.

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

  // DETALHE: Valida campos obrigatorios e limites antes de criar/editar item de inventario.

  function validateInventoryPayload(payload) {
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

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

  // DETALHE: Valida nome de catalogos auxiliares (categoria/local) com regras comuns.

  function validateCatalogName(name, entityLabel = "nome") {
    const normalized = String(name || "").trim();
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

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

    // SECAO: rotas de autenticacao (login/logout).

// DETALHE: Rota GET /login: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

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
      return res.status(403).json({
        success: false,
        error: "CSRF token inválido ou expirado.",
        csrfToken: nextToken,
      });
    }

    try {
      const result = registerPresenceInWorkbook(req.body.cracha, req.body.evento);
      return res.json(result);
    } catch (error) {
      console.error("Erro ao registrar presença:", error);
      return res.status(500).json({
        success: false,
        error: "Erro interno ao registrar presença.",
      });
    }
  });

    // SECAO: rotas de relatorios semanais (criacao, edicao e exclusao).

// DETALHE: Rota GET /relatorios: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/relatorios", requireAuth, (req, res) => {
    return renderReportPage(req, res);
  });

  app.get("/relatorios/monthly/pdf", requireAuth, async (req, res) => {
    const requestedMemberId = parseId(req.query.member_id);
    const currentMember = getCurrentMember(req);
    const targetMemberId = requestedMemberId || currentMember?.id || null;
    const targetMember = targetMemberId ? database.getMemberById(targetMemberId) : null;
    const monthKey = normalizeMonthKey(req.query.month) || getCurrentMonthKeyInSaoPaulo();

    if (!targetMember) {
      req.flash("warning", "Selecione um membro válido para gerar o relatório mensal.");
      return res.redirect("/relatorios");
    }

    const canGenerate =
      Boolean(req.currentUser?.is_admin)
      || (currentMember?.is_active && currentMember.id === targetMember.id);
    if (!canGenerate) {
      req.flash("warning", "Você não tem permissão para gerar esse relatório mensal.");
      return res.redirect(
        `/relatorios${buildReportsQuery({
          memberId: targetMember.id,
        })}`,
      );
    }

    try {
      const goals = database.listReportMonthGoalsForMember(targetMember.id, {
        monthKey,
        limit: 2500,
      });
      const pdf = await generateMonthlyReportPdf({
        member: targetMember,
        monthKey,
        goals,
        generatedByName: req.currentUser?.name || req.currentUser?.username || null,
      });

      const safeMemberName = String(targetMember.name || "membro")
        .replace(/[^\p{L}\p{N}._-]+/gu, "_")
        .replace(/^_+|_+$/g, "");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Relatorio_Mensal_${safeMemberName || "membro"}_${monthKey}.pdf"`,
      );
      return res.send(pdf);
    } catch (error) {
      console.error("Erro ao gerar PDF mensal de relatório:", error);
      req.flash("danger", `Erro ao gerar relatório mensal: ${error.message}`);
      return res.redirect(
        `/relatorios${buildReportsQuery({
          memberId: targetMember.id,
        })}#report-goals-panel`,
      );
    }
  });

  // DETALHE: Rota POST /relatorios/create: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/relatorios/create", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    req.flash("info", "O registro semanal agora é feito em \"Metas da Semana\".");
    return res.redirect("/relatorios#report-goals-panel");
  });

  // DETALHE: Rota POST /relatorios/edit/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/relatorios/edit/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    req.flash("info", "A edição semanal agora é feita em \"Metas da Semana\".");
    return res.redirect("/relatorios#report-goals-panel");
  });

  // DETALHE: Rota POST /relatorios/delete/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/relatorios/delete/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    req.flash("info", "A remoção semanal agora é feita em \"Metas da Semana\".");
    return res.redirect("/relatorios#report-goals-panel");
  });

  // DETALHE: Rota POST /relatorios/goals/create: cria meta semanal para membro/projeto selecionados.

  app.post("/relatorios/goals/create", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const selectedMemberId = parseId(req.body.member_id);
    const projectId = parseId(req.body.project_id);
    const goalFormData = {
      projectId: String(req.body.project_id || "").trim(),
      activity: String(req.body.activity || "").trim(),
      description: String(req.body.description || "").trim(),
      isCompleted: Boolean(req.body.is_completed),
    };
    const goalFormErrors = {};

    const selectedMember = selectedMemberId
      ? database.getMemberById(selectedMemberId)
      : null;
    if (!selectedMember) {
      req.flash("warning", "Membro inválido para cadastrar meta da semana.");
      return res.redirect("/relatorios");
    }

    const project = projectId ? database.getProjectById(projectId) : null;
    if (!project) {
      goalFormErrors.projectId = ["Selecione um projeto válido."];
    } else if (!database.isProjectMember(project.id, selectedMember.id)) {
      goalFormErrors.projectId = ["Este membro não participa do projeto selecionado."];
    }

    if (!goalFormData.activity) {
      goalFormErrors.activity = ["Informe a atividade da meta semanal."];
    } else if (goalFormData.activity.length < 3 || goalFormData.activity.length > 180) {
      goalFormErrors.activity = ["A atividade deve ter entre 3 e 180 caracteres."];
    }

    if (goalFormData.description.length > 2000) {
      goalFormErrors.description = ["A descrição pode ter no máximo 2000 caracteres."];
    }

    if (!req.currentUser?.is_admin) {
      const currentMember = getCurrentMember(req);
      const isOwnGoal = Boolean(currentMember?.is_active && currentMember.id === selectedMember.id);
      const canCreateAsCoordinator = Boolean(
        currentMember?.is_active
        && project
        && database.isProjectCoordinator(project.id, currentMember.id),
      );

      if (!isOwnGoal && !canCreateAsCoordinator) {
        goalFormErrors.activity = [
          "Sem permissão: somente admin, o próprio membro ou coordenador do projeto podem adicionar metas aqui.",
        ];
      }
    }

    if (Object.keys(goalFormErrors).length > 0) {
      return renderReportPage(req, res, {
        selectedMemberId: selectedMember.id,
        selectedProjectId: project?.id || null,
        goalFormData,
        goalFormErrors,
      });
    }

    try {
      database.createReportWeekGoal({
        memberId: selectedMember.id,
        projectId: project.id,
        createdByUserId: req.currentUser.id,
        weekStart: getCurrentWeekStartDate(),
        activity: goalFormData.activity,
        description: goalFormData.description,
        isCompleted: goalFormData.isCompleted,
      });
      req.flash("success", "Meta da semana adicionada com sucesso.");
    } catch (error) {
      console.error("Erro ao criar meta semanal:", error);
      req.flash("danger", `Erro ao criar meta semanal: ${error.message}`);
      return renderReportPage(req, res, {
        selectedMemberId: selectedMember.id,
        selectedProjectId: project?.id || null,
        goalFormData,
        goalFormErrors,
      });
    }

    return res.redirect(
      `/relatorios${buildReportsQuery({
        memberId: selectedMember.id,
      })}#report-goals-panel`,
    );
  });

  // DETALHE: Rota POST /relatorios/goals/:id/update: atualiza atividade/descricao/status de uma meta semanal.

  app.post("/relatorios/goals/:id/update", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const goalId = parseId(req.params.id);
    const goal = goalId ? database.getReportWeekGoalById(goalId) : null;
    if (!goal) {
      req.flash("warning", "Meta semanal não encontrada.");
      return res.redirect("/relatorios");
    }

    if (!canManageReportGoal(req, {
      memberId: goal.member_id,
      projectId: goal.project_id,
    })) {
      req.flash("warning", "Sem permissão para editar esta meta semanal.");
      return res.redirect(
        `/relatorios${buildReportsQuery({
          memberId: goal.member_id,
        })}#report-goals-panel`,
      );
    }

    const activity = String(req.body.activity || "").trim();
    const description = String(req.body.description || "").trim();
    const isCompleted = Boolean(req.body.is_completed);
    const goalFormErrors = {};

    if (!activity) {
      goalFormErrors.activity = ["A atividade não pode ficar vazia."];
    } else if (activity.length < 3 || activity.length > 180) {
      goalFormErrors.activity = ["A atividade deve ter entre 3 e 180 caracteres."];
    }

    if (description.length > 2000) {
      goalFormErrors.description = ["A descrição pode ter no máximo 2000 caracteres."];
    }

    if (Object.keys(goalFormErrors).length > 0) {
      req.flash("warning", goalFormErrors.activity?.[0] || goalFormErrors.description?.[0]);
      return res.redirect(
        `/relatorios${buildReportsQuery({
          memberId: goal.member_id,
        })}#report-goals-panel`,
      );
    }

    try {
      database.updateReportWeekGoal(goal.id, {
        activity,
        description,
        isCompleted,
      });
      req.flash("success", "Meta semanal atualizada.");
    } catch (error) {
      console.error("Erro ao atualizar meta semanal:", error);
      req.flash("danger", `Erro ao atualizar meta semanal: ${error.message}`);
    }

    return res.redirect(
      `/relatorios${buildReportsQuery({
        memberId: goal.member_id,
      })}#report-goals-panel`,
    );
  });

  app.post("/relatorios/goals/:id/delete", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const goalId = parseId(req.params.id);
    const goal = goalId ? database.getReportWeekGoalById(goalId) : null;
    if (!goal) {
      req.flash("warning", "Meta semanal não encontrada.");
      return res.redirect("/relatorios");
    }

    if (!canDeleteCompletedGoalFromOthers(req, goal)) {
      req.flash(
        "warning",
        "Sem permissão para apagar metas concluídas deste membro neste projeto.",
      );
      return res.redirect(
        `/relatorios${buildReportsQuery({
          memberId: goal.member_id,
          projectId: goal.project_id,
        })}#report-goals-panel`,
      );
    }

    try {
      database.deleteReportWeekGoalWithAudit(goal.id, req.currentUser.id);
      req.flash("success", "Atividade concluída removida com sucesso.");
    } catch (error) {
      console.error("Erro ao apagar meta concluída:", error);
      req.flash("danger", `Erro ao apagar atividade concluída: ${error.message}`);
    }

    return res.redirect(
      `/relatorios${buildReportsQuery({
        memberId: goal.member_id,
        projectId: goal.project_id,
      })}#report-goals-panel`,
    );
  });

    // SECAO: rotas de membros (listagem e manutencao administrativa).

// DETALHE: Rota GET /members: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/members", requireAuth, (req, res) => {
    return render(res, "members/list.html", {
      title: "Membros Ativos",
      activeSection: "members",
      members: database.listActiveMembers(),
    });
  });

  // DETALHE: Rota GET /members/add: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/members/add", requireAuth, requireAdminPage, (req, res) => {
    return renderMemberForm(res, {
      title: "Adicionar Membro",
      actionLabel: "Adicionar",
      formData: {
        name: "",
        photoClear: false,
      },
      errors: {},
    });
  });

  // DETALHE: Rota POST /members/add: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/members/add", requireAuth, requireAdminPage, runMemberPhotoUpload, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const formData = {
      name: String(req.body.name || "").trim(),
      photoClear: Boolean(req.body["photo-clear"]),
    };
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const errors = {};

    if (!formData.name) {
      errors.name = ["Nome é obrigatório."];
    } else if (formData.name.length < 2 || formData.name.length > 100) {
      errors.name = ["Nome deve ter entre 2 e 100 caracteres."];
    }
    if (req.uploadError) {
      errors.photo = [req.uploadError];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(errors).length > 0) {
      if (req.file?.filename) {
        safeUnlink(path.join(config.uploadDir, req.file.filename));
      }
      return renderMemberForm(res, {
        title: "Adicionar Membro",
        actionLabel: "Adicionar",
        formData,
        errors,
      });
    }

    let storedPhoto = null;
    try {
      storedPhoto = await persistUploadedImage(req, { folder: "pet-c3/members" });
      const member = database.createMember(formData.name, storedPhoto || null);
      req.flash("success", `Membro "${member.name}" adicionado com sucesso!`);
      return res.redirect(urlFor("list_members"));
    } catch (error) {
      if (storedPhoto) {
        await deleteStoredImage(storedPhoto);
      } else if (req.file?.path) {
        safeUnlink(req.file.path);
      }
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

  // DETALHE: Rota GET /members/edit/:id: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

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
        photoClear: false,
      },
      errors: {},
      member,
    });
  });

  // DETALHE: Rota POST /members/edit/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/members/edit/:id", requireAuth, requireAdminPage, runMemberPhotoUpload, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

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
      photoClear: Boolean(req.body["photo-clear"]),
    };
    // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

    const errors = {};

    if (!formData.name) {
      errors.name = ["Nome é obrigatório."];
    } else if (formData.name.length < 2 || formData.name.length > 100) {
      errors.name = ["Nome deve ter entre 2 e 100 caracteres."];
    }
    if (req.uploadError) {
      errors.photo = [req.uploadError];
    }

    // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

    if (Object.keys(errors).length > 0) {
      if (req.file?.filename) {
        safeUnlink(path.join(config.uploadDir, req.file.filename));
      }
      return renderMemberForm(res, {
        title: `Editar Membro: ${member.name} ${member.is_active ? "(Ativo)" : "(Inativo)"}`,
        actionLabel: "Salvar Alterações",
        formData,
        errors,
        member,
      });
    }

    let uploadedPhoto = null;
    try {
      if (req.file) {
        uploadedPhoto = await persistUploadedImage(req, { folder: "pet-c3/members" });
      }
      const nextPhoto = uploadedPhoto
        ? uploadedPhoto
        : (formData.photoClear ? null : member.photo || null);
      const previousPhotoToDelete =
        nextPhoto !== (member.photo || null) && member.photo
          ? member.photo
          : null;

      database.updateMember(memberId, {
        name: formData.name,
        photo: nextPhoto,
      });
      if (previousPhotoToDelete) {
        await deleteStoredImage(previousPhotoToDelete);
      }
      req.flash("success", `Membro "${formData.name}" atualizado com sucesso!`);
      return res.redirect(urlFor("list_members"));
    } catch (error) {
      if (uploadedPhoto && uploadedPhoto !== member.photo) {
        await deleteStoredImage(uploadedPhoto);
      } else if (req.file?.path) {
        safeUnlink(req.file.path);
      }
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

  // DETALHE: Rota POST /members/delete/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/members/delete/:id", requireAuth, requireAdminPage, (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

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

    // SECAO: rotas de projetos (cadastro, associacoes e logo).

// DETALHE: Rota GET /projects: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/projects", requireAuth, (req, res) => {
    const projects = listAccessibleProjects(req).map((project) => {
      const detailed = database.getProjectById(project.id);
      if (!detailed) {
        return null;
      }
      return {
        ...detailed,
        can_manage: canManageProject(req, detailed),
      };
    }).filter(Boolean);

    return render(res, "projects/list.html", {
      title: "Projetos",
      activeSection: "projects",
      projects,
    });
  });

  // DETALHE: Rota GET /projects/add: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/projects/add", requireAuth, requireAdminPage, (req, res) => {
    return renderProjectForm(res, {
      title: "Adicionar Projeto",
      actionLabel: "Adicionar",
      formData: {
        name: "",
        primaryColor: DEFAULT_PROJECT_COLOR,
        memberIds: [],
        coordinatorIds: [],
        logoClear: false,
      },
      errors: {},
      canManageProject: true,
    });
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/projects/add",
    requireAuth,
    requireAdminPage,
    runLogoUpload,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return;
      }

      const memberIds = parseIdArray(req.body.members);
      const coordinatorIds = parseIdArray(req.body.coordinators);
      const formData = {
        name: String(req.body.name || "").trim(),
        primaryColor: normalizeProjectColor(req.body.primary_color),
        memberIds,
        coordinatorIds,
        logoClear: false,
      };
      // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

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
      if (memberIds.length === 0) {
        errors.members = ["Selecione ao menos um membro para o projeto."];
      } else if (invalidMemberIds.length > 0) {
        errors.members = ["Há membros inválidos na seleção."];
      }

      const coordinatorOutsideProject = coordinatorIds.filter(
        (memberId) => !memberIds.includes(memberId),
      );
      if (coordinatorOutsideProject.length > 0) {
        errors.coordinators = ["Todo coordenador também precisa estar marcado como membro."];
      } else if (memberIds.length > 0 && coordinatorIds.length === 0) {
        errors.coordinators = ["Selecione ao menos um coordenador para o projeto."];
      }

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        return renderProjectForm(res, {
          title: "Adicionar Projeto",
          actionLabel: "Adicionar",
          formData,
          errors,
          canManageProject: true,
        });
      }

      let storedLogo = null;
      try {
        storedLogo = await persistUploadedImage(req, { folder: "pet-c3/projects" });
        const project = database.createProject({
          name: formData.name,
          logo: storedLogo || null,
          primaryColor: formData.primaryColor,
          memberIds,
          coordinatorIds,
        });
        req.flash("success", `Projeto "${project.name}" adicionado com sucesso!`);
        return res.redirect(urlFor("list_projects"));
      } catch (error) {
        if (storedLogo) {
          await deleteStoredImage(storedLogo);
        } else if (req.file) {
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
          canManageProject: true,
        });
      }
    },
  );

  // DETALHE: Rota GET /projects/edit/:id: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/projects/edit/:id", requireAuth, (req, res) => {
    const project = database.getProjectById(parseId(req.params.id));
    if (!project) {
      return notFound(res);
    }

    if (!canManageProject(req, project)) {
      req.flash(
        "warning",
        "Somente coordenadores deste projeto podem editar membros, coordenadores e dados do projeto.",
      );
      return res.redirect(urlFor("list_projects"));
    }

    return renderProjectForm(res, {
      title: "Editar Projeto",
      actionLabel: "Salvar Alterações",
      formData: {
        name: project.name,
        primaryColor: project.primary_color || DEFAULT_PROJECT_COLOR,
        memberIds: project.active_member_ids,
        coordinatorIds: project.coordinator_member_ids,
        logoClear: false,
      },
      errors: {},
      project,
      canManageProject: true,
    });
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/projects/edit/:id",
    requireAuth,
    runLogoUpload,
    async (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

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

      if (!canManageProject(req, project)) {
        if (req.file) {
          safeUnlink(req.file.path);
        }
        req.flash(
          "warning",
          "Somente coordenadores deste projeto podem editar membros, coordenadores e dados do projeto.",
        );
        return res.redirect(urlFor("list_projects"));
      }

      const memberIds = parseIdArray(req.body.members);
      const coordinatorIds = parseIdArray(req.body.coordinators);
      const formData = {
        name: String(req.body.name || "").trim(),
        primaryColor: normalizeProjectColor(req.body.primary_color, project.primary_color),
        memberIds,
        coordinatorIds,
        logoClear: Boolean(req.body["logo-clear"]),
      };
      // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

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
      if (memberIds.length === 0) {
        errors.members = ["Selecione ao menos um membro para o projeto."];
      } else if (invalidMemberIds.length > 0) {
        errors.members = ["Há membros inválidos na seleção."];
      }

      const coordinatorOutsideProject = coordinatorIds.filter(
        (memberId) => !memberIds.includes(memberId),
      );
      if (coordinatorOutsideProject.length > 0) {
        errors.coordinators = ["Todo coordenador também precisa estar marcado como membro."];
      } else if (memberIds.length > 0 && coordinatorIds.length === 0) {
        errors.coordinators = ["Selecione ao menos um coordenador para o projeto."];
      }

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

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
          canManageProject: true,
        });
      }

      let logo = project.logo;
      let uploadedIsNew = false;
      let uploadedLogo = null;

      try {
        if (req.file) {
          uploadedLogo = await persistUploadedImage(req, { folder: "pet-c3/projects" });
          logo = uploadedLogo;
          uploadedIsNew = logo !== project.logo;
        } else if (formData.logoClear) {
          logo = null;
        }

        const updated = database.updateProject(projectId, {
          name: formData.name,
          logo,
          primaryColor: formData.primaryColor,
          memberIds,
          coordinatorIds,
        });
        if (project.logo && logo !== project.logo) {
          await deleteStoredImage(project.logo);
        }
        req.flash("success", `Projeto "${updated.name}" atualizado com sucesso!`);
        return res.redirect(urlFor("list_projects"));
      } catch (error) {
        if (uploadedLogo && uploadedIsNew) {
          await deleteStoredImage(uploadedLogo);
        } else if (req.file) {
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
            primary_color: formData.primaryColor,
          },
          canManageProject: true,
        });
      }
    },
  );

  // DETALHE: Rota POST /projects/delete/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/projects/delete/:id", requireAuth, async (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const projectId = parseId(req.params.id);
    const project = database.getProjectById(projectId);
    if (!project) {
      return notFound(res);
    }

    if (!canManageProject(req, project)) {
      req.flash(
        "warning",
        "Somente coordenadores deste projeto podem remover o projeto.",
      );
      return res.redirect(urlFor("list_projects"));
    }

    try {
      database.deleteProject(projectId);
      if (project.logo) {
        await deleteStoredImage(project.logo);
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

    // SECAO: rotas de atas (criacao, download de PDF e exclusao).

// DETALHE: Rota GET /atas/create: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/atas/create", requireAuth, (req, res) => {
    const availableProjects = listAccessibleProjects(req);
    return renderAtaForm(req, res, {
      title: "Criar Nova Ata",
      formData: {
        projectId: "",
        meetingDatetime: defaultMeetingDateTimeInput(),
        notes: "",
        presentMemberIds: [],
        justifications: {},
      },
      errors: {},
      projects: availableProjects,
    });
  });

  // DETALHE: Rota GET /atas/create/for/:project_id: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/atas/create/for/:project_id", requireAuth, (req, res) => {
    const projectId = parseId(req.params.project_id);
    const project = database.getProjectById(projectId);
    if (!project) {
      return notFound(res);
    }

    if (!canCreateAtaForProject(req, project)) {
      req.flash(
        "warning",
        "Você só pode criar atas para projetos nos quais está vinculado como membro.",
      );
      return res.redirect(urlFor("create_ata"));
    }

    return renderAtaForm(req, res, {
      title: "Criar Nova Ata",
      formData: {
        projectId: String(projectId),
        meetingDatetime: defaultMeetingDateTimeInput(),
        notes: "",
        presentMemberIds: [],
        justifications: {},
      },
      errors: {},
      projects: listAccessibleProjects(req),
    });
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    ["/atas/create", "/atas/create/for/:project_id"],
    requireAuth,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

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

      // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

      const errors = {};
      const projectId = parseId(formData.projectId);
      const project = projectId ? database.getProjectById(projectId) : null;

      if (!project) {
        errors.project = ["É necessário selecionar um projeto válido."];
      } else if (!canCreateAtaForProject(req, project)) {
        errors.project = [
          "Você só pode criar atas para projetos nos quais está vinculado como membro.",
        ];
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

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

      if (Object.keys(errors).length > 0) {
        return renderAtaForm(req, res, {
          title: "Criar Nova Ata",
          formData,
          errors,
          projects: listAccessibleProjects(req),
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
        return renderAtaForm(req, res, {
          title: "Criar Nova Ata",
          formData,
          errors,
          projects: listAccessibleProjects(req),
        });
      }
    },
  );

  // DETALHE: Rota GET /atas/download/:id: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

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

  // DETALHE: Rota POST /atas/delete/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/atas/delete/:id", requireAuth, (req, res) => {
    // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const ataId = parseId(req.params.id);
    const ata = database.getAtaById(ataId);
    if (!ata) {
      return notFound(res);
    }

    if (!canManageProject(req, ata.project)) {
      req.flash(
        "warning",
        "Somente coordenadores do projeto podem excluir esta ata.",
      );
      return res.redirect(urlFor("home"));
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

    // SECAO: rotas do almoxarifado (painel, estoque, emprestimos e APIs internas).

// DETALHE: Rota GET /almoxarifado: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/almoxarifado", requireAuth, (req, res) => {
    return renderAlmox(res, {
      activeTab: req.query.tab,
    });
  });

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/users/create",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "users";
      const userFormData = {
        name: String(req.body.name || "").trim(),
        username: String(req.body.username || "").trim(),
        password: "",
        role: String(req.body.role || "common").trim().toLowerCase(),
        memberId: String(req.body.member_id || "").trim(),
      };
      const rawPassword = String(req.body.password || "");
      // DETALHE: Objeto para acumular erros de validacao e devolver feedback completo ao usuario.

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

      const memberId = parseId(userFormData.memberId);
      if (userFormData.memberId && !memberId) {
        userErrors.memberId = ["Selecione um membro válido."];
      } else if (memberId) {
        const member = database.getMemberById(memberId);
        if (!member || !member.is_active) {
          userErrors.memberId = ["Selecione um membro ativo válido."];
        }
      }

      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

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
          memberId: memberId || null,
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

  // DETALHE: Inicio de bloco de rota declarada em multiplas linhas; revisar path e middlewares logo abaixo.

  app.post(
    "/almoxarifado/users/link/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      // DETALHE: Interrompe o fluxo quando token CSRF esta invalido ou expirado.

      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "users";
      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "Usuário inválido para vinculação.");
        return res.redirect(almoxPath(activeTab));
      }

      const user = database.getUserById(userId);
      if (!user) {
        req.flash("warning", "Usuário não encontrado.");
        return res.redirect(almoxPath(activeTab));
      }

      const memberIdRaw = String(req.body.member_id || "").trim();
      const memberId = parseId(memberIdRaw);
      if (memberIdRaw && !memberId) {
        req.flash("warning", "Selecione um membro válido.");
        return res.redirect(almoxPath(activeTab));
      }

      if (memberId) {
        const member = database.getMemberById(memberId);
        if (!member || !member.is_active) {
          req.flash("warning", "Selecione um membro ativo válido.");
          return res.redirect(almoxPath(activeTab));
        }
      }

      try {
        const updatedUser = database.setUserMemberLink(userId, memberId || null);
        if (updatedUser?.member_name) {
          req.flash(
            "success",
            `Usuário @${updatedUser.username} vinculado ao membro ${updatedUser.member_name}.`,
          );
        } else {
          req.flash(
            "success",
            `Vínculo de membro removido do usuário @${user.username}.`,
          );
        }
      } catch (error) {
        console.error("Erro ao vincular usuário ao membro:", error);
        req.flash("danger", `Erro ao vincular usuário: ${error.message}`);
      }

      return res.redirect(almoxPath(activeTab));
    },
  );

  app.post(
    "/almoxarifado/users/reset-password/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "users";
      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "Usuário inválido para redefinição de senha.");
        return res.redirect(almoxPath(activeTab));
      }

      const user = database.getUserById(userId);
      if (!user) {
        req.flash("warning", "Usuário não encontrado.");
        return res.redirect(almoxPath(activeTab));
      }

      const rawPassword = String(req.body.new_password || "");
      if (!rawPassword || rawPassword.length < 6) {
        req.flash("warning", "A nova senha deve ter pelo menos 6 caracteres.");
        return res.redirect(almoxPath(activeTab));
      }

      try {
        const passwordHash = bcrypt.hashSync(rawPassword, 12);
        database.updateUserPassword(userId, passwordHash);
        req.flash("success", `Senha de @${user.username} redefinida com sucesso.`);
      } catch (error) {
        console.error("Erro ao redefinir senha de usuário:", error);
        req.flash("danger", `Erro ao redefinir senha: ${error.message}`);
      }

      return res.redirect(almoxPath(activeTab));
    },
  );

  app.post(
    "/almoxarifado/users/delete/:id",
    requireAuth,
    requireAdminPage,
    (req, res) => {
      if (!ensureValidCsrf(req, res)) {
        return;
      }

      const activeTab = "users";
      const userId = parseId(req.params.id);
      if (!userId) {
        req.flash("warning", "Usuário inválido para exclusão.");
        return res.redirect(almoxPath(activeTab));
      }

      if (req.currentUser?.id === userId) {
        req.flash("warning", "Você não pode excluir seu próprio usuário.");
        return res.redirect(almoxPath(activeTab));
      }

      try {
        const result = database.deleteUser(userId);
        if (!result?.deleted) {
          if (result?.reason === "not_found") {
            req.flash("warning", "Usuário não encontrado.");
          } else if (result?.reason === "has_history") {
            req.flash(
              "warning",
              "Não é possível excluir usuário com histórico de retiradas ou empréstimos.",
            );
          } else {
            req.flash("warning", "Não foi possível excluir o usuário.");
          }
          return res.redirect(almoxPath(activeTab));
        }

        req.flash("success", `Usuário @${result.user.username} excluído com sucesso.`);
      } catch (error) {
        console.error("Erro ao excluir usuário:", error);
        req.flash("danger", `Erro ao excluir usuário: ${error.message}`);
      }

      return res.redirect(almoxPath(activeTab));
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
      loanErrors.nameOrCode = ["Informe o nome exato ou o ID do patrimônio."];
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

  // DETALHE: Rota GET /almoxarifado/api/itens: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

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
        return res.status(400).json({ error: "Item inválido." });
      }

      const parsed = parseInventoryPayload(req.body);
      const { errors, normalized } = validateInventoryPayload(parsed);
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

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
        return res.status(400).json({ error: "Categoria inválida." });
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome da categoria",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

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
        return res.status(400).json({ error: "Local inválido." });
      }

      const { normalized, errors } = validateCatalogName(
        req.body.nome || req.body.name,
        "nome do local",
      );
      // DETALHE: Se houver erro de validacao, encerra cedo para evitar persistencia inconsistente.

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

    // SECAO: endpoints auxiliares para preencher formularios dinamicos no frontend.

// DETALHE: Rota GET /api/project/:project_id/members: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

app.get("/api/project/:project_id/members", requireAuth, (req, res) => {
    const projectId = parseId(req.params.project_id);
    const project = projectId ? database.getProjectById(projectId) : null;

    if (!project) {
      return res.status(404).json({ error: "Projeto não encontrado." });
    }

    if (!canCreateAtaForProject(req, project)) {
      return res.status(403).json({
        error: "Você não tem acesso aos membros deste projeto.",
      });
    }

    return res.json({
      members: project.active_members.map((member) => ({
        id: member.id,
        name: member.name,
      })),
    });
  });

    // SECAO: fallback de erro (404) e handler global de excecoes (500).

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
