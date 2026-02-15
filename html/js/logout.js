var csrfToken = "";

(function initCsrfApi() {
    let csrfTokenPromise = null;
    const nativeFetch = window.fetch.bind(window);
    window.csrfToken = csrfToken;

    function resolveUrl(input) {
        if (typeof input === "string") return input;
        if (input && typeof input.url === "string") return input.url;
        return "";
    }

    function isStateChangingApi(input, method) {
        const m = String(method || "GET").toUpperCase();
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(m)) return false;

        const raw = resolveUrl(input);
        if (!raw) return false;

        let u;
        try {
            u = new URL(raw, window.location.origin);
        } catch {
            return false;
        }
        if (u.origin !== window.location.origin) return false;
        if (!u.pathname.startsWith("/api/")) return false;
        if (u.pathname === "/api/webhooks/paypal") return false;
        return true;
    }

    async function ensure(force = false) {
        if (force) {
            csrfToken = "";
            csrfTokenPromise = null;
            window.csrfToken = "";
        }
        if (csrfToken) return csrfToken;
        if (!csrfTokenPromise) {
            csrfTokenPromise = nativeFetch("/api/csrf", { credentials: "include" })
                .then((r) => (r.ok ? r.json() : {}))
                .then((j) => {
                    csrfToken = String(j?.csrfToken || "");
                    window.csrfToken = csrfToken;
                    return csrfToken;
                })
                .catch(() => {
                    csrfToken = "";
                    window.csrfToken = "";
                    return "";
                })
                .finally(() => {
                    csrfTokenPromise = null;
                });
        }
        return csrfTokenPromise;
    }

    function withHeaders(headers) {
        const out = { ...(headers || {}) };
        if (csrfToken) out["X-CSRF-Token"] = csrfToken;
        return out;
    }

    async function csrfFetch(url, init = {}, retryOnCsrf = true) {
        const baseInit = { credentials: "include", ...(init || {}) };
        const method = String(baseInit.method || "GET").toUpperCase();

        if (!isStateChangingApi(url, method)) {
            return nativeFetch(url, baseInit);
        }

        const doFetch = async (forceRefresh = false) => {
            await ensure(forceRefresh);
            const headers = new Headers(baseInit.headers || {});
            if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
            return nativeFetch(url, {
                ...baseInit,
                headers
            });
        };

        let response = await doFetch(false);
        if (!retryOnCsrf || response.status !== 403) return response;

        const err = await response.clone().json().catch(() => ({}));
        if (err?.error !== "csrf") return response;

        response = await doFetch(true);
        return response;
    }

    window.__csrf = { ensure, withHeaders, fetch: csrfFetch };
    window.fetch = (input, init) => csrfFetch(input, init, true);
    window.addEventListener("DOMContentLoaded", () => { ensure(); }, { once: true });
})();
// єто для логаута
document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("btn-logout");
    if (!btn) return;

    btn.addEventListener("click", async (e) => {
        e.preventDefault();

        try {
            const csrfFetch = window.__csrf?.fetch
                ? window.__csrf.fetch
                : (url, init) => fetch(url, { credentials: "include", ...(init || {}) });

            const r = await csrfFetch("/api/auth/logout", {
                method: "POST",
                headers: { "Content-Type": "application/json" }
            });

            // даже если 204 — ок
            if (!r.ok && r.status !== 204) {
                const txt = await r.text().catch(() => "");
                console.error("Logout failed:", r.status, txt);
                return;
            }

            // после логаута — на главную/логин
            window.location.href = "/";
        } catch (err) {
            console.error("Logout error:", err);
        }
    });

    const dropdown = document.getElementById("userDropdown");
    const avatar = document.getElementById("userAccount");

    if (!dropdown || !avatar) return;

    function close() {
        dropdown.classList.remove("open");
    }

    avatar.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.toggle("open");
    });

    // клик снаружи — закрыть
    document.addEventListener("click", close);

    // Esc — закрыть
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
    });

    // клики внутри меню не должны закрывать раньше времени
    dropdown.querySelector(".dropdown-menu")?.addEventListener("click", (e) => {
        e.stopPropagation();
    });

});
// для блога проверки откуда тип пришел 
(function () {
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    const backToBlog = document.getElementById("backToBlog");

    if (!backToBlog) return;

    if (from === "blog") {
        backToBlog.hidden = false;
    }
})();

