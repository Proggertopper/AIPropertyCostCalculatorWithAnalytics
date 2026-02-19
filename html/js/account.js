(function () {
    try {
        var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
        if (!tz) return;

        var m = document.cookie.match(/(?:^|; )tz=([^;]+)/);
        var cur = m ? decodeURIComponent(m[1]) : "";

        if (cur !== tz) {
            document.cookie =
                "tz=" + encodeURIComponent(tz) +
                "; Path=/; Max-Age=31536000; SameSite=Lax" +
                (location.protocol === "https:" ? "; Secure" : "");
        }
    } catch (e) { }
})();

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

document.addEventListener("DOMContentLoaded", () => { ensureCsrfToken(); }, { once: true });

(function init() {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
        return;
    }

    const boot = window.__BOOT__ || {};
    const list = boot.account?.calculations || [];

    applyWalletToAiButtons(boot.account?.wallet);

    const root = document.getElementById("calculations");
    if (!root) return;
    mountDealDeskTools();
    syncSparseCalculationsState(root);

    root.addEventListener("click", async (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;

        const row = btn.closest(".calc-item");
        if (!row) return;

        const id = Number(row.dataset.id);
        const action = btn.dataset.action;

        if (action === "delete") {
            showDeleteModal(id, row);
            return;
        }

        if (action === "ai") {
            const details = row.querySelector(".ai-details");
            if (!details) return;

            const isOpen = !details.classList.contains("hidden");
            if (isOpen) {
                closeAiPanel(row);
                return;
            }

            details.classList.remove("hidden");
            closeOpenedCalculationPanel();
            syncAiButtonState(btn);

            if (details.dataset.loaded === "1") {
                return;
            }
            clearNode(details);
            details.appendChild(el("div", "verdict info", "Thinking hard… please wait"));
            
            const payloadForServer = { calculationId: id };
            

            try {
                const r = await csrfFetch("/api/verdict", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payloadForServer)
                });

                let j = await r.json().catch(() => ({}));

                if (!r.ok && r.status !== 202) {
                    if (j?.error === "NO_CREDITS") {
                        renderAiNoCredits(details);
                        return;
                    }
                    renderAiError(details, j?.message || j?.error || "Request failed.");
                    return;
                }

                if (r.status === 202) {
                    const waitNode = details.querySelector(".verdict.info");
                    if (waitNode) waitNode.textContent = "Full analysis queued… waiting in line.";
                    j = await resolveQueuedAiResult(r, j, {
                        missingJobError: "VERDICT_JOB_ID_MISSING",
                        onTick: (status) => {
                            if (!waitNode) return;
                            if (status === "queued") waitNode.textContent = "Full analysis queued… waiting in line.";
                            else if (status === "processing") waitNode.textContent = "Full analysis processing… almost done.";
                        }
                    });
                }

                renderAiResult(details, j.mode, j.verdict , id);
                details.dataset.loaded = "1";
            

                if (j.wallet) {
                    // обновляем глобальный boot (чтобы дальше было консистентно)
                    window.__BOOT__ = window.__BOOT__ || {};
                    window.__BOOT__.account = window.__BOOT__.account || {};
                    window.__BOOT__.account.wallet = j.wallet;

                    applyWalletToAiButtons(j.wallet);
                }
            } catch (e) {
                renderAiError(details, "Network error.");
            }

            return;
        }

        if (action === "regen") {
            const details = row.querySelector(".ai-details");
            if (!details) return;

            details.classList.remove("hidden");
            closeOpenedCalculationPanel();
            
            const wallet = (window.__BOOT__ || {}).account?.wallet;
            const freeUsed = !!wallet?.free_used;
            const credits = Number(wallet?.credits || 0);

            if (freeUsed && credits <= 0) {
                // Keep already loaded analysis visible; only block paid regeneration.
                details.querySelectorAll(".regen-no-credit-hint").forEach((n) => n.remove());
                removeCreditsOffer(details);

                const hadLoadedAnalysis =
                    details.dataset.loaded === "1" ||
                    !!details.querySelector(".ai-output");

                if (hadLoadedAnalysis) {
                    const hint = el(
                        "div",
                        "verdict warn regen-no-credit-hint",
                        "⚠️ Not enough credits to regenerate. Saved analysis remains visible."
                    );
                    details.prepend(hint);
                    renderCreditsOffer(details, {
                        message: "⚠️ You have no credits to regenerate Full analysis."
                    });
                } else {
                    renderAiNoCredits(details);
                }
                return;
            }

            details.dataset.loaded = "0";
            clearNode(details);
            details.appendChild(el("div", "verdict info", "Rethinking… please wait"));

            const payloadForServer = {
                calculationId: id
            };

            try {
                const r = await csrfFetch("/api/verdict", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ...payloadForServer, force: true })
                });

                let j = await r.json().catch(() => ({}));

                if (!r.ok && r.status !== 202) {
                    if (j?.error === "NO_CREDITS") {
                        renderAiNoCredits(details);
                        return;
                    }
                    renderAiError(details, j?.message || j?.error || "Request failed.");
                    return;
                }

                if (r.status === 202) {
                    const waitNode = details.querySelector(".verdict.info");
                    if (waitNode) waitNode.textContent = "Regeneration queued… waiting in line.";
                    j = await resolveQueuedAiResult(r, j, {
                        missingJobError: "VERDICT_JOB_ID_MISSING",
                        onTick: (status) => {
                            if (!waitNode) return;
                            if (status === "queued") waitNode.textContent = "Regeneration queued… waiting in line.";
                            else if (status === "processing") waitNode.textContent = "Regeneration processing… almost done.";
                        }
                    });
                }

                renderAiResult(details, j.mode, j.verdict , id);
                details.dataset.loaded = "1";
                

                if (j.wallet) {
                    window.__BOOT__ = window.__BOOT__ || {};
                    window.__BOOT__.account = window.__BOOT__.account || {};
                    window.__BOOT__.account.wallet = j.wallet;

                    applyWalletToAiButtons(j.wallet);
                }
            } catch (e) {
                renderAiError(details, "Network error.");
            }

            return;
        }

        if (action === "open") {
            const details = row.querySelector(".calc-details");
           
            if (!details) return;

            // ищем calc из boot (без перерисовки списка)
            const calc = list.find(x => Number(x.id) === id);
            if (!calc) return;

            closeAiPanel(row);

            openCalculation(calc, details, btn);
            
            
            return;
        }

        if (action === "run_scenarios") {
            const count = Number(btn.dataset.count || 3);
            const pack = String(btn.dataset.pack || "quick");
            await runScenariosFlow(row, id, count, list, pack);
            return;
        }
    });
})();


(async function handlePaymentReturn() {
    const qs = new URLSearchParams(location.search);
    const txn = String(qs.get("txn") || "").trim();
    const paddlePaid = qs.get("paddle_paid");
    const nowPaid = qs.get("np_paid");
    const providerHint = String(
        qs.get("provider") || (nowPaid ? "nowpayments" : (paddlePaid ? "paddle" : ""))
    ).trim().toLowerCase();

    if (!txn || (!paddlePaid && !nowPaid)) return;

    const endpoints =
        providerHint === "paddle"
            ? ["/api/paddle/transaction-status"]
            : providerHint === "nowpayments"
                ? ["/api/nowpayments/transaction-status"]
                : ["/api/nowpayments/transaction-status", "/api/paddle/transaction-status"];

    async function checkWithEndpoint(endpoint) {
        const r = await fetch(`${endpoint}?txn=${encodeURIComponent(txn)}`, {
            credentials: "include"
        });
        const j = await r.json().catch(() => ({}));
        if (j?.wallet) {
            window.__BOOT__ = window.__BOOT__ || {};
            window.__BOOT__.account = window.__BOOT__.account || {};
            window.__BOOT__.account.wallet = j.wallet;
            applyWalletToAiButtons(j.wallet);
        }
        return { r, j };
    }

    async function checkOnce() {
        let last = { r: { ok: false }, j: {} };
        for (const endpoint of endpoints) {
            const out = await checkWithEndpoint(endpoint);
            last = out;
            if (out?.r?.ok) return out;
        }
        return last;
    }

    try {
        for (let i = 0; i < 20; i++) {
            const { r, j } = await checkOnce();
            if (r.ok && String(j?.status || "").toLowerCase() === "paid") break;
            if (i < 19) await waitMs(1200);
        }

        history.replaceState({}, "", "/account/");
    } catch (e) {
        console.error(e);
    }
})();


function getMiniVerdictTextForCalc(calc) {
    try {
        // создаём DOM-элемент как в openCalculation()
        const v = renderVerdict(calc);
        const text = (v?.textContent || "").trim();
        let level = "info";
        if (v.classList.contains("bad") || v.classList.contains("negative")) level = "bad";
        else if (v.classList.contains("warn")) level = "warn";
        else if (v.classList.contains("good") || v.classList.contains("positive")) level = "good";
        return { level, text };
    } catch (e) {
        return { level: "info", text: "ℹ️ Mini verdict not available." };
    }
}
function iconForLevel(level) {
    if (level === "good") return "✅";
    if (level === "warn") return "⚠️";
    if (level === "bad") return "❌";
    return "ℹ️";
}

function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollAiJobUntilDone(jobId, options = {}) {
    const id = String(jobId || "").trim();
    if (!id) throw new Error("Missing AI job id");

    const intervalMs = Math.max(700, Number(options.intervalMs || 900));
    const timeoutMs = Math.max(15000, Number(options.timeoutMs || 240000));
    const startedAt = Date.now();
    const onTick = typeof options.onTick === "function" ? options.onTick : null;

    while (Date.now() - startedAt < timeoutMs) {
        const r = await fetch(`/api/ai/jobs/${encodeURIComponent(id)}`, {
            credentials: "include"
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
            throw new Error(j?.message || j?.error || `Job poll failed (${r.status})`);
        }

        const status = String(j?.status || "").toLowerCase();
        if (onTick) onTick(status, j);

        if (status === "done") return j?.result || {};
        if (status === "failed") throw new Error(String(j?.error || "AI job failed"));

        await waitMs(intervalMs);
    }

    throw new Error("AI job timeout. Please try again.");
}

async function resolveQueuedAiResult(response, body, options = {}) {
    if (Number(response?.status) !== 202) return body;

    const id = String(body?.jobId || "").trim();
    if (!id) {
        throw new Error(String(options.missingJobError || "AI_JOB_ID_MISSING"));
    }

    return pollAiJobUntilDone(id, {
        intervalMs: Number(options.intervalMs || 900),
        timeoutMs: Number(options.timeoutMs || 240000),
        onTick: typeof options.onTick === "function" ? options.onTick : undefined
    });
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function syncSparseCalculationsState(box) {
    if (!box) return;

    box.querySelectorAll(".calc-sparse-hint").forEach((node) => node.remove());

    const count = box.querySelectorAll(".calc-item").length;
    box.classList.toggle("is-sparse", count === 1);

    if (count === 1) {
        const hint = el(
            "div",
            "calc-sparse-hint",
            "You currently have one saved deal. Add one more to compare options faster and strengthen portfolio insights."
        );
        box.appendChild(hint);
    }
}

function getAiDefaultButtonText(wallet) {
    const freeUsed = !!wallet?.free_used;
    return freeUsed ? "✨Full Analysis" : "✨Full Analysis (Free)";
}

function syncAiButtonState(btn, wallet = (window.__BOOT__ || {}).account?.wallet) {
    if (!btn) return;

    const freeUsed = !!wallet?.free_used;
    const credits = Number(wallet?.credits || 0);
    const noCredits = freeUsed && credits <= 0;

    const row = btn.closest(".calc-item");
    const aiBox = row?.querySelector(".ai-details");
    const aiOpen = !!aiBox && !aiBox.classList.contains("hidden");

    btn.disabled = false;
    btn.dataset.noCredits = noCredits ? "1" : "0";
    btn.classList.toggle("is-no-credits", noCredits);

    if (aiOpen) {
        btn.textContent = "✖ Close Analysis";
        btn.title = "Close Full Analysis";
        return;
    }

    btn.textContent = getAiDefaultButtonText(wallet);
    btn.title = noCredits ? "No credits left — click to buy" : "";
}

function closeOpenedCalculationPanel() {
    if (!openedDetails) return;
    openedDetails.classList.add("hidden");
    openedDetails.textContent = "";
    if (openedButton) openedButton.textContent = "▶ Open";
    openedDetails = null;
    openedButton = null;
}

function closeAiPanel(row) {
    const aiBox = row?.querySelector(".ai-details");
    if (!aiBox) return;
    aiBox.classList.add("hidden");
    const aiBtn = row?.querySelector('button.btn-ai[data-action="ai"]');
    syncAiButtonState(aiBtn);
}

function showActionConfirm({
    title = "Confirm action",
    message = "Please confirm to continue.",
    confirmText = "Confirm",
    cancelText = "Cancel",
    danger = false
} = {}) {
    const modal = document.getElementById("actionModal");
    const titleEl = document.getElementById("actionModalTitle");
    const messageEl = document.getElementById("actionModalMessage");
    const confirmEl = document.getElementById("actionModalConfirm");
    const cancelEl = document.getElementById("actionModalCancel");

    if (!modal || !titleEl || !messageEl || !confirmEl || !cancelEl) {
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        titleEl.textContent = String(title || "Confirm action");
        messageEl.textContent = String(message || "Please confirm to continue.");
        confirmEl.textContent = String(confirmText || "Confirm");
        cancelEl.textContent = String(cancelText || "Cancel");
        confirmEl.classList.toggle("btn-danger", !!danger);

        const close = (ok) => {
            modal.classList.remove("open");
            modal.setAttribute("aria-hidden", "true");
            confirmEl.onclick = null;
            cancelEl.onclick = null;
            modal.onclick = null;
            document.removeEventListener("keydown", onKeyDown);
            resolve(!!ok);
        };

        const onKeyDown = (e) => {
            if (e.key === "Escape") close(false);
        };

        confirmEl.onclick = () => close(true);
        cancelEl.onclick = () => close(false);
        modal.onclick = (e) => {
            if (e.target === modal) close(false);
        };

        modal.setAttribute("aria-hidden", "false");
        modal.classList.add("open");
        document.addEventListener("keydown", onKeyDown);
    });
}

const SAVED_TOOLS = new Map();

function createSavedToolsPanel(calculationId) {
    const calcId = Number(calculationId);

    const wrap = document.createElement("div");
    wrap.className = "saved-tools-box";

    const title = document.createElement("div");
    title.className = "saved-tools-title";
    title.textContent = "Saved tools for this calculation";
    wrap.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "saved-tools-grid";
    wrap.appendChild(grid);

    const chips = {};

    function addChip(key, text) {
        const chip = document.createElement("div");
        chip.className = "saved-tool-chip is-muted";
        chip.textContent = text;
        chips[key] = chip;
        grid.appendChild(chip);
    }

    addChip("scenarios", "Scenarios: waiting for run.");
    addChip("deep", "Deep dives: waiting for scenarios.");
    addChip("optimizer", "Optimizer: no saved result yet.");
    addChip("compare", "Compare: no saved result yet.");

    const api = {
        node: wrap,
        set(key, text, level = "muted") {
            const chip = chips[key];
            if (!chip) return;
            chip.textContent = String(text || "");
            chip.classList.remove("is-muted", "is-info", "is-good", "is-warn");
            chip.classList.add(`is-${level}`);
        }
    };

    SAVED_TOOLS.set(calcId, api);
    return api;
}

function getSavedToolsPanel(calculationId) {
    return SAVED_TOOLS.get(Number(calculationId)) || null;
}

function makeBuyButton(details, text, packKey) {
    const btn = el("button", "btn btn-ai-buy", text);
    btn.type = "button";

    btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Redirecting to checkout…";

        try {
            await ensureCsrfToken();
            const endpoints = [
                "/api/nowpayments/create-checkout",
                "/api/paddle/create-checkout"
            ];
            let redirected = false;
            let lastErr = null;

            for (const endpoint of endpoints) {
                const r = await fetch(endpoint, {
                    method: "POST",
                    headers: withCsrfHeaders({ "Content-Type": "application/json" }),
                    credentials: "include",
                    body: JSON.stringify({ pack: packKey })
                });
                const order = await r.json().catch(() => ({}));
                const checkoutUrl = String(order?.checkoutUrl || "");
                if (r.ok && checkoutUrl) {
                    redirected = true;
                    window.location.href = checkoutUrl;
                    break;
                }
                lastErr = { endpoint, status: r.status, order };
            }

            if (!redirected) {
                console.error("create-checkout failed", lastErr);
                btn.disabled = false;
                btn.textContent = text;
                details.appendChild(el("div", "verdict bad", "Failed to create checkout."));
                return;
            }
        } catch (e) {
            console.error(e);
            btn.disabled = false;
            btn.textContent = text;
            details.appendChild(el("div", "verdict bad", "Network error."));
        }
    });

    return btn;
}

function removeCreditsOffer(hostEl) {
    if (!hostEl) return;
    hostEl.querySelectorAll(".credits-offer").forEach((node) => node.remove());
}

function renderCreditsOffer(hostEl, options = {}) {
    if (!hostEl) return;
    removeCreditsOffer(hostEl);

    const message = String(options.message || "⚠️ Not enough credits for this action.");
    const primaryText = String(options.primaryText || "Buy 10 Full verdicts for $6.99");
    const primaryPack = String(options.primaryPack || "basic10");
    const secondaryText = String(options.secondaryText || "Buy 30 Full verdicts for $4.99");
    const secondaryPack = String(options.secondaryPack || "plus30");
    const includeLink = options.includeLink !== false;

    const box = document.createElement("div");
    box.className = "credits-offer";

    box.appendChild(el("div", "verdict warn", message));
    box.appendChild(makeBuyButton(box, primaryText, primaryPack));
    box.appendChild(makeBuyButton(box, secondaryText, secondaryPack));

    if (includeLink) {
        const a = document.createElement("a");
        a.href = "/pricing/";
        a.className = "muted";
        a.textContent = "See all plans & what’s included →";
        box.appendChild(a);
    }

    hostEl.appendChild(box);
    return box;
}

