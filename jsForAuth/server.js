require("dotenv").config();
const express = require("express");
const session = require("express-session");

const pgSession = require("connect-pg-simple")(session);
const tokens = require("./tokens");
const authRoutes = require("./auth"); 
const calcRoutes = require("./calculator");
const path = require("path");
const db = require("./db");
const registerFacebookRoutes = require("./facebook");
const pool = require("./db");
const registerGoogleRoutes = require("./google");
const contactRoutes = require("./contactUs");
// const registerAppleRoutes = require("./apple");


const { RedisStore } = require("connect-redis");
const redisClient = require("./redis");

const app = express();


app.set('trust proxy', 1);
app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; 

// app.use(session({
//     store: new pgSession({
//     pool: pool, // используем существующий пул соединений
//     tableName: "session",
//     createTableIfMissing: false ,
//     proxy: true, 
//     }),
//     secret: process.env.SESSION_SECRET,
//     resave: false,
//     saveUninitialized: false,
//     cookie: {
//     httpOnly: true,
//     secure: true,   //ДЛЯ ПРОДАКШЕНА true
//     sameSite: "lax", //lax - для редиректа OAuth2
//     maxAge: 1000 * 60 * 60 * 24 // 1 день для обычной и 30 для remember me только надо ее еще сделать или делать уже гугловскую 
//     }
// }));

// if (process.env.NODE_ENV === 'development') {
//     console.log('⚡ Dev mode enabled: логирование и тестовые фичи включены');
// } else if (process.env.NODE_ENV === 'production') {
//     console.log('✅ Prod mode: логирование минимальное, безопасный режим');
// } НА БУДУЩЕЕ МОЖНО ЛОГИРОВАТЬ ХОРОШО 



app.use(session({
    store:new RedisStore({
        client: redisClient,
        prefix: "sess:"
    }),
    name: "__Host-session",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        httpOnly: true,
        secure: true,        // обязательно в проде
        sameSite: "lax",     // OAuth работает
        maxAge: 1000 * 60 * 60 * 24
    }
}));

app.use((err, req, res, next) => {
    console.error("EXPRESS ERROR:", err);
    res.status(500).end();
});

process.on("uncaughtException", err => {
    console.error("UNCAUGHT EXCEPTION", err);
});

process.on("unhandledRejection", err => {
    console.error("UNHANDLED PROMISE", err);
});

app.use((req, res, next) => {
    if (req.sessionID) {
        console.log(
            "USER",
            req.ip,
            req.method,
            req.path,
            req.session.userId || "guest"
        );
    }
    next();
});

// function requireAuth(req, res, next) {
//     if (!req.session.userId) return res.sendStatus(401);
//         next();
// }

// app.use((req, res, next) => {
//     res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
//     res.setHeader("Pragma", "no-cache");
//     res.setHeader("Expires", "0");
//     next();
// });
// app.use(express.static(path.join(__dirname, "..", "html")));
// app.use(express.static(path.join(__dirname, "..", "jsForAuth")));
app.use(express.static(path.join(__dirname, "..", "html")));
app.use(express.static(path.join(__dirname, "..", "jsForAuth")));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "html", "mainPage.html"));
});

// Подключаем маршруты
authRoutes(app);
calcRoutes(app);
// registerFacebookRoutes(app);
registerGoogleRoutes(app);
app.use(contactRoutes);
// registerAppleRoutes(app);

// app.get("/__redis_test", (req, res) => {
//     if (!req.session.views) {
//         req.session.views = 1;
//     } else {
//         req.session.views++;
//     }

//     res.json({
//         sessionID: req.sessionID,
//         views: req.session.views
//     });
// });
const pages = [
    { url: "/mainPage.html", changefreq: "daily", priority: 1.0 },
    { url: "/AboutProject.html", changefreq: "monthly", priority: 0.8 },
    { url: "/contactUs.html", changefreq: "monthly", priority: 0.8 },
    { url: "/allCalculators.html", changefreq: "weekly", priority: 0.9 },
    { url: "/termsOfService.html", changefreq: "yearly", priority: 0.5 },
    { url: "/privacyPolicy.html", changefreq: "yearly", priority: 0.5 },
];

app.get("/sitemap.xml", (req, res) => {
    res.header("Content-Type", "application/xml");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
            .map(
                (page) => `
  <url>
    <loc>https://mypropertycost.com${page.url}</loc>
    <lastmod>${new Date().toISOString().split("T")[0]}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`
            )
            .join("")}
</urlset>`;

    res.send(xml);
});




app.get("/ads.txt", (req, res) => {
    res.type("text/plain");
    res.send("google.com, pub-4041439086297277, DIRECT, f08c47fec0942fa0");
});

app.get("/robots.txt", (req, res) => {
    res.type("text/plain");

    res.send(`# robots.txt for PropertyCost.com

User-agent: *
Disallow: /admin/
Disallow: /login/
Disallow: /register/
Disallow: /account/
Allow: /

Sitemap: https://mypropertycost.com/sitemap.xml
`);
});


//app.listen(3000, () => console.log("Server started on http://localhost:3000")); //для продакшена 
app.listen(PORT, HOST, () =>
    console.log(`Server on ${HOST}:${PORT}`)
);


