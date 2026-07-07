<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";

const API = "/api";
const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0
});

const navItems = [
  { id: "dashboard", label: "Dashboard", title: "Dashboard", kicker: "Panel", roles: ["admin", "supervisor", "cajero", "inventario"] },
  { id: "pos", label: "POS", title: "Punto de venta", kicker: "Ventas", roles: ["admin", "supervisor", "cajero"] },
  { id: "inventory", label: "Inventario", title: "Inventario", kicker: "Productos", roles: ["admin", "supervisor", "inventario"] },
  { id: "customers", label: "Clientes", title: "Clientes", kicker: "CRM", roles: ["admin", "supervisor", "cajero"] },
  { id: "discounts", label: "Descuentos", title: "Descuentos", kicker: "Reglas", roles: ["admin", "supervisor"] },
  { id: "payment-methods", label: "Formas de pago", title: "Formas de pago", kicker: "Parametros", roles: ["admin", "supervisor"] },
  { id: "taxes", label: "Impuestos", title: "Impuestos", kicker: "Parametros", roles: ["admin", "supervisor"] },
  { id: "returns", label: "Devoluciones", title: "Devoluciones y NC", kicker: "Postventa", roles: ["admin", "supervisor", "cajero"] },
  { id: "reports", label: "Reportes", title: "Reporte diario", kicker: "Ventas", roles: ["admin", "supervisor"] },
  { id: "shifts", label: "Turnos", title: "Turnos y cierre", kicker: "Caja", roles: ["admin", "supervisor", "cajero"] },
  { id: "users", label: "Usuarios", title: "Usuarios", kicker: "Acceso", roles: ["admin"] }
];

const roles = ["admin", "supervisor", "cajero", "inventario"];

const token = ref(localStorage.getItem("sportStoreToken") || "");
const user = ref(null);
const activeView = ref("dashboard");
const loading = ref(false);
const toast = reactive({ show: false, message: "", type: "" });
const loginForm = reactive({ username: "", password: "" });

const products = ref([]);
const categories = ref([]);
const paymentMethods = ref([]);
const customers = ref([]);
const discounts = ref([]);
const taxes = ref([]);
const returnsList = ref([]);
const dashboard = ref(null);
const currentShift = ref(null);
const shifts = ref([]);
const sales = ref([]);
const report = ref(null);
const users = ref([]);
const receipt = ref(null);

const productSearchInput = ref(null);
const posSearch = ref("");
const productSuggestions = ref([]);
const productSuggestionsQuery = ref("");
const productSuggestionIndex = ref(-1);
const productSearchLoading = ref(false);
const customerSearch = ref("");
const cart = ref([]);
const payments = ref([]);
const selectedCustomerId = ref("");
const selectedDiscountId = ref("");
const customerName = ref("");
const openingCash = ref(0);
const closeShift = reactive({ counted_cash: 0, notes: "" });
const reportDate = ref(today());
const shiftDate = ref(today());

const productForm = reactive(emptyProduct());
const editingProductId = ref(null);
const stockForms = reactive({});

const customerForm = reactive(emptyCustomer());
const editingCustomerId = ref(null);
const discountForm = reactive(emptyDiscount());
const editingDiscountId = ref(null);
const paymentMethodForm = reactive(emptyPaymentMethod());
const editingPaymentMethodId = ref(null);
const taxForm = reactive(emptyTax());
const editingTaxId = ref(null);
const returnReceiptSearch = ref("");
const returnSale = ref(null);
const returnQuantities = reactive({});
const returnReason = ref("");

const newUser = reactive({ username: "", full_name: "", role: "cajero", password: "" });
const userDrafts = reactive({});

const currentNav = computed(() => navItems.find((item) => item.id === activeView.value) || navItems[0]);
const visibleNav = computed(() => navItems.filter(canAccess));
const cartTotal = computed(() => roundMoney(cart.value.reduce((sum, item) => sum + Number(item.product.price) * item.quantity, 0)));
const selectedDiscount = computed(() => discounts.value.find((item) => Number(item.id) === Number(selectedDiscountId.value)) || null);
const discountTotal = computed(() => {
  const discount = selectedDiscount.value;
  if (!discount) return 0;
  if (cartTotal.value < Number(discount.min_subtotal || 0)) return 0;
  if (discount.discount_type === "PERCENT") {
    return roundMoney(Math.min(cartTotal.value, cartTotal.value * Number(discount.value || 0) / 100));
  }
  return roundMoney(Math.min(cartTotal.value, Number(discount.value || 0)));
});
const taxTotal = computed(() => 0);
const saleBaseTotal = computed(() => roundMoney(cartTotal.value - discountTotal.value + taxTotal.value));
const paymentMethodById = computed(() => new Map(paymentMethods.value.map((method) => [Number(method.id), method])));
const cardSurchargeRate = 0.05;

function isCardMethod(method) {
  const code = String(method?.code || "").toLowerCase();
  const name = String(method?.name || "").toLowerCase();
  return code === "debit" || code === "credit" || code.includes("card") || code.includes("tarjeta") || name.includes("tarjeta");
}

function paymentMethodFor(payment) {
  return paymentMethodById.value.get(Number(payment?.payment_method_id)) || null;
}

function paymentRequiresReference(payment) {
  return Boolean(paymentMethodFor(payment)?.requires_reference);
}

function paymentMethodIsCash(payment) {
  return paymentMethodFor(payment)?.code === "cash";
}

function hasPaymentMethod(method) {
  return payments.value.some((payment) => Number(payment.payment_method_id) === Number(method.id));
}

const usesCardPayment = computed(() => payments.value.some((payment) => isCardMethod(paymentMethodFor(payment))));
const cardSurchargeTotal = computed(() => usesCardPayment.value ? roundMoney(saleBaseTotal.value * cardSurchargeRate) : 0);
const saleTotal = computed(() => roundMoney(saleBaseTotal.value + cardSurchargeTotal.value));
const paidTotal = computed(() => roundMoney(payments.value.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)));
const balance = computed(() => roundMoney(saleTotal.value - paidTotal.value));
const activePaymentMethod = computed(() => paymentMethodById.value.get(Number(payments.value[0]?.payment_method_id)) || null);
const activePaymentRequiresReference = computed(() => Boolean(activePaymentMethod.value?.requires_reference));
const cashPaymentsTotal = computed(() => roundMoney(payments.value.reduce((sum, payment) => paymentMethodIsCash(payment) ? sum + Number(payment.amount || 0) : sum, 0)));
const cashReceived = ref(0);
const quickCashAmounts = computed(() => {
  const total = Math.max(0, cashPaymentsTotal.value || saleTotal.value);
  const bases = [10000, 20000, 50000, 100000];
  return [...new Set([total, ...bases].filter((amount) => amount > 0))];
});
const cashChange = computed(() => roundMoney(Math.max(0, Number(cashReceived.value || 0) - cashPaymentsTotal.value)));
const cashTenderedOk = computed(() => cashPaymentsTotal.value <= 0 || Number(cashReceived.value || 0) >= cashPaymentsTotal.value);
const canCompleteSale = computed(() => currentShift.value && cart.value.length > 0 && Math.round(balance.value * 100) === 0 && cashTenderedOk.value);
const posProductResults = computed(() => (productSuggestions.value.length ? productSuggestions.value : products.value).slice(0, 8));
const lowStockProducts = computed(() => products.value.filter((product) => product.low_stock).slice(0, 8));
const canManageUsers = computed(() => user.value?.role === "admin");
const canSeeSupervisorViews = computed(() => ["admin", "supervisor"].includes(user.value?.role));
const selectedCustomer = computed(() => customers.value.find((item) => Number(item.id) === Number(selectedCustomerId.value)) || null);
const selectedCustomerData = computed(() => {
  const customer = selectedCustomer.value;
  if (!customer) {
    return { document: "", first_name: "", last_name: "" };
  }
  const nameParts = String(customer.full_name || "").trim().split(/\s+/).filter(Boolean);
  return {
    document: [customer.document_type, customer.document_number].filter(Boolean).join(" "),
    first_name: nameParts[0] || "",
    last_name: nameParts.slice(1).join(" ")
  };
});
const cashDifferencePreview = computed(() => {
  if (!currentShift.value) return 0;
  return roundMoney(Number(closeShift.counted_cash || 0) - Number(currentShift.value.expected_cash || 0));
});

function today() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function emptyProduct() {
  return {
    sku: "",
    reference: "",
    barcode: "",
    name: "",
    category_id: "",
    category_name: "",
    size: "",
    color: "",
    cost: 0,
    price: 0,
    stock: 0,
    min_stock: 0,
    is_active: "1"
  };
}

function emptyCustomer() {
  return {
    document_type: "CC",
    document_number: "",
    full_name: "",
    phone: "",
    email: "",
    address: "",
    is_active: "1"
  };
}

function emptyDiscount() {
  return {
    code: "",
    name: "",
    discount_type: "PERCENT",
    value: 0,
    min_subtotal: 0,
    starts_at: "",
    ends_at: "",
    is_active: "1"
  };
}

function emptyPaymentMethod() {
  return {
    code: "",
    name: "",
    requires_reference: "0",
    is_active: "1"
  };
}

function emptyTax() {
  return {
    code: "",
    name: "",
    rate: 0,
    is_active: "1"
  };
}

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0));
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function canAccess(item) {
  return user.value && (user.value.role === "admin" || item.roles.includes(user.value.role));
}

