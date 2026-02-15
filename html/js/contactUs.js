const form = document.getElementById("contactForm");
const errorBox = document.getElementById("error");
const successBox = document.getElementById("success");
const submitBtn = document.getElementById("contactSubmit");
let csrfToken = "";
let csrfTokenPromise = null;

async function ensureCsrfToken() {
    if (csrfToken) return csrfToken;
    if (!csrfTokenPromise) {
        csrfTokenPromise = fetch("/api/csrf", { credentials: "include" })
            .then((r) => (r.ok ? r.json() : {}))
            .then((j) => {
                csrfToken = String(j?.csrfToken || "");
                return csrfToken;
            })
            .catch(() => "")
            .finally(() => {
                csrfTokenPromise = null;
            });
    }
    return csrfTokenPromise;
}

if (form && errorBox && successBox) {
    ensureCsrfToken();
    form.addEventListener("submit", async (e) => {
        e.preventDefault();

        errorBox.classList.add("hidden");
        successBox.classList.add("hidden");
        errorBox.textContent = "";
        successBox.textContent = "";

        const data = {
            name: form.name.value.trim(),
            email: form.email.value.trim(),
            message: form.message.value.trim(),
        };

        if (!data.name || !data.email || !data.message) {
            errorBox.textContent = "Please fill in all required fields.";
            errorBox.classList.remove("hidden");
            return;
        }

        try {
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = "Sending...";
            }

            await ensureCsrfToken();
            const res = await fetch("/api/contact", {
                method: "POST",
                headers: csrfToken
                    ? { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }
                    : { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(data),
            });

            const json = await res.json();

            if (res.ok && json.success) {
                successBox.textContent = "Message sent. We will get back to you soon.";
                successBox.classList.remove("hidden");
                form.reset();
            } else {
                errorBox.textContent = json.error || "Unable to send message right now.";
                errorBox.classList.remove("hidden");
            }
        } catch (err) {
            errorBox.textContent = "Network error. Please try again.";
            errorBox.classList.remove("hidden");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = "Send Message";
            }
        }
    });
}
