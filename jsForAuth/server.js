require("dotenv").config();
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const authRoutes = require("./auth");
const calcRoutes = require("./calculator");
const path = require("path");
require("./google");

const app = express();
app.use(express.json());



app.use(session({
    secret: "SUPER_SECRET",
    resave: false,
    saveUninitialized: false,
    cookie: {
    httpOnly: true,
    secure: false // true в https
    }
}));

app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname,".." ,"html")));

// Подключаем маршруты
authRoutes(app);
calcRoutes(app);


app.get("/auth/google",
    passport.authenticate("google", { scope: ["email", "profile"] })
);

app.get("/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/login.html" }),
    (req, res) => res.redirect("/mainPage.html") // редирект после успеха
);

app.listen(3000, () => console.log("Server started on http://localhost:3000"));

