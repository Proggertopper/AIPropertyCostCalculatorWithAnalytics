require("dotenv").config();
const express = require("express");
const session = require("express-session");
const rateLimit = require('express-rate-limit');
const pgSession = require("connect-pg-simple")(session);
const tokens = require("./tokens");

const authRoutes = require("./auth");
const helmet = require("helmet"); 
const calcRoutes = require("./calculator");
const path = require("path");
const db = require("./db");
const registerFacebookRoutes = require("./facebook");
const pool = require("./db");
const registerGoogleRoutes = require("./google");
// const registerAppleRoutes = require("./apple");

const app = express();
app.use(express.json());
app.use(helmet());
app.use(
    helmet({
    contentSecurityPolicy: {
    useDefaults: true,
    directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:"],
        "object-src": ["'none'"]
    }
    }
})
);
app.use(express.json({ limit: "10kb" })); 



app.use(session({
    store: new pgSession({
    pool: pool, // используем существующий пул соединений
    tableName: "user_sessions",
    createTableIfMissing: true 
    }),
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
//     sameSite: "lax", lax - для редиректа OAuth2
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
registerGoogleRoutes(app);
// registerAppleRoutes(app);


app.listen(3000, () => console.log("Server started on http://localhost:3000"));

