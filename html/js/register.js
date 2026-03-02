const form = document.getElementById("registerForm");
const errorBox = document.getElementById("error");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const PASSWORD_MIN_LENGTH = 8;
const EMAIL_MAX_LENGTH = 254;

let csrfToken = "";

function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = "block";
    errorBox.classList.remove("hidden");
}

function hideError() {
    errorBox.textContent = "";
    errorBox.style.display = "none";
    errorBox.classList.add("hidden");
}

function validateCredentials(email, password) {
    if (!email || email.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(email)) {
        return "Enter a valid email address.";
    }
    if (!password || password.length < PASSWORD_MIN_LENGTH) {
        return "Password must be at least 8 characters.";
    }
    return "";
}

window.addEventListener("DOMContentLoaded", async () => {
    try {
        const res = await fetch("/api/csrf", { credentials: "include" });
        const data = await res.json();
        csrfToken = data.csrfToken || "";
    } catch (err) {
        console.error("CSRF fetch failed:", err);
        showError("Cannot initialize session. Refresh the page and try again.");
    }
});

const params = new URLSearchParams(window.location.search);
const error = params.get("error");

const errorMessages = {
    email_exists: "User with this email already exists.",
    weak_password: "Password must be at least 8 characters.",
    invalid_email: "Invalid email address.",
    invalid_data: "Enter a valid email and password (min 8 characters).",
    internal_error: "Server error. Try again later.",
    registration_failed: "Registration failed. Please check your input."
};

if (error && errorMessages[error]) {
    showError(errorMessages[error]);
}

form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    const validationError = validateCredentials(email, password);
    if (validationError) {
        showError(validationError);
        return;
    }

    if (!csrfToken) {
        showError("Session expired. Refresh the page and try again.");
        return;
    }

    try {
        const res = await fetch("/api/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
            credentials: "include",
            body: JSON.stringify({ email, password })
        });

        if (res.ok) {
            window.location.href = "/login/";
            return;
        }

        const data = await res.json().catch(() => ({}));

        if (data.error && errorMessages[data.error]) {
            showError(errorMessages[data.error]);
        } else {
            showError(errorMessages.internal_error);
        }
    } catch (err) {
        showError(errorMessages.internal_error);
    }
});

const googleLogin = document.getElementById("googleLogin");
if (googleLogin) {
    googleLogin.addEventListener("click", () => {
        window.location.href = "/auth/api/google";
    });
}