function renderAiNoCredits(details) {
    clearNode(details);

    details.appendChild(el("div", "verdict warn", "⚠️ You have no credits for Full analysis."));

    details.appendChild(makeBuyButton( details , "Buy 10 Full verdicts for $6.99", "basic10"));
    details.appendChild(makeBuyButton( details , "Buy 50 Full verdicts for $7.99", "premium50"));
    const a = document.createElement("a");
    a.href = "/pricing/";
    a.className = "muted";
    a.style.display = "block";
    a.style.margin= "18px auto"
    a.style.textAlign="center";
    a.textContent = "See all plans & what’s included →";
    details.appendChild(a);
}

function renderAiResult(details, mode, verdictText , calcId) {
    clearNode(details);

    const head = document.createElement("div");
    head.className = "ai-head";

    const title = el("div", "verdict info", `Full analysis (${mode})`);

    const regen = el("button", "btn btn-regen", "🔄 Regenerate");
    regen.type = "button";
    regen.setAttribute("data-action", "regen");

    head.appendChild(title);
    head.appendChild(regen);
    details.appendChild(head);

    const pre = el("pre", "ai-output");
    pre.textContent = String(verdictText || "");
    details.appendChild(pre);

    if (String(mode) === "cached_old") {
        details.appendChild(
            el(
                "div",
                "verdict warn",
                "Loaded your previously saved analysis. Numbers may differ from the current model. Regenerate when credits are available."
            )
        );
    }

    const savedTools = createSavedToolsPanel(calcId);
    details.appendChild(savedTools.node);

    details.appendChild(renderScenarioBlock(calcId));
    mountAskAnalyst(calcId , details );
    mountOptimizer(details , calcId);
    const compare = document.createElement("div");
    details.appendChild(compare);
    loadCompareDeals(compare, calcId);
}




async function mountOptimizer(hostEl, calculationId) {
    const wrap = document.createElement("div");
    wrap.className = "optimizer-box";

    const title = document.createElement("div");
    title.className = "optimizer-title";
    title.textContent = "Optimizer";
    wrap.appendChild(title);

    const metric = document.createElement("select");
    const op = document.createElement("select");
    const val = document.createElement("input");
    val.type = "number";
    val.placeholder = "Target value";

    const mode = document.createElement("select");
    [["quick", "Quick (8 credits)"], ["standard", "Standard (10 credits)"], ["deep", "Deep (15 credits)"]]
        .forEach(([k, t]) => { const o = document.createElement("option"); o.value = k; o.textContent = t; mode.appendChild(o); });

    ["<=", ">=", "<", ">"].forEach(x => { const o1 = document.createElement("option"); o1.value = x; o1.textContent = x; op.appendChild(o1); });

     const boot = window.__BOOT__ || {};
     const list = boot.account?.calculations || [];
     const calc = list.find(x => Number(x.id) === calculationId);
     const calculatorType = calc?.calculator_type;

    const metricCatalogByType = {
        mortgage: [
            { key: "monthlyPayment", label: "Monthly payment", better: "min" },
            { key: "totalInterest", label: "Total interest", better: "min" },
            { key: "totalPayment", label: "Total payment", better: "min" }
        ],
        cash_flow: [
            { key: "stressCashFlow", label: "Stress cash flow (monthly)", better: "max" },
            { key: "realCashFlowMonth", label: "Real cash flow (monthly)", better: "max" },
            { key: "cashFlowMonth", label: "Cash flow (monthly)", better: "max" }
        ],
        property_irr: [
            { key: "realIRR", label: "Real IRR", better: "max" },
            { key: "irr", label: "IRR", better: "max" },
            { key: "paybackYears", label: "Payback years", better: "min" }
        ],
        property_taxes: [
            { key: "finalProfitPV", label: "Final profit (PV)", better: "max" },
            { key: "realROI", label: "Real ROI", better: "max" },
            { key: "totalTaxes", label: "Total taxes", better: "min" }
        ],
        break_even: [
            { key: "breakEvenRent", label: "Break-even rent", better: "min" },
            { key: "breakEvenPrice", label: "Break-even price", better: "min" }
        ],
        rent_vs_buy: [
            { key: "buyNetCost", label: "Buy net cost", better: "min" },
            { key: "rentTotal", label: "Rent total", better: "min" },
            { key: "mortgagePaid", label: "Mortgage paid", better: "min" }
        ],
        ownership_cost: [
            { key: "totalOwnershipCostPV", label: "Total ownership cost (PV)", better: "min" },
            { key: "totalOwnershipCost", label: "Total ownership cost", better: "min" },
            { key: "costAsPercentOfPrice", label: "Cost as % of price", better: "min" }
        ],
        property_sale: [
            { key: "netProfit", label: "Net profit", better: "max" },
            { key: "realReturn", label: "Real return", better: "max" },
            { key: "annualReturn", label: "Annual return", better: "max" }
        ],
        renovation_roi: [
            { key: "netProfitPV", label: "Net profit (PV)", better: "max" },
            { key: "roiPV", label: "ROI (PV)", better: "max" },
            { key: "payback", label: "Payback", better: "min" }
        ],
        alternative_investment: [
            { key: "difference", label: "Property minus alternative", better: "max" },
            { key: "alternativeRealReturnPercent", label: "Alternative real return %", better: "max" },
            { key: "alternativeValue", label: "Alternative value", better: "max" }
        ],
        mortgage_overpayment: [
            { key: "realOverpayment", label: "Real overpayment", better: "min" },
            { key: "nominalOverpayment", label: "Nominal overpayment", better: "min" },
            { key: "monthlyPayment", label: "Monthly payment", better: "min" }
        ]
    };
    const metricCatalog = metricCatalogByType[calculatorType] || [
        { key: "monthlyPayment", label: "Monthly payment", better: "min" }
    ];
    metricCatalog.forEach((m) => {
        const o = document.createElement("option");
        o.value = m.key;
        o.textContent = m.label;
        metric.appendChild(o);
    });
    const metricBetter = new Map(metricCatalog.map((m) => [m.key, m.better]));

    function applyDefaultOpByMetric() {
        const better = metricBetter.get(metric.value);
        op.value = better === "max" ? ">=" : "<=";
    }
    metric.addEventListener("change", applyDefaultOpByMetric);
    applyDefaultOpByMetric();

    const status = document.createElement("div");
    status.className = "optimizer-status muted";
    status.textContent = "Set a target and run optimization for this calculation.";

    const btn = document.createElement("button");
    btn.className = "btn btn-optimizer";
    btn.textContent = "Run optimizer";

    const out = document.createElement("pre");
    out.className = "ai-output hidden";

    wrap.appendChild(metric);
    wrap.appendChild(op);
    wrap.appendChild(val);
    wrap.appendChild(mode);
    wrap.appendChild(btn);
    wrap.appendChild(status);
    wrap.appendChild(out);
    hostEl.appendChild(wrap);

    function costForMode(m) {
        if (m === "quick") return 8;
        if (m === "deep") return 15;
        return 10;
    }

    async function loadCachedOptimizer() {
        try {
            const r = await fetch(`/api/optimizer/cached?calculationId=${encodeURIComponent(calculationId)}`, {
                credentials: "include"
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j?.has) {
                const savedTools = getSavedToolsPanel(calculationId);
                if (savedTools) savedTools.set("optimizer", "Optimizer: no saved result yet.", "info");
                return;
            }

            const g = j.goal || {};
            const gMetric = String(g.metric || "");
            const gOp = String(g.op || "");
            const gValue = Number(g.value);
            const m = String(j.mode || "");

            if (gMetric && Array.from(metric.options).some(o => o.value === gMetric)) metric.value = gMetric;
            if (gOp && Array.from(op.options).some(o => o.value === gOp)) op.value = gOp;
            if (Number.isFinite(gValue)) val.value = String(gValue);
            if (m && Array.from(mode.options).some(o => o.value === m)) mode.value = m;

            out.textContent = String(j.content || "");
            out.classList.remove("hidden");
            const isStale = !!j?.stale;
            status.textContent = isStale
                ? "Loaded saved optimizer result (from previous model version)."
                : "Loaded saved optimizer result for this calculation.";
            status.className = isStale ? "optimizer-status verdict warn" : "optimizer-status verdict good";
            const savedTools = getSavedToolsPanel(calculationId);
            if (savedTools) {
                savedTools.set(
                    "optimizer",
                    isStale ? "Optimizer: saved result loaded (older model)." : "Optimizer: saved result loaded.",
                    isStale ? "warn" : "good"
                );
            }
        } catch (e) {
            // non-blocking: optimizer can still run even if cache read fails
            const savedTools = getSavedToolsPanel(calculationId);
            if (savedTools) savedTools.set("optimizer", "Optimizer: cache unavailable.", "warn");
        }
    }

    btn.addEventListener("click", async () => {
        const m = String(mode.value || "standard");
        const cost = costForMode(m);
        const credits = Number(window.__BOOT__?.account?.wallet?.credits || 0);
        const savedTools = getSavedToolsPanel(calculationId);
        const hasSavedOutput = !!String(out.textContent || "").trim();

        removeCreditsOffer(wrap);
        if (credits < cost) {
            if (!hasSavedOutput) {
                out.classList.add("hidden");
                out.textContent = "";
            }
            status.textContent = hasSavedOutput
                ? `Not enough credits. Optimizer (${m}) costs ${cost}, you have ${credits}. Saved result remains visible.`
                : `Not enough credits. Optimizer (${m}) costs ${cost}, you have ${credits}.`;
            status.className = "optimizer-status verdict warn";
            renderCreditsOffer(wrap, {
                message: `⚠️ Not enough credits for Optimizer. This run costs ${cost} credits.`
            });
            if (savedTools) savedTools.set("optimizer", "Optimizer: not enough credits.", "warn");
            return;
        }

        status.textContent = `This run costs ${cost} credits. You’ll have ${credits - cost} left.`;
        const ok = await showActionConfirm({
            title: "Run optimizer?",
            message: `This run costs ${cost} credits. You’ll have ${credits - cost} left.`,
            confirmText: `Run for ${cost} credits`,
            cancelText: "Cancel"
        });
        if (!ok) return;

        btn.disabled = true;
        btn.textContent = "Optimizing…";

        try {
            const goal = { metric: metric.value, op: op.value, value: Number(val.value) };
            await ensureCsrfToken();
            const r = await fetch("/api/optimizer/run", {
                method: "POST",
                headers: withCsrfHeaders({ "Content-Type": "application/json" }),
                credentials: "include",
                body: JSON.stringify({ calculationId, goal, mode: m })
            });
            let j = await r.json().catch(() => ({}));

            if (r.status === 202) {
                status.textContent = "Optimizer queued… waiting in line.";
                status.className = "optimizer-status verdict info";
                try {
                    j = await resolveQueuedAiResult(r, j, {
                        missingJobError: "OPTIMIZER_JOB_ID_MISSING",
                        onTick: (jobStatus) => {
                            if (jobStatus === "queued") {
                                status.textContent = "Optimizer queued… waiting in line.";
                                status.className = "optimizer-status verdict info";
                            } else if (jobStatus === "processing") {
                                status.textContent = "Optimizer processing… almost done.";
                                status.className = "optimizer-status verdict info";
                            }
                        }
                    });
                } catch (pollErr) {
                    out.classList.remove("hidden");
                    out.textContent = "Optimizer failed.";
                    status.textContent = String(pollErr?.message || pollErr || "Optimizer failed.");
                    status.className = "optimizer-status verdict warn";
                    if (savedTools) savedTools.set("optimizer", "Optimizer: run failed.", "warn");
                    return;
                }
            }

            if (!r.ok) {
                if (j?.error === "NO_CREDITS") {
                    if (!hasSavedOutput) {
                        out.classList.add("hidden");
                        out.textContent = "";
                    }
                    status.textContent = hasSavedOutput
                        ? `Not enough credits for Optimizer (${cost} credits needed). Saved result remains visible.`
                        : `Not enough credits for Optimizer (${cost} credits needed).`;
                    status.className = "optimizer-status verdict warn";
                    renderCreditsOffer(wrap, {
                        message: `⚠️ Not enough credits for Optimizer. This run costs ${cost} credits.`
                    });
                    if (savedTools) savedTools.set("optimizer", "Optimizer: not enough credits.", "warn");
                    return;
                }
                if (j?.error === "BAD_GOAL_METRIC") {
                    out.classList.add("hidden");
                    out.textContent = "";
                    status.textContent = "This target metric is not supported for this calculator. Please choose another metric.";
                    status.className = "optimizer-status verdict warn";
                    if (savedTools) savedTools.set("optimizer", "Optimizer: unsupported target metric.", "warn");
                    return;
                }
                if (j?.error === "GOAL_METRIC_NOT_AVAILABLE") {
                    out.classList.add("hidden");
                    out.textContent = "";
                    status.textContent = "Target metric is unavailable for this calculation result. Open and recalculate this deal, then run optimizer again.";
                    status.className = "optimizer-status verdict warn";
                    if (savedTools) savedTools.set("optimizer", "Optimizer: metric unavailable for this calc.", "warn");
                    return;
                }
                if (j?.error === "BAD_GOAL_OPERATOR") {
                    out.classList.add("hidden");
                    out.textContent = "";
                    status.textContent = "Invalid goal operator. Use <=, <, >=, or >.";
                    status.className = "optimizer-status verdict warn";
                    if (savedTools) savedTools.set("optimizer", "Optimizer: invalid goal operator.", "warn");
                    return;
                }

                out.classList.remove("hidden");
                out.textContent = "Optimizer failed.";
                status.textContent = j?.message || j?.error || `Optimizer failed (${r.status})`;
                status.className = "optimizer-status verdict warn";
                if (savedTools) savedTools.set("optimizer", "Optimizer: run failed.", "warn");
                return;
            }

            removeCreditsOffer(wrap);
            out.classList.remove("hidden");
            out.textContent = String(j.content || "");
            status.textContent = j?.mode === "cached"
                ? "Loaded saved optimizer result (no extra credit used)."
                : "Optimizer result is ready.";
            status.className = "optimizer-status verdict good";
            if (savedTools) {
                savedTools.set(
                    "optimizer",
                    j?.mode === "cached"
                        ? "Optimizer: saved result reused."
                        : "Optimizer: new result saved.",
                    "good"
                );
            }

            if (j.wallet) {
                window.__BOOT__ = window.__BOOT__ || {};
                window.__BOOT__.account = window.__BOOT__.account || {};
                window.__BOOT__.account.wallet = j.wallet;
                applyWalletToAiButtons(j.wallet);
            }
        } finally {
            btn.disabled = false;
            btn.textContent = "Run optimizer";
        }
    });

    loadCachedOptimizer();
}


 async function mountAskAnalyst(calculationId, hostEl) {
    const wrap = document.createElement("div");
    wrap.className = "qa-box";

    const title = document.createElement("div");
    title.className = "qa-title";
    title.textContent = "Ask the Analyst";
    wrap.appendChild(title);

    const status = document.createElement("div");
    status.className = "qa-status muted";
    status.textContent = "Ask only about this calculation: inputs, verdict, risks, and what to change.";
    wrap.appendChild(status);

    const history = document.createElement("div");
    history.className = "qa-history";
    wrap.appendChild(history);

    const row = document.createElement("div");
    row.className = "qa-row";

    const input = document.createElement("input");
    input.className = "qa-input";
    input.placeholder = "Example: Which input changes buyNetCost the most here?";
    row.appendChild(input);

    const btn = document.createElement("button");
    btn.className = "btn btn-qa";
    btn.textContent = "Ask";
    row.appendChild(btn);

    wrap.appendChild(row);
    hostEl.appendChild(wrap);
    let remainingSlots = 0;

    async function refresh() {
        const r = await fetch(`/api/verdict/qa/history?calculationId=${encodeURIComponent(calculationId)}`, { credentials: "include" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
            status.textContent = "Q&A history is temporarily unavailable.";
            status.className = "qa-status verdict warn";
            return;
        }

        history.innerHTML = "";
        (j.items || []).slice(-10).forEach(it => {
            const card = document.createElement("div");
            card.className = "qa-item";
            card.innerHTML = `<div class="q"><b>Q:</b> ${escapeHtml(it.question)}</div><div class="a"><b>A:</b><pre class="ai-output">${escapeHtml(it.answer)}</pre></div>`;
            history.appendChild(card);
        });

        const remaining = Number(j.remaining || 0);
        const credits = Number(j.wallet?.credits || 0);
        remainingSlots = remaining;

        if (remaining > 0) {
            status.textContent = `This question will use 1 of your remaining ${remaining} questions (0 credits).`;
            status.className = "qa-status verdict info";
            removeCreditsOffer(wrap);
        } else {
            status.textContent = `No pack. Next question costs 1 credit and gives you 3 questions. You have ${credits} credits.`;
            status.className = "qa-status muted";
            if (credits <= 0) {
                renderCreditsOffer(wrap, {
                    message: "⚠️ Not enough credits for Ask the Analyst. One question costs 1 credit."
                });
            } else {
                removeCreditsOffer(wrap);
            }
        }

        if (j.wallet) {
            window.__BOOT__ = window.__BOOT__ || {};
            window.__BOOT__.account = window.__BOOT__.account || {};
            window.__BOOT__.account.wallet = j.wallet;
            applyWalletToAiButtons(j.wallet);
        }
    }

    btn.addEventListener("click", async () => {
        const q = String(input.value || "").trim();
        if (q.length < 3) return;
        const credits = Number(window.__BOOT__?.account?.wallet?.credits || 0);
        if (remainingSlots <= 0 && credits < 1) {
            status.textContent = "Not enough credits. One question costs 1 credit.";
            status.className = "qa-status verdict warn";
            renderCreditsOffer(wrap, {
                message: "⚠️ Not enough credits for Ask the Analyst. One question costs 1 credit."
            });
            return;
        }

        btn.disabled = true;
        btn.textContent = "Asking…";

        try {
            await ensureCsrfToken();
            const r = await fetch("/api/verdict/qa", {
                method: "POST",
                headers: withCsrfHeaders({ "Content-Type": "application/json" }),
                credentials: "include",
                body: JSON.stringify({ calculationId, question: q })
            });
            let j = await r.json().catch(() => ({}));

            if (r.status === 202) {
                status.textContent = "Ask queued… waiting in line.";
                status.className = "qa-status verdict info";
                try {
                    j = await resolveQueuedAiResult(r, j, {
                        missingJobError: "QA_JOB_ID_MISSING",
                        onTick: (jobStatus) => {
                            if (jobStatus === "queued") {
                                status.textContent = "Ask queued… waiting in line.";
                                status.className = "qa-status verdict info";
                            } else if (jobStatus === "processing") {
                                status.textContent = "Analyst is preparing your answer…";
                                status.className = "qa-status verdict info";
                            }
                        }
                    });
                } catch (pollErr) {
                    status.textContent = String(pollErr?.message || pollErr || "Ask failed.");
                    status.className = "qa-status verdict bad";
                    return;
                }
            }

            if (!r.ok) {
                if (j?.wallet) {
                    window.__BOOT__ = window.__BOOT__ || {};
                    window.__BOOT__.account = window.__BOOT__.account || {};
                    window.__BOOT__.account.wallet = j.wallet;
                    applyWalletToAiButtons(j.wallet);
                }
                if (j?.error === "BAD_QUESTION" || j?.error === "QUESTION_OUT_OF_SCOPE") {
                    const examples = Array.isArray(j?.examples)
                        ? j.examples.filter(Boolean).slice(0, 3)
                        : [];
                    const tips = examples.length
                        ? ` Try: ${examples.map((x) => `"${String(x)}"`).join(" | ")}`
                        : "";
                    status.textContent = `${String(j?.message || "Please ask about this calculation.")}${tips}`;
                    status.className = "qa-status verdict warn";
                    removeCreditsOffer(wrap);
                    return;
                }
                status.textContent = j?.error === "NO_CREDITS"
                    ? "Not enough credits. One question costs 1 credit."
                    : (j?.message || j?.error || `Ask failed (${r.status})`);
                if (j?.error === "NO_CREDITS") {
                    status.className = "qa-status verdict warn";
                    renderCreditsOffer(wrap, {
                        message: "⚠️ Not enough credits for Ask the Analyst. One question costs 1 credit."
                    });
                } else {
                    status.className = "qa-status verdict bad";
                    removeCreditsOffer(wrap);
                }
                return;
            }

            if (j?.wallet) {
                window.__BOOT__ = window.__BOOT__ || {};
                window.__BOOT__.account = window.__BOOT__.account || {};
                window.__BOOT__.account.wallet = j.wallet;
                applyWalletToAiButtons(j.wallet);
            }
            if (j?.error === "BAD_QUESTION" || j?.error === "QUESTION_OUT_OF_SCOPE") {
                const examples = Array.isArray(j?.examples)
                    ? j.examples.filter(Boolean).slice(0, 3)
                    : [];
                const tips = examples.length
                    ? ` Try: ${examples.map((x) => `"${String(x)}"`).join(" | ")}`
                    : "";
                status.textContent = `${String(j?.message || "Please ask about this calculation.")}${tips}`;
                status.className = "qa-status verdict warn";
                removeCreditsOffer(wrap);
                return;
            }

            removeCreditsOffer(wrap);
            input.value = "";
            await refresh();
        } finally {
            btn.disabled = false;
            btn.textContent = "Ask";
        }
    });

    refresh();
}

function escapeHtml(s = "") {
    return String(s)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function mountExportPdfButton(hostEl, calculationId, options = {}) {
    if (!hostEl) return;

    const wrap = document.createElement("div");
    wrap.className = "pdf-box";

    if (options.showTitle !== false) {
        const title = document.createElement("div");
        title.className = "pdf-title";
        title.textContent = String(options.title || "PDF report");
        wrap.appendChild(title);

        const note = document.createElement("div");
        note.className = "pdf-note muted";
        note.textContent = String(options.note || "Export this calculation to share with partners, lenders, or your team.");
        wrap.appendChild(note);
    }

    const btn = document.createElement("button");
    btn.className = "btn btn-pdf";
    const defaultButtonText = String(options.buttonText || "Export PDF report (1 credit)");
    btn.textContent = defaultButtonText;

    const status = document.createElement("div");
    status.className = "pdf-status muted";
    status.textContent = "";

    wrap.appendChild(btn);
    wrap.appendChild(status);
    hostEl.appendChild(wrap);

    btn.addEventListener("click", async () => {
        const credits = Number(window.__BOOT__?.account?.wallet?.credits || 0);
        removeCreditsOffer(wrap);
        if (credits < 1) {
            status.textContent = "Not enough credits. PDF export costs 1 credit.";
            status.className = "pdf-status verdict warn";
            renderCreditsOffer(wrap, {
                message: "⚠️ Not enough credits for PDF export. This action costs 1 credit."
            });
            return;
        }

        const ok = await showActionConfirm({
            title: "Export PDF report?",
            message: `This export costs 1 credit. You’ll have ${credits - 1} left.`,
            confirmText: "Export for 1 credit",
            cancelText: "Cancel"
        });
        if (!ok) return;

        status.textContent = "Preparing PDF export…";
        status.className = "pdf-status verdict info";
        btn.disabled = true;
        btn.textContent = "Exporting…";

        try {
            await ensureCsrfToken();
            const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
            const locale = navigator.language || "";
            const r = await fetch("/api/report/pdf", {
                method: "POST",
                headers: withCsrfHeaders({ "Content-Type": "application/json" }),
                credentials: "include",
                body: JSON.stringify({ calculationId, timeZone, locale })
            });

            if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                if (j?.error === "NO_CREDITS") {
                    status.textContent = "Not enough credits. PDF export costs 1 credit.";
                    status.className = "pdf-status verdict warn";
                    renderCreditsOffer(wrap, {
                        message: "⚠️ Not enough credits for PDF export. This action costs 1 credit."
                    });
                    return;
                }
                throw new Error(j?.message || j?.error || `Export failed (${r.status})`);
            }

            removeCreditsOffer(wrap);
            const blob = await r.blob();
            const cd = String(r.headers.get("content-disposition") || "");
            const match = cd.match(/filename="?([^"]+)"?/i);
            const fileName = match?.[1] || `propertycost_report_${calculationId}.pdf`;

            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            if (window.__BOOT__?.account?.wallet) {
                const next = Math.max(0, Number(window.__BOOT__.account.wallet.credits || 0) - 1);
                window.__BOOT__.account.wallet.credits = next;
                applyWalletToAiButtons(window.__BOOT__.account.wallet);
            }
            status.textContent = "PDF downloaded successfully.";
            status.className = "pdf-status verdict good";
        } catch (e) {
            console.error("PDF export failed:", e);
            status.textContent = String(e?.message || "PDF export failed.");
            status.className = "pdf-status verdict bad";
        } finally {
            btn.disabled = false;
            btn.textContent = defaultButtonText;
        }
    });
}

function mountDealDeskTools() {
    const host = document.getElementById("dealDeskTools");
    if (!host || host.dataset.ready === "1") return;
    host.dataset.ready = "1";
    clearNode(host);

    const title = document.createElement("div");
    title.className = "deal-desk-title";
    title.textContent = "Deal desk";
    host.appendChild(title);

    const sub = document.createElement("p");
    sub.className = "deal-desk-sub muted";
    sub.textContent = "Portfolio summary turns your latest calculations into an action plan worth executing.";
    host.appendChild(sub);

    const list = document.createElement("ul");
    list.className = "deal-desk-list";
    ["Spot biggest portfolio risks early.", "Get top 3 next runs with the strongest upside."].forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        list.appendChild(li);
    });
    host.appendChild(list);

    const portfolioHost = document.createElement("div");
    host.appendChild(portfolioHost);
    mountPortfolioSummary(portfolioHost, {
        title: "Portfolio strategy",
        subtitle: "Scans up to 20 latest calculations and highlights what to fix first.",
        buttonText: "Generate portfolio summary (6 credits)"
    });
}

