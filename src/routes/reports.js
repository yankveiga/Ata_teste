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
    canGenerateMonthlyReport,
    buildMonthlyPdfFilename,
    validateWeekGoalForm,
    logError,
  } = ctx;

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

    Object.assign(goalFormErrors, validateWeekGoalForm(goalFormData).errors);

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
      logError(req, "Erro ao criar meta semanal:", error);
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

    const validatedGoal = validateWeekGoalForm({ activity, description });
    if (validatedGoal.errors.activity) {
      goalFormErrors.activity = validatedGoal.errors.activity;
    }
    if (validatedGoal.errors.description) {
      goalFormErrors.description = validatedGoal.errors.description;
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
      logError(req, "Erro ao atualizar meta semanal:", error);
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
      logError(req, "Erro ao apagar meta concluída:", error);
      req.flash("danger", `Erro ao apagar atividade concluída: ${error.message}`);
    }

    return res.redirect(
      `/relatorios${buildReportsQuery({
        memberId: goal.member_id,
        projectId: goal.project_id,
      })}#report-goals-panel`,
    );
  });
}

module.exports = { registerReportRoutes };
