// require("dotenv").config();
// const jwt = require("jsonwebtoken");
// const axios = require("axios");
// const qs = require("qs");

// function createAppleClientSecret() {
//     return jwt.sign(
//     {
//         iss: process.env.APPLE_TEAM_ID,
//         aud: "https://appleid.apple.com",
//         sub: process.env.APPLE_CLIENT_ID
//     },
//     process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
//     {
//         algorithm: "ES256",
//         expiresIn: "180d",
//         keyid: process.env.APPLE_KEY_ID
//     }
//     );
// }

// function registerAppleRoutes(app) {
//     app.get("/auth/api/apple", (req, res) => {
//     const redirect = new URL("https://appleid.apple.com/auth/authorize");

//     redirect.searchParams.set("response_type", "code id_token");
//     redirect.searchParams.set("response_mode", "form_post");
//     redirect.searchParams.set("client_id", process.env.APPLE_CLIENT_ID);
//     redirect.searchParams.set("redirect_uri", process.env.APPLE_REDIRECT_URI);
//     redirect.searchParams.set("scope", "name email");

//     res.redirect(redirect.toString());
//     });

//     app.post("/auth/api/apple/callback", async (req, res) => {
//     try {
//         const clientSecret = createAppleClientSecret();

//         const tokenRes = await axios.post(
//         "https://appleid.apple.com/auth/token",
//         qs.stringify({
//             grant_type: "authorization_code",
//             code: req.body.code,
//             redirect_uri: process.env.APPLE_REDIRECT_URI,
//             client_id: process.env.APPLE_CLIENT_ID,
//             client_secret: clientSecret
//         }),
//         { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
//     );

//     const user = jwt.decode(tokenRes.data.id_token);

//         req.session.userId = user.sub;
//         req.session.email = user.email;

//         res.redirect("/mainPage.html");
//     } catch (err) {
//         console.error(err.response?.data || err);
//         res.status(500).send("Apple auth failed");
//     }
// });
// }

// module.exports = registerAppleRoutes;