const PORTFOLIO_SECTION_LABELS = {
    snapshot: "Portfolio snapshot",
    risks: "Top risks",
    opportunities: "Top opportunities",
    missing: "Missing assumptions",
    next: "What to run next"
};

function normalizePortfolioLine(line) {
    return String(line || "").replace(/\s+/g, " ").trim();
}

function stripPortfolioBulletPrefix(line) {
    return normalizePortfolioLine(line).replace(/^([-*•]\s+|\d+[.)]\s+)/, "").trim();
}

function parsePortfolioSummaryContent(rawText) {
    const out = {
        snapshot: [],
        risks: [],
        opportunities: [],
        missing: [],
        next: []
    };

    const lines = String(rawText || "").replace(/\r\n?/g, "\n").split("\n");
    let current = "";

    function detectSection(line) {
        const v = normalizePortfolioLine(line).replace(/:$/, "").toLowerCase();
        if (!v) return "";
        if (v.startsWith("portfolio snapshot")) return "snapshot";
        if (v.startsWith("top risks")) return "risks";
        if (v.startsWith("top opportunities")) return "opportunities";
        if (v.startsWith("missing assumptions")) return "missing";
        if (v.startsWith("what i would do next")) return "next";
        return "";
    }

    for (const raw of lines) {
        const line = normalizePortfolioLine(raw);
        if (!line) continue;

        const section = detectSection(line);
        if (section) {
            current = section;
            continue;
        }
        if (!current) continue;

        const item = stripPortfolioBulletPrefix(line);
        if (!item) continue;
        out[current].push(item);
    }

    return out;
}

function extractPortfolioDigestMetrics(parsed) {
    const stats = { deals: null, good: null, warn: null, bad: null };
    const lines = Array.isArray(parsed?.snapshot) ? parsed.snapshot : [];
    let dealsByType = 0;
    let dealsFallback = null;

    for (const line of lines) {
        const s = String(line || "");

        const byType = s.match(/:\s*(\d+)\s+deal\(s\)/i);
        if (byType) dealsByType += Number(byType[1] || 0);

        if (dealsFallback == null) {
            const anyDeals = s.match(/(\d+)\s+deal\(s\)/i);
            if (anyDeals) dealsFallback = Number(anyDeals[1] || 0);
        }

        if (stats.good == null) {
            const m = s.match(/\bgood\s+(\d+)/i);
            if (m) stats.good = Number(m[1]);
        }
        if (stats.warn == null) {
            const m = s.match(/\bwarn\s+(\d+)/i);
            if (m) stats.warn = Number(m[1]);
        }
        if (stats.bad == null) {
            const m = s.match(/\bbad\s+(\d+)/i);
            if (m) stats.bad = Number(m[1]);
        }
    }

    if (dealsByType > 0) stats.deals = dealsByType;
    else if (Number.isFinite(dealsFallback)) stats.deals = dealsFallback;

    return stats;
}

function createPortfolioKpi(label, value, tone = "") {
    const node = document.createElement("div");
    node.className = `portfolio-kpi${tone ? ` is-${tone}` : ""}`;

    const v = document.createElement("div");
    v.className = "portfolio-kpi-value";
    v.textContent = value == null ? "—" : String(value);

    const l = document.createElement("div");
    l.className = "portfolio-kpi-label";
    l.textContent = label;

    node.appendChild(v);
    node.appendChild(l);
    return node;
}

function appendPortfolioSectionCard(host, title, items, limit = 2, ordered = false) {
    if (!host || !Array.isArray(items) || !items.length) return;

    const card = document.createElement("section");
    card.className = "portfolio-section-card";

    const h = document.createElement("h4");
    h.textContent = title;
    card.appendChild(h);

    const list = document.createElement(ordered ? "ol" : "ul");
    list.className = ordered ? "portfolio-next-list" : "portfolio-bullet-list";
    items.slice(0, limit).forEach((item) => {
        const li = document.createElement("li");
        li.textContent = String(item || "");
        list.appendChild(li);
    });
    card.appendChild(list);

    if (items.length > limit) {
        const more = document.createElement("div");
        more.className = "portfolio-more";
        more.textContent = `+${items.length - limit} more in full report`;
        card.appendChild(more);
    }

    host.appendChild(card);
}

function renderPortfolioPreview(host, parsed) {
    if (!host) return;
    clearNode(host);

    const metrics = extractPortfolioDigestMetrics(parsed);

    const kpis = document.createElement("div");
    kpis.className = "portfolio-kpis";
    kpis.appendChild(createPortfolioKpi("Deals scanned", metrics.deals, ""));
    kpis.appendChild(createPortfolioKpi("Good", metrics.good, "good"));
    kpis.appendChild(createPortfolioKpi("Warn", metrics.warn, "warn"));
    kpis.appendChild(createPortfolioKpi("Bad", metrics.bad, "bad"));
    host.appendChild(kpis);

    if (Array.isArray(parsed?.snapshot) && parsed.snapshot.length) {
        const chips = document.createElement("div");
        chips.className = "portfolio-snapshot-chips";
        parsed.snapshot.slice(0, 3).forEach((line) => {
            const chip = document.createElement("span");
            chip.className = "portfolio-chip";
            chip.textContent = line;
            chips.appendChild(chip);
        });
        if (parsed.snapshot.length > 3) {
            const more = document.createElement("span");
            more.className = "portfolio-chip is-more";
            more.textContent = `+${parsed.snapshot.length - 3} more`;
            chips.appendChild(more);
        }
        host.appendChild(chips);
    }

    const compact = document.createElement("div");
    compact.className = "portfolio-compact";
    appendPortfolioSectionCard(compact, PORTFOLIO_SECTION_LABELS.risks, parsed.risks, 2, false);
    appendPortfolioSectionCard(compact, PORTFOLIO_SECTION_LABELS.opportunities, parsed.opportunities, 2, false);
    appendPortfolioSectionCard(compact, PORTFOLIO_SECTION_LABELS.missing, parsed.missing, 2, false);
    appendPortfolioSectionCard(compact, PORTFOLIO_SECTION_LABELS.next, parsed.next, 3, true);

    if (!compact.childElementCount) {
        const empty = document.createElement("div");
        empty.className = "portfolio-empty muted";
        empty.textContent = "No structured highlights found. Open full report for details.";
        compact.appendChild(empty);
    }

    host.appendChild(compact);
}

let portfolioModalRefs = null;

function closePortfolioSummaryModal() {
    if (!portfolioModalRefs) return;
    portfolioModalRefs.root.classList.remove("open");
    portfolioModalRefs.root.setAttribute("aria-hidden", "true");
}

function ensurePortfolioSummaryModal() {
    if (portfolioModalRefs) return portfolioModalRefs;

    const root = document.createElement("div");
    root.id = "portfolioSummaryModal";
    root.className = "modal portfolio-modal";
    root.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "modal-content portfolio-modal-content";

    const head = document.createElement("div");
    head.className = "portfolio-modal-head";

    const title = document.createElement("h3");
    title.textContent = "Portfolio strategy report";

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn btn-open";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";

    head.appendChild(title);
    head.appendChild(closeBtn);
    content.appendChild(head);

    const body = document.createElement("div");
    body.className = "portfolio-modal-body";
    content.appendChild(body);
    root.appendChild(content);
    document.body.appendChild(root);

    closeBtn.addEventListener("click", closePortfolioSummaryModal);
    root.addEventListener("click", (e) => {
        if (e.target === root) closePortfolioSummaryModal();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && root.classList.contains("open")) closePortfolioSummaryModal();
    });

    portfolioModalRefs = { root, title, body };
    return portfolioModalRefs;
}

function renderPortfolioModalBody(host, parsed, rawText) {
    clearNode(host);
    renderPortfolioPreview(host, parsed);

    const sectionsHost = document.createElement("div");
    sectionsHost.className = "portfolio-modal-sections";

    const ordered = ["snapshot", "risks", "opportunities", "missing", "next"];
    ordered.forEach((key) => {
        const items = Array.isArray(parsed?.[key]) ? parsed[key] : [];
        if (!items.length) return;

        const section = document.createElement("section");
        section.className = "portfolio-modal-section";

        const h = document.createElement("h4");
        h.textContent = PORTFOLIO_SECTION_LABELS[key] || key;
        section.appendChild(h);

        const list = document.createElement(key === "next" ? "ol" : "ul");
        list.className = key === "next" ? "portfolio-next-list" : "portfolio-bullet-list";
        items.forEach((item) => {
            const li = document.createElement("li");
            li.textContent = item;
            list.appendChild(li);
        });
        section.appendChild(list);
        sectionsHost.appendChild(section);
    });

    host.appendChild(sectionsHost);

    const raw = document.createElement("details");
    raw.className = "portfolio-raw";
    const summary = document.createElement("summary");
    summary.textContent = "View raw analyst text";
    raw.appendChild(summary);
    const pre = document.createElement("pre");
    pre.className = "ai-output";
    pre.textContent = String(rawText || "");
    raw.appendChild(pre);
    host.appendChild(raw);
}

function openPortfolioSummaryModal(rawText) {
    const modal = ensurePortfolioSummaryModal();
    const parsed = parsePortfolioSummaryContent(rawText);
    renderPortfolioModalBody(modal.body, parsed, rawText);
    modal.root.classList.add("open");
    modal.root.setAttribute("aria-hidden", "false");
}

