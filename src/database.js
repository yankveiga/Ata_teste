/*
 * ARQUIVO: src/database.js
 * FUNCAO: camada de persistencia PostgreSQL/Neon (schema, consultas, insercoes e atualizacoes de dados de dominio).
 * IMPACTO DE MUDANCAS:
 * - Qualquer ajuste de schema exige compatibilidade com dados existentes e consultas ja usadas no app.
 * - Mudancas em regras de normalizacao/validacao podem alterar dados gravados e relatorios gerados.
 * - Mudancas em nomes de colunas/joins afetam telas, filtros e exportacoes.
 */
const { MessageChannel, Worker, receiveMessageOnPort } = require("node:worker_threads");

const { config } = require("./config");
const { firstNamesSummary } = require("./utils");

// ESTADO GLOBAL: instancia unica do adaptador de banco para a aplicacao.
let database;
// ESTADO GLOBAL: ponte ativa entre thread principal e worker do Postgres.
let bridgeState;
// ESTADO GLOBAL: sequencia crescente para correlacao de mensagens SQL.
let querySequence = 0;
// ESTADO GLOBAL: buffer de espera usado no modo sincrono.
const sleeper = new Int32Array(new SharedArrayBuffer(4));
// CONSTANTE DE DOMINIO: timezone oficial usada em datas/horarios do sistema.
const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Sao_Paulo";

// FUNCAO: normalizeError.
function normalizeError(payload) {
  if (!payload) {
    return null;
  }

  const error = new Error(payload.message || "Database query failed");
  Object.assign(error, payload);
  return error;
}

// FUNCAO: toPostgresSql.
function toPostgresSql(sql) {
  let index = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let output = "";

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const previous = i > 0 ? sql[i - 1] : "";

    if (char === "'" && previous !== "\\" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      output += char;
      continue;
    }

    if (char === '"' && previous !== "\\" && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      output += char;
      continue;
    }

    if (char === "?" && !inSingleQuote && !inDoubleQuote) {
      output += `$${index}`;
      index += 1;
      continue;
    }

    output += char;
  }

  // "user" e palavra reservada no Postgres; quote apenas quando usado como nome de tabela.
  return output
    .replace(/\bFROM\s+user\b/gi, 'FROM "user"')
    .replace(/\bJOIN\s+user\b/gi, 'JOIN "user"')
    .replace(/\bINTO\s+user\b/gi, 'INTO "user"')
    .replace(/\bUPDATE\s+user\b/gi, 'UPDATE "user"')
    .replace(/\bTABLE\s+user\b/gi, 'TABLE "user"')
    .replace(/\bREFERENCES\s+user\b/gi, 'REFERENCES "user"');
}

// FUNCAO: createSyncBridge.
function createSyncBridge() {
  if (bridgeState) {
    return bridgeState;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL não configurada. Para Neon/Postgres, defina DATABASE_URL no ambiente.",
    );
  }

  const workerCode = `
    const { parentPort } = require("node:worker_threads");
    const { Client } = require("pg");

    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("sslmode=")
        ? undefined
        : { rejectUnauthorized: false },
    });

    let channel = null;
    let connected = false;

    // FUNCAO INTERNA DO WORKER: conecta no banco uma unica vez.
    async function ensureConnected() {
      if (!connected) {
        await client.connect();
        await client.query("SET TIME ZONE 'America/Sao_Paulo'");
        connected = true;
      }
    }

    // FUNCAO INTERNA DO WORKER: executa SQL recebido e responde no canal.
    async function handle(message) {
      const { id, sql, params } = message;
      try {
        await ensureConnected();
        const result = await client.query(sql, params || []);
        channel.postMessage({
          id,
          ok: true,
          result: {
            rows: result.rows || [],
            rowCount: Number(result.rowCount || 0),
            command: result.command || "",
          },
        });
      } catch (error) {
        channel.postMessage({
          id,
          ok: false,
          error: {
            message: error.message,
            code: error.code,
            detail: error.detail,
            table: error.table,
            constraint: error.constraint,
          },
        });
      }
    }

    // EVENTO DO WORKER: recebe MessagePort inicial e habilita consumo de comandos.
    parentPort.on("message", (message) => {
      if (!message || !message.port) {
        return;
      }
      channel = message.port;
      channel.on("message", (payload) => {
        handle(payload);
      });
    });
  `;

  const worker = new Worker(workerCode, { eval: true });
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ port: port2 }, [port2]);
  if (typeof worker.unref === "function") {
    worker.unref();
  }
  if (typeof port1.unref === "function") {
    port1.unref();
  }

  bridgeState = {
    worker,
    port: port1,
    pending: new Map(),
  };

  return bridgeState;
}

// FUNCAO: querySync.
function querySync(sql, params = []) {
  const bridge = createSyncBridge();
  const id = ++querySequence;
  bridge.port.postMessage({ id, sql, params });

  // LOOP SINCRONO: aguarda retorno do worker mantendo API simples para chamadas locais.
  while (true) {
    const ready = bridge.pending.get(id);
    if (ready) {
      bridge.pending.delete(id);
      if (!ready.ok) {
        throw normalizeError(ready.error);
      }
      return ready.result;
    }

    const packet = receiveMessageOnPort(bridge.port);
    if (packet && packet.message) {
      const message = packet.message;
      bridge.pending.set(message.id, message);
      continue;
    }

    Atomics.wait(sleeper, 0, 0, 10);
  }
}

// FUNCAO: createPreparedStatement.
function createPreparedStatement(sql, inTransaction = false) {
  const transformedSql = toPostgresSql(sql);
  const execute = (params = []) =>
    inTransaction
      ? querySync(transformedSql, params)
      : querySync(transformedSql, params);

  return {
    run(...params) {
      const result = execute(params);
      let lastInsertRowid = null;
      if (result.rows && result.rows[0] && result.rows[0].id !== undefined) {
        lastInsertRowid = Number(result.rows[0].id);
      }
      return {
        changes: Number(result.rowCount || 0),
        lastInsertRowid,
      };
    },
    get(...params) {
      const result = execute(params);
      return result.rows[0] || undefined;
    },
    all(...params) {
      const result = execute(params);
      return result.rows || [];
    },
  };
}

// FUNCAO: createDbAdapter.
function createDbAdapter() {
  return {
    // ADAPTADOR: executa SQL bruto (DDL/DML) sem retorno de linhas.
    exec(sql) {
      querySync(toPostgresSql(sql));
    },
    // ADAPTADOR: devolve statement com operacoes run/get/all.
    prepare(sql) {
      return createPreparedStatement(sql);
    },
  };
}
// SECAO: constantes de dominio e restricoes de valores aceitos no banco.

const USER_ROLES = new Set(["admin", "common"]);
const INVENTORY_TYPES = new Set(["stock", "patrimony"]);
const DEFAULT_PROJECT_COLOR = "#0b6bcb";
const REPORT_STATUSES = new Set(["completed", "in_progress", "blocked"]);
const PLANNER_STATUSES = new Set(["todo", "in_progress", "done"]);
const PLANNER_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const PLANNER_RECURRENCE_UNITS = new Set(["days", "weeks", "months"]);
const PLANNER_WORKFLOW_STATES = new Set(["active", "missed"]);

// SECAO: normalizadores e utilitarios basicos usados antes de persistir dados.

// FUNCAO: normalizeInventoryType.
function normalizeInventoryType(value) {
  return INVENTORY_TYPES.has(value) ? value : "stock";
}

// FUNCAO: normalizeProjectColor.
function normalizeProjectColor(value) {
  const normalized = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized)
    ? normalized.toLowerCase()
    : DEFAULT_PROJECT_COLOR;
}

// FUNCAO: normalizeReportStatus.
function normalizeReportStatus(value) {
  return REPORT_STATUSES.has(value) ? value : "in_progress";
}

// FUNCAO: normalizePlannerStatus.
function normalizePlannerStatus(value) {
  return PLANNER_STATUSES.has(value) ? value : "todo";
}

// FUNCAO: normalizePlannerPriority.
function normalizePlannerPriority(value) {
  return PLANNER_PRIORITIES.has(value) ? value : "medium";
}

// FUNCAO: normalizePlannerRecurrenceUnit.
function normalizePlannerRecurrenceUnit(value) {
  return PLANNER_RECURRENCE_UNITS.has(value) ? value : null;
}

// FUNCAO: normalizePlannerWorkflowState.
function normalizePlannerWorkflowState(value) {
  return PLANNER_WORKFLOW_STATES.has(value) ? value : "active";
}

// FUNCAO: toSqlDateTime.
function toSqlDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const valueByType = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      valueByType[part.type] = part.value;
    }
  });

  return `${valueByType.year}-${valueByType.month}-${valueByType.day} ${valueByType.hour}:${valueByType.minute}:${valueByType.second}`;
}

// FUNCAO: fromSqlDateTime.
function fromSqlDateTime(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

// FUNCAO: resolveFortnightStartFromSqlDateTime.
function resolveFortnightStartFromSqlDateTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return null;
  }

  const day = Number(match[3]);
  const fortnightStart = day <= 15 ? "01" : "16";
  return `${match[1]}-${match[2]}-${fortnightStart}`;
}

// FUNCAO: addDaysToNow.
function addDaysToNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toSqlDateTime(date);
}

// SECAO: conexao PostgreSQL/Neon e garantia incremental de schema.

// FUNCAO: getDb.
function getDb() {
  if (!database) {
    database = createDbAdapter();
  }

  return database;
}

