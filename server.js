const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

// CORS: restrict to same origin in production
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || false,
    credentials: true
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ── In-memory session store ───────────────────────────────────────────────────
const sessions = new Map(); // token → { expires: timestamp }
const SESSION_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

function createServerSession() {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { expires: Date.now() + SESSION_DURATION_MS });
    return token;
}

function isValidSession(token) {
    if (!token) return false;
    const s = sessions.get(token);
    if (!s) return false;
    if (Date.now() > s.expires) { sessions.delete(token); return false; }
    return true;
}

function destroySession(token) {
    sessions.delete(token);
}

// Purge expired sessions every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, s] of sessions) {
        if (now > s.expires) sessions.delete(token);
    }
}, 30 * 60 * 1000);

// ── Brute-force protection ────────────────────────────────────────────────────
const loginAttempts = new Map(); // ip → { count, lockedUntil }
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes server-side

function checkBruteForce(ip) {
    const a = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    if (Date.now() < a.lockedUntil) return { locked: true, remaining: Math.ceil((a.lockedUntil - Date.now()) / 1000) };
    return { locked: false, count: a.count };
}

function recordFailedAttempt(ip) {
    const a = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    a.count = (a.count || 0) + 1;
    if (a.count >= MAX_ATTEMPTS) { a.lockedUntil = Date.now() + LOCKOUT_MS; a.count = 0; }
    loginAttempts.set(ip, a);
}

function clearAttempts(ip) { loginAttempts.delete(ip); }

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
    const token = req.headers["x-admin-token"] || req.query._token;
    if (isValidSession(token)) return next();
    return res.status(401).json({ success: false, error: "Unauthorized" });
}

const sseClients = new Set();
const sseOrderClients = new Map();
const sseAdminClients = new Set();
const sseResellerOrderClients = new Map();

function broadcastResellerOrders(email) {
    const clients = sseResellerOrderClients.get(email);
    if (!clients || clients.size === 0) return;
    try {
        const rows = db.prepare("SELECT * FROM orders WHERE resellerEmail = ? ORDER BY createdAt DESC").all(email);
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        const payload = JSON.stringify({ type: "reseller_orders", orders });
        for (const res of clients) {
            try { res.write(`data: ${payload}\n\n`); } catch (e) { clients.delete(res); }
        }
    } catch (e) {}
}

function broadcastAdminOrders() {
    if (sseAdminClients.size === 0) return;
    try {
        const resellerRows = db.prepare("SELECT * FROM orders ORDER BY createdAt DESC").all();
        const resellerOrders = resellerRows.map(r => ({ ...r, items: JSON.parse(r.items) }));

        const buyerRows = db.prepare("SELECT * FROM buyer_orders ORDER BY createdAt DESC").all();
        const buyerOrders = buyerRows.map(r => ({ ...r, items: JSON.parse(r.items) }));

        const payload = JSON.stringify({ type: "admin_orders", resellerOrders, buyerOrders });
        for (const res of sseAdminClients) {
            try { res.write(`data: ${payload}\n\n`); } catch (e) { sseAdminClients.delete(res); }
        }
    } catch (e) {}
}

function broadcastOrdersToContact(contact) {
    const clients = sseOrderClients.get(contact);
    if (!clients || clients.size === 0) return;
    try {
        const rows = db.prepare("SELECT * FROM buyer_orders WHERE contact = ? ORDER BY createdAt DESC").all(contact);
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        const payload = JSON.stringify({ type: "orders", orders });
        for (const res of clients) {
            try { res.write(`data: ${payload}\n\n`); } catch (e) { clients.delete(res); }
        }
    } catch (e) {}
}

function broadcastProducts() {
    if (sseClients.size === 0) return;
    try {
        const rows = db.prepare("SELECT data FROM products").all();
        const products = rows.map(r => JSON.parse(r.data));
        const payload = JSON.stringify({ type: "products", products });
        for (const res of sseClients) {
            try { res.write(`data: ${payload}\n\n`); } catch (e) { sseClients.delete(res); }
        }
    } catch (e) {}
}

const DATA_DIR = "/data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const uploadsDir = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