async function mountPortfolioSummary(hostEl, options = {}) {
    if (!hostEl) return;

    const wrap = document.createElement("div");
    wrap.className = "portfolio-box";

    const title = document.createElement("div");
    title.className = "portfolio-title";
    title.textContent = String(options.title || "Portfolio summary");
    wrap.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "portfolio-sub muted";
    subtitle.textContent = String(options.subtitle || "Use this when you have at least 5 saved calculations.");
    wrap.appendChild(subtitle);

    const teaser = document.createElement("div");
    teaser.className = "portfolio-teaser";
    ["Risk map", "Opportunity map", "Action plan"].forEach((text) => {
        const chip = document.createElement("span");
        chip.className = "portfolio-teaser-chip";
        chip.textContent = text;
        teaser.appendChild(chip);
    });
    wrap.appendChild(teaser);

    const btn = document.createElement("button");
    btn.className = "btn btn-portfolio";
    const generateText = String(options.buttonText || "Generate portfolio summary (6 credits)");
    const regenerateText = "Regenerate portfolio summary (6 credits)";
    btn.textContent = generateText;

    const viewBtn = document.createElement("button");
    viewBtn.className = "btn btn-open btn-portfolio-view hidden";
    viewBtn.type = "button";
    viewBtn.textContent = "Show full portfolio";

    const actions = document.createElement("div");
    actions.className = "portfolio-actions";
    actions.appendChild(btn);
    actions.appendChild(viewBtn);

    const status = document.createElement("div");
    status.className = "portfolio-status muted";
    status.textContent = "Runs on your recent data and returns risks, opportunities, and next actions.";

    const link = document.createElement("a");
    link.href = "/pricing/";
    link.className = "portfolio-link";
    link.textContent = "Top up credits →";

    wrap.appendChild(actions);
    wrap.appendChild(status);
    wrap.appendChild(link);
    hostEl.appendChild(wrap);

    let latestPortfolioText = "";
    let hasSavedPortfolio = false;

    function updateRunButtonLabel() {
        btn.textContent = hasSavedPortfolio ? regenerateText : generateText;
    }

    function setSavedPortfolioState(rawText, mode = "") {
        latestPortfolioText = String(rawText || "").trim();
        if (!latestPortfolioText) return;
        hasSavedPortfolio = true;
        updateRunButtonLabel();
        viewBtn.classList.remove("hidden");
        if (mode === "cached") {
            status.textContent = "Saved portfolio summary is ready. Click \"Show full portfolio\". Need fresh data? Click Regenerate.";
        } else {
            status.textContent = "Portfolio summary is ready. Click \"Show full portfolio\". You can regenerate anytime.";
        }
        status.className = "portfolio-status verdict good";
    }

    // load previously saved portfolio summary (no credit spend)
    try {
        const savedResp = await fetch("/api/portfolio/summary/latest", { credentials: "include" });
        const savedJson = await savedResp.json().catch(() => ({}));
        if (savedResp.ok && String(savedJson?.content || "").trim()) {
            setSavedPortfolioState(savedJson.content, "cached");
        }
    } catch (_) { }

    viewBtn.addEventListener("click", () => {
        if (!latestPortfolioText) return;
        openPortfolioSummaryModal(latestPortfolioText);
    });

    btn.addEventListener("click", async () => {
        const credits = Number(window.__BOOT__?.account?.wallet?.credits || 0);
        removeCreditsOffer(wrap);
        if (credits < 6) {
            status.textContent = `Not enough credits. Portfolio summary costs 6, you have ${credits}.`;
            status.className = "portfolio-status verdict warn";
            if (hasSavedPortfolio && latestPortfolioText) {
                status.textContent += " You can still open your saved portfolio report.";
            }
            renderCreditsOffer(wrap, {
                message: "⚠️ Not enough credits for Portfolio summary. This action costs 6 credits.",
                includeLink: false
            });
            return;
        }

        status.textContent = `This run costs 6 credits. You’ll have ${Math.max(0, credits - 6)} left.`;
        status.className = "portfolio-status verdict info";
        const isRegenerate = hasSavedPortfolio;
        const ok = await showActionConfirm({
            title: isRegenerate ? "Regenerate portfolio summary?" : "Run portfolio summary?",
            message: isRegenerate
                ? `This will replace your saved portfolio report and costs 6 credits. You’ll have ${credits - 6} left.`
                : `This run costs 6 credits. You’ll have ${credits - 6} left.`,
            confirmText: isRegenerate ? "Regenerate for 6 credits" : "Run for 6 credits",
            cancelText: "Cancel"
        });
        if (!ok) return;

        btn.disabled = true;
        btn.textContent = "Summarizing…";

        try {
            await ensureCsrfToken();
            const r = await fetch("/api/portfolio/summary", {
                method: "POST",
                headers: withCsrfHeaders({ "Content-Type": "application/json" }),
                credentials: "include",
                body: JSON.stringify({ limit: 20, force: isRegenerate })
            });
            let j = await r.json().catch(() => ({}));

            if (r.status === 202) {
                status.textContent = "Portfolio summary queued… waiting in line.";
                status.className = "portfolio-status verdict info";
                try {
                    j = await resolveQueuedAiResult(r, j, {
                        missingJobError: "PORTFOLIO_JOB_ID_MISSING",
                        onTick: (jobStatus) => {
                            if (jobStatus === "queued") {
                                status.textContent = "Portfolio summary queued… waiting in line.";
                                status.className = "portfolio-status verdict info";
                            } else if (jobStatus === "processing") {
                                status.textContent = "Portfolio summary processing… almost done.";
                                status.className = "portfolio-status verdict info";
                            }
                        }
                    });
                } catch (pollErr) {
                    status.textContent = String(pollErr?.message || pollErr || "Portfolio summary failed.");
                    status.className = "portfolio-status verdict bad";
                    removeCreditsOffer(wrap);
                    return;
                }
            }

            if (!r.ok) {
                if (j?.error === "NOT_ENOUGH_DATA") {
                    status.textContent = "Need at least 5 calculations for portfolio summary.";
                    status.className = "portfolio-status verdict info";
                    removeCreditsOffer(wrap);
                    return;
                }
                if (j?.error === "NO_CREDITS") {
                    status.textContent = "Not enough credits for Portfolio summary (6 credits needed).";
                    status.className = "portfolio-status verdict warn";
                    if (hasSavedPortfolio && latestPortfolioText) {
                        status.textContent += " You can still open your saved portfolio report.";
                    }
                    renderCreditsOffer(wrap, {
                        message: "⚠️ Not enough credits for Portfolio summary. This action costs 6 credits.",
                        includeLink: false
                    });
                    return;
                }
                status.textContent = String(j?.message || j?.error || "Portfolio summary failed.");
                status.className = "portfolio-status verdict bad";
                removeCreditsOffer(wrap);
                return;
            }

            removeCreditsOffer(wrap);
            const contentText = String(j.content || "").trim();
            if (!contentText) {
                status.textContent = "Portfolio summary returned empty content. Please run again.";
                status.className = "portfolio-status verdict bad";
                return;
            }
            setSavedPortfolioState(contentText, j?.mode === "cached" ? "cached" : "credit");

            if (j.wallet) {
                window.__BOOT__ = window.__BOOT__ || {};
                window.__BOOT__.account = window.__BOOT__.account || {};
                window.__BOOT__.account.wallet = j.wallet;
                applyWalletToAiButtons(j.wallet);
            }
        } finally {
            btn.disabled = false;
            updateRunButtonLabel();
        }
    });
}


async function loadCompareDeals(rootEl, calculationId = null) {
    clearNode(rootEl);
    const savedTools = getSavedToolsPanel(calculationId);
    try {
        const rr = await fetch("/api/calculations/list?limit=30", { credentials: "include" });
        if (!rr.ok) {
            rootEl.appendChild(el("div", "muted", "Compare tools are temporarily unavailable."));
            if (savedTools) savedTools.set("compare", "Compare: tools unavailable.", "warn");
            return;
        }
        const j = await rr.json().catch(() => ({}));
        renderCompareDeals(rootEl, j.items || [], calculationId);
    } catch (e) {
        rootEl.appendChild(el("div", "muted", "Compare tools are temporarily unavailable."));
        if (savedTools) savedTools.set("compare", "Compare: tools unavailable.", "warn");
    }
}


