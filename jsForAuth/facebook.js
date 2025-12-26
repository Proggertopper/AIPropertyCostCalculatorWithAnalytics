require("dotenv").config();


function registerFacebookRoutes(app){
app.get("/auth/api/facebook", (req, res) => {
    const clientId = process.env.FB_CLIENT_ID;
    const redirectUri = "http://localhost:3000/auth/api/facebook/callback";
    const fbAuthUrl = `https://www.facebook.com/v15.0/dialog/oauth?client_id=${clientId}&redirect_uri=${redirectUri}&scope=email`;
    res.redirect(fbAuthUrl);
});


app.get("/auth/api/facebook/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect("/login.html");

  // Обмен code на access_token
    const tokenRes = await fetch(
    `https://graph.facebook.com/v15.0/oauth/access_token?client_id=${process.env.FB_CLIENT_ID}&redirect_uri=http://localhost:3000/auth/api/facebook/callback&client_secret=${process.env.FB_CLIENT_SECRET}&code=${code}`
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

  // Получаем профиль пользователя
    const profileRes = await fetch(`https://graph.facebook.com/me?fields=id,email&access_token=${accessToken}`);
    const profile = await profileRes.json();

  // Сохраняем в сессию
    req.session.userId = profile.id;
    req.session.email = profile.email;

  // Редирект
    res.redirect("/mainPage.html");
});
}

module.exports=registerFacebookRoutes