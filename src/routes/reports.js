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
  } = ctx;

  function normalizeDueAtInput(value) {
    return toSqlDateTime(String(value || "").trim());
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
      req.flash("warning", "Selecione um membro válido para gerar o relatório mensal.");
      return res.redirect("/relatorios");
    }

    const canGenerate = canGenerateMonthlyReport(req, currentMember, targetMember);
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

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${buildMonthlyPdfFilename(targetMember.name, monthKey)}"`,
      );
      return res.send(pdf);
    } catch (error) {
      logError(req, "Erro ao gerar PDF mensal de relatório:", error);
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
    req.flash("info", "O registro quinzenal agora é feito em \"Metas da Quinzena\".");
    return res.redirect("/relatorios#report-goals-panel");
  });

  // DETALHE: Rota POST /relatorios/edit/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/relatorios/edit/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    req.flash("info", "A edição quinzenal agora é feita em \"Metas da Quinzena\".");
    return res.redirect("/relatorios#report-goals-panel");
  });

  // DETALHE: Rota POST /relatorios/delete/:id: processa envio de formulario/acao, valida entrada, persiste dados e redireciona.

  app.post("/relatorios/delete/:id", requireAuth, (req, res) => {
    if (!ensureValidCsrf(req, res)) {
      return;
    }
    req.flash("info", "A remoção quinzenal agora é feita em \"Metas da Quinzena\".");
    return res.redirect("/relatorios#report-goals-panel");
  });

  // DETALHE: Rota POST /relatorios/goals/create: cria meta quinzenal para membro/projeto selecionados.

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
      dueAt: String(req.body.due_at || "").trim(),
      isCompleted: Boolean(req.body.is_completed),
    };
    const goalFormErrors = {};

    const selectedMember = selectedMemberId
      ? database.getMemberById(selectedMemberId)
      : null;
    if (!selectedMember) {
      req.flash("warning", "Membro inválido para cadastrar meta da quinzena.");
      return res.redirect("/relatorios");
    }

    const project = projectId ? database.getProjectById(projectId) : null;
    if (!project) {
      goalFormErrors.projectId = ["Selecione um projeto válido."];
    } else if (!database.isProjectMember(project.id, selectedMember.id)) {
      goalFormErrors.projectId = ["Este membro não participa do projeto selecionado."];
    }

    Object.assign(goalFormErrors, validateWeekGoalForm(goalFormData).errors);
    const dueAt = normalizeDueAtInput(goalFormData.dueAt);
    const nowSql = toSqlDateTime(new Date());
    if (!dueAt) {
      goalFormErrors.dueAt = ["Informe uma data de entrega válida."];
    } else if (nowSql && dueAt < nowSql) {
      goalFormErrors.dueAt = ["A data de entrega não pode estar no passado."];
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
      const initialStatus = dueAt && nowSql && dueAt <= nowSql
        ? "in_progress"
        : "todo";
      const createdTask = database.createPlannerTask({
        projectId: project.id,
        assignedMemberId: selectedMember.id,
        createdByUserId: req.currentUser.id,
        title: goalFormData.activity,
        description: goalFormData.description,
        dueAt,
        status: goalFormData.isCompleted ? "done" : initialStatus,
        workflowState: "active",
        priority: "medium",
      });
      database.syncReportWeekGoalFromPlannerTask(createdTask, {
        createdByUserId: req.currentUser.id,
      });
      req.flash("success", "Meta da quinzena adicionada com sucesso.");
    } catch (error) {
      logError(req, "Erro ao criar meta quinzenal:", error);
      req.flash("danger", `Erro ao criar meta quinzenal: ${error.message}`);
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
      return sendGoalUpdateError(404, "Meta quinzenal não encontrada.");
    }

    if (!canManageReportGoal(req, {
      memberId: goal.member_id,
      projectId: goal.project_id,
    })) {
      return sendGoalUpdateError(403, "Sem permissão para editar esta meta quinzenal.");
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
    const previousDueAt = String(goal.due_at || "").trim();

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
      if (
        dueAt
        && nowSql
        && dueAt < nowSql
        && dueAt !== previousDueAt
      ) {
        goalFormErrors.dueAt = ["A data de entrega não pode estar no passado."];
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
        || "Não foi possível salvar a meta.";
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
        database.syncReportWeekGoalFromPlannerTask(createdTask, {
          createdByUserId: req.currentUser.id,
        });
        if (!goal.planner_task_id) {
          database.deleteReportWeekGoal(goal.id);
        }
        linkedTask = createdTask;
      }

      if (!linkedTask) {
        throw new Error("Falha ao localizar tarefa vinculada no Planner.");
      }

      if (linkedTask.workflow_state === "missed" && goalAction === "save") {
        return sendGoalUpdateError(
          409,
          "Tarefa em histórico de não feitas. Use 'Feito com atraso' ou 'Estender prazo'.",
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
      req.flash("warning", "Meta quinzenal não encontrada.");
      return res.redirect("/relatorios");
    }

    const canDeleteFromCompleted = canDeleteCompletedGoalFromOthers(req, goal);
    const canDeleteFromExecution = canDeleteGoalFromExecution(req, goal);

    if (!canDeleteFromCompleted && !canDeleteFromExecution) {
      req.flash(
        "warning",
        "Sem permissão para apagar esta meta neste projeto.",
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
      logError(req, "Erro ao apagar meta concluída:", error);
      req.flash("danger", `Erro ao apagar atividade concluída: ${error.message}`);
    }

    return res.redirect(
      `/relatorios${buildReportsQuery({
        memberId: goal.member_id,
        projectId: returnProjectId || goal.project_id,
      })}#report-goals-panel`,
    );
  });
}

module.exports = { registerReportRoutes };
