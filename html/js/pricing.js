function getCsrfApi() {
    return window.__csrf || null;
}

async function ensureCsrfToken(force = false) {
    const api = getCsrfApi();
    if (api?.ensure) return api.ensure(force);
    return "";
}

function withCsrfHeaders(headers) {
    const api = getCsrfApi();
    if (api?.withHeaders) return api.withHeaders(headers);
    return { ...(headers || {}) };
}

async function csrfFetch(url, init = {}, retryOnCsrf = true) {
    const api = getCsrfApi();
    if (api?.fetch) return api.fetch(url, init, retryOnCsrf);
    return fetch(url, { credentials: "include", ...(init || {}) });
}

async function buyPack(packKey, btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Redirecting to checkout…";

    try {
        await ensureCsrfToken();
        const providers = [
            "/api/nowpayments/create-checkout",
            "/api/paddle/create-checkout"
        ];
        let lastErr = null;

        for (const endpoint of providers) {
            const r = await csrfFetch(endpoint, {
                method: "POST",
                headers: withCsrfHeaders({ "Content-Type": "application/json" }),
                credentials: "include",
                body: JSON.stringify({ pack: packKey })
            });

            if (r.status === 401) {
                window.location.href = "/login/";
                return;
            }

            const order = await r.json().catch(() => ({}));
            const checkoutUrl = String(order?.checkoutUrl || "");
            if (r.ok && checkoutUrl) {
                window.location.href = checkoutUrl;
                return;
            }

            lastErr = { endpoint, status: r.status, order };
        }

        console.error("create-checkout failed", lastErr);
        throw new Error(lastErr?.order?.error || "CREATE_CHECKOUT_FAILED");
    } catch (e) {
        console.error(e);
        btn.disabled = false;
        btn.textContent = original;
        showPricingError(btn, "Failed to create checkout. Please try again.");
    }
}

function showPricingError(btn, message) {
    const host = btn?.parentElement || btn;
    if (!host) return;
    const prev = host.querySelector(".pricing-inline-error");
    if (prev) prev.remove();

    const box = document.createElement("div");
    box.className = "pricing-inline-error";
    box.textContent = String(message || "Something went wrong.");
    host.appendChild(box);
}

document.querySelectorAll("button[data-pack]").forEach(btn => {
    btn.addEventListener("click", () => buyPack(btn.dataset.pack, btn));
});

document.addEventListener("DOMContentLoaded", () => { ensureCsrfToken(); }, { once: true });
