const db = require("./db");
const tokens = require("./tokens");

module.exports = app => {

    app.post("/api/app/calculation", async (req, res) => {
    if (!req.session.userId) return res.sendStatus(401);

    const csrfToken = req.headers["x-csrf-token"];
    const secret = req.session.csrfSecret;

    if (!secret || !csrfToken) {
        return res.status(403).json({ error: "CSRF token missing" });
    }

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

    // const csrfToken = req.headers["x-csrf-token"];
    // const secret = req.session.csrfSecret;

    // if (!secret || !csrfToken) {
    //     return res.status(403).json({ error: "CSRF token missing" });
    // }

    // if (!tokens.verify(secret, csrfToken)) {
    // return res.status(403).json({ error: "Invalid CSRF token" });
    // }

    const data = await db.query(
      "SELECT * FROM calculations WHERE user_id=$1",
        [req.session.userId]
    );

    res.json(data.rows);
    });
};