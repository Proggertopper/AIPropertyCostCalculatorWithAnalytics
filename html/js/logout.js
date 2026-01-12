(async function () {
    const userControls = document.getElementById("userControls");

    function setGuest() {
        userControls.classList.remove("auth--user");
        userControls.classList.add("auth--guest");
    }

    function setUser() {
        userControls.classList.remove("auth--guest");
        userControls.classList.add("auth--user");
    }

    try {
        const res = await fetch("/api/auth/me", { credentials: "include" });

        if (!res.ok) {
            setGuest();
        } else {
            const data = await res.json();
            if (data?.email) {
                setUser();
            } else {
                setGuest();
            }
        }

    } catch (e) {
        setGuest();
    } finally {
        document.body.classList.remove("auth-loading");
    }
})();

const dropdown = document.getElementById("userDropdown");

dropdown.addEventListener("click", e => {
    e.stopPropagation();
    dropdown.classList.toggle("open");
});

document.addEventListener("click", () => {
    dropdown.classList.remove("open");
});


const logoutBtn = document.getElementById("btn-logout");

if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {

        const csrfRes = await fetch("/api/csrf", { credentials: "include" });
        const csrfData = await csrfRes.json();

        await fetch("/api/auth/logout", {
            method: "POST",
            credentials: "include",
            headers: {
                "X-CSRF-Token": csrfData.csrfToken
            }
        });

        location.reload();
    });
}
