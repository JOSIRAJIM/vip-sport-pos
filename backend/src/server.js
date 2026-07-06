const path = require("path");
const express = require("express");
const { config } = require("./config");
const { pool, waitForDatabase, withTransaction } = require("./db");
const { createPasswordHash, signToken, verifyPassword, verifyToken } = require("./auth");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.static(path.join(__dirname, "..", "public")));

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function toMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toCents(value) {
  return Math.round((Number(value) || 0) * 100);
}

function toPositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw httpError(400, `${fieldName} debe ser un entero positivo.`);
  }
  return parsed;
}

function toNonNegativeMoney(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw httpError(400, `${fieldName} debe ser un valor mayor o igual a cero.`);
  }
  return toMoney(parsed);
}

function getRequestedDate(value) {
  const date = value || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw httpError(400, "La fecha debe tener formato YYYY-MM-DD.");
  }
  return date;
}

function nullableText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function nullableDateTime(value) {
  const text = nullableText(value);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, "Fecha invalida.");
  }
  if (text.length === 10) {
    return `${text} 00:00:00`;
  }
  const normalized = text.replace("T", " ");
  return normalized.length === 16 ? `${normalized}:00` : normalized;
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    is_active: Boolean(row.is_active),
    created_at: row.created_at
  };
}

function canManageShift(user, shift) {
  return user.role === "admin" || user.role === "supervisor" || Number(shift.opened_by) === Number(user.id);
}

async function authRequired(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = verifyToken(token, config.jwtSecret);
    if (!payload || !payload.sub) {
      throw httpError(401, "Sesion invalida o expirada.");
    }

    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.is_active, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.is_active = 1`,
      [payload.sub]
    );

    if (!rows[0]) {
      throw httpError(401, "Usuario inactivo o inexistente.");
    }

    req.user = mapUser(rows[0]);
    next();
  } catch (error) {
    next(error);
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (req.user.role === "admin" || roles.includes(req.user.role)) {
      next();
      return;
    }
    next(httpError(403, "No tienes permisos para esta accion."));
  };
}

async function resolveCategoryId(db, categoryId, categoryName) {
  if (categoryId) {
    const id = Number(categoryId);
    const [rows] = await db.query("SELECT id FROM categories WHERE id = ?", [id]);
    if (!rows[0]) {
      throw httpError(400, "La categoria no existe.");
    }
    return id;
  }

  const name = nullableText(categoryName);
  if (!name) {
    return null;
  }

  await db.query("INSERT IGNORE INTO categories (name) VALUES (?)", [name]);
  const [rows] = await db.query("SELECT id FROM categories WHERE name = ?", [name]);
  return rows[0].id;
}

async function getCashSalesTotal(db, shiftId) {
  const [rows] = await db.query(
    `SELECT COALESCE(SUM(sp.amount), 0) AS total
     FROM sale_payments sp
     JOIN sales s ON s.id = sp.sale_id
     JOIN payment_methods pm ON pm.id = sp.payment_method_id
     WHERE s.shift_id = ? AND s.status = 'COMPLETED' AND pm.code = 'cash'`,
    [shiftId]
  );
  return toMoney(rows[0].total || 0);
}

async function getShiftSalesSummary(db, shiftId) {
  const [salesRows] = await db.query(
    `SELECT COUNT(*) AS sales_count, COALESCE(SUM(total), 0) AS total_sales
     FROM sales
     WHERE shift_id = ? AND status = 'COMPLETED'`,
    [shiftId]
  );
  const [paymentRows] = await db.query(
    `SELECT pm.code, pm.name, COALESCE(SUM(sp.amount), 0) AS total, COUNT(*) AS payments
     FROM sale_payments sp
     JOIN payment_methods pm ON pm.id = sp.payment_method_id
     JOIN sales s ON s.id = sp.sale_id
     WHERE s.shift_id = ? AND s.status = 'COMPLETED'
     GROUP BY pm.id, pm.code, pm.name
     ORDER BY total DESC, pm.name`,
    [shiftId]
  );

  return {
    sales_count: Number(salesRows[0].sales_count || 0),
    total_sales: toMoney(salesRows[0].total_sales || 0),
    payments: paymentRows.map((row) => ({
      ...row,
      total: toMoney(row.total),
      payments: Number(row.payments || 0)
    }))
  };
}

async function fetchShiftSummary(db, shiftId) {
  const [rows] = await db.query(
    `SELECT s.*, opener.full_name AS opened_by_name, closer.full_name AS closed_by_name
     FROM shifts s
     JOIN users opener ON opener.id = s.opened_by
     LEFT JOIN users closer ON closer.id = s.closed_by
     WHERE s.id = ?`,
    [shiftId]
  );

  if (!rows[0]) {
    return null;
  }

  const salesSummary = await getShiftSalesSummary(db, shiftId);
  const cashPayment = salesSummary.payments.find((payment) => payment.code === "cash");
  const cashSales = cashPayment ? cashPayment.total : 0;
  const expectedCash = rows[0].status === "OPEN" ? toMoney(Number(rows[0].opening_cash) + cashSales) : rows[0].expected_cash;

  return {
    ...rows[0],
    opening_cash: toMoney(rows[0].opening_cash),
    total_sales: salesSummary.total_sales,
    sales_count: salesSummary.sales_count,
    payments: salesSummary.payments,
    cash_sales: cashSales,
    expected_cash: toMoney(expectedCash || 0),
    counted_cash: rows[0].counted_cash == null ? null : toMoney(rows[0].counted_cash),
    difference: rows[0].difference == null ? null : toMoney(rows[0].difference)
  };
}

async function fetchSale(db, saleId) {
  const [saleRows] = await db.query(
    `SELECT s.*, u.full_name AS cashier_name, c.full_name AS customer_full_name,
            c.document_type AS customer_document_type, c.document_number AS customer_document_number
     FROM sales s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.id = ?`,
    [saleId]
  );

  if (!saleRows[0]) {
    return null;
  }

  const [items] = await db.query(
    `SELECT id AS sale_item_id, product_id, sku_snapshot AS sku, name_snapshot AS name, size_snapshot AS size,
            color_snapshot AS color, quantity, returned_quantity, unit_price, total
     FROM sale_items
     WHERE sale_id = ?
     ORDER BY id`,
    [saleId]
  );

  const [payments] = await db.query(
    `SELECT sp.amount, sp.reference, sp.credit_note_id, pm.code, pm.name, cn.note_number AS credit_note_number
     FROM sale_payments sp
     JOIN payment_methods pm ON pm.id = sp.payment_method_id
     LEFT JOIN credit_notes cn ON cn.id = sp.credit_note_id
     WHERE sp.sale_id = ?
     ORDER BY sp.id`,
    [saleId]
  );

  return {
    ...saleRows[0],
    subtotal: toMoney(saleRows[0].subtotal),
    discount_total: toMoney(saleRows[0].discount_total || 0),
    tax_total: toMoney(saleRows[0].tax_total || 0),
    total: toMoney(saleRows[0].total),
    customer: saleRows[0].customer_id ? {
      id: saleRows[0].customer_id,
      full_name: saleRows[0].customer_full_name,
      document_type: saleRows[0].customer_document_type,
      document_number: saleRows[0].customer_document_number
    } : null,
    discount: saleRows[0].discount_id ? {
      id: saleRows[0].discount_id,
      code: saleRows[0].discount_code_snapshot,
      name: saleRows[0].discount_name_snapshot,
      discount_type: saleRows[0].discount_type_snapshot,
      value: toMoney(saleRows[0].discount_value_snapshot || 0)
    } : null,
    items: items.map((item) => ({
      ...item,
      unit_price: toMoney(item.unit_price),
      total: toMoney(item.total)
    })),
    payments: payments.map((payment) => ({
      ...payment,
      amount: toMoney(payment.amount)
    }))
  };
}

function createReceiptNumber() {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `POS-${timestamp}-${random}`;
}

function createReturnNumber() {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `DEV-${timestamp}-${random}`;
}

function createCreditNoteNumber() {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `NC-${timestamp}-${random}`;
}

function calculateDiscountCents(subtotalCents, discount) {
  if (!discount) {
    return 0;
  }
  if (subtotalCents < toCents(discount.min_subtotal || 0)) {
    throw httpError(400, "La venta no cumple el minimo para aplicar el descuento.");
  }
  if (discount.discount_type === "PERCENT") {
    if (Number(discount.value) <= 0 || Number(discount.value) > 100) {
      throw httpError(400, "El descuento porcentual debe estar entre 0 y 100.");
    }
    return Math.min(subtotalCents, Math.round(subtotalCents * Number(discount.value) / 100));
  }
  return Math.min(subtotalCents, toCents(discount.value));
}

app.get("/api/health", asyncHandler(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username || !password) {
    throw httpError(400, "Usuario y contrasena son obligatorios.");
  }

  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.password_hash, u.is_active, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.username = ?`,
    [username]
  );

  const user = rows[0];
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
    throw httpError(401, "Credenciales invalidas.");
  }

  const token = signToken({ sub: user.id, role: user.role }, config.jwtSecret);
  res.json({ token, user: mapUser(user) });
}));