// article UX helpers: keep mobile TOC complete and ensure calculator CTA exists
document.addEventListener("DOMContentLoaded", () => {
    const seoPage = document.querySelector("main.seo-page");
    if (!seoPage) return;

    const desktopTocLinks = Array.from(
        seoPage.querySelectorAll(".seo-sidebar .toc ul a[href^='#']")
    );
    const mobileTocNav = seoPage.querySelector(".toc-mobile nav");

    if (desktopTocLinks.length && mobileTocNav) {
        const mobileTocLinks = Array.from(mobileTocNav.querySelectorAll("a[href^='#']"));
        const sameList =
            desktopTocLinks.length === mobileTocLinks.length &&
            desktopTocLinks.every((link, i) => link.getAttribute("href") === mobileTocLinks[i]?.getAttribute("href"));

        if (!sameList) {
            mobileTocNav.innerHTML = "";
            desktopTocLinks.forEach((link) => {
                const a = document.createElement("a");
                a.href = link.getAttribute("href") || "#";
                a.textContent = (link.textContent || "").trim();
                mobileTocNav.appendChild(a);
            });
        }
    }

    const tocLinks = Array.from(
        seoPage.querySelectorAll(".seo-sidebar .toc a[href^='#'], .toc-mobile nav a[href^='#']")
    );

    const sectionIds = Array.from(
        new Set(
            tocLinks
                .map((link) => (link.getAttribute("href") || "").slice(1))
                .filter(Boolean)
        )
    );

    const sections = sectionIds
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .sort((a, b) => a.offsetTop - b.offsetTop);

    const setActiveTocLink = (id) => {
        if (!id) return;
        tocLinks.forEach((link) => {
            const linkId = (link.getAttribute("href") || "").slice(1);
            link.classList.toggle("is-active", linkId === id);
        });
    };

    if (sections.length && tocLinks.length) {
        let rafPending = false;
        const updateActiveFromScroll = () => {
            rafPending = false;
            const markerY = window.scrollY + Math.min(window.innerHeight * 0.3, 260);
            let currentId = sections[0].id;
            for (const section of sections) {
                if (section.offsetTop <= markerY) currentId = section.id;
                else break;
            }
            setActiveTocLink(currentId);
        };

        const requestActiveUpdate = () => {
            if (rafPending) return;
            rafPending = true;
            window.requestAnimationFrame(updateActiveFromScroll);
        };

        window.addEventListener("scroll", requestActiveUpdate, { passive: true });
        window.addEventListener("resize", requestActiveUpdate);
        window.addEventListener("hashchange", requestActiveUpdate);

        tocLinks.forEach((link) => {
            link.addEventListener("click", () => {
                const id = (link.getAttribute("href") || "").slice(1);
                if (id) setActiveTocLink(id);
            });
        });

        requestActiveUpdate();
    }

    if (!seoPage.querySelector(".cta-calc")) {
        const pathParts = window.location.pathname.split("/").filter(Boolean);
        const hub = pathParts[0];
        if (!hub || pathParts.length < 2) return;

        const contentWrapper = seoPage.querySelector(".seo-content .content-wrapper");
        if (!contentWrapper) return;

        const anchorSection =
            contentWrapper.querySelector(".content-section#related") ||
            contentWrapper.querySelector(".content-section#faq");

        const ctaSection = document.createElement("div");
        ctaSection.className = "content-section";
        ctaSection.innerHTML = `
            <h2>Run This Scenario In The Calculator</h2>
            <div class="cta-calc">
                <div>
                    <h4>Want to verify this with your numbers?</h4>
                    <p>Open the calculator, run base vs conservative assumptions, and compare outcomes side by side.</p>
                </div>
                <a href="/${hub}/calculator/">Open calculator →</a>
            </div>
        `;

        if (anchorSection) {
            contentWrapper.insertBefore(ctaSection, anchorSection);
        } else {
            contentWrapper.appendChild(ctaSection);
        }
    }
});
