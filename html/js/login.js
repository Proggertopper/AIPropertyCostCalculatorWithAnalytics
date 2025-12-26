const form = document.getElementById("loginForm");
        form.addEventListener("submit", async e => {
            e.preventDefault();
            const email = document.getElementById("email").value;
            const password = document.getElementById("password").value;

            const res = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",       // важно для сессии
                body: JSON.stringify({ email, password })
            });

            if (res.ok) {
                window.location.href = "/mainPage.html"; // редирект после успешного логина
            } else {
                alert("Неверный логин или пароль");
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