app.get("/api/auth/me", authRequired, asyncHandler(async (req, res) => {
  res.json({ user: req.user });
}));

app.get("/api/dashboard", authRequired, asyncHandler(async (req, res) => {
  const date = getRequestedDate(req.query.date);
  const [[salesSummary], [lowStock], [openShifts]] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS transactions, COALESCE(SUM(total), 0) AS revenue
       FROM sales
       WHERE status = 'COMPLETED' AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
      [date, date]
    ),
    pool.query(
      `SELECT COUNT(*) AS low_stock
       FROM products
       WHERE is_active = 1 AND stock <= min_stock`,
      []
    ),
    pool.query("SELECT COUNT(*) AS open_shifts FROM shifts WHERE status = 'OPEN'", [])
  ]);

  res.json({
    date,
    transactions: Number(salesSummary[0].transactions || 0),
    revenue: toMoney(salesSummary[0].revenue || 0),
    low_stock: Number(lowStock[0].low_stock || 0),
    open_shifts: Number(openShifts[0].open_shifts || 0)
  });
}));

app.get("/api/categories", authRequired, asyncHandler(async (req, res) => {
  const [rows] = await pool.query("SELECT id, name FROM categories ORDER BY name");
  res.json({ categories: rows });
}));

app.get("/api/payment-methods", authRequired, asyncHandler(async (req, res) => {
  const activeFilter = req.query.active;
  const params = [];
  let sql = "SELECT id, code, name, requires_reference, is_active FROM payment_methods";
  if (activeFilter !== "all") {
    sql += " WHERE is_active = 1";
  }
  sql += " ORDER BY id";
  const [rows] = await pool.query(
    sql,
    params
  );
  res.json({
    payment_methods: rows.map((row) => ({
      ...row,
      requires_reference: Boolean(row.requires_reference),
      is_active: Boolean(row.is_active)
    }))
  });
}));

app.post("/api/payment-methods", authRequired, requireRoles("supervisor"), asyncHandler(async (req, res) => {
  const code = String(req.body.code || "").trim().toLowerCase().replace(/\s+/g, "_");
  const name = String(req.body.name || "").trim();
  if (!code || !name) {
    throw httpError(400, "Codigo y nombre de la forma de pago son obligatorios.");
  }
  if (!/^[a-z0-9_-]+$/.test(code)) {
    throw httpError(400, "El codigo solo puede tener letras, numeros, guion o guion bajo.");
  }

  const [result] = await pool.query(
    "INSERT INTO payment_methods (code, name, requires_reference, is_active) VALUES (?, ?, ?, ?)",
    [
      code,
      name,
      req.body.requires_reference === true || req.body.requires_reference === 1 ? 1 : 0,
      req.body.is_active === false || req.body.is_active === 0 ? 0 : 1
    ]
  );
  const [rows] = await pool.query("SELECT * FROM payment_methods WHERE id = ?", [result.insertId]);
  res.status(201).json({
    payment_method: {
      ...rows[0],
      requires_reference: Boolean(rows[0].requires_reference),
      is_active: Boolean(rows[0].is_active)
    }
  });
}));

app.put("/api/payment-methods/:id", authRequired, requireRoles("supervisor"), asyncHandler(async (req, res) => {
  const methodId = toPositiveInt(req.params.id, "Forma de pago");
  const code = String(req.body.code || "").trim().toLowerCase().replace(/\s+/g, "_");
  const name = String(req.body.name || "").trim();
  if (!code || !name) {
    throw httpError(400, "Codigo y nombre de la forma de pago son obligatorios.");
  }
  if (!/^[a-z0-9_-]+$/.test(code)) {
    throw httpError(400, "El codigo solo puede tener letras, numeros, guion o guion bajo.");
  }

  await pool.query(
    `UPDATE payment_methods
     SET code = ?, name = ?, requires_reference = ?, is_active = ?
     WHERE id = ?`,
    [
      code,
      name,
      req.body.requires_reference === true || req.body.requires_reference === 1 ? 1 : 0,
      req.body.is_active === false || req.body.is_active === 0 ? 0 : 1,
      methodId
    ]
  );
  const [rows] = await pool.query("SELECT * FROM payment_methods WHERE id = ?", [methodId]);
  if (!rows[0]) {
    throw httpError(404, "Forma de pago no encontrada.");
  }
  res.json({
    payment_method: {
      ...rows[0],
      requires_reference: Boolean(rows[0].requires_reference),
      is_active: Boolean(rows[0].is_active)
    }
  });
}));

app.get("/api/customers", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const search = String(req.query.search || "").trim();
  const params = [];
  let sql = `SELECT id, document_type, document_number, full_name, phone, email, address, is_active, created_at
             FROM customers
             WHERE 1 = 1`;
  if (req.query.active !== "all") {
    sql += " AND is_active = 1";
  }
  if (search) {
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    sql += " AND (full_name LIKE ? OR document_number LIKE ? OR phone LIKE ? OR email LIKE ?)";
  }
  sql += " ORDER BY full_name LIMIT 200";
  const [rows] = await pool.query(sql, params);
  res.json({ customers: rows.map((row) => ({ ...row, is_active: Boolean(row.is_active) })) });
}));