// FUNCAO: ensureColumn.
function ensureColumn(tableName, columnName, definition) {
  const exists = querySync(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName],
  );

  if (!exists.rows.length) {
    querySync(`ALTER TABLE ${tableName === "user" ? '"user"' : tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

// FUNCAO: ensureSchema.
function ensureSchema() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS member (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      photo TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS "user" (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'admin',
      member_id INTEGER,
      FOREIGN KEY (member_id) REFERENCES member(id)
    );

    CREATE TABLE IF NOT EXISTS project (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      logo TEXT,
      primary_color TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_COLOR}'
    );

    CREATE TABLE IF NOT EXISTS ata (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      meeting_datetime TEXT NOT NULL,
      location_type TEXT,
      location_details TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      project_id INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES project(id)
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      is_coordinator INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, member_id),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (member_id) REFERENCES member(id)
    );

    CREATE TABLE IF NOT EXISTS ata_present_members (
      ata_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      PRIMARY KEY (ata_id, member_id),
      FOREIGN KEY (ata_id) REFERENCES ata(id),
      FOREIGN KEY (member_id) REFERENCES member(id)
    );

    CREATE TABLE IF NOT EXISTS ata_absent_justification (
      ata_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      justification TEXT NOT NULL,
      PRIMARY KEY (ata_id, member_id),
      FOREIGN KEY (ata_id) REFERENCES ata(id),
      FOREIGN KEY (member_id) REFERENCES member(id)
    );

    CREATE TABLE IF NOT EXISTS report_entry (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      project_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      created_by_user_id INTEGER,
      week_start TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (created_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS report_week_goal (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      member_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      created_by_user_id INTEGER,
      week_start TEXT NOT NULL,
      due_at TEXT,
      activity TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      planner_task_id INTEGER,
      goal_source TEXT NOT NULL DEFAULT 'manual',
      task_state TEXT NOT NULL DEFAULT 'active',
      is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      completed_late INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (created_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS report_week_goal_deletion_log (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      goal_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      deleted_by_user_id INTEGER NOT NULL,
      week_start TEXT NOT NULL,
      activity TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (deleted_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS planner_task (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      project_id INTEGER NOT NULL,
      assigned_member_id INTEGER NOT NULL,
      created_by_user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      label TEXT,
      due_at TEXT NOT NULL,
      is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      completed_late INTEGER NOT NULL DEFAULT 0,
      workflow_state TEXT NOT NULL DEFAULT 'active',
      missed_at TEXT,
      last_extended_at TEXT,
      last_extended_by_user_id INTEGER,
      recurrence_interval_days INTEGER,
      recurrence_unit TEXT,
      recurrence_every INTEGER,
      recurrence_member_queue TEXT,
      recurrence_next_index INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (assigned_member_id) REFERENCES member(id),
      FOREIGN KEY (created_by_user_id) REFERENCES user(id),
      FOREIGN KEY (last_extended_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS planner_task_completion_log (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      task_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      assigned_member_id INTEGER NOT NULL,
      completed_by_user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      priority TEXT NOT NULL DEFAULT 'medium',
      label TEXT,
      due_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES planner_task(id),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (assigned_member_id) REFERENCES member(id),
      FOREIGN KEY (completed_by_user_id) REFERENCES user(id)
    );

    CREATE TABLE IF NOT EXISTS task_audit_log (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      task_id INTEGER,
      report_goal_id INTEGER,
      member_id INTEGER,
      project_id INTEGER,
      event_type TEXT NOT NULL,
      actor_user_id INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS estoque (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'stock',
      category TEXT NOT NULL,
      category_id INTEGER,
      location TEXT,
      location_id INTEGER,
      amount INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pedido (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      qtd_retirada INTEGER NOT NULL,
      usuario_id INTEGER NOT NULL,
      estoque_id INTEGER NOT NULL,
      data_pedido TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES user(id),
      FOREIGN KEY (estoque_id) REFERENCES estoque(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_category (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS inventory_location (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS inventory_loan (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      item_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      borrowed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      original_due_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      returned_at TEXT,
      extended_at TEXT,
      extended_by_user_id INTEGER,
      returned_by_user_id INTEGER,
      FOREIGN KEY (item_id) REFERENCES estoque(id),
      FOREIGN KEY (user_id) REFERENCES user(id),
      FOREIGN KEY (extended_by_user_id) REFERENCES user(id),
      FOREIGN KEY (returned_by_user_id) REFERENCES user(id)
    );

    CREATE INDEX IF NOT EXISTS ix_member_name ON member(name);
    CREATE INDEX IF NOT EXISTS ix_member_is_active ON member(is_active);
    CREATE INDEX IF NOT EXISTS ix_project_name ON project(name);
    CREATE INDEX IF NOT EXISTS ix_user_username ON "user"(username);
    CREATE INDEX IF NOT EXISTS ix_ata_meeting_datetime ON ata(meeting_datetime);
    CREATE INDEX IF NOT EXISTS ix_report_entry_project_id ON report_entry(project_id);
    CREATE INDEX IF NOT EXISTS ix_report_entry_member_id ON report_entry(member_id);
    CREATE INDEX IF NOT EXISTS ix_report_entry_week_start ON report_entry(week_start);
    CREATE INDEX IF NOT EXISTS ix_report_entry_created_at ON report_entry(created_at);
    CREATE INDEX IF NOT EXISTS ix_report_week_goal_member_id ON report_week_goal(member_id);
    CREATE INDEX IF NOT EXISTS ix_report_week_goal_project_id ON report_week_goal(project_id);
    CREATE INDEX IF NOT EXISTS ix_report_week_goal_week_start ON report_week_goal(week_start);
    CREATE INDEX IF NOT EXISTS ix_report_week_goal_completed ON report_week_goal(is_completed);
    CREATE INDEX IF NOT EXISTS ix_report_goal_deletion_member_id ON report_week_goal_deletion_log(member_id);
    CREATE INDEX IF NOT EXISTS ix_report_goal_deletion_project_id ON report_week_goal_deletion_log(project_id);
    CREATE INDEX IF NOT EXISTS ix_report_goal_deletion_deleted_at ON report_week_goal_deletion_log(deleted_at);
    CREATE INDEX IF NOT EXISTS ix_planner_task_project_id ON planner_task(project_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_assigned_member_id ON planner_task(assigned_member_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_due_at ON planner_task(due_at);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completed ON planner_task(is_completed);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completion_log_task_id ON planner_task_completion_log(task_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completion_log_project_id ON planner_task_completion_log(project_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completion_log_member_id ON planner_task_completion_log(assigned_member_id);
    CREATE INDEX IF NOT EXISTS ix_planner_task_completion_log_completed_at ON planner_task_completion_log(completed_at);
    CREATE INDEX IF NOT EXISTS ix_estoque_name ON estoque(name);
    CREATE INDEX IF NOT EXISTS ix_estoque_item_type ON estoque(item_type);
    CREATE INDEX IF NOT EXISTS ix_estoque_category_id ON estoque(category_id);
    CREATE INDEX IF NOT EXISTS ix_estoque_location_id ON estoque(location_id);
    CREATE INDEX IF NOT EXISTS ix_pedido_usuario_id ON pedido(usuario_id);
    CREATE INDEX IF NOT EXISTS ix_pedido_estoque_id ON pedido(estoque_id);
    CREATE INDEX IF NOT EXISTS ix_inventory_category_name ON inventory_category(name);
    CREATE INDEX IF NOT EXISTS ix_inventory_location_name ON inventory_location(name);
    CREATE INDEX IF NOT EXISTS ix_inventory_loan_item_id ON inventory_loan(item_id);
    CREATE INDEX IF NOT EXISTS ix_inventory_loan_user_id ON inventory_loan(user_id);
    CREATE INDEX IF NOT EXISTS ix_inventory_loan_due_at ON inventory_loan(due_at);
    CREATE INDEX IF NOT EXISTS ix_inventory_loan_returned_at ON inventory_loan(returned_at);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_task_id ON task_audit_log(task_id);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_goal_id ON task_audit_log(report_goal_id);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_member_id ON task_audit_log(member_id);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_project_id ON task_audit_log(project_id);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_event_type ON task_audit_log(event_type);
    CREATE INDEX IF NOT EXISTS ix_task_audit_log_created_at ON task_audit_log(created_at);
  `);

  ensureColumn("ata", "location_type", "TEXT");
  ensureColumn("ata", "location_details", "TEXT");
  ensureColumn("user", "name", "TEXT");
  ensureColumn("user", "role", "TEXT NOT NULL DEFAULT 'admin'");
  ensureColumn("user", "member_id", "INTEGER");
  ensureColumn("member", "photo", "TEXT");
  ensureColumn("report_entry", "status", "TEXT NOT NULL DEFAULT 'in_progress'");
  ensureColumn("estoque", "location", "TEXT");
  ensureColumn("estoque", "category_id", "INTEGER");
  ensureColumn("estoque", "location_id", "INTEGER");
  ensureColumn("estoque", "item_type", "TEXT NOT NULL DEFAULT 'stock'");
  ensureColumn("project", "primary_color", `TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_COLOR}'`);
  ensureColumn("project_members", "is_coordinator", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("report_week_goal", "planner_task_id", "INTEGER");
  ensureColumn("report_week_goal", "goal_source", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn("planner_task", "status", "TEXT NOT NULL DEFAULT 'todo'");
  ensureColumn("planner_task", "priority", "TEXT NOT NULL DEFAULT 'medium'");
  ensureColumn("planner_task", "label", "TEXT");
  ensureColumn("planner_task", "workflow_state", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn("planner_task", "missed_at", "TEXT");
  ensureColumn("planner_task", "last_extended_at", "TEXT");
  ensureColumn("planner_task", "last_extended_by_user_id", "INTEGER");
  ensureColumn("planner_task", "recurrence_interval_days", "INTEGER");
  ensureColumn("planner_task", "recurrence_unit", "TEXT");
  ensureColumn("planner_task", "recurrence_every", "INTEGER");
  ensureColumn("planner_task", "recurrence_member_queue", "TEXT");
  ensureColumn("planner_task", "recurrence_next_index", "INTEGER");
  ensureColumn("task_audit_log", "member_id", "INTEGER");
  ensureColumn("task_audit_log", "project_id", "INTEGER");
  ensureColumn("report_week_goal", "due_at", "TEXT");
  ensureColumn("report_week_goal", "task_state", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn("report_week_goal", "completed_late", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("planner_task", "completed_late", "INTEGER NOT NULL DEFAULT 0");
  getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_status ON planner_task(status)");
  getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_priority ON planner_task(priority)");
  getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_workflow_state ON planner_task(workflow_state)");
  getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_missed_at ON planner_task(missed_at)");
  getDb().exec("CREATE INDEX IF NOT EXISTS ix_planner_task_completed_late ON planner_task(completed_late)");
  getDb().exec("CREATE INDEX IF NOT EXISTS ix_report_week_goal_due_at ON report_week_goal(due_at)");
  getDb().exec("CREATE INDEX IF NOT EXISTS ix_report_week_goal_task_state ON report_week_goal(task_state)");
  getDb().exec("CREATE INDEX IF NOT EXISTS ix_report_week_goal_completed_late ON report_week_goal(completed_late)");
  getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_project_members_project_coordinator ON project_members(project_id, is_coordinator)",
  );
  getDb().exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_report_week_goal_planner_task_id ON report_week_goal(planner_task_id) WHERE planner_task_id IS NOT NULL",
  );

  db.prepare(
    `
    UPDATE estoque
    SET item_type = CASE
      WHEN item_type IN ('stock', 'patrimony') THEN item_type
      ELSE 'stock'
    END
  `,
  ).run();

  db.prepare(
    `
    UPDATE user
    SET
      name = COALESCE(NULLIF(TRIM(name), ''), username),
      role = CASE
        WHEN role IN ('admin', 'common') THEN role
        ELSE 'admin'
      END
  `,
  ).run();

  db.prepare(
    `
    UPDATE planner_task
    SET
      status = CASE
        WHEN status IN ('todo', 'in_progress', 'done') THEN status
        ELSE 'todo'
      END,
      priority = CASE
        WHEN priority IN ('low', 'medium', 'high', 'urgent') THEN priority
        ELSE 'medium'
      END,
      recurrence_unit = CASE
        WHEN recurrence_unit IN ('days', 'weeks', 'months') THEN recurrence_unit
        ELSE NULL
      END,
      workflow_state = CASE
        WHEN workflow_state IN ('active', 'missed') THEN workflow_state
        ELSE 'active'
      END,
      completed_late = CASE
        WHEN completed_late IN (0, 1) THEN completed_late
        ELSE 0
      END,
      recurrence_every = CASE
        WHEN recurrence_every IS NOT NULL AND recurrence_every >= 1 THEN recurrence_every
        ELSE NULL
      END
  `,
  ).run();

  db.exec(`
    INSERT INTO inventory_category (name)
    SELECT DISTINCT TRIM(category)
    FROM estoque
    WHERE category IS NOT NULL AND TRIM(category) <> ''
    ON CONFLICT (name) DO NOTHING;

    INSERT INTO inventory_location (name)
    SELECT DISTINCT TRIM(location)
    FROM estoque
    WHERE location IS NOT NULL AND TRIM(location) <> ''
    ON CONFLICT (name) DO NOTHING;
  `);

  db.prepare(
    `
    UPDATE estoque
    SET category_id = (
      SELECT ic.id
      FROM inventory_category ic
      WHERE LOWER(ic.name) = LOWER(estoque.category)
      LIMIT 1
    )
    WHERE category_id IS NULL
      AND category IS NOT NULL
      AND TRIM(category) <> ''
  `,
  ).run();

  db.prepare(
    `
    UPDATE estoque
    SET location_id = (
      SELECT il.id
      FROM inventory_location il
      WHERE LOWER(il.name) = LOWER(estoque.location)
      LIMIT 1
    )
    WHERE location_id IS NULL
      AND location IS NOT NULL
      AND TRIM(location) <> ''
  `,
  ).run();

  db.prepare(
    `
    UPDATE project
    SET primary_color = CASE
      WHEN primary_color ~* '^#[0-9a-f]{6}$' THEN LOWER(primary_color)
      ELSE ?
    END
  `,
  ).run(DEFAULT_PROJECT_COLOR);

  db.prepare(
    `
    UPDATE report_entry
    SET status = CASE
      WHEN status IN ('completed', 'in_progress', 'blocked') THEN status
      ELSE 'in_progress'
    END
  `,
  ).run();

  db.prepare(
    `
    UPDATE report_week_goal
    SET goal_source = CASE
      WHEN goal_source IN ('manual', 'planner') THEN goal_source
      ELSE 'manual'
    END
  `,
  ).run();

  db.prepare(
    `
    UPDATE report_week_goal
    SET task_state = CASE
      WHEN task_state IN ('active', 'missed') THEN task_state
      ELSE 'active'
    END
  `,
  ).run();

  db.prepare(
    `
    UPDATE report_week_goal
    SET completed_late = CASE
      WHEN completed_late IN (0, 1) THEN completed_late
      ELSE 0
    END
  `,
  ).run();
}

// SECAO: transacoes e mapeadores de linhas (SQL -> objetos de dominio).

// FUNCAO: withTransaction.
function withTransaction(callback) {
  const db = getDb();
  db.exec("BEGIN");

  try {
    const result = callback(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      console.error("Falha ao fazer rollback:", rollbackError);
    }
    throw error;
  }
}

// FUNCAO: mapMember.
function mapMember(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    photo: row.photo || null,
    is_active: Boolean(row.is_active),
    is_coordinator: Boolean(row.is_coordinator),
  };
}

// FUNCAO: mapUser.
function mapUser(row) {
  if (!row) {
    return null;
  }

  const role = USER_ROLES.has(row.role) ? row.role : "admin";
  return {
    id: row.id,
    username: row.username,
    password_hash: row.password_hash,
    name: row.name || row.username,
    member_id: row.member_id || null,
    member_name: row.member_name || null,
    role,
    is_admin: role === "admin",
  };
}

// FUNCAO: mapProject.
function mapProject(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    logo: row.logo || null,
    primary_color: normalizeProjectColor(row.primary_color),
  };
}

// FUNCAO: mapAta.
function mapAta(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    meeting_datetime: row.meeting_datetime,
    location_type: row.location_type || null,
    location_details: row.location_details || null,
    notes: row.notes || "",
    created_at: row.created_at || null,
    project_id: row.project_id,
  };
}

// FUNCAO: mapReportEntry.
function mapReportEntry(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    project_id: row.project_id,
    member_id: row.member_id,
    created_by_user_id: row.created_by_user_id || null,
    week_start: row.week_start,
    status: normalizeReportStatus(row.status),
    content: row.content || "",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    project: {
      id: row.project_id,
      name: row.project_name,
      logo: row.project_logo || null,
      primary_color: normalizeProjectColor(row.project_primary_color),
    },
    member: {
      id: row.member_id,
      name: row.member_name,
      photo: row.member_photo || null,
      is_active: Boolean(row.member_is_active),
    },
    created_by_user: row.created_by_user_id
      ? {
          id: row.created_by_user_id,
          username: row.created_by_username,
          name: row.created_by_name || row.created_by_username,
        }
      : null,
  };
}

