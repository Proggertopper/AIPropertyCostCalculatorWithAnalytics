const bcrypt = require("bcrypt");
const db = require("./db");
const rateLimit = require("express-rate-limit");
const tokens = require("./tokens");



const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 ,standardHeaders: true, legacyHeaders: false  });
const registerLimiter = rateLimit({ windowMs: 15*60*1000, max: 3 , standardHeaders: true, legacyHeaders: false});


function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}



module.exports = app => {

    
app.post("/api/auth/register", registerLimiter, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password || !email.includes("@") || password.length < 8) {
        return res.status(400).json({ error: "invalid_data" });
    }

    let hash;
    try {
        hash = await bcrypt.hash(password, 12);
    } catch (e) {
        return res.status(500).json({ error: "internal_error" });
    }

    try {
        await db.query(
            "INSERT INTO users (email, password_hash) VALUES ($1,$2)",
            [email, hash]
        );
    } catch (e) {
        if (e.code === "23505") {
            await delay(1000);
            return res.status(409).json({ error: "email_exists" });
        }
        await delay(1000);
        return res.status(500).json({ error: "internal_error" });
    }

    res.status(201).json({ ok: true });
});



    app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "invalid_data" });
    }

    let user;
    try {
        user = await db.query(
            "SELECT id, email, password_hash FROM users WHERE email=$1",
            [email]
        );
    } catch {
        return res.status(500).json({ error: "internal_error" });
    }

    if (!user.rows[0]) {
        await delay(1000);
        return res.status(403).json({ error: "invalid_credentials" });
    }

    const ok = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!ok) {
        await delay(1000);
        return res.status(403).json({ error: "invalid_credentials" });
    }

    req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: "internal_error" });

        req.session.userId = user.rows[0].id;
        req.session.email = user.rows[0].email;
        res.json({ ok: true });
    });
});

    app.post("/api/auth/logout", (req, res) => {
        const csrfToken = req.headers["x-csrf-token"];
            const secret = req.session.csrfSecret;
        
            if (!secret || !csrfToken) {
        return res.status(403).json({ error: "CSRF token missing" });
    }

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



