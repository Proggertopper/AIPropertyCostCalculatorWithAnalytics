const bcrypt = require("bcrypt");
const db = require("./db");
const rateLimit = require("express-rate-limit");
const tokens = require("./tokens");

const validator = require("validator");

const {RedisStore} = require("rate-limit-redis");
const redisClient = require("./redis");

const loginLimiter = rateLimit({
    store: new RedisStore({
        sendCommand: (...args) => redisClient.sendCommand(args),
    }),
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
});





function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}



module.exports = app => {

    

    app.get("/api/csrf", (req, res) => {
        if (!req.session.csrfSecret) {
            req.session.csrfSecret = tokens.secretSync();
        }

        res.set("Cache-Control", "no-store");

        // Сохраняем сессию перед отправкой токена
        req.session.save(err => {
            if (err) {
                console.error("Session save failed:", err);
                return res.status(500).end();
            }
            res.json({ csrfToken: tokens.create(req.session.csrfSecret) });
        });
    });

    app.get("/api/auth/me", async (req, res) => {
        res.set("Cache-Control", "no-store");

        try {

            if (!req.session.userId) {
                return res.json({ loggedIn: false });
            }

            const result = await db.query(
                "SELECT email FROM users WHERE id = $1",
                [req.session.userId]
            );

            if (!result.rows[0]) {
                return res.sendStatus(401);
                //return res.json({ loggedIn: false });
            }

            res.json({
                loggedIn: true,
                userId: req.session.userId,
                email: result.rows[0].email
            });

        } catch (err) {
            console.error("Auth /me error:", err);
            res.status(500).json({ error: "internal_error" });
        }
    });

    


    
app.post("/api/auth/register", loginLimiter, async (req, res) => {
    const csrfToken = req.headers["x-csrf-token"];
            const secret = req.session.csrfSecret;

    res.set("Cache-Control", "no-store");
        
            if (!secret || !csrfToken) {
        return res.status(403).json({ error: "CSRF token missing" });
    }

            if (!tokens.verify(secret, csrfToken)) {
            return res.status(403).json({ error: "Invalid CSRF token" });
            }
    const { email, password } = req.body;

    if (!email || !password || !email.includes("@") || password.length < 8 || !validator.isEmail(email)) {
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
        console.error("Registration error:", e);
        if (e.code === "23505") {
            await delay(1000);
            return res.status(400).json({ error: "registration_failed" });
        }
        await delay(1000);
        return res.status(400).json({ error: "registration_failed" });
    }

    res.status(201).json({ ok: true });
});



    app.post("/api/auth/login", loginLimiter, async (req, res) => {
        const csrfToken = req.headers["x-csrf-token"];
            const secret = req.session.csrfSecret;
         console.log("Secret:", req.session.csrfSecret);
         console.log("Token:", csrfToken);

        res.set("Cache-Control", "no-store");
        
            if (!secret || !csrfToken) {
        return res.status(403).json({ error: "CSRF token missing" });
    }

            if (!tokens.verify(secret, csrfToken)) {
            return res.status(403).json({ error: "Invalid CSRF token" });
            }
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
        res.json({ ok: true });
    });
});




    
    app.post("/api/auth/logout", (req, res) => {
    const csrfToken = req.headers["x-csrf-token"];
    const secret = req.session.csrfSecret;

        res.set("Cache-Control", "no-store");

    if (!secret || !csrfToken || !tokens.verify(secret, csrfToken)) {
    return res.status(403).json({ error: "csrf" });
    }

    req.session.regenerate(() => {
    res.json({ ok: true });
    });
});







// console.warn("Failed login", {
//     email,                          хз нужно или нет 
//     ip: req.ip,
//     ua: req.headers["user-agent"]
// });

};