// FUNCAO: mapReportWeekGoal.
function mapReportWeekGoal(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    member_id: row.member_id,
    project_id: row.project_id,
    created_by_user_id: row.created_by_user_id || null,
    week_start: row.week_start,
    due_at: row.due_at || null,
    activity: row.activity || "",
    description: row.description || "",
    planner_task_id: row.planner_task_id || null,
    goal_source: row.goal_source === "planner" ? "planner" : "manual",
    task_state: normalizePlannerWorkflowState(row.task_state),
    is_completed: Boolean(row.is_completed),
    completed_at: row.completed_at || null,
    completed_late: Boolean(row.completed_late),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    project: {
      id: row.project_id,
      name: row.project_name,
      logo: row.project_logo || null,
      primary_color: normalizeProjectColor(row.project_primary_color),
    },
    member: {
      id: row.member_id,
      name: row.member_name,
      photo: row.member_photo || null,
      is_active: Boolean(row.member_is_active),
    },
    created_by_user: row.created_by_user_id
      ? {
          id: row.created_by_user_id,
          username: row.created_by_username,
          name: row.created_by_name || row.created_by_username,
        }
      : null,
  };
}

// FUNCAO: mapPlannerTask.
function mapPlannerTask(row) {
  if (!row) {
    return null;
  }

  const recurrenceQueue = String(row.recurrence_member_queue || "")
    .split(",")
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);

  return {
    id: row.id,
    project_id: row.project_id,
    assigned_member_id: row.assigned_member_id,
    created_by_user_id: row.created_by_user_id,
    title: row.title || "",
    description: row.description || "",
    status: normalizePlannerStatus(row.status),
    priority: normalizePlannerPriority(row.priority),
    label: row.label || null,
    due_at: row.due_at,
    is_completed: Boolean(row.is_completed),
    completed_at: row.completed_at || null,
    completed_late: Boolean(row.completed_late),
    workflow_state: normalizePlannerWorkflowState(row.workflow_state),
    missed_at: row.missed_at || null,
    last_extended_at: row.last_extended_at || null,
    last_extended_by_user_id: row.last_extended_by_user_id || null,
    recurrence_interval_days:
      row.recurrence_interval_days === null || row.recurrence_interval_days === undefined
        ? null
        : Number(row.recurrence_interval_days),
    recurrence_unit: normalizePlannerRecurrenceUnit(row.recurrence_unit),
    recurrence_every:
      row.recurrence_every === null || row.recurrence_every === undefined
        ? null
        : Number(row.recurrence_every),
    recurrence_member_queue: recurrenceQueue,
    recurrence_next_index:
      row.recurrence_next_index === null || row.recurrence_next_index === undefined
        ? null
        : Number(row.recurrence_next_index),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    project: {
      id: row.project_id,
      name: row.project_name,
      logo: row.project_logo || null,
      primary_color: normalizeProjectColor(row.project_primary_color),
    },
    member: {
      id: row.assigned_member_id,
      name: row.member_name,
      photo: row.member_photo || null,
      is_active: Boolean(row.member_is_active),
    },
    created_by_user: row.created_by_user_id
      ? {
          id: row.created_by_user_id,
          username: row.created_by_username || null,
          name: row.created_by_name || row.created_by_username || null,
        }
      : null,
  };
}

// FUNCAO: mapPlannerTaskCompletionLog.
function mapPlannerTaskCompletionLog(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    task_id: row.task_id,
    project_id: row.project_id,
    assigned_member_id: row.assigned_member_id,
    completed_by_user_id: row.completed_by_user_id,
    title: row.title || "",
    description: row.description || "",
    status: normalizePlannerStatus(row.status),
    priority: normalizePlannerPriority(row.priority),
    label: row.label || null,
    due_at: row.due_at || null,
    completed_at: row.completed_at || null,
    project_name: row.project_name || null,
    member_name: row.member_name || null,
    member_photo: row.member_photo || null,
    completed_by_name: row.completed_by_name || row.completed_by_username || null,
    completed_by_username: row.completed_by_username || null,
  };
}

// FUNCAO: mapReportWeekGoalDeletionLog.
function mapReportWeekGoalDeletionLog(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    goal_id: row.goal_id,
    member_id: row.member_id,
    project_id: row.project_id,
    deleted_by_user_id: row.deleted_by_user_id,
    week_start: row.week_start,
    activity: row.activity || "",
    description: row.description || "",
    completed_at: row.completed_at || null,
    deleted_at: row.deleted_at || null,
    member_name: row.member_name || null,
    project_name: row.project_name || null,
    deleted_by_name: row.deleted_by_name || row.deleted_by_username || null,
    deleted_by_username: row.deleted_by_username || null,
  };
}

// FUNCAO: mapInventoryCatalog.
function mapInventoryCatalog(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
  };
}

// FUNCAO: mapInventoryItem.
function mapInventoryItem(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    item_type: normalizeInventoryType(row.item_type),
    category: row.category || "",
    category_id: row.category_id || null,
    location: row.location || "",
    location_id: row.location_id || null,
    amount: row.amount,
    description: row.description || "",
  };
}

// FUNCAO: mapInventoryLoan.
function mapInventoryLoan(row) {
  if (!row) {
    return null;
  }

  const returnedAt = row.returned_at || null;
  const dueAt = row.due_at;
  const isOverdue =
    !returnedAt &&
    Boolean(dueAt) &&
    new Date(dueAt.replace(" ", "T")) < new Date();

  return {
    id: row.id,
    item_id: row.item_id,
    user_id: row.user_id,
    quantity: row.quantity,
    borrowed_at: row.borrowed_at,
    original_due_at: row.original_due_at,
    due_at: dueAt,
    returned_at: returnedAt,
    extended_at: row.extended_at || null,
    extended_by_user_id: row.extended_by_user_id || null,
    returned_by_user_id: row.returned_by_user_id || null,
    item_name: row.item_name,
    item_type: normalizeInventoryType(row.item_type),
    item_category: row.item_category || "",
    user_name: row.user_name || row.user_username,
    user_username: row.user_username,
    user_role: row.user_role,
    extended_by_name: row.extended_by_name || null,
    returned_by_name: row.returned_by_name || null,
    is_overdue: isOverdue,
    status: returnedAt ? "returned" : isOverdue ? "overdue" : "active",
  };
}

// SECAO: operacoes de usuarios e vinculacao com membros.

// FUNCAO: getUserById.
function getUserById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.password_hash,
        u.name,
        u.role,
        u.member_id,
        m.name AS member_name
      FROM user u
      LEFT JOIN member m ON m.id = u.member_id
      WHERE u.id = ?
    `,
    )
    .get(id);

  return mapUser(row);
}

// FUNCAO: getUserByUsername.
function getUserByUsername(username) {
  const row = getDb()
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.password_hash,
        u.name,
        u.role,
        u.member_id,
        m.name AS member_name
      FROM user u
      LEFT JOIN member m ON m.id = u.member_id
      WHERE u.username = ?
    `,
    )
    .get(username);

  return mapUser(row);
}

// FUNCAO: listUsers.
function listUsers() {
  return getDb()
    .prepare(
      `
      SELECT
        u.id,
        u.username,
        u.name,
        u.role,
        u.member_id,
        m.name AS member_name
      FROM user u
      LEFT JOIN member m ON m.id = u.member_id
      ORDER BY LOWER(COALESCE(u.name, u.username)), LOWER(u.username)
    `,
    )
    .all()
    .map(mapUser);
}

// FUNCAO: createUser.
function createUser(
  username,
  passwordHash,
  { name = null, role = "admin", memberId = null } = {},
) {
  const db = getDb();
  const normalizedRole = USER_ROLES.has(role) ? role : "common";
  const result = db
    .prepare(
      `
      INSERT INTO user (username, password_hash, name, role, member_id)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `,
    ).run(username, passwordHash, name || username, normalizedRole, memberId);

  return getUserById(result.lastInsertRowid);
}

// FUNCAO: setUserMemberLink.
function setUserMemberLink(userId, memberId = null) {
  const db = getDb();
  const current = getUserById(userId);
  if (!current) {
    return null;
  }

  db.prepare("UPDATE user SET member_id = ? WHERE id = ?").run(memberId, userId);
  return getUserById(userId);
}

// FUNCAO: updateUserPassword.
function updateUserPassword(userId, passwordHash) {
  const current = getUserById(userId);
  if (!current) {
    return null;
  }

  getDb()
    .prepare("UPDATE user SET password_hash = ? WHERE id = ?")
    .run(passwordHash, userId);
  return getUserById(userId);
}

// FUNCAO: deleteUser.
function deleteUser(userId) {
  return withTransaction((db) => {
    const current = getUserById(userId);
    if (!current) {
      return { deleted: false, reason: "not_found" };
    }

    const requestCount = Number(
      db.prepare("SELECT COUNT(*) AS total FROM pedido WHERE usuario_id = ?").get(userId)
        ?.total || 0,
    );
    const loanCount = Number(
      db.prepare("SELECT COUNT(*) AS total FROM inventory_loan WHERE user_id = ?").get(userId)
        ?.total || 0,
    );

    if (requestCount > 0 || loanCount > 0) {
      return {
        deleted: false,
        reason: "has_history",
        requestCount,
        loanCount,
      };
    }

    db.prepare(
      "UPDATE report_entry SET created_by_user_id = NULL WHERE created_by_user_id = ?",
    ).run(userId);
    db.prepare(
      "UPDATE report_week_goal SET created_by_user_id = NULL WHERE created_by_user_id = ?",
    ).run(userId);
    db.prepare(
      "UPDATE inventory_loan SET extended_by_user_id = NULL WHERE extended_by_user_id = ?",
    ).run(userId);
    db.prepare(
      "UPDATE inventory_loan SET returned_by_user_id = NULL WHERE returned_by_user_id = ?",
    ).run(userId);
    db.prepare(
      "DELETE FROM report_week_goal_deletion_log WHERE deleted_by_user_id = ?",
    ).run(userId);
    db.prepare("DELETE FROM user WHERE id = ?").run(userId);

    return { deleted: true, user: current };
  });
}

// SECAO: tabelas auxiliares do almoxarifado (categorias e locais).

// FUNCAO: listInventoryCategories.
function listInventoryCategories() {
  return getDb()
    .prepare(
      `
      SELECT id, name
      FROM inventory_category
      ORDER BY LOWER(name), id
    `,
    )
    .all()
    .map(mapInventoryCatalog);
}

// FUNCAO: getInventoryCategoryById.
function getInventoryCategoryById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT id, name
      FROM inventory_category
      WHERE id = ?
    `,
    )
    .get(id);

  return mapInventoryCatalog(row);
}

// FUNCAO: createInventoryCategory.
function createInventoryCategory(name) {
  const db = getDb();
  const result = db
    .prepare(
      `
      INSERT INTO inventory_category (name)
      VALUES (?)
      RETURNING id
    `,
    )
    .run(name);

  return getInventoryCategoryById(result.lastInsertRowid);
}

// FUNCAO: updateInventoryCategory.
function updateInventoryCategory(id, name) {
  return withTransaction((db) => {
    const current = db
      .prepare(
        `
        SELECT id, name
        FROM inventory_category
        WHERE id = ?
      `,
      )
      .get(id);

    if (!current) {
      return null;
    }

    db.prepare("UPDATE inventory_category SET name = ? WHERE id = ?").run(name, id);
    db.prepare(
      `
      UPDATE estoque
      SET category = ?
      WHERE category_id = ?
    `,
    ).run(name, id);

    return getInventoryCategoryById(id);
  });
}

// FUNCAO: deleteInventoryCategory.
function deleteInventoryCategory(id) {
  return withTransaction((db) => {
    const current = db
      .prepare(
        `
        SELECT id, name
        FROM inventory_category
        WHERE id = ?
      `,
      )
      .get(id);

    if (!current) {
      return null;
    }

    db.prepare(
      `
      UPDATE estoque
      SET category_id = NULL
      WHERE category_id = ?
    `,
    ).run(id);

    db.prepare("DELETE FROM inventory_category WHERE id = ?").run(id);
    return mapInventoryCatalog(current);
  });
}

// FUNCAO: listInventoryLocations.
function listInventoryLocations() {
  return getDb()
    .prepare(
      `
      SELECT id, name
      FROM inventory_location
      ORDER BY LOWER(name), id
    `,
    )
    .all()
    .map(mapInventoryCatalog);
}

// FUNCAO: getInventoryLocationById.
function getInventoryLocationById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT id, name
      FROM inventory_location
      WHERE id = ?
    `,
    )
    .get(id);

  return mapInventoryCatalog(row);
}

// FUNCAO: createInventoryLocation.
function createInventoryLocation(name) {
  const db = getDb();
  const result = db
    .prepare(
      `
      INSERT INTO inventory_location (name)
      VALUES (?)
      RETURNING id
    `,
    )
    .run(name);

  return getInventoryLocationById(result.lastInsertRowid);
}

// FUNCAO: updateInventoryLocation.
function updateInventoryLocation(id, name) {
  return withTransaction((db) => {
    const current = db
      .prepare(
        `
        SELECT id, name
        FROM inventory_location
        WHERE id = ?
      `,
      )
      .get(id);

    if (!current) {
      return null;
    }

    db.prepare("UPDATE inventory_location SET name = ? WHERE id = ?").run(name, id);
    db.prepare(
      `
      UPDATE estoque
      SET location = ?
      WHERE location_id = ?
    `,
    ).run(name, id);

    return getInventoryLocationById(id);
  });
}

// FUNCAO: deleteInventoryLocation.
function deleteInventoryLocation(id) {
  return withTransaction((db) => {
    const current = db
      .prepare(
        `
        SELECT id, name
        FROM inventory_location
        WHERE id = ?
      `,
      )
      .get(id);

    if (!current) {
      return null;
    }

    db.prepare(
      `
      UPDATE estoque
      SET location_id = NULL
      WHERE location_id = ?
    `,
    ).run(id);

    db.prepare("DELETE FROM inventory_location WHERE id = ?").run(id);
    return mapInventoryCatalog(current);
  });
}

