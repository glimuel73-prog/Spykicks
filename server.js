const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const path = require("path");
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use(express.static(path.join(__dirname)));

// ================= DATABASE =================
const db = new sqlite3.Database("/app/data/users.db");

db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS resellers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        shopName TEXT,
        experience TEXT,
        social TEXT,
        approved INTEGER DEFAULT 0
    )`);

    // Add missing columns if upgrading from old DB (ignore errors if already exist)
    ["shopName", "experience", "social"].forEach(col => {
        db.run(`ALTER TABLE resellers ADD COLUMN ${col} TEXT`, () => {});
    });

    db.run(`
    CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        data TEXT
    )`);
});

// ================= DELETE PRODUCT =================
app.post("/admin/delete-product", (req, res) => {
    const { id } = req.body;
    db.run("DELETE FROM products WHERE id = ?", [id], function (err) {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

// ================= APPLY =================
app.post("/apply-reseller", (req, res) => {
    const { email, shopName, experience, social } = req.body;

    if (!email || !shopName || !experience || !social) {
        return res.json({ success: false, error: "Missing fields" });
    }

    db.run(
        "INSERT OR IGNORE INTO resellers (email, shopName, experience, social, approved) VALUES (?, ?, ?, ?, 0)",
        [email, shopName, experience, social],
        function (err) {
            if (err) return res.json({ success: false, error: err.message });
            res.json({ success: true });
        }
    );
});

// ================= APPROVE =================
app.post("/admin/approve-reseller", (req, res) => {
    const { email } = req.body;
    db.run(
        "UPDATE resellers SET approved = 1 WHERE email = ?",
        [email],
        function (err) {
            if (err) return res.json({ success: false });
            res.json({ success: true });
        }
    );
});

// ================= REJECT / REMOVE =================
app.post("/admin/reject-reseller", (req, res) => {
    const { email } = req.body;
    db.run("DELETE FROM resellers WHERE email = ?", [email], function (err) {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

// ================= CHECK USER =================
app.post("/check-user", (req, res) => {
    const { email } = req.body;
    db.get(
        "SELECT * FROM resellers WHERE email = ? AND approved = 1",
        [email],
        (err, row) => {
            res.json({ verified: !!row });
        }
    );
});

// ================= RESELLER PRODUCTS =================
app.get("/reseller-products", (req, res) => {
    const { email } = req.query;

    db.get(
        "SELECT * FROM resellers WHERE email = ? AND approved = 1",
        [email],
        (err, row) => {
            if (!row) return res.json({ authorized: false });

            db.all("SELECT data FROM products", [], (err2, rows) => {
                if (err2 || !rows) return res.json({ authorized: true, products: [] });
                const products = rows
                    .map(r => JSON.parse(r.data))
                    .filter(p => !p.status || p.status === "active");
                res.json({ authorized: true, products });
            });
        }
    );
});

// ================= ADMIN — RESELLERS LIST =================
app.get("/admin/resellers", (req, res) => {
    db.all("SELECT email, shopName, experience, social, approved FROM resellers ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.json({ resellers: [] });
        res.json({ resellers: rows || [] });
    });
});

// ================= ADMIN — RESELLER COUNT =================
app.get("/admin/reseller-count", (req, res) => {
    db.get("SELECT COUNT(*) as count FROM resellers WHERE approved = 1", [], (err, row) => {
        res.json({ count: row ? row.count : 0 });
    });
});

// ================= ADMIN — SAVE PRODUCTS =================
app.post("/admin/save-products", (req, res) => {
    const { products } = req.body;
    if (!Array.isArray(products)) return res.json({ success: false });

    const stmt = db.prepare("INSERT OR REPLACE INTO products (id, data) VALUES (?, ?)");
    products.forEach(p => stmt.run(p.id, JSON.stringify(p)));
    stmt.finalize();
    res.json({ success: true });
});

// ================= ADMIN — GET PRODUCTS =================
app.get("/admin/products", (req, res) => {
    db.all("SELECT data FROM products", [], (err, rows) => {
        if (err) return res.json({ products: [] });
        const products = rows.map(r => JSON.parse(r.data));
        res.json({ products });
    });
});

// ================= ADMIN — ADD RESELLER DIRECTLY =================
app.post("/admin/add-reseller", (req, res) => {
    const { email } = req.body;
    if (!email) return res.json({ success: false, error: "Email required" });

    db.run(
        "INSERT OR IGNORE INTO resellers (email, shopName, experience, social, approved) VALUES (?, ?, ?, ?, 1)",
        [email, "", "", ""],
        function (err) {
            if (err) return res.json({ success: false, error: err.message });
            // If it already existed, just approve it
            db.run("UPDATE resellers SET approved = 1 WHERE email = ?", [email], () => {
                res.json({ success: true });
            });
        }
    );
});

// ================= START SERVER =================
app.listen(process.env.PORT || 3000, () => {
    console.log("Server running on port 3000");
});
