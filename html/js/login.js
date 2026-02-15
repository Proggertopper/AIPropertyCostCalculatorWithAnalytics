const form = document.getElementById("loginForm");
const errorBox= document.getElementById("error");


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
            credentials: "include" ,
            body: JSON.stringify({ email, password })
            
        });

        const data = await res.json();

        if (res.ok) {
            window.location.href = "/";
        } else {
            errorBox.innerText = data.error || "Failed to log in. Check your input."
            errorBox.classList.remove("hidden")
        }
    } catch (err) {
        console.error(err);
        errorBox.innerText = "Server error.Please try again later.";
        errorBox.classList.remove("hidden");
    }
});

        // Кнопка Google OAuth
        document.getElementById("googleLogin").addEventListener("click", () => {
            window.location.href = "/auth/api/google";
        });
        // document.getElementById("facebookLogin").addEventListener("click", () => {
        //     window.location.href = "/auth/api/facebook";
        // });
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
    errorBox.classList.remove("hidden");
}