// FUNCAO: resolveInventoryCatalogEntry.
function resolveInventoryCatalogEntry({
  db,
  table,
  id,
  name,
}) {
  const normalizedName = trimCatalogValue(name);
  const numericId = Number.isInteger(Number(id)) ? Number(id) : null;

  if (numericId) {
    const row = db
      .prepare(`SELECT id, name FROM ${table} WHERE id = ?`)
      .get(numericId);

    if (row) {
      return mapInventoryCatalog(row);
    }
  }

  if (!normalizedName) {
    return null;
  }

  const existing = db
    .prepare(`SELECT id, name FROM ${table} WHERE LOWER(name) = LOWER(?)`)
    .get(normalizedName);
  if (existing) {
    return mapInventoryCatalog(existing);
  }

  const result = db
    .prepare(`INSERT INTO ${table} (name) VALUES (?) RETURNING id`)
    .run(normalizedName);

  return mapInventoryCatalog({
    id: Number(result.lastInsertRowid),
    name: normalizedName,
  });
}

// FUNCAO: trimCatalogValue.
function trimCatalogValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

// SECAO: operacoes de membros (cadastro, busca e desativacao).

// FUNCAO: listActiveMembers.
function listActiveMembers() {
  return getDb()
    .prepare(
      "SELECT id, name, photo, is_active FROM member WHERE is_active = 1 ORDER BY LOWER(name)",
    )
    .all()
    .map(mapMember);
}

// FUNCAO: getMemberById.
function getMemberById(id) {
  const row = getDb()
    .prepare("SELECT id, name, photo, is_active FROM member WHERE id = ?")
    .get(id);

  return row ? mapMember(row) : null;
}

// FUNCAO: getMemberByName.
function getMemberByName(name) {
  const normalized = String(name || "").trim();
  if (!normalized) {
    return null;
  }

  const row = getDb()
    .prepare(
      `
      SELECT id, name, photo, is_active
      FROM member
      WHERE LOWER(name) = LOWER(?)
      LIMIT 1
    `,
    )
    .get(normalized);

  return mapMember(row);
}

// FUNCAO: createMember.
function createMember(name, photo = null) {
  const db = getDb();
  const result = db
    .prepare("INSERT INTO member (name, photo, is_active) VALUES (?, ?, 1) RETURNING id")
    .run(name, photo);

  return getMemberById(result.lastInsertRowid);
}

// FUNCAO: updateMember.
function updateMember(id, { name, photo }) {
  getDb().prepare("UPDATE member SET name = ?, photo = ? WHERE id = ?").run(name, photo, id);
  return getMemberById(id);
}

// FUNCAO: deactivateMember.
function deactivateMember(id) {
  return withTransaction((db) => {
    db.prepare("UPDATE member SET is_active = 0 WHERE id = ?").run(id);
    db.prepare("DELETE FROM project_members WHERE member_id = ?").run(id);
    return getMemberById(id);
  });
}

// SECAO: operacoes de projetos e relacoes projeto-membro.

// FUNCAO: listProjectsBasic.
function listProjectsBasic() {
  return getDb()
    .prepare("SELECT id, name, logo, primary_color FROM project ORDER BY LOWER(name)")
    .all()
    .map(mapProject);
}

// FUNCAO: getProjectMembers.
function getProjectMembers(projectId, { activeOnly = false } = {}) {
  const where = activeOnly ? "AND m.is_active = 1" : "";

  return getDb()
    .prepare(
      `
      SELECT m.id, m.name, m.photo, m.is_active
      , pm.is_coordinator
      FROM member m
      INNER JOIN project_members pm ON pm.member_id = m.id
      WHERE pm.project_id = ?
      ${where}
      ORDER BY LOWER(m.name)
    `,
    )
    .all(projectId)
    .map(mapMember);
}

// FUNCAO: getProjectById.
function getProjectById(id) {
  const projectRow = getDb()
    .prepare("SELECT id, name, logo, primary_color FROM project WHERE id = ?")
    .get(id);

  if (!projectRow) {
    return null;
  }

  const project = mapProject(projectRow);
  project.members = getProjectMembers(project.id);
  project.active_members = project.members.filter((member) => member.is_active);
  project.active_member_ids = project.active_members.map((member) => member.id);
  project.coordinator_member_ids = project.members
    .filter((member) => member.is_coordinator)
    .map((member) => member.id);
  project.coordinators = project.members.filter((member) => member.is_coordinator);
  project.active_coordinators = project.active_members.filter(
    (member) => member.is_coordinator,
  );
  project.member_name_preview = firstNamesSummary(project.members);
  project.coordinator_name_preview = firstNamesSummary(project.coordinators);
  return project;
}

// FUNCAO: listProjectsWithMembers.
function listProjectsWithMembers() {
  return listProjectsBasic().map((project) => getProjectById(project.id));
}

// FUNCAO: createProject.
function createProject({ name, logo, primaryColor, memberIds, coordinatorIds = null }) {
  return withTransaction((db) => {
    const uniqueMemberIds = [...new Set(memberIds)];
    const normalizedCoordinatorIds = Array.isArray(coordinatorIds)
      ? coordinatorIds.filter((memberId) => uniqueMemberIds.includes(memberId))
      : uniqueMemberIds.slice(0, 1);
    const coordinatorIdSet = new Set(normalizedCoordinatorIds);

    const result = db
      .prepare("INSERT INTO project (name, logo, primary_color) VALUES (?, ?, ?) RETURNING id")
      .run(name, logo || null, normalizeProjectColor(primaryColor));

    const projectId = Number(result.lastInsertRowid);
    const insertMembership = db.prepare(
      "INSERT INTO project_members (project_id, member_id, is_coordinator) VALUES (?, ?, ?)",
    );

    uniqueMemberIds.forEach((memberId) => {
      insertMembership.run(projectId, memberId, coordinatorIdSet.has(memberId) ? 1 : 0);
    });

    return getProjectById(projectId);
  });
}

// FUNCAO: updateProject.
function updateProject(
  id,
  { name, logo, primaryColor, memberIds, coordinatorIds = null },
) {
  return withTransaction((db) => {
    const uniqueMemberIds = [...new Set(memberIds)];
    const normalizedCoordinatorIds = Array.isArray(coordinatorIds)
      ? coordinatorIds.filter((memberId) => uniqueMemberIds.includes(memberId))
      : uniqueMemberIds.slice(0, 1);
    const coordinatorIdSet = new Set(normalizedCoordinatorIds);

    db.prepare("UPDATE project SET name = ?, logo = ?, primary_color = ? WHERE id = ?").run(
      name,
      logo || null,
      normalizeProjectColor(primaryColor),
      id,
    );
    db.prepare("DELETE FROM project_members WHERE project_id = ?").run(id);

    const insertMembership = db.prepare(
      "INSERT INTO project_members (project_id, member_id, is_coordinator) VALUES (?, ?, ?)",
    );

    uniqueMemberIds.forEach((memberId) => {
      insertMembership.run(id, memberId, coordinatorIdSet.has(memberId) ? 1 : 0);
    });

    return getProjectById(id);
  });
}

// FUNCAO: listProjectsForMember.
function listProjectsForMember(memberId) {
  return getDb()
    .prepare(
      `
      SELECT p.id, p.name, p.logo, p.primary_color
      FROM project p
      INNER JOIN project_members pm ON pm.project_id = p.id
      WHERE pm.member_id = ?
      ORDER BY LOWER(p.name)
    `,
    )
    .all(memberId)
    .map(mapProject);
}

// FUNCAO: isProjectMember.
function isProjectMember(projectId, memberId) {
  const row = getDb()
    .prepare(
      `
      SELECT 1 AS ok
      FROM project_members
      WHERE project_id = ? AND member_id = ?
      LIMIT 1
    `,
    )
    .get(projectId, memberId);

  return Boolean(row?.ok);
}

// FUNCAO: isProjectCoordinator.
function isProjectCoordinator(projectId, memberId) {
  const row = getDb()
    .prepare(
      `
      SELECT 1 AS ok
      FROM project_members
      WHERE project_id = ? AND member_id = ? AND is_coordinator = 1
      LIMIT 1
    `,
    )
    .get(projectId, memberId);

  return Boolean(row?.ok);
}

// FUNCAO: deleteProject.
function deleteProject(id) {
  return withTransaction((db) => {
    db.prepare(
      "DELETE FROM ata_absent_justification WHERE ata_id IN (SELECT id FROM ata WHERE project_id = ?)",
    ).run(id);
    db.prepare(
      "DELETE FROM ata_present_members WHERE ata_id IN (SELECT id FROM ata WHERE project_id = ?)",
    ).run(id);
    db.prepare("DELETE FROM ata WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM project_members WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM project WHERE id = ?").run(id);
  });
}

// SECAO: operacoes de atas (consulta completa, criacao e exclusao).

// FUNCAO: listRecentAtas.
function listRecentAtas(limit = 5) {
  return getDb()
    .prepare(
      `
      SELECT
        a.id,
        a.meeting_datetime,
        a.project_id,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color
      FROM ata a
      INNER JOIN project p ON p.id = a.project_id
      ORDER BY a.meeting_datetime DESC
      LIMIT ?
    `,
    )
    .all(limit)
    .map((row) => ({
      id: row.id,
      meeting_datetime: row.meeting_datetime,
      project_id: row.project_id,
      project: {
        id: row.project_id,
        name: row.project_name,
        logo: row.project_logo || null,
        primary_color: normalizeProjectColor(row.project_primary_color),
      },
    }));
}

// FUNCAO: getAtaBaseById.
function getAtaBaseById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT
        a.id,
        a.meeting_datetime,
        a.location_type,
        a.location_details,
        a.notes,
        a.created_at,
        a.project_id,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color
      FROM ata a
      INNER JOIN project p ON p.id = a.project_id
      WHERE a.id = ?
    `,
    )
    .get(id);

  if (!row) {
    return null;
  }

  const ata = mapAta(row);
  ata.project = {
    id: row.project_id,
    name: row.project_name,
    logo: row.project_logo || null,
    primary_color: normalizeProjectColor(row.project_primary_color),
  };
  return ata;
}

// FUNCAO: getAtaPresentMembers.
function getAtaPresentMembers(ataId) {
  return getDb()
    .prepare(
      `
      SELECT m.id, m.name, m.photo, m.is_active
      FROM member m
      INNER JOIN ata_present_members apm ON apm.member_id = m.id
      WHERE apm.ata_id = ?
      ORDER BY LOWER(m.name)
    `,
    )
    .all(ataId)
    .map(mapMember);
}

// FUNCAO: getAtaAbsentJustifications.
function getAtaAbsentJustifications(ataId) {
  const rows = getDb()
    .prepare(
      `
      SELECT aj.member_id, aj.justification, m.name
      FROM ata_absent_justification aj
      INNER JOIN member m ON m.id = aj.member_id
      WHERE aj.ata_id = ?
      ORDER BY LOWER(m.name)
    `,
    )
    .all(ataId);

  const dictionary = {};
  rows.forEach((row) => {
    dictionary[row.member_id] = row.justification;
  });

  return {
    rows,
    dictionary,
  };
}

// FUNCAO: getAtaById.
function getAtaById(id) {
  const ata = getAtaBaseById(id);
  if (!ata) {
    return null;
  }

  ata.present_members = getAtaPresentMembers(id);
  const project = getProjectById(ata.project_id);
  const presentMemberIds = new Set(ata.present_members.map((member) => member.id));
  ata.absent_members = project.members.filter(
    (member) => !presentMemberIds.has(member.id),
  );

  const justifications = getAtaAbsentJustifications(id);
  ata.absent_justifications = justifications.rows;
  ata.absent_justifications_dict = justifications.dictionary;

  return ata;
}

// FUNCAO: createAta.
function createAta({ projectId, meetingDateTime, notes, presentMemberIds, justifications }) {
  return withTransaction((db) => {
    const result = db
      .prepare(
        `
        INSERT INTO ata (meeting_datetime, location_type, location_details, notes, created_at, project_id)
        VALUES (?, NULL, NULL, ?, CURRENT_TIMESTAMP, ?)
        RETURNING id
      `,
      )
      .run(meetingDateTime, notes, projectId);

    const ataId = Number(result.lastInsertRowid);
    const insertPresent = db.prepare(
      "INSERT INTO ata_present_members (ata_id, member_id) VALUES (?, ?)",
    );
    presentMemberIds.forEach((memberId) => {
      insertPresent.run(ataId, memberId);
    });

    const insertJustification = db.prepare(
      `
      INSERT INTO ata_absent_justification (ata_id, member_id, justification)
      VALUES (?, ?, ?)
    `,
    );

    Object.entries(justifications).forEach(([memberId, justification]) => {
      insertJustification.run(ataId, Number(memberId), justification);
    });

    return getAtaById(ataId);
  });
}

// FUNCAO: deleteAta.
function deleteAta(id) {
  return withTransaction((db) => {
    db.prepare("DELETE FROM ata_absent_justification WHERE ata_id = ?").run(id);
    db.prepare("DELETE FROM ata_present_members WHERE ata_id = ?").run(id);
    db.prepare("DELETE FROM ata WHERE id = ?").run(id);
  });
}

// SECAO: operacoes de relatorios semanais.

// FUNCAO: createReportEntry.
function createReportEntry({
  projectId,
  memberId,
  createdByUserId = null,
  weekStart,
  status = "in_progress",
  content,
}) {
  const result = getDb()
    .prepare(
      `
      INSERT INTO report_entry (
        project_id,
        member_id,
        created_by_user_id,
        week_start,
        status,
        content
      )
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `,
    )
    .run(
      projectId,
      memberId,
      createdByUserId,
      weekStart,
      normalizeReportStatus(status),
      content,
    );

  return getReportEntryById(result.lastInsertRowid);
}

// FUNCAO: updateReportEntry.
function updateReportEntry(id, { content, status = "in_progress" }) {
  const db = getDb();
  const existing = getReportEntryById(id);
  if (!existing) {
    return null;
  }

  db.prepare(
    `
    UPDATE report_entry
    SET
      week_start = ?,
      status = ?,
      content = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(existing.week_start, normalizeReportStatus(status), content, id);

  return getReportEntryById(id);
}