app.post("/admin/upload-image", requireAdmin, (req, res) => {
    const { base64, mimeType } = req.body;
    if (!base64 || !mimeType) return res.json({ success: false, error: "No image data" });

    try {
        const ext = (mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg");
        const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const filepath = path.join(uploadsDir, filename);
        fs.writeFileSync(filepath, Buffer.from(base64, "base64"));
        res.json({ success: true, url: `/uploads/${filename}` });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.use(express.static(path.join(__dirname)));

const db = new Database(path.join(DATA_DIR, "users.db"));

db.exec(`
    CREATE TABLE IF NOT EXISTS resellers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        shopName TEXT,
        experience TEXT,
        social TEXT,
        approved INTEGER DEFAULT 0
    )
`);

["shopName", "experience", "social"].forEach(col => {
    try { db.exec(`ALTER TABLE resellers ADD COLUMN ${col} TEXT`); } catch (e) {}
});

db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        data TEXT
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )
`);

const defaultSocials = {
    facebook:  "https://www.facebook.com/profile.php?id=61565876271368",
    instagram: "https://www.instagram.com/spykicksph/?utm_source=qr",
    twitter:   "",
    tiktok:    "",
    shopee:    "",
    lazada:    ""
};
Object.entries(defaultSocials).forEach(([k, v]) => {
    const existing = db.prepare("SELECT value FROM settings WHERE key = ?").get("social_" + k);
    if (!existing) db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("social_" + k, v);
});

// Login — rate-limited, server-side verification
app.post("/admin/login", (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const bf = checkBruteForce(ip);
    if (bf.locked) return res.status(429).json({ success: false, error: `Too many attempts. Try again in ${bf.remaining}s.` });

    const { hash } = req.body;
    if (!hash || typeof hash !== "string") return res.status(400).json({ success: false, error: "Missing credentials" });

    const DEFAULT_HASH = "c1d381d6c4c20d3a2583c26a52ec289b83b124f2aae15e4c01a7d65d6b253c92";
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_pw_hash'").get();
        const storedHash = row ? row.value : DEFAULT_HASH;

        // Constant-time comparison to prevent timing attacks
        const a = Buffer.from(hash.padEnd(64, "0").slice(0, 64));
        const b = Buffer.from(storedHash.padEnd(64, "0").slice(0, 64));
        const match = a.length === b.length && crypto.timingSafeEqual(a, b) && hash === storedHash;

        if (match) {
            clearAttempts(ip);
            const token = createServerSession();
            return res.json({ success: true, token });
        } else {
            recordFailedAttempt(ip);
            return res.status(401).json({ success: false, error: "Incorrect password" });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: "Server error" });
    }
});

// Logout — invalidate token
app.post("/admin/logout", (req, res) => {
    const token = req.headers["x-admin-token"];
    if (token) destroySession(token);
    res.json({ success: true });
});

// Session check — for the frontend to verify token is still valid
app.get("/admin/session", (req, res) => {
    const token = req.headers["x-admin-token"];
    res.json({ valid: isValidSession(token) });
});

app.post("/admin/change-password", requireAdmin, (req, res) => {
    const { currentHash, newHash } = req.body;
    if (!currentHash || !newHash) return res.json({ success: false, error: "Missing fields" });

    const DEFAULT_HASH = "c1d381d6c4c20d3a2583c26a52ec289b83b124f2aae15e4c01a7d65d6b253c92";

    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_pw_hash'").get();
        const storedHash = row ? row.value : DEFAULT_HASH;

        if (currentHash !== storedHash) {
            return res.json({ success: false, error: "Current password is incorrect." });
        }

        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_pw_hash', ?)").run(newHash);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/admin/social-links", requireAdmin, (req, res) => {
    try {
        const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'social_%'").all();
        const links = {};
        rows.forEach(r => { links[r.key.replace("social_", "")] = r.value; });
        res.json({ links });
    } catch (err) {
        res.json({ links: {} });
    }
});

app.post("/admin/social-links", requireAdmin, (req, res) => {
    const { links } = req.body;
    if (!links || typeof links !== "object") return res.json({ success: false });
    try {
        const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
        const save = db.transaction((obj) => {
            for (const [k, v] of Object.entries(obj)) stmt.run("social_" + k, v || "");
        });
        save(links);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/admin/brand-taxonomy", requireAdmin, (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'brand_taxonomy'").get();
        res.json({ taxonomy: row ? JSON.parse(row.value) : [] });
    } catch (err) {
        res.json({ taxonomy: [] });
    }
});

app.post("/admin/brand-taxonomy", requireAdmin, (req, res) => {
    const { taxonomy } = req.body;
    if (!Array.isArray(taxonomy)) return res.json({ success: false });
    try {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("brand_taxonomy", JSON.stringify(taxonomy));
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/brand-taxonomy", (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'brand_taxonomy'").get();
        res.json({ taxonomy: row ? JSON.parse(row.value) : [] });
    } catch (err) {
        res.json({ taxonomy: [] });
    }
});

// ── New Arrivals (featured list chosen by admin) ─────────────────────────────
app.get("/new-arrivals", (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'new_arrivals_ids'").get();
        const ids = row ? JSON.parse(row.value) : [];
        if (ids.length === 0) return res.json({ products: [] });
        const allRows = db.prepare("SELECT data FROM products").all();
        const allProducts = allRows.map(r => JSON.parse(r.data));
        const products = ids
            .map(id => allProducts.find(p => String(p.id) === String(id)))
            .filter(p => p && (!p.status || p.status === "active") && (p.publishTo === "buyer" || p.publishTo === "both" || !p.publishTo));
        res.json({ products });
    } catch (err) {
        res.json({ products: [] });
    }
});

app.get("/admin/new-arrivals", requireAdmin, (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'new_arrivals_ids'").get();
        res.json({ ids: row ? JSON.parse(row.value) : [] });
    } catch (err) {
        res.json({ ids: [] });
    }
});

app.post("/admin/new-arrivals", requireAdmin, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.json({ success: false, error: "ids must be an array" });
    try {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('new_arrivals_ids', ?)").run(JSON.stringify(ids));
        broadcastProducts();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/social-links", (req, res) => {
    try {
        const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'social_%'").all();
        const links = {};
        rows.forEach(r => { links[r.key.replace("social_", "")] = r.value; });
        res.json({ links });
    } catch (err) {
        res.json({ links: {} });
    }
});


app.get("/products", (req, res) => {
    try {
        const rows = db.prepare("SELECT data FROM products").all();
        const products = rows
            .map(r => JSON.parse(r.data))
            .filter(p => {
                const active = !p.status || p.status === "active";
                const pt = p.publishTo || "both"; 
                return active && (pt === "buyer" || pt === "both");
            });
        res.json({ products });
    } catch (err) {
        res.json({ products: [] });
    }
});

app.post("/admin/delete-product", requireAdmin, (req, res) => {
    const { id } = req.body;
    try {
        const row = db.prepare("SELECT data FROM products WHERE id = ?").get(id);
        if (row) {
            try {
                const p = JSON.parse(row.data);
                (p.images || []).forEach(url => {
                    if (url && url.startsWith("/uploads/")) {
                        const fp = path.join(__dirname, url);
                        if (fs.existsSync(fp)) fs.unlinkSync(fp);
                    }
                });
            } catch (e) {}
        }
        db.prepare("DELETE FROM products WHERE id = ?").run(id);
        broadcastProducts(); broadcastAdminOrders();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

app.post("/apply-reseller", (req, res) => {
    const { email, shopName, experience, social } = req.body;
    if (!email || !shopName || !experience || !social)
        return res.json({ success: false, error: "Missing fields" });
    try {
        db.prepare(
            "INSERT OR IGNORE INTO resellers (email, shopName, experience, social, approved) VALUES (?, ?, ?, ?, 0)"
        ).run(email, shopName, experience, social);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/approve-reseller", requireAdmin, (req, res) => {
    const { email } = req.body;
    try {
        db.prepare("UPDATE resellers SET approved = 1 WHERE email = ?").run(email);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

app.post("/admin/reject-reseller", requireAdmin, (req, res) => {
    const { email } = req.body;
    try {
        db.prepare("DELETE FROM resellers WHERE email = ?").run(email);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

app.post("/check-user", (req, res) => {
    const { email } = req.body;
    try {
        const row = db.prepare("SELECT * FROM resellers WHERE email = ? AND approved = 1").get(email);
        res.json({ verified: !!row });
    } catch (err) {
        res.json({ verified: false });
    }
});

app.get("/reseller-products", (req, res) => {
    const { email } = req.query;
    try {
        const row = db.prepare("SELECT * FROM resellers WHERE email = ? AND approved = 1").get(email);
        if (!row) return res.json({ authorized: false });
        const rows = db.prepare("SELECT data FROM products").all();
        const products = rows
            .map(r => JSON.parse(r.data))
            .filter(p => {
                const active = !p.status || p.status === "active";
                const pt = p.publishTo || "both";
                return active && (pt === "reseller" || pt === "both");
            });
        res.json({ authorized: true, products });
    } catch (err) {
        res.json({ authorized: false });
    }
});

// Alias for clean URL
app.get("/reseller", (req, res, next) => {
    if (req.query.email) return next(); // let /reseller-products handler serve data
    res.sendFile(path.join(__dirname, "reseller-products.html"));
});

app.get("/admin/resellers", requireAdmin, (req, res) => {
    try {
        const rows = db.prepare("SELECT email, shopName, experience, social, approved FROM resellers ORDER BY id DESC").all();
        res.json({ resellers: rows || [] });
    } catch (err) {
        res.json({ resellers: [] });
    }
});

app.get("/admin/reseller-count", requireAdmin, (req, res) => {
    try {
        const row = db.prepare("SELECT COUNT(*) as count FROM resellers WHERE approved = 1").get();
        res.json({ count: row ? row.count : 0 });
    } catch (err) {
        res.json({ count: 0 });
    }
});

app.post("/admin/save-products", requireAdmin, (req, res) => {
    const { products } = req.body;
    if (!Array.isArray(products)) return res.json({ success: false });
    try {
        const stmt = db.prepare("INSERT OR REPLACE INTO products (id, data) VALUES (?, ?)");
        const insertMany = db.transaction((prods) => {
            for (const p of prods) stmt.run(p.id, JSON.stringify(p));
        });
        insertMany(products);
        broadcastProducts(); broadcastAdminOrders();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/save-product", requireAdmin, (req, res) => {
    const { product } = req.body;
    if (!product || !product.id) return res.json({ success: false, error: "Missing product or id" });
    try {
        db.prepare("INSERT OR REPLACE INTO products (id, data) VALUES (?, ?)").run(product.id, JSON.stringify(product));
        broadcastProducts(); broadcastAdminOrders();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/update-stock", requireAdmin, (req, res) => {
    const { productId, sizes, supplier, wholesalePrice } = req.body;
    if (!productId || !Array.isArray(sizes))
        return res.json({ success: false, error: "Missing productId or sizes" });
    try {
        const row = db.prepare("SELECT data FROM products WHERE id = ?").get(productId);
        if (!row) return res.json({ success: false, error: "Product not found" });
        const product = JSON.parse(row.data);
        if (!product.invStock) product.invStock = {};
        sizes.forEach(({ size, stock }) => {
            product.invStock[size] = Math.max(0, Number(stock) || 0);
        });
        if (typeof supplier === 'string') product.supplier = supplier.trim();
        if (wholesalePrice !== undefined && wholesalePrice !== null) {
            product.wholesalePrice = Math.max(0, Number(wholesalePrice) || 0);
        }
        db.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), productId);
        broadcastProducts(); broadcastAdminOrders();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/admin/product/:id", requireAdmin, (req, res) => {
    try {
        const row = db.prepare("SELECT data FROM products WHERE id = ?").get(req.params.id);
        if (!row) return res.json({ product: null });
        res.json({ product: JSON.parse(row.data) });
    } catch (err) {
        res.json({ product: null });
    }
});

app.get("/admin/products", requireAdmin, (req, res) => {
    try {
        const rows = db.prepare("SELECT data FROM products").all();
        const products = rows.map(r => JSON.parse(r.data));
        res.json({ products });
    } catch (err) {
        res.json({ products: [] });
    }
});

app.post("/admin/add-reseller", requireAdmin, (req, res) => {
    const { email } = req.body;
    if (!email) return res.json({ success: false, error: "Email required" });
    try {
        db.prepare(
            "INSERT OR IGNORE INTO resellers (email, shopName, experience, social, approved) VALUES (?, ?, ?, ?, 1)"
        ).run(email, "", "", "");
        db.prepare("UPDATE resellers SET approved = 1 WHERE email = ?").run(email);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        resellerEmail TEXT,
        items TEXT,
        totalAmount REAL,
        status TEXT DEFAULT 'pending',
        note TEXT,
        createdAt TEXT,
        updatedAt TEXT
    )
`);

app.post("/reseller/place-order", (req, res) => {
    const { email, items, totalAmount, note } = req.body;
    if (!email || !items || !Array.isArray(items) || items.length === 0)
        return res.json({ success: false, error: "Missing fields" });

    const row = db.prepare("SELECT * FROM resellers WHERE email = ? AND approved = 1").get(email);
    if (!row) return res.json({ success: false, error: "Not an approved reseller" });

    try {
        const orderId = "ORD_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7).toUpperCase();
        const now = new Date().toISOString();
        db.prepare(
            "INSERT INTO orders (id, resellerEmail, items, totalAmount, status, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)"
        ).run(orderId, email, JSON.stringify(items), totalAmount || 0, note || "", now, now);
        broadcastAdminOrders();
        res.json({ success: true, orderId });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/reseller/orders", (req, res) => {
    const { email } = req.query;
    if (!email) return res.json({ orders: [] });
    try {
        const rows = db.prepare("SELECT * FROM orders WHERE resellerEmail = ? ORDER BY createdAt DESC").all(email);
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        res.json({ orders });
    } catch (err) {
        res.json({ orders: [] });
    }
});

app.post("/reseller/cancel-order", (req, res) => {
    const { email, orderId } = req.body;
    if (!email || !orderId) return res.json({ success: false, error: "Missing fields" });

    try {
        const orderRow = db.prepare("SELECT * FROM orders WHERE id = ? AND resellerEmail = ?").get(orderId, email);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });

        const cancellable = ["pending", "approved", "processing"];
        if (!cancellable.includes(orderRow.status)) {
            return res.json({ success: false, error: "This order can no longer be cancelled" });
        }

        const items = JSON.parse(orderRow.items);
        const now = new Date().toISOString();

        const cancel = db.transaction(() => {
            if (orderRow.status === "approved" || orderRow.status === "processing") {
                for (const item of items) {
                    const prodRow = db.prepare("SELECT data FROM products WHERE id = ?").get(item.productId);
                    if (!prodRow) continue;
                    const product = JSON.parse(prodRow.data);
                    if (item.size && product.sizes && product.sizes.length > 0 && typeof product.sizes[0] === "object") {
                        const sizeObj = product.sizes.find(s => String(s.size) === String(item.size));
                        if (sizeObj) {
                            if (item.color && sizeObj.colorStock && typeof sizeObj.colorStock === "object") {
                                sizeObj.colorStock[item.color] = (Number(sizeObj.colorStock[item.color]) || 0) + (Number(item.qty) || 1);
                                sizeObj.stock = Object.values(sizeObj.colorStock).reduce((a, b) => a + (Number(b) || 0), 0);
                            } else if (sizeObj.stock != null) {
                                sizeObj.stock = (Number(sizeObj.stock) || 0) + (Number(item.qty) || 1);
                            }
                        }
                        product.stock = product.sizes.reduce((sum, s) => sum + (Number(s.stock) || 0), 0);
                    } else {
                        product.stock = (Number(product.stock) || 0) + (Number(item.qty) || 1);
                    }
                    db.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), item.productId);
                }
            }
            db.prepare("UPDATE orders SET status = 'cancelled', updatedAt = ? WHERE id = ?").run(now, orderId);
        });
        cancel();
        broadcastProducts(); broadcastAdminOrders();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/admin/orders", requireAdmin, (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM orders ORDER BY createdAt DESC").all();
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        res.json({ orders });
    } catch (err) {
        res.json({ orders: [] });
    }
});