function notify(message, type = "") {
  toast.message = message;
  toast.type = type;
  toast.show = true;
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => {
    toast.show = false;
  }, 3600);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token.value) {
    headers.Authorization = `Bearer ${token.value}`;
  }

  const response = await fetch(`${API}${path}`, {
    ...options,
    headers,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      logout(false);
    }
    throw new Error(payload.error || "No fue posible completar la accion.");
  }
  return payload;
}

async function guarded(action) {
  loading.value = true;
  try {
    await action();
  } catch (error) {
    notify(error.message, "error");
  } finally {
    loading.value = false;
  }
}

async function login() {
  await guarded(async () => {
    const result = await api("/auth/login", { method: "POST", body: loginForm });
    token.value = result.token;
    user.value = result.user;
    localStorage.setItem("sportStoreToken", token.value);
    await loadView();
  });
}

function logout(showMessage = true) {
  token.value = "";
  user.value = null;
  cart.value = [];
  payments.value = [];
  selectedCustomerId.value = "";
  selectedDiscountId.value = "";
  customerName.value = "";
  clearProductSearch();
  localStorage.removeItem("sportStoreToken");
  if (showMessage) {
    notify("Sesion cerrada.");
  }
}

async function setView(viewId) {
  const target = navItems.find((item) => item.id === viewId);
  if (!target || !canAccess(target)) return;
  activeView.value = viewId;
  await loadView();
}

async function loadView() {
  if (!user.value) return;
  const target = navItems.find((item) => item.id === activeView.value && canAccess(item));
  if (!target) {
    activeView.value = visibleNav.value[0]?.id || "dashboard";
  }

  if (activeView.value === "dashboard") await loadDashboard();
  if (activeView.value === "pos") await loadPos();
  if (activeView.value === "inventory") await loadInventory();
  if (activeView.value === "customers") await loadCustomers();
  if (activeView.value === "discounts") await loadDiscounts();
  if (activeView.value === "payment-methods") await loadPaymentMethods();
  if (activeView.value === "taxes") await loadTaxes();
  if (activeView.value === "returns") await loadReturns();
  if (activeView.value === "reports") await loadReports();
  if (activeView.value === "shifts") await loadShifts();
  if (activeView.value === "users") await loadUsers();
}

async function loadDashboard() {
  const [summary, productResult] = await Promise.all([
    api(`/dashboard?date=${today()}`),
    api("/products?active=all")
  ]);
  dashboard.value = summary;
  products.value = productResult.products;
}

async function loadProducts(search = "", active = "") {
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (active) query.set("active", active);
  const result = await api(`/products${query.toString() ? `?${query}` : ""}`);
  products.value = result.products;
}

async function loadPos() {
  const [productResult, methodResult, shiftResult, customerResult, discountResult] = await Promise.all([
    api("/products?limit=8"),
    api("/payment-methods"),
    api("/shifts/current"),
    api(`/customers?search=${encodeURIComponent(customerSearch.value)}`),
    api("/discounts?active=true")
  ]);
  products.value = productResult.products;
  paymentMethods.value = methodResult.payment_methods;
  currentShift.value = shiftResult.shift;
  customers.value = customerResult.customers;
  discounts.value = discountResult.discounts;
  if (!payments.value.length && saleTotal.value > 0) {
    setSinglePaymentToTotal();
  }
  focusProductSearch();
}

async function searchPos() {
  await guarded(async () => {
    const result = await api(`/customers?search=${encodeURIComponent(customerSearch.value)}`);
    customers.value = result.customers;
  });
}

function focusProductSearch() {
  nextTick(() => {
    productSearchInput.value?.focus();
  });
}

function clearProductSearch() {
  window.clearTimeout(queueProductSuggestions.timer);
  posSearch.value = "";
  productSuggestions.value = [];
  productSuggestionsQuery.value = "";
  productSuggestionIndex.value = -1;
}

async function loadProductSuggestions(query = posSearch.value) {
  const search = String(query || "").trim();
  if (!search) {
    clearProductSearch();
    return;
  }

  productSearchLoading.value = true;
  try {
    const result = await api(`/products?search=${encodeURIComponent(search)}&limit=10`);
    if (String(posSearch.value || "").trim() === search) {
      productSuggestions.value = result.products.slice(0, 10);
      productSuggestionsQuery.value = search;
      productSuggestionIndex.value = productSuggestions.value.length ? 0 : -1;
    }
  } catch (error) {
    notify(error.message, "error");
  } finally {
    productSearchLoading.value = false;
  }
}

function queueProductSuggestions() {
  window.clearTimeout(queueProductSuggestions.timer);
  const search = String(posSearch.value || "").trim();
  if (!search) {
    clearProductSearch();
    return;
  }
  productSuggestionIndex.value = -1;
  queueProductSuggestions.timer = window.setTimeout(() => {
    loadProductSuggestions(search);
  }, 120);
}

function moveProductSuggestion(direction) {
  const total = productSuggestions.value.length;
  if (!total) return;
  const current = productSuggestionIndex.value < 0 ? 0 : productSuggestionIndex.value;
  productSuggestionIndex.value = (current + direction + total) % total;
}

function findExactProduct(search) {
  const normalized = String(search || "").trim().toLowerCase();
  return productSuggestions.value.find((product) => (
    String(product.barcode || "").toLowerCase() === normalized ||
    String(product.sku || "").toLowerCase() === normalized ||
    String(product.reference || "").toLowerCase() === normalized
  ));
}

function addProductFromSearch(product) {
  if (!product) return;
  if (Number(product.stock) <= 0) {
    notify("Producto sin stock disponible.", "error");
    focusProductSearch();
    return;
  }
  addToCart(product);
  clearProductSearch();
  focusProductSearch();
}

async function confirmProductSearch() {
  const search = String(posSearch.value || "").trim();
  if (!search) return;
  if (!productSuggestions.value.length || productSuggestionsQuery.value !== search) {
    await loadProductSuggestions(search);
  }
  const selected = productSuggestions.value[productSuggestionIndex.value];
  const product = selected || findExactProduct(search) || productSuggestions.value[0];
  if (!product) {
    notify("No se encontro producto para agregar.", "error");
    focusProductSearch();
    return;
  }
  addProductFromSearch(product);
}

function addToCart(product) {
  const existing = cart.value.find((item) => Number(item.product.id) === Number(product.id));
  if (existing && existing.quantity >= product.stock) {
    notify("No hay mas stock disponible.", "error");
    return;
  }
  if (existing) existing.quantity += 1;
  else cart.value.push({ product, quantity: 1 });
  if (payments.value.length <= 1) setSinglePaymentToTotal();
}

function incrementCart(index) {
  const item = cart.value[index];
  if (item.quantity >= item.product.stock) {
    notify("No hay mas stock disponible.", "error");
    return;
  }
  item.quantity += 1;
  if (payments.value.length <= 1) setSinglePaymentToTotal();
}

function decrementCart(index) {
  const item = cart.value[index];
  item.quantity -= 1;
  if (item.quantity <= 0) cart.value.splice(index, 1);
  if (payments.value.length <= 1) setSinglePaymentToTotal();
}

function removeCart(index) {
  cart.value.splice(index, 1);
  if (payments.value.length <= 1) setSinglePaymentToTotal();
}

function remainingPaymentAmount(excludeIndex = null) {
  const paid = payments.value.reduce((sum, payment, index) => (
    index === excludeIndex ? sum : sum + Number(payment.amount || 0)
  ), 0);
  return roundMoney(Math.max(0, saleTotal.value - paid));
}

function ensureCashReceivedCoversCash() {
  if (cashPaymentsTotal.value > 0 && Number(cashReceived.value || 0) < cashPaymentsTotal.value) {
    cashReceived.value = cashPaymentsTotal.value;
  }
}

function normalizePaymentsToTotal() {
  if (!payments.value.length) {
    setSinglePaymentToTotal();
    return;
  }
  if (payments.value.length === 1) {
    payments.value[0].amount = saleTotal.value;
  } else {
    const lastIndex = payments.value.length - 1;
    payments.value[lastIndex].amount = roundMoney(Number(payments.value[lastIndex].amount || 0) + balance.value);
  }
  ensureCashReceivedCoversCash();
}

function setSinglePaymentToTotal(methodId = null) {
  const currentMethod = methodId
    ? paymentMethods.value.find((item) => Number(item.id) === Number(methodId))
    : paymentMethodById.value.get(Number(payments.value[0]?.payment_method_id));
  const method = currentMethod || paymentMethods.value.find((item) => item.code === "cash") || paymentMethods.value[0];
  if (!method) return;
  const reference = Number(payments.value[0]?.payment_method_id) === Number(method.id) ? payments.value[0]?.reference || "" : "";
  payments.value = [{ payment_method_id: method.id, amount: saleTotal.value, reference }];
  ensureCashReceivedCoversCash();
}

function selectPaymentMethod(method) {
  if (!payments.value.length || payments.value.length === 1) {
    setSinglePaymentToTotal(method.id);
    return;
  }
  addPayment(method.id);
}

function updatePaymentMethod(payment) {
  payment.reference = "";
  normalizePaymentsToTotal();
}

function addPayment(methodId = null) {
  const method = methodId
    ? paymentMethods.value.find((item) => Number(item.id) === Number(methodId))
    : paymentMethods.value[0];
  if (!method) return;
  payments.value.push({ payment_method_id: method.id, amount: 0, reference: "" });
  const index = payments.value.length - 1;
  payments.value[index].amount = remainingPaymentAmount(index);
  ensureCashReceivedCoversCash();
}

