const db = require("./db");
const tokens = require("./tokens");

async function initTables() {
    await db.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE,
        password_hash TEXT,
        google_id TEXT,
        facebook_id TEXT,
        created_at TIMESTAMP DEFAULT NOW()
    )
    `);

    await db.query(`
    CREATE TABLE IF NOT EXISTS calculations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        expression TEXT,
        result TEXT,
        created_at TIMESTAMP DEFAULT NOW()
    )
    `);
}

initTables().then(() => console.log("Tables ready"));

module.exports = app => {

    app.post("/api/app/calculation", async (req, res) => {
    if (!req.session.userId) return res.sendStatus(401);

    const csrfToken = req.headers["x-csrf-token"];
    const secret = req.session.csrfSecret;

    if (!tokens.verify(secret, csrfToken)) {
    return res.status(403).json({ error: "Invalid CSRF token" });
    }

    const { expression, result } = req.body;

    await db.query(
        "INSERT INTO calculations (user_id, expression, result) VALUES ($1,$2,$3)",
        [req.session.userId, expression, result]
    );

    res.json({ ok: true });
    });

    app.get("/api/app/calculations", async (req, res) => {
    if (!req.session.userId) return res.sendStatus(401);

    const csrfToken = req.headers["x-csrf-token"];
    const secret = req.session.csrfSecret;

    if (!tokens.verify(secret, csrfToken)) {
    return res.status(403).json({ error: "Invalid CSRF token" });
    }

    const data = await db.query(
      "SELECT * FROM calculations WHERE user_id=$1",
        [req.session.userId]
    );

    res.json(data.rows);
    });
};