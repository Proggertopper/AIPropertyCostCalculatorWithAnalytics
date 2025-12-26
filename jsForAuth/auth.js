const bcrypt = require("bcrypt");
const db = require("./db");
const rateLimit = require("express-rate-limit");
const tokens = require("./tokens");



const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 10,                 // 10 попыток
    standardHeaders: true,
    legacyHeaders: false
});

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}



module.exports = app => {

    app.post("/api/auth/register",authLimiter, async (req, res) => {
    const { email, password } = req.body;
    const hash = await bcrypt.hash(password, 10);

    await db.query(
        "INSERT INTO users (email, password_hash) VALUES ($1,$2)",
        [email, hash]
    );

    res.json({ ok: true });
    });

    app.post("/api/auth/login", authLimiter , async (req, res) => {
    const { email, password } = req.body;

    const user = await db.query(
      "SELECT * FROM users WHERE email=$1",
        [email]
    );

    if (!user.rows[0]) {
        await delay(1000);
        return res.sendStatus(401);
    }

    const ok = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!ok) {
        await delay(1000);
        return res.sendStatus(401);
    }

    req.session.userId = user.rows[0].id;
    req.session.email = user.rows[0].email;
    res.json({ ok: true });
    });

    app.post("/api/auth/logout", (req, res) => {
        const csrfToken = req.headers["x-csrf-token"];
            const secret = req.session.csrfSecret;
        
            if (!tokens.verify(secret, csrfToken)) {
            return res.status(403).json({ error: "Invalid CSRF token" });
            }
    req.session.destroy();
    res.json({ ok: true });
    });

    app.get("/api/auth/me", (req, res) => {
    if (!req.session.userId) return res.json({ loggedIn: false });
    
    res.json({
        loggedIn: true,
        userId: req.session.userId,
        email: req.session.email // можно сохранять email при login
    });
});

app.get("/api/csrf", (req, res) => {
    if (!req.session.csrfSecret) {
    req.session.csrfSecret = tokens.secretSync();
    }

    const csrfToken = tokens.create(req.session.csrfSecret);

    res.json({ csrfToken });
});
// console.warn("Failed login", {
//     email,                          хз нужно или нет 
//     ip: req.ip,
//     ua: req.headers["user-agent"]
// });

};