app.post("/api/customers", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const fullName = String(req.body.full_name || "").trim();
  if (!fullName) {
    throw httpError(400, "El nombre del cliente es obligatorio.");
  }

  const [result] = await pool.query(
    `INSERT INTO customers (document_type, document_number, full_name, phone, email, address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      nullableText(req.body.document_type),
      nullableText(req.body.document_number),
      fullName,
      nullableText(req.body.phone),
      nullableText(req.body.email),
      nullableText(req.body.address)
    ]
  );
  const [rows] = await pool.query("SELECT * FROM customers WHERE id = ?", [result.insertId]);
  res.status(201).json({ customer: { ...rows[0], is_active: Boolean(rows[0].is_active) } });
}));

app.put("/api/customers/:id", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const customerId = toPositiveInt(req.params.id, "Cliente");
  const fullName = String(req.body.full_name || "").trim();
  if (!fullName) {
    throw httpError(400, "El nombre del cliente es obligatorio.");
  }

  await pool.query(
    `UPDATE customers
     SET document_type = ?, document_number = ?, full_name = ?, phone = ?, email = ?,
         address = ?, is_active = ?
     WHERE id = ?`,
    [
      nullableText(req.body.document_type),
      nullableText(req.body.document_number),
      fullName,
      nullableText(req.body.phone),
      nullableText(req.body.email),
      nullableText(req.body.address),
      req.body.is_active === false || req.body.is_active === 0 ? 0 : 1,
      customerId
    ]
  );
  const [rows] = await pool.query("SELECT * FROM customers WHERE id = ?", [customerId]);
  if (!rows[0]) {
    throw httpError(404, "Cliente no encontrado.");
  }
  res.json({ customer: { ...rows[0], is_active: Boolean(rows[0].is_active) } });
}));

app.get("/api/discounts", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const params = [];
  let sql = `SELECT d.*, u.full_name AS created_by_name
             FROM discounts d
             JOIN users u ON u.id = d.created_by
             WHERE 1 = 1`;
  if (req.query.active === "true") {
    sql += " AND d.is_active = 1 AND (d.starts_at IS NULL OR d.starts_at <= CURRENT_TIMESTAMP) AND (d.ends_at IS NULL OR d.ends_at >= CURRENT_TIMESTAMP)";
  } else if (req.query.active !== "all") {
    sql += " AND d.is_active = 1";
  }
  const search = String(req.query.search || "").trim();
  if (search) {
    params.push(`%${search}%`, `%${search}%`);
    sql += " AND (d.code LIKE ? OR d.name LIKE ?)";
  }
  sql += " ORDER BY d.created_at DESC LIMIT 200";
  const [rows] = await pool.query(sql, params);
  res.json({
    discounts: rows.map((row) => ({
      ...row,
      value: toMoney(row.value),
      min_subtotal: toMoney(row.min_subtotal),
      is_active: Boolean(row.is_active)
    }))
  });
}));

app.post("/api/discounts", authRequired, requireRoles("supervisor"), asyncHandler(async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const name = String(req.body.name || "").trim();
  const discountType = String(req.body.discount_type || "").toUpperCase();
  const value = toNonNegativeMoney(req.body.value, "Valor del descuento");
  const minSubtotal = toNonNegativeMoney(req.body.min_subtotal || 0, "Subtotal minimo");

  if (!code || !name || !["PERCENT", "FIXED"].includes(discountType)) {
    throw httpError(400, "Codigo, nombre y tipo de descuento son obligatorios.");
  }
  if (discountType === "PERCENT" && (value <= 0 || value > 100)) {
    throw httpError(400, "El descuento porcentual debe estar entre 0 y 100.");
  }

  const [result] = await pool.query(
    `INSERT INTO discounts (code, name, discount_type, value, min_subtotal, starts_at, ends_at, is_active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      code,
      name,
      discountType,
      value,
      minSubtotal,
      nullableDateTime(req.body.starts_at),
      nullableDateTime(req.body.ends_at),
      req.body.is_active === false || req.body.is_active === 0 ? 0 : 1,
      req.user.id
    ]
  );
  const [rows] = await pool.query("SELECT * FROM discounts WHERE id = ?", [result.insertId]);
  res.status(201).json({ discount: { ...rows[0], is_active: Boolean(rows[0].is_active) } });
}));

app.put("/api/discounts/:id", authRequired, requireRoles("supervisor"), asyncHandler(async (req, res) => {
  const discountId = toPositiveInt(req.params.id, "Descuento");
  const code = String(req.body.code || "").trim().toUpperCase();
  const name = String(req.body.name || "").trim();
  const discountType = String(req.body.discount_type || "").toUpperCase();
  const value = toNonNegativeMoney(req.body.value, "Valor del descuento");
  const minSubtotal = toNonNegativeMoney(req.body.min_subtotal || 0, "Subtotal minimo");

  if (!code || !name || !["PERCENT", "FIXED"].includes(discountType)) {
    throw httpError(400, "Codigo, nombre y tipo de descuento son obligatorios.");
  }
  if (discountType === "PERCENT" && (value <= 0 || value > 100)) {
    throw httpError(400, "El descuento porcentual debe estar entre 0 y 100.");
  }

  await pool.query(
    `UPDATE discounts
     SET code = ?, name = ?, discount_type = ?, value = ?, min_subtotal = ?,
         starts_at = ?, ends_at = ?, is_active = ?
     WHERE id = ?`,
    [
      code,
      name,
      discountType,
      value,
      minSubtotal,
      nullableDateTime(req.body.starts_at),
      nullableDateTime(req.body.ends_at),
      req.body.is_active === false || req.body.is_active === 0 ? 0 : 1,
      discountId
    ]
  );
  const [rows] = await pool.query("SELECT * FROM discounts WHERE id = ?", [discountId]);
  if (!rows[0]) {
    throw httpError(404, "Descuento no encontrado.");
  }
  res.json({ discount: { ...rows[0], is_active: Boolean(rows[0].is_active) } });
}));

app.get("/api/taxes", authRequired, requireRoles("supervisor"), asyncHandler(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM taxes ORDER BY name");
  res.json({ taxes: rows.map((row) => ({ ...row, rate: toMoney(row.rate), is_active: Boolean(row.is_active) })) });
}));

app.post("/api/taxes", authRequired, requireRoles("supervisor"), asyncHandler(async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();
  const name = String(req.body.name || "").trim();
  const rate = toNonNegativeMoney(req.body.rate, "Tarifa");
  if (!code || !name) {
    throw httpError(400, "Codigo y nombre del impuesto son obligatorios.");
  }

  const [result] = await pool.query(
    "INSERT INTO taxes (code, name, rate, is_active) VALUES (?, ?, ?, ?)",
    [code, name, rate, req.body.is_active === false || req.body.is_active === 0 ? 0 : 1]
  );
  const [rows] = await pool.query("SELECT * FROM taxes WHERE id = ?", [result.insertId]);
  res.status(201).json({ tax: { ...rows[0], is_active: Boolean(rows[0].is_active) } });
}));

