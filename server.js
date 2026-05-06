const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ================= SSE — LIVE PRODUCT UPDATES =================
const sseClients = new Set();

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

// ================= PERSISTENT DATA DIR =================
const DATA_DIR = "/data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ================= UPLOADS DIR =================
const uploadsDir = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// ================= IMAGE UPLOAD =================
// Saves image to disk and returns a real URL — NOT a base64 data URL.
// This prevents the DB and localStorage from being bloated with MB-sized strings,
// which was causing products to silently vanish in the admin panel.
app.post("/admin/upload-image", (req, res) => {
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

// ================= DATABASE =================
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

// Seed default social links if not present
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

// ================= ADMIN — GET PASSWORD HASH =================
app.get("/admin/password-hash", (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_pw_hash'").get();
        res.json({ hash: row ? row.value : null });
    } catch (err) {
        res.json({ hash: null });
    }
});

// ================= ADMIN — CHANGE PASSWORD =================
app.post("/admin/change-password", (req, res) => {
    const { currentHash, newHash } = req.body;
    if (!currentHash || !newHash) return res.json({ success: false, error: "Missing fields" });

    // Default hash (same as compiled default in admin.html)
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

// ================= ADMIN — GET SOCIAL LINKS =================
app.get("/admin/social-links", (req, res) => {
    try {
        const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'social_%'").all();
        const links = {};
        rows.forEach(r => { links[r.key.replace("social_", "")] = r.value; });
        res.json({ links });
    } catch (err) {
        res.json({ links: {} });
    }
});

// ================= ADMIN — SAVE SOCIAL LINKS =================
app.post("/admin/social-links", (req, res) => {
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

// ================= ADMIN — GET BRAND TAXONOMY =================
app.get("/admin/brand-taxonomy", (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'brand_taxonomy'").get();
        res.json({ taxonomy: row ? JSON.parse(row.value) : [] });
    } catch (err) {
        res.json({ taxonomy: [] });
    }
});

// ================= ADMIN — SAVE BRAND TAXONOMY =================
app.post("/admin/brand-taxonomy", (req, res) => {
    const { taxonomy } = req.body;
    if (!Array.isArray(taxonomy)) return res.json({ success: false });
    try {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("brand_taxonomy", JSON.stringify(taxonomy));
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= PUBLIC — GET BRAND TAXONOMY =================
app.get("/brand-taxonomy", (req, res) => {
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'brand_taxonomy'").get();
        res.json({ taxonomy: row ? JSON.parse(row.value) : [] });
    } catch (err) {
        res.json({ taxonomy: [] });
    }
});

// ================= PUBLIC — GET SOCIAL LINKS =================
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


// ================= PUBLIC — BUYER PRODUCTS =================
// Only returns active products that are published to 'buyer' or 'both'.
// Products with publishTo === 'reseller' are excluded here.
app.get("/products", (req, res) => {
    try {
        const rows = db.prepare("SELECT data FROM products").all();
        const products = rows
            .map(r => JSON.parse(r.data))
            .filter(p => {
                const active = !p.status || p.status === "active";
                const pt = p.publishTo || "both"; // treat missing as 'both' (legacy)
                return active && (pt === "buyer" || pt === "both");
            });
        res.json({ products });
    } catch (err) {
        res.json({ products: [] });
    }
});

app.post("/admin/delete-product", (req, res) => {
    const { id } = req.body;
    try {
        // Also delete associated image files from disk
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
        broadcastProducts();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// ================= APPLY =================
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

// ================= APPROVE =================
app.post("/admin/approve-reseller", (req, res) => {
    const { email } = req.body;
    try {
        db.prepare("UPDATE resellers SET approved = 1 WHERE email = ?").run(email);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// ================= REJECT / REMOVE =================
app.post("/admin/reject-reseller", (req, res) => {
    const { email } = req.body;
    try {
        db.prepare("DELETE FROM resellers WHERE email = ?").run(email);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// ================= CHECK USER =================
app.post("/check-user", (req, res) => {
    const { email } = req.body;
    try {
        const row = db.prepare("SELECT * FROM resellers WHERE email = ? AND approved = 1").get(email);
        res.json({ verified: !!row });
    } catch (err) {
        res.json({ verified: false });
    }
});

// ================= RESELLER PRODUCTS =================
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
                const pt = p.publishTo || "both"; // treat missing as 'both' (legacy)
                return active && (pt === "reseller" || pt === "both");
            });
        res.json({ authorized: true, products });
    } catch (err) {
        res.json({ authorized: false });
    }
});

// ================= ADMIN — RESELLERS LIST =================
app.get("/admin/resellers", (req, res) => {
    try {
        const rows = db.prepare("SELECT email, shopName, experience, social, approved FROM resellers ORDER BY id DESC").all();
        res.json({ resellers: rows || [] });
    } catch (err) {
        res.json({ resellers: [] });
    }
});

// ================= ADMIN — RESELLER COUNT =================
app.get("/admin/reseller-count", (req, res) => {
    try {
        const row = db.prepare("SELECT COUNT(*) as count FROM resellers WHERE approved = 1").get();
        res.json({ count: row ? row.count : 0 });
    } catch (err) {
        res.json({ count: 0 });
    }
});

// ================= ADMIN — SAVE PRODUCTS (bulk) =================
app.post("/admin/save-products", (req, res) => {
    const { products } = req.body;
    if (!Array.isArray(products)) return res.json({ success: false });
    try {
        const stmt = db.prepare("INSERT OR REPLACE INTO products (id, data) VALUES (?, ?)");
        const insertMany = db.transaction((prods) => {
            for (const p of prods) stmt.run(p.id, JSON.stringify(p));
        });
        insertMany(products);
        broadcastProducts();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — SAVE SINGLE PRODUCT (upsert) =================
// Use this instead of save-products when adding/editing one product,
// so that stock deductions on OTHER products are never overwritten.
app.post("/admin/save-product", (req, res) => {
    const { product } = req.body;
    if (!product || !product.id) return res.json({ success: false, error: "Missing product or id" });
    try {
        db.prepare("INSERT OR REPLACE INTO products (id, data) VALUES (?, ?)").run(product.id, JSON.stringify(product));
        broadcastProducts();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — GET SINGLE PRODUCT (fresh from DB) =================
app.get("/admin/product/:id", (req, res) => {
    try {
        const row = db.prepare("SELECT data FROM products WHERE id = ?").get(req.params.id);
        if (!row) return res.json({ product: null });
        res.json({ product: JSON.parse(row.data) });
    } catch (err) {
        res.json({ product: null });
    }
});

// ================= ADMIN — GET PRODUCTS =================
app.get("/admin/products", (req, res) => {
    try {
        const rows = db.prepare("SELECT data FROM products").all();
        const products = rows.map(r => JSON.parse(r.data));
        res.json({ products });
    } catch (err) {
        res.json({ products: [] });
    }
});

// ================= ADMIN — ADD RESELLER DIRECTLY =================
app.post("/admin/add-reseller", (req, res) => {
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

// ================= ORDERS TABLE =================
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

// ================= RESELLER — PLACE ORDER =================
app.post("/reseller/place-order", (req, res) => {
    const { email, items, totalAmount, note } = req.body;
    if (!email || !items || !Array.isArray(items) || items.length === 0)
        return res.json({ success: false, error: "Missing fields" });

    // Verify reseller is still approved
    const row = db.prepare("SELECT * FROM resellers WHERE email = ? AND approved = 1").get(email);
    if (!row) return res.json({ success: false, error: "Not an approved reseller" });

    try {
        const orderId = "ORD_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7).toUpperCase();
        const now = new Date().toISOString();
        db.prepare(
            "INSERT INTO orders (id, resellerEmail, items, totalAmount, status, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)"
        ).run(orderId, email, JSON.stringify(items), totalAmount || 0, note || "", now, now);
        res.json({ success: true, orderId });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= RESELLER — GET OWN ORDERS =================
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

// ================= RESELLER — CANCEL OWN ORDER =================
app.post("/reseller/cancel-order", (req, res) => {
    const { email, orderId } = req.body;
    if (!email || !orderId) return res.json({ success: false, error: "Missing fields" });

    try {
        const orderRow = db.prepare("SELECT * FROM orders WHERE id = ? AND resellerEmail = ?").get(orderId, email);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });
        if (orderRow.status !== "pending") return res.json({ success: false, error: "Only pending orders can be cancelled" });

        const now = new Date().toISOString();
        db.prepare("UPDATE orders SET status = 'cancelled', updatedAt = ? WHERE id = ?").run(now, orderId);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — GET ALL ORDERS =================
app.get("/admin/orders", (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM orders ORDER BY createdAt DESC").all();
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        res.json({ orders });
    } catch (err) {
        res.json({ orders: [] });
    }
});

// ================= ADMIN — APPROVE ORDER (deduct stock) =================
app.post("/admin/approve-order", (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });

    try {
        const orderRow = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });
        if (orderRow.status !== "pending") return res.json({ success: false, error: "Order is not pending" });

        const items = JSON.parse(orderRow.items);
        const now = new Date().toISOString();

        // Deduct stock for each item in a transaction
        const approve = db.transaction(() => {
            for (const item of items) {
                const prodRow = db.prepare("SELECT data FROM products WHERE id = ?").get(item.productId);
                if (!prodRow) continue;
                const product = JSON.parse(prodRow.data);

                if (item.size && product.sizes && product.sizes.length > 0 && typeof product.sizes[0] === 'object') {
                    // Per-size stock deduction
                    const sizeObj = product.sizes.find(s => String(s.size) === String(item.size));
                    if (sizeObj) {
                        // Per-color stock deduction (new model)
                        if (item.color && sizeObj.colorStock && typeof sizeObj.colorStock === 'object') {
                            const prev = Number(sizeObj.colorStock[item.color]) || 0;
                            sizeObj.colorStock[item.color] = Math.max(0, prev - (Number(item.qty) || 1));
                            // Recompute aggregate stock for this size = sum of all color stocks
                            sizeObj.stock = Object.values(sizeObj.colorStock).reduce((a, b) => a + (Number(b) || 0), 0);
                        } else if (sizeObj.stock != null) {
                            sizeObj.stock = Math.max(0, (Number(sizeObj.stock) || 0) - (Number(item.qty) || 1));
                        }
                    }
                    // Also update product-level stock as sum across all sizes
                    product.stock = product.sizes.reduce((sum, s) => sum + (Number(s.stock) || 0), 0);
                } else {
                    // Global stock deduction
                    product.stock = Math.max(0, (Number(product.stock) || 0) - (Number(item.qty) || 1));
                }

                db.prepare("UPDATE products SET data = ? WHERE id = ?").run(JSON.stringify(product), item.productId);
            }
            db.prepare("UPDATE orders SET status = 'approved', updatedAt = ? WHERE id = ?").run(now, orderId);
        });

        approve();
        broadcastProducts();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — REJECT ORDER =================
app.post("/admin/reject-order", (req, res) => {
    const { orderId, reason } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });
    try {
        const now = new Date().toISOString();
        db.prepare("UPDATE orders SET status = 'rejected', note = ?, updatedAt = ? WHERE id = ?")
            .run(reason || "", now, orderId);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — DELETE ORDER =================
app.post("/admin/delete-order", (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.json({ success: false, error: "orderId required" });
    try {
        const result = db.prepare("DELETE FROM orders WHERE id = ?").run(orderId);
        if (result.changes === 0) return res.json({ success: false, error: "Order not found" });
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — ORDER COUNT (pending) =================
app.get("/admin/order-count", (req, res) => {
    try {
        const row = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'").get();
        res.json({ count: row ? row.count : 0 });
    } catch (err) {
        res.json({ count: 0 });
    }
});

// ================= BUYER ORDERS TABLE =================
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
// Migration: add stockDeducted column for existing DBs
try { db.exec("ALTER TABLE buyer_orders ADD COLUMN stockDeducted INTEGER DEFAULT 0"); } catch(e) {}

// ================= BUYER — PLACE ORDER =================
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
        res.json({ success: true, orderId });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — GET ALL BUYER ORDERS =================
app.get("/admin/buyer-orders", (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM buyer_orders ORDER BY createdAt DESC").all();
        const orders = rows.map(r => ({ ...r, items: JSON.parse(r.items) }));
        res.json({ orders });
    } catch (err) {
        res.json({ orders: [] });
    }
});

// ================= SHARED HELPER — deduct/restore stock for buyer order items =================
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

// ================= ADMIN — UPDATE BUYER ORDER STATUS (with stock logic) =================
app.post("/admin/buyer-order-status", (req, res) => {
    const { orderId, status } = req.body;
    if (!orderId || !status) return res.json({ success: false, error: "Missing fields" });
    const allowed = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) return res.json({ success: false, error: "Invalid status" });
    try {
        const orderRow = db.prepare("SELECT * FROM buyer_orders WHERE id = ?").get(orderId);
        if (!orderRow) return res.json({ success: false, error: "Order not found" });

        const items = JSON.parse(orderRow.items);
        const wasDeducted = orderRow.stockDeducted === 1;
        // Stock-affecting statuses: processing/shipped/delivered = stock deducted
        // pending/cancelled = stock NOT deducted
        const shouldDeduct = ['processing', 'shipped', 'delivered'].includes(status);
        const now = new Date().toISOString();

        const doUpdate = db.transaction(() => {
            if (shouldDeduct && !wasDeducted) {
                // Moving into a "confirmed" state — deduct stock
                deductBuyerStock(items);
                db.prepare("UPDATE buyer_orders SET status = ?, updatedAt = ?, stockDeducted = 1 WHERE id = ?").run(status, now, orderId);
            } else if (!shouldDeduct && wasDeducted) {
                // Moving back to pending or cancelling — restore stock
                restoreBuyerStock(items);
                db.prepare("UPDATE buyer_orders SET status = ?, updatedAt = ?, stockDeducted = 0 WHERE id = ?").run(status, now, orderId);
            } else {
                // No stock change needed (e.g. shipped → delivered, pending → cancelled without prior deduction)
                db.prepare("UPDATE buyer_orders SET status = ?, updatedAt = ? WHERE id = ?").run(status, now, orderId);
            }
        });
        doUpdate();
        broadcastProducts();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — APPROVE BUYER ORDER (deduct stock, move to processing) =================
app.post("/admin/approve-buyer-order", (req, res) => {
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
        broadcastProducts();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — REJECT BUYER ORDER (restore stock if deducted, cancel) =================
app.post("/admin/reject-buyer-order", (req, res) => {
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
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= BUYER — CANCEL OWN ORDER (restore stock if deducted) =================
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
        broadcastProducts();
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ================= ADMIN — DELETE BUYER ORDER =================
app.post("/admin/delete-buyer-order", (req, res) => {
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

// ================= ADMIN — BUYER ORDER COUNT (pending) =================
app.get("/admin/buyer-order-count", (req, res) => {
    try {
        const row = db.prepare("SELECT COUNT(*) as count FROM buyer_orders WHERE status = 'pending'").get();
        res.json({ count: row ? row.count : 0 });
    } catch (err) {
        res.json({ count: 0 });
    }
});

// ================= BUYER — GET OWN ORDERS (by contact) =================
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

// ================= SSE — CLIENT SUBSCRIPTION =================
app.get("/events/products", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send current products immediately on connect
    try {
        const rows = db.prepare("SELECT data FROM products").all();
        const products = rows.map(r => JSON.parse(r.data));
        res.write(`data: ${JSON.stringify({ type: "products", products })}\n\n`);
    } catch (e) {}

    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
});

// ================= START SERVER =================
app.listen(process.env.PORT || 3000, () => {
    console.log("Server running on port " + (process.env.PORT || 3000));
});