async function renderCompareDeals(hostEl, calcs, calculationId = null) {
    const wrap = document.createElement("div");
    wrap.className = "compare-box";

    const title = document.createElement("div");
    title.className = "compare-title";
    title.textContent = "Compare 2 deals";
    wrap.appendChild(title);

    const status = document.createElement("div");
    status.className = "compare-status muted";
    wrap.appendChild(status);

    const selA = document.createElement("select");
    const selB = document.createElement("select");

    const btn = document.createElement("button");
    btn.className = "btn btn-compare";
    btn.textContent = "Compare (2 credits)";

    const out = document.createElement("pre");
    out.className = "ai-output compare-output hidden";

    wrap.appendChild(selA);
    wrap.appendChild(selB);
    wrap.appendChild(btn);
    wrap.appendChild(out);
    hostEl.appendChild(wrap);

    const all = (calcs || []).slice();
    const savedTools = getSavedToolsPanel(calculationId);
    if (!all.length) {
        status.textContent = "No calculations found for compare.";
        status.className = "compare-status verdict info";
        btn.disabled = true;
        if (savedTools) savedTools.set("compare", "Compare: no calculations available.", "info");
        return;
    }

    function labelFor(c) {
        // если есть title/address — добавь сюда
        return `#${c.id} • ${c.type}`;
    }

    function fillSelect(select, items, selectedId) {
        select.innerHTML = "";
        items.forEach(c => {
            const o = document.createElement("option");
            o.value = String(c.id);
            o.textContent = labelFor(c);
            select.appendChild(o);
        });
        if (selectedId && items.some(x => Number(x.id) === Number(selectedId))) {
            select.value = String(selectedId);
        }
    }

    // 1) заполняем A всеми (предпочтительно текущей калькуляцией)
    fillSelect(selA, all, calculationId);

    // 2) функция: пересобрать B по типу выбранного A
    function rebuildB(preferredBId) {
        const aId = Number(selA.value);
        const a = all.find(x => Number(x.id) === aId);
        const typeA = String(a?.type || "");

        const filtered = all.filter(x => String(x.type) === typeA);

        // Убираем A из B (чтобы нельзя было сравнить одинаковые)
        const filteredB = filtered.filter(x => Number(x.id) !== aId);

        fillSelect(selB, filteredB, preferredBId);

        if (!filteredB.length) {
            status.textContent = `No other deals of type "${typeA}" to compare.`;
            status.className = "compare-status verdict warn";
            btn.disabled = true;
            return;
        }

        status.textContent = `Comparing type: ${typeA}`;
        status.className = "compare-status muted";
        btn.disabled = false;
    }

    selA.addEventListener("change", () => {
        out.classList.add("hidden");
        out.textContent = "";
        rebuildB();
    });

    // первичная сборка B
    rebuildB();

    async function loadCachedCompare() {
        if (!calculationId) return;

        try {
            const r = await fetch(`/api/deals/compare/cached?calculationId=${encodeURIComponent(calculationId)}`, {
                credentials: "include"
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j?.has) {
                if (savedTools) savedTools.set("compare", "Compare: no saved result yet.", "info");
                return;
            }

            const aId = Number(j.aId);
            const bId = Number(j.bId);
            const hasA = all.some(x => Number(x.id) === aId);
            const hasB = all.some(x => Number(x.id) === bId);

            if (hasA && hasB) {
                selA.value = String(aId);
                rebuildB(bId);
            }

            out.textContent = String(j.content || "");
            out.classList.remove("hidden");
            const isStale = !!j?.stale;
            status.textContent = isStale
                ? `Loaded saved compare for #${aId} vs #${bId} (older model).`
                : `Loaded saved compare for #${aId} vs #${bId}.`;
            status.className = isStale ? "compare-status verdict warn" : "compare-status verdict good";
            if (savedTools) {
                savedTools.set(
                    "compare",
                    isStale
                        ? `Compare: saved result #${aId} vs #${bId} (older model).`
                        : `Compare: saved result #${aId} vs #${bId}.`,
                    isStale ? "warn" : "good"
                );
            }
        } catch (e) {
            // non-blocking: user can still run compare manually
            if (savedTools) savedTools.set("compare", "Compare: no saved result yet.", "info");
        }
    }

    btn.addEventListener("click", async () => {
        const aId = Number(selA.value);
        const bId = Number(selB.value);
        if (!aId || !bId || aId === bId) return;

        const credits = Number((window.__BOOT__?.account?.wallet?.credits) || 0);
        const hasSavedOutput = !!String(out.textContent || "").trim();
        removeCreditsOffer(wrap);
        if (credits < 2) {
            if (!hasSavedOutput) {
                out.classList.add("hidden");
                out.textContent = "";
            }
            status.textContent = hasSavedOutput
                ? `Not enough credits. Compare costs 2, you have ${credits}. Saved compare remains visible.`
                : `Not enough credits. Compare costs 2, you have ${credits}.`;
            status.className = "compare-status verdict warn";
            renderCreditsOffer(wrap, {
                message: "⚠️ Not enough credits for Compare. This action costs 2 credits."
            });
            if (savedTools) savedTools.set("compare", "Compare: not enough credits.", "warn");
            return;
        }

        status.textContent = `This run costs 2 credits. You’ll have ${Math.max(0, credits - 2)} left.`;
        const ok = await showActionConfirm({
            title: "Compare deals?",
            message: `This compare costs 2 credits. You’ll have ${credits - 2} left.`,
            confirmText: "Compare for 2 credits",
            cancelText: "Cancel"
        });
        if (!ok) return;

        btn.disabled = true;
        btn.textContent = "Comparing…";

        try {
            await ensureCsrfToken();
            const r = await fetch("/api/deals/compare", {
                method: "POST",
                headers: withCsrfHeaders({ "Content-Type": "application/json" }),
                credentials: "include",
                body: JSON.stringify({ aId, bId })
            });
            let j = await r.json().catch(() => ({}));

            if (r.status === 202) {
                status.textContent = "Compare queued… waiting in line.";
                status.className = "compare-status verdict info";
                try {
                    j = await resolveQueuedAiResult(r, j, {
                        missingJobError: "COMPARE_JOB_ID_MISSING",
                        onTick: (jobStatus) => {
                            if (jobStatus === "queued") {
                                status.textContent = "Compare queued… waiting in line.";
                                status.className = "compare-status verdict info";
                            } else if (jobStatus === "processing") {
                                status.textContent = "Compare processing… almost done.";
                                status.className = "compare-status verdict info";
                            }
                        }
                    });
                } catch (pollErr) {
                    out.classList.remove("hidden");
                    out.textContent = "Compare failed.";
                    status.textContent = String(pollErr?.message || pollErr || "Compare failed.");
                    status.className = "compare-status verdict bad";
                    if (savedTools) savedTools.set("compare", "Compare: run failed.", "warn");
                    return;
                }
            }

            if (!r.ok) {
                if (j?.error === "NO_CREDITS") {
                    if (!hasSavedOutput) {
                        out.classList.add("hidden");
                        out.textContent = "";
                    }
                    status.textContent = hasSavedOutput
                        ? "Not enough credits for Compare (2 credits needed). Saved compare remains visible."
                        : "Not enough credits for Compare (2 credits needed).";
                    status.className = "compare-status verdict warn";
                    renderCreditsOffer(wrap, {
                        message: "⚠️ Not enough credits for Compare. This action costs 2 credits."
                    });
                    if (savedTools) savedTools.set("compare", "Compare: not enough credits.", "warn");
                    return;
                }

                out.classList.remove("hidden");
                out.textContent = String(j?.error || "Compare failed.");
                status.textContent = j?.message || j?.error || `Compare failed (${r.status})`;
                status.className = "compare-status verdict bad";
                if (savedTools) savedTools.set("compare", "Compare: run failed.", "warn");
                return;
            }

            removeCreditsOffer(wrap);
            out.textContent = String(j.content || "");
            out.classList.remove("hidden");
            status.textContent = j?.mode === "cached"
                ? "Loaded saved compare (no extra credit used)."
                : "Compare result is ready.";
            status.className = "compare-status verdict good";
            if (savedTools) {
                savedTools.set(
                    "compare",
                    j?.mode === "cached" ? "Compare: saved result reused." : "Compare: new result saved.",
                    "good"
                );
            }

            if (j.wallet) {
                window.__BOOT__ = window.__BOOT__ || {};
                window.__BOOT__.account = window.__BOOT__.account || {};
                window.__BOOT__.account.wallet = j.wallet;
                applyWalletToAiButtons(j.wallet);
            }
        } finally {
            btn.disabled = false;
            btn.textContent = "Compare (2 credits)";
        }
    });

    loadCachedCompare();
}


function renderAiError(details, msg) {
    clearNode(details);
    details.appendChild(el("div", "verdict bad", msg || "Failed."));
}

function renderScenarioNoCredits(resultsBox, options = {}) {
    if (!resultsBox) return;
    clearNode(resultsBox);
    renderCreditsOffer(resultsBox, {
        message: String(options.message || "⚠️ Not enough credits for Scenarios."),
        includeLink: options.includeLink !== false
    });
}

function renderScenarioBlock(calcId) {
    const wrap = document.createElement("div");
    wrap.className = "scenario-block";
    wrap.dataset.calcId = String(calcId);

    const title = el("div", "scenario-title", "Scenarios (bulk credits)");
    wrap.appendChild(title);

    wrap.dataset.lastCount = "0";

    const packs = document.createElement("div");
    packs.className = "scenario-packs";


    packs.appendChild(makeScenarioBtn("Find quick wins (3 tests) (2 credits)", 3, "quick"));
    packs.appendChild(makeScenarioBtn("Optimize deal (best value) ⭐ (3 credits)", 5, "optimize"));
    packs.appendChild(makeScenarioBtn("Maximize outcome (deep search) (6 credits)", 10, "deep"));


    wrap.appendChild(packs);

    const phrase = document.createElement("div");
    phrase.textContent = "Choose a pack by count. To regenerate, click the same pack again.";
    wrap.appendChild(phrase);

    const status = el("div", "scenario-status muted", "Each rerun creates a new set and charges credits again.");
    wrap.appendChild(status);

    const results = document.createElement("div");
    results.className = "scenario-results";
    wrap.appendChild(results);

    setTimeout(() => loadCachedScenarios(wrap), 0);
    return wrap;
}

async function loadCachedScenarios(blockEl) {
    try {
        const calcId = Number(blockEl?.dataset?.calcId);
        if (!calcId) return;
        const savedTools = getSavedToolsPanel(calcId);

        const details = blockEl.closest(".ai-details");
        const resultsBox = details?.querySelector(".scenario-results");
        const statusBox = details?.querySelector(".scenario-status");

        const r = await fetch(`/api/scenarios/cached?calculationId=${encodeURIComponent(calcId)}`, {
            credentials: "include"
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.has) {
            if (savedTools) savedTools.set("scenarios", "Scenarios: no saved run yet.", "info");
            if (savedTools) savedTools.set("deep", "Deep dives: no saved items yet.", "info");
            return;
        }

        const gen = Number(j.generatedCount ?? (j.items?.length || 0));
        const req = Number(j.requestedCount ?? gen);
        const miss = req - gen;

        // remember last paid pack size for regen
        blockEl.dataset.lastCount = String(req);

        const isStale = !!j?.stale;
        if (statusBox) {
            const loadedText =
                miss > 0
                    ? `Loaded saved scenarios: ${gen} unique of ${req} requested (removed ${miss} duplicates).`
                    : `Loaded saved scenarios: ${gen}/${req}.`;
            statusBox.textContent = isStale
                ? `${loadedText} Saved from an older model version. To refresh, regenerate ${req}.`
                : `${loadedText} To regenerate ${req}, click its pack button again.`;
            statusBox.className = isStale ? "scenario-status verdict warn" : "scenario-status verdict good";
        }
        if (savedTools) {
            savedTools.set(
                "scenarios",
                isStale
                    ? `Scenarios: ${gen}/${req} saved (older model).`
                    : (miss > 0
                        ? `Scenarios: ${gen}/${req} saved (deduped).`
                        : `Scenarios: ${gen}/${req} saved.`),
                isStale ? "warn" : "good"
            );
        }

        // render cached results
        if (resultsBox) {
            const resultsBox = details?.querySelector(".scenario-results");
            const boot = window.__BOOT__ || {};
            const list = boot.account?.calculations || [];
            const calc = list.find(x => Number(x.id) === calcId);
            const calcType = calc?.calculator_type;
            if (calcType) renderScenarioResults(resultsBox, j.items || [], calcType, calc);
        }
    } catch (e) {
        console.error("loadCachedScenarios failed:", e);
        const calcId = Number(blockEl?.dataset?.calcId);
        const savedTools = getSavedToolsPanel(calcId);
        if (savedTools) savedTools.set("scenarios", "Scenarios: cache unavailable.", "warn");
    }
}

async function runScenariosFlow(row, id, count, list, pack = "quick") {
    const details = row.querySelector(".ai-details");
    if (!details) return;
    details.classList.remove("hidden");

    const resultsBox = details.querySelector(".scenario-results");
    const statusBox = details.querySelector(".scenario-status");
    const savedTools = getSavedToolsPanel(id);
    const calc = list.find(x => Number(x.id) === id);
    const calcType = calc?.calculator_type;

    function scenarioCostLocal(count) {
        if (count === 3) return 2;
        if (count === 5) return 3;
        if (count === 10) return 6;
        return Math.max(1, Math.ceil(count * 0.6));
    }

    if (!calc || !calcType) {
        if (statusBox) {
            statusBox.textContent = "Calculation not found.";
            statusBox.className = "scenario-status verdict bad";
        }
        if (savedTools) savedTools.set("scenarios", "Scenarios: calculation not found.", "warn");
        return;
    }

    const wallet = (window.__BOOT__ || {}).account?.wallet;
    const credits = Number(wallet?.credits || 0);
    const cost = scenarioCostLocal(count);
    const left = credits - cost;
    const block = details.querySelector(".scenario-block");
    const previousCount = Number(block?.dataset?.lastCount || 0);
    const samePackRerun = previousCount > 0 && previousCount === count;
    const switchingPack = previousCount > 0 && previousCount !== count;
    const hasSavedScenarios = !!resultsBox?.querySelector(".scenario-card");

    if (resultsBox) removeCreditsOffer(resultsBox);
    if (credits < cost) {
        if (statusBox) {
            statusBox.textContent = hasSavedScenarios
                ? `Not enough credits. ${count} scenarios cost ${cost}, you have ${credits}. Saved scenarios remain visible.`
                : `Not enough credits. ${count} scenarios cost ${cost}, you have ${credits}.`;
            statusBox.className = "scenario-status verdict warn";
        }
        if (resultsBox) {
            if (hasSavedScenarios) {
                renderCreditsOffer(resultsBox, {
                    message: `⚠️ Not enough credits for Scenarios. This pack costs ${cost} credits.`
                });
            } else {
                renderScenarioNoCredits(resultsBox, {
                    message: `⚠️ Not enough credits for Scenarios. This pack costs ${cost} credits.`
                });
            }
        }
        if (savedTools) savedTools.set("scenarios", "Scenarios: not enough credits.", "warn");
        return;
    }

    if (statusBox) {
        if (samePackRerun) {
            statusBox.textContent = `Regenerating ${count} scenarios. This rerun costs ${cost} credits. You’ll have ${Math.max(0, left)} left.`;
        } else if (switchingPack) {
            statusBox.textContent = `Running ${count} scenarios (replacing currently shown ${previousCount}). This run costs ${cost} credits. You’ll have ${Math.max(0, left)} left.`;
        } else {
            statusBox.textContent = `Running ${count} scenarios. This run costs ${cost} credits. You’ll have ${Math.max(0, left)} left.`;
        }
        statusBox.className = "scenario-status verdict info";
    }

    // optional (очень повышает конверсию): confirm
    if (credits >= cost) {
        const confirmText = samePackRerun
            ? `Regenerate ${count} scenarios for ${cost} credits? A fresh set of ${count} will replace current cards. You’ll have ${left} left.`
            : switchingPack
                ? `Run ${count} scenarios for ${cost} credits? This will replace current ${previousCount} with ${count} new scenarios. You’ll have ${left} left.`
                : `Run ${count} scenarios for ${cost} credits? You’ll have ${left} left.`;
        const ok = await showActionConfirm({
            title: samePackRerun ? "Regenerate scenarios?" : "Run scenarios?",
            message: confirmText,
            confirmText: samePackRerun
                ? `Regenerate ${count} (${cost} credits)`
                : `Run ${count} (${cost} credits)`,
            cancelText: "Cancel"
        });
        if (!ok) {
            if (statusBox) {
                statusBox.textContent = "Canceled.";
                statusBox.className = "scenario-status muted";
            }
            return;
        }
    }


    try {
        // 1) build
        await ensureCsrfToken();
        const r0 = await fetch("/api/scenarios/build", {
            method: "POST",
            headers: withCsrfHeaders({ "Content-Type": "application/json" }),
            credentials: "include",
            body: JSON.stringify({ calculationId: id, count, pack })
        });
        const j0 = await r0.json().catch(() => ({}));
        if (!r0.ok) throw new Error(j0?.error || "BUILD_FAILED");

        const itemsForCompute = (j0.scenarios || []).map(s => ({
            label: s.label,
            input_data: s.input_data
        }));

        // 2) compute
        const rC = await fetch("/api/scenarios/compute", {
            method: "POST",
            headers: withCsrfHeaders({ "Content-Type": "application/json" }),
            credentials: "include",
            body: JSON.stringify({ calculationId: id, count, items: itemsForCompute, rerun: samePackRerun })
        });
        const jC = await rC.json().catch(() => ({}));
        if (!rC.ok) throw new Error(jC?.error);

        // 3) analyze (paid)
        const r1 = await fetch("/api/scenarios/analyze", {
            method: "POST",
            headers: withCsrfHeaders({ "Content-Type": "application/json" }),
            credentials: "include",
            body: JSON.stringify({ calculationId: id, requestedCount: count, items: jC.items, async: true })
        });

        let j1 = await r1.json().catch(() => ({}));
        if (!r1.ok && r1.status !== 202) {
            if (j1?.error === "NO_CREDITS") {
                const hasSavedScenariosNow = !!resultsBox?.querySelector(".scenario-card");
                if (statusBox) {
                    statusBox.textContent = hasSavedScenariosNow
                        ? `Not enough credits. ${count} scenarios cost ${cost} credits. Saved scenarios remain visible.`
                        : `Not enough credits. ${count} scenarios cost ${cost} credits.`;
                    statusBox.className = "scenario-status verdict warn";
                }
                if (resultsBox) {
                    if (hasSavedScenariosNow) {
                        renderCreditsOffer(resultsBox, {
                            message: `⚠️ Not enough credits for Scenarios. This pack costs ${cost} credits.`
                        });
                    } else {
                        renderScenarioNoCredits(resultsBox, {
                            message: `⚠️ Not enough credits for Scenarios. This pack costs ${cost} credits.`
                        });
                    }
                } else {
                    renderAiNoCredits(details);
                }
                if (savedTools) savedTools.set("scenarios", "Scenarios: not enough credits.", "warn");
                return;
            }
            throw new Error(j1?.error || "ANALYZE_FAILED");
        }

        if (r1.status === 202) {
            const jobId = String(j1?.jobId || "").trim();
            if (!jobId) throw new Error("ANALYZE_JOB_ID_MISSING");

            if (statusBox) {
                statusBox.textContent = "Scenarios queued… generating insights.";
                statusBox.className = "scenario-status verdict info";
            }

            j1 = await pollAiJobUntilDone(jobId, {
                intervalMs: 900,
                timeoutMs: 240000,
                onTick: (status) => {
                    if (!statusBox) return;
                    if (status === "queued") {
                        statusBox.textContent = "Scenarios queued… waiting in line.";
                        statusBox.className = "scenario-status verdict info";
                    } else if (status === "processing") {
                        statusBox.textContent = "Scenarios processing… almost done.";
                        statusBox.className = "scenario-status verdict info";
                    }
                }
            });
        }

        const gen = Number(j1.generatedCount ?? (j1.items?.length || 0));
        const req = Number(j1.requestedCount ?? count);

        if (statusBox) {
            statusBox.textContent = `Done. Generated ${gen}/${req} unique scenarios. To regenerate ${req}, click the same pack again.`;
            statusBox.className = "scenario-status verdict good";
        }
        if (savedTools) {
            savedTools.set("scenarios", `Scenarios: ${gen}/${req} saved.`, "good");
            savedTools.set("deep", "Deep dives: loading saved items…", "info");
        }
        if (resultsBox) {
            renderScenarioResults(resultsBox, j1.items || [], calcType, calc);
        }

        // remember last selected pack size
        if (block) block.dataset.lastCount = String(req);

        // wallet update
        if (j1.wallet) {
            window.__BOOT__ = window.__BOOT__ || {};
            window.__BOOT__.account = window.__BOOT__.account || {};
            window.__BOOT__.account.wallet = j1.wallet;
            applyWalletToAiButtons(j1.wallet);
        }

    } catch (err) {
        console.error("SCENARIOS FAILED:", err);
        if (statusBox) {
            statusBox.textContent = String(err?.message || "Network error.");
            statusBox.className = "scenario-status verdict bad";
        }
        if (savedTools) savedTools.set("scenarios", "Scenarios: run failed.", "warn");
    }
}


function makeScenarioBtn(text, count, pack) {
    const btn = el("button", "btn btn-scenarios", text);
    btn.type = "button";
    btn.dataset.count = String(count);
    btn.dataset.pack = String(pack || "quick");
    btn.setAttribute("data-action", "run_scenarios");
    return btn;
}

function renderScenarioResults(container, items, calcType, baselineCalc) {
    clearNode(container);

    if (!items || !items.length) {
        container.appendChild(el("div", "muted", "No scenarios returned."));
        return;
    }

    // baseline для delta (если есть)
    const baseRes = baselineCalc?.result_data || null;

    items.forEach((it, idx) => {
        const card = document.createElement("div");
        card.className = "scenario-card";
        card.dataset.scenarioIdx = String(idx);

        const head = document.createElement("div");
        head.className = "scenario-card-head";

        const name = el("div", "scenario-name", `${idx + 1}. ${it.label || "Scenario"}`);
        head.appendChild(name);

        const actions = document.createElement("div");
        actions.className = "scenario-card-actions";

        const toggle = el("button", "btn btn-scenario-toggle", "Show full scenario");
        toggle.type = "button";
        actions.appendChild(toggle);

        const deepBtn = el("button", "btn btn-scenario-deep", "Deep dive (2 credits)");
        deepBtn.type = "button";
        actions.appendChild(deepBtn);

        head.appendChild(actions);

        card.appendChild(head);

        // summary line
        // mini verdict (very visible)
        const mv = miniVerdictLine(it.mini_verdict);
        if (mv) card.appendChild(mv);

        // changes line (what user controls)
        const ch = buildScenarioInputChanges(calcType, it.input_data, baselineCalc?.input_data);
        if (ch) card.appendChild(ch);

        // summary line (numbers)
        const summary = buildScenarioSummary(calcType, it.result_data, baseRes);
        summary.classList.add("scenario-metrics");
        card.appendChild(summary);

        // expandable AI text
        const body = document.createElement("div");
        body.className = "scenario-full hidden";
        body.textContent = String(it.verdict_text || "");
        card.appendChild(body);

        toggle.addEventListener("click", () => {
            const open = !body.classList.contains("hidden");
            body.classList.toggle("hidden");
            toggle.textContent = open ? "Show full scenario" : "Hide full scenario";
        });

        const deepBox = el("div", "scenario-deep hidden", "");
        card.appendChild(deepBox);

        deepBtn.addEventListener("click", async () => {
            deepBtn.disabled = true;
            deepBtn.textContent = "Running deep dive…";

            try {
                removeCreditsOffer(deepBox);
                await ensureCsrfToken();
                const r = await fetch("/api/scenarios/deep_dive", {
                    method: "POST",
                    headers: withCsrfHeaders({ "Content-Type": "application/json" }),
                    credentials: "include",
                    body: JSON.stringify({ calculationId: Number(baselineCalc.id), idx })
                });
                let j = await r.json().catch(() => ({}));

                if (r.status === 202) {
                    deepBtn.textContent = "Deep dive queued…";
                    deepBox.classList.remove("hidden");
                    deepBox.textContent = "Deep dive queued… waiting in line.";
                    j = await resolveQueuedAiResult(r, j, {
                        missingJobError: "DEEP_DIVE_JOB_ID_MISSING",
                        onTick: (jobStatus) => {
                            if (jobStatus === "queued") {
                                deepBtn.textContent = "Deep dive queued…";
                                deepBox.textContent = "Deep dive queued… waiting in line.";
                            } else if (jobStatus === "processing") {
                                deepBtn.textContent = "Deep dive processing…";
                                deepBox.textContent = "Deep dive processing… almost done.";
                            }
                        }
                    });
                }

                if (!r.ok) {
                    if (j?.error === "NO_CREDITS") {
                        deepBox.classList.remove("hidden");
                        clearNode(deepBox);
                        renderCreditsOffer(deepBox, {
                            message: "⚠️ Not enough credits for Deep dive. This action costs 2 credits.",
                            includeLink: false
                        });
                        deepBtn.textContent = "Deep dive (2 credits)";
                        const savedTools = getSavedToolsPanel(Number(baselineCalc?.id));
                        if (savedTools) savedTools.set("deep", "Deep dives: no credits to run.", "warn");
                        return;
                    }
                    if (j?.error === "SCENARIOS_STALE") {
                        deepBox.classList.remove("hidden");
                        deepBox.textContent = "Scenarios are outdated after updated calculations. Regenerate scenarios first, then run Deep dive.";
                        deepBtn.textContent = "Regenerate scenarios first";
                        const savedTools = getSavedToolsPanel(Number(baselineCalc?.id));
                        if (savedTools) savedTools.set("deep", "Deep dives: scenarios are stale, regenerate scenarios first.", "warn");
                        return;
                    }
                    throw new Error(j?.error || "DEEP_DIVE_FAILED");
                }

                removeCreditsOffer(deepBox);
                deepBox.textContent = String(j.content || "");
                deepBox.classList.remove("hidden");
                deepBtn.textContent = "Deep dive loaded ✅";
                const savedTools = getSavedToolsPanel(Number(baselineCalc?.id));
                if (savedTools) {
                    savedTools.set(
                        "deep",
                        j?.mode === "cached"
                            ? `Deep dives: scenario #${idx + 1} loaded from saved cache.`
                            : `Deep dives: scenario #${idx + 1} saved.`,
                        "good"
                    );
                }

                if (j.wallet) {
                    window.__BOOT__ = window.__BOOT__ || {};
                    window.__BOOT__.account = window.__BOOT__.account || {};
                    window.__BOOT__.account.wallet = j.wallet;
                    applyWalletToAiButtons(j.wallet);
                }
            } catch (e) {
                deepBtn.textContent = "Deep dive failed";
                const savedTools = getSavedToolsPanel(Number(baselineCalc?.id));
                if (savedTools) savedTools.set("deep", "Deep dives: run failed.", "warn");
            } finally {
                deepBtn.disabled = false;
            }
        });


        container.appendChild(card);
    });

    const calcId = Number(baselineCalc?.id);
    if (calcId) {
        setTimeout(() => loadCachedScenarioDeepDives(calcId, container), 0);
    }
}

async function loadCachedScenarioDeepDives(calculationId, container) {
    if (!container) return;
    const savedTools = getSavedToolsPanel(calculationId);

    try {
        const r = await fetch(`/api/scenarios/deep_dive/cached?calculationId=${encodeURIComponent(calculationId)}`, {
            credentials: "include"
        });
        const j = await r.json().catch(() => ({}));

        if (!r.ok || !j?.has) {
            if (savedTools) savedTools.set("deep", "Deep dives: no saved items yet.", "info");
            return;
        }

        const deepItems = Array.isArray(j.items) ? j.items : [];
        deepItems.forEach((it) => {
            const idx = Number(it?.idx);
            if (!Number.isInteger(idx) || idx < 0) return;

            const card = container.querySelector(`.scenario-card[data-scenario-idx="${idx}"]`);
            const deepBox = card?.querySelector(".scenario-deep");
            const deepBtn = card?.querySelector(".btn-scenario-deep");
            if (deepBox) {
                deepBox.textContent = String(it?.content || "");
                deepBox.classList.remove("hidden");
            }
            if (deepBtn) {
                deepBtn.textContent = "Deep dive loaded ✅";
            }
        });

        if (savedTools) {
            const count = Number(j.count ?? deepItems.length ?? 0);
            savedTools.set("deep", `Deep dives: ${count} saved scenario${count === 1 ? "" : "s"} loaded.`, "good");
        }
    } catch (e) {
        if (savedTools) savedTools.set("deep", "Deep dives: cache unavailable.", "warn");
    }
}

function buildScenarioInputChanges(calcType, scenarioInput, baselineInput) {
    const base = baselineInput || {};
    const cur = scenarioInput || {};
    const schema = (CALC_FORMATS?.[calcType]?.input) || {};

    const changes = [];
    for (const key of Object.keys(schema)) {
        if (!(key in base) || !(key in cur)) continue;

        const a = base[key];
        const b = cur[key];

        // loose numeric compare
        const na = Number(a);
        const nb = Number(b);
        const bothNum = Number.isFinite(na) && Number.isFinite(nb);
        const eq = bothNum ? (na === nb) : (String(a) === String(b));
        if (eq) continue;

        const type = (typeof schema[key] === "string") ? schema[key] : (schema[key]?.type || "number");
        const fmt = FORMAT[type] || FORMAT.number;

        changes.push(`${humanInputName(key)}: ${fmt(a)} → ${fmt(b)}`);
        if (changes.length >= 5) break;
    }

    if (!changes.length) return null;

    const line = document.createElement("div");
    line.className = "scenario-line muted";
    line.textContent = `Changes: ${changes.join(" · ")}`;
    return line;
}

function miniVerdictLine(mini) {
    if (!mini) return null;

    const lv = String(mini.level || "info");
    const icon = mini.icon || iconForLevel(lv);

    const text = String(mini.text || "").trim();
    if (!text) return null;

    const cls =
        (lv === "good") ? "good" :
            (lv === "warn") ? "warn" :
                (lv === "bad") ? "bad" : "info";

    const d = document.createElement("div");
    d.className = `verdict ${cls}`;
    d.textContent = `${icon} ${text}`;
    return d;
}

function levelFromTag(tag) {
    const s = String(tag || "");
    if (s.includes("❌")) return "bad";
    if (s.includes("⚠️")) return "warn";
    if (s.includes("✅")) return "good";
    return "info";
}



function buildScenarioSummary(calcType, resultData, baseResult) {
    const box = document.createElement("div");
    const r = resultData || {};
    const schema = (CALC_FORMATS?.[calcType]?.result) || {};

    // --- Special: mortgage summary (always show the 3 key deltas) ---
    if (calcType === "mortgage" && baseResult) {
        const mp = Number(r.monthlyPayment || 0);
        const tp = Number(r.totalPayment || 0);
        const ti = Number(r.totalInterest || 0);

        const bmp = Number(baseResult.monthlyPayment || 0);
        const btp = Number(baseResult.totalPayment || 0);
        const bti = Number(baseResult.totalInterest || 0);

        const dM = mp - bmp;
        const dT = tp - btp;
        const dI = ti - bti;

        // Trade-off tag
        let tag = "";
        if (Number.isFinite(dM) && Number.isFinite(dT)) {
            if (dM < 0 && dT > 0) tag = "Trade-off: ✅ monthly relief / ❌ higher total cost";
            else if (dM < 0 && dT < 0) tag = "✅ Win-win: monthly and total cost down";
            else if (dM > 0 && dT < 0) tag = "Trade-off: ❌ higher monthly / ✅ lower total cost";
            else if (dM > 0 && dT > 0) tag = "❌ Worse: monthly and total cost up";
        }
        if (tag) {
        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        }
        

        box.appendChild(el("div", "scenario-line",
            `Monthly: ${FORMAT.money(mp)} (${dM < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dM))} vs base)`
        ));
        box.appendChild(el("div", "scenario-line",
            `Total payment: ${FORMAT.money(tp)} (${dT < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dT))} vs base)`
        ));
        box.appendChild(el("div", "scenario-line",
            `Total interest: ${FORMAT.money(ti)} (${dI < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dI))} vs base)`
        ));

        return box;
    }

    if (calcType === "rent_vs_buy" && baseResult) {
        const rentTotal = Number(r.rentTotal || 0);
        const buyNetCost = Number(r.buyNetCost || 0);
        const diff = rentTotal - buyNetCost;

        const br = Number(baseResult.rentTotal || 0);
        const bb = Number(baseResult.buyNetCost || 0);
        const bdiff = br - bb;

        const dDiff = diff - bdiff;

        let tag = "";
        const pct = rentTotal > 0 ? Math.abs(diff / rentTotal) : 0;
        if (pct < 0.03) tag = "Close call (sensitive to assumptions)";
        else tag = diff > 0 ? "✅ Buy advantage" : "⚠️ Rent advantage";

        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        box.appendChild(el("div", "scenario-line", `Rent total: ${FORMAT.money(rentTotal)}`));
        box.appendChild(el("div", "scenario-line", `Buy net cost: ${FORMAT.money(buyNetCost)}`));
        box.appendChild(el("div", "scenario-line",
            `Rent minus Buy: ${FORMAT.money(diff)} (${dDiff < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dDiff))} vs base)`
        ));

        return box;
    }

    if (calcType === "cash_flow" && baseResult) {
        const cf = Number(r.cashFlowMonth ?? 0);
        const real = Number(r.realCashFlowMonth ?? 0);
        const stress = Number(r.stressCashFlow ?? 0);

        const bcf = Number(baseResult.cashFlowMonth ?? 0);
        const breal = Number(baseResult.realCashFlowMonth ?? 0);
        const bstress = Number(baseResult.stressCashFlow ?? 0);

        const dCF = cf - bcf;
        const dStress = stress - bstress;

        let tag = "";
        if (stress < 0) tag = "❌ Fails stress test";
        else if (cf < 0) tag = "❌ Negative cash flow";
        else tag = "✅ Healthy cash flow";

        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        box.appendChild(el("div", "scenario-line", `Cash flow (mo): ${FORMAT.money(cf)} (${dCF < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dCF))} vs base)`));
        box.appendChild(el("div", "scenario-line", `Real cash flow (mo): ${FORMAT.money(real)} (${(real - breal) < 0 ? "−" : "+"}${FORMAT.money(Math.abs(real - breal))} vs base)`));
        box.appendChild(el("div", "scenario-line", `Stress cash flow (mo): ${FORMAT.money(stress)} (${dStress < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dStress))} vs base)`));

        return box;
    }

    if (calcType === "property_irr" && baseResult) {
        const irr = Number(r.irr ?? 0);
        const real = Number(r.realIRR ?? 0);
        const payback = r.paybackYears;

        const birr = Number(baseResult.irr ?? 0);
        const breal = Number(baseResult.realIRR ?? 0);

        const dI = irr - birr;
        const dR = real - breal;

        let tag = "";
        if (real <= 0) tag = "❌ Real IRR ≤ 0% (value erosion)";
        else if (real < 5) tag = "⚠️ Low real IRR (sensitive)";
        else tag = "✅ Solid real IRR";

        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        box.appendChild(el("div", "scenario-line", `IRR: ${FORMAT.percent(irr)} (${dI < 0 ? "−" : "+"}${FORMAT.percent(Math.abs(dI))} vs base)`));
        box.appendChild(el("div", "scenario-line", `Real IRR: ${FORMAT.percent(real)} (${dR < 0 ? "−" : "+"}${FORMAT.percent(Math.abs(dR))} vs base)`));
        if (payback !== undefined && payback !== null) box.appendChild(el("div", "scenario-line", `Payback: ${FORMAT.payback(payback)}`));

        return box;
    }

    if (calcType === "renovation_roi" && baseResult) {
        const roiPV = Number(r.roiPV ?? 0);
        const netPV = Number(r.netProfitPV ?? 0);
        const payback = r.payback;

        const broiPV = Number(baseResult.roiPV ?? 0);
        const bnetPV = Number(baseResult.netProfitPV ?? 0);

        const dR = roiPV - broiPV;
        const dN = netPV - bnetPV;

        let tag = "";
        if (netPV <= 0 || roiPV <= 0) tag = "❌ Not worth it after discounting";
        else if (roiPV < 10) tag = "⚠️ Low PV ROI (sensitive)";
        else tag = "✅ Strong PV ROI";

        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        box.appendChild(el("div", "scenario-line", `ROI (PV): ${FORMAT.percent(roiPV)} (${dR < 0 ? "−" : "+"}${FORMAT.percent(Math.abs(dR))} vs base)`));
        box.appendChild(el("div", "scenario-line", `Net profit (PV): ${FORMAT.money(netPV)} (${dN < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dN))} vs base)`));
        if (payback !== undefined && payback !== null) box.appendChild(el("div", "scenario-line", `Payback: ${FORMAT.payback(payback)}`));

        return box;
    }

    if (calcType === "property_sale" && baseResult) {
        const net = Number(r.netProfit ?? 0);
        const real = Number(r.realReturn ?? 0);
        const annual = Number(r.annualReturn ?? 0);

        const bnet = Number(baseResult.netProfit ?? 0);
        const breal = Number(baseResult.realReturn ?? 0);

        const dN = net - bnet;
        const dR = real - breal;

        let tag = "";
        if (net <= 0 || real <= 0) tag = "❌ Weak sale after inflation/costs";
        else if (real < 3) tag = "⚠️ Low real return (sensitive)";
        else tag = "✅ Solid real return";

        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        box.appendChild(el("div", "scenario-line", `Net profit: ${FORMAT.money(net)} (${dN < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dN))} vs base)`));
        box.appendChild(el("div", "scenario-line", `Real return: ${FORMAT.percent(real)} (${dR < 0 ? "−" : "+"}${FORMAT.percent(Math.abs(dR))} vs base)`));
        box.appendChild(el("div", "scenario-line", `Annual return: ${FORMAT.percent(annual)}`));

        return box;
    }

    if (calcType === "property_taxes" && baseResult) {
        const fpv = Number(r.finalProfitPV ?? 0);
        const rroi = Number(r.realROI ?? 0);
        const burden = Number(r.taxBurdenPercent ?? 0);

        const bfpv = Number(baseResult.finalProfitPV ?? 0);
        const brroi = Number(baseResult.realROI ?? 0);

        const dP = fpv - bfpv;
        const dR = rroi - brroi;

        let tag = "";
        if (fpv <= 0 || rroi <= 0) tag = "❌ Taxes/fees kill real returns";
        else if (burden >= 55 || rroi < 4) tag = "⚠️ High drag / low real ROI";
        else tag = "✅ Manageable taxes & fees";

        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        box.appendChild(el("div", "scenario-line",
            `Final profit (PV): ${FORMAT.money(fpv)} (${dP < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dP))} vs base)`));
        box.appendChild(el("div", "scenario-line",
            `Real ROI: ${FORMAT.percent(rroi)} (${dR < 0 ? "−" : "+"}${FORMAT.percent(Math.abs(dR))} vs base)`));
        box.appendChild(el("div", "scenario-line",
            `Tax burden: ${FORMAT.percent(burden)}`));

        return box;
    }

    if (calcType === "ownership_cost" && baseResult) {
        const total = Number(r.totalOwnershipCost ?? r.totalCost ?? 0);
        const baseTotal = Number(baseResult.totalOwnershipCost ?? baseResult.totalCost ?? 0);
        const d = total - baseTotal;

        // try to get PV too
        const pv = Number(r.totalOwnershipCostPV ?? r.totalCostPV ?? 0);
        const basePv = Number(baseResult.totalOwnershipCostPV ?? baseResult.totalCostPV ?? 0);
        const dPv = pv - basePv;

        // years (prefer result.years that we inject in enrichResultDataForUI)
        const years = Number(r.years ?? baseResult.years ?? 0);
        const mAvg = (years > 0) ? total / (years * 12) : 0;

        const p = Number.isFinite(r.costAsPercentOfPrice) ? Number(r.costAsPercentOfPrice) : NaN;

        // impact line
        let impactText = "ℹ️ No change vs base";
        let impactClass = "verdict info";
        if (Number.isFinite(d) && d !== 0) {
            if (d < 0) { impactText = `✅ Savings vs base: ${FORMAT.money(Math.abs(d))}`; impactClass = "verdict good"; }
            else { impactText = `❌ Higher cost vs base: ${FORMAT.money(d)}`; impactClass = "verdict bad"; }
        }
        box.appendChild(el("div", `scenario-line ${impactClass}`, impactText));

        // quality tag (only if p exists)
        if (Number.isFinite(p)) {
            let tag = "⚠️ Moderate ownership cost";
            if (p <= 35) tag = "✅ Controlled ownership cost";
            else if (p > 85) tag = "❌ Too expensive to hold";
            box.appendChild(el("div", "scenario-line verdict info", `${tag} (cost: ${FORMAT.percent(p)} of price)`));
        }

        // totals + deltas
        const sign = d < 0 ? "−" : "+";
        box.appendChild(el(
            "div",
            "scenario-line",
            `Total ownership cost: ${FORMAT.money(total)} (${sign}${FORMAT.money(Math.abs(d))} vs base)`
        ));

        if (pv > 0 && basePv > 0) {
            const signPv = dPv < 0 ? "−" : "+";
            box.appendChild(el(
                "div",
                "scenario-line",
                `Total cost (PV): ${FORMAT.money(pv)} (${signPv}${FORMAT.money(Math.abs(dPv))} vs base)`
            ));
        }

        if (years > 0) {
            box.appendChild(el("div", "scenario-line", `Avg monthly: ${FORMAT.money(mAvg)}`));
        }

        return box;
    }

    if (calcType === "mortgage_overpayment" && baseResult) {
        const real = Number(r.realOverpayment ?? 0);
        const nominal = Number(r.nominalOverpayment ?? 0);
        const mp = Number(r.monthlyPayment ?? 0);

        const bReal = Number(baseResult.realOverpayment ?? 0);
        const bNom = Number(baseResult.nominalOverpayment ?? 0);
        const bMp = Number(baseResult.monthlyPayment ?? 0);

        const dReal = real - bReal;
        const dNom = nominal - bNom;
        const dMp = mp - bMp;

        let tag = "";
        if (dReal < 0) tag = "✅ Real overpayment improved";
        else if (dReal > 0) tag = "❌ Real overpayment worsened";
        else tag = "ℹ️ Real overpayment unchanged";

        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        box.appendChild(el("div", "scenario-line", `Real overpayment: ${FORMAT.money(real)} (${dReal < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dReal))} vs base)`));
        box.appendChild(el("div", "scenario-line", `Nominal overpayment: ${FORMAT.money(nominal)} (${dNom < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dNom))} vs base)`));
        box.appendChild(el("div", "scenario-line", `Monthly payment: ${FORMAT.money(mp)} (${dMp < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dMp))} vs base)`));
        if (r.realInterestRate !== undefined && r.realInterestRate !== null) {
            box.appendChild(el("div", "scenario-line", `Real interest rate: ${FORMAT.percent(Number(r.realInterestRate))}`));
        }
        return box;
    }

    if (calcType === "alternative_investment" && baseResult) {
        const prop = Number(r.propertyValue ?? 0);
        const alt = Number(r.alternativeValue ?? 0);
        const diff = prop - alt;

        const bProp = Number(baseResult.propertyValue ?? 0);
        const bAlt = Number(baseResult.alternativeValue ?? 0);
        const bDiff = bProp - bAlt;
        const dDiff = diff - bDiff;

        let tag = "";
        if (Math.abs(diff) < Math.max(1, Math.abs(prop) * 0.02)) tag = "⚠️ Close call (sensitive to assumptions)";
        else tag = diff < 0 ? "✅ Alternative outperforms property" : "⚠️ Property outperforms alternative";

        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        box.appendChild(el("div", "scenario-line", `Property value: ${FORMAT.money(prop)}`));
        box.appendChild(el("div", "scenario-line", `Alternative value: ${FORMAT.money(alt)}`));
        box.appendChild(el("div", "scenario-line", `Property minus Alternative: ${FORMAT.money(diff)} (${dDiff < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dDiff))} vs base)`));
        if (r.propertyRealReturnPercent !== undefined && r.alternativeRealReturnPercent !== undefined) {
            box.appendChild(el("div", "scenario-line",
                `Real return gap: ${FORMAT.percent(Number(r.propertyRealReturnPercent))} vs ${FORMAT.percent(Number(r.alternativeRealReturnPercent))}`));
        }
        return box;
    }

    if (calcType === "break_even" && baseResult) {
        const ber = Number(r.breakEvenRent ?? 0);
        const bep = Number(r.breakEvenPrice ?? 0);
        const bBer = Number(baseResult.breakEvenRent ?? 0);
        const bBep = Number(baseResult.breakEvenPrice ?? 0);
        const dBer = ber - bBer;
        const dBep = bep - bBep;

        let tag = "";
        if (dBer < 0) tag = "✅ Break-even is easier to hit";
        else if (dBer > 0) tag = "❌ Break-even got harder";
        else tag = "ℹ️ Break-even unchanged";

        const lv = levelFromTag(tag);
        box.appendChild(el("div", `scenario-line verdict ${lv}`, tag));
        box.appendChild(el("div", "scenario-line", `Break-even rent: ${FORMAT.money(ber)} (${dBer < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dBer))} vs base)`));
        box.appendChild(el("div", "scenario-line", `Break-even price: ${FORMAT.money(bep)} (${dBep < 0 ? "−" : "+"}${FORMAT.money(Math.abs(dBep))} vs base)`));
        return box;
    }


    const keys = Object.keys(schema).filter(k => r[k] !== undefined && r[k] !== null);
    if (!keys.length) {
        box.appendChild(el("div", "scenario-line muted", "No result metrics to summarize."));
        return box;
    }

    const top = keys.slice(0, 5);
    top.forEach(k => {
        const type = schema[k] || "number";
        const fmt = FORMAT[type] || FORMAT.number;
        box.appendChild(el("div", "scenario-line", `${humanize(k)}: ${fmt(r[k])}`));
    });

    
    if (baseResult && top.length) {
        const k = top[0];
        const a = Number(r[k]);
        const b = Number(baseResult?.[k]);
        if (Number.isFinite(a) && Number.isFinite(b)) {
            const d = a - b;
            const sign = d < 0 ? "−" : "+";
            box.appendChild(el("div", "scenario-line verdict info", `${humanize(k)} delta vs base: ${sign}${FORMAT.number(Math.abs(d))}`));
        }
    }

    return box;

}




function applyWalletToAiButtons(wallet) {
    document.querySelectorAll('button.btn-ai[data-action="ai"]').forEach(btn => {
        syncAiButtonState(btn, wallet);
    });
}





function renderCalculations(list) {
    const box = document.getElementById("calculations");
    const totalEl = document.getElementById("totalCalcs");
    const lastEl = document.getElementById("lastCalc");


    if (!box) return;

    box.textContent = "";
    box.classList.remove("is-sparse");

    if (totalEl) totalEl.textContent = list.length;

    if (!list || list.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "muted";
        emptyDiv.textContent = "No calculations yet. Create your first calculation to analyze your investment.";
        box.appendChild(emptyDiv);
        if (lastEl) lastEl.textContent = "—";
        syncSparseCalculationsState(box);
        return;
    }

    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const last = new Date(list[0].created_at).toLocaleDateString();
    if (lastEl) lastEl.textContent = last;

    // уже для калькуляторов идет 
        list.forEach(calc => {
            // const row = document.createElement("div");
            // row.className = "calc-item";
            // row.dataset.id = String(calc.id);


            // // Левая часть
            // const info = document.createElement("div");
            // info.className = "calc-info";

            // const title = document.createElement("div");
            // title.className = "calc-title";
            // title.textContent = humanName(calc.calculator_type);

            // const date = document.createElement("div");
            // date.className = "calc-date";
            // date.textContent = new Date(calc.created_at).toLocaleString();

            // info.appendChild(title);
            // info.appendChild(date);

            // // Кнопки
            // const actions = document.createElement("div");
            // actions.className = "calc-actions";

            // const openBtn = document.createElement("button");
            // openBtn.className = "btn btn-open";
            // openBtn.textContent = "▶ Open";

            // const aiBtn = document.createElement("button");
            // aiBtn.className = "btn btn-ai";
            // aiBtn.textContent = "✨Full Analysis";
            // aiBtn.setAttribute("data-action", "ai");
            

            // const delBtn = document.createElement("button");
            // delBtn.className = "btn btn-delete";
            // delBtn.textContent = "Delete";
            // delBtn.addEventListener("click" , () => {
            //     showDeleteModal(calc.id , row);
            // });
            

            // actions.appendChild(openBtn);
            // actions.appendChild(aiBtn);
            // actions.appendChild(delBtn);


            // const details = document.createElement("div");
            // details.className = "calc-details hidden";

            // const aiDetails = document.createElement("div");
            // aiDetails.className = "ai-details hidden";

            // row.appendChild(info);
            // row.appendChild(actions);
            // row.appendChild(details);
            // row.appendChild(aiDetails);

            // openBtn.addEventListener("click" , () => {
            //     openCalculation(calc, details, openBtn);
            // });
            
            // box.appendChild(row);
            const row = document.createElement("div");
            row.className = "calc-item";
            row.dataset.id = String(calc.id);

            // head
            const head = document.createElement("div");
            head.className = "calc-head";

            // left info
            const info = document.createElement("div");
            info.className = "calc-info";
            const title = document.createElement("div");
            title.className = "calc-title";
            title.textContent = humanName(calc.calculator_type);
            const date = document.createElement("div");
            date.className = "calc-date";
            date.textContent = new Date(calc.created_at).toLocaleString();
            info.appendChild(title);
            info.appendChild(date);

            // actions
            const actions = document.createElement("div");
            actions.className = "calc-actions";

            const openBtn = document.createElement("button");
            openBtn.className = "btn btn-open";
            openBtn.textContent = "▶ Open";
            openBtn.setAttribute("data-action", "open");

            const aiBtn = document.createElement("button");
            aiBtn.className = "btn btn-ai";
            aiBtn.textContent = "✨Full Analysis";
            aiBtn.setAttribute("data-action", "ai");

            const delBtn = document.createElement("button");
            delBtn.className = "btn btn-delete";
            delBtn.textContent = "Delete";
            delBtn.setAttribute("data-action", "delete");

            actions.appendChild(openBtn);
            actions.appendChild(aiBtn);
            actions.appendChild(delBtn);

            head.appendChild(info);
            head.appendChild(actions);

            // panels
            const panels = document.createElement("div");
            panels.className = "calc-panels";

            const details = document.createElement("div");
            details.className = "calc-details hidden";

            const aiDetails = document.createElement("div");
            aiDetails.className = "ai-details hidden";

            panels.appendChild(details);
            panels.appendChild(aiDetails);

            row.appendChild(head);
            row.appendChild(panels);

            box.appendChild(row);
        });
    applyWalletToAiButtons((window.__BOOT__ || {}).account?.wallet);
    syncSparseCalculationsState(box);
}
        

        


function humanInputName(key) {
    const map = {
        priceBefore: "Price before renovation",
        rentBefore: "Rent before renovation",
        renovationCost: "Renovation cost",
        priceIncrease: "Expected price increase",
        rentIncrease: "Expected rent increase",
        years: "Investment period",
        noiAnnual: "NOI (annual)",
        price: "Purchase Price",
        rentMonthly: "Gross Rent (monthly)",
        vacancy: "Vacancy",
        opexAnnual: "Operating Expenses (annual)",
        noiAnnualBuilt: "NOI (built)"
    };

    return map[key] || humanize(key);
}

// Форматируем деньги
const moneyFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
});