// FUNCAO: deleteReportEntry.
function deleteReportEntry(id) {
  const existing = getReportEntryById(id);
  if (!existing) {
    return null;
  }

  getDb().prepare("DELETE FROM report_entry WHERE id = ?").run(id);
  return existing;
}

// FUNCAO: getReportEntryById.
function getReportEntryById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT
        r.id,
        r.project_id,
        r.member_id,
        r.created_by_user_id,
        r.week_start,
        r.status,
        r.content,
        r.created_at,
        r.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_entry r
      INNER JOIN project p ON p.id = r.project_id
      INNER JOIN member m ON m.id = r.member_id
      LEFT JOIN user u ON u.id = r.created_by_user_id
      WHERE r.id = ?
    `,
    )
    .get(id);

  return mapReportEntry(row);
}

// FUNCAO: listReportEntries.
function listReportEntries({
  memberId = null,
  projectId = null,
  weekStart = null,
  status = null,
  limit = 200,
} = {}) {
  const where = [];
  const params = [];

  if (memberId) {
    where.push("r.member_id = ?");
    params.push(memberId);
  }

  if (projectId) {
    where.push("r.project_id = ?");
    params.push(projectId);
  }

  if (weekStart) {
    where.push("r.week_start = ?");
    params.push(weekStart);
  }

  if (REPORT_STATUSES.has(status)) {
    where.push("r.status = ?");
    params.push(status);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return getDb()
    .prepare(
      `
      SELECT
        r.id,
        r.project_id,
        r.member_id,
        r.created_by_user_id,
        r.week_start,
        r.status,
        r.content,
        r.created_at,
        r.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_entry r
      INNER JOIN project p ON p.id = r.project_id
      INNER JOIN member m ON m.id = r.member_id
      LEFT JOIN user u ON u.id = r.created_by_user_id
      ${whereClause}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit)
    .map(mapReportEntry);
}

// FUNCAO: listReportProjectsForMember.
function listReportProjectsForMember(memberId, { weekStart = null, status = null } = {}) {
  const where = ["r.member_id = ?"];
  const params = [memberId];
  if (weekStart) {
    where.push("r.week_start = ?");
    params.push(weekStart);
  }
  if (REPORT_STATUSES.has(status)) {
    where.push("r.status = ?");
    params.push(status);
  }

  return getDb()
    .prepare(
      `
      SELECT DISTINCT p.id, p.name, p.logo, p.primary_color
      FROM report_entry r
      INNER JOIN project p ON p.id = r.project_id
      WHERE ${where.join(" AND ")}
      ORDER BY LOWER(p.name)
    `,
    )
    .all(...params)
    .map(mapProject);
}

// FUNCAO: listReportWeeksForMember.
function listReportWeeksForMember(memberId, { projectId = null, status = null } = {}) {
  const where = ["member_id = ?"];
  const params = [memberId];
  if (projectId) {
    where.push("project_id = ?");
    params.push(projectId);
  }
  if (REPORT_STATUSES.has(status)) {
    where.push("status = ?");
    params.push(status);
  }

  return getDb()
    .prepare(
      `
      SELECT DISTINCT week_start
      FROM report_entry
      WHERE ${where.join(" AND ")}
      ORDER BY week_start DESC
    `,
    )
    .all(...params)
    .map((row) => row.week_start);
}

// FUNCAO: listReportMembersSummary.
function listReportMembersSummary() {
  return getDb()
    .prepare(
      `
      SELECT
        m.id,
        m.name,
        m.photo,
        m.is_active,
        COUNT(r.id) AS total_entries,
        MAX(r.created_at) AS last_created_at
      FROM member m
      LEFT JOIN report_entry r ON r.member_id = m.id
      GROUP BY m.id, m.name, m.photo, m.is_active
      ORDER BY
        CASE WHEN COUNT(r.id) > 0 THEN 0 ELSE 1 END,
        LOWER(m.name)
    `,
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      photo: row.photo || null,
      is_active: Boolean(row.is_active),
      total_entries: row.total_entries || 0,
      last_created_at: row.last_created_at || null,
    }));
}

// FUNCAO: createReportWeekGoal.
function createReportWeekGoal({
  memberId,
  projectId,
  createdByUserId = null,
  weekStart,
  dueAt = null,
  activity,
  description = "",
  plannerTaskId = null,
  goalSource = "manual",
  taskState = "active",
  isCompleted = false,
  completedLate = false,
}) {
  const result = getDb()
    .prepare(
      `
      INSERT INTO report_week_goal (
        member_id,
        project_id,
        created_by_user_id,
        week_start,
        due_at,
        activity,
        description,
        planner_task_id,
        goal_source,
        task_state,
        is_completed,
        completed_at,
        completed_late
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CAST(CURRENT_TIMESTAMP AS TEXT) ELSE NULL END, ?)
      RETURNING id
    `,
    )
    .run(
      memberId,
      projectId,
      createdByUserId,
      weekStart,
      dueAt,
      activity,
      description,
      plannerTaskId,
      goalSource === "planner" ? "planner" : "manual",
      normalizePlannerWorkflowState(taskState),
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      completedLate ? 1 : 0,
    );

  return getReportWeekGoalById(result.lastInsertRowid);
}

// FUNCAO: getReportWeekGoalById.
function getReportWeekGoalById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT
        g.id,
        g.member_id,
        g.project_id,
        g.created_by_user_id,
        g.week_start,
        g.due_at,
        g.activity,
        g.description,
        g.planner_task_id,
        g.goal_source,
        g.task_state,
        COALESCE(t.status, CASE WHEN g.is_completed = 1 THEN 'done' ELSE 'todo' END) AS task_status,
        g.is_completed,
        g.completed_at,
        g.completed_late,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_week_goal g
      INNER JOIN project p ON p.id = g.project_id
      INNER JOIN member m ON m.id = g.member_id
      LEFT JOIN planner_task t ON t.id = g.planner_task_id
      LEFT JOIN user u ON u.id = g.created_by_user_id
      WHERE g.id = ?
      LIMIT 1
    `,
    )
    .get(id);

  return mapReportWeekGoal(row);
}

// FUNCAO: getReportWeekGoalByPlannerTaskId.
function getReportWeekGoalByPlannerTaskId(plannerTaskId) {
  const row = getDb()
    .prepare(
      `
      SELECT
        g.id,
        g.member_id,
        g.project_id,
        g.created_by_user_id,
        g.week_start,
        g.due_at,
        g.activity,
        g.description,
        g.planner_task_id,
        g.goal_source,
        g.task_state,
        g.is_completed,
        g.completed_at,
        g.completed_late,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_week_goal g
      INNER JOIN project p ON p.id = g.project_id
      INNER JOIN member m ON m.id = g.member_id
      LEFT JOIN user u ON u.id = g.created_by_user_id
      WHERE g.planner_task_id = ?
      LIMIT 1
    `,
    )
    .get(plannerTaskId);

  return mapReportWeekGoal(row);
}

// FUNCAO: syncReportWeekGoalFromPlannerTask.
function syncReportWeekGoalFromPlannerTask(
  plannerTask,
  { createdByUserId = null } = {},
) {
  if (!plannerTask?.id || !plannerTask?.assigned_member_id || !plannerTask?.project_id) {
    return null;
  }

  const weekStart = resolveFortnightStartFromSqlDateTime(plannerTask.due_at);
  const activity = String(plannerTask.title || "").trim();
  if (!weekStart || !activity) {
    return null;
  }

  const description = String(plannerTask.description || "").trim();
  const ownerUserId = createdByUserId || plannerTask.created_by_user_id || null;
  const isCompleted = Boolean(plannerTask.is_completed);
  const completedLate = Boolean(plannerTask.completed_late);

  return withTransaction((db) => {
    const existing = db
      .prepare(
        `
        SELECT id
        FROM report_week_goal
        WHERE planner_task_id = ?
        LIMIT 1
      `,
      )
      .get(plannerTask.id);

    if (existing?.id) {
      db.prepare(
        `
        UPDATE report_week_goal
        SET
          member_id = ?,
          project_id = ?,
          week_start = ?,
          due_at = ?,
          activity = ?,
          description = ?,
          task_state = ?,
          is_completed = ?,
          completed_at = CASE
            WHEN ? = 1 THEN COALESCE(CAST(? AS TEXT), completed_at, CAST(CURRENT_TIMESTAMP AS TEXT))
            ELSE NULL
          END,
          completed_late = ?,
          goal_source = 'planner',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      ).run(
        plannerTask.assigned_member_id,
        plannerTask.project_id,
        weekStart,
        plannerTask.due_at,
        activity,
        description,
        normalizePlannerWorkflowState(plannerTask.workflow_state),
        isCompleted ? 1 : 0,
        isCompleted ? 1 : 0,
        plannerTask.completed_at || null,
        completedLate ? 1 : 0,
        existing.id,
      );

      if (ownerUserId) {
        db.prepare(
          `
          UPDATE report_week_goal
          SET created_by_user_id = COALESCE(created_by_user_id, ?)
          WHERE id = ?
        `,
        ).run(ownerUserId, existing.id);
      }

      return getReportWeekGoalById(existing.id);
    }

    const inserted = db.prepare(
      `
      INSERT INTO report_week_goal (
        member_id,
        project_id,
        created_by_user_id,
        week_start,
        due_at,
        activity,
        description,
        planner_task_id,
        goal_source,
        task_state,
        is_completed,
        completed_at,
        completed_late
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planner', ?, ?, CASE WHEN ? = 1 THEN COALESCE(CAST(? AS TEXT), CAST(CURRENT_TIMESTAMP AS TEXT)) ELSE NULL END, ?)
      RETURNING id
    `,
    ).run(
      plannerTask.assigned_member_id,
      plannerTask.project_id,
      ownerUserId,
      weekStart,
      plannerTask.due_at,
      activity,
      description,
      plannerTask.id,
      normalizePlannerWorkflowState(plannerTask.workflow_state),
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      plannerTask.completed_at || null,
      completedLate ? 1 : 0,
    );

    return getReportWeekGoalById(inserted.lastInsertRowid);
  });
}

// FUNCAO: updateReportWeekGoal.
function updateReportWeekGoal(
  id,
  {
    activity,
    description,
    isCompleted = false,
    dueAt = null,
    taskState = null,
    completedLate = null,
  },
) {
  const existing = getReportWeekGoalById(id);
  if (!existing) {
    return null;
  }

  getDb()
    .prepare(
      `
      UPDATE report_week_goal
      SET
        activity = ?,
        description = ?,
        due_at = COALESCE(?, due_at),
        task_state = CASE
          WHEN ? IS NULL THEN task_state
          ELSE ?
        END,
        is_completed = ?,
        completed_at = CASE WHEN ? = 1 THEN CAST(CURRENT_TIMESTAMP AS TEXT) ELSE NULL END,
        completed_late = CASE
          WHEN ? IS NULL THEN completed_late
          WHEN ? = 1 THEN 1
          ELSE 0
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )
    .run(
      activity,
      description,
      dueAt,
      taskState ? normalizePlannerWorkflowState(taskState) : null,
      taskState ? normalizePlannerWorkflowState(taskState) : null,
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      completedLate === null ? null : (completedLate ? 1 : 0),
      completedLate ? 1 : 0,
      id,
    );

  return getReportWeekGoalById(id);
}

// FUNCAO: deleteReportWeekGoal.
function deleteReportWeekGoal(id) {
  const existing = getReportWeekGoalById(id);
  if (!existing) {
    return null;
  }

  getDb().prepare("DELETE FROM report_week_goal WHERE id = ?").run(id);
  return existing;
}

// FUNCAO: deleteReportWeekGoalWithAudit.
function deleteReportWeekGoalWithAudit(id, deletedByUserId) {
  return withTransaction((db) => {
    const existing = getReportWeekGoalById(id);
    if (!existing) {
      return null;
    }

    db.prepare(
      `
      INSERT INTO report_week_goal_deletion_log (
        goal_id,
        member_id,
        project_id,
        deleted_by_user_id,
        week_start,
        activity,
        description,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      existing.id,
      existing.member_id,
      existing.project_id,
      deletedByUserId,
      existing.week_start,
      existing.activity,
      existing.description || "",
      existing.completed_at,
    );

    db.prepare("DELETE FROM report_week_goal WHERE id = ?").run(id);
    return existing;
  });
}

