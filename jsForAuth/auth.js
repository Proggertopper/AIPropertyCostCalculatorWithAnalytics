const bcrypt = require("bcrypt");
const db = require("./db");

module.exports = app => {

    app.post("/api/register", async (req, res) => {
    const { email, password } = req.body;
    const hash = await bcrypt.hash(password, 10);

    await db.query(
        "INSERT INTO users (email, password_hash) VALUES ($1,$2)",
        [email, hash]
    );

    res.json({ ok: true });
    });

    app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;

    const user = await db.query(
      "SELECT * FROM users WHERE email=$1",
        [email]
    );

    if (!user.rows[0]) return res.sendStatus(401);

    const ok = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!ok) return res.sendStatus(401);

    req.session.userId = user.rows[0].id;
    req.session.email = user.rows[0].email;
    res.json({ ok: true });
    });

    app.post("/api/logout", (req, res) => {
    req.session.destroy();
    res.json({ ok: true });
    });

    app.get("/api/me", (req, res) => {
    if (!req.session.userId) return res.json({ loggedIn: false });
    
    res.json({
        loggedIn: true,
        userId: req.session.userId,
        email: req.session.email // можно сохранять email при login
    });
});
};

