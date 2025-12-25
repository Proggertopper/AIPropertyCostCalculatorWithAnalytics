const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const db = require("./db");


passport.use(new GoogleStrategy({
    clientID: "GOOGLE_CLIENT_ID",
    clientSecret: "GOOGLE_SECRET",
    callbackURL: "/auth/google/callback"
}, async (_, __, profile, done) => {

    let user = await db.query(
    "SELECT * FROM users WHERE google_id=$1",
    [profile.id]
    );

    if (!user.rows[0]) {
    user = await db.query(
      "INSERT INTO users (google_id, email) VALUES ($1,$2) RETURNING *",
        [profile.id, profile.emails[0].value]
    );
    }

    done(null, user.rows[0]);
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const user = await db.query("SELECT * FROM users WHERE id=$1", [id]);
    done(null, user.rows[0]);
});

