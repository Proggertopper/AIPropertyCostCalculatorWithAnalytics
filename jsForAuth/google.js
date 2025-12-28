require("dotenv").config();
const db = require("./db");
const rateLimit = require('express-rate-limit');
const crypto = require("crypto");

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 ,standardHeaders: true, legacyHeaders: false  });



function registerGoogleRoutes(app){
    
    app.get("/auth/api/google", loginLimiter, (req, res) => {
        const state = crypto.randomBytes(16).toString("hex");
        req.session.googleState = state;

        const rootUrl = "https://accounts.google.com/o/oauth2/v2/auth";
        const params = new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            redirect_uri: process.env.GOOGLE_REDIRECT_URI,
            response_type: "code",
            scope: "openid email profile",
            access_type: "offline",
            prompt: "consent",
            state
        });

        res.redirect(`${rootUrl}?${params.toString()}`);
    });
    ///////////////////////////
    
    app.get("/auth/api/google/callback", loginLimiter, async (req, res) => {

        // 🔐 STATE CHECK (CSRF protection)
        if (!req.query.state || req.query.state !== req.session.googleState) {
            return res.redirect("/login.html?error=oauth_state_invalid");
        }
        delete req.session.googleState;

        const code = req.query.code;
        if (!code) {
            return res.redirect("/login.html?error=oauth_no_code");
        }

        // ====== TOKEN EXCHANGE ======
        let tokenRes;
        try {
            tokenRes = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    code,
                    client_id: process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
                    grant_type: "authorization_code"
                })
            });
        } catch (err) {
            console.error("Google token fetch failed:", err);
            return res.redirect("/login.html?error=google_unavailable");
        }

        if (!tokenRes.ok) {
            console.error("Google token error:", await tokenRes.text());
            return res.redirect("/login.html?error=token_exchange_failed");
        }

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
            return res.redirect("/login.html?error=token_exchange_failed");
        }

        // ====== GET PROFILE ======
        let userRes;
        try {
            userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
                headers: {
                    Authorization: `Bearer ${tokenData.access_token}`
                }
            });
        } catch (err) {
            console.error("Google profile fetch failed:", err);
            return res.redirect("/login.html?error=google_unavailable");
        }

        if (!userRes.ok) {
            console.error("Google profile error:", await userRes.text());
            return res.redirect("/login.html?error=profile_fetch_failed");
        }

        const profile = await userRes.json();

        if (!profile.email) {
            return res.redirect("/login.html?error=no_email");
        }

        //  DB LOGIC 
        let user;
        try {
            user = await db.query(
                "SELECT * FROM users WHERE google_id=$1",
                [profile.id]
            );

            if (!user.rows[0]) {
                user = await db.query(
                    "SELECT * FROM users WHERE email=$1",
                    [profile.email]
                );

                if (user.rows[0]) {
                    await db.query(
                        "UPDATE users SET google_id=$1 WHERE id=$2",
                        [profile.id, user.rows[0].id]
                    );
                } else {
                    user = await db.query(
                        "INSERT INTO users (google_id, email) VALUES ($1, $2) RETURNING *",
                        [profile.id, profile.email]
                    );
                }
            }
        } catch (err) {
            console.error("DB error:", err);
            return res.redirect("/login.html?error=internal_error");
        }

        //  SESSION FIXATION PROTECTION 
        req.session.regenerate(err => {
            if (err) {
                console.error("Session regenerate failed:", err);
                return res.redirect("/login.html?error=internal_error");
            }

            req.session.userId = user.rows[0].id;

            res.redirect("/mainPage.html");
        });
    });
}

module.exports = registerGoogleRoutes