app.post("/admin/approve-order", requireAdmin, (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });

    try {
        const orderRow = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });
        if (orderRow.status !== "pending") return res.json({ success: false, error: "Order is not pending" });

        const items = JSON.parse(orderRow.items);
        const now = new Date().toISOString();

        const approve = db.transaction(() => {
            for (const item of items) {
                const prodRow = db.prepare("SELECT data FROM products WHERE id = ?").get(item.productId);
                if (!prodRow) continue;
                const product = JSON.parse(prodRow.data);

                if (item.size && product.sizes && product.sizes.length > 0 && typeof product.sizes[0] === 'object') {
                    const sizeObj = product.sizes.find(s => String(s.size) === String(item.size));
                    if (sizeObj) {
                        if (item.color && sizeObj.colorStock && typeof sizeObj.colorStock === 'object') {
                            const prev = Number(sizeObj.colorStock[item.color]) || 0;
                            sizeObj.colorStock[item.color] = Math.max(0, prev - (Number(item.qty) || 1));
                            sizeObj.stock = Object.values(sizeObj.colorStock).reduce((a, b) => a + (Number(b) || 0), 0);
                        } else if (sizeObj.stock != null) {
                            sizeObj.stock = Math.max(0, (Number(sizeObj.stock) || 0) - (Number(item.qty) || 1));
                        }
                    }
                    product.stock = product.sizes.reduce((sum, s) => sum + (Number(s.stock) || 0), 0);
                } else {
                    product.stock = Math.max(0, (Number(product.stock) || 0) - (Number(item.qty) || 1));
                }

                db.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), item.productId);
            }
            db.prepare("UPDATE orders SET status = 'approved', updatedAt = ? WHERE id = ?").run(now, orderId);
        });

        approve();
        broadcastProducts(); broadcastAdminOrders();
        broadcastResellerOrders(orderRow.resellerEmail);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/reject-order", requireAdmin, (req, res) => {
    const { orderId, reason } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });
    try {
        const orderRow = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
        const now = new Date().toISOString();
        db.prepare("UPDATE orders SET status = 'rejected', note = ?, updatedAt = ? WHERE id = ?")
            .run(reason || "", now, orderId);
        broadcastAdminOrders();
        if (orderRow) broadcastResellerOrders(orderRow.resellerEmail);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/reseller-order-status", requireAdmin, (req, res) => {
    const { orderId, status } = req.body;
    if (!orderId || !status) return res.json({ success: false, error: "Missing fields" });
    const allowed = ['pending', 'approved', 'processing', 'shipped', 'delivered', 'rejected', 'cancelled'];
    if (!allowed.includes(status)) return res.json({ success: false, error: "Invalid status" });
    try {
        const orderRow = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });

        const items = JSON.parse(orderRow.items);
        const wasApproved = ['approved', 'processing', 'shipped', 'delivered'].includes(orderRow.status);
        const willApprove = ['approved', 'processing', 'shipped', 'delivered'].includes(status);
        const now = new Date().toISOString();

        const doUpdate = db.transaction(() => {
            if (willApprove && !wasApproved) {
                for (const item of items) {
                    const prodRow = db.prepare("SELECT data FROM products WHERE id = ?").get(item.productId);
                    if (!prodRow) continue;
                    const product = JSON.parse(prodRow.data);
                    if (item.size && product.sizes && product.sizes.length > 0 && typeof product.sizes[0] === 'object') {
                        const sizeObj = product.sizes.find(s => String(s.size) === String(item.size));
                        if (sizeObj) {
                            if (item.color && sizeObj.colorStock && typeof sizeObj.colorStock === 'object') {
                                const prev = Number(sizeObj.colorStock[item.color]) || 0;
                                sizeObj.colorStock[item.color] = Math.max(0, prev - (Number(item.qty) || 1));
                                sizeObj.stock = Object.values(sizeObj.colorStock).reduce((a, b) => a + (Number(b) || 0), 0);
                            } else if (sizeObj.stock != null) {
                                sizeObj.stock = Math.max(0, (Number(sizeObj.stock) || 0) - (Number(item.qty) || 1));
                            }
                        }
                        product.stock = product.sizes.reduce((sum, s) => sum + (Number(s.stock) || 0), 0);
                    } else {
                        product.stock = Math.max(0, (Number(product.stock) || 0) - (Number(item.qty) || 1));
                    }
                    db.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), item.productId);
                }
            }
            if (!willApprove && wasApproved) {
                for (const item of items) {
                    const prodRow = db.prepare("SELECT data FROM products WHERE id = ?").get(item.productId);
                    if (!prodRow) continue;
                    const product = JSON.parse(prodRow.data);
                    if (item.size && product.sizes && product.sizes.length > 0 && typeof product.sizes[0] === 'object') {
                        const sizeObj = product.sizes.find(s => String(s.size) === String(item.size));
                        if (sizeObj) {
                            if (item.color && sizeObj.colorStock && typeof sizeObj.colorStock === 'object') {
                                sizeObj.colorStock[item.color] = (Number(sizeObj.colorStock[item.color]) || 0) + (Number(item.qty) || 1);
                                sizeObj.stock = Object.values(sizeObj.colorStock).reduce((a, b) => a + (Number(b) || 0), 0);
                            } else if (sizeObj.stock != null) {
                                sizeObj.stock = (Number(sizeObj.stock) || 0) + (Number(item.qty) || 1);
                            }
                        }
                        product.stock = product.sizes.reduce((sum, s) => sum + (Number(s.stock) || 0), 0);
                    } else {
                        product.stock = (Number(product.stock) || 0) + (Number(item.qty) || 1);
                    }
                    db.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), item.productId);
                }
            }
            db.prepare("UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?").run(status, now, orderId);
        });
        doUpdate();
        broadcastProducts(); broadcastAdminOrders();
        broadcastResellerOrders(orderRow.resellerEmail);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/cancel-reseller-order", requireAdmin, (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });
    try {
        const orderRow = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });

        const items = JSON.parse(orderRow.items);
        const wasApproved = ['approved', 'processing', 'shipped', 'delivered'].includes(orderRow.status);
        const now = new Date().toISOString();

        const doCancel = db.transaction(() => {
            if (wasApproved) {
                for (const item of items) {
                    const prodRow = db.prepare("SELECT data FROM products WHERE id = ?").get(item.productId);
                    if (!prodRow) continue;
                    const product = JSON.parse(prodRow.data);
                    if (item.size && product.sizes && product.sizes.length > 0 && typeof product.sizes[0] === 'object') {
                        const sizeObj = product.sizes.find(s => String(s.size) === String(item.size));
                        if (sizeObj) {
                            if (item.color && sizeObj.colorStock && typeof sizeObj.colorStock === 'object') {
                                sizeObj.colorStock[item.color] = (Number(sizeObj.colorStock[item.color]) || 0) + (Number(item.qty) || 1);
                                sizeObj.stock = Object.values(sizeObj.colorStock).reduce((a, b) => a + (Number(b) || 0), 0);
                            } else if (sizeObj.stock != null) {
                                sizeObj.stock = (Number(sizeObj.stock) || 0) + (Number(item.qty) || 1);
                            }
                        }
                        product.stock = product.sizes.reduce((sum, s) => sum + (Number(s.stock) || 0), 0);
                    } else {
                        product.stock = (Number(product.stock) || 0) + (Number(item.qty) || 1);
                    }
                    db.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), item.productId);
                }
            }
            db.prepare("UPDATE orders SET status = 'cancelled', updatedAt = ? WHERE id = ?").run(now, orderId);
        });
        doCancel();
        broadcastProducts(); broadcastAdminOrders();
        broadcastResellerOrders(orderRow.resellerEmail);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/delete-order", requireAdmin, (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });
    try {
        const orderRow = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
        const result = db.prepare("DELETE FROM orders WHERE id = ?").run(orderId);
        if (result.changes === 0) return res.json({ success: false, error: "Order not found" });
        if (orderRow) broadcastResellerOrders(orderRow.resellerEmail);
        broadcastAdminOrders();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/admin/order-count", requireAdmin, (req, res) => {
    try {
        const row = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'").get();
        res.json({ count: row ? row.count : 0 });
    } catch (err) {
        res.json({ count: 0 });
    }
});

