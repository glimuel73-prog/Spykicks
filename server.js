const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ================= UPLOADS DIR =================
const uploadsDir = "/data/uploads";

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
const db = new Database("/data/users.db");

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

// ================= DELETE PRODUCT =================
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

// ================= ADMIN — SAVE PRODUCTS =================
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

// ================= START SERVER =================
app.listen(process.env.PORT || 3000, () => {
    console.log("Server running on port " + (process.env.PORT || 3000));
});