app.put("/api/taxes/:id", authRequired, requireRoles("supervisor"), asyncHandler(async (req, res) => {
  const taxId = toPositiveInt(req.params.id, "Impuesto");
  const code = String(req.body.code || "").trim().toUpperCase();
  const name = String(req.body.name || "").trim();
  const rate = toNonNegativeMoney(req.body.rate, "Tarifa");
  if (!code || !name) {
    throw httpError(400, "Codigo y nombre del impuesto son obligatorios.");
  }

  await pool.query(
    "UPDATE taxes SET code = ?, name = ?, rate = ?, is_active = ? WHERE id = ?",
    [code, name, rate, req.body.is_active === false || req.body.is_active === 0 ? 0 : 1, taxId]
  );
  const [rows] = await pool.query("SELECT * FROM taxes WHERE id = ?", [taxId]);
  if (!rows[0]) {
    throw httpError(404, "Impuesto no encontrado.");
  }
  res.json({ tax: { ...rows[0], is_active: Boolean(rows[0].is_active) } });
}));

app.get("/api/credit-notes", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const search = String(req.query.search || "").trim();
  const params = [];
  let sql = `SELECT cn.*, c.full_name AS customer_name
             FROM credit_notes cn
             LEFT JOIN customers c ON c.id = cn.customer_id
             WHERE 1 = 1`;
  if (req.query.status) {
    params.push(String(req.query.status).toUpperCase());
    sql += " AND cn.status = ?";
  }
  if (search) {
    params.push(`%${search}%`, `%${search}%`);
    sql += " AND (cn.note_number LIKE ? OR c.full_name LIKE ?)";
  }
  sql += " ORDER BY cn.created_at DESC LIMIT 100";
  const [rows] = await pool.query(sql, params);
  res.json({
    credit_notes: rows.map((row) => ({
      ...row,
      amount: toMoney(row.amount),
      remaining_amount: toMoney(row.remaining_amount)
    }))
  });
}));

app.get("/api/products", authRequired, asyncHandler(async (req, res) => {
  const params = [];
  let sql = `SELECT p.id, p.sku, p.reference, p.barcode, p.name, p.category_id, c.name AS category_name, p.size, p.color,
                    p.cost, p.price, p.stock, p.min_stock, p.is_active, p.created_at, p.updated_at
             FROM products p
             LEFT JOIN categories c ON c.id = p.category_id
             WHERE 1 = 1`;

  if (req.query.active !== "all") {
    sql += " AND p.is_active = 1";
  }

  const search = String(req.query.search || "").trim();
  if (search) {
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    sql += " AND (p.sku LIKE ? OR p.reference LIKE ? OR p.barcode LIKE ? OR p.name LIKE ? OR c.name LIKE ?)";
  }

  if (search) {
    params.push(search, search, search, `${search}%`, `${search}%`, `${search}%`, `%${search}%`);
    sql += ` ORDER BY
      CASE
        WHEN p.barcode = ? THEN 0
        WHEN p.sku = ? THEN 1
        WHEN p.reference = ? THEN 2
        WHEN p.barcode LIKE ? OR p.sku LIKE ? OR p.reference LIKE ? THEN 3
        WHEN p.name LIKE ? THEN 4
        ELSE 5
      END,
      p.name, p.size, p.color`;
  } else {
    sql += " ORDER BY p.name, p.size, p.color";
  }

  const requestedLimit = Number(req.query.limit || 300);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 300) : 300;
  params.push(limit);
  sql += " LIMIT ?";

  const [rows] = await pool.query(sql, params);
  res.json({
    products: rows.map((row) => ({
      ...row,
      cost: toMoney(row.cost),
      price: toMoney(row.price),
      is_active: Boolean(row.is_active),
      low_stock: Number(row.stock) <= Number(row.min_stock)
    }))
  });
}));

app.post("/api/products", authRequired, requireRoles("supervisor", "inventario"), asyncHandler(async (req, res) => {
  const sku = String(req.body.sku || "").trim();
  const reference = nullableText(req.body.reference);
  const barcode = nullableText(req.body.barcode);
  const name = String(req.body.name || "").trim();
  const price = toNonNegativeMoney(req.body.price, "Precio");
  const cost = toNonNegativeMoney(req.body.cost || 0, "Costo");
  const stock = Number(req.body.stock || 0);
  const minStock = Number(req.body.min_stock || 0);

  if (!sku || !name) {
    throw httpError(400, "SKU y nombre son obligatorios.");
  }
  if (!Number.isInteger(stock) || stock < 0 || !Number.isInteger(minStock) || minStock < 0) {
    throw httpError(400, "Stock y stock minimo deben ser enteros mayores o iguales a cero.");
  }

  const product = await withTransaction(async (connection) => {
    const categoryId = await resolveCategoryId(connection, req.body.category_id, req.body.category_name);
    const [result] = await connection.query(
      `INSERT INTO products (sku, reference, barcode, name, category_id, size, color, cost, price, stock, min_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sku,
        reference,
        barcode,
        name,
        categoryId,
        nullableText(req.body.size),
        nullableText(req.body.color),
        cost,
        price,
        stock,
        minStock
      ]
    );

    if (stock > 0) {
      await connection.query(
        `INSERT INTO inventory_movements
           (product_id, user_id, movement_type, quantity, previous_stock, new_stock, note)
         VALUES (?, ?, 'ADJUSTMENT', ?, 0, ?, ?)`,
        [result.insertId, req.user.id, stock, stock, "Stock inicial"]
      );
    }

    const [rows] = await connection.query(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = ?`,
      [result.insertId]
    );
    return rows[0];
  });

  res.status(201).json({ product });
}));

