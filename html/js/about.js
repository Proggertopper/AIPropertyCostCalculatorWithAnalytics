(function () {
    const TOTAL_CALC_TYPES = 11;

    const refs = {
        calcs: document.getElementById("sig-calcs"),
        calcsNote: document.getElementById("sig-calcs-note"),
        coverage: document.getElementById("sig-coverage"),
        coverageNote: document.getElementById("sig-coverage-note"),
        last: document.getElementById("sig-last"),
        lastNote: document.getElementById("sig-last-note"),
        scenarios: document.getElementById("sig-scenarios"),
        scenariosNote: document.getElementById("sig-scenarios-note"),
        readiness: document.getElementById("sig-readiness"),
        readinessNote: document.getElementById("sig-readiness-note"),
        mode: document.getElementById("sig-mode"),
        modeNote: document.getElementById("sig-mode-note")
    };

    function setGuestMode(reason) {
        if (refs.calcs) refs.calcs.textContent = "0";
        if (refs.calcsNote) refs.calcsNote.textContent = reason || "Login to show personal activity";

        if (refs.coverage) refs.coverage.textContent = "0/11";
        if (refs.coverageNote) refs.coverageNote.textContent = "Unique calculator families used";

        if (refs.last) refs.last.textContent = "--";
        if (refs.lastNote) refs.lastNote.textContent = "No account timeline in guest mode";

        if (refs.scenarios) refs.scenarios.textContent = "--";
        if (refs.scenariosNote) refs.scenariosNote.textContent = "Scenario analytics available after login";

        if (refs.readiness) refs.readiness.textContent = "Low";
        if (refs.readinessNote) refs.readinessNote.textContent = "Run at least 5 calculations for portfolio insights";

        if (refs.mode) refs.mode.textContent = "Guest";
        if (refs.modeNote) refs.modeNote.textContent = "Login unlocks personalized trust signals";
    }

    function setLoggedMode() {
        if (refs.mode) refs.mode.textContent = "Account";
        if (refs.modeNote) refs.modeNote.textContent = "Real data from your current session";
    }

    function formatDate(iso) {
        if (!iso) return "--";
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "--";
        return d.toLocaleString();
    }

    function readinessLabel(calcCount, coveragePercent, scenarioRatio) {
        let score = 0;
        if (calcCount >= 5) score += 1;
        if (coveragePercent >= 35) score += 1;
        if (scenarioRatio >= 0.8) score += 1;

        if (score >= 3) return "High";
        if (score === 2) return "Medium";
        return "Low";
    }

    async function fetchJson(url) {
        const r = await fetch(url, { credentials: "include" });
        if (r.status === 401) {
            const e = new Error("UNAUTHORIZED");
            e.code = 401;
            throw e;
        }
        if (!r.ok) {
            const e = new Error("REQUEST_FAILED");
            e.code = r.status;
            throw e;
        }
        return r.json();
    }

    async function hydrateTrustSignals() {
        try {
            const calcData = await fetchJson("/api/calculations/list?limit=20");
            const items = Array.isArray(calcData?.items) ? calcData.items : [];
            setLoggedMode();

            const calcCount = items.length;
            const typeCount = new Set(items.map((x) => String(x.type || ""))).size;
            const coveragePercent = Math.round((typeCount / TOTAL_CALC_TYPES) * 100);

            if (refs.calcs) refs.calcs.textContent = String(calcCount);
            if (refs.calcsNote) refs.calcsNote.textContent = calcCount > 0 ? "Recent calculations loaded" : "Start with your first calculator run";

            if (refs.coverage) refs.coverage.textContent = typeCount + "/" + TOTAL_CALC_TYPES;
            if (refs.coverageNote) refs.coverageNote.textContent = coveragePercent + "% model coverage";

            const lastCreatedAt = items[0]?.createdAt || null;
            if (refs.last) refs.last.textContent = formatDate(lastCreatedAt);
            if (refs.lastNote) refs.lastNote.textContent = lastCreatedAt ? "Latest saved run in your account" : "No saved runs yet";

            let scenarioRatio = 0;
            if (items[0]?.id) {
                try {
                    const cached = await fetchJson("/api/scenarios/cached?calculationId=" + encodeURIComponent(String(items[0].id)));
                    if (cached?.has) {
                        const requested = Number(cached.requestedCount || 0);
                        const generated = Number(cached.generatedCount || 0);
                        scenarioRatio = requested > 0 ? (generated / requested) : 0;
                        if (refs.scenarios) refs.scenarios.textContent = generated + "/" + requested;
                        if (refs.scenariosNote) refs.scenariosNote.textContent = "Latest scenario pack completion";
                    } else {
                        if (refs.scenarios) refs.scenarios.textContent = "0/0";
                        if (refs.scenariosNote) refs.scenariosNote.textContent = "No scenario analysis cached yet";
                    }
                } catch (_) {
                    if (refs.scenarios) refs.scenarios.textContent = "--";
                    if (refs.scenariosNote) refs.scenariosNote.textContent = "Scenario endpoint unavailable right now";
                }
            }

            const readiness = readinessLabel(calcCount, coveragePercent, scenarioRatio);
            if (refs.readiness) refs.readiness.textContent = readiness;
            if (refs.readinessNote) {
                if (readiness === "High") refs.readinessNote.textContent = "Good depth for compare, optimizer, and portfolio summary";
                else if (readiness === "Medium") refs.readinessNote.textContent = "Add more runs to improve confidence and coverage";
                else refs.readinessNote.textContent = "Run more calculators and scenarios for stronger evidence";
            }
        } catch (e) {
            if (e && e.code === 401) {
                setGuestMode("Login to load your real trust metrics");
                return;
            }

            setGuestMode("Live metrics temporarily unavailable");
        }
    }

    hydrateTrustSignals();
})();
