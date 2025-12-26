async function checkUser() {
            const res = await fetch("/api/auth/me", { credentials: "include" });
            const data = await res.json();

            if (data.loggedIn) {
                // скрываем кнопки Login/Register
                document.getElementById("btn-login").style.display = "none";
                document.getElementById("btn-signin").style.display = "none";

                // показываем кнопку Logout
                document.getElementById("logoutBtn").style.display = "inline-block";
                document.getElementById("userEmail").innerText = data.email;
            } else {
                document.getElementById("logoutBtn").style.display = "none";
            }
        }

        checkUser();

        document.getElementById("logoutBtn").addEventListener("click", async () => {
                await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
                window.location.href = "/login.html";
            });