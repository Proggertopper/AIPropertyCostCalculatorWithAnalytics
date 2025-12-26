const form = document.getElementById("registerForm");
        form.addEventListener("submit", async e => {
            e.preventDefault();
            const email = document.getElementById("email").value;
            const password = document.getElementById("password").value;

            const res = await fetch("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password })
            });

            if (res.ok) {
                alert("Регистрация прошла успешно!");
                window.location.href = "/login.html";
            } else {
                alert("Ошибка регистрации");
            }
        });

    // Кнопка Google OAuth
        document.getElementById("googleLogin").addEventListener("click", () => {
            window.location.href = "/auth/api/google";
        });
        document.getElementById("facebookLogin").addEventListener("click", () => {
            window.location.href = "/auth/api/facebook";
        });
        //  для епл входа
        // document.getElementById("appleLogin").addEventListener("click" , ()=> {
        //     window.location.href="/auth/api/apple";
        // } );