function removePayment(index) {
  payments.value.splice(index, 1);
  normalizePaymentsToTotal();
}

function selectDiscount(discountId) {
  selectedDiscountId.value = discountId || "";
  normalizePaymentsToTotal();
}

function setCashReceived(amount) {
  cashReceived.value = amount;
}

async function openShiftFromPos() {
  await guarded(async () => {
    await api("/shifts/open", { method: "POST", body: { opening_cash: Number(openingCash.value) } });
    openingCash.value = 0;
    notify("Turno abierto.");
    await loadView();
  });
}

function resetSaleState() {
  cart.value = [];
  payments.value = [];
  cashReceived.value = 0;
  customerName.value = "";
  selectedCustomerId.value = "";
  selectedDiscountId.value = "";
  receipt.value = null;
  clearProductSearch();
}

async function completeSale() {
  if (!canCompleteSale.value) return;
  const receiptWindow = window.open("", "sportStoreReceipt", "width=420,height=720");
  loading.value = true;
  try {
    const result = await api("/sales", {
      method: "POST",
      body: {
        shift_id: currentShift.value.id,
        customer_id: selectedCustomerId.value || null,
        customer_name: customerName.value,
        discount_id: selectedDiscountId.value || null,
        items: cart.value.map((item) => ({ product_id: item.product.id, quantity: item.quantity })),
        payments: payments.value.map((payment) => ({
          payment_method_id: payment.payment_method_id,
          amount: Number(payment.amount),
          reference: payment.reference || null
        }))
      }
    });
    resetSaleState();
    openReceiptPopup(result.sale, receiptWindow);
    notify("Venta registrada.");
    await loadPos();
  } catch (error) {
    if (receiptWindow && !receiptWindow.closed) {
      receiptWindow.close();
    }
    notify(error.message, "error");
  } finally {
    loading.value = false;
    focusProductSearch();
  }
}