// FUNCAO: listReportWeekGoalDeletionLogsForMember.
function listReportWeekGoalDeletionLogsForMember(
  memberId,
  { projectId = null, limit = 30 } = {},
) {
  const where = ["l.member_id = ?"];
  const params = [memberId];

  if (projectId) {
    where.push("l.project_id = ?");
    params.push(projectId);
  }

  return getDb()
    .prepare(
      `
      SELECT
        l.id,
        l.goal_id,
        l.member_id,
        l.project_id,
        l.deleted_by_user_id,
        l.week_start,
        l.activity,
        l.description,
        l.completed_at,
        l.deleted_at,
        m.name AS member_name,
        p.name AS project_name,
        u.username AS deleted_by_username,
        u.name AS deleted_by_name
      FROM report_week_goal_deletion_log l
      INNER JOIN member m ON m.id = l.member_id
      INNER JOIN project p ON p.id = l.project_id
      INNER JOIN user u ON u.id = l.deleted_by_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.deleted_at DESC, l.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit)
    .map(mapReportWeekGoalDeletionLog);
}

// FUNCAO: listReportWeekGoalsForMember.
function listReportWeekGoalsForMember(
  memberId,
  { projectId = null, currentWeekStart = null, nowSql = null, limit = 200 } = {},
) {
  const where = ["g.member_id = ?"];
  const params = [memberId];

  if (projectId) {
    where.push("g.project_id = ?");
    params.push(projectId);
  }

  const overdueReferenceWeek = currentWeekStart || "9999-12-31";
  const referenceNow = nowSql || toSqlDateTime(new Date());

  return getDb()
    .prepare(
      `
      SELECT
        g.id,
        g.member_id,
        g.project_id,
        g.created_by_user_id,
        g.week_start,
        g.due_at,
        g.activity,
        g.description,
        g.planner_task_id,
        g.goal_source,
        g.task_state,
        g.is_completed,
        g.completed_at,
        g.completed_late,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_week_goal g
      INNER JOIN project p ON p.id = g.project_id
      INNER JOIN member m ON m.id = g.member_id
      LEFT JOIN user u ON u.id = g.created_by_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY g.week_start DESC, g.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit)
    .map((row) => {
      const mapped = mapReportWeekGoal(row);
      const byDueDate = Boolean(mapped.due_at && referenceNow && mapped.due_at < referenceNow);
      const byFortnight = !mapped.due_at && mapped.week_start < overdueReferenceWeek;
      return {
        ...mapped,
        is_overdue: !mapped.is_completed
          && mapped.task_state !== "missed"
          && (byDueDate || byFortnight),
      };
    });
}

// FUNCAO: listReportMonthGoalsForMember.
function listReportMonthGoalsForMember(memberId, { monthKey, limit = 1200 } = {}) {
  const normalizedMonth = String(monthKey || "").trim();
  if (!/^\d{4}-\d{2}$/.test(normalizedMonth)) {
    return [];
  }

  return getDb()
    .prepare(
      `
      SELECT
        g.id,
        g.member_id,
        g.project_id,
        g.created_by_user_id,
        g.week_start,
        g.due_at,
        g.activity,
        g.description,
        g.planner_task_id,
        g.goal_source,
        g.task_state,
        g.is_completed,
        g.completed_at,
        g.completed_late,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM report_week_goal g
      INNER JOIN project p ON p.id = g.project_id
      INNER JOIN member m ON m.id = g.member_id
      LEFT JOIN user u ON u.id = g.created_by_user_id
      WHERE g.member_id = ?
        AND g.week_start LIKE (? || '-%')
      ORDER BY g.week_start DESC, g.id DESC
      LIMIT ?
    `,
    )
    .all(memberId, normalizedMonth, limit)
    .map(mapReportWeekGoal);
}

// FUNCAO: serializeAuditPayload.
function serializeAuditPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  try {
    return JSON.stringify(payload);
  } catch (error) {
    return null;
  }
}