app.put("/api/products/:id", authRequired, requireRoles("supervisor", "inventario"), asyncHandler(async (req, res) => {
  const productId = toPositiveInt(req.params.id, "Producto");
  const sku = String(req.body.sku || "").trim();
  const reference = nullableText(req.body.reference);
  const barcode = nullableText(req.body.barcode);
  const name = String(req.body.name || "").trim();
  const price = toNonNegativeMoney(req.body.price, "Precio");
  const cost = toNonNegativeMoney(req.body.cost || 0, "Costo");
  const minStock = Number(req.body.min_stock || 0);

  if (!sku || !name) {
    throw httpError(400, "SKU y nombre son obligatorios.");
  }
  if (!Number.isInteger(minStock) || minStock < 0) {
    throw httpError(400, "Stock minimo debe ser entero mayor o igual a cero.");
  }

  const product = await withTransaction(async (connection) => {
    const [existingRows] = await connection.query("SELECT id FROM products WHERE id = ? FOR UPDATE", [productId]);
    if (!existingRows[0]) {
      throw httpError(404, "Producto no encontrado.");
    }

    const categoryId = await resolveCategoryId(connection, req.body.category_id, req.body.category_name);
    await connection.query(
      `UPDATE products
       SET sku = ?, reference = ?, barcode = ?, name = ?, category_id = ?, size = ?, color = ?, cost = ?, price = ?,
           min_stock = ?, is_active = ?
       WHERE id = ?`,
      [
        sku,
        reference,
        barcode,
        name,
        categoryId,
        nullableText(req.body.size),
        nullableText(req.body.color),
        cost,
        price,
        minStock,
        req.body.is_active === false || req.body.is_active === 0 ? 0 : 1,
        productId
      ]
    );

    const [rows] = await connection.query(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = ?`,
      [productId]
    );
    return rows[0];
  });

  res.json({ product });
}));

app.post("/api/products/:id/stock", authRequired, requireRoles("supervisor", "inventario"), asyncHandler(async (req, res) => {
  const productId = toPositiveInt(req.params.id, "Producto");
  const type = String(req.body.type || "").toUpperCase();
  const quantity = Number(req.body.quantity);

  if (!["IN", "OUT", "ADJUSTMENT"].includes(type)) {
    throw httpError(400, "Tipo de movimiento invalido.");
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw httpError(400, "Cantidad debe ser un entero mayor o igual a cero.");
  }

  const movement = await withTransaction(async (connection) => {
    const [products] = await connection.query("SELECT * FROM products WHERE id = ? FOR UPDATE", [productId]);
    const product = products[0];
    if (!product) {
      throw httpError(404, "Producto no encontrado.");
    }

    const previousStock = Number(product.stock);
    let newStock;
    let delta;
    if (type === "IN") {
      delta = quantity;
      newStock = previousStock + quantity;
    } else if (type === "OUT") {
      delta = -quantity;
      newStock = previousStock - quantity;
    } else {
      delta = quantity - previousStock;
      newStock = quantity;
    }

    if (newStock < 0) {
      throw httpError(409, "El movimiento deja el inventario en negativo.");
    }

    await connection.query("UPDATE products SET stock = ? WHERE id = ?", [newStock, productId]);
    const [result] = await connection.query(
      `INSERT INTO inventory_movements
         (product_id, user_id, movement_type, quantity, previous_stock, new_stock, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [productId, req.user.id, type, delta, previousStock, newStock, nullableText(req.body.note)]
    );

    return {
      id: result.insertId,
      product_id: productId,
      movement_type: type,
      quantity: delta,
      previous_stock: previousStock,
      new_stock: newStock
    };
  });

  res.status(201).json({ movement });
}));

app.get("/api/shifts/current", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id FROM shifts WHERE opened_by = ? AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1",
    [req.user.id]
  );
  const shift = rows[0] ? await fetchShiftSummary(pool, rows[0].id) : null;
  res.json({ shift });
}));

app.get("/api/shifts", authRequired, requireRoles("supervisor"), asyncHandler(async (req, res) => {
  const date = req.query.date ? getRequestedDate(req.query.date) : null;
  const params = [];
  let sql = `SELECT s.id
             FROM shifts s
             WHERE 1 = 1`;

  if (req.query.status) {
    params.push(String(req.query.status).toUpperCase());
    sql += " AND s.status = ?";
  }
  if (date) {
    params.push(date, date);
    sql += " AND s.opened_at >= ? AND s.opened_at < DATE_ADD(?, INTERVAL 1 DAY)";
  }
  sql += " ORDER BY s.opened_at DESC LIMIT 100";

  const [rows] = await pool.query(sql, params);
  const shifts = [];
  for (const row of rows) {
    shifts.push(await fetchShiftSummary(pool, row.id));
  }
  res.json({ shifts });
}));

app.post("/api/shifts/open", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const openingCash = toNonNegativeMoney(req.body.opening_cash, "Base de caja");

  const shift = await withTransaction(async (connection) => {
    const [openRows] = await connection.query(
      "SELECT id FROM shifts WHERE opened_by = ? AND status = 'OPEN' FOR UPDATE",
      [req.user.id]
    );
    if (openRows[0]) {
      throw httpError(409, "Ya tienes un turno abierto.");
    }

    const [result] = await connection.query(
      "INSERT INTO shifts (opened_by, opening_cash) VALUES (?, ?)",
      [req.user.id, openingCash]
    );
    return fetchShiftSummary(connection, result.insertId);
  });

  res.status(201).json({ shift });
}));

app.post("/api/shifts/:id/close", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const shiftId = toPositiveInt(req.params.id, "Turno");
  const countedCash = toNonNegativeMoney(req.body.counted_cash, "Efectivo contado");

  const shift = await withTransaction(async (connection) => {
    const [rows] = await connection.query("SELECT * FROM shifts WHERE id = ? FOR UPDATE", [shiftId]);
    const currentShift = rows[0];
    if (!currentShift) {
      throw httpError(404, "Turno no encontrado.");
    }
    if (currentShift.status !== "OPEN") {
      throw httpError(409, "El turno ya esta cerrado.");
    }
    if (!canManageShift(req.user, currentShift)) {
      throw httpError(403, "No puedes cerrar un turno de otro usuario.");
    }

    const cashSales = await getCashSalesTotal(connection, shiftId);
    const expectedCash = toMoney(Number(currentShift.opening_cash) + cashSales);
    const difference = toMoney(countedCash - expectedCash);

    await connection.query(
      `UPDATE shifts
       SET status = 'CLOSED', closed_by = ?, expected_cash = ?, counted_cash = ?,
           difference = ?, closed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [req.user.id, expectedCash, countedCash, difference, shiftId]
    );
    await connection.query(
      `INSERT INTO cash_closures (shift_id, user_id, expected_cash, counted_cash, difference, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [shiftId, req.user.id, expectedCash, countedCash, difference, nullableText(req.body.notes)]
    );

    return fetchShiftSummary(connection, shiftId);
  });

  res.json({ shift });
}));

