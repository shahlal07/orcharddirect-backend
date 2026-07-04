/**
 * OrchardDirect backend — Express server + Admin Dashboard API.
 *
 * Still a starting point, not a finished production backend. See the
 * original README's "Before you launch" list — none of those items are
 * fixed here; this update only adds the admin dashboard layer on top.
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ---- Simple JSON-file "database" (swap for Postgres/etc before real launch) ----
const PRODUCTS_PATH = path.join(__dirname, "products.json");
const SETTINGS_PATH = path.join(__dirname, "settings.json");
const DISCOUNTS_PATH = path.join(__dirname, "discounts.json");

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

let products = readJSON(PRODUCTS_PATH, []);
let settings = readJSON(SETTINGS_PATH, { phone: "", whatsapp: "", address: "", instagram: "", facebook: "" });
let discounts = readJSON(DISCOUNTS_PATH, []);

// ---- In-memory order store (swap for a real DB before launch) ----
const orders = new Map();

// ---- Env vars you will set in production ----
const SAFEPAY_SECRET = process.env.SAFEPAY_SECRET_KEY || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme"; // ALWAYS override this in production env vars

// ================= ADMIN AUTH =================
// Simple token-based auth: password in, random token out, token expires after 12h.
// This is fine for a single store-owner admin. Do not extend this pattern to
// multi-user auth without adding hashed passwords + a real session store.
const activeTokens = new Map(); // token -> expiry timestamp

function issueToken() {
  const token = crypto.randomBytes(24).toString("hex");
  activeTokens.set(token, Date.now() + 12 * 60 * 60 * 1000); // 12 hour session
  return token;
}

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const expiry = activeTokens.get(token);
  if (!expiry || expiry < Date.now()) {
    activeTokens.delete(token);
    return res.status(401).json({ error: "Not authenticated. Please log in again." });
  }
  next();
}

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Wrong password." });
  }
  res.json({ token: issueToken() });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  activeTokens.delete(token);
  res.json({ ok: true });
});

// Fetch everything the dashboard needs in one call
app.get("/api/admin/data", requireAdmin, (req, res) => {
  res.json({ products, settings, discounts });
});

app.put("/api/admin/products", requireAdmin, (req, res) => {
  if (!Array.isArray(req.body.products)) {
    return res.status(400).json({ error: "products must be an array." });
  }
  products = req.body.products;
  writeJSON(PRODUCTS_PATH, products);
  res.json({ ok: true });
});

app.put("/api/admin/settings", requireAdmin, (req, res) => {
  settings = req.body.settings || settings;
  writeJSON(SETTINGS_PATH, settings);
  res.json({ ok: true });
});

app.put("/api/admin/discounts", requireAdmin, (req, res) => {
  if (!Array.isArray(req.body.discounts)) {
    return res.status(400).json({ error: "discounts must be an array." });
  }
  discounts = req.body.discounts;
  writeJSON(DISCOUNTS_PATH, discounts);
  res.json({ ok: true });
});

// ================= PUBLIC STOREFRONT ROUTES =================
app.get("/api/products", (req, res) => {
  res.json(products);
});

app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.get("/api/discounts/:code", (req, res) => {
  const code = req.params.code.toLowerCase();
  const match = discounts.find(
    (d) => d.code.toLowerCase() === code && (!d.expiry || new Date(d.expiry) > new Date())
  );
  if (!match) return res.status(404).json({ error: "Invalid or expired code." });
  res.json(match);
});

// ================= ORDER CREATION =================
app.post("/api/checkout/init", async (req, res) => {
  const { customer, delivery, payment, items, discountCode } = req.body;

  if (!customer?.name || !customer?.phone || !delivery?.address || !items?.length) {
    return res.status(400).json({ error: "Missing required order fields." });
  }

  // Recompute everything server-side from the products file — never trust
  // prices, stock, or totals sent by the client, since those can be edited
  // in the browser before the request is sent.
  const verifiedItems = [];
  for (const claimedItem of items) {
    const product = products.find((p) => p.id === claimedItem.id);
    const variant = product?.variants.find((v) => v.label === claimedItem.variant);
    if (!product || !variant) {
      return res.status(400).json({ error: `Unknown product/variant: ${claimedItem.id} ${claimedItem.variant}` });
    }
    if (variant.stock !== undefined && claimedItem.qty > variant.stock) {
      return res.status(409).json({ error: `Only ${variant.stock} of ${product.name} (${variant.label}) left in stock.` });
    }
    verifiedItems.push({
      id: product.id,
      name: product.name,
      variant: variant.label,
      qty: claimedItem.qty,
      lineTotal: variant.price * claimedItem.qty, // real price, not the client's number
    });
  }

  let subtotal = verifiedItems.reduce((s, i) => s + i.lineTotal, 0);
  const deliveryFee = subtotal >= 3000 ? 0 : 200;

  let discountApplied = null;
  if (discountCode) {
    const match = discounts.find(
      (d) => d.code.toLowerCase() === discountCode.toLowerCase() && (!d.expiry || new Date(d.expiry) > new Date())
    );
    if (match) {
      discountApplied = match;
      subtotal = subtotal - Math.round(subtotal * match.percentOff / 100);
    }
  }

  const total = subtotal + deliveryFee;
  const orderId = "OD-" + Math.floor(10000 + Math.random() * 89999);

  const order = {
    orderId,
    customer,
    delivery,
    payment: payment.method,
    items: verifiedItems,
    discountApplied,
    subtotal,
    deliveryFee,
    total,
    status: payment.method === "cod" ? "confirmed-cod" : "pending-payment",
    createdAt: new Date().toISOString(),
  };
  orders.set(orderId, order);

  // Deduct stock now that the order is placed
  for (const item of verifiedItems) {
    const product = products.find((p) => p.id === item.id);
    const variant = product?.variants.find((v) => v.label === item.variant);
    if (variant?.stock !== undefined) variant.stock -= item.qty;
  }
  writeJSON(PRODUCTS_PATH, products);

  if (payment.method === "cod") {
    return res.json({ orderId, status: order.status });
  }

  try {
    let redirectUrl;
    if (payment.method === "card") {
      redirectUrl = await createSafepaySession(order);
    } else if (payment.method === "jazzcash") {
      redirectUrl = await createJazzCashSession(order);
    } else if (payment.method === "easypaisa") {
      redirectUrl = await createEasypaisaSession(order);
    } else {
      return res.status(400).json({ error: "Unsupported payment method." });
    }
    res.json({ orderId, redirectUrl });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not reach payment gateway." });
  }
});

async function createSafepaySession(order) {
  return `https://sandbox.getsafepay.com/checkout/pay/DEMO-${order.orderId}`;
}
async function createJazzCashSession(order) {
  return `https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform?order=${order.orderId}`;
}
async function createEasypaisaSession(order) {
  return `https://easypaystg.easypaisa.com.pk/easypay/Index.jsf?orderId=${order.orderId}`;
}

// ================= PAYMENT WEBHOOKS =================
app.post("/api/webhooks/safepay", (req, res) => {
  if (!verifySafepaySignature(req)) return res.status(401).end();
  const { order_id, status } = req.body;
  markOrderPaid(order_id, status);
  res.sendStatus(200);
});

app.post("/api/webhooks/jazzcash", (req, res) => {
  if (!verifyJazzCashSignature(req)) return res.status(401).end();
  const { pp_TxnRefNo, pp_ResponseCode } = req.body;
  markOrderPaid(pp_TxnRefNo, pp_ResponseCode === "000" ? "paid" : "failed");
  res.sendStatus(200);
});

function verifySafepaySignature(req) {
  return true; // placeholder — implement per Safepay docs before launch
}
function verifyJazzCashSignature(req) {
  return true; // placeholder — implement per JazzCash docs before launch
}

function markOrderPaid(orderId, status) {
  const order = orders.get(orderId);
  if (!order) return;
  order.status = status === "paid" ? "paid" : "payment-failed";
}

// ================= ORDER TRACKING =================
app.get("/api/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json(order);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`OrchardDirect API running on port ${PORT}`));