const numberFormatter = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
});

function humanize(key) {
    return key
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, s => s.toUpperCase());
}

function humanName(type) {
    const map = {
        alternative_investment: "Alternative Investments",
        break_even: "Break-even",
        cash_flow: "Cash Flow",
        property_irr: "Property IRR",
        mortgage: "Mortgage",
        ownership_cost: "Ownership Cost",
        property_sale: "Property Sale",
        property_taxes: "Property Taxes",
        mortgage_overpayment: "Mortgage Overpayment",
        renovation_roi: "Renovation ROI",
        rent_vs_buy: "Rent vs Buy",
        cap_rate: "Cap Rate"
    };

    return map[type] || type;
}

function formatPercent(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2) + "%";
} 

function formatMoney(value) {
    if (typeof value !== "number") return value;
    return moneyFormatter.format(value);
}

function formatNumber(value) {
    if (typeof value !== "number") return value;
    return numberFormatter.format(value);
}

function formatPayback(value) {
    if (typeof value !== "number" || value < 0) return value;

    const years = Math.floor(value);
    const months = Math.round((value - years) * 12);

    if (years > 0 && months > 0) {
        return `${years} yrs ${months} months`;
    }

    if (years > 0) {
        return `${years} yrs`;
    }

    return `${months} months`;
}