app.post("/api/sales", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const shiftId = toPositiveInt(req.body.shift_id, "Turno");
  const itemsInput = Array.isArray(req.body.items) ? req.body.items : [];
  const paymentsInput = Array.isArray(req.body.payments) ? req.body.payments : [];
  let customerId = req.body.customer_id ? toPositiveInt(req.body.customer_id, "Cliente") : null;
  const discountId = req.body.discount_id ? toPositiveInt(req.body.discount_id, "Descuento") : null;

  if (!itemsInput.length) {
    throw httpError(400, "La venta debe tener al menos un producto.");
  }
  if (!paymentsInput.length) {
    throw httpError(400, "La venta debe tener al menos una forma de pago.");
  }

  const itemMap = new Map();
  for (const item of itemsInput) {
    const productId = toPositiveInt(item.product_id, "Producto");
    const quantity = toPositiveInt(item.quantity, "Cantidad");
    itemMap.set(productId, (itemMap.get(productId) || 0) + quantity);
  }

  const sale = await withTransaction(async (connection) => {
    const [shiftRows] = await connection.query("SELECT * FROM shifts WHERE id = ? FOR UPDATE", [shiftId]);
    const shift = shiftRows[0];
    if (!shift) {
      throw httpError(404, "Turno no encontrado.");
    }
    if (shift.status !== "OPEN") {
      throw httpError(409, "El turno esta cerrado.");
    }
    if (!canManageShift(req.user, shift)) {
      throw httpError(403, "No puedes vender en un turno de otro usuario.");
    }

    let customer = null;
    if (customerId) {
      const [customers] = await connection.query("SELECT * FROM customers WHERE id = ? AND is_active = 1", [customerId]);
      customer = customers[0];
      if (!customer) {
        throw httpError(400, "Cliente invalido o inactivo.");
      }
    }

    const saleItems = [];
    let subtotalCents = 0;

    for (const [productId, quantity] of itemMap.entries()) {
      const [products] = await connection.query(
        "SELECT * FROM products WHERE id = ? AND is_active = 1 FOR UPDATE",
        [productId]
      );
      const product = products[0];
      if (!product) {
        throw httpError(404, `Producto ${productId} no encontrado o inactivo.`);
      }
      if (Number(product.stock) < quantity) {
        throw httpError(409, `Stock insuficiente para ${product.name}. Disponible: ${product.stock}.`);
      }

      const lineCents = toCents(product.price) * quantity;
      subtotalCents += lineCents;
      saleItems.push({
        product,
        quantity,
        unit_price: toMoney(product.price),
        total: lineCents / 100
      });
    }

    let discount = null;
    if (discountId) {
      const [discounts] = await connection.query(
        `SELECT *
         FROM discounts
         WHERE id = ? AND is_active = 1
           AND (starts_at IS NULL OR starts_at <= CURRENT_TIMESTAMP)
           AND (ends_at IS NULL OR ends_at >= CURRENT_TIMESTAMP)
         FOR UPDATE`,
        [discountId]
      );
      discount = discounts[0];
      if (!discount) {
        throw httpError(400, "Descuento invalido o inactivo.");
      }
    }

    const discountCents = calculateDiscountCents(subtotalCents, discount);
    const taxCents = 0;
    const totalCents = subtotalCents - discountCents + taxCents;
    if (totalCents <= 0) {
      throw httpError(400, "El total de la venta debe ser mayor a cero.");
    }

    const paymentRows = [];
    let paymentCents = 0;
    let creditNoteCents = 0;
    const usedCreditNoteIds = new Set();

    for (const payment of paymentsInput) {
      const paymentMethodId = toPositiveInt(payment.payment_method_id, "Forma de pago");
      const amount = toNonNegativeMoney(payment.amount, "Valor pagado");
      if (amount <= 0) {
        throw httpError(400, "Cada pago debe ser mayor a cero.");
      }

      const [methods] = await connection.query(
        "SELECT id, code, name, requires_reference FROM payment_methods WHERE id = ? AND is_active = 1",
        [paymentMethodId]
      );
      const method = methods[0];
      if (!method) {
        throw httpError(400, "Forma de pago invalida.");
      }
      if (method.requires_reference && !nullableText(payment.reference)) {
        throw httpError(400, `La forma de pago ${method.name} requiere referencia.`);
      }

      let creditNote = null;
      if (method.code === "credit_note") {
        const noteNumber = nullableText(payment.reference);
        const [notes] = await connection.query(
          "SELECT * FROM credit_notes WHERE note_number = ? FOR UPDATE",
          [noteNumber]
        );
        creditNote = notes[0];
        if (!creditNote || creditNote.status !== "OPEN") {
          throw httpError(400, "La nota credito no existe o no esta disponible.");
        }
        if (usedCreditNoteIds.has(Number(creditNote.id))) {
          throw httpError(400, "La misma nota credito no puede usarse mas de una vez en la venta.");
        }
        if (toCents(amount) !== toCents(creditNote.remaining_amount)) {
          throw httpError(400, "El valor de la nota credito debe redimirse completo.");
        }
        if (creditNote.customer_id && customerId && Number(creditNote.customer_id) !== Number(customerId)) {
          throw httpError(400, "La nota credito pertenece a otro cliente.");
        }
        if (creditNote.customer_id && !customerId) {
          customerId = Number(creditNote.customer_id);
          const [customers] = await connection.query("SELECT * FROM customers WHERE id = ?", [customerId]);
          customer = customers[0] || null;
        }
        usedCreditNoteIds.add(Number(creditNote.id));
        creditNoteCents += toCents(amount);
      }

      paymentCents += toCents(amount);
      paymentRows.push({
        method,
        amount,
        reference: nullableText(payment.reference),
        creditNote
      });
    }

    if (creditNoteCents > totalCents) {
      throw httpError(400, "La venta debe ser de igual o mayor valor que la nota credito.");
    }

    if (paymentCents !== totalCents) {
      throw httpError(400, "El total pagado debe coincidir exactamente con el total de la venta.");
    }

    const receiptNumber = createReceiptNumber();
    const subtotal = subtotalCents / 100;
    const discountTotal = discountCents / 100;
    const taxTotal = taxCents / 100;
    const total = totalCents / 100;
    const [saleResult] = await connection.query(
      `INSERT INTO sales
         (receipt_number, shift_id, user_id, customer_id, customer_name, discount_id,
          discount_code_snapshot, discount_name_snapshot, discount_type_snapshot,
          discount_value_snapshot, subtotal, discount_total, tax_total, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        receiptNumber,
        shiftId,
        req.user.id,
        customerId,
        nullableText(req.body.customer_name) || (customer ? customer.full_name : null),
        discount ? discount.id : null,
        discount ? discount.code : null,
        discount ? discount.name : null,
        discount ? discount.discount_type : null,
        discount ? discount.value : null,
        subtotal,
        discountTotal,
        taxTotal,
        total
      ]
    );
    const saleId = saleResult.insertId;

    for (const item of saleItems) {
      const previousStock = Number(item.product.stock);
      const newStock = previousStock - item.quantity;
      await connection.query(
        `INSERT INTO sale_items
           (sale_id, product_id, sku_snapshot, name_snapshot, size_snapshot, color_snapshot,
            quantity, unit_price, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          saleId,
          item.product.id,
          item.product.sku,
          item.product.name,
          item.product.size,
          item.product.color,
          item.quantity,
          item.unit_price,
          item.total
        ]
      );
      await connection.query("UPDATE products SET stock = ? WHERE id = ?", [newStock, item.product.id]);
      await connection.query(
        `INSERT INTO inventory_movements
           (product_id, sale_id, user_id, movement_type, quantity, previous_stock, new_stock, note)
         VALUES (?, ?, ?, 'SALE', ?, ?, ?, ?)`,
        [item.product.id, saleId, req.user.id, -item.quantity, previousStock, newStock, receiptNumber]
      );
    }

    for (const payment of paymentRows) {
      await connection.query(
        `INSERT INTO sale_payments (sale_id, payment_method_id, amount, reference, credit_note_id)
         VALUES (?, ?, ?, ?, ?)`,
        [saleId, payment.method.id, payment.amount, payment.reference, payment.creditNote ? payment.creditNote.id : null]
      );
      if (payment.creditNote) {
        await connection.query(
          `UPDATE credit_notes
           SET status = 'REDEEMED', remaining_amount = 0, redeemed_sale_id = ?, redeemed_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [saleId, payment.creditNote.id]
        );
      }
    }

    return fetchSale(connection, saleId);
  });

  res.status(201).json({ sale });
}));

app.get("/api/sales", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const date = getRequestedDate(req.query.date);
  const params = [date, date];
  let shiftFilter = "";
  if (req.query.shift_id) {
    shiftFilter = " AND s.shift_id = ?";
    params.push(toPositiveInt(req.query.shift_id, "Turno"));
  }

  const [rows] = await pool.query(
    `SELECT s.id, s.receipt_number, s.subtotal, s.discount_total, s.tax_total, s.total,
            s.created_at, s.customer_name, u.full_name AS cashier_name
     FROM sales s
     JOIN users u ON u.id = s.user_id
     WHERE s.status = 'COMPLETED'
       AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)
       ${shiftFilter}
     ORDER BY s.created_at DESC
     LIMIT 200`,
    params
  );

  res.json({
    sales: rows.map((row) => ({
      ...row,
      subtotal: toMoney(row.subtotal),
      discount_total: toMoney(row.discount_total || 0),
      tax_total: toMoney(row.tax_total || 0),
      total: toMoney(row.total)
    }))
  });
}));

app.get("/api/sales/by-receipt/:receipt", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const receiptNumber = String(req.params.receipt || "").trim();
  const [rows] = await pool.query("SELECT id FROM sales WHERE receipt_number = ?", [receiptNumber]);
  if (!rows[0]) {
    throw httpError(404, "Venta no encontrada.");
  }
  const sale = await fetchSale(pool, rows[0].id);
  res.json({ sale });
}));

app.get("/api/sales/:id", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const sale = await fetchSale(pool, toPositiveInt(req.params.id, "Venta"));
  if (!sale) {
    throw httpError(404, "Venta no encontrada.");
  }
  res.json({ sale });
}));

app.get("/api/returns", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const date = req.query.date ? getRequestedDate(req.query.date) : null;
  const params = [];
  let sql = `SELECT r.id, r.return_number, r.total, r.reason, r.created_at,
                    s.receipt_number, u.full_name AS cashier_name,
                    cn.note_number, cn.status AS credit_note_status
             FROM returns r
             JOIN sales s ON s.id = r.sale_id
             JOIN users u ON u.id = r.user_id
             LEFT JOIN credit_notes cn ON cn.return_id = r.id
             WHERE 1 = 1`;
  if (date) {
    params.push(date, date);
    sql += " AND r.created_at >= ? AND r.created_at < DATE_ADD(?, INTERVAL 1 DAY)";
  }
  sql += " ORDER BY r.created_at DESC LIMIT 100";
  const [rows] = await pool.query(sql, params);
  res.json({ returns: rows.map((row) => ({ ...row, total: toMoney(row.total) })) });
}));

app.post("/api/returns", authRequired, requireRoles("supervisor", "cajero"), asyncHandler(async (req, res) => {
  const saleId = toPositiveInt(req.body.sale_id, "Venta");
  const shiftId = req.body.shift_id ? toPositiveInt(req.body.shift_id, "Turno") : null;
  const itemsInput = Array.isArray(req.body.items) ? req.body.items : [];

  if (!itemsInput.length) {
    throw httpError(400, "La devolucion debe tener al menos un producto.");
  }

  const itemMap = new Map();
  for (const item of itemsInput) {
    const saleItemId = toPositiveInt(item.sale_item_id, "Item de venta");
    const quantity = toPositiveInt(item.quantity, "Cantidad");
    itemMap.set(saleItemId, (itemMap.get(saleItemId) || 0) + quantity);
  }

  const result = await withTransaction(async (connection) => {
    let activeShiftId = shiftId;
    if (!activeShiftId) {
      const [shiftRows] = await connection.query(
        "SELECT * FROM shifts WHERE opened_by = ? AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1 FOR UPDATE",
        [req.user.id]
      );
      if (!shiftRows[0]) {
        throw httpError(409, "Debes tener un turno abierto para registrar devoluciones.");
      }
      activeShiftId = shiftRows[0].id;
    }

    const [shiftRows] = await connection.query("SELECT * FROM shifts WHERE id = ? FOR UPDATE", [activeShiftId]);
    const shift = shiftRows[0];
    if (!shift || shift.status !== "OPEN") {
      throw httpError(409, "El turno no esta abierto.");
    }
    if (!canManageShift(req.user, shift)) {
      throw httpError(403, "No puedes registrar devoluciones en un turno de otro usuario.");
    }

    const [saleRows] = await connection.query("SELECT * FROM sales WHERE id = ? FOR UPDATE", [saleId]);
    const sale = saleRows[0];
    if (!sale || sale.status !== "COMPLETED") {
      throw httpError(404, "Venta no encontrada o no disponible para devolucion.");
    }

    const returnNumber = createReturnNumber();
    const returnItems = [];
    const ratio = Number(sale.subtotal) > 0 ? Number(sale.total) / Number(sale.subtotal) : 1;
    let returnCents = 0;

    for (const [saleItemId, quantity] of itemMap.entries()) {
      const [itemRows] = await connection.query(
        "SELECT * FROM sale_items WHERE id = ? AND sale_id = ? FOR UPDATE",
        [saleItemId, saleId]
      );
      const saleItem = itemRows[0];
      if (!saleItem) {
        throw httpError(404, "Item de venta no encontrado.");
      }
      const available = Number(saleItem.quantity) - Number(saleItem.returned_quantity);
      if (quantity > available) {
        throw httpError(409, `Cantidad a devolver supera lo disponible para ${saleItem.name_snapshot}.`);
      }

      const lineCents = Math.round(toCents(saleItem.unit_price) * quantity * ratio);
      returnCents += lineCents;
      returnItems.push({
        saleItem,
        quantity,
        unit_price: lineCents / quantity / 100,
        total: lineCents / 100
      });
    }

    if (returnCents <= 0) {
      throw httpError(400, "El valor de la devolucion debe ser mayor a cero.");
    }

    const [returnResult] = await connection.query(
      `INSERT INTO returns (return_number, sale_id, shift_id, user_id, customer_id, total, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [returnNumber, saleId, activeShiftId, req.user.id, sale.customer_id, returnCents / 100, nullableText(req.body.reason)]
    );
    const returnId = returnResult.insertId;

    for (const item of returnItems) {
      const [products] = await connection.query("SELECT * FROM products WHERE id = ? FOR UPDATE", [item.saleItem.product_id]);
      const product = products[0];
      if (!product) {
        throw httpError(404, "Producto de la devolucion no encontrado.");
      }
      const previousStock = Number(product.stock);
      const newStock = previousStock + item.quantity;

      await connection.query(
        `INSERT INTO return_items (return_id, sale_item_id, product_id, quantity, unit_price, total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [returnId, item.saleItem.id, item.saleItem.product_id, item.quantity, item.unit_price, item.total]
      );
      await connection.query(
        "UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ?",
        [item.quantity, item.saleItem.id]
      );
      await connection.query("UPDATE products SET stock = ? WHERE id = ?", [newStock, item.saleItem.product_id]);
      await connection.query(
        `INSERT INTO inventory_movements
           (product_id, sale_id, user_id, movement_type, quantity, previous_stock, new_stock, note)
         VALUES (?, ?, ?, 'RETURN', ?, ?, ?, ?)`,
        [item.saleItem.product_id, saleId, req.user.id, item.quantity, previousStock, newStock, returnNumber]
      );
    }

    const noteNumber = createCreditNoteNumber();
    const [creditNoteResult] = await connection.query(
      `INSERT INTO credit_notes (note_number, return_id, customer_id, amount, remaining_amount, issued_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [noteNumber, returnId, sale.customer_id, returnCents / 100, returnCents / 100, req.user.id]
    );

    const [returnRows] = await connection.query(
      `SELECT r.*, s.receipt_number, u.full_name AS cashier_name
       FROM returns r
       JOIN sales s ON s.id = r.sale_id
       JOIN users u ON u.id = r.user_id
       WHERE r.id = ?`,
      [returnId]
    );
    const [creditRows] = await connection.query("SELECT * FROM credit_notes WHERE id = ?", [creditNoteResult.insertId]);
    const [itemRows] = await connection.query(
      `SELECT ri.*, si.sku_snapshot AS sku, si.name_snapshot AS name,
              si.size_snapshot AS size, si.color_snapshot AS color
       FROM return_items ri
       JOIN sale_items si ON si.id = ri.sale_item_id
       WHERE ri.return_id = ?
       ORDER BY ri.id`,
      [returnId]
    );

    return {
      return: {
        ...returnRows[0],
        total: toMoney(returnRows[0].total),
        items: itemRows.map((item) => ({
          ...item,
          unit_price: toMoney(item.unit_price),
          total: toMoney(item.total)
        })),
        credit_note: {
          ...creditRows[0],
          amount: toMoney(creditRows[0].amount),
          remaining_amount: toMoney(creditRows[0].remaining_amount)
        }
      }
    };
  });

  res.status(201).json(result);
}));

app.get("/api/reports/daily", authRequired, requireRoles("supervisor"), asyncHandler(async (req, res) => {
  const date = getRequestedDate(req.query.date);
  const [summaryRows] = await pool.query(
    `SELECT COUNT(*) AS transactions, COALESCE(SUM(total), 0) AS revenue,
            COALESCE(SUM(discount_total), 0) AS discounts,
            COALESCE(SUM(tax_total), 0) AS taxes
     FROM sales
     WHERE status = 'COMPLETED'
       AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`,
    [date, date]
  );
  const [paymentRows] = await pool.query(
    `SELECT pm.code, pm.name, COALESCE(SUM(sp.amount), 0) AS total, COUNT(*) AS payments
     FROM sale_payments sp
     JOIN payment_methods pm ON pm.id = sp.payment_method_id
     JOIN sales s ON s.id = sp.sale_id
     WHERE s.status = 'COMPLETED'
       AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)
     GROUP BY pm.id, pm.code, pm.name
     ORDER BY total DESC`,
    [date, date]
  );
  const [productRows] = await pool.query(
    `SELECT si.sku_snapshot AS sku, si.name_snapshot AS name,
            COALESCE(SUM(si.quantity), 0) AS quantity, COALESCE(SUM(si.total), 0) AS total
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
     WHERE s.status = 'COMPLETED'
       AND s.created_at >= ? AND s.created_at < DATE_ADD(?, INTERVAL 1 DAY)
     GROUP BY si.sku_snapshot, si.name_snapshot
     ORDER BY quantity DESC, total DESC
     LIMIT 10`,
    [date, date]
  );
  const [hourRows] = await pool.query(
    `SELECT HOUR(created_at) AS hour, COUNT(*) AS transactions, COALESCE(SUM(total), 0) AS revenue
     FROM sales
     WHERE status = 'COMPLETED'
       AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
     GROUP BY HOUR(created_at)
     ORDER BY hour`,
    [date, date]
  );

  res.json({
    date,
    summary: {
      transactions: Number(summaryRows[0].transactions || 0),
      revenue: toMoney(summaryRows[0].revenue || 0),
      discounts: toMoney(summaryRows[0].discounts || 0),
      taxes: toMoney(summaryRows[0].taxes || 0)
    },
    payments: paymentRows.map((row) => ({
      ...row,
      total: toMoney(row.total),
      payments: Number(row.payments)
    })),
    top_products: productRows.map((row) => ({
      ...row,
      quantity: Number(row.quantity),
      total: toMoney(row.total)
    })),
    by_hour: hourRows.map((row) => ({
      hour: Number(row.hour),
      transactions: Number(row.transactions),
      revenue: toMoney(row.revenue)
    }))
  });
}));

app.get("/api/users", authRequired, requireRoles("admin"), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.is_active, u.created_at, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     ORDER BY u.created_at DESC`
  );
  res.json({ users: rows.map(mapUser) });
}));

app.post("/api/users", authRequired, requireRoles("admin"), asyncHandler(async (req, res) => {
  const username = String(req.body.username || "").trim();
  const fullName = String(req.body.full_name || "").trim();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "").trim();

  if (!username || !fullName || !password || !role) {
    throw httpError(400, "Usuario, nombre, rol y contrasena son obligatorios.");
  }

  const [roles] = await pool.query("SELECT id FROM roles WHERE name = ?", [role]);
  if (!roles[0]) {
    throw httpError(400, "Rol invalido.");
  }

  const [result] = await pool.query(
    "INSERT INTO users (username, full_name, password_hash, role_id) VALUES (?, ?, ?, ?)",
    [username, fullName, createPasswordHash(password), roles[0].id]
  );
  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.is_active, u.created_at, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`,
    [result.insertId]
  );

  res.status(201).json({ user: mapUser(rows[0]) });
}));