db.exec(`
    CREATE TABLE IF NOT EXISTS buyer_orders (
        id TEXT PRIMARY KEY,
        customerName TEXT,
        contact TEXT,
        province TEXT,
        municipality TEXT,
        barangay TEXT,
        fullAddress TEXT,
        items TEXT,
        totalAmount REAL,
        status TEXT DEFAULT 'pending',
        createdAt TEXT,
        updatedAt TEXT,
        stockDeducted INTEGER DEFAULT 0
    )
`);
try { db.exec("ALTER TABLE buyer_orders ADD COLUMN stockDeducted INTEGER DEFAULT 0"); } catch(e) {}

app.post("/buyer/place-order", (req, res) => {
    const { customer, items, totalAmount } = req.body;
    if (!customer || !items || !Array.isArray(items) || items.length === 0)
        return res.json({ success: false, error: "Missing fields" });
    if (!customer.name || !customer.contact || !customer.province || !customer.municipality || !customer.barangay || !customer.fullAddress)
        return res.json({ success: false, error: "Incomplete customer info" });

    try {
        const orderId = "BORDER_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7).toUpperCase();
        const now = new Date().toISOString();
        db.prepare(
            `INSERT INTO buyer_orders (id, customerName, contact, province, municipality, barangay, fullAddress, items, totalAmount, status, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).run(
            orderId,
            customer.name,
            customer.contact,
            customer.province,
            customer.municipality,
            customer.barangay,
            customer.fullAddress,
            JSON.stringify(items),
            totalAmount || 0,
            now, now
        );
        broadcastAdminOrders();
        res.json({ success: true, orderId });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/admin/buyer-orders", requireAdmin, (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM buyer_orders ORDER BY createdAt DESC").all();
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        res.json({ orders });
    } catch (err) {
        res.json({ orders: [] });
    }
});

function deductBuyerStock(items) {
    for (const item of items) {
        const prodRow = db.prepare("SELECT data FROM products WHERE id = ?").get(item.productId);
        if (!prodRow) continue;
        const product = JSON.parse(prodRow.data);

        if (item.size && product.sizes && product.sizes.length > 0 && typeof product.sizes[0] === 'object') {
            const sizeObj = product.sizes.find(s => String(s.size) === String(item.size));
            if (sizeObj) {
                if (item.color && sizeObj.colorStock && typeof sizeObj.colorStock === 'object') {
                    const prev = Number(sizeObj.colorStock[item.color]) || 0;
                    sizeObj.colorStock[item.color] = Math.max(0, prev - (Number(item.qty) || 1));
                    sizeObj.stock = Object.values(sizeObj.colorStock).reduce((a, b) => a + (Number(b) || 0), 0);
                } else if (sizeObj.stock != null) {
                    sizeObj.stock = Math.max(0, (Number(sizeObj.stock) || 0) - (Number(item.qty) || 1));
                }
            }
            product.stock = product.sizes.reduce((sum, s) => sum + (Number(s.stock) || 0), 0);
        } else {
            product.stock = Math.max(0, (Number(product.stock) || 0) - (Number(item.qty) || 1));
        }
        db.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), item.productId);
    }
}

function restoreBuyerStock(items) {
    for (const item of items) {
        const prodRow = db.prepare("SELECT data FROM products WHERE id = ?").get(item.productId);
        if (!prodRow) continue;
        const product = JSON.parse(prodRow.data);

        if (item.size && product.sizes && product.sizes.length > 0 && typeof product.sizes[0] === 'object') {
            const sizeObj = product.sizes.find(s => String(s.size) === String(item.size));
            if (sizeObj) {
                if (item.color && sizeObj.colorStock && typeof sizeObj.colorStock === 'object') {
                    const prev = Number(sizeObj.colorStock[item.color]) || 0;
                    sizeObj.colorStock[item.color] = prev + (Number(item.qty) || 1);
                    sizeObj.stock = Object.values(sizeObj.colorStock).reduce((a, b) => a + (Number(b) || 0), 0);
                } else if (sizeObj.stock != null) {
                    sizeObj.stock = (Number(sizeObj.stock) || 0) + (Number(item.qty) || 1);
                }
            }
            product.stock = product.sizes.reduce((sum, s) => sum + (Number(s.stock) || 0), 0);
        } else {
            product.stock = (Number(product.stock) || 0) + (Number(item.qty) || 1);
        }
        db.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), item.productId);
    }
}

app.post("/admin/buyer-order-status", requireAdmin, (req, res) => {
    const { orderId, status } = req.body;
    if (!orderId || !status) return res.json({ success: false, error: "Missing fields" });
    const allowed = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) return res.json({ success: false, error: "Invalid status" });
    try {
        const orderRow = db.prepare("SELECT * FROM buyer_orders WHERE id = ?").get(orderId);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });

        const items = JSON.parse(orderRow.items);
        const wasDeducted = orderRow.stockDeducted === 1;
        const shouldDeduct = ['processing', 'shipped', 'delivered'].includes(status);
        const now = new Date().toISOString();

        const doUpdate = db.transaction(() => {
            if (shouldDeduct && !wasDeducted) {
                deductBuyerStock(items);
                db.prepare("UPDATE buyer_orders SET status = ?, updatedAt = ?, stockDeducted = 1 WHERE id = ?").run(status, now, orderId);
            } else if (!shouldDeduct && wasDeducted) {
                restoreBuyerStock(items);
                db.prepare("UPDATE buyer_orders SET status = ?, updatedAt = ?, stockDeducted = 0 WHERE id = ?").run(status, now, orderId);
            } else {
                db.prepare("UPDATE buyer_orders SET status = ?, updatedAt = ? WHERE id = ?").run(status, now, orderId);
            }
        });
        doUpdate();
        broadcastProducts(); broadcastAdminOrders();
        broadcastOrdersToContact(orderRow.contact);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/approve-buyer-order", requireAdmin, (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });
    try {
        const orderRow = db.prepare("SELECT * FROM buyer_orders WHERE id = ?").get(orderId);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });
        if (orderRow.status !== "pending") return res.json({ success: false, error: "Order is not pending" });

        const items = JSON.parse(orderRow.items);
        const now = new Date().toISOString();

        const approve = db.transaction(() => {
            deductBuyerStock(items);
            db.prepare("UPDATE buyer_orders SET status = 'processing', updatedAt = ?, stockDeducted = 1 WHERE id = ?").run(now, orderId);
        });
        approve();
        broadcastProducts(); broadcastAdminOrders();
        broadcastOrdersToContact(orderRow.contact);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/reject-buyer-order", requireAdmin, (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });
    try {
        const orderRow = db.prepare("SELECT * FROM buyer_orders WHERE id = ?").get(orderId);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });

        const items = JSON.parse(orderRow.items);
        const now = new Date().toISOString();

        const reject = db.transaction(() => {
            if (orderRow.stockDeducted === 1) {
                restoreBuyerStock(items);
            }
            db.prepare("UPDATE buyer_orders SET status = 'cancelled', updatedAt = ?, stockDeducted = 0 WHERE id = ?").run(now, orderId);
        });
        reject();
        broadcastOrdersToContact(orderRow.contact);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/buyer/cancel-order", (req, res) => {
    const { orderId, contact } = req.body;
    if (!orderId || !contact) return res.json({ success: false, error: "Missing fields" });
    try {
        const orderRow = db.prepare("SELECT * FROM buyer_orders WHERE id = ? AND contact = ?").get(orderId, contact);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });
        if (!['pending', 'processing'].includes(orderRow.status)) return res.json({ success: false, error: "This order can no longer be cancelled" });
        const items = JSON.parse(orderRow.items);
        const now = new Date().toISOString();
        const cancel = db.transaction(() => {
            if (orderRow.stockDeducted === 1) restoreBuyerStock(items);
            db.prepare("UPDATE buyer_orders SET status = 'cancelled', updatedAt = ?, stockDeducted = 0 WHERE id = ?").run(now, orderId);
        });
        cancel();
        broadcastProducts(); broadcastAdminOrders();
        broadcastOrdersToContact(contact);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post("/admin/delete-buyer-order", requireAdmin, (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });
    try {
        const result = db.prepare("DELETE FROM buyer_orders WHERE id = ?").run(orderId);
        if (result.changes === 0) return res.json({ success: false, error: "Order not found" });
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/admin/buyer-order-count", requireAdmin, (req, res) => {
    try {
        const row = db.prepare("SELECT COUNT(*) as count FROM buyer_orders WHERE status = 'pending'").get();
        res.json({ count: row ? row.count : 0 });
    } catch (err) {
        res.json({ count: 0 });
    }
});

app.get("/buyer/orders", (req, res) => {
    const { contact } = req.query;
    if (!contact) return res.json({ orders: [] });
    try {
        const rows = db.prepare("SELECT * FROM buyer_orders WHERE contact = ? ORDER BY createdAt DESC").all(contact);
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        res.json({ orders });
    } catch (err) {
        res.json({ orders: [] });
    }
});

app.get("/events/products", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
        const rows = db.prepare("SELECT data FROM products").all();
        const products = rows.map(r => JSON.parse(r.data));
        res.write(`data: ${JSON.stringify({ type: "products", products })}\n\n`);
    } catch (e) {}

    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
});

app.get("/events/orders", (req, res) => {
    const contact = (req.query.contact || "").trim();
    if (!contact) return res.status(400).end();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
        const rows = db.prepare("SELECT * FROM buyer_orders WHERE contact = ? ORDER BY createdAt DESC").all(contact);
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        res.write(`data: ${JSON.stringify({ type: "orders", orders })}\n\n`);
    } catch (e) {}

    if (!sseOrderClients.has(contact)) sseOrderClients.set(contact, new Set());
    sseOrderClients.get(contact).add(res);

    req.on("close", () => {
        const clients = sseOrderClients.get(contact);
        if (clients) { clients.delete(res); if (clients.size === 0) sseOrderClients.delete(contact); }
    });
});

app.get("/events/reseller-orders", (req, res) => {
    const email = (req.query.email || "").trim();
    if (!email) return res.status(400).end();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
        const rows = db.prepare("SELECT * FROM orders WHERE resellerEmail = ? ORDER BY createdAt DESC").all(email);
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        res.write(`data: ${JSON.stringify({ type: "reseller_orders", orders })}\n\n`);
    } catch (e) {}

    if (!sseResellerOrderClients.has(email)) sseResellerOrderClients.set(email, new Set());
    sseResellerOrderClients.get(email).add(res);

    req.on("close", () => {
        const clients = sseResellerOrderClients.get(email);
        if (clients) { clients.delete(res); if (clients.size === 0) sseResellerOrderClients.delete(email); }
    });
});

app.get("/events/admin-orders", requireAdmin, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
        const resellerRows = db.prepare("SELECT * FROM orders ORDER BY createdAt DESC").all();
        const resellerOrders = resellerRows.map(r => ({ ...r, items: JSON.parse(r.items) }));

        const buyerRows = db.prepare("SELECT * FROM buyer_orders ORDER BY createdAt DESC").all();
        const buyerOrders = buyerRows.map(r => ({ ...r, items: JSON.parse(r.items) }));

        res.write(`data: ${JSON.stringify({ type: "admin_orders", resellerOrders, buyerOrders })}\n\n`);
    } catch (e) {}

    sseAdminClients.add(res);
    req.on("close", () => sseAdminClients.delete(res));
});

db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sku TEXT,
        location TEXT,
        supplier TEXT,
        qty INTEGER DEFAULT 0,
        reorderPoint INTEGER DEFAULT 5,
        lastReceived TEXT,
        notes TEXT,
        createdAt TEXT,
        updatedAt TEXT
    )
`);

app.get("/admin/inventory", requireAdmin, (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM inventory_items ORDER BY name ASC").all();
        res.json({ items: rows });
    } catch (err) {
        res.json({ items: [], error: err.message });
    }
});

app.post("/admin/inventory", requireAdmin, (req, res) => {
    const { name, sku, location, supplier, qty, reorderPoint, lastReceived, notes } = req.body;
    if (!name || !name.trim()) return res.json({ success: false, error: "Item name is required." });
    const id = "si" + Date.now() + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();
    try {
        db.prepare(`INSERT INTO inventory_items (id, name, sku, location, supplier, qty, reorderPoint, lastReceived, notes, createdAt, updatedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, name.trim(), sku || "", location || "Warehouse A", supplier || "",
               Number(qty) || 0, Number(reorderPoint) || 5,
               lastReceived || new Date().toISOString().slice(0, 10), notes || "", now, now);
        const item = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(id);
        res.json({ success: true, item });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.put("/admin/inventory/:id", requireAdmin, (req, res) => {
    const { id } = req.params;
    const { name, sku, location, supplier, qty, reorderPoint, lastReceived, notes } = req.body;
    if (!name || !name.trim()) return res.json({ success: false, error: "Item name is required." });
    const now = new Date().toISOString();
    try {
        const result = db.prepare(`UPDATE inventory_items SET name=?, sku=?, location=?, supplier=?, qty=?, reorderPoint=?, lastReceived=?, notes=?, updatedAt=? WHERE id=?`)
          .run(name.trim(), sku || "", location || "Warehouse A", supplier || "",
               Number(qty) || 0, Number(reorderPoint) || 5,
               lastReceived || "", notes || "", now, id);
        if (result.changes === 0) return res.json({ success: false, error: "Item not found." });
        const item = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(id);
        res.json({ success: true, item });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.delete("/admin/inventory/:id", requireAdmin, (req, res) => {
    const { id } = req.params;
    try {
        const result = db.prepare("DELETE FROM inventory_items WHERE id = ?").run(id);
        if (result.changes === 0) return res.json({ success: false, error: "Item not found." });
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ── Clean URLs ────────────────────────────────────────────────────────────────
app.get("/buyer",          (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/reseller-login", (req, res) => res.sendFile(path.join(__dirname, "vip-login.html")));

app.listen(process.env.PORT || 3000, () => {
    console.log("Server running on port " + (process.env.PORT || 3000));
});
