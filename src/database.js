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

let database;
let bridgeState;
let querySequence = 0;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function normalizeError(payload) {
  if (!payload) {
    return null;
  }

  const error = new Error(payload.message || "Database query failed");
  Object.assign(error, payload);
  return error;
}

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

    async function ensureConnected() {
      if (!connected) {
        await client.connect();
        connected = true;
      }
    }

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

function querySync(sql, params = []) {
  const bridge = createSyncBridge();
  const id = ++querySequence;
  bridge.port.postMessage({ id, sql, params });

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

function createDbAdapter() {
  return {
    exec(sql) {
      querySync(toPostgresSql(sql));
    },
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

// SECAO: normalizadores e utilitarios basicos usados antes de persistir dados.

function normalizeInventoryType(value) {
  return INVENTORY_TYPES.has(value) ? value : "stock";
}

function normalizeProjectColor(value) {
  const normalized = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized)
    ? normalized.toLowerCase()
    : DEFAULT_PROJECT_COLOR;
}

function normalizeReportStatus(value) {
  return REPORT_STATUSES.has(value) ? value : "in_progress";
}

function toSqlDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 19).replace("T", " ");
}

function addDaysToNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toSqlDateTime(date);
}

// SECAO: conexao PostgreSQL/Neon e garantia incremental de schema.

function getDb() {
  if (!database) {
    database = createDbAdapter();
  }

  return database;
}

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
      activity TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (member_id) REFERENCES member(id),
      FOREIGN KEY (project_id) REFERENCES project(id),
      FOREIGN KEY (created_by_user_id) REFERENCES user(id)
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
  getDb().exec(
    "CREATE INDEX IF NOT EXISTS ix_project_members_project_coordinator ON project_members(project_id, is_coordinator)",
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
}

// SECAO: transacoes e mapeadores de linhas (SQL -> objetos de dominio).

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
    activity: row.activity || "",
    description: row.description || "",
    is_completed: Boolean(row.is_completed),
    completed_at: row.completed_at || null,
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

function mapInventoryCatalog(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
  };
}

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

function setUserMemberLink(userId, memberId = null) {
  const db = getDb();
  const current = getUserById(userId);
  if (!current) {
    return null;
  }

  db.prepare("UPDATE user SET member_id = ? WHERE id = ?").run(memberId, userId);
  return getUserById(userId);
}

// SECAO: tabelas auxiliares do almoxarifado (categorias e locais).

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

function trimCatalogValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

// SECAO: operacoes de membros (cadastro, busca e desativacao).

function listActiveMembers() {
  return getDb()
    .prepare(
      "SELECT id, name, photo, is_active FROM member WHERE is_active = 1 ORDER BY LOWER(name)",
    )
    .all()
    .map(mapMember);
}

function getMemberById(id) {
  const row = getDb()
    .prepare("SELECT id, name, photo, is_active FROM member WHERE id = ?")
    .get(id);

  return row ? mapMember(row) : null;
}

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

function createMember(name, photo = null) {
  const db = getDb();
  const result = db
    .prepare("INSERT INTO member (name, photo, is_active) VALUES (?, ?, 1) RETURNING id")
    .run(name, photo);

  return getMemberById(result.lastInsertRowid);
}

function updateMember(id, { name, photo }) {
  getDb().prepare("UPDATE member SET name = ?, photo = ? WHERE id = ?").run(name, photo, id);
  return getMemberById(id);
}

function deactivateMember(id) {
  return withTransaction((db) => {
    db.prepare("UPDATE member SET is_active = 0 WHERE id = ?").run(id);
    db.prepare("DELETE FROM project_members WHERE member_id = ?").run(id);
    return getMemberById(id);
  });
}

// SECAO: operacoes de projetos e relacoes projeto-membro.

function listProjectsBasic() {
  return getDb()
    .prepare("SELECT id, name, logo, primary_color FROM project ORDER BY LOWER(name)")
    .all()
    .map(mapProject);
}

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

function listProjectsWithMembers() {
  return listProjectsBasic().map((project) => getProjectById(project.id));
}

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

function deleteAta(id) {
  return withTransaction((db) => {
    db.prepare("DELETE FROM ata_absent_justification WHERE ata_id = ?").run(id);
    db.prepare("DELETE FROM ata_present_members WHERE ata_id = ?").run(id);
    db.prepare("DELETE FROM ata WHERE id = ?").run(id);
  });
}

// SECAO: operacoes de relatorios semanais.

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

function deleteReportEntry(id) {
  const existing = getReportEntryById(id);
  if (!existing) {
    return null;
  }

  getDb().prepare("DELETE FROM report_entry WHERE id = ?").run(id);
  return existing;
}

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

function createReportWeekGoal({
  memberId,
  projectId,
  createdByUserId = null,
  weekStart,
  activity,
  description = "",
  isCompleted = false,
}) {
  const result = getDb()
    .prepare(
      `
      INSERT INTO report_week_goal (
        member_id,
        project_id,
        created_by_user_id,
        week_start,
        activity,
        description,
        is_completed,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)
      RETURNING id
    `,
    )
    .run(
      memberId,
      projectId,
      createdByUserId,
      weekStart,
      activity,
      description,
      isCompleted ? 1 : 0,
      isCompleted ? 1 : 0,
    );

  return getReportWeekGoalById(result.lastInsertRowid);
}

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
        g.activity,
        g.description,
        g.is_completed,
        g.completed_at,
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
      WHERE g.id = ?
      LIMIT 1
    `,
    )
    .get(id);

  return mapReportWeekGoal(row);
}

function updateReportWeekGoal(id, { activity, description, isCompleted = false }) {
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
        is_completed = ?,
        completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )
    .run(activity, description, isCompleted ? 1 : 0, isCompleted ? 1 : 0, id);

  return getReportWeekGoalById(id);
}

function listReportWeekGoalsForMember(
  memberId,
  { projectId = null, currentWeekStart = null, limit = 200 } = {},
) {
  const where = ["g.member_id = ?"];
  const params = [memberId];

  if (projectId) {
    where.push("g.project_id = ?");
    params.push(projectId);
  }

  const overdueReferenceWeek = currentWeekStart || "9999-12-31";

  return getDb()
    .prepare(
      `
      SELECT
        g.id,
        g.member_id,
        g.project_id,
        g.created_by_user_id,
        g.week_start,
        g.activity,
        g.description,
        g.is_completed,
        g.completed_at,
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
      ORDER BY
        CASE
          WHEN g.is_completed = 0 AND g.week_start < ? THEN 0
          WHEN g.is_completed = 0 THEN 1
          ELSE 2
        END,
        g.week_start ASC,
        g.id ASC
      LIMIT ?
    `,
    )
    .all(...params, overdueReferenceWeek, limit)
    .map((row) => {
      const mapped = mapReportWeekGoal(row);
      return {
        ...mapped,
        is_overdue: !mapped.is_completed && mapped.week_start < overdueReferenceWeek,
      };
    });
}

// SECAO: inventario e movimentacoes (retirada, emprestimo, prorrogacao e devolucao).

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
  listReportWeekGoalsForMember,
  listReportWeeksForMember,
  listRecentAtas,
  createReportEntry,
  createReportWeekGoal,
  extendInventoryLoan,
  returnInventoryLoan,
  setUserMemberLink,
  updateInventoryCategory,
  updateInventoryItem,
  updateInventoryLocation,
  updateMember,
  updateProject,
  updateReportEntry,
  updateReportWeekGoal,
  isProjectMember,
  isProjectCoordinator,
  withdrawInventoryItem,
};