// FUNCAO: parseAuditPayload.
function parseAuditPayload(payloadJson) {
  const raw = String(payloadJson || "").trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

// FUNCAO: extractAuditTaskTitle.
function extractAuditTaskTitle(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const directTitle = String(payload.title || "").trim();
  if (directTitle) {
    return directTitle;
  }

  const afterTitle = String(payload.after?.title || "").trim();
  if (afterTitle) {
    return afterTitle;
  }

  const beforeTitle = String(payload.before?.title || "").trim();
  if (beforeTitle) {
    return beforeTitle;
  }

  return null;
}

// FUNCAO: createTaskAuditLog.
function createTaskAuditLog({
  db = null,
  taskId = null,
  reportGoalId = null,
  memberId = null,
  projectId = null,
  eventType,
  actorUserId = null,
  payload = null,
  createdAt = null,
}) {
  const targetDb = db || getDb();
  const normalizedEvent = String(eventType || "").trim().toLowerCase();
  if (!normalizedEvent) {
    return null;
  }

  const result = targetDb
    .prepare(
      `
      INSERT INTO task_audit_log (
        task_id,
        report_goal_id,
        member_id,
        project_id,
        event_type,
        actor_user_id,
        payload_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(CAST(? AS TEXT), CAST(CURRENT_TIMESTAMP AS TEXT)))
      RETURNING id
    `,
    )
    .run(
      taskId,
      reportGoalId,
      memberId,
      projectId,
      normalizedEvent,
      actorUserId,
      serializeAuditPayload(payload),
      createdAt,
    );

  return Number(result.lastInsertRowid || 0);
}

// FUNCAO: listTaskAuditLogsForMember.
function listTaskAuditLogsForMember(memberId, { projectId = null, limit = 120 } = {}) {
  const where = ["l.member_id = ?"];
  const params = [memberId];
  if (projectId) {
    where.push("l.project_id = ?");
    params.push(projectId);
  }

  return getDb()
    .prepare(
      `
      SELECT
        l.id,
        l.task_id,
        l.report_goal_id,
        l.member_id,
        l.project_id,
        l.event_type,
        l.actor_user_id,
        l.payload_json,
        l.created_at,
        p.name AS project_name,
        u.username AS actor_username,
        u.name AS actor_name
      FROM task_audit_log l
      LEFT JOIN project p ON p.id = l.project_id
      LEFT JOIN "user" u ON u.id = l.actor_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit)
    .map((row) => {
      const payload = parseAuditPayload(row.payload_json);
      return {
        id: row.id,
        task_id: row.task_id || null,
        report_goal_id: row.report_goal_id || null,
        member_id: row.member_id,
        project_id: row.project_id || null,
        project_name: row.project_name || null,
        event_type: row.event_type,
        actor_user_id: row.actor_user_id || null,
        actor_name: row.actor_name || row.actor_username || null,
        actor_username: row.actor_username || null,
        payload_json: row.payload_json || null,
        payload,
        task_title: extractAuditTaskTitle(payload),
        created_at: row.created_at || null,
      };
    });
}

// FUNCAO: refreshPlannerTaskLifecycle.
function refreshPlannerTaskLifecycle({ now = null, graceHours = 48 } = {}) {
  const nowSql = toSqlDateTime(now || new Date());
  const nowDate = fromSqlDateTime(nowSql);
  if (!nowDate || !nowSql) {
    return { updatedCount: 0, taskIds: [] };
  }

  const threshold = new Date(nowDate.getTime() - (Number(graceHours || 48) * 60 * 60 * 1000));
  const thresholdSql = toSqlDateTime(threshold);
  if (!thresholdSql) {
    return { updatedCount: 0, taskIds: [] };
  }

  return withTransaction((db) => {
    const staleTasks = db
      .prepare(
        `
        SELECT id, project_id, assigned_member_id, due_at
        FROM planner_task
        WHERE is_completed = 0
          AND workflow_state = 'active'
          AND CAST(due_at AS timestamp) <= CAST(? AS timestamp)
        ORDER BY CAST(due_at AS timestamp) ASC, id ASC
      `,
      )
      .all(thresholdSql);

    staleTasks.forEach((task) => {
      db.prepare(
        `
        UPDATE planner_task
        SET
          workflow_state = 'missed',
          missed_at = COALESCE(missed_at, ?),
          updated_at = ?
        WHERE id = ?
      `,
      ).run(nowSql, nowSql, task.id);

      db.prepare(
        `
        UPDATE report_week_goal
        SET
          task_state = 'missed',
          due_at = COALESCE(due_at, ?),
          updated_at = CURRENT_TIMESTAMP
        WHERE planner_task_id = ?
      `,
      ).run(task.due_at, task.id);

      createTaskAuditLog({
        db,
        taskId: task.id,
        memberId: task.assigned_member_id,
        projectId: task.project_id,
        eventType: "auto_missed",
        actorUserId: null,
        payload: {
          due_at: task.due_at,
          grace_hours: Number(graceHours || 48),
        },
        createdAt: nowSql,
      });
    });

    return {
      updatedCount: staleTasks.length,
      taskIds: staleTasks.map((task) => task.id),
    };
  });
}

// FUNCAO: createPlannerTask.
function createPlannerTask({
  projectId,
  assignedMemberId,
  createdByUserId,
  title,
  description = "",
  status = "todo",
  workflowState = "active",
  priority = "medium",
  label = null,
  dueAt,
  recurrenceIntervalDays = null,
  recurrenceUnit = null,
  recurrenceEvery = null,
  recurrenceMemberQueue = null,
  recurrenceNextIndex = null,
}) {
  const recurrenceQueueText = Array.isArray(recurrenceMemberQueue)
    ? recurrenceMemberQueue
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
      .join(",")
    : null;
  const result = getDb()
    .prepare(
      `
      INSERT INTO planner_task (
        project_id,
        assigned_member_id,
        created_by_user_id,
        title,
        description,
        status,
        workflow_state,
        priority,
        label,
        due_at,
        recurrence_interval_days,
        recurrence_unit,
        recurrence_every,
        recurrence_member_queue,
        recurrence_next_index
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `,
    )
    .run(
      projectId,
      assignedMemberId,
      createdByUserId,
      title,
      description,
      normalizePlannerStatus(status),
      normalizePlannerWorkflowState(workflowState),
      normalizePlannerPriority(priority),
      label,
      dueAt,
      recurrenceIntervalDays,
      normalizePlannerRecurrenceUnit(recurrenceUnit),
      recurrenceEvery,
      recurrenceQueueText || null,
      recurrenceNextIndex,
    );
  const createdTask = getPlannerTaskById(result.lastInsertRowid);
  if (createdTask) {
    createTaskAuditLog({
      taskId: createdTask.id,
      memberId: createdTask.assigned_member_id,
      projectId: createdTask.project_id,
      eventType: "task_created",
      actorUserId: createdByUserId || null,
      payload: {
        title: createdTask.title,
        due_at: createdTask.due_at,
      },
    });
  }

  return createdTask;
}

// FUNCAO: getPlannerTaskById.
function getPlannerTaskById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT
        t.id,
        t.project_id,
        t.assigned_member_id,
        t.created_by_user_id,
        t.title,
        t.description,
        t.status,
        t.priority,
        t.label,
        t.due_at,
        t.is_completed,
        t.completed_at,
        t.completed_late,
        t.workflow_state,
        t.missed_at,
        t.last_extended_at,
        t.last_extended_by_user_id,
        t.recurrence_interval_days,
        t.recurrence_unit,
        t.recurrence_every,
        t.recurrence_member_queue,
        t.recurrence_next_index,
        t.created_at,
        t.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM planner_task t
      INNER JOIN project p ON p.id = t.project_id
      INNER JOIN member m ON m.id = t.assigned_member_id
      LEFT JOIN "user" u ON u.id = t.created_by_user_id
      WHERE t.id = ?
      LIMIT 1
    `,
    )
    .get(id);

  return mapPlannerTask(row);
}

// FUNCAO: listPlannerTasks.
function listPlannerTasks({
  projectId = null,
  memberId = null,
  includeCompleted = true,
  includeMissed = true,
  workflowState = null,
  limit = 240,
} = {}) {
  const where = [];
  const params = [];

  if (projectId) {
    where.push("t.project_id = ?");
    params.push(projectId);
  }

  if (memberId) {
    where.push("t.assigned_member_id = ?");
    params.push(memberId);
  }

  if (!includeCompleted) {
    where.push("t.is_completed = 0");
  }

  if (!includeMissed) {
    where.push("t.workflow_state <> 'missed'");
  } else if (workflowState) {
    where.push("t.workflow_state = ?");
    params.push(normalizePlannerWorkflowState(workflowState));
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return getDb()
    .prepare(
      `
      SELECT
        t.id,
        t.project_id,
        t.assigned_member_id,
        t.created_by_user_id,
        t.title,
        t.description,
        t.status,
        t.priority,
        t.label,
        t.due_at,
        t.is_completed,
        t.completed_at,
        t.completed_late,
        t.workflow_state,
        t.missed_at,
        t.last_extended_at,
        t.last_extended_by_user_id,
        t.recurrence_interval_days,
        t.recurrence_unit,
        t.recurrence_every,
        t.recurrence_member_queue,
        t.recurrence_next_index,
        t.created_at,
        t.updated_at,
        p.name AS project_name,
        p.logo AS project_logo,
        p.primary_color AS project_primary_color,
        m.name AS member_name,
        m.photo AS member_photo,
        m.is_active AS member_is_active,
        u.username AS created_by_username,
        u.name AS created_by_name
      FROM planner_task t
      INNER JOIN project p ON p.id = t.project_id
      INNER JOIN member m ON m.id = t.assigned_member_id
      LEFT JOIN "user" u ON u.id = t.created_by_user_id
      ${whereClause}
      ORDER BY CAST(t.due_at AS timestamp) ASC, t.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit)
    .map(mapPlannerTask);
}

// FUNCAO: deletePlannerTask.
function deletePlannerTask(id, { actorUserId = null, reportGoalId = null } = {}) {
  return withTransaction((db) => {
    const taskRow = db
      .prepare(
        `
        SELECT id, project_id, assigned_member_id, title, due_at, status, workflow_state
        FROM planner_task
        WHERE id = ?
        LIMIT 1
      `,
      )
      .get(id);
    if (!taskRow) {
      return false;
    }

    createTaskAuditLog({
      db,
      taskId: taskRow.id,
      reportGoalId,
      memberId: taskRow.assigned_member_id,
      projectId: taskRow.project_id,
      eventType: "task_deleted",
      actorUserId,
      payload: {
        title: taskRow.title,
        due_at: taskRow.due_at,
        status: taskRow.status,
        workflow_state: taskRow.workflow_state,
      },
    });

    db.prepare(
      `
      DELETE FROM planner_task_completion_log
      WHERE task_id = ?
    `,
    ).run(id);

    const result = db.prepare(
      `
      DELETE FROM planner_task
      WHERE id = ?
    `,
    ).run(id);

    return Number(result.changes || 0) > 0;
  });
}

// FUNCAO: updatePlannerTaskCompletion.
function updatePlannerTaskCompletion({
  id,
  isCompleted,
  completedAt = null,
  updatedAt = null,
  actorUserId = null,
}) {
  const before = getPlannerTaskById(id);
  if (!before) {
    return null;
  }

  const result = getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        is_completed = ?,
        status = CASE WHEN ? = 1 THEN 'done' ELSE status END,
        workflow_state = CASE WHEN ? = 1 THEN 'active' ELSE workflow_state END,
        completed_at = ?,
        completed_late = 0,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
      isCompleted ? completedAt : null,
      updatedAt || null,
      id,
    );

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = getPlannerTaskById(id);
  if (updated) {
    createTaskAuditLog({
      taskId: updated.id,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: isCompleted ? "task_completed" : "task_reopened",
      actorUserId,
      payload: {
        from: before.is_completed ? 1 : 0,
        to: updated.is_completed ? 1 : 0,
      },
      createdAt: updatedAt || completedAt || null,
    });
  }

  return updated;
}

// FUNCAO: updatePlannerTaskStatus.
function updatePlannerTaskStatus({
  id,
  status,
  updatedAt = null,
  actorUserId = null,
}) {
  const before = getPlannerTaskById(id);
  if (!before) {
    return null;
  }

  const normalizedStatus = normalizePlannerStatus(status);
  const isDone = normalizedStatus === "done";
  const result = getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        status = ?,
        is_completed = ?,
        completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, CAST(CURRENT_TIMESTAMP AS TEXT)) ELSE NULL END,
        completed_late = 0,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      normalizedStatus,
      isDone ? 1 : 0,
      isDone ? 1 : 0,
      updatedAt || null,
      id,
    );

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = getPlannerTaskById(id);
  if (updated) {
    createTaskAuditLog({
      taskId: updated.id,
      reportGoalId: null,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: "status_changed",
      actorUserId,
      payload: {
        from: before.status,
        to: updated.status,
      },
    });
  }

  return updated;
}

// FUNCAO: updatePlannerTaskDetails.
function updatePlannerTaskDetails({
  id,
  projectId,
  assignedMemberId,
  title,
  description = "",
  dueAt,
  status = null,
  priority = null,
  label = null,
  updatedAt = null,
  actorUserId = null,
}) {
  const before = getPlannerTaskById(id);
  if (!before) {
    return null;
  }

  const normalizedStatus = status ? normalizePlannerStatus(status) : before.status;
  const normalizedPriority = priority ? normalizePlannerPriority(priority) : before.priority;
  const normalizedLabel = label === undefined ? before.label : label;
  const normalizedUpdatedAt = updatedAt || toSqlDateTime(new Date());
  const isDone = normalizedStatus === "done";
  const result = getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        project_id = ?,
        assigned_member_id = ?,
        title = ?,
        description = ?,
        due_at = ?,
        status = ?,
        priority = ?,
        label = ?,
        is_completed = ?,
        completed_at = CASE
          WHEN ? = 1 THEN COALESCE(completed_at, CAST(CURRENT_TIMESTAMP AS TEXT))
          ELSE NULL
        END,
        completed_late = CASE
          WHEN ? = 1 THEN completed_late
          ELSE 0
        END,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      projectId,
      assignedMemberId,
      title,
      description,
      dueAt,
      normalizedStatus,
      normalizedPriority,
      normalizedLabel,
      isDone ? 1 : 0,
      isDone ? 1 : 0,
      isDone ? 1 : 0,
      normalizedUpdatedAt,
      id,
    );

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = getPlannerTaskById(id);
  if (updated) {
    createTaskAuditLog({
      taskId: updated.id,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: "task_updated",
      actorUserId,
      payload: {
        before: {
          project_id: before.project_id,
          assigned_member_id: before.assigned_member_id,
          title: before.title,
          description: before.description,
          due_at: before.due_at,
          status: before.status,
          priority: before.priority,
          label: before.label,
        },
        after: {
          project_id: updated.project_id,
          assigned_member_id: updated.assigned_member_id,
          title: updated.title,
          description: updated.description,
          due_at: updated.due_at,
          status: updated.status,
          priority: updated.priority,
          label: updated.label,
        },
      },
    });
  }

  return updated;
}

// FUNCAO: markPlannerTaskDoneLate.
function markPlannerTaskDoneLate({ id, actorUserId = null, completedAt = null }) {
  const before = getPlannerTaskById(id);
  if (!before) {
    return null;
  }

  const doneAt = completedAt || toSqlDateTime(new Date());
  const result = getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        is_completed = 1,
        status = 'done',
        workflow_state = 'active',
        completed_at = ?,
        completed_late = 1,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(doneAt, doneAt, id);

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = getPlannerTaskById(id);
  if (updated) {
    createTaskAuditLog({
      taskId: updated.id,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: "task_done_late",
      actorUserId,
      payload: {
        previous_state: before.workflow_state,
        missed_at: before.missed_at,
      },
      createdAt: doneAt,
    });
  }

  return updated;
}

// FUNCAO: extendPlannerTaskDeadline.
function extendPlannerTaskDeadline({
  id,
  dueAt,
  actorUserId = null,
  reason = null,
  updatedAt = null,
}) {
  const before = getPlannerTaskById(id);
  if (!before) {
    return null;
  }

  const stamp = updatedAt || toSqlDateTime(new Date());
  const result = getDb()
    .prepare(
      `
      UPDATE planner_task
      SET
        due_at = ?,
        workflow_state = 'active',
        missed_at = NULL,
        last_extended_at = ?,
        last_extended_by_user_id = ?,
        updated_at = ?
      WHERE id = ?
    `,
    )
    .run(
      dueAt,
      stamp,
      actorUserId,
      stamp,
      id,
    );

  if (!Number(result.changes || 0)) {
    return null;
  }

  const updated = getPlannerTaskById(id);
  if (updated) {
    createTaskAuditLog({
      taskId: updated.id,
      memberId: updated.assigned_member_id,
      projectId: updated.project_id,
      eventType: "deadline_extended",
      actorUserId,
      payload: {
        previous_due_at: before.due_at,
        next_due_at: updated.due_at,
        reason: String(reason || "").trim() || null,
      },
      createdAt: stamp,
    });
  }

  return updated;
}

// FUNCAO: createPlannerTaskCompletionLog.
function createPlannerTaskCompletionLog({
  taskId,
  projectId,
  assignedMemberId,
  completedByUserId,
  title,
  description = "",
  status = "done",
  priority = "medium",
  label = null,
  dueAt,
  completedAt,
}) {
  const result = getDb()
    .prepare(
      `
      INSERT INTO planner_task_completion_log (
        task_id,
        project_id,
        assigned_member_id,
        completed_by_user_id,
        title,
        description,
        status,
        priority,
        label,
        due_at,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `,
    )
    .run(
      taskId,
      projectId,
      assignedMemberId,
      completedByUserId,
      title,
      description,
      normalizePlannerStatus(status),
      normalizePlannerPriority(priority),
      label,
      dueAt,
      completedAt || null,
    );

  return Number(result.lastInsertRowid || 0);
}

// FUNCAO: listPlannerTaskCompletionLogs.
function listPlannerTaskCompletionLogs({
  projectId = null,
  memberId = null,
  limit = 60,
} = {}) {
  const where = [];
  const params = [];

  if (projectId) {
    where.push("l.project_id = ?");
    params.push(projectId);
  }
  if (memberId) {
    where.push("l.assigned_member_id = ?");
    params.push(memberId);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return getDb()
    .prepare(
      `
      SELECT
        l.id,
        l.task_id,
        l.project_id,
        l.assigned_member_id,
        l.completed_by_user_id,
        l.title,
        l.description,
        l.status,
        l.priority,
        l.label,
        l.due_at,
        l.completed_at,
        p.name AS project_name,
        m.name AS member_name,
        m.photo AS member_photo,
        u.username AS completed_by_username,
        u.name AS completed_by_name
      FROM planner_task_completion_log l
      INNER JOIN project p ON p.id = l.project_id
      INNER JOIN member m ON m.id = l.assigned_member_id
      INNER JOIN "user" u ON u.id = l.completed_by_user_id
      ${whereClause}
      ORDER BY CAST(l.completed_at AS timestamp) DESC, l.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit)
    .map(mapPlannerTaskCompletionLog);
}

// SECAO: inventario e movimentacoes (retirada, emprestimo, prorrogacao e devolucao).

// FUNCAO: listInventoryItems.
function listInventoryItems({ type = null } = {}) {
  const normalizedType = type ? normalizeInventoryType(type) : null;
  const sql = normalizedType
    ? `
      SELECT id, name, item_type, category, category_id, location, location_id, amount, description
      FROM estoque
      WHERE item_type = ?
      ORDER BY LOWER(name), id
    `
    : `
      SELECT id, name, item_type, category, category_id, location, location_id, amount, description
      FROM estoque
      ORDER BY LOWER(name), id
    `;

  const rows = normalizedType
    ? getDb().prepare(sql).all(normalizedType)
    : getDb().prepare(sql).all();

  return rows.map(mapInventoryItem);
}

// FUNCAO: getInventoryItemById.
function getInventoryItemById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT id, name, item_type, category, category_id, location, location_id, amount, description
      FROM estoque
      WHERE id = ?
    `,
    )
    .get(id);

  return mapInventoryItem(row);
}

// FUNCAO: createInventoryItem.
function createInventoryItem({
  name,
  itemType = "stock",
  category,
  categoryId = null,
  location = null,
  locationId = null,
  quantity,
  description,
}) {
  return withTransaction((db) => {
    const resolvedCategory = resolveInventoryCatalogEntry({
      db,
      table: "inventory_category",
      id: categoryId,
      name: category,
    });
    const resolvedLocation = resolveInventoryCatalogEntry({
      db,
      table: "inventory_location",
      id: locationId,
      name: location,
    });

    const result = db
      .prepare(
        `
        INSERT INTO estoque (name, item_type, category, category_id, location, location_id, amount, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `,
      )
      .run(
        name,
        normalizeInventoryType(itemType),
        resolvedCategory?.name || trimCatalogValue(category),
        resolvedCategory?.id || null,
        resolvedLocation?.name || trimCatalogValue(location),
        resolvedLocation?.id || null,
        quantity,
        description,
      );

    return getInventoryItemById(result.lastInsertRowid);
  });
}

// FUNCAO: updateInventoryItem.
function updateInventoryItem(
  id,
  {
    name,
    itemType = "stock",
    category,
    categoryId = null,
    location = null,
    locationId = null,
    quantity,
    description,
  },
) {
  return withTransaction((db) => {
    const current = db
      .prepare(
        `
        SELECT id
        FROM estoque
        WHERE id = ?
      `,
      )
      .get(id);

    if (!current) {
      return null;
    }

    const resolvedCategory = resolveInventoryCatalogEntry({
      db,
      table: "inventory_category",
      id: categoryId,
      name: category,
    });
    const resolvedLocation = resolveInventoryCatalogEntry({
      db,
      table: "inventory_location",
      id: locationId,
      name: location,
    });

    db.prepare(
      `
      UPDATE estoque
      SET
        name = ?,
        item_type = ?,
        category = ?,
        category_id = ?,
        location = ?,
        location_id = ?,
        amount = ?,
        description = ?
      WHERE id = ?
    `,
    ).run(
      name,
      normalizeInventoryType(itemType),
      resolvedCategory?.name || trimCatalogValue(category),
      resolvedCategory?.id || null,
      resolvedLocation?.name || trimCatalogValue(location),
      resolvedLocation?.id || null,
      quantity,
      description,
      id,
    );

    return getInventoryItemById(id);
  });
}

// FUNCAO: deleteInventoryItem.
function deleteInventoryItem(id) {
  return withTransaction((db) => {
    const item = db
      .prepare(
        `
        SELECT id, name, item_type, category, category_id, location, location_id, amount, description
        FROM estoque
        WHERE id = ?
      `,
      )
      .get(id);

    if (!item) {
      return null;
    }

    const loanCount =
      db.prepare("SELECT COUNT(*) AS total FROM inventory_loan WHERE item_id = ?").get(id)
        ?.total || 0;

    if (loanCount > 0) {
      throw new Error(
        "Este item possui histórico de empréstimos e não pode ser removido.",
      );
    }

    db.prepare("DELETE FROM pedido WHERE estoque_id = ?").run(id);
    db.prepare("DELETE FROM estoque WHERE id = ?").run(id);
    return mapInventoryItem(item);
  });
}

// FUNCAO: withdrawInventoryItem.
function withdrawInventoryItem({ nameOrCode, quantity, userId }) {
  return withTransaction((db) => {
    const item = db
      .prepare(
        `
        SELECT id, name, item_type, category, category_id, location, location_id, amount, description
        FROM estoque
        WHERE item_type = 'stock'
          AND (LOWER(name) = LOWER(?) OR CAST(id AS TEXT) = ?)
        ORDER BY id
        LIMIT 1
      `,
      )
      .get(nameOrCode, nameOrCode);

    if (!item) {
      return {
        success: false,
        message: "Item de estoque não encontrado. Materiais patrimoniais devem ser emprestados.",
      };
    }

    if (item.amount < quantity) {
      return { success: false, message: "Quantidade insuficiente no estoque." };
    }

    const newQuantity = item.amount - quantity;
    db.prepare("UPDATE estoque SET amount = ? WHERE id = ?").run(newQuantity, item.id);
    db.prepare(
      `
      INSERT INTO pedido (qtd_retirada, usuario_id, estoque_id, data_pedido)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `,
    ).run(quantity, userId, item.id);

    return {
      success: true,
      message: "Item retirado com sucesso e registrado no histórico.",
      item: {
        ...item,
        amount: newQuantity,
      },
    };
  });
}

// FUNCAO: getInventoryLoanById.
function getInventoryLoanById(id) {
  const row = getDb()
    .prepare(
      `
      SELECT
        l.id,
        l.item_id,
        l.user_id,
        l.quantity,
        l.borrowed_at,
        l.original_due_at,
        l.due_at,
        l.returned_at,
        l.extended_at,
        l.extended_by_user_id,
        l.returned_by_user_id,
        e.name AS item_name,
        e.item_type,
        e.category AS item_category,
        u.name AS user_name,
        u.username AS user_username,
        u.role AS user_role,
        eu.name AS extended_by_name,
        ru.name AS returned_by_name
      FROM inventory_loan l
      INNER JOIN estoque e ON e.id = l.item_id
      INNER JOIN user u ON u.id = l.user_id
      LEFT JOIN user eu ON eu.id = l.extended_by_user_id
      LEFT JOIN user ru ON ru.id = l.returned_by_user_id
      WHERE l.id = ?
    `,
    )
    .get(id);

  return mapInventoryLoan(row);
}

// FUNCAO: borrowInventoryItem.
function borrowInventoryItem({ nameOrCode, quantity, userId }) {
  return withTransaction((db) => {
    const item = db
      .prepare(
        `
        SELECT id, name, item_type, category, category_id, location, location_id, amount, description
        FROM estoque
        WHERE item_type = 'patrimony'
          AND (LOWER(name) = LOWER(?) OR CAST(id AS TEXT) = ?)
        ORDER BY id
        LIMIT 1
      `,
      )
      .get(nameOrCode, nameOrCode);

    if (!item) {
      return {
        success: false,
        message: "Material patrimonial não encontrado para empréstimo.",
      };
    }

    if (item.amount < quantity) {
      return {
        success: false,
        message: "Quantidade insuficiente disponível para empréstimo.",
      };
    }

    const newQuantity = item.amount - quantity;
    const dueAt = addDaysToNow(7);

    db.prepare("UPDATE estoque SET amount = ? WHERE id = ?").run(newQuantity, item.id);
    const result = db
      .prepare(
        `
        INSERT INTO inventory_loan (
          item_id,
          user_id,
          quantity,
          original_due_at,
          due_at
        )
        VALUES (?, ?, ?, ?, ?)
        RETURNING id
      `,
      )
      .run(item.id, userId, quantity, dueAt, dueAt);

    return {
      success: true,
      message: "Empréstimo registrado com sucesso. A devolução está prevista para 7 dias.",
      loan: getInventoryLoanById(result.lastInsertRowid),
      item: {
        ...item,
        amount: newQuantity,
      },
    };
  });
}

// FUNCAO: extendInventoryLoan.
function extendInventoryLoan({ loanId, extraDays, actorUserId }) {
  return withTransaction((db) => {
    const loan = db
      .prepare(
        `
        SELECT id, due_at, returned_at
        FROM inventory_loan
        WHERE id = ?
      `,
      )
      .get(loanId);

    if (!loan) {
      return { success: false, message: "Empréstimo não encontrado." };
    }

    if (loan.returned_at) {
      return {
        success: false,
        message: "Este empréstimo já foi encerrado e não pode ser prorrogado.",
      };
    }

    const dueDate = new Date(String(loan.due_at).replace(" ", "T"));
    dueDate.setDate(dueDate.getDate() + extraDays);
    const nextDueAt = toSqlDateTime(dueDate);

    db.prepare(
      `
      UPDATE inventory_loan
      SET due_at = ?, extended_at = CURRENT_TIMESTAMP, extended_by_user_id = ?
      WHERE id = ?
    `,
    ).run(nextDueAt, actorUserId, loanId);

    return {
      success: true,
      message: "Prazo do empréstimo prorrogado com sucesso.",
      loan: getInventoryLoanById(loanId),
    };
  });
}

// FUNCAO: returnInventoryLoan.
function returnInventoryLoan({ loanId, actorUserId }) {
  return withTransaction((db) => {
    const loan = db
      .prepare(
        `
        SELECT id, item_id, quantity, returned_at
        FROM inventory_loan
        WHERE id = ?
      `,
      )
      .get(loanId);

    if (!loan) {
      return { success: false, message: "Empréstimo não encontrado." };
    }

    if (loan.returned_at) {
      return {
        success: false,
        message: "Este empréstimo já foi devolvido anteriormente.",
      };
    }

    db.prepare(
      `
      UPDATE estoque
      SET amount = amount + ?
      WHERE id = ?
    `,
    ).run(loan.quantity, loan.item_id);

    db.prepare(
      `
      UPDATE inventory_loan
      SET returned_at = CURRENT_TIMESTAMP, returned_by_user_id = ?
      WHERE id = ?
    `,
    ).run(actorUserId, loanId);

    return {
      success: true,
      message: "Devolução registrada com sucesso.",
      loan: getInventoryLoanById(loanId),
    };
  });
}

// FUNCAO: listInventoryRequests.
function listInventoryRequests(limit = null) {
  const sql = `
    SELECT
      p.id AS pedido_id,
      p.usuario_id,
      p.estoque_id,
      u.name AS nome_usuario,
      u.username AS username_usuario,
      u.role AS role_usuario,
      e.name AS nome_item_estoque,
      p.qtd_retirada,
      p.data_pedido
    FROM pedido p
    INNER JOIN user u ON u.id = p.usuario_id
    INNER JOIN estoque e ON e.id = p.estoque_id
    ORDER BY p.data_pedido DESC, p.id DESC
  `;

  const rows = limit
    ? getDb().prepare(`${sql} LIMIT ?`).all(limit)
    : getDb().prepare(sql).all();

  return rows.map((row) => ({
    pedido_id: row.pedido_id,
    usuario_id: row.usuario_id,
    estoque_id: row.estoque_id,
    nome_usuario: row.nome_usuario || row.username_usuario,
    username_usuario: row.username_usuario,
    role_usuario: row.role_usuario,
    nome_item_estoque: row.nome_item_estoque,
    qtd_retirada: row.qtd_retirada,
    data_pedido: row.data_pedido,
  }));
}

// FUNCAO: listInventoryLoans.
function listInventoryLoans({ status = null, limit = null } = {}) {
  const conditions = [];
  const params = [];
  let orderBy = `
    ORDER BY
      CASE WHEN l.returned_at IS NULL THEN 0 ELSE 1 END,
      l.due_at ASC,
      l.borrowed_at DESC,
      l.id DESC
  `;

  if (status === "active") {
    conditions.push("l.returned_at IS NULL");
    orderBy = `
      ORDER BY
        l.due_at ASC,
        l.borrowed_at DESC,
        l.id DESC
    `;
  } else if (status === "returned") {
    conditions.push("l.returned_at IS NOT NULL");
    orderBy = `
      ORDER BY
        l.returned_at DESC,
        l.id DESC
    `;
  } else if (status === "overdue") {
    conditions.push("l.returned_at IS NULL");
    conditions.push("CAST(l.due_at AS timestamp) < CURRENT_TIMESTAMP");
    orderBy = `
      ORDER BY
        l.due_at ASC,
        l.borrowed_at DESC,
        l.id DESC
    `;
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT
      l.id,
      l.item_id,
      l.user_id,
      l.quantity,
      l.borrowed_at,
      l.original_due_at,
      l.due_at,
      l.returned_at,
      l.extended_at,
      l.extended_by_user_id,
      l.returned_by_user_id,
      e.name AS item_name,
      e.item_type,
      e.category AS item_category,
      u.name AS user_name,
      u.username AS user_username,
      u.role AS user_role,
      eu.name AS extended_by_name,
      ru.name AS returned_by_name
    FROM inventory_loan l
    INNER JOIN estoque e ON e.id = l.item_id
    INNER JOIN user u ON u.id = l.user_id
    LEFT JOIN user eu ON eu.id = l.extended_by_user_id
    LEFT JOIN user ru ON ru.id = l.returned_by_user_id
    ${whereClause}
    ${orderBy}
  `;

  const statement = limit ? `${sql} LIMIT ?` : sql;
  const rows = limit
    ? getDb().prepare(statement).all(...params, limit)
    : getDb().prepare(statement).all(...params);

  return rows.map(mapInventoryLoan);
}

// SECAO: agregacoes para dashboard do almoxarifado.

// FUNCAO: getInventoryDashboardData.
function getInventoryDashboardData() {
  const db = getDb();
  const summary = {
    user_count:
      db.prepare("SELECT COUNT(*) AS total FROM user").get()?.total || 0,
    item_count:
      db.prepare("SELECT COUNT(*) AS total FROM estoque").get()?.total || 0,
    stock_item_count:
      db.prepare("SELECT COUNT(*) AS total FROM estoque WHERE item_type = 'stock'").get()
        ?.total || 0,
    patrimony_item_count:
      db.prepare("SELECT COUNT(*) AS total FROM estoque WHERE item_type = 'patrimony'").get()
        ?.total || 0,
    category_count:
      db.prepare("SELECT COUNT(*) AS total FROM inventory_category").get()?.total || 0,
    location_count:
      db.prepare("SELECT COUNT(*) AS total FROM inventory_location").get()?.total || 0,
    request_count:
      db.prepare("SELECT COUNT(*) AS total FROM pedido").get()?.total || 0,
    active_loan_count:
      db.prepare(
        "SELECT COUNT(*) AS total FROM inventory_loan WHERE returned_at IS NULL",
      ).get()?.total || 0,
    overdue_loan_count:
      db.prepare(
        "SELECT COUNT(*) AS total FROM inventory_loan WHERE returned_at IS NULL AND CAST(due_at AS timestamp) < CURRENT_TIMESTAMP",
      ).get()?.total || 0,
    total_units:
      db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM estoque").get()
        ?.total || 0,
    stock_units:
      db.prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM estoque WHERE item_type = 'stock'",
      ).get()?.total || 0,
    patrimony_units:
      db.prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM estoque WHERE item_type = 'patrimony'",
      ).get()?.total || 0,
  };

  return {
    summary,
    recent_requests: listInventoryRequests(6),
    recent_loans: listInventoryLoans({ status: "active", limit: 6 }),
    recent_users: db
      .prepare(
        `
        SELECT id, username, name, role
        FROM user
        ORDER BY id DESC
        LIMIT 6
      `,
      )
      .all()
      .map(mapUser),
  };
}

// SECAO: interface publica deste modulo para o restante da aplicacao.
// OBSERVACAO: alteracoes de nomes exportados exigem ajuste imediato nos imports de rotas/servicos.

module.exports = {
  createAta,
  createMember,
  createProject,
  createUser,
  createInventoryItem,
  createInventoryCategory,
  createInventoryLocation,
  borrowInventoryItem,
  deactivateMember,
  deleteAta,
  deleteReportEntry,
  deleteInventoryItem,
  deleteInventoryCategory,
  deleteInventoryLocation,
  deleteProject,
  ensureSchema,
  getAtaById,
  getDb,
  getInventoryDashboardData,
  getInventoryCategoryById,
  getInventoryItemById,
  getInventoryLoanById,
  getInventoryLocationById,
  getMemberById,
  getMemberByName,
  getProjectById,
  getProjectMembers,
  getReportEntryById,
  getReportWeekGoalById,
  getReportWeekGoalByPlannerTaskId,
  getUserById,
  getUserByUsername,
  listInventoryCategories,
  listInventoryItems,
  listInventoryLoans,
  listInventoryLocations,
  listInventoryRequests,
  listUsers,
  listActiveMembers,
  listProjectsBasic,
  listProjectsForMember,
  listProjectsWithMembers,
  listReportEntries,
  listReportMembersSummary,
  listReportProjectsForMember,
  listReportMonthGoalsForMember,
  listPlannerTasks,
  getPlannerTaskById,
  refreshPlannerTaskLifecycle,
  listReportWeekGoalsForMember,
  listReportWeekGoalDeletionLogsForMember,
  listTaskAuditLogsForMember,
  listReportWeeksForMember,
  listRecentAtas,
  createReportEntry,
  createReportWeekGoal,
  syncReportWeekGoalFromPlannerTask,
  createPlannerTask,
  createTaskAuditLog,
  createPlannerTaskCompletionLog,
  updatePlannerTaskDetails,
  updatePlannerTaskCompletion,
  markPlannerTaskDoneLate,
  extendPlannerTaskDeadline,
  updatePlannerTaskStatus,
  deletePlannerTask,
  listPlannerTaskCompletionLogs,
  extendInventoryLoan,
  returnInventoryLoan,
  setUserMemberLink,
  updateUserPassword,
  deleteUser,
  updateInventoryCategory,
  updateInventoryItem,
  updateInventoryLocation,
  updateMember,
  updateProject,
  updateReportEntry,
  updateReportWeekGoal,
  deleteReportWeekGoal,
  deleteReportWeekGoalWithAudit,
  isProjectMember,
  isProjectCoordinator,
  withdrawInventoryItem,
};
