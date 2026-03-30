const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { config } = require("./config");
const { firstNamesSummary } = require("./utils");

let database;
const USER_ROLES = new Set(["admin", "common"]);
const INVENTORY_TYPES = new Set(["stock", "patrimony"]);

function normalizeInventoryType(value) {
  return INVENTORY_TYPES.has(value) ? value : "stock";
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

function getDb() {
  if (!database) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    database = new DatabaseSync(config.databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
  }

  return database;
}

function ensureColumn(tableName, columnName, definition) {
  const db = getDb();
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => column.name);

  if (!columns.includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function ensureSchema() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'admin'
    );

    CREATE TABLE IF NOT EXISTS member (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS project (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      logo TEXT
    );

    CREATE TABLE IF NOT EXISTS ata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

    CREATE TABLE IF NOT EXISTS estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qtd_retirada INTEGER NOT NULL,
      usuario_id INTEGER NOT NULL,
      estoque_id INTEGER NOT NULL,
      data_pedido TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES user(id),
      FOREIGN KEY (estoque_id) REFERENCES estoque(id)
    );

    CREATE TABLE IF NOT EXISTS inventory_category (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS inventory_location (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS inventory_loan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    CREATE INDEX IF NOT EXISTS ix_user_username ON user(username);
    CREATE INDEX IF NOT EXISTS ix_ata_meeting_datetime ON ata(meeting_datetime);
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
  ensureColumn("estoque", "location", "TEXT");
  ensureColumn("estoque", "category_id", "INTEGER");
  ensureColumn("estoque", "location_id", "INTEGER");
  ensureColumn("estoque", "item_type", "TEXT NOT NULL DEFAULT 'stock'");

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
    INSERT OR IGNORE INTO inventory_category (name)
    SELECT DISTINCT TRIM(category)
    FROM estoque
    WHERE category IS NOT NULL AND TRIM(category) <> '';

    INSERT OR IGNORE INTO inventory_location (name)
    SELECT DISTINCT TRIM(location)
    FROM estoque
    WHERE location IS NOT NULL AND TRIM(location) <> '';
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
}

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
    is_active: Boolean(row.is_active),
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

function getUserById(id) {
  const row = getDb()
    .prepare("SELECT id, username, password_hash, name, role FROM user WHERE id = ?")
    .get(id);

  return mapUser(row);
}

function getUserByUsername(username) {
  const row = getDb()
    .prepare(
      "SELECT id, username, password_hash, name, role FROM user WHERE username = ?",
    )
    .get(username);

  return mapUser(row);
}

function listUsers() {
  return getDb()
    .prepare(
      `
      SELECT id, username, name, role
      FROM user
      ORDER BY LOWER(COALESCE(name, username)), LOWER(username)
    `,
    )
    .all()
    .map(mapUser);
}

function createUser(username, passwordHash, { name = null, role = "admin" } = {}) {
  const db = getDb();
  const normalizedRole = USER_ROLES.has(role) ? role : "common";
  const result = db
    .prepare(
      `
      INSERT INTO user (username, password_hash, name, role)
      VALUES (?, ?, ?, ?)
    `,
    )
    .run(username, passwordHash, name || username, normalizedRole);

  return getUserById(result.lastInsertRowid);
}

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
    .prepare(`INSERT INTO ${table} (name) VALUES (?)`)
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

function listActiveMembers() {
  return getDb()
    .prepare(
      "SELECT id, name, is_active FROM member WHERE is_active = 1 ORDER BY LOWER(name)",
    )
    .all()
    .map(mapMember);
}

function getMemberById(id) {
  const row = getDb()
    .prepare("SELECT id, name, is_active FROM member WHERE id = ?")
    .get(id);

  return row ? mapMember(row) : null;
}

function createMember(name) {
  const db = getDb();
  const result = db
    .prepare("INSERT INTO member (name, is_active) VALUES (?, 1)")
    .run(name);

  return getMemberById(result.lastInsertRowid);
}

function updateMember(id, name) {
  getDb().prepare("UPDATE member SET name = ? WHERE id = ?").run(name, id);
  return getMemberById(id);
}

function deactivateMember(id) {
  return withTransaction((db) => {
    db.prepare("UPDATE member SET is_active = 0 WHERE id = ?").run(id);
    db.prepare("DELETE FROM project_members WHERE member_id = ?").run(id);
    return getMemberById(id);
  });
}

function listProjectsBasic() {
  return getDb()
    .prepare("SELECT id, name, logo FROM project ORDER BY LOWER(name)")
    .all()
    .map(mapProject);
}

function getProjectMembers(projectId, { activeOnly = false } = {}) {
  const where = activeOnly ? "AND m.is_active = 1" : "";

  return getDb()
    .prepare(
      `
      SELECT m.id, m.name, m.is_active
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
    .prepare("SELECT id, name, logo FROM project WHERE id = ?")
    .get(id);

  if (!projectRow) {
    return null;
  }

  const project = mapProject(projectRow);
  project.members = getProjectMembers(project.id);
  project.active_members = project.members.filter((member) => member.is_active);
  project.active_member_ids = project.active_members.map((member) => member.id);
  project.member_name_preview = firstNamesSummary(project.members);
  return project;
}

function listProjectsWithMembers() {
  return listProjectsBasic().map((project) => getProjectById(project.id));
}

function createProject({ name, logo, memberIds }) {
  return withTransaction((db) => {
    const result = db
      .prepare("INSERT INTO project (name, logo) VALUES (?, ?)")
      .run(name, logo || null);

    const projectId = Number(result.lastInsertRowid);
    const insertMembership = db.prepare(
      "INSERT INTO project_members (project_id, member_id) VALUES (?, ?)",
    );

    memberIds.forEach((memberId) => {
      insertMembership.run(projectId, memberId);
    });

    return getProjectById(projectId);
  });
}

function updateProject(id, { name, logo, memberIds }) {
  return withTransaction((db) => {
    db.prepare("UPDATE project SET name = ?, logo = ? WHERE id = ?").run(
      name,
      logo || null,
      id,
    );
    db.prepare("DELETE FROM project_members WHERE project_id = ?").run(id);

    const insertMembership = db.prepare(
      "INSERT INTO project_members (project_id, member_id) VALUES (?, ?)",
    );

    memberIds.forEach((memberId) => {
      insertMembership.run(id, memberId);
    });

    return getProjectById(id);
  });
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

function listRecentAtas(limit = 5) {
  return getDb()
    .prepare(
      `
      SELECT
        a.id,
        a.meeting_datetime,
        a.project_id,
        p.name AS project_name,
        p.logo AS project_logo
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
        p.logo AS project_logo
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
  };
  return ata;
}

function getAtaPresentMembers(ataId) {
  return getDb()
    .prepare(
      `
      SELECT m.id, m.name, m.is_active
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
    conditions.push("l.due_at < CURRENT_TIMESTAMP");
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
        "SELECT COUNT(*) AS total FROM inventory_loan WHERE returned_at IS NULL AND due_at < CURRENT_TIMESTAMP",
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
  getProjectById,
  getProjectMembers,
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
  listProjectsWithMembers,
  listRecentAtas,
  extendInventoryLoan,
  returnInventoryLoan,
  updateInventoryCategory,
  updateInventoryItem,
  updateInventoryLocation,
  updateMember,
  updateProject,
  withdrawInventoryItem,
};