const FORMAT = {
    money: v => formatMoney(v),
    percent: v => formatPercent(v),
    years: v => typeof v === "number"
        ? `${v.toFixed(1)} yrs`
        : v,
    payback: v => formatPayback(v) ,
    number: v => formatNumber(v),
    text: v => v 
};

const CALC_FORMATS = {

    alternative_investment: {
        input: {
            propertyInitial: "money",
            propertyCashflow: "money",
            propertyGrowth: "percent",
            propertyInflation: "percent",
            propertyTaxRate:"percent",
            altReturn: "percent",
            altContribution: "money",
            altInflation: "percent",
            altTaxRate: "percent",
            years: "years"
        },
        result: {
            propertyValue: "money",
            alternativeValue: "money",
            propertyRealReturnPercent: "percent",
            alternativeRealReturnPercent: "percent",
            difference: "money",
            winner: "text"
        }
    },

    

    break_even: {
        input: {
            price: "money",
            downPayment: "money",
            marketRent: "money",
            mortgage: "money",
            expenses: "money",
            taxes: "money",
            vacancy: "percent"
        },
        result: {
            breakEvenRent: "money",
            breakEvenPrice: "money",
            winner: "text"      
        }
    },
    

    cash_flow: {
        input: {
            rent: "money",
            vacancy: "percent",
            mortgage: "money",
            expenses: "money",
            taxes: "percent",
            inflation: "percent"
        },
        result: {
            netIncome: "money",
            totalExpenses: "money",
            cashFlowMonth: "money",
            cashFlowYear: "money",
            realCashFlowMonth: "money",
            realCashFlowYear: "money",
            stressCashFlow: "money",
            status: "text"
        }
    },

    property_irr: {
        input: {
            price: "money",
            downPayment: "money",
            purchaseCosts: "money",
            renovation: "money",
            rent: "money",
            vacancy: "percent",
            expenses: "money",
            mortgage: "money",
            years: "years",
            growth: "percent",
            saleTax: "percent",
            inflation: "percent"
        },
        result: {
            cashFlow: "money",
            roi: "percent",
            irr: "percent",
            realIRR: "percent",
            paybackYears: "payback"
        }
    },

    mortgage: {
        input: {
            price: "money",
            down: "money",
            ratePercent: "percent",
            termYears: "years"
        },
        result: {
            monthlyPayment: "money",
            totalPayment: "money",
            totalInterest: "money"
        }
    },

    ownership_cost: {
        input: {
            price: { type: "money", min: 1, max: 50_000_000 },
            years: { type: "years", min: 1, max: 100 },

            // annual property tax rate (% of price)
            taxPercent: { type: "percent", min: 0, max: 90 },

            // annual maintenance (nominal $)
            maintenance: { type: "money", min: 0, max: 10_000_000 },

            // % per year (can be negative)
            inflation: { type: "percent", min: -5, max: 40 }
        },

        result: {
            // ✅ canonical (new)
            years: "years",

            totalOwnershipCost: "money",      // nominal total incl. purchase price
            totalOwnershipCostPV: "money",    // PV total incl. purchase price

            totalTaxes: "money",              // nominal sum of taxes (years 1..N)
            totalMaintenance: "money",         // nominal sum of maintenance (years 1..N)
            totalTaxesPV: "money",             // PV of taxes
            totalMaintenancePV: "money",       // PV of maintenance

            costAsPercentOfPrice: "percent",   // totalOwnershipCost / price * 100
            taxesSharePercent: "percent",      // totalTaxes / totalOwnershipCost * 100
            maintenanceSharePercent: "percent",// totalMaintenance / totalOwnershipCost * 100

            // ✅ backward compat (old UI / old storage)
            totalCost: "money",
            totalCostPV: "money"
        }
    },


    property_sale: {
        input: {
            buyPrice: "money",
            sellPrice: "money",
            years: "years",
            tax: "percent",
            commission: "percent",
            inflation: "percent",
            renovation: "money"
        },
        result: {
            taxAmount: "money",
            commissionAmount: "money",
            netProfit: "money",
            annualReturn: "percent",
            realReturn: "percent"
        }
    },

    property_taxes: {
        input: {
            price: "money",
            rent: "money",
            years: "years",
            priceGrowth: "percent",
            propertyTax: "percent",
            rentTax: "percent",
            annualFees: "money",
            feeGrowth: "percent",
            saleTax: "percent",
            agentFee: "percent",
            inflationRate: "percent"
        },
        result: {
            totalTaxes: "money",
            totalFees: "money",
            totalRentNet: "money",
            finalProfit: "money",
            finalProfitPV: "money",
            simpleROI: "percent",
            realROI: "percent",
            taxBurdenPercent: "percent"
        }
    },

    mortgage_overpayment: {
        input: {
            loan: "money",
            rate: "percent",
            years: "years",
            inflation: "percent"
        },
        result: {
            monthlyPayment: "money",
            nominalOverpayment: "money",
            realOverpayment: "money",
            realInterestRate: "percent"
        }
    },

    renovation_roi: {
        input: {
            priceBefore: "money",
            rentBefore: "money",
            renovationCost: "money",
            priceIncrease: "percent",
            rentIncrease: "percent",
            agentFee: "percent",
            saleTax: "percent",
            years: "years",
            discountRate: "percent",
            inflationRate: "percent"
        },
        result: {
            priceAfter: "money",
            rentAfter: "money",
            totalExtraRent: "money",
            totalExtraRentPV: "money",
            saleProfit: "money",
            netProfit: "money",
            netProfitPV: "money",
            roi: "percent",
            roiPV: "percent",
            payback: "payback"
        }

    },

    rent_vs_buy: {
        input: {
            rent: "money",
            mortgage: "money",
            years: "years",
            propertyValue: "money",
            rentGrowth: "percent",
            mortgageRate: "percent",
            propertyGrowth: "percent",
            inflation: "percent"
        },
        result: {
            rentTotal: "money",
            mortgagePaid: "money",
            buyNetCost: "money",
            winner: "text"
        }
    }
};


function renderWarnings(calc) {
    if (!calc || !calc.result_data) return null;
    
    const box = document.createElement("div");
    const r = calc.result_data;
    const i = calc.input_data;

    if (typeof r.payback === "number" && typeof i.years === "number") {
        const horizonMonths = i.years * 12;
        const paybackMonths = r.payback * 12;

        if (paybackMonths > horizonMonths) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ Payback period exceeds selected investment horizon.";
            box.appendChild(w);
        }
    }

    if (calc.calculator_type === "break_even") {
        const r = calc.result_data;
        const i = calc.input_data;

        if (i.vacancy > 20) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent = "⚠️ High vacancy assumption (>20%).";
            box.appendChild(w);
        }

        if (r.breakEvenRent > i.price * 0.012) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent="⚠️ Required rent exceeds 1.2% of purchase price.";
            box.appendChild(w);
        }

        if (i.mortgage === 0) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent="ℹ️ Mortgage not included. Results assume cash purchase.";
            box.appendChild(w);
        }
    }

    if (calc.calculator_type === "property_taxes") {
        const r = calc.result_data;

        if (r.taxBurdenPercent > 60) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ High effective tax rate. Consider legal tax optimization strategies.";
            box.appendChild(w);
        }
    }
    
    if (calc.calculator_type === "ownership_cost") {
        const price = Number(i.price || 0);
        const total = Number(r.totalOwnershipCost ?? r.totalCost ?? 0);
        const real = Number(r.totalOwnershipCostPV ?? r.totalCostPV ?? 0);
        const years = Number(i.years || 0);
        const tax = Number(i.taxPercent || 0);
        const maintenance = Number(i.maintenance || 0);

        if (!price) return null;

        // if (real > price * 2) {
        //     const w = document.createElement("div");
        //     w.className = "verdict warn";
        //     w.textContent =
        //         "⚠️ Total real ownership cost exceeds 2x property price.";
        //     return w;
        // }

        // ⚠️ Высокие налоги
        if (tax > 5) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ High annual property tax (>5% of property price).";
            box.appendChild(w);
        }

        // ⚠️ Высокое обслуживание
        if (maintenance > price * 0.03) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ High maintenance costs (>3% of property price per year).";
            box.appendChild(w);
        }

        // ⚠️ Очень длинный период владения
        if (years > 50) {
            const w = document.createElement("div");
            w.className = "verdict warn";
            w.textContent =
                "⚠️ Very long ownership period (>50 years). Forecast reliability is low.";
            box.appendChild(w);
        }
    }

    return box.childNodes.length ? box : null;
}

function renderInputData(calc) {
    const ul = document.createElement("ul");
    ul.className = "input-list";

    const schema = CALC_FORMATS[calc.calculator_type]?.input || {};

    for (const key in schema) {
        const raw = calc.input_data?.[key];
        if (raw === undefined || raw === null) continue;

        const li = document.createElement("li");

        const type = schema[key] || "number";
        const formatter = FORMAT[type] || FORMAT.number;

        li.textContent = `${humanInputName(key)}: ${formatter(raw)}`;
        ul.appendChild(li);
    }

    return ul;
}


function renderResultData(calc) {
    const table = document.createElement("table");
    table.className = "result-table";

    const r = calc.result_data;

    const schema = CALC_FORMATS[calc.calculator_type]?.result || {};

    for (const key in schema) {
        if (!(key in r)) continue;

        const raw = r[key];
        if (raw === undefined || raw === null) continue;

        const row = document.createElement("tr");

        const name = document.createElement("td");
        name.textContent = humanize(key);

        const value = document.createElement("td");
        const type = schema[key] ?? "number";
        const formatter = FORMAT[type] || FORMAT.number;

        value.textContent = formatter(raw);

        const negativeMetrics = [
            "totalInterest", "taxAmount", "commissionAmount", "totalPayment",
            "totalCost", "totalCostPV",
            "totalOwnershipCost", "totalOwnershipCostPV",
            "totalExpenses"
        ];

        if (key === "realIRR") {
            if (raw > 0) value.classList.add("value-positive");
            else value.classList.add("value-negative");
            value.classList.add("result-highlight");
        }

        if (typeof raw === "number") {
            if (negativeMetrics.includes(key)) {
                if (raw > 0) value.classList.add("value-negative");
            } else {
                if (raw > 0) value.classList.add("value-positive");
                if (raw < 0) value.classList.add("value-negative");
            }
        }

        if (["roi", "roiPV", "netProfit", "netProfitPV", "irr"].includes(key)) {
            value.classList.add("result-highlight");
        }

        row.appendChild(name);
        row.appendChild(value);
        table.appendChild(row);
    }

    return table;
}



function renderVerdict(calc) {
    if (!calc || !calc.result_data) {
        const v = document.createElement("div");
        v.className = "verdict info";
        v.textContent = "ℹ️ Result data not available.";
        return v;
    }

    const type = calc.calculator_type;

    switch (type) {
        // инвестиционные калькуляторы
        case "property_irr":
        case "renovation_roi":
        case "alternative_investment":
        case "property_sale":
        case "property_taxes":
            return investmentVerdict(calc);

        // cash flow отдельный обработчик
        case "cash_flow":
            return cashFlowVerdict(calc);


        // сравнительные калькуляторы
        case "rent_vs_buy":
            return rentVsBuyVerdict(calc);

        case "break_even":
            return comparisonVerdict(calc);

        // стоимость / кредиты
        case "mortgage":
        case "mortgage_overpayment":
        case "ownership_cost":
            return costVerdict(calc);

        default:
            const v = document.createElement("div");
            v.className = "verdict info";
            v.textContent = "ℹ️ Verdict not available for this calculator.";
            return v;
    }
}