app.patch("/api/users/:id", authRequired, requireRoles("admin"), asyncHandler(async (req, res) => {
  const userId = toPositiveInt(req.params.id, "Usuario");
  const updates = [];
  const params = [];

  if (req.body.full_name !== undefined) {
    updates.push("full_name = ?");
    params.push(String(req.body.full_name || "").trim());
  }
  if (req.body.role !== undefined) {
    const [roles] = await pool.query("SELECT id FROM roles WHERE name = ?", [String(req.body.role).trim()]);
    if (!roles[0]) {
      throw httpError(400, "Rol invalido.");
    }
    updates.push("role_id = ?");
    params.push(roles[0].id);
  }
  if (req.body.password) {
    updates.push("password_hash = ?");
    params.push(createPasswordHash(String(req.body.password)));
  }
  if (req.body.is_active !== undefined) {
    updates.push("is_active = ?");
    params.push(req.body.is_active ? 1 : 0);
  }

  if (!updates.length) {
    throw httpError(400, "No hay cambios para guardar.");
  }

  params.push(userId);
  await pool.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);

  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.is_active, u.created_at, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`,
    [userId]
  );
  if (!rows[0]) {
    throw httpError(404, "Usuario no encontrado.");
  }

  res.json({ user: mapUser(rows[0]) });
}));

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((error, req, res, next) => {
  if (error && error.code === "ER_DUP_ENTRY") {
    res.status(409).json({ error: "Ya existe un registro con ese valor unico." });
    return;
  }

  const status = error.status || 500;
  const message = status >= 500 ? "Error interno del servidor." : error.message;
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({ error: message, details: error.details });
});

waitForDatabase()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`Vip Sport POS running on port ${config.port}`);
    });
  })
  .catch((error) => {
    console.error("Database is not available.", error);
    process.exit(1);
  });
