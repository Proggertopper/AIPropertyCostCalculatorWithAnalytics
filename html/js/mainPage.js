function initHomeToolsToggle() {
    const toggle = document.getElementById("toolsToggle");
    const toolsGrid = document.querySelector(".home-tools-grid");
    const extras = Array.from(document.querySelectorAll(".home-tools-grid .is-extra"));

    if (toggle && toolsGrid && extras.length) {
        let expanded = false;

        const syncToggle = () => {
            toolsGrid.classList.toggle("is-expanded", expanded);
            toggle.setAttribute("aria-expanded", String(expanded));
            toggle.textContent = expanded ? "Show fewer tools" : `Show ${extras.length} more tools`;
        };

        toggle.addEventListener("click", (e) => {
            e.preventDefault();
            expanded = !expanded;
            syncToggle();
        });

        syncToggle();
    } else if (toggle) {
        toggle.hidden = true;
    }

    if (window.location.hash === "#_=_") {
        history.replaceState(null, "", window.location.href.split("#")[0]);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHomeToolsToggle, { once: true });
} else {
    initHomeToolsToggle();
}