function investmentVerdict(calc) {
    const v = document.createElement("div");
    v.className = "verdict";
    
    const r = calc.result_data;

    if(calc.calculator_type === "renovation_roi"){
        if ((typeof r.netProfitPV === "number" && r.netProfitPV <= 0) ||
            (typeof r.roiPV === "number" && r.roiPV <= 0)) {
            v.classList.add("bad");
            v.textContent = "❌ This investment is not profitable when discounted at the given rate.";
        } else if ((typeof r.netProfit === "number" && r.netProfit <= 0) ||
            (typeof r.roi === "number" && r.roi <= 0)) {
            v.classList.add("warn");
            v.textContent = "⚠️ Investment is profitable nominally but loses value after discounting.";
        } else {
            v.classList.add("good");
            v.textContent = "✅ This investment looks profitable even after discounting.";
        }
        return v;
    }

    else if (calc.calculator_type === "alternative_investment") {
        const r = calc.result_data;
        const diff = Number(r.difference || 0);

        if (diff > 0) {
            v.classList.add("good");
            v.textContent = "✅ Alternative investment outperforms property after taxes and inflation.";
        } else if (diff < 0) {
            v.classList.add("good");
            v.textContent = "✅ Property outperforms alternative investment after taxes and inflation.";
        } else {
            v.classList.add("info");
            v.textContent = "ℹ️ Results are close — property and alternative investments are nearly equal.";
        }
        return v;
    }

    else if (calc.calculator_type === "property_taxes") {
        const r = calc.result_data;

        const finalPV = Number(r.finalProfitPV || 0);
        const finalNominal = Number(r.finalProfit || 0);
        const realROI = Number(r.realROI || 0);
        const simpleROI = Number(r.simpleROI || 0);

        // ❌ Реально убыточно
        if (finalPV <= 0 || realROI <= 0) {
            v.classList.add("bad");
            v.textContent =
                "❌ This investment loses value after inflation, taxes, and fees.";
        }
        // ⚠️ Номинально ок, реально плохо
        else if (finalNominal > 0 && finalPV <= finalNominal * 0.3) {
            v.classList.add("warn");
            v.textContent =
                "⚠️ Nominal profit exists, but inflation significantly reduces returns.";
        }
        // ✅ Всё хорошо
        else {
            v.classList.add("good");
            v.textContent =
                "✅ Investment remains profitable after taxes and inflation.";
        }

        return v;
    }

    else if (calc.calculator_type === "property_sale") {
        const r = calc.result_data;

        const net = Number(r.netProfit || 0);
        const annual = Number(r.annualReturn || 0);
        const real = Number(r.realReturn || 0);

        // ❌ убыточно в реальности
        if (net <= 0 || real <= 0) {
            v.classList.add("bad");
            v.textContent =
                "❌ Sale results in a loss after inflation and costs.";
        }
        // ⚠️ номинально ок, реально слабо
        else if (real < 2) {
            v.classList.add("warn");
            v.textContent =
                "⚠️ Sale is profitable nominally, but real return is very low.";
        }
        // 🟡 нормально, но не инвестиционно
        else if (real < 5) {
            v.classList.add("info");
            v.textContent =
                "ℹ️ Sale preserves capital with modest real growth.";
        }
        // ✅ сильная продажа
        else {
            v.classList.add("good");
            v.textContent =
                "✅ Sale delivers strong real annual return.";
        }

        return v;
    }

    else if (calc.calculator_type === "property_irr") {
        const realIRR = Number(r.realIRR || 0);
        const irr = Number(r.irr || 0);

        // ❌ реально убыточно
        if (realIRR <= 0) {
            v.classList.add("bad");
            v.textContent = "❌ Investment loses value after inflation (real IRR ≤ 0%).";
        }
        // ⚠️ номинально прибыльно, но реальная доходность низкая
        else if (realIRR > 0 && realIRR < 5) {
            v.classList.add("warn");
            v.textContent = `⚠️ Investment nominally profitable (IRR ${irr.toFixed(2)}%), but real IRR is low (${realIRR.toFixed(2)}%).`;
        }
        // ✅ нормально
        else {
            v.classList.add("good");
            v.textContent = `✅ Investment looks profitable after inflation (real IRR ${realIRR.toFixed(2)}%).`;
        }

        return v;
    }

    // Общая логика для других инвесткалькуляторов
    
    if ((typeof r.irr === "number" && r.irr < 7) ||
        (typeof r.netProfit === "number" && r.netProfit <= 0) ||
        (typeof r.roi === "number" && r.roi <= 0)) {
        v.classList.add("bad");
        v.textContent = "❌ This investment is not profitable based on provided inputs.";
    } else {
        v.classList.add("good");
        v.textContent = "✅ This investment looks profitable based on provided inputs.";
    }
    return v;

}



function cashFlowVerdict(calc) {
    if (!calc || !calc.result_data) return null;

    const r = calc.result_data;
    const i = calc.input_data;

    /* ❌ Реальный cash flow отрицательный */
    if (r.realCashFlowMonth < 0) {
        const v = document.createElement("div");
        v.className = "verdict negative";
        v.textContent =
            "❌ Real cash flow is negative after inflation. Investment loses purchasing power.";
        return v;
    }

    /* ⚠️ Stress test не выдержан */
    if (r.stressCashFlow < 0) {
        const v = document.createElement("div");
        v.className = "verdict warn";
        v.textContent =
            "⚠️ Investment fails stress test (vacancy +5%, expenses +10%).";
        return v;
    }

    /* ⚠️ Высокая вакансия */
    if (i.vacancy > 15) {
        const v = document.createElement("div");
        v.className = "verdict warn";
        v.textContent =
            "⚠️ High vacancy assumption. Income may be unstable.";
        return v;
    }

    /* ⚠️ Ипотека слишком большая */
    if (i.mortgage > i.rent * 0.6) {
        const v = document.createElement("div");
        v.className = "verdict warn";
        v.textContent =
            "⚠️ Mortgage exceeds 60% of rent. High leverage risk.";
        return v;
    }

    /* ✅ Хорошая инвестиция */
    if (r.cashFlowMonth > i.rent * 0.1) {
        const v = document.createElement("div");
        v.className = "verdict positive";
        v.textContent =
            "✅ Strong positive cash flow with inflation protection.";
        return v;
    }

    const v = document.createElement("div");
    v.className = "verdict info";
    v.textContent =
        "ℹ️ Cash flow is close to break-even. Small changes may affect profitability.";
    return v;
}

function rentVsBuyVerdict(calc) {
    const v = document.createElement("div");
    v.className = "verdict";

    const winner = String(calc.result_data?.winner || "").toLowerCase();

    if (winner === "buy") {
        v.classList.add("good");
        v.textContent = "✅ Buying is more cost-effective over this period.";
        return v;
    }

    if (winner === "rent") {
        v.classList.add("warn");
        v.textContent = "⚠️ Renting is more cost-effective over this period.";
        return v;
    }

    v.classList.add("info");
    v.textContent = "ℹ️ Results are close — analyze assumptions carefully.";
    return v;
}


function comparisonVerdict(calc) {
    const v = document.createElement("div");
    v.className = "verdict";

    const r = calc.result_data || {};
    const i = calc.input_data || {};

    const winner = String(r.winner || "").toLowerCase();

    const breakEvenRent = Number(r.breakEvenRent);
    const marketRent = Number(i.marketRent);

    // если есть winner — показываем понятный вердикт
    if (winner === "property") {
        v.classList.add("good");
        v.textContent = "✅ Market rent covers break-even rent. Deal is cash-flow viable.";
        return v;
    }
    if (winner === "rent") {
        v.classList.add("bad");
        v.textContent = "❌ Market rent is below break-even rent. Deal is cash-flow negative.";
        return v;
    }

    // fallback (если winner почему-то не сохранился)
    if (Number.isFinite(breakEvenRent) && Number.isFinite(marketRent)) {
        if (marketRent >= breakEvenRent) {
            v.classList.add("good");
            v.textContent = "✅ Break-even rent looks achievable under current assumptions.";
        } else {
            v.classList.add("bad");
            v.textContent = "❌ Break-even rent is above market rent. Risk of negative cash flow.";
        }
        return v;
    }

    v.classList.add("info");
    v.textContent = "ℹ️ Not enough data to generate break-even verdict.";
    return v;
}


// -------------------------
// Стоимость / кредиты
// -------------------------
function costVerdict(calc) {
    const v = document.createElement("div");
    v.className = "verdict";

    const r = calc.result_data;

    // mortgage
    if (calc.calculator_type === "mortgage") {
        const loan = Number(calc.input_data.price || 0) - Number(calc.input_data.down || 0);
        const totalInterest = Number(r.totalInterest || 0);

        if (!loan || !totalInterest) {
            v.classList.add("info");
            v.textContent = "ℹ️ Not enough data to evaluate loan cost.";
        } else if (totalInterest / loan > 0.8) {
            v.classList.add("bad");
            v.textContent = "❌ Very expensive loan cost: total interest is high versus principal.";
        } else if (totalInterest / loan > 0.4) {
            v.classList.add("warn");
            v.textContent = "⚠️ High-interest loan. Strong cash flow is required.";
        } else {
            v.classList.add("good");
            v.textContent = "✅ Loan cost is acceptable.";
        }

        return v;
    }

    // mortgage_overpayment
    if (calc.calculator_type === "mortgage_overpayment") {
        const loan = Number(calc.input_data.loan || 0);
        const nominal = Number(r.nominalOverpayment || 0);
        const real = Number(r.realOverpayment || 0);

        if (!loan || !nominal) {
            v.classList.add("info");
            v.textContent = "ℹ️ Not enough data to evaluate overpayment.";
        }
        // сначала смотрим реальную переплату
        else if (real / loan > 0.6) {
            v.classList.add("bad");
            v.textContent = "❌ High real overpayment even after inflation.";
        }
        else if (real / loan > 0.3) {
            v.classList.add("warn");
            v.textContent = "⚠️ Moderate real overpayment after inflation.";
        }
        // если реальная ок, но номинальная высокая
        else if (nominal / loan > 0.5) {
            v.classList.add("info");
            v.textContent = "ℹ️ Nominal overpayment is high, but inflation reduces real cost.";
        }
        else {
            v.classList.add("good");
            v.textContent = "✅ Loan overpayment is acceptable in real terms.";
        }

        return v;
    }

    if (calc.calculator_type === "ownership_cost") {
        const price = Number(calc.input_data.price || 0);
        const total = Number(r.totalOwnershipCost ?? r.totalCost ?? 0);
        const real = Number(r.totalOwnershipCostPV ?? r.totalCostPV ?? 0);

        if (!price || !total) {
            v.classList.add("info");
            v.textContent = "ℹ️ Ownership cost data unavailable.";
        }
        else if (real > price * 2) {
            v.classList.add("bad");
            v.textContent =
                "❌ Total real ownership cost exceeds 2× property price. Ownership is inefficient.";
        }
        else if (real > price * 1.3) {
            v.classList.add("warn");
            v.textContent =
                "⚠️ Ownership costs are high relative to property price.";
        }
        else {
            v.classList.add("good");
            v.textContent =
                "✅ Ownership costs are reasonable relative to property value.";
        }

        return v;
    }

    return v;
}


function renderInputSection(calc) {
    const wrapper = document.createElement("div");

    const toggle = document.createElement("div");
    toggle.className = "details-toggle";
    toggle.textContent = "Show input data";

    const content = renderInputData(calc);
    content.classList.add("hidden");

    toggle.addEventListener("click", () => {
        const open = !content.classList.contains("hidden");
        content.classList.toggle("hidden");
        toggle.textContent = open ? "Show input data" : "Hide input data";
    });

    wrapper.appendChild(toggle);
    wrapper.appendChild(content);

    return wrapper;
}

// Рассчеты 

let openedDetails = null;
let openedButton = null;

function openCalculation(calc, container, button) {
     if (openedDetails && openedDetails !== container) {
         openedDetails.classList.add("hidden");
         openedDetails.textContent = "";
         if (openedButton) openedButton.textContent = "▶ Open";
     }
    

    const isOpen = !container.classList.contains("hidden");

     if (isOpen) {
         container.classList.add("hidden");
         container.textContent = "";
         button.textContent = "▶ Open";
         openedDetails = null;
         openedButton = null;
         return;
     }
   

    container.textContent = "";
    container.classList.remove("hidden");
    button.textContent = "▼ Close";

    openedDetails = container;
    openedButton = button;

    const verdictEl = renderVerdict(calc);
    container.appendChild(verdictEl);

    const isBad = verdictEl.classList.contains("bad") ||
        verdictEl.classList.contains("negative");

    const warning = renderWarnings(calc);
    if (warning && !isBad) {
        container.appendChild(warning);
    }
    //input
    const inputTitle = document.createElement("h4");
    inputTitle.textContent = "Input data";
    container.appendChild(inputTitle);
    try {
        container.appendChild(renderInputSection(calc));
    } catch (e) {
        container.textContent = "Failed to render section.";
    }
    //results
    const resultTitle = document.createElement("h4");
    resultTitle.textContent = "Result";
    container.appendChild(resultTitle);
    try {
        container.appendChild(renderResultData(calc));
    } catch (e) {
        container.textContent = "Failed to render results.";
    }

    const toolsDock = document.createElement("div");
    toolsDock.className = "calc-tools-dock";
    container.appendChild(toolsDock);
    mountExportPdfButton(toolsDock, calc.id, {
        title: "Share-ready report",
        note: "Export this exact deal as a clean PDF report in one click.",
        buttonText: "Export PDF report (1 credit)"
    });
    
}

function formatCalcDatesToLocal() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";

    document.querySelectorAll(".calc-date[data-iso]").forEach(el => {
        // если SSR уже положил текст и пометил is-ready — не трогаем
        if (el.classList.contains("is-ready") && el.textContent.trim()) return;

        const d = new Date(el.dataset.iso);
        el.textContent = Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
        el.classList.add("is-ready");
    });

    const lastEl = document.getElementById("lastCalc");
    if (lastEl?.dataset?.iso) {
        if (!(lastEl.classList.contains("is-ready") && lastEl.textContent.trim())) {
            const d = new Date(lastEl.dataset.iso);
            lastEl.textContent = Number.isFinite(d.getTime()) ? d.toLocaleDateString() : "—";
            lastEl.classList.add("is-ready");
        }
    }
}
document.addEventListener("DOMContentLoaded", formatCalcDatesToLocal, { once: true });




// ------------------------
// Удаление расчёта
// ------------------------
let deleteTargetId = null;
let deleteTargetRow = null;

const modal = document.getElementById("deleteModal");
const confirmBtn = document.getElementById("confirmDelete");
const cancelBtn = document.getElementById("cancelDelete");

function showDeleteModal(id, row) {
    if (!modal) return;
    deleteTargetId = id;
    deleteTargetRow = row;
    modal.classList.add("open");
}

// Подтверждение удаления
if (confirmBtn) {
    confirmBtn.addEventListener("click", async () => {
        if (!deleteTargetId || !deleteTargetRow) return;

        await ensureCsrfToken();
        fetch(`/api/app/calculation/${deleteTargetId}`, {
            method: "DELETE",
            headers: withCsrfHeaders({}),
            credentials: "include"
        })
            .then(res => {
                if (res.ok) {
                    // Удаляем элемент только если он реально существует
                    if (deleteTargetRow.parentNode) {
                        deleteTargetRow.remove();
                    }

                    // Обновляем счётчик
                    const counter = document.getElementById("totalCalcs");
                    if (counter) {
                        let value = parseInt(counter.textContent, 10);
                        if (!isNaN(value) && value > 0) counter.textContent = value - 1;
                    }

                    // Если список пустой
                    const box = document.getElementById("calculations");
                    if (box && box.querySelectorAll(".calc-item").length === 0) {
                        const emptyDiv = document.createElement("div");
                        emptyDiv.className = "muted";
                        emptyDiv.textContent = "No calculations yet";
                        box.appendChild(emptyDiv);

                        const lastCalc = document.getElementById("lastCalc");
                        if (lastCalc) lastCalc.textContent = "—";
                    }
                    if (box) syncSparseCalculationsState(box);
                }
            })
            .catch(console.error)
            .finally(() => {
                modal.classList.remove("open");
                deleteTargetId = null;
                deleteTargetRow = null;
            });
    });
}
    

// Отмена
if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
        if (!modal) return;
        modal.classList.remove("open");
        deleteTargetId = null;
        deleteTargetRow = null;
    });
}

document.addEventListener("DOMContentLoaded", () => {
    const list = document.getElementById("calculations");
    const search = document.getElementById("calcSearch");
    const creditsNode = document.getElementById("walletCredits");
    const freeNode = document.getElementById("walletFree");

    const updateWallet = (wallet) => {
        const w = wallet || (window.__BOOT__ && window.__BOOT__.account && window.__BOOT__.account.wallet) || {};
        const credits = Number(w.credits || 0);
        const freeUsed = !!w.free_used;

        if (creditsNode) creditsNode.textContent = "Credits: " + credits;
        if (freeNode) freeNode.textContent = freeUsed ? "Free verdict: used" : "Free verdict: available";
    };

    const bindWalletHook = () => {
        if (typeof window.applyWalletToAiButtons !== "function") return;
        if (window.applyWalletToAiButtons.__premiumHooked) return;

        const original = window.applyWalletToAiButtons;
        const wrapped = function (wallet) {
            const out = original.call(this, wallet);
            updateWallet(wallet);
            return out;
        };
        wrapped.__premiumHooked = true;
        window.applyWalletToAiButtons = wrapped;
    };

    const filterList = () => {
        if (!list || !search) return;
        const q = String(search.value || "").trim().toLowerCase();
        list.querySelectorAll(".calc-item").forEach((item) => {
            const title = (item.querySelector(".calc-title") && item.querySelector(".calc-title").textContent || "").toLowerCase();
            const date = (item.querySelector(".calc-date") && item.querySelector(".calc-date").textContent || "").toLowerCase();
            const show = !q || title.includes(q) || date.includes(q);
            item.style.display = show ? "" : "none";
        });
    };

    if (search) search.addEventListener("input", filterList);
    if (list) {
        const mo = new MutationObserver(() => {
            filterList();
            updateWallet();
        });
        mo.observe(list, { childList: true, subtree: true });
    }

    bindWalletHook();
    updateWallet();
    filterList();
});
