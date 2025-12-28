const form = document.getElementById("loginForm");
let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
    const res = await fetch("/api/csrf" , {credentials:"include"});
    const data = await res.json();
    csrfToken = data.csrfToken;
});
form.addEventListener("submit", async e => {
    e.preventDefault();
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;

    try {
        const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" , "x-csrf-token": csrfToken },
            body: JSON.stringify({ email, password }),
            credentials: "include"
        });

        const data = await res.json();

        if (res.ok) {
            window.location.href = "/mainPage.html";
        } else {
            alert(data.error || "Ошибка входа");
        }
    } catch (err) {
        console.error(err);
        alert("Ошибка сервера");
    }
});

        // Кнопка Google OAuth
        document.getElementById("googleLogin").addEventListener("click", () => {
            window.location.href = "/auth/api/google";
        });
        document.getElementById("facebookLogin").addEventListener("click", () => {
            window.location.href = "/auth/api/facebook";
        });
        // // для епл входа
        // document.getElementById("appleLogin").addEventListener("click" , ()=> {
        //     window.location.href="/auth/api/apple";
        // } );


        const params = new URLSearchParams(window.location.search);
        const error = params.get("error");

const messages = {
    oauth_state_invalid :  "problem with state(CSRF)",
    oauth_no_code        : "Facebook didn't return the code" ,
    facebook_unavailable  : "Facebook is not responding / network" ,
    token_exchange_failed : "Facebook did not issue an access token." ,
    profile_fetch_failed  : "failed to get profile" ,
    no_email              : "Facebook did not return email",
    internal_error        : "our error (DB / session)"
};

if (error && messages[error]) {
    const errorBox = document.getElementById("error");
    errorBox.innerText = messages[error];
    errorBox.style.display = "block";
}