function printReceipt() {
  window.print();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildReceiptHtml(sale) {
  const itemRows = sale.items.map((item) => `
    <div class="item">
      <strong>${escapeHtml(item.name)}</strong>
      <div class="row"><span>${escapeHtml(item.quantity)} x ${escapeHtml(formatMoney(item.unit_price))}</span><span>${escapeHtml(formatMoney(item.total))}</span></div>
      <small>${escapeHtml(item.sku)} ${escapeHtml(item.size || "")} ${escapeHtml(item.color || "")}</small>
    </div>
  `).join("");
  const paymentRows = sale.payments.map((payment) => `
    <div class="row">
      <span>${escapeHtml(payment.name)} ${payment.reference ? `(${escapeHtml(payment.reference)})` : ""}</span>
      <span>${escapeHtml(formatMoney(payment.amount))}</span>
    </div>
  `).join("");
  const customer = sale.customer?.full_name || sale.customer_name || "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Tirilla ${escapeHtml(sale.receipt_number)}</title>
  <style>
    body { margin: 0; background: #f4f6f5; color: #111; font-family: Arial, sans-serif; }
    .toolbar { display: flex; gap: 8px; padding: 12px; background: #fff; border-bottom: 1px solid #d9e2df; position: sticky; top: 0; }
    button { min-height: 36px; border: 0; border-radius: 6px; padding: 0 12px; background: #0f766e; color: #fff; font-weight: 700; cursor: pointer; }
    .receipt { width: 310px; margin: 16px auto; padding: 18px; background: #fff; font-family: Consolas, "Courier New", monospace; font-size: 12px; box-shadow: 0 12px 30px rgba(0,0,0,.12); }
    h3 { text-align: center; font-size: 15px; margin: 0 0 8px; }
    .line { border-top: 1px dashed #333; margin: 8px 0; }
    .row { display: flex; justify-content: space-between; gap: 8px; }
    .item { margin-bottom: 6px; }
    .center { text-align: center; }
    @media print {
      body { background: #fff; }
      .toolbar { display: none; }
      .receipt { margin: 0; box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar"><button type="button" onclick="window.print()">Imprimir</button></div>
  <main class="receipt">
    <h3>VIP SPORT</h3>
    <div class="row"><span>Tirilla</span><span>${escapeHtml(sale.receipt_number)}</span></div>
    <div class="row"><span>Fecha</span><span>${escapeHtml(new Date(sale.created_at).toLocaleString())}</span></div>
    <div class="row"><span>Cajero</span><span>${escapeHtml(sale.cashier_name)}</span></div>
    ${customer ? `<div class="row"><span>Cliente</span><span>${escapeHtml(customer)}</span></div>` : ""}
    <div class="line"></div>
    ${itemRows}
    <div class="line"></div>
    <div class="row"><span>Subtotal</span><span>${escapeHtml(formatMoney(sale.subtotal))}</span></div>
    ${sale.discount_total > 0 ? `<div class="row"><span>Descuento</span><span>-${escapeHtml(formatMoney(sale.discount_total))}</span></div>` : ""}
    ${sale.tax_total > 0 ? `<div class="row"><span>Impuestos</span><span>${escapeHtml(formatMoney(sale.tax_total))}</span></div>` : ""}
    <div class="row"><strong>Total</strong><strong>${escapeHtml(formatMoney(sale.total))}</strong></div>
    <div class="line"></div>
    ${paymentRows}
    <div class="line"></div>
    <p class="center">Gracias por su compra</p>
  </main>
</body>
</html>`;
}

function openReceiptPopup(sale, receiptWindow) {
  const target = receiptWindow && !receiptWindow.closed
    ? receiptWindow
    : window.open("", "sportStoreReceipt", "width=420,height=720");

  if (!target) {
    receipt.value = sale;
    return;
  }

  target.document.open();
  target.document.write(buildReceiptHtml(sale));
  target.document.close();
  target.focus();
}

async function loadInventory() {
  const [productResult, categoryResult] = await Promise.all([
    api("/products?active=all"),
    api("/categories")
  ]);
  products.value = productResult.products;
  categories.value = categoryResult.categories;
  for (const product of products.value) {
    if (!stockForms[product.id]) {
      stockForms[product.id] = { type: "IN", quantity: 0, note: "" };
    }
  }
}

function editProduct(product) {
  editingProductId.value = product.id;
  Object.assign(productForm, {
    sku: product.sku || "",
    reference: product.reference || "",
    barcode: product.barcode || "",
    name: product.name || "",
    category_id: product.category_id || "",
    category_name: "",
    size: product.size || "",
    color: product.color || "",
    cost: product.cost || 0,
    price: product.price || 0,
    stock: product.stock || 0,
    min_stock: product.min_stock || 0,
    is_active: product.is_active ? "1" : "0"
  });
}

function clearProductForm() {
  editingProductId.value = null;
  Object.assign(productForm, emptyProduct());
}

async function saveProduct() {
  await guarded(async () => {
    const body = {
      sku: productForm.sku,
      reference: productForm.reference || null,
      barcode: productForm.barcode || null,
      name: productForm.name,
      category_id: productForm.category_id || null,
      category_name: productForm.category_name || null,
      size: productForm.size || null,
      color: productForm.color || null,
      cost: Number(productForm.cost || 0),
      price: Number(productForm.price || 0),
      min_stock: Number(productForm.min_stock || 0),
      is_active: productForm.is_active === "1"
    };

    if (editingProductId.value) {
      await api(`/products/${editingProductId.value}`, { method: "PUT", body });
      notify("Producto actualizado.");
    } else {
      body.stock = Number(productForm.stock || 0);
      await api("/products", { method: "POST", body });
      notify("Producto creado.");
    }
    clearProductForm();
    await loadInventory();
  });
}

async function adjustStock(productId) {
  const form = stockForms[productId];
  await guarded(async () => {
    await api(`/products/${productId}/stock`, {
      method: "POST",
      body: { type: form.type, quantity: Number(form.quantity), note: form.note }
    });
    stockForms[productId] = { type: "IN", quantity: 0, note: "" };
    notify("Inventario actualizado.");
    await loadInventory();
  });
}

async function loadCustomers() {
  const result = await api(`/customers?active=all&search=${encodeURIComponent(customerSearch.value)}`);
  customers.value = result.customers;
}

function editCustomer(customer) {
  editingCustomerId.value = customer.id;
  Object.assign(customerForm, {
    document_type: customer.document_type || "CC",
    document_number: customer.document_number || "",
    full_name: customer.full_name || "",
    phone: customer.phone || "",
    email: customer.email || "",
    address: customer.address || "",
    is_active: customer.is_active ? "1" : "0"
  });
}

function clearCustomerForm() {
  editingCustomerId.value = null;
  Object.assign(customerForm, emptyCustomer());
}

async function saveCustomer() {
  await guarded(async () => {
    const body = { ...customerForm, is_active: customerForm.is_active === "1" };
    if (editingCustomerId.value) {
      await api(`/customers/${editingCustomerId.value}`, { method: "PUT", body });
      notify("Cliente actualizado.");
    } else {
      await api("/customers", { method: "POST", body });
      notify("Cliente creado.");
    }
    clearCustomerForm();
    await loadCustomers();
  });
}

async function loadDiscounts() {
  const result = await api("/discounts?active=all");
  discounts.value = result.discounts;
}

function editDiscount(discount) {
  editingDiscountId.value = discount.id;
  Object.assign(discountForm, {
    code: discount.code || "",
    name: discount.name || "",
    discount_type: discount.discount_type || "PERCENT",
    value: discount.value || 0,
    min_subtotal: discount.min_subtotal || 0,
    starts_at: discount.starts_at ? String(discount.starts_at).slice(0, 16) : "",
    ends_at: discount.ends_at ? String(discount.ends_at).slice(0, 16) : "",
    is_active: discount.is_active ? "1" : "0"
  });
}

function clearDiscountForm() {
  editingDiscountId.value = null;
  Object.assign(discountForm, emptyDiscount());
}

async function saveDiscount() {
  await guarded(async () => {
    const body = { ...discountForm, is_active: discountForm.is_active === "1" };
    if (editingDiscountId.value) {
      await api(`/discounts/${editingDiscountId.value}`, { method: "PUT", body });
      notify("Descuento actualizado.");
    } else {
      await api("/discounts", { method: "POST", body });
      notify("Descuento creado.");
    }
    clearDiscountForm();
    await loadDiscounts();
  });
}

async function loadPaymentMethods() {
  const result = await api("/payment-methods?active=all");
  paymentMethods.value = result.payment_methods;
}

function editPaymentMethod(method) {
  editingPaymentMethodId.value = method.id;
  Object.assign(paymentMethodForm, {
    code: method.code || "",
    name: method.name || "",
    requires_reference: method.requires_reference ? "1" : "0",
    is_active: method.is_active ? "1" : "0"
  });
}

function clearPaymentMethodForm() {
  editingPaymentMethodId.value = null;
  Object.assign(paymentMethodForm, emptyPaymentMethod());
}

async function savePaymentMethod() {
  await guarded(async () => {
    const body = {
      ...paymentMethodForm,
      requires_reference: paymentMethodForm.requires_reference === "1",
      is_active: paymentMethodForm.is_active === "1"
    };
    if (editingPaymentMethodId.value) {
      await api(`/payment-methods/${editingPaymentMethodId.value}`, { method: "PUT", body });
      notify("Forma de pago actualizada.");
    } else {
      await api("/payment-methods", { method: "POST", body });
      notify("Forma de pago creada.");
    }
    clearPaymentMethodForm();
    await loadPaymentMethods();
  });
}

async function loadTaxes() {
  const result = await api("/taxes");
  taxes.value = result.taxes;
}

function editTax(tax) {
  editingTaxId.value = tax.id;
  Object.assign(taxForm, {
    code: tax.code || "",
    name: tax.name || "",
    rate: tax.rate || 0,
    is_active: tax.is_active ? "1" : "0"
  });
}

function clearTaxForm() {
  editingTaxId.value = null;
  Object.assign(taxForm, emptyTax());
}

async function saveTax() {
  await guarded(async () => {
    const body = { ...taxForm, is_active: taxForm.is_active === "1" };
    if (editingTaxId.value) {
      await api(`/taxes/${editingTaxId.value}`, { method: "PUT", body });
      notify("Impuesto actualizado.");
    } else {
      await api("/taxes", { method: "POST", body });
      notify("Impuesto creado.");
    }
    clearTaxForm();
    await loadTaxes();
  });
}

async function loadReturns() {
  const [result, shiftResult] = await Promise.all([
    api(`/returns?date=${today()}`),
    api("/shifts/current")
  ]);
  returnsList.value = result.returns;
  currentShift.value = shiftResult.shift;
}

async function findReturnSale() {
  if (!returnReceiptSearch.value) return;
  await guarded(async () => {
    const result = await api(`/sales/by-receipt/${encodeURIComponent(returnReceiptSearch.value)}`);
    returnSale.value = result.sale;
    for (const item of result.sale.items) {
      returnQuantities[item.sale_item_id] = 0;
    }
  });
}

async function createReturn() {
  if (!returnSale.value || !currentShift.value) {
    notify("Debes tener turno abierto y una venta seleccionada.", "error");
    return;
  }
  const items = returnSale.value.items
    .map((item) => ({ sale_item_id: item.sale_item_id, quantity: Number(returnQuantities[item.sale_item_id] || 0) }))
    .filter((item) => item.quantity > 0);

  if (!items.length) {
    notify("Selecciona al menos un producto para devolver.", "error");
    return;
  }

  await guarded(async () => {
    const result = await api("/returns", {
      method: "POST",
      body: {
        sale_id: returnSale.value.id,
        shift_id: currentShift.value.id,
        reason: returnReason.value,
        items
      }
    });
    notify(`Devolucion registrada. NC ${result.return.credit_note.note_number}.`);
    returnReceiptSearch.value = "";
    returnSale.value = null;
    returnReason.value = "";
    await loadReturns();
  });
}

async function loadReports() {
  const [reportResult, saleResult] = await Promise.all([
    api(`/reports/daily?date=${reportDate.value}`),
    api(`/sales?date=${reportDate.value}`)
  ]);
  report.value = reportResult;
  sales.value = saleResult.sales;
}

async function loadShifts() {
  const current = await api("/shifts/current");
  currentShift.value = current.shift;
  if (currentShift.value) {
    closeShift.counted_cash = currentShift.value.expected_cash;
  }
  if (canSeeSupervisorViews.value) {
    const result = await api(`/shifts?date=${shiftDate.value}`);
    shifts.value = result.shifts;
  } else {
    shifts.value = [];
  }
}

async function closeCurrentShift() {
  if (!currentShift.value) return;
  await guarded(async () => {
    const result = await api(`/shifts/${currentShift.value.id}/close`, {
      method: "POST",
      body: {
        counted_cash: Number(closeShift.counted_cash),
        notes: closeShift.notes
      }
    });
    notify(`Turno cerrado. Diferencia ${formatMoney(result.shift.difference)}.`);
    closeShift.notes = "";
    await loadShifts();
  });
}

async function loadUsers() {
  if (!canManageUsers.value) return;
  const result = await api("/users");
  users.value = result.users;
  for (const item of users.value) {
    userDrafts[item.id] = {
      full_name: item.full_name,
      role: item.role,
      is_active: item.is_active ? "1" : "0",
      password: ""
    };
  }
}

async function createUser() {
  await guarded(async () => {
    await api("/users", { method: "POST", body: newUser });
    Object.assign(newUser, { username: "", full_name: "", role: "cajero", password: "" });
    notify("Usuario creado.");
    await loadUsers();
  });
}

async function updateUser(userId) {
  const draft = userDrafts[userId];
  const body = {
    full_name: draft.full_name,
    role: draft.role,
    is_active: draft.is_active === "1"
  };
  if (draft.password) body.password = draft.password;

  await guarded(async () => {
    await api(`/users/${userId}`, { method: "PATCH", body });
    notify("Usuario actualizado.");
    await loadUsers();
  });
}

watch(selectedCustomer, (customer) => {
  customerName.value = customer?.full_name || "";
});

onMounted(async () => {
  if (!token.value) return;
  await guarded(async () => {
    const result = await api("/auth/me");
    user.value = result.user;
    await loadView();
  });
});
</script>

<template>
  <section v-if="!user" class="login-screen">
    <form class="login-panel" @submit.prevent="login">
      <div>
        <p class="eyebrow">Vip Sport</p>
        <h1>POS e inventario</h1>
      </div>
      <label>
        Usuario
        <input v-model.trim="loginForm.username" autocomplete="username" required>
      </label>
      <label>
        Contrasena
        <input v-model="loginForm.password" type="password" autocomplete="current-password" required>
      </label>
      <button class="primary full" type="submit" :disabled="loading">Ingresar</button>
      <p class="hint">Demo: admin / Admin123!</p>
    </form>
  </section>

  <section v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">Sport</span>
        <div>
          <strong>Vip Sport</strong>
          <span>POS</span>
        </div>
      </div>

      <nav class="nav">
        <button
          v-for="item in visibleNav"
          :key="item.id"
          type="button"
          :class="{ active: activeView === item.id }"
          @click="setView(item.id)"
        >
          {{ item.label }}
        </button>
      </nav>

      <div class="session-box">
        <strong>{{ user.full_name }}</strong>
        <span>{{ user.role }}</span>
        <button class="ghost full" type="button" @click="logout()">Salir</button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ currentNav.kicker }}</p>
          <h2>{{ currentNav.title }}</h2>
        </div>
      </header>

      <section class="view">
        <div v-if="loading" class="panel">
          <div class="panel-body">
            <p class="muted">Cargando...</p>
          </div>
        </div>

        <template v-else-if="activeView === 'dashboard'">
          <section class="grid three">
            <article class="panel metric">
              <div class="panel-body">
                <p class="muted">Ventas hoy</p>
                <strong>{{ formatMoney(dashboard?.revenue || 0) }}</strong>
                <p class="muted">{{ dashboard?.transactions || 0 }} transacciones</p>
              </div>
            </article>
            <article class="panel metric">
              <div class="panel-body">
                <p class="muted">Stock bajo</p>
                <strong>{{ dashboard?.low_stock || 0 }}</strong>
                <p class="muted">productos por revisar</p>
              </div>
            </article>
            <article class="panel metric">
              <div class="panel-body">
                <p class="muted">Turnos abiertos</p>
                <strong>{{ dashboard?.open_shifts || 0 }}</strong>
                <p class="muted">cajas activas</p>
              </div>
            </article>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h3>Productos en alerta</h3>
              <span class="status-pill" :class="{ warn: lowStockProducts.length }">{{ lowStockProducts.length ? "Pendiente" : "OK" }}</span>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>SKU</th><th>Producto</th><th>Talla</th><th>Color</th><th>Stock</th><th>Minimo</th></tr>
                </thead>
                <tbody>
                  <tr v-if="!lowStockProducts.length">
                    <td colspan="6" class="muted">Sin alertas de inventario.</td>
                  </tr>
                  <tr v-for="product in lowStockProducts" :key="product.id">
                    <td>{{ product.sku }}</td>
                    <td>{{ product.name }}</td>
                    <td>{{ product.size || "-" }}</td>
                    <td>{{ product.color || "-" }}</td>
                    <td><span class="status-pill warn">{{ product.stock }}</span></td>
                    <td>{{ product.min_stock }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="activeView === 'pos'">
          <section class="pos-layout">
            <div class="pos-left-stack">
              <section class="panel pos-customer-panel">
                <div class="panel-header"><h3>Cliente</h3></div>
                <div class="panel-body grid">
                  <form class="toolbar" @submit.prevent="searchPos">
                    <label>Buscar cliente
                      <input v-model.trim="customerSearch" placeholder="Documento, nombre o telefono">
                    </label>
                    <button class="ghost" type="submit">Buscar</button>
                  </form>
                  <label>Cliente registrado
                    <select v-model="selectedCustomerId">
                      <option value="">Sin cliente registrado</option>
                      <option v-for="customer in customers" :key="customer.id" :value="customer.id">
                        {{ customer.full_name }} {{ customer.document_number ? `- ${customer.document_number}` : "" }}
                      </option>
                    </select>
                  </label>
                  <div class="form-grid compact readonly-customer">
                    <label>Documento
                      <input :value="selectedCustomerData.document" readonly>
                    </label>
                    <label>Nombre
                      <input :value="selectedCustomerData.first_name" readonly>
                    </label>
                    <label>Apellido
                      <input :value="selectedCustomerData.last_name" readonly>
                    </label>
                  </div>
                </div>
              </section>

              <section class="panel pos-sale-panel">
                <div class="panel-header pos-sale-header">
                  <div>
                    <h3>Carrito (Lista de productos)</h3>
                    <p v-if="currentShift" class="muted">Turno #{{ currentShift.id }} abierto por {{ currentShift.opened_by_name }}</p>
                    <p v-else class="muted">Abre un turno para empezar a vender.</p>
                  </div>
                  <div class="pos-sale-total">
                    <span class="muted">Total a pagar</span>
                    <strong>{{ formatMoney(saleTotal) }}</strong>
                    <span class="status-pill" :class="{ warn: balance !== 0 }">{{ formatMoney(balance) }} saldo</span>
                  </div>
                </div>

              <div class="panel-body pos-sale-body">
                <form v-if="!currentShift" class="toolbar shift-open-inline" @submit.prevent="openShiftFromPos">
                  <label>Base de caja
                    <input v-model.number="openingCash" type="number" min="0" step="100" required>
                  </label>
                  <button class="primary" type="submit">Abrir turno</button>
                </form>
                <div v-else class="shift-strip">
                  <span>Base {{ formatMoney(currentShift.opening_cash) }}</span>
                  <span>Total vendido {{ formatMoney(currentShift.total_sales || 0) }}</span>
                  <span>{{ currentShift.sales_count || 0 }} ventas</span>
                  <span>Efectivo esperado {{ formatMoney(currentShift.expected_cash) }}</span>
                </div>

                <div class="table-wrap pos-cart-table-wrap">
                  <table class="cart-table">
                    <thead>
                      <tr><th>SKU</th><th>Nombre</th><th>Cantidad</th><th>Precio</th><th>Extiende total</th><th></th></tr>
                    </thead>
                    <tbody>
                      <tr v-if="!cart.length">
                        <td colspan="6" class="muted">Carrito vacio.</td>
                      </tr>
                      <tr v-for="(item, index) in cart" :key="item.product.id">
                        <td>
                          <strong>{{ item.product.sku }}</strong>
                          <p class="muted"><template v-if="item.product.reference">Ref. {{ item.product.reference }}</template></p>
                        </td>
                        <td>
                          <strong>{{ item.product.name }}</strong>
                          <p class="muted">{{ item.product.size || "" }} {{ item.product.color || "" }}</p>
                        </td>
                        <td>
                          <div class="qty-stepper">
                            <button class="ghost mini icon-btn" type="button" @click="decrementCart(index)">-</button>
                            <strong>{{ item.quantity }}</strong>
                            <button class="ghost mini icon-btn" type="button" @click="incrementCart(index)">+</button>
                          </div>
                        </td>
                        <td>{{ formatMoney(item.product.price) }}</td>
                        <td><strong>{{ formatMoney(Number(item.product.price) * item.quantity) }}</strong></td>
                        <td><button class="danger mini icon-btn" type="button" @click="removeCart(index)">X</button></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div class="cart-subtotal">
                  <span>Subtotal:</span>
                  <strong>{{ formatMoney(cartTotal) }}</strong>
                </div>
              </div>
            </section>

              <section class="panel product-search-panel">
                <div class="panel-header"><h3>Producto</h3></div>
                <div class="panel-body">
                  <div class="pos-search-box">
                    <label>Buscar producto
                      <input
                        ref="productSearchInput"
                        v-model.trim="posSearch"
                        autocomplete="off"
                        placeholder="Codigo de barras, SKU, referencia o producto"
                        @input="queueProductSuggestions"
                        @focus="queueProductSuggestions"
                        @keydown.down.prevent="moveProductSuggestion(1)"
                        @keydown.up.prevent="moveProductSuggestion(-1)"
                        @keydown.enter.prevent="confirmProductSearch"
                        @keydown.esc.prevent="clearProductSearch"
                      >
                    </label>
                    <div v-if="posSearch" class="suggestion-panel" role="listbox">
                      <p v-if="productSearchLoading" class="muted">Buscando...</p>
                      <button
                        v-for="(product, index) in productSuggestions"
                        :key="product.id"
                        type="button"
                        class="suggestion-item"
                        :class="{ active: index === productSuggestionIndex, disabled: product.stock <= 0 }"
                        :disabled="product.stock <= 0"
                        role="option"
                        @mousedown.prevent="addProductFromSearch(product)"
                      >
                        <span>
                          <strong>{{ product.name }}</strong>
                          <small>{{ product.sku }} <template v-if="product.reference">/ Ref. {{ product.reference }}</template> <template v-if="product.barcode">/ {{ product.barcode }}</template></small>
                        </span>
                        <span>
                          <strong>{{ formatMoney(product.price) }}</strong>
                          <small>Stock {{ product.stock }}</small>
                        </span>
                      </button>
                      <p v-if="!productSearchLoading && productSuggestionsQuery === posSearch && !productSuggestions.length" class="muted">Sin resultados.</p>
                    </div>
                  </div>
                  <h3 class="section-title">Resultados de Busqueda</h3>
                  <div class="product-card-grid">
                    <article v-for="product in posProductResults" :key="product.id" class="product-card">
                      <div class="product-thumb">{{ product.name.slice(0, 2).toUpperCase() }}</div>
                      <div class="product-card-main">
                        <strong>{{ product.name }}</strong>
                        <span>{{ product.sku }} <template v-if="product.reference">/ {{ product.reference }}</template></span>
                        <b>{{ formatMoney(product.price) }}</b>
                      </div>
                      <button class="ghost mini icon-btn" type="button" :disabled="product.stock <= 0" @click="addProductFromSearch(product)">+</button>
                    </article>
                  </div>
                </div>
              </section>
            </div>

            <section class="grid two pos-checkout-grid">
              <section class="panel">
                <div class="panel-header"><h3>Resumen y Pago</h3></div>
                <div class="panel-body grid">
                  <div>
                    <h3 class="section-title compact">Codigo de Cupon o Descuento General:</h3>
                    <div class="discount-buttons">
                      <button class="ghost" type="button" :class="{ selected: !selectedDiscountId }" @click="selectDiscount('')">Sin descuento</button>
                      <button
                        v-for="discount in discounts"
                        :key="discount.id"
                        class="ghost"
                        type="button"
                        :class="{ selected: Number(selectedDiscountId) === Number(discount.id) }"
                        @click="selectDiscount(discount.id)"
                      >
                        {{ discount.discount_type === "PERCENT" ? `${discount.value}%` : formatMoney(discount.value) }}
                      </button>
                    </div>
                  </div>

                  <div class="summary-lines tight">
                    <div><span>Subtotal:</span><span>{{ formatMoney(cartTotal) }}</span></div>
                    <div><span>Descuento:</span><span class="danger-text">-{{ formatMoney(discountTotal) }}</span></div>
                    <div v-if="cardSurchargeTotal > 0"><span>Recargo tarjeta 5%:</span><span>{{ formatMoney(cardSurchargeTotal) }}</span></div>
                  </div>

                  <div class="pay-total">
                    <span>Total a pagar</span>
                    <strong>{{ formatMoney(saleTotal) }}</strong>
                  </div>

                  <div class="payment-button-grid">
                    <button
                      v-for="method in paymentMethods"
                      :key="method.id"
                      class="ghost payment-choice"
                      type="button"
                      :class="{ selected: hasPaymentMethod(method) }"
                      @click="selectPaymentMethod(method)"
                    >
                      {{ method.name }}
                    </button>
                  </div>

                  <div class="payment-list mixed-payment-list">
                    <div v-for="(payment, index) in payments" :key="index" class="payment-row">
                      <div class="form-grid compact">
                        <label>Forma
                          <select v-model.number="payment.payment_method_id" @change="updatePaymentMethod(payment)">
                            <option v-for="method in paymentMethods" :key="method.id" :value="method.id">{{ method.name }}</option>
                          </select>
                        </label>
                        <label>Valor
                          <input v-model.number="payment.amount" type="number" min="0" step="100">
                        </label>
                        <label v-if="paymentRequiresReference(payment)">Referencia
                          <input v-model.trim="payment.reference" placeholder="Numero o comprobante">
                        </label>
                      </div>
                      <button class="ghost mini" type="button" :disabled="payments.length <= 1" @click="removePayment(index)">Eliminar pago</button>
                    </div>
                  </div>
                  <button class="ghost" type="button" @click="addPayment()">Agregar otra forma de pago</button>

                  <label v-if="cashPaymentsTotal > 0">Recibido (Efectivo):
                    <input v-model.number="cashReceived" type="number" min="0" step="100">
                  </label>
                  <div v-if="cashPaymentsTotal > 0" class="quick-cash-grid">
                    <button v-for="amount in quickCashAmounts" :key="amount" class="ghost mini" type="button" @click="setCashReceived(amount)">
                      {{ formatMoney(amount) }}
                    </button>
                  </div>
                  <div v-if="cashPaymentsTotal > 0" class="change-box">
                    <span>Cambio a entregar (vueltos)</span>
                    <strong>{{ formatMoney(cashChange) }}</strong>
                  </div>

                  <div class="summary-lines">
                    <div><span>Pagado registrado</span><span>{{ formatMoney(paidTotal) }}</span></div>
                    <div><span>Saldo</span><span>{{ formatMoney(balance) }}</span></div>
                  </div>
                  <button class="primary full checkout-button" type="button" :disabled="!canCompleteSale || loading" @click="completeSale">Finalizar venta</button>
                  <p class="hint center">Verifica productos y montos antes de finalizar</p>
                </div>
              </section>
            </section>
          </section>
        </template>

        <template v-else-if="activeView === 'inventory'">
          <section class="panel">
            <div class="panel-header">
              <h3>{{ editingProductId ? "Editar producto" : "Nuevo producto" }}</h3>
              <button v-if="editingProductId" class="ghost" type="button" @click="clearProductForm">Cancelar</button>
            </div>
            <div class="panel-body">
              <form class="form-grid" @submit.prevent="saveProduct">
                <label>SKU<input v-model.trim="productForm.sku" required></label>
                <label>Referencia<input v-model.trim="productForm.reference"></label>
                <label>Codigo de barras<input v-model.trim="productForm.barcode"></label>
                <label class="span-2">Producto<input v-model.trim="productForm.name" required></label>
                <label>Categoria
                  <select v-model="productForm.category_id">
                    <option value="">Sin categoria</option>
                    <option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option>
                  </select>
                </label>
                <label>Nueva categoria<input v-model.trim="productForm.category_name"></label>
                <label>Talla<input v-model.trim="productForm.size"></label>
                <label>Color<input v-model.trim="productForm.color"></label>
                <label>Costo<input v-model.number="productForm.cost" type="number" min="0" step="100"></label>
                <label>Precio<input v-model.number="productForm.price" type="number" min="0" step="100" required></label>
                <label>Stock inicial<input v-model.number="productForm.stock" type="number" min="0" step="1" :disabled="Boolean(editingProductId)"></label>
                <label>Stock minimo<input v-model.number="productForm.min_stock" type="number" min="0" step="1"></label>
                <label>Activo
                  <select v-model="productForm.is_active">
                    <option value="1">Si</option>
                    <option value="0">No</option>
                  </select>
                </label>
                <div class="span-4 actions"><button class="primary" type="submit">{{ editingProductId ? "Guardar cambios" : "Crear producto" }}</button></div>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header"><h3>Productos</h3></div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>SKU</th><th>Referencia</th><th>Producto</th><th>Categoria</th><th>Precio</th><th>Stock</th><th>Ajuste</th><th></th></tr>
                </thead>
                <tbody>
                  <tr v-for="product in products" :key="product.id">
                    <td>{{ product.sku }}</td>
                    <td>{{ product.reference || "-" }}<br><span class="muted">{{ product.barcode || "" }}</span></td>
                    <td>{{ product.name }}<br><span class="muted">{{ product.size || "-" }} / {{ product.color || "-" }}</span></td>
                    <td>{{ product.category_name || "-" }}</td>
                    <td>{{ formatMoney(product.price) }}</td>
                    <td><span class="status-pill" :class="{ warn: product.low_stock }">{{ product.stock }}</span></td>
                    <td>
                      <div v-if="stockForms[product.id]" class="actions">
                        <select v-model="stockForms[product.id].type" class="stock-type">
                          <option value="IN">Entrada</option>
                          <option value="OUT">Salida</option>
                          <option value="ADJUSTMENT">Conteo</option>
                        </select>
                        <input v-model.number="stockForms[product.id].quantity" class="stock-qty" type="number" min="0" step="1">
                        <input v-model.trim="stockForms[product.id].note" class="stock-note" placeholder="Nota">
                        <button class="ghost mini" type="button" @click="adjustStock(product.id)">Guardar</button>
                      </div>
                    </td>
                    <td><button class="ghost mini" type="button" @click="editProduct(product)">Editar</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="activeView === 'customers'">
          <section class="panel">
            <div class="panel-header">
              <h3>{{ editingCustomerId ? "Editar cliente" : "Nuevo cliente" }}</h3>
              <button v-if="editingCustomerId" class="ghost" type="button" @click="clearCustomerForm">Cancelar</button>
            </div>
            <div class="panel-body">
              <form class="form-grid" @submit.prevent="saveCustomer">
                <label>Tipo doc.
                  <select v-model="customerForm.document_type">
                    <option value="CC">CC</option>
                    <option value="NIT">NIT</option>
                    <option value="CE">CE</option>
                    <option value="PAS">PAS</option>
                  </select>
                </label>
                <label>Documento<input v-model.trim="customerForm.document_number"></label>
                <label class="span-2">Nombre<input v-model.trim="customerForm.full_name" required></label>
                <label>Telefono<input v-model.trim="customerForm.phone"></label>
                <label>Email<input v-model.trim="customerForm.email" type="email"></label>
                <label class="span-2">Direccion<input v-model.trim="customerForm.address"></label>
                <label>Estado
                  <select v-model="customerForm.is_active">
                    <option value="1">Activo</option>
                    <option value="0">Inactivo</option>
                  </select>
                </label>
                <div class="span-4 actions">
                  <button class="primary" type="submit">{{ editingCustomerId ? "Guardar cliente" : "Crear cliente" }}</button>
                </div>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <h3>Clientes</h3>
              <form class="actions" @submit.prevent="guarded(loadCustomers)">
                <input v-model.trim="customerSearch" placeholder="Buscar cliente">
                <button class="ghost" type="submit">Buscar</button>
              </form>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Documento</th><th>Nombre</th><th>Telefono</th><th>Email</th><th>Estado</th><th></th></tr></thead>
                <tbody>
                  <tr v-if="!customers.length"><td colspan="6" class="muted">Sin clientes.</td></tr>
                  <tr v-for="customer in customers" :key="customer.id">
                    <td>{{ customer.document_type || "-" }} {{ customer.document_number || "" }}</td>
                    <td>{{ customer.full_name }}</td>
                    <td>{{ customer.phone || "-" }}</td>
                    <td>{{ customer.email || "-" }}</td>
                    <td><span class="status-pill" :class="{ bad: !customer.is_active }">{{ customer.is_active ? "Activo" : "Inactivo" }}</span></td>
                    <td><button class="ghost mini" type="button" @click="editCustomer(customer)">Editar</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="activeView === 'discounts'">
          <section class="panel">
            <div class="panel-header">
              <h3>{{ editingDiscountId ? "Editar descuento" : "Nuevo descuento" }}</h3>
              <button v-if="editingDiscountId" class="ghost" type="button" @click="clearDiscountForm">Cancelar</button>
            </div>
            <div class="panel-body">
              <form class="form-grid" @submit.prevent="saveDiscount">
                <label>Codigo<input v-model.trim="discountForm.code" required></label>
                <label class="span-2">Nombre<input v-model.trim="discountForm.name" required></label>
                <label>Tipo
                  <select v-model="discountForm.discount_type">
                    <option value="PERCENT">Porcentaje</option>
                    <option value="FIXED">Valor fijo</option>
                  </select>
                </label>
                <label>Valor<input v-model.number="discountForm.value" type="number" min="0" step="0.01" required></label>
                <label>Subtotal minimo<input v-model.number="discountForm.min_subtotal" type="number" min="0" step="100"></label>
                <label>Inicio<input v-model="discountForm.starts_at" type="datetime-local"></label>
                <label>Fin<input v-model="discountForm.ends_at" type="datetime-local"></label>
                <label>Estado
                  <select v-model="discountForm.is_active">
                    <option value="1">Activo</option>
                    <option value="0">Inactivo</option>
                  </select>
                </label>
                <div class="span-4 actions">
                  <button class="primary" type="submit">{{ editingDiscountId ? "Guardar descuento" : "Crear descuento" }}</button>
                </div>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header"><h3>Descuentos</h3></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Codigo</th><th>Nombre</th><th>Tipo</th><th>Valor</th><th>Minimo</th><th>Estado</th><th></th></tr></thead>
                <tbody>
                  <tr v-if="!discounts.length"><td colspan="7" class="muted">Sin descuentos.</td></tr>
                  <tr v-for="discount in discounts" :key="discount.id">
                    <td>{{ discount.code }}</td>
                    <td>{{ discount.name }}</td>
                    <td>{{ discount.discount_type === "PERCENT" ? "Porcentaje" : "Valor fijo" }}</td>
                    <td>{{ discount.discount_type === "PERCENT" ? `${discount.value}%` : formatMoney(discount.value) }}</td>
                    <td>{{ formatMoney(discount.min_subtotal) }}</td>
                    <td><span class="status-pill" :class="{ bad: !discount.is_active }">{{ discount.is_active ? "Activo" : "Inactivo" }}</span></td>
                    <td><button class="ghost mini" type="button" @click="editDiscount(discount)">Editar</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="activeView === 'payment-methods'">
          <section class="panel">
            <div class="panel-header">
              <h3>{{ editingPaymentMethodId ? "Editar forma de pago" : "Nueva forma de pago" }}</h3>
              <button v-if="editingPaymentMethodId" class="ghost" type="button" @click="clearPaymentMethodForm">Cancelar</button>
            </div>
            <div class="panel-body">
              <form class="form-grid compact" @submit.prevent="savePaymentMethod">
                <label>Codigo<input v-model.trim="paymentMethodForm.code" placeholder="ej: efectivo, nequi" required></label>
                <label>Nombre<input v-model.trim="paymentMethodForm.name" placeholder="Nombre visible" required></label>
                <label>Referencia
                  <select v-model="paymentMethodForm.requires_reference">
                    <option value="0">No requiere</option>
                    <option value="1">Requiere</option>
                  </select>
                </label>
                <label>Estado
                  <select v-model="paymentMethodForm.is_active">
                    <option value="1">Activo</option>
                    <option value="0">Inactivo</option>
                  </select>
                </label>
                <div class="span-4 actions">
                  <button class="primary" type="submit">{{ editingPaymentMethodId ? "Guardar forma de pago" : "Crear forma de pago" }}</button>
                </div>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header"><h3>Formas de pago parametrizadas</h3></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Codigo</th><th>Nombre</th><th>Referencia</th><th>Estado</th><th></th></tr></thead>
                <tbody>
                  <tr v-if="!paymentMethods.length"><td colspan="5" class="muted">Sin formas de pago.</td></tr>
                  <tr v-for="method in paymentMethods" :key="method.id">
                    <td>{{ method.code }}</td>
                    <td>{{ method.name }}</td>
                    <td>{{ method.requires_reference ? "Requiere" : "No requiere" }}</td>
                    <td><span class="status-pill" :class="{ bad: !method.is_active }">{{ method.is_active ? "Activo" : "Inactivo" }}</span></td>
                    <td><button class="ghost mini" type="button" @click="editPaymentMethod(method)">Editar</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="activeView === 'taxes'">
          <section class="panel">
            <div class="panel-header">
              <h3>{{ editingTaxId ? "Editar impuesto" : "Nuevo impuesto" }}</h3>
              <button v-if="editingTaxId" class="ghost" type="button" @click="clearTaxForm">Cancelar</button>
            </div>
            <div class="panel-body">
              <form class="form-grid compact" @submit.prevent="saveTax">
                <label>Codigo<input v-model.trim="taxForm.code" required></label>
                <label>Nombre<input v-model.trim="taxForm.name" required></label>
                <label>Tarifa %<input v-model.number="taxForm.rate" type="number" min="0" step="0.0001" required></label>
                <label>Estado
                  <select v-model="taxForm.is_active">
                    <option value="1">Activo</option>
                    <option value="0">Inactivo</option>
                  </select>
                </label>
                <div class="span-4 actions">
                  <button class="primary" type="submit">{{ editingTaxId ? "Guardar impuesto" : "Crear impuesto" }}</button>
                </div>
              </form>
              <p class="hint form-space">Los impuestos quedan parametrizados; por ahora no se aplican automaticamente a las ventas.</p>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header"><h3>Impuestos parametrizados</h3></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Codigo</th><th>Nombre</th><th>Tarifa</th><th>Estado</th><th></th></tr></thead>
                <tbody>
                  <tr v-if="!taxes.length"><td colspan="5" class="muted">Sin impuestos.</td></tr>
                  <tr v-for="tax in taxes" :key="tax.id">
                    <td>{{ tax.code }}</td>
                    <td>{{ tax.name }}</td>
                    <td>{{ tax.rate }}%</td>
                    <td><span class="status-pill" :class="{ bad: !tax.is_active }">{{ tax.is_active ? "Activo" : "Inactivo" }}</span></td>
                    <td><button class="ghost mini" type="button" @click="editTax(tax)">Editar</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="activeView === 'returns'">
          <section class="grid two">
            <section class="panel">
              <div class="panel-header"><h3>Nueva devolucion</h3></div>
              <div class="panel-body grid">
                <p v-if="!currentShift" class="muted">Debes abrir turno antes de registrar devoluciones.</p>
                <form class="toolbar" @submit.prevent="findReturnSale">
                  <label>Tirilla de venta
                    <input v-model.trim="returnReceiptSearch" placeholder="POS-..." required>
                  </label>
                  <button class="primary" type="submit">Buscar</button>
                </form>

                <div v-if="returnSale" class="grid">
                  <div class="actions">
                    <span class="status-pill">{{ returnSale.receipt_number }}</span>
                    <span class="muted">Total {{ formatMoney(returnSale.total) }}</span>
                    <span class="muted">{{ returnSale.customer_name || returnSale.customer?.full_name || "Sin cliente" }}</span>
                  </div>
                  <div class="table-wrap">
                    <table>
                      <thead><tr><th>Producto</th><th>Comprado</th><th>Devuelto</th><th>Disponible</th><th>Devolver</th></tr></thead>
                      <tbody>
                        <tr v-for="item in returnSale.items" :key="item.sale_item_id">
                          <td>{{ item.name }}<br><span class="muted">{{ item.sku }}</span></td>
                          <td>{{ item.quantity }}</td>
                          <td>{{ item.returned_quantity }}</td>
                          <td>{{ item.quantity - item.returned_quantity }}</td>
                          <td>
                            <input
                              v-model.number="returnQuantities[item.sale_item_id]"
                              type="number"
                              min="0"
                              :max="item.quantity - item.returned_quantity"
                              step="1"
                            >
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <label>Motivo
                    <textarea v-model.trim="returnReason" rows="3"></textarea>
                  </label>
                  <button class="danger" type="button" :disabled="!currentShift" @click="createReturn">Registrar devolucion y generar NC</button>
                </div>
              </div>
            </section>

            <section class="panel">
              <div class="panel-header"><h3>Notas credito</h3></div>
              <div class="panel-body">
                <p class="muted">La NC se redime completa como forma de pago en una compra de igual o mayor valor.</p>
              </div>
            </section>
          </section>

          <section class="panel">
            <div class="panel-header"><h3>Devoluciones de hoy</h3></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Devolucion</th><th>Venta</th><th>Cajero</th><th>Total</th><th>NC</th><th>Estado NC</th></tr></thead>
                <tbody>
                  <tr v-if="!returnsList.length"><td colspan="6" class="muted">Sin devoluciones.</td></tr>
                  <tr v-for="item in returnsList" :key="item.id">
                    <td>{{ item.return_number }}</td>
                    <td>{{ item.receipt_number }}</td>
                    <td>{{ item.cashier_name }}</td>
                    <td>{{ formatMoney(item.total) }}</td>
                    <td>{{ item.note_number }}</td>
                    <td><span class="status-pill" :class="{ warn: item.credit_note_status === 'OPEN' }">{{ item.credit_note_status }}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="activeView === 'reports'">
          <section class="panel">
            <div class="panel-body">
              <form class="toolbar" @submit.prevent="guarded(loadReports)">
                <label>Fecha
                  <input v-model="reportDate" type="date">
                </label>
                <button class="primary" type="submit">Consultar</button>
              </form>
            </div>
          </section>

          <section class="grid three">
            <article class="panel metric">
              <div class="panel-body">
                <p class="muted">Venta total</p>
                <strong>{{ formatMoney(report?.summary?.revenue || 0) }}</strong>
                <p class="muted">{{ report?.summary?.transactions || 0 }} transacciones</p>
                <p class="muted">Desc. {{ formatMoney(report?.summary?.discounts || 0) }} / Imp. {{ formatMoney(report?.summary?.taxes || 0) }}</p>
              </div>
            </article>
            <article class="panel metric">
              <div class="panel-body">
                <p class="muted">Ticket promedio</p>
                <strong>{{ formatMoney(report?.summary?.transactions ? report.summary.revenue / report.summary.transactions : 0) }}</strong>
                <p class="muted">por venta</p>
              </div>
            </article>
            <article class="panel metric">
              <div class="panel-body">
                <p class="muted">Formas de pago</p>
                <strong>{{ report?.payments?.length || 0 }}</strong>
                <p class="muted">activas en el dia</p>
              </div>
            </article>
          </section>

          <section class="grid two">
            <section class="panel">
              <div class="panel-header"><h3>Formas de pago</h3></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Metodo</th><th>Pagos</th><th>Total</th></tr></thead>
                  <tbody>
                    <tr v-if="!report?.payments?.length"><td colspan="3" class="muted">Sin datos.</td></tr>
                    <tr v-for="payment in report?.payments || []" :key="payment.code">
                      <td>{{ payment.name }}</td><td>{{ payment.payments }}</td><td>{{ formatMoney(payment.total) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
            <section class="panel">
              <div class="panel-header"><h3>Top productos</h3></div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>SKU</th><th>Producto</th><th>Cant.</th><th>Total</th></tr></thead>
                  <tbody>
                    <tr v-if="!report?.top_products?.length"><td colspan="4" class="muted">Sin datos.</td></tr>
                    <tr v-for="product in report?.top_products || []" :key="product.sku">
                      <td>{{ product.sku }}</td><td>{{ product.name }}</td><td>{{ product.quantity }}</td><td>{{ formatMoney(product.total) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </section>

          <section class="panel">
            <div class="panel-header"><h3>Ventas</h3></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Tirilla</th><th>Cajero</th><th>Cliente</th><th>Fecha</th><th>Total</th></tr></thead>
                <tbody>
                  <tr v-if="!sales.length"><td colspan="5" class="muted">Sin ventas para la fecha.</td></tr>
                  <tr v-for="sale in sales" :key="sale.id">
                    <td>{{ sale.receipt_number }}</td>
                    <td>{{ sale.cashier_name }}</td>
                    <td>{{ sale.customer_name || "-" }}</td>
                    <td>{{ new Date(sale.created_at).toLocaleString() }}</td>
                    <td>{{ formatMoney(sale.total) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="activeView === 'shifts'">
          <section class="grid two">
            <section class="panel">
              <div class="panel-header"><h3>Turno actual</h3></div>
              <div class="panel-body">
                <form v-if="currentShift" class="grid" @submit.prevent="closeCurrentShift">
                  <p><span class="status-pill">Abierto</span> <span class="muted">por {{ currentShift.opened_by_name }}</span></p>
                  <div class="closure-summary">
                    <div class="total-line"><span>Base inicial</span><span>{{ formatMoney(currentShift.opening_cash) }}</span></div>
                    <div class="total-line"><span>Total vendido</span><span>{{ formatMoney(currentShift.total_sales || 0) }}</span></div>
                    <div class="total-line"><span>Cantidad de ventas</span><span>{{ currentShift.sales_count || 0 }}</span></div>
                    <div class="payment-breakdown">
                      <div v-if="!currentShift.payments?.length" class="muted">Sin pagos registrados.</div>
                      <div v-for="payment in currentShift.payments || []" :key="payment.code">
                        <span>{{ payment.name }}</span>
                        <span>{{ formatMoney(payment.total) }}</span>
                      </div>
                    </div>
                    <div class="total-line"><span>Efectivo esperado</span><span>{{ formatMoney(currentShift.expected_cash) }}</span></div>
                  </div>
                  <label>Efectivo contado
                    <input v-model.number="closeShift.counted_cash" type="number" min="0" step="100" required>
                  </label>
                  <div class="total-line"><span>Diferencia de caja</span><span>{{ formatMoney(cashDifferencePreview) }}</span></div>
                  <label>Notas
                    <textarea v-model.trim="closeShift.notes" rows="3"></textarea>
                  </label>
                  <button class="danger" type="submit">Cerrar turno</button>
                </form>
                <form v-else class="toolbar" @submit.prevent="openShiftFromPos">
                  <label>Base de caja
                    <input v-model.number="openingCash" type="number" min="0" step="100" required>
                  </label>
                  <button class="primary" type="submit">Abrir</button>
                </form>
              </div>
            </section>

            <section class="panel">
              <div class="panel-header"><h3>Resumen</h3></div>
              <div class="panel-body">
                <template v-if="currentShift">
                  <p class="muted">Turno #{{ currentShift.id }}</p>
                  <div class="total-line"><span>Base inicial</span><span>{{ formatMoney(currentShift.opening_cash) }}</span></div>
                  <div class="total-line"><span>Total vendido</span><span>{{ formatMoney(currentShift.total_sales || 0) }}</span></div>
                  <div class="total-line"><span>Cantidad de ventas</span><span>{{ currentShift.sales_count || 0 }}</span></div>
                  <div class="summary-lines">
                    <div v-for="payment in currentShift.payments || []" :key="payment.code">
                      <span>{{ payment.name }}</span><span>{{ formatMoney(payment.total) }}</span>
                    </div>
                  </div>
                  <div class="total-line"><span>Efectivo esperado</span><span>{{ formatMoney(currentShift.expected_cash) }}</span></div>
                </template>
                <p v-else class="muted">No hay turno abierto.</p>
              </div>
            </section>
          </section>

          <section v-if="canSeeSupervisorViews" class="panel">
            <div class="panel-header">
              <h3>Turnos</h3>
              <form class="actions" @submit.prevent="guarded(loadShifts)">
                <input v-model="shiftDate" type="date">
                <button class="ghost" type="submit">Consultar</button>
              </form>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>#</th><th>Cajero</th><th>Estado</th><th>Base</th><th>Total vendido</th><th>Ventas</th><th>Esperado</th><th>Contado</th><th>Diferencia</th></tr></thead>
                <tbody>
                  <tr v-if="!shifts.length"><td colspan="9" class="muted">Sin turnos.</td></tr>
                  <tr v-for="shift in shifts" :key="shift.id">
                    <td>{{ shift.id }}</td>
                    <td>{{ shift.opened_by_name }}</td>
                    <td><span class="status-pill" :class="{ warn: shift.status !== 'CLOSED' }">{{ shift.status }}</span></td>
                    <td>{{ formatMoney(shift.opening_cash) }}</td>
                    <td>{{ formatMoney(shift.total_sales || 0) }}</td>
                    <td>{{ shift.sales_count || 0 }}</td>
                    <td>{{ formatMoney(shift.expected_cash) }}</td>
                    <td>{{ shift.counted_cash == null ? "-" : formatMoney(shift.counted_cash) }}</td>
                    <td>{{ shift.difference == null ? "-" : formatMoney(shift.difference) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="activeView === 'users'">
          <section class="panel">
            <div class="panel-header"><h3>Crear usuario</h3></div>
            <div class="panel-body">
              <form class="form-grid" @submit.prevent="createUser">
                <label>Usuario<input v-model.trim="newUser.username" required></label>
                <label>Nombre<input v-model.trim="newUser.full_name" required></label>
                <label>Rol
                  <select v-model="newUser.role">
                    <option v-for="role in roles" :key="role" :value="role">{{ role }}</option>
                  </select>
                </label>
                <label>Contrasena<input v-model="newUser.password" type="password" required></label>
                <div class="span-4 actions"><button class="primary" type="submit">Crear usuario</button></div>
              </form>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header"><h3>Usuarios</h3></div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th><th>Nueva contrasena</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="item in users" :key="item.id">
                    <td>{{ item.username }}</td>
                    <td><input v-model.trim="userDrafts[item.id].full_name"></td>
                    <td>
                      <select v-model="userDrafts[item.id].role">
                        <option v-for="role in roles" :key="role" :value="role">{{ role }}</option>
                      </select>
                    </td>
                    <td>
                      <select v-model="userDrafts[item.id].is_active">
                        <option value="1">Activo</option>
                        <option value="0">Inactivo</option>
                      </select>
                    </td>
                    <td><input v-model="userDrafts[item.id].password" type="password" placeholder="Sin cambio"></td>
                    <td><button class="ghost mini" type="button" @click="updateUser(item.id)">Guardar</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>
      </section>
    </main>
  </section>

  <div v-if="toast.show" class="toast" :class="{ error: toast.type === 'error' }">{{ toast.message }}</div>

  <dialog class="receipt-dialog" :open="Boolean(receipt)">
    <div v-if="receipt" id="receiptPrint" class="receipt">
      <h3>VIP SPORT</h3>
      <div class="row"><span>Tirilla</span><span>{{ receipt.receipt_number }}</span></div>
      <div class="row"><span>Fecha</span><span>{{ new Date(receipt.created_at).toLocaleString() }}</span></div>
      <div class="row"><span>Cajero</span><span>{{ receipt.cashier_name }}</span></div>
      <div v-if="receipt.customer_name" class="row"><span>Cliente</span><span>{{ receipt.customer_name }}</span></div>
      <div class="line"></div>
      <div v-for="item in receipt.items" :key="`${item.product_id}-${item.sku}`">
        <strong>{{ item.name }}</strong>
        <div class="row"><span>{{ item.quantity }} x {{ formatMoney(item.unit_price) }}</span><span>{{ formatMoney(item.total) }}</span></div>
        <small>{{ item.sku }} {{ item.size || "" }} {{ item.color || "" }}</small>
      </div>
      <div class="line"></div>
      <div class="row"><span>Subtotal</span><span>{{ formatMoney(receipt.subtotal) }}</span></div>
      <div v-if="receipt.discount_total > 0" class="row"><span>Descuento</span><span>-{{ formatMoney(receipt.discount_total) }}</span></div>
      <div v-if="receipt.tax_total > 0" class="row"><span>Impuestos</span><span>{{ formatMoney(receipt.tax_total) }}</span></div>
      <div class="row"><strong>Total</strong><strong>{{ formatMoney(receipt.total) }}</strong></div>
      <div class="line"></div>
      <div v-for="(payment, index) in receipt.payments" :key="`${payment.code}-${index}`" class="row">
        <span>{{ payment.name }} {{ payment.reference ? `(${payment.reference})` : "" }}</span><span>{{ formatMoney(payment.amount) }}</span>
      </div>
      <div class="line"></div>
      <p class="center">Gracias por su compra</p>
    </div>
    <div class="dialog-actions">
      <button class="primary" type="button" @click="printReceipt">Imprimir</button>
      <button class="ghost" type="button" @click="receipt = null">Cerrar</button>
    </div>
  </dialog>
</template>
