
async function checkUser() {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    const data = await res.json();

    const loginBtn = document.getElementById("btn-login");
    const registerBtn = document.getElementById("btn-signin");
    const logoutBtn = document.getElementById("logoutBtn");
    const userEmailElem = document.getElementById("userEmail");

    if (data.loggedIn) {
        loginBtn.style.display = "none";
        registerBtn.style.display = "none";
        logoutBtn.style.display = "inline-block";
        userEmailElem.innerText = data.email;
    } else {
        loginBtn.style.display = "inline-block";
        registerBtn.style.display = "inline-block";
        logoutBtn.style.display = "none";
        userEmailElem.innerText = "";
    }
}

// Проверяем статус пользователя при загрузке
checkUser();

document.getElementById("logoutBtn").addEventListener("click", async () => {
    // Получаем CSRF-токен
    const csrfRes = await fetch("/api/csrf", { credentials: "include" });
    const csrfData = await csrfRes.json();
    
    // Отправляем logout с CSRF-токеном
    await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: {
            "X-CSRF-Token": csrfData.csrfToken
        }
    });

    // Обновляем отображение кнопок
    checkUser();
});
