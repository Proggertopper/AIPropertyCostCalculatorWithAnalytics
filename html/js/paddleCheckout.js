(async function paddleCheckoutPage() {
    const statusNode = document.getElementById("paddleStatus");
    const pricingBtn = document.getElementById("paddleBackToPricing");
    const accountBtn = document.getElementById("paddleBackToAccount");

    const setStatus = (text) => {
        if (statusNode) statusNode.textContent = String(text || "");
    };
    const showPricing = () => pricingBtn?.classList.remove("hidden");
    const showAccount = () => accountBtn?.classList.remove("hidden");

    const qs = new URLSearchParams(window.location.search);
    const txn = String(qs.get("_ptxn") || qs.get("txn") || "").trim();
    if (!txn) {
        setStatus("Checkout token is missing. Please start again from pricing.");
        showPricing();
        return;
    }

    async function fetchStatus() {
        const r = await fetch(`/api/paddle/transaction-status?txn=${encodeURIComponent(txn)}`, {
            credentials: "include"
        });
        const j = await r.json().catch(() => ({}));
        return { r, j };
    }

    async function pollStatusUntilPaid(maxTicks = 45, intervalMs = 1500) {
        for (let i = 0; i < maxTicks; i++) {
            const { r, j } = await fetchStatus();
            if (r.ok && String(j?.status || "").toLowerCase() === "paid") {
                window.location.href = `/account/?paddle_paid=1&txn=${encodeURIComponent(txn)}`;
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        return false;
    }

    let cfg = null;
    try {
        const r = await fetch("/api/paddle/config", { credentials: "include" });
        cfg = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(cfg?.error || "PADDLE_CONFIG_FAILED");
    } catch (e) {
        console.error(e);
        setStatus("Checkout is temporarily unavailable. Please try again later.");
        showPricing();
        return;
    }

    if (!window.Paddle || typeof window.Paddle.Initialize !== "function") {
        setStatus("Paddle SDK failed to load. Please refresh the page.");
        showPricing();
        return;
    }

    try {
        if (String(cfg?.env || "").toLowerCase() === "sandbox") {
            if (window.Paddle.Environment && typeof window.Paddle.Environment.set === "function") {
                window.Paddle.Environment.set("sandbox");
            }
        }

        window.Paddle.Initialize({
            token: String(cfg?.clientToken || ""),
            eventCallback: (evt) => {
                const name = String(evt?.name || "");
                if (name === "checkout.completed") {
                    const doneTxn = String(evt?.data?.transaction_id || txn);
                    window.location.href = `/account/?paddle_paid=1&txn=${encodeURIComponent(doneTxn)}`;
                }
            }
        });

        if (window.Paddle.Checkout && typeof window.Paddle.Checkout.open === "function") {
            window.Paddle.Checkout.open({ transactionId: txn });
        }
    } catch (e) {
        console.error(e);
        setStatus("Unable to open checkout window. Please try again.");
        showPricing();
        return;
    }

    setStatus("Checkout opened. Complete payment and you will be redirected automatically.");
    const paid = await pollStatusUntilPaid();
    if (!paid) {
        setStatus("Payment is still pending. If you already paid, open account and check your credits.");
        showAccount();
    }
})();
