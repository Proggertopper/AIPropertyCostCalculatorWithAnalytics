require("dotenv").config();
const rateLimit = require('express-rate-limit');
const db = require("./db");
const crypto = require("crypto");

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 ,standardHeaders: true, legacyHeaders: false  });

function registerFacebookRoutes(app){
app.get("/auth/api/facebook", loginLimiter , (req, res) => {
    const clientId = process.env.FB_CLIENT_ID;
    const redirectUri = process.env.FB_REDIRECT_URI;

    const state=crypto.randomBytes(16).toString("hex");
    req.session.fbState=state;

    const fbAuthUrl = `https://www.facebook.com/v15.0/dialog/oauth?client_id=${clientId}&redirect_uri=${redirectUri}&scope=email&state=${state}`;
    res.redirect(fbAuthUrl);
});


app.get("/auth/api/facebook/callback", loginLimiter ,  async (req, res) => {
    if (!req.query.state || req.query.state !== req.session.fbState) {
    return res.redirect("/login.html?error=oauth_state_invalid");
}
    delete req.session.fbState;

    const code = req.query.code;
    if (!code)  return res.redirect("/login.html?error=oauth_no_code");

  // Обмен code на access_token
    let tokenRes
    try{
        tokenRes = await fetch(
    `https://graph.facebook.com/v15.0/oauth/access_token?client_id=${process.env.FB_CLIENT_ID}&redirect_uri=${process.env.FB_REDIRECT_URI}&client_secret=${process.env.FB_CLIENT_SECRET}&code=${code}`
    );
    } catch(err){
        console.error("Token fetch failed:", err);
        return res.redirect("/login.html?error=facebook_unavailable");
    }
        
    if (!tokenRes.ok) {
        console.error("Token response not ok:", await tokenRes.text());
    return res.redirect("/login.html?error=token_exchange_failed");
}
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;


if (!accessToken) {
    return res.redirect("/login.html?error=token_exchange_failed");
}

  // Получаем профиль пользователя
    let profileRes;
    try{
        profileRes = await fetch(`https://graph.facebook.com/me?fields=id,email&access_token=${accessToken}`);
    } catch(err){
        console.error("Profile fetch failed:", err);
        return res.redirect("/login.html?error=facebook_unavailable");
    }
    if (!profileRes.ok) {
        console.error("Profile response not ok:", await profileRes.text());
    return res.redirect("/login.html?error=profile_fetch_failed");
}
    const profile = await profileRes.json();

    if (!profile.email) {
    return res.redirect("/login.html?error=no_email");
}

    let user;
    try {
        user = await db.query(
            "SELECT * FROM users WHERE facebook_id=$1",
            [profile.id]
        );

        if (!user.rows[0]) {
            user = await db.query(
                "SELECT * FROM users WHERE email=$1",
                [profile.email]
            );

            if (user.rows[0]) {
                await db.query(
                    "UPDATE users SET facebook_id=$1 WHERE id=$2",
                    [profile.id, user.rows[0].id]
                );
            } else {
                user = await db.query(
                    "INSERT INTO users (facebook_id, email) VALUES ($1, $2) RETURNING *",
                    [profile.id, profile.email]
                );
            }
        }
    } catch (err) {
        console.error("DB error:", err);
        return res.redirect("/login.html?error=internal_error");
    }

// В сессию кладём внутренний ID
req.session.regenerate((err) => {
    if(err){
        console.error("Session regenerate failed:", err);// идет туда откуда запускал или на хостинг сервер 
        return res.redirect("/login.html?error=internal_error");
    }
    req.session.userId = user.rows[0].id;
    req.session.email = user.rows[0].email;
    res.redirect("/mainPage.html");
});
});
}

module.exports=registerFacebookRoutes