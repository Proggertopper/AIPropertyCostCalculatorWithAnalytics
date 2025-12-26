require("dotenv").config();
const express = require("express");
const session = require("express-session");
const tokens = require("./tokens");

const authRoutes = require("./auth");
const helmet = require("helmet"); 
const calcRoutes = require("./calculator");
const path = require("path");
const db = require("./db");
const registerFacebookRoutes = require("./facebook");
// const registerAppleRoutes = require("./apple");

const app = express();
app.use(express.json());
app.use(helmet());




app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
    httpOnly: true,
    secure: false 
    }
}));
// app.use(session({
//     secret: process.env.SESSION_SECRET,
//     resave: false,
//     saveUninitialized: false,
//     cookie: {
//     httpOnly: true,
//     secure: true,   ДЛЯ ПРОДАКШЕНА
//     sameSite: "strict",
//     maxAge: 1000 * 60 * 60 * 24 // 1 день для обычной и 30 для remember me только надо ее еще сделать или делать уже гугловскую 
//     }
// }));

// function requireAuth(req, res, next) {
//     if (!req.session.userId) return res.sendStatus(401);
//         next();
// }


app.use(express.static(path.join(__dirname,".." ,"html")));
app.use(express.static(path.join(__dirname,"..","jsForAuth")));

// Подключаем маршруты
authRoutes(app);
calcRoutes(app);
registerFacebookRoutes(app);
// registerAppleRoutes(app);


app.get("/auth/api/google", (req, res) => {
    const rootUrl = "https://accounts.google.com/o/oauth2/v2/auth";
    const options = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        response_type: "code",
        scope: "openid email profile",
        access_type: "offline",
        prompt: "consent"
    });
    res.redirect(`${rootUrl}?${options.toString()}`);
});
///////////////////////////

app.get("/auth/api/google/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect("/login.html");

    // Обмен кода на токен
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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
    const tokenData = await tokenRes.json();

    // Получаем профиль пользователя
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();

    // Здесь можно проверить, есть ли пользователь в БД, иначе создать
    let user = await db.query("SELECT * FROM users WHERE email=$1", [userData.email]);
    if (!user.rows[0]) {
        const newUser = await db.query(
            "INSERT INTO users (email) VALUES ($1) RETURNING *",
            [userData.email]
        );
        user = newUser;
    }

    // Сохраняем в сессию
    req.session.userId = user.rows[0].id;
    req.session.email = user.rows[0].email;

    res.redirect("/mainPage.html");
});

app.listen(3000, () => console.log("Server started on http://localhost:3000"));

