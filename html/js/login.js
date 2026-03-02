const form = document.getElementById("loginForm");
const errorBox = document.getElementById("error");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const PASSWORD_MIN_LENGTH = 8;
const EMAIL_MAX_LENGTH = 254;

let csrfToken = "";

function showError(message) {
    errorBox.innerText = message;
    errorBox.style.display = "block";
    errorBox.classList.remove("hidden");
}

function hideError() {
    errorBox.innerText = "";
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

form.addEventListener("submit", async e => {
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
        const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
            credentials: "include",
            body: JSON.stringify({ email, password })
        });

        const data = await res.json().catch(() => ({}));

        if (res.ok) {
            window.location.href = "/";
            return;
        }

        if (data.error === "invalid_data") {
            showError("Enter a valid email and password (min 8 characters).");
            return;
        }
        if (data.error === "invalid_credentials") {
            showError("Invalid email or password.");
            return;
        }

        showError("Failed to log in. Check your input.");
    } catch (err) {
        console.error(err);
        showError("Server error. Please try again later.");
    }
});

const googleLogin = document.getElementById("googleLogin");
if (googleLogin) {
    googleLogin.addEventListener("click", () => {
        window.location.href = "/auth/api/google";
    });
}

const params = new URLSearchParams(window.location.search);
const error = params.get("error");

const messages = {
    oauth_state_invalid: "Problem with state (CSRF).",
    oauth_no_code: "Google did not return the code.",
    google_unavailable: "Google is not responding.",
    facebook_unavailable: "OAuth provider is not responding.",
    token_exchange_failed: "OAuth provider did not issue an access token.",
    profile_fetch_failed: "Failed to get profile data.",
    no_email: "OAuth provider did not return email.",
    internal_error: "Internal error (DB/session)."
};

if (error && messages[error]) {
    showError(messages[error]);
}
