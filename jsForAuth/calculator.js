const db = require("./db");

async function initTables() {
    await db.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE,
        password_hash TEXT,
        google_id TEXT,
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

    app.post("/api/calculation", async (req, res) => {
    if (!req.session.userId) return res.sendStatus(401);

    const { expression, result } = req.body;

    await db.query(
        "INSERT INTO calculations (user_id, expression, result) VALUES ($1,$2,$3)",
        [req.session.userId, expression, result]
    );

    res.json({ ok: true });
    });

    app.get("/api/calculations", async (req, res) => {
    if (!req.session.userId) return res.sendStatus(401);

    const data = await db.query(
      "SELECT * FROM calculations WHERE user_id=$1",
        [req.session.userId]
    );

    res.json(data.rows);
    });
};