/*
 * ARQUIVO: src/routes/auth.js
 * FUNCAO: registra rotas de autenticacao, navegacao inicial e presenca.
 * IMPACTO DE MUDANCAS:
 * - Alterar campos/validacao de login afeta sessao de todos os usuarios.
 * - Alterar retorno JSON de presenca impacta o frontend que consome a API.
 */

function buildPlannerQuery({
  view = "member",
  projectId = null,
  memberId = null,
  month = null,
  day = null,
} = {}) {
  const params = new URLSearchParams();
  params.set("view", view === "project" ? "project" : "member");
  if (projectId) {
    params.set("project_id", String(projectId));
  }
  if (memberId) {
    params.set("member_id", String(memberId));
  }
  if (month) {
    params.set("month", String(month));
  }
  if (day) {
    params.set("day", String(day));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function registerAuthRoutes(ctx) {
  const {
    app,
    config,
    bcrypt,
    database,
    urlFor,
    render,
    renderLogin,
    requireAuth,
    canManageProject,
    getCurrentMember,
    listAccessibleProjects,
    ensureValidCsrf,
    ensureCsrfToken,
    verifyCsrf,
    safeRedirectPath,
    parseId,
    toSqlDateTime,
    trimToNull,
    registerPresenceInWorkbook,
    logError,
    sendApiError,
  } = ctx;

  function canDeletePlannerTask(req, task) {
    if (!task) {
      return false;
    }

    if (req.currentUser?.is_admin) {
      return true;
    }

    const currentMember = getCurrentMember(req);
    if (!currentMember?.is_active) {
      return false;
    }

    if (Number(task.assigned_member_id) === Number(currentMember.id)) {
      return true;
    }

    return canManageProject(req, task.project);
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
    req.session.authExpiresAt = Date.now() + config.sessionIdleMaxAgeMs;
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
      authExpiresAt: null,
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

  // DETALHE: Rota GET /planner: consulta dados necessarios e monta resposta (HTML/JSON) para a tela solicitada.

  app.get("/planner", requireAuth, (req, res) => {
    const currentMember = getCurrentMember(req);
    const isAdmin = Boolean(req.currentUser?.is_admin);
    const requestedView = String(req.query.view || "").trim().toLowerCase();
    const viewMode = requestedView === "project" ? "project" : "member";
    const accessibleProjects = listAccessibleProjects(req);
    const accessibleProjectIds = new Set(accessibleProjects.map((project) => project.id));
    const requestedProjectId = parseId(req.query.project_id);
    const selectedProject = requestedProjectId && accessibleProjectIds.has(requestedProjectId)
      ? database.getProjectById(requestedProjectId)
      : (accessibleProjects[0] ? database.getProjectById(accessibleProjects[0].id) : null);
    const selectedProjectId = selectedProject?.id || null;

    let selectedMember = null;
    const requestedMemberId = parseId(req.query.member_id);
    if (isAdmin) {
      selectedMember = requestedMemberId
        ? database.getMemberById(requestedMemberId)
        : (currentMember || null);
      if (!selectedMember) {
        selectedMember = database.listActiveMembers()[0] || null;
      }
    } else {
      selectedMember = currentMember || null;
    }

    const selectedMemberId = selectedMember?.id || null;
    const memberOptions = isAdmin
      ? database.listActiveMembers()
      : (selectedMember ? [selectedMember] : []);
    const memberViewMode = viewMode === "member";
    const effectiveViewMode = memberViewMode ? "member" : "project";
    const baseTasks = effectiveViewMode === "project"
      ? (selectedProjectId ? database.listPlannerTasks({ projectId: selectedProjectId }) : [])
      : (selectedMemberId ? database.listPlannerTasks({ memberId: selectedMemberId }) : []);
    const visibleTasks = isAdmin
      ? baseTasks
      : baseTasks.filter((task) => accessibleProjectIds.has(task.project_id));

    const nowIso = toSqlDateTime(new Date());
    const plannerTasks = visibleTasks.map((task) => ({
      ...task,
      is_overdue: !task.is_completed && Boolean(task.due_at && nowIso && task.due_at < nowIso),
    }));
    const nowDate = new Date();
    const currentMonthKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
    }).format(nowDate);
    const requestedMonthKey = String(req.query.month || "").trim();
    const plannerMonth = /^\d{4}-\d{2}$/.test(requestedMonthKey)
      ? requestedMonthKey
      : currentMonthKey;
    const [yearText, monthText] = plannerMonth.split("-");
    const monthYear = Number(yearText);
    const monthIndex = Number(monthText) - 1;
    const monthStart = new Date(Date.UTC(monthYear, monthIndex, 1));
    const monthEnd = new Date(Date.UTC(monthYear, monthIndex + 1, 0));
    const firstWeekday = monthStart.getUTCDay(); // 0 = domingo
    const daysInMonth = monthEnd.getUTCDate();
    const prevMonthEnd = new Date(Date.UTC(monthYear, monthIndex, 0));
    const daysInPrevMonth = prevMonthEnd.getUTCDate();
    const tasksByDay = {};
    plannerTasks
      .slice()
      .sort((a, b) => String(a.due_at || "").localeCompare(String(b.due_at || "")))
      .forEach((task) => {
        const dayKey = String(task.due_at || "").slice(0, 10);
        if (!dayKey) {
          return;
        }
        if (!tasksByDay[dayKey]) {
          tasksByDay[dayKey] = [];
        }
        tasksByDay[dayKey].push(task);
      });
    const cells = [];
    const totalCells = 42;
    for (let i = 0; i < totalCells; i += 1) {
      const dayOffset = i - firstWeekday;
      let cellYear = monthYear;
      let cellMonth = monthIndex;
      let dayNumber = dayOffset + 1;
      let inCurrentMonth = true;
      if (dayOffset < 0) {
        inCurrentMonth = false;
        cellMonth = monthIndex - 1;
        if (cellMonth < 0) {
          cellMonth = 11;
          cellYear -= 1;
        }
        dayNumber = daysInPrevMonth + dayOffset + 1;
      } else if (dayOffset >= daysInMonth) {
        inCurrentMonth = false;
        cellMonth = monthIndex + 1;
        if (cellMonth > 11) {
          cellMonth = 0;
          cellYear += 1;
        }
        dayNumber = dayOffset - daysInMonth + 1;
      }
      const dateKey = `${String(cellYear).padStart(4, "0")}-${String(cellMonth + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
      const dayTasks = tasksByDay[dateKey] || [];
      cells.push({
        dateKey,
        dayNumber,
        inCurrentMonth,
        isToday: dateKey === nowIso.slice(0, 10),
        tasks: dayTasks.slice(0, 2),
        taskCount: dayTasks.length,
      });
    }
    const selectedDayQuery = String(req.query.day || "").trim();
    const defaultSelectedDay = (() => {
      const todayKey = nowIso.slice(0, 10);
      if (todayKey.startsWith(`${plannerMonth}-`)) {
        return todayKey;
      }
      const firstDayWithTasks = Object.keys(tasksByDay)
        .filter((day) => day.startsWith(`${plannerMonth}-`))
        .sort()[0];
      return firstDayWithTasks || `${plannerMonth}-01`;
    })();
    const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(selectedDayQuery)
      ? selectedDayQuery
      : defaultSelectedDay;
    const selectedDayTasks = (tasksByDay[selectedDay] || []).map((task) => ({
      ...task,
      can_delete: canDeletePlannerTask(req, task),
    }));
    const prevMonthDate = new Date(Date.UTC(monthYear, monthIndex - 1, 1));
    const nextMonthDate = new Date(Date.UTC(monthYear, monthIndex + 1, 1));
    const prevMonthKey = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const nextMonthKey = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const plannerMonthLabel = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      month: "long",
      year: "numeric",
    }).format(new Date(`${plannerMonth}-01T12:00:00Z`));

    const creatableProjects = accessibleProjects
      .map((project) => database.getProjectById(project.id))
      .filter((project) => canManageProject(req, project));
    const creatableProjectIds = new Set(creatableProjects.map((project) => project.id));

    const plannerFormState = req.session?.plannerFormState || null;
    if (req.session?.plannerFormState) {
      req.session.plannerFormState = null;
    }
    const formData = {
      projectId: String(req.query.create_project_id || ""),
      memberId: "",
      title: "",
      description: "",
      dueAt: "",
      ...(plannerFormState?.formData || {}),
    };
    if (!formData.memberId && effectiveViewMode === "member" && selectedMemberId) {
      formData.memberId = String(selectedMemberId);
    }

    const preferredProjectForMember = effectiveViewMode === "member" && selectedMemberId
      ? (creatableProjects.find((project) => (
        project.active_members || []
      ).some((member) => member.id === selectedMemberId)) || null)
      : null;
    const requestedCreateProjectId = parseId(formData.projectId)
      || selectedProjectId
      || preferredProjectForMember?.id
      || null;
    const selectedCreateProject = requestedCreateProjectId && creatableProjectIds.has(requestedCreateProjectId)
      ? creatableProjects.find((project) => project.id === requestedCreateProjectId) || null
      : (creatableProjects[0] || null);
    const selectedCreateProjectId = selectedCreateProject?.id || null;
    const createMemberOptions = selectedCreateProject?.active_members || [];
    const createMemberIds = new Set(createMemberOptions.map((member) => member.id));
    if (!formData.projectId && selectedCreateProjectId) {
      formData.projectId = String(selectedCreateProjectId);
    }
    if (formData.memberId) {
      const parsedFormMemberId = parseId(formData.memberId);
      if (!parsedFormMemberId || !createMemberIds.has(parsedFormMemberId)) {
        formData.memberId = "";
      }
    }

    return render(res, "planner/index.html", {
      title: "Planner",
      activeSection: "planner",
      plannerViewMode: effectiveViewMode,
      selectedProject,
      selectedMember,
      plannerTasks,
      plannerMonth,
      plannerMonthLabel,
      currentMonthKey,
      todayDateKey: nowIso.slice(0, 10),
      prevMonthKey,
      nextMonthKey,
      calendarWeekdays: ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"],
      calendarCells: cells,
      selectedDay,
      selectedDayTasks,
      projectOptions: accessibleProjects,
      memberOptions,
      canCreatePlannerTask: creatableProjects.length > 0,
      createProjectOptions: creatableProjects,
      createMemberOptions,
      plannerFormData: formData,
      plannerFormErrors: plannerFormState?.errors || {},
      plannerPanelTheme: effectiveViewMode === "project"
        ? "project"
        : "member",
      plannerPanelColor: selectedProject?.primary_color || "#0f766e",
      plannerQuery: buildPlannerQuery({
        view: effectiveViewMode,
        projectId: selectedProjectId,
        memberId: selectedMemberId,
        month: plannerMonth,
        day: selectedDay,
      }),
    });
  });

  // DETALHE: Rota POST /planner/tasks/create: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/planner/tasks/create", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const currentMember = getCurrentMember(req);
    const fallbackQuery = buildPlannerQuery({
      view: req.body.view_mode,
      projectId: parseId(req.body.return_project_id),
      memberId: parseId(req.body.return_member_id) || currentMember?.id || null,
      month: String(req.body.return_month || ""),
      day: String(req.body.return_day || ""),
    });
    const formData = {
      projectId: String(req.body.project_id || ""),
      memberId: String(req.body.member_id || ""),
      title: String(req.body.title || "").trim(),
      description: String(req.body.description || "").trim(),
      dueAt: String(req.body.due_at || "").trim(),
    };
    const errors = {};
    const projectId = parseId(formData.projectId);
    const memberId = parseId(formData.memberId);
    const project = projectId ? database.getProjectById(projectId) : null;

    if (!project) {
      errors.projectId = ["Selecione um projeto válido."];
    } else if (!canManageProject(req, project)) {
      errors.projectId = ["Somente administradores ou coordenadores do projeto podem criar tarefas."];
    }

    if (!memberId) {
      errors.memberId = ["Selecione o membro da tarefa."];
    } else if (project && !database.isProjectMember(project.id, memberId)) {
      errors.memberId = ["O membro selecionado não pertence ao projeto escolhido."];
    }

    const title = trimToNull(formData.title);
    if (!title) {
      errors.title = ["Título da tarefa é obrigatório."];
    } else if (title.length > 180) {
      errors.title = ["Título da tarefa deve ter no máximo 180 caracteres."];
    }

    const dueAt = toSqlDateTime(formData.dueAt);
    if (!dueAt) {
      errors.dueAt = ["Informe data e horário válidos para a tarefa."];
    }

    const description = trimToNull(formData.description) || "";

    if (Object.keys(errors).length > 0) {
      req.session.plannerFormState = {
        formData,
        errors,
      };
      req.flash("danger", "Não foi possível criar a tarefa do Planner. Revise os campos.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    try {
      database.createPlannerTask({
        projectId: project.id,
        assignedMemberId: memberId,
        createdByUserId: req.currentUser.id,
        title,
        description,
        dueAt,
      });
      req.flash("success", "Tarefa do Planner criada com sucesso.");
      return res.redirect(
        `${urlFor("planner")}${buildPlannerQuery({
          view: "project",
          projectId: project.id,
          memberId,
          month: String(req.body.return_month || ""),
          day: String(req.body.return_day || ""),
        })}`,
      );
    } catch (error) {
      logError(req, "Erro ao criar tarefa do Planner:", error);
      req.flash("danger", `Erro ao criar tarefa do Planner: ${error.message}`);
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }
  });

  // DETALHE: Rota POST /planner/tasks/:id/delete: remove tarefa quando usuario tem permissao no projeto.

  app.post("/planner/tasks/:id/delete", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const taskId = parseId(req.params.id);
    const fallbackQuery = buildPlannerQuery({
      view: String(req.body.view_mode || ""),
      projectId: parseId(req.body.return_project_id),
      memberId: parseId(req.body.return_member_id),
      month: String(req.body.return_month || ""),
      day: String(req.body.return_day || ""),
    });

    if (!taskId) {
      req.flash("danger", "Tarefa inválida para exclusão.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    const task = database.getPlannerTaskById(taskId);
    if (!task) {
      req.flash("danger", "Tarefa do Planner não encontrada.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    if (!canDeletePlannerTask(req, task)) {
      req.flash("danger", "Você não tem permissão para excluir esta tarefa.");
      return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
    }

    try {
      database.deletePlannerTask(task.id);
      req.flash("success", "Tarefa do Planner excluída com sucesso.");
    } catch (error) {
      logError(req, "Erro ao excluir tarefa do Planner:", error);
      req.flash("danger", `Erro ao excluir tarefa do Planner: ${error.message}`);
    }

    return res.redirect(`${urlFor("planner")}${fallbackQuery}`);
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
