const form = document.getElementById("contactForm");
const errorBox = document.getElementById("error");
const successBox=document.getElementById("success");

    form.addEventListener("submit", async (e) => {
        e.preventDefault();

        const data = {
            name: form.name.value,
            email: form.email.value,
            message: form.message.value,
        };

        const res = await fetch("/api/contact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(data)
        });

        const json = await res.json();

        if (json.success) {
            successBox.innerText="Message sent!";
            successBox.classList.remove("hidden");
            form.reset();
        } else {
            errorBox.innerText= json.error || "Error";
            errorBox.classList.remove("hidden");
        }
    });