/*
 * ARQUIVO: src/routes/reports.js
 * FUNCAO: registra rotas de relatorios quinzenais e exportacao mensal em PDF.
 * IMPACTO DE MUDANCAS:
 * - Alterar regras de permissao afeta quem pode criar/editar/apagar metas.
 * - Alterar validacao de metas impacta consistencia dos dados exibidos no quadro.
 */
function registerReportRoutes(ctx) {
  const {
    app,
    requireAuth,
    parseId,
    database,
    normalizeMonthKey,
    getCurrentMonthKeyInSaoPaulo,
    getCurrentWeekStartDate,
    generateMonthlyReportPdf,
    buildReportsQuery,
    getCurrentMember,
    renderReportPage,
    ensureValidCsrf,
    canManageReportGoal,
    canDeleteCompletedGoalFromOthers,
    canDeleteGoalFromExecution,
    canGenerateMonthlyReport,
    buildMonthlyPdfFilename,
    validateWeekGoalForm,
    toSqlDateTime,
    logError,
    notificationService,
  } = ctx;

  function parseQueueMemberIds(rawValue) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const seen = new Set();
    const queue = [];
    values.forEach((value) => {
      const parsed = parseId(value);
      if (!parsed || seen.has(parsed)) {
        return;
      }
      seen.add(parsed);
      queue.push(parsed);
    });
    return queue;
  }

  function normalizePlannerRecurrenceUnit(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "weeks" || raw === "months") {
      return raw;
    }
    return "days";
  }

  function normalizeDueAtInput(value) {
    return toSqlDateTime(String(value || "").trim());
  }

  function normalizeWeekStartInput(value, fallbackWeekStart) {
    const raw = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return raw;
    }
    return fallbackWeekStart;
  }

  function wantsJsonResponse(req) {
    const requestedWith = String(req.get("x-requested-with") || "").toLowerCase();
    const acceptHeader = String(req.get("accept") || "").toLowerCase();
    return requestedWith === "xmlhttprequest" || acceptHeader.includes("application/json");
  }

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
      req.flash("warning", "Selecione um membro vÃ¡lido para gerar o relatÃ³rio mensal.");
      return res.redirect("/relatorios");
    }

    const canGenerate = canGenerateMonthlyReport(req, currentMember, targetMember);
    if (!canGenerate) {
      req.flash("warning", "VocÃª nÃ£o tem permissÃ£o para gerar esse relatÃ³rio mensal.");
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

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${buildMonthlyPdfFilename(targetMember.name, monthKey)}"`,
      );
      return res.send(pdf);
    } catch (error) {
      logError(req, "Erro ao gerar PDF mensal de relatÃ³rio:", error);
      req.flash("danger", `Erro ao gerar relatÃ³rio mensal: ${error.message}`);
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
    req.flash("info", "O registro quinzenal agora Ã© feito em \"Metas da Quinzena\".");
    return res.redirect("/relatorios#report-goals-panel");
  });

  // DETALHE: Rota POST /relatorios/edit/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/relatorios/edit/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    req.flash("info", "A ediÃ§Ã£o quinzenal agora Ã© feita em \"Metas da Quinzena\".");
    return res.redirect("/relatorios#report-goals-panel");
  });

  // DETALHE: Rota POST /relatorios/delete/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/relatorios/delete/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    req.flash("info", "A remoÃ§Ã£o quinzenal agora Ã© feita em \"Metas da Quinzena\".");
    return res.redirect("/relatorios#report-goals-panel");
  });

  // DETALHE: Rota POST /relatorios/goals/create: cria meta quinzenal para membro/projeto selecionados.

  app.post("/relatorios/goals/create", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    const wantsJson = wantsJsonResponse(req);

    const selectedMemberId = parseId(req.body.member_id);
    const projectId = parseId(req.body.project_id);
    const goalFormData = {
      projectId: String(req.body.project_id || "").trim(),
      memberId: String(req.body.member_id || "").trim(),
      activity: String(req.body.activity || "").trim(),
      description: String(req.body.description || "").trim(),
      dueAt: String(req.body.due_at || "").trim(),
      isCompleted: Boolean(req.body.is_completed),
      recurrenceEnabled: String(req.body.recurrence_enabled || "") === "1",
      recurrenceIntervalDays: String(req.body.recurrence_interval_days || "7").trim(),
      recurrenceUnit: normalizePlannerRecurrenceUnit(req.body.recurrence_unit),
      recurrenceMemberIds: parseQueueMemberIds(req.body.recurrence_member_ids).map((id) => String(id)),
    };
    const goalFormErrors = {};

    const selectedMember = selectedMemberId
      ? database.getMemberById(selectedMemberId)
      : null;
    if (!selectedMember) {
      if (wantsJson) {
        return res.status(400).json({
          ok: false,
          message: "Membro invÃ¡lido para cadastrar tarefa.",
        });
      }
      req.flash("warning", "Membro invÃ¡lido para cadastrar meta da quinzena.");
      return res.redirect("/relatorios");
    }

    const project = projectId ? database.getProjectById(projectId) : null;
    if (!project) {
      goalFormErrors.projectId = ["Selecione um projeto vÃ¡lido."];
    } else if (!database.isProjectMember(project.id, selectedMember.id)) {
      goalFormErrors.projectId = ["Este membro nÃ£o participa do projeto selecionado."];
    }

    Object.assign(goalFormErrors, validateWeekGoalForm(goalFormData).errors);
    const dueAt = normalizeDueAtInput(goalFormData.dueAt);
    const nowSql = toSqlDateTime(new Date());
    const currentWeekStart = getCurrentWeekStartDate();
    if (!dueAt) {
      goalFormErrors.dueAt = ["Informe uma data de entrega vÃ¡lida."];
    } else {
      const dueDateKey = String(dueAt).slice(0, 10);
      if (dueDateKey < currentWeekStart) {
        goalFormErrors.dueAt = ["Use uma data dentro da quinzena atual."];
      }
    }

    const currentMember = getCurrentMember(req);
    const isOwnGoal = Boolean(currentMember?.is_active && currentMember.id === selectedMember.id);
    const canCreateAsCoordinator = Boolean(
      currentMember?.is_active
      && project
      && database.isProjectCoordinator(project.id, currentMember.id),
    );

    const recurrenceEnabled = Boolean(goalFormData.recurrenceEnabled);
    const recurrenceIntervalDays = Number(goalFormData.recurrenceIntervalDays);
    const recurrenceUnit = normalizePlannerRecurrenceUnit(goalFormData.recurrenceUnit);
    let recurrenceQueue = [];
    if (project && recurrenceEnabled) {
      const projectMemberIds = new Set(
        (project.active_members || []).map((member) => Number(member.id)),
      );
      recurrenceQueue = parseQueueMemberIds(goalFormData.recurrenceMemberIds)
        .filter((id) => projectMemberIds.has(id));
      if (!req.currentUser?.is_admin && !canCreateAsCoordinator) {
        recurrenceQueue = selectedMember?.id ? [selectedMember.id] : [];
      }
      if (!recurrenceQueue.length && selectedMember?.id && projectMemberIds.has(selectedMember.id)) {
        recurrenceQueue = [selectedMember.id];
      }
      if (!recurrenceQueue.length) {
        goalFormErrors.memberId = ["Selecione pelo menos um membro da fila de recorrÃªncia."];
      }
      if (!Number.isInteger(recurrenceIntervalDays) || recurrenceIntervalDays < 1 || recurrenceIntervalDays > 60) {
        goalFormErrors.recurrenceIntervalDays = ["Intervalo de recorrÃªncia deve ser entre 1 e 60 dias."];
      }
    }

    if (!req.currentUser?.is_admin) {
      if (!isOwnGoal && !canCreateAsCoordinator) {
        goalFormErrors.memberId = [
          "Sem permissÃ£o: somente admin, o prÃ³prio membro ou coordenador do projeto podem adicionar metas aqui.",
        ];
      }
    }

    if (Object.keys(goalFormErrors).length > 0) {
      if (wantsJson) {
        return res.status(422).json({
          ok: false,
          message: "Revise os campos obrigatÃ³rios.",
          errors: goalFormErrors,
        });
      }
      return renderReportPage(req, res, {
        selectedMemberId: selectedMember.id,
        selectedProjectId: project?.id || null,
        goalFormData,
        goalFormErrors,
      });
    }

    let createdTask = null;
    try {
      const initialStatus = dueAt && nowSql && dueAt <= nowSql
        ? "in_progress"
        : "todo";
      const assignedMemberId = recurrenceEnabled && recurrenceQueue.length
        ? recurrenceQueue[0]
        : selectedMember.id;
      const recurrenceNextIndex = recurrenceEnabled && recurrenceQueue.length > 1
        ? 1
        : 0;
      createdTask = database.createPlannerTask({
        projectId: project.id,
        assignedMemberId,
        createdByUserId: req.currentUser.id,
        title: goalFormData.activity,
        description: goalFormData.description,
        dueAt,
        status: goalFormData.isCompleted ? "done" : initialStatus,
        workflowState: "active",
        priority: "medium",
        recurrenceIntervalDays: recurrenceEnabled ? recurrenceIntervalDays : null,
        recurrenceUnit: recurrenceEnabled ? recurrenceUnit : null,
        recurrenceEvery: recurrenceEnabled ? recurrenceIntervalDays : null,
        recurrenceMemberQueue: recurrenceEnabled ? recurrenceQueue : null,
        recurrenceNextIndex: recurrenceEnabled ? recurrenceNextIndex : null,
      });
      let syncedTask = createdTask;
      if (goalFormData.isCompleted && createdTask?.id) {
        const completedAt = toSqlDateTime(new Date());
        syncedTask = database.updatePlannerTaskCompletion({
          id: createdTask.id,
          isCompleted: true,
          completedAt,
          updatedAt: completedAt,
          actorUserId: req.currentUser.id,
        }) || createdTask;
      }
      database.syncReportWeekGoalFromPlannerTask(syncedTask, {
        createdByUserId: req.currentUser.id,
      });
      if (!wantsJson) {
        req.flash("success", "Tarefa adicionada com sucesso.");
      }
    } catch (error) {
      logError(req, "Erro ao criar meta quinzenal:", error);
      if (wantsJson) {
        return res.status(500).json({
          ok: false,
          message: "Erro ao criar tarefa. Tente novamente.",
        });
      }
      req.flash("danger", `Erro ao criar meta quinzenal: ${error.message}`);
      return renderReportPage(req, res, {
        selectedMemberId: selectedMember.id,
        selectedProjectId: project?.id || null,
        goalFormData,
        goalFormErrors,
      });
    }

    const redirectUrl = `/relatorios${buildReportsQuery({
      memberId: selectedMember.id,
    })}#report-goals-panel`;
    if (wantsJson) {
      return res.json({
        ok: true,
        message: "Tarefa criada.",
        goalId: createdTask?.id || null,
        redirectUrl,
      });
    }

    return res.redirect(
      redirectUrl,
    );
  });

  // DETALHE: Rota POST /relatorios/goals/:id/update: atualiza atividade/descricao/status de uma meta quinzenal.

  app.post("/relatorios/goals/:id/update", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const goalId = parseId(req.params.id);
    const goal = goalId ? database.getReportWeekGoalById(goalId) : null;
    const returnProjectId = parseId(req.body.return_project_id);
    const wantsJson = wantsJsonResponse(req);

    function buildReturnUrl() {
      return `/relatorios${buildReportsQuery({
        memberId: goal?.member_id || null,
        projectId: returnProjectId || null,
      })}#report-goals-panel`;
    }

    function sendGoalUpdateError(status, message) {
      if (wantsJson) {
        return res.status(status).json({ ok: false, message });
      }
      req.flash("warning", message);
      return res.redirect(goal ? buildReturnUrl() : "/relatorios");
    }

    if (!goal) {
      return sendGoalUpdateError(404, "Meta quinzenal nÃ£o encontrada.");
    }

    if (!canManageReportGoal(req, {
      memberId: goal.member_id,
      projectId: goal.project_id,
    })) {
      return sendGoalUpdateError(403, "Sem permissÃ£o para editar esta meta quinzenal.");
    }

    const activity = String(req.body.activity || "").trim();
    const description = String(req.body.description || "").trim();
    const dueAtInput = String(req.body.due_at || "").trim();
    const dueAt = normalizeDueAtInput(dueAtInput);
    const isCompleted = Boolean(req.body.is_completed);
    const goalAction = String(req.body.goal_action || "save").trim().toLowerCase();
    const extensionReason = String(req.body.extension_reason || "").trim();
    const goalFormErrors = {};
    const nowSql = toSqlDateTime(new Date());

    if (goalAction === "save") {
      const validatedGoal = validateWeekGoalForm({ activity, description, dueAt: dueAtInput });
      if (validatedGoal.errors.activity) {
        goalFormErrors.activity = validatedGoal.errors.activity;
      }
      if (validatedGoal.errors.description) {
        goalFormErrors.description = validatedGoal.errors.description;
      }
      if (validatedGoal.errors.dueAt) {
        goalFormErrors.dueAt = validatedGoal.errors.dueAt;
      }
    } else if (goalAction === "extend_deadline") {
      if (!dueAt) {
        goalFormErrors.dueAt = ["Informe a nova data de entrega para estender o prazo."];
      } else if (nowSql && dueAt <= nowSql) {
        goalFormErrors.dueAt = ["A nova data de entrega deve ser futura."];
      }
    }

    if (Object.keys(goalFormErrors).length > 0) {
      const firstError = goalFormErrors.activity?.[0]
        || goalFormErrors.description?.[0]
        || goalFormErrors.dueAt?.[0]
        || "NÃ£o foi possÃ­vel salvar a meta.";
      if (wantsJson) {
        return res.status(422).json({
          ok: false,
          message: firstError,
          errors: goalFormErrors,
        });
      }
      req.flash("warning", firstError);
      return res.redirect(buildReturnUrl());
    }

    try {
      let linkedTask = goal.planner_task_id
        ? database.getPlannerTaskById(goal.planner_task_id)
        : null;

      if (!linkedTask) {
        const createdTask = database.createPlannerTask({
          projectId: goal.project_id,
          assignedMemberId: goal.member_id,
          createdByUserId: req.currentUser.id,
          title: activity || goal.activity,
          description: description || goal.description,
          dueAt: dueAt || goal.due_at || toSqlDateTime(new Date()),
          status: isCompleted ? "done" : "todo",
          workflowState: goal.task_state === "missed" ? "missed" : "active",
          priority: "medium",
        });
        database.attachPlannerTaskToReportWeekGoal(goal.id, createdTask.id);
        database.syncReportWeekGoalFromPlannerTask(createdTask, {
          createdByUserId: req.currentUser.id,
        });
        linkedTask = createdTask;
      }

      if (!linkedTask) {
        throw new Error("Falha ao localizar tarefa vinculada no Planner.");
      }

      if (linkedTask.workflow_state === "missed" && goalAction === "save") {
        return sendGoalUpdateError(
          409,
          "Tarefa em histÃ³rico de nÃ£o feitas. Use 'Feito com atraso' ou 'Estender prazo'.",
        );
      }

      let updatedTask = null;
      if (goalAction === "done_late") {
        updatedTask = database.markPlannerTaskDoneLate({
          id: linkedTask.id,
          actorUserId: req.currentUser.id,
        });
      } else if (goalAction === "extend_deadline") {
        updatedTask = database.extendPlannerTaskDeadline({
          id: linkedTask.id,
          dueAt,
          actorUserId: req.currentUser.id,
          reason: extensionReason || null,
        });
      } else {
        const nextStatus = isCompleted
          ? "done"
          : (dueAt && nowSql && dueAt <= nowSql ? "in_progress" : "todo");
        updatedTask = database.updatePlannerTaskDetails({
          id: linkedTask.id,
          projectId: goal.project_id,
          assignedMemberId: goal.member_id,
          title: activity,
          description,
          dueAt: dueAt || linkedTask.due_at,
          status: nextStatus,
          actorUserId: req.currentUser.id,
        });
      }

      if (updatedTask) {
        database.syncReportWeekGoalFromPlannerTask(updatedTask, {
          createdByUserId: req.currentUser.id,
        });
      }

      if (wantsJson) {
        return res.json({
          ok: true,
          message: "Meta quinzenal atualizada.",
          goalId: goal.id,
        });
      }

      req.flash("success", "Meta quinzenal atualizada.");
    } catch (error) {
      logError(req, "Erro ao atualizar meta quinzenal:", error);
      if (wantsJson) {
        return res.status(500).json({
          ok: false,
          message: `Erro ao atualizar meta quinzenal: ${error.message}`,
        });
      }
      req.flash("danger", `Erro ao atualizar meta quinzenal: ${error.message}`);
    }

    return res.redirect(buildReturnUrl());
  });

  app.post("/relatorios/goals/:id/delete", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }

    const goalId = parseId(req.params.id);
    const goal = goalId ? database.getReportWeekGoalById(goalId) : null;
    const returnProjectId = parseId(req.body.return_project_id);
    if (!goal) {
      req.flash("warning", "Meta quinzenal nÃ£o encontrada.");
      return res.redirect("/relatorios");
    }

    const canDeleteFromCompleted = canDeleteCompletedGoalFromOthers(req, goal);
    const canDeleteFromExecution = canDeleteGoalFromExecution(req, goal);

    if (!canDeleteFromCompleted && !canDeleteFromExecution) {
      req.flash(
        "warning",
        "Sem permissÃ£o para apagar esta meta neste projeto.",
      );
      return res.redirect(
        `/relatorios${buildReportsQuery({
          memberId: goal.member_id,
          projectId: returnProjectId || goal.project_id,
        })}#report-goals-panel`,
      );
    }

    try {
      if (goal.planner_task_id) {
        const linkedTask = database.getPlannerTaskById(goal.planner_task_id);
        if (linkedTask) {
          database.deletePlannerTask(linkedTask.id, {
            actorUserId: req.currentUser.id,
            reportGoalId: goal.id,
          });
        }
      }
      database.deleteReportWeekGoalWithAudit(goal.id, req.currentUser.id);
      req.flash("success", "Atividade removida com sucesso.");
    } catch (error) {
      logError(req, "Erro ao apagar meta concluÃ­da:", error);
      req.flash("danger", `Erro ao apagar atividade concluÃ­da: ${error.message}`);
    }

    return res.redirect(
      `/relatorios${buildReportsQuery({
        memberId: goal.member_id,
        projectId: returnProjectId || goal.project_id,
      })}#report-goals-panel`,
    );
  });

  app.post("/relatorios/writing/geral/create", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    if (!req.currentUser?.is_admin) {
      req.flash("warning", "Sem permissÃ£o para criar registro geral.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const content = String(req.body.content || "").trim();
    if (!content) {
      req.flash("warning", "ConteÃºdo Ã© obrigatÃ³rio para registro geral.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    try {
      const generatedTitle = `Registro ${new Date().toLocaleString("pt-BR")}`;
      database.createWritingGeneralEntry({
        title: generatedTitle,
        content,
        authorUserId: req.currentUser.id,
      });
      req.flash("success", "Registro geral criado com sucesso.");
    } catch (error) {
      logError(req, "Erro ao criar registro geral:", error);
      req.flash("danger", `Erro ao criar registro geral: ${error.message}`);
    }
    return res.redirect("/relatorios#report-writing-panel");
  });

  app.post("/relatorios/writing/geral/edit/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    if (!req.currentUser?.is_admin) {
      req.flash("warning", "Sem permissÃ£o para editar registro geral.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const entryId = parseId(req.params.id);
    const content = String(req.body.content || "").trim();
    if (!entryId || !content) {
      req.flash("warning", "Dados invÃ¡lidos para editar registro geral.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    try {
      const current = database.getWritingGeneralEntryById(entryId);
      const updated = database.updateWritingGeneralEntry(entryId, {
        title: current?.title || `Registro ${new Date().toLocaleString("pt-BR")}`,
        content,
      });
      if (!updated) {
        req.flash("warning", "Registro geral nÃ£o encontrado.");
      } else {
        req.flash("success", "Registro geral atualizado.");
      }
    } catch (error) {
      logError(req, "Erro ao editar registro geral:", error);
      req.flash("danger", `Erro ao editar registro geral: ${error.message}`);
    }
    return res.redirect("/relatorios#report-writing-panel");
  });

  app.post("/relatorios/writing/geral/delete/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    if (!req.currentUser?.is_admin) {
      req.flash("warning", "Sem permissÃ£o para excluir registro geral.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const entryId = parseId(req.params.id);
    if (!entryId) {
      req.flash("warning", "Registro geral invÃ¡lido.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    try {
      const deleted = database.deleteWritingGeneralEntry(entryId);
      if (!deleted) {
        req.flash("warning", "Registro geral nÃ£o encontrado.");
      } else {
        req.flash("success", "Registro geral removido.");
      }
    } catch (error) {
      logError(req, "Erro ao excluir registro geral:", error);
      req.flash("danger", `Erro ao excluir registro geral: ${error.message}`);
    }
    return res.redirect("/relatorios#report-writing-panel");
  });

  app.post("/relatorios/writing/tutor/create", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    if (req.currentUser?.role !== "tutor") {
      req.flash("warning", "Somente tutor pode criar anotaÃ§Ã£o privada.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const title = String(req.body.title || "").trim();
    const content = String(req.body.content || "").trim();
    if (!title || !content) {
      req.flash("warning", "TÃ­tulo e conteÃºdo sÃ£o obrigatÃ³rios para anotaÃ§Ã£o privada.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    try {
      database.createWritingTutorPrivateEntry({
        title,
        content,
        tutorUserId: req.currentUser.id,
      });
      req.flash("success", "AnotaÃ§Ã£o privada criada com sucesso.");
    } catch (error) {
      logError(req, "Erro ao criar anotaÃ§Ã£o privada:", error);
      req.flash("danger", `Erro ao criar anotaÃ§Ã£o privada: ${error.message}`);
    }
    return res.redirect("/relatorios#report-writing-panel");
  });

  app.post("/relatorios/writing/tutor/edit/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    if (req.currentUser?.role !== "tutor") {
      req.flash("warning", "Somente tutor pode editar anotaÃ§Ã£o privada.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const entryId = parseId(req.params.id);
    const title = String(req.body.title || "").trim();
    const content = String(req.body.content || "").trim();
    if (!entryId || !title || !content) {
      req.flash("warning", "Dados invÃ¡lidos para editar anotaÃ§Ã£o privada.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const existing = database.getWritingTutorPrivateEntryById(entryId);
    if (!existing || existing.tutor_user_id !== req.currentUser.id) {
      req.flash("warning", "AnotaÃ§Ã£o privada nÃ£o encontrada.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    try {
      database.updateWritingTutorPrivateEntry(entryId, { title, content });
      req.flash("success", "AnotaÃ§Ã£o privada atualizada.");
    } catch (error) {
      logError(req, "Erro ao editar anotaÃ§Ã£o privada:", error);
      req.flash("danger", `Erro ao editar anotaÃ§Ã£o privada: ${error.message}`);
    }
    return res.redirect("/relatorios#report-writing-panel");
  });

  app.post("/relatorios/writing/tutor/delete/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    if (req.currentUser?.role !== "tutor") {
      req.flash("warning", "Somente tutor pode excluir anotaÃ§Ã£o privada.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const entryId = parseId(req.params.id);
    if (!entryId) {
      req.flash("warning", "AnotaÃ§Ã£o privada invÃ¡lida.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const existing = database.getWritingTutorPrivateEntryById(entryId);
    if (!existing || existing.tutor_user_id !== req.currentUser.id) {
      req.flash("warning", "AnotaÃ§Ã£o privada nÃ£o encontrada.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    try {
      database.deleteWritingTutorPrivateEntry(entryId);
      req.flash("success", "AnotaÃ§Ã£o privada removida.");
    } catch (error) {
      logError(req, "Erro ao excluir anotaÃ§Ã£o privada:", error);
      req.flash("danger", `Erro ao excluir anotaÃ§Ã£o privada: ${error.message}`);
    }
    return res.redirect("/relatorios#report-writing-panel");
  });

  app.post("/relatorios/writing/fortnight/save", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    if (req.currentUser?.role !== "tutor") {
      req.flash("warning", "Somente tutor pode salvar avaliaÃ§Ã£o complementar.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const memberId = parseId(req.body.member_id);
    const currentWeekStart = getCurrentWeekStartDate();
    const weekStart = normalizeWeekStartInput(req.body.week_start, currentWeekStart);
    const content = String(req.body.content || "").trim();

    if (!memberId) {
      req.flash("warning", "Selecione um membro para salvar a avaliaÃ§Ã£o.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    if (weekStart < currentWeekStart) {
      req.flash("warning", "A quinzena jÃ¡ foi encerrada e nÃ£o pode ser editada.");
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }

    if (!content || content.length < 10) {
      req.flash("warning", "A avaliaÃ§Ã£o complementar deve ter pelo menos 10 caracteres.");
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }

    try {
      const note = database.upsertReportFortnightTutorNote({
        tutorUserId: req.currentUser.id,
        memberId,
        weekStart,
        content,
      });

      const memberUser = database.getUserByMemberId(memberId);
      if (!memberUser?.id) {
        req.flash("success", "AvaliaÃ§Ã£o complementar salva.");
        req.flash("warning", "Membro sem usuÃ¡rio vinculado: envio ao chat nÃ£o realizado.");
        return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
      }

      let conversation = database.findDirectConversationByUsers(req.currentUser.id, memberUser.id);
      if (!conversation?.id) {
        conversation = database.createChatConversation({
          title: `Tutor â€¢ ${memberUser.name || memberUser.username}`,
          createdByUserId: req.currentUser.id,
          participantUserIds: [req.currentUser.id, memberUser.id],
        });
      }

      const weekLabel = String(weekStart).split("-").reverse().join("/");
      const chatMessage = database.createChatMessage({
        conversationId: conversation.id,
        authorUserId: req.currentUser.id,
        text: `Avaliação complementar da quinzena (${weekLabel})\n\n${note.content}`,
      });
      if (notificationService) {
        notificationService.sendChatNewMessageNotification({
          conversationId: conversation.id,
          messageText: chatMessage?.text || note.content,
          authorUserId: req.currentUser.id,
          sentAt: chatMessage?.sent_at || null,
        }).catch((notifyError) => {
          logError(req, "Erro ao notificar e-mail de avaliação do tutor:", notifyError);
        });
      }
      database.markReportFortnightTutorNoteAsSentToChat(note.id, conversation.id);
      req.flash("success", "AvaliaÃ§Ã£o salva e enviada ao chat privado.");
      return res.redirect(`/mensagens/conversas/${conversation.id}`);
    } catch (error) {
      logError(req, "Erro ao salvar avaliaÃ§Ã£o complementar:", error);
      req.flash("danger", `Erro ao salvar avaliaÃ§Ã£o complementar: ${error.message}`);
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }
  });

  app.post("/relatorios/writing/fortnight/send-chat", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    if (req.currentUser?.role !== "tutor") {
      req.flash("warning", "Somente tutor pode enviar avaliaÃ§Ã£o para o chat.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const memberId = parseId(req.body.member_id);
    const currentWeekStart = getCurrentWeekStartDate();
    const weekStart = normalizeWeekStartInput(req.body.week_start, currentWeekStart);
    if (!memberId) {
      req.flash("warning", "Membro invÃ¡lido para envio ao chat.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const note = database.getReportFortnightTutorNote({
      tutorUserId: req.currentUser.id,
      memberId,
      weekStart,
    });
    if (!note || !String(note.content || "").trim()) {
      req.flash("warning", "Salve a avaliaÃ§Ã£o complementar antes de enviar ao chat.");
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }

    const memberUser = database.getUserByMemberId(memberId);
    if (!memberUser?.id) {
      req.flash("warning", "Este membro nÃ£o possui usuÃ¡rio vinculado para receber mensagens.");
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }

    try {
      let conversation = database.findDirectConversationByUsers(req.currentUser.id, memberUser.id);
      if (!conversation?.id) {
        conversation = database.createChatConversation({
          title: `Tutor â€¢ ${memberUser.name || memberUser.username}`,
          createdByUserId: req.currentUser.id,
          participantUserIds: [req.currentUser.id, memberUser.id],
        });
      }

      const weekLabel = String(weekStart).split("-").reverse().join("/");
      const chatMessage = database.createChatMessage({
        conversationId: conversation.id,
        authorUserId: req.currentUser.id,
        text: `Avaliação complementar da quinzena (${weekLabel})\n\n${note.content}`,
      });
      if (notificationService) {
        notificationService.sendChatNewMessageNotification({
          conversationId: conversation.id,
          messageText: chatMessage?.text || note.content,
          authorUserId: req.currentUser.id,
          sentAt: chatMessage?.sent_at || null,
        }).catch((notifyError) => {
          logError(req, "Erro ao notificar e-mail de avaliação do tutor:", notifyError);
        });
      }
      database.markReportFortnightTutorNoteAsSentToChat(note.id, conversation.id);
      req.flash("success", "AvaliaÃ§Ã£o enviada ao chat privado com sucesso.");
      return res.redirect(`/mensagens/conversas/${conversation.id}`);
    } catch (error) {
      logError(req, "Erro ao enviar avaliaÃ§Ã£o complementar ao chat:", error);
      req.flash("danger", `Erro ao enviar ao chat: ${error.message}`);
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }
  });

  app.post("/relatorios/writing/member/save", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    if (req.currentUser?.role === "tutor") {
      req.flash("warning", "Este complemento Ã© para membros (nÃ£o tutor).");
      return res.redirect("/relatorios#report-writing-panel");
    }

    const currentMember = getCurrentMember(req);
    const memberId = parseId(req.body.member_id);
    const currentWeekStart = getCurrentWeekStartDate();
    const weekStart = normalizeWeekStartInput(req.body.week_start, currentWeekStart);
    const content = String(req.body.content || "").trim();

    if (!currentMember?.is_active || Number(currentMember.id) !== Number(memberId)) {
      req.flash("warning", "Sem permissÃ£o para complementar este relatÃ³rio.");
      return res.redirect("/relatorios#report-writing-panel");
    }

    if (weekStart < currentWeekStart) {
      req.flash("warning", "A quinzena jÃ¡ foi encerrada e nÃ£o pode ser editada.");
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }

    if (!content || content.length < 10) {
      req.flash("warning", "O complemento deve ter pelo menos 10 caracteres.");
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }

    const tutorUser = database.listUsers().find((user) => user.role === "tutor") || null;
    if (!tutorUser) {
      req.flash("warning", "Nenhum tutor cadastrado para receber o complemento.");
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }

    try {
      const note = database.upsertReportFortnightMemberNote({
        memberId,
        authorUserId: req.currentUser.id,
        targetTutorUserId: tutorUser.id,
        weekStart,
        content,
      });

      let conversation = database.findDirectConversationByUsers(req.currentUser.id, tutorUser.id);
      if (!conversation?.id) {
        conversation = database.createChatConversation({
          title: `Tutor â€¢ ${tutorUser.name || tutorUser.username}`,
          createdByUserId: req.currentUser.id,
          participantUserIds: [req.currentUser.id, tutorUser.id],
        });
      }

      const weekLabel = String(weekStart).split("-").reverse().join("/");
      const chatMessage = database.createChatMessage({
        conversationId: conversation.id,
        authorUserId: req.currentUser.id,
        text: `Complemento do relatório da quinzena (${weekLabel})\n\n${note.content}`,
      });
      if (notificationService) {
        notificationService.sendChatNewMessageNotification({
          conversationId: conversation.id,
          messageText: chatMessage?.text || note.content,
          authorUserId: req.currentUser.id,
          sentAt: chatMessage?.sent_at || null,
        }).catch((notifyError) => {
          logError(req, "Erro ao notificar e-mail de complemento do relatório:", notifyError);
        });
      }
      database.markReportFortnightMemberNoteAsSentToChat(note.id, conversation.id);
      req.flash("success", "Complemento salvo e enviado ao chat do tutor.");
      return res.redirect(`/mensagens/conversas/${conversation.id}`);
    } catch (error) {
      logError(req, "Erro ao salvar complemento do membro:", error);
      req.flash("danger", `Erro ao salvar complemento: ${error.message}`);
      return res.redirect(`/relatorios${buildReportsQuery({ memberId })}#report-writing-panel`);
    }
  });
}

module.exports = { registerReportRoutes };


