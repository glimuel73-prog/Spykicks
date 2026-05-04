const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

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
            .filter(p => !p.status || p.status === "active");
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
                    if (sizeObj && sizeObj.stock != null) {
                        sizeObj.stock = Math.max(0, (Number(sizeObj.stock) || 0) - (Number(item.qty) || 1));
                    }
                    // Also update product-level stock as sum
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

// ================= START SERVER =================
app.listen(process.env.PORT || 3000, () => {
    console.log("Server running on port " + (process.env.PORT || 3000));
});
