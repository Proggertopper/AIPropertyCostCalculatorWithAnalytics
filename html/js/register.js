const form = document.getElementById("registerForm");
const errorBox = document.getElementById("error");

//  показать ошибку
function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = "block";
}

let csrfToken;
window.addEventListener("DOMContentLoaded", async () => {
    const res = await fetch("/api/csrf" , {credentials:"include"});
    const data = await res.json();
    csrfToken = data.csrfToken;
});

//  обработка ошибок из URL (?error=...)
const params = new URLSearchParams(window.location.search);
const error = params.get("error");

const errorMessages = {
    email_exists: "User with this email already exists",
    weak_password: "Password must be at least 8 characters",
    invalid_email: "Invalid email address",
    internal_error: "Server error. Try again later",
    registration_failed : "Registration failed. Please check your input."
};

if (error && errorMessages[error]) {
    showError(errorMessages[error]);
}

// 👉 submit формы
form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.style.display = "none";

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    try {
        const res = await fetch("/api/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" , "x-csrf-token": csrfToken },
            credentials: "include",
            body: JSON.stringify({ email, password })
        });

        if (res.ok) {
            window.location.href = "/login/";
            return;
        }

        //  сервер возвращает JSON с кодом ошибки
        const data = await res.json();

        if (data.error && errorMessages[data.error]) {
            showError(errorMessages[data.error]);
        } else {
            showError(errorMessages.internal_error);
        }

    } catch (err) {
        showError(errorMessages.internal_error);
    }
});

    // Кнопка Google OAuth
        document.getElementById("googleLogin").addEventListener("click", () => {
            window.location.href = "/auth/api/google";
        });
        // document.getElementById("facebookLogin").addEventListener("click", () => {
        //     window.location.href = "/auth/api/facebook";
        // });
        //  для епл входа
        // document.getElementById("appleLogin").addEventListener("click" , ()=> {
        //     window.location.href="/auth/api/apple";
        // } );