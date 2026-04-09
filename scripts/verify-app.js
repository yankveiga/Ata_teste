/*
 * ARQUIVO: scripts/verify-app.js
 * FUNCAO: script de verificacao automatizada para validar fluxos principais do sistema em banco Postgres configurado.
 * IMPACTO DE MUDANCAS:
 * - Alterar assercoes pode ocultar regressao real ou gerar falso positivo no processo de validacao.
 * - O script usa DATABASE_URL do ambiente; execute em uma base de teste dedicada.
 */
const assert = require("node:assert/strict");
const { promisify } = require("node:util");

const bcrypt = require("bcryptjs");

const { urlFor } = require("../src/utils");

// SECAO: rotina de verificacao ponta a ponta usando a base Postgres configurada.

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Defina DATABASE_URL para executar a verificação no Postgres.");
  }

  const database = require("../src/database");
  const { createApp } = require("../src/app");
  const { generateAtaPdf } = require("../src/pdf");

  database.ensureSchema();

    const adminUsername = "codex_verify_admin";
    const adminPassword = "codex123";
    let adminUser = database.getUserByUsername(adminUsername);
    if (!adminUser) {
      adminUser = database.createUser(
        adminUsername,
        bcrypt.hashSync(adminPassword, 12),
        {
          name: "Codex Verify Admin",
          role: "admin",
        },
      );
    }

    const commonUsername = "codex_verify_common";
    let commonUser = database.getUserByUsername(commonUsername);
    if (!commonUser) {
      commonUser = database.createUser(
        commonUsername,
        bcrypt.hashSync("codex456", 12),
        {
          name: "Codex Verify Common",
          role: "common",
        },
      );
    }

    const app = createApp();
    const render = promisify(app.render.bind(app));

    const routeEntries = app._router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Array.isArray(layer.route.path)
          ? layer.route.path
          : [layer.route.path],
      );

    [
      "/",
      "/login",
      "/logout",
      "/services",
      "/home",
      "/members",
      "/projects",
      "/atas/create",
      "/atas/download/:id",
      "/almoxarifado",
      "/almoxarifado/users/create",
      "/almoxarifado/inventory/create",
      "/almoxarifado/inventory/delete/:id",
      "/almoxarifado/inventory/withdraw",
      "/almoxarifado/inventory/borrow",
      "/almoxarifado/loans/return/:id",
      "/almoxarifado/loans/extend/:id",
      "/almoxarifado/categories/create",
      "/almoxarifado/categories/delete/:id",
      "/almoxarifado/locations/create",
      "/almoxarifado/locations/delete/:id",
      "/almoxarifado/api/itens",
      "/almoxarifado/api/itens/:id",
      "/almoxarifado/api/categorias",
      "/almoxarifado/api/categorias/:id",
      "/almoxarifado/api/locais",
      "/almoxarifado/api/locais/:id",
      "/api/project/:project_id/members",
    ].forEach((routePath) => {
      assert.ok(routeEntries.includes(routePath), `Rota ausente: ${routePath}`);
    });

    assert.equal(adminUser.role, "admin");
    assert.equal(adminUser.is_admin, true);
    assert.equal(commonUser.role, "common");
    assert.equal(commonUser.is_admin, false);

    const csrfToken = "csrf-token-teste";
    const projects = database.listProjectsBasic();
    assert.ok(projects.length > 0, "Nenhum projeto encontrado no banco de teste.");
    const project = database.getProjectById(projects[0].id);
    assert.ok(project, "Projeto de teste não encontrado.");
    assert.ok(
      project.active_members.length > 0,
      "Projeto de teste não possui membros ativos.",
    );

    const recentAtasBefore = database.listRecentAtas(5);
    assert.ok(recentAtasBefore.length > 0, "Nenhuma ata encontrada para teste.");

    await render("login.html", {
      title: "Entrar",
      csrfToken,
      flashMessages: [],
      formData: { username: adminUsername, next: "/services" },
      errors: {},
    });

    await render("services.html", {
      title: "Serviços",
      activeSection: "services",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
    });

    await render("home.html", {
      title: "Atas",
      activeSection: "home",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
      recentAtas: recentAtasBefore,
    });

    await render("members/list.html", {
      title: "Membros Ativos",
      activeSection: "members",
      currentUser: commonUser,
      flashMessages: [],
      csrfToken,
      members: database.listActiveMembers(),
    });

    await render("projects/list.html", {
      title: "Projetos",
      activeSection: "projects",
      currentUser: commonUser,
      flashMessages: [],
      csrfToken,
      projects: database.listProjectsWithMembers(),
    });

    await render("atas/create_form.html", {
      title: "Criar Nova Ata",
      activeSection: "atas",
      currentUser: commonUser,
      flashMessages: [],
      csrfToken,
      formData: {
        projectId: project.id,
        meetingDatetime: "2026-03-29T14:30",
        notes: "Reunião de verificação automatizada da migração para Node.js.",
        presentMemberIds: [project.active_members[0].id],
        justifications: project.active_members[1]
          ? { [project.active_members[1].id]: "Compromisso acadêmico." }
          : {},
      },
      errors: {},
      projects,
      selectedProject: project,
      selectedProjectMembers: project.active_members,
    });

    const categoryName = `Categoria Verificacao ${Date.now()}`;
    const locationName = `Local Verificacao ${Date.now()}`;
    const category = database.createInventoryCategory(categoryName);
    const location = database.createInventoryLocation(locationName);
    assert.ok(category?.id, "Falha ao criar categoria de patrimônio.");
    assert.ok(location?.id, "Falha ao criar local de patrimônio.");

    const inventoryName = `Estoque Verificacao ${Date.now()}`;
    const createdItem = database.createInventoryItem({
      name: inventoryName,
      itemType: "stock",
      categoryId: category.id,
      locationId: location.id,
      quantity: 7,
      description: "Produto criado durante a verificação automatizada.",
    });
    assert.ok(createdItem?.id, "Falha ao criar item de estoque para teste.");
    assert.equal(createdItem.item_type, "stock");
    assert.equal(createdItem.category, category.name);
    assert.equal(createdItem.location, location.name);

    const withdrawal = database.withdrawInventoryItem({
      nameOrCode: String(createdItem.id),
      quantity: 2,
      userId: commonUser.id,
    });
    assert.equal(withdrawal.success, true, "Falha ao registrar retirada de estoque.");

    const patrimonyName = `Patrimonio Verificacao ${Date.now()}`;
    const patrimonyItem = database.createInventoryItem({
      name: patrimonyName,
      itemType: "patrimony",
      categoryId: category.id,
      locationId: location.id,
      quantity: 3,
      description: "Patrimônio criado para teste automatizado de empréstimo.",
    });
    assert.ok(patrimonyItem?.id, "Falha ao criar item patrimonial para teste.");
    assert.equal(patrimonyItem.item_type, "patrimony");

    const invalidStockBorrow = database.borrowInventoryItem({
      nameOrCode: String(createdItem.id),
      quantity: 1,
      userId: commonUser.id,
    });
    assert.equal(
      invalidStockBorrow.success,
      false,
      "Material de estoque não deveria entrar em empréstimo.",
    );

    const invalidPatrimonyWithdraw = database.withdrawInventoryItem({
      nameOrCode: String(patrimonyItem.id),
      quantity: 1,
      userId: commonUser.id,
    });
    assert.equal(
      invalidPatrimonyWithdraw.success,
      false,
      "Patrimônio não deveria sair pela rota de retirada.",
    );

    const loan = database.borrowInventoryItem({
      nameOrCode: String(patrimonyItem.id),
      quantity: 1,
      userId: commonUser.id,
    });
    assert.equal(loan.success, true, "Falha ao registrar empréstimo patrimonial.");
    assert.equal(loan.loan.status, "active");

    const extension = database.extendInventoryLoan({
      loanId: loan.loan.id,
      extraDays: 5,
      actorUserId: adminUser.id,
    });
    assert.equal(extension.success, true, "Falha ao prorrogar empréstimo.");

    const activeLoans = database.listInventoryLoans({ status: "active" });
    assert.ok(
      activeLoans.some(
        (entry) =>
          entry.id === loan.loan.id &&
          entry.user_id === commonUser.id &&
          entry.item_name === patrimonyName,
      ),
      "Lista de materiais emprestados não registrou o patrimônio de teste.",
    );

    const returnLoan = database.returnInventoryLoan({
      loanId: loan.loan.id,
      actorUserId: commonUser.id,
    });
    assert.equal(returnLoan.success, true, "Falha ao registrar devolução.");

    const dashboard = database.getInventoryDashboardData();
    assert.ok(
      dashboard.summary.item_count >= 1,
      "Resumo do almoxarifado não contabilizou itens.",
    );
    assert.ok(
      dashboard.summary.category_count >= 1,
      "Resumo do almoxarifado não contabilizou categorias.",
    );
    assert.ok(
      dashboard.summary.location_count >= 1,
      "Resumo do almoxarifado não contabilizou locais.",
    );
    assert.ok(
      dashboard.summary.request_count >= 1,
      "Resumo do almoxarifado não contabilizou retiradas.",
    );
    assert.ok(
      dashboard.summary.patrimony_item_count >= 1,
      "Resumo do almoxarifado não contabilizou patrimônio.",
    );

    const requests = database.listInventoryRequests();
    assert.ok(
      requests.some(
        (request) =>
          request.usuario_id === commonUser.id &&
          request.nome_item_estoque === inventoryName,
      ),
      "Histórico de retiradas não registrou a movimentação de teste.",
    );

    const returnedLoans = database.listInventoryLoans({ status: "returned" });
    assert.ok(
      returnedLoans.some(
        (entry) =>
          entry.id === loan.loan.id &&
          entry.returned_at &&
          entry.item_name === patrimonyName,
      ),
      "Histórico de devoluções não registrou o empréstimo de teste.",
    );

    await render("almoxarifado/index.html", {
      title: "Almoxarifado",
      activeSection: "almox",
      activeTab: "overview",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
      dashboard,
      users: database.listUsers(),
      inventoryItems: database.listInventoryItems(),
      stockItems: database.listInventoryItems({ type: "stock" }),
      patrimonyItems: database.listInventoryItems({ type: "patrimony" }),
      categories: database.listInventoryCategories(),
      locations: database.listInventoryLocations(),
      requests,
      activeLoans: database.listInventoryLoans({ status: "active" }),
      returnedLoans,
      overdueLoans: database.listInventoryLoans({ status: "overdue" }),
      userFormData: { name: "", username: "", password: "", role: "common" },
      userErrors: {},
      itemFormData: {
        name: "",
        itemType: "stock",
        categoryId: "",
        categoryName: "",
        locationId: "",
        locationName: "",
        quantity: "",
        description: "",
      },
      itemErrors: {},
      categoryFormData: { name: "" },
      categoryErrors: {},
      locationFormData: { name: "" },
      locationErrors: {},
      withdrawFormData: { nameOrCode: "", quantity: "" },
      withdrawErrors: {},
      loanFormData: { nameOrCode: "", quantity: "1" },
      loanErrors: {},
      loanExtendDefaults: { extraDays: "7" },
    });

    await render("almoxarifado/index.html", {
      title: "Almoxarifado",
      activeSection: "almox",
      activeTab: "withdraw",
      currentUser: commonUser,
      flashMessages: [],
      csrfToken,
      dashboard,
      users: database.listUsers(),
      inventoryItems: database.listInventoryItems(),
      stockItems: database.listInventoryItems({ type: "stock" }),
      patrimonyItems: database.listInventoryItems({ type: "patrimony" }),
      categories: database.listInventoryCategories(),
      locations: database.listInventoryLocations(),
      requests,
      activeLoans: database.listInventoryLoans({ status: "active" }),
      returnedLoans,
      overdueLoans: database.listInventoryLoans({ status: "overdue" }),
      userFormData: { name: "", username: "", password: "", role: "common" },
      userErrors: {},
      itemFormData: {
        name: "",
        itemType: "stock",
        categoryId: "",
        categoryName: "",
        locationId: "",
        locationName: "",
        quantity: "",
        description: "",
      },
      itemErrors: {},
      categoryFormData: { name: "" },
      categoryErrors: {},
      locationFormData: { name: "" },
      locationErrors: {},
      withdrawFormData: { nameOrCode: createdItem.name, quantity: "1" },
      withdrawErrors: {},
      loanFormData: { nameOrCode: patrimonyItem.name, quantity: "1" },
      loanErrors: {},
      loanExtendDefaults: { extraDays: "7" },
    });

    await render("errors/404.html", {
      title: "Página Não Encontrada",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
      activeSection: "",
    });

    await render("errors/500.html", {
      title: "Erro Interno",
      currentUser: adminUser,
      flashMessages: [],
      csrfToken,
      activeSection: "",
    });

    const createdAta = database.createAta({
      projectId: project.id,
      meetingDateTime: "2026-03-29 14:30:00",
      notes: "Reunião de verificação automatizada da migração para Node.js.",
      presentMemberIds: [project.active_members[0].id],
      justifications: project.active_members[1]
        ? { [project.active_members[1].id]: "Compromisso acadêmico." }
        : {},
    });

    assert.ok(createdAta?.id, "Falha ao criar ata na base de teste.");

    const loadedAta = database.getAtaById(createdAta.id);
    assert.ok(loadedAta, "Falha ao recarregar a ata criada.");
    assert.equal(loadedAta.project.id, project.id);
    assert.ok(Array.isArray(loadedAta.present_members));
    assert.ok(Array.isArray(loadedAta.absent_members));

    const pdf = await generateAtaPdf(loadedAta);
    assert.ok(Buffer.isBuffer(pdf), "PDF não foi gerado em formato Buffer.");
    assert.ok(pdf.length > 1000, "PDF gerado parece inválido.");

    assert.equal(urlFor("services"), "/services");
    assert.equal(urlFor("home"), "/home");
    assert.equal(urlFor("almox_home"), "/almoxarifado");
    assert.equal(urlFor("create_ata", { project_id: project.id }), `/atas/create/for/${project.id}`);

  console.log("Verificação concluída com sucesso.");
}

main().catch((error) => {
  console.error("Falha na verificação da aplicação:", error);
  process.exitCode = 1;
});
