#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = process.cwd();
const HTML_ROOT = path.join(PROJECT_ROOT, "html");
const SITE_URL = "https://mypropertycost.com";
const DEFAULT_OG_IMAGE = `${SITE_URL}/images/main_2_image.jpg`;

const titleOverrides = {
    "/": "PropertyCost — Real Estate Calculators and Deal Analysis",
    "/about/": "About PropertyCost — Real Estate Analysis Platform",
    "/blog/": "PropertyCost Blog — Real Estate Guides & Calculator Tips",
    "/calculators/": "Real Estate Calculators — Mortgage, IRR, Cash Flow | PropertyCost",
    "/contact/": "Contact PropertyCost — Support and Partnership",
    "/disclaimer/": "PropertyCost Disclaimer — Informational Use Only",
    "/examples/": "PropertyCost Output Examples — Verdicts, Scenarios, and PDFs",
    "/mortgage/calculator/": "Mortgage Calculator — Payment and Interest | PropertyCost",
    "/pricing/": "PropertyCost Pricing — Credits for Analysis and PDF Reports",
    "/privacy/": "PropertyCost Privacy Policy — Data and Cookies",
    "/terms/": "PropertyCost Terms — Platform Use and Payments"
};

const descriptionOverrides = {
    "/": "Use PropertyCost calculators to compare rent vs buy, mortgage, taxes, cash flow, and returns with scenario testing and clear deal verdicts.",
    "/about/": "Learn how PropertyCost helps buyers and investors evaluate real estate decisions with calculators, scenario analysis, and practical verdict workflows.",
    "/blog/": "Read PropertyCost blog guides on rent vs buy, mortgage math, property taxes, cash flow, and investment returns to make better real estate decisions.",
    "/break-even/": "Use the Break-Even hub to calculate payback timelines and learn break-even formulas, contribution margin, fixed vs variable costs, and sensitivity tests.",
    "/calculators/": "Browse all PropertyCost real estate calculators for mortgage, IRR, cash flow, ownership cost, taxes, and renovation ROI analysis.",
    "/cash-flow/": "Use the Cash Flow hub to estimate rental cash flow and learn NOI, DSCR, vacancy impact, CapEx reserves, and common cash flow mistakes.",
    "/contact/": "Contact PropertyCost for support, feedback, and partnership questions about calculators, analysis workflows, and platform access.",
    "/disclaimer/": "Review the PropertyCost disclaimer to understand informational use, limitations, and responsibility before making financial decisions.",
    "/examples/": "See sample PropertyCost outputs including verdicts, scenario packs, deep dives, compare reports, portfolio summaries, and PDF previews.",
    "/homeownership-cost/": "Use the Homeownership Cost hub to estimate true ownership cost and learn hidden costs, maintenance, taxes, insurance, HOA, and sale friction.",
    "/irr/": "Use the IRR hub to calculate internal rate of return and learn IRR vs NPV, XIRR, hurdle rate, multiple IRRs, and real estate return analysis.",
    "/mortgage/": "Use the Mortgage hub to estimate payments and explore APR vs rate, amortization, PMI, refinance break-even, and extra payment strategies.",
    "/mortgage-overpayment/": "Use the Mortgage Overpayment hub to model extra principal payments, payoff time, interest savings, and refinance vs prepay decisions.",
    "/mortgage/calculator/": "Estimate monthly payment, total interest, and amortization with the PropertyCost mortgage calculator, then test assumptions with scenarios.",
    "/property-sale/": "Use the Property Sale hub to estimate net proceeds and learn pricing strategy, selling costs, negotiation, and timing decisions for home sales.",
    "/property-tax/": "Use the Property Tax hub to estimate annual taxes and learn assessed value, millage rates, reassessment risk, escrow, and appeal strategy.",
    "/pricing/": "Compare PropertyCost credit packs for Full Analysis, scenario tools, deal compare, portfolio summaries, and PDF report export. No subscription.",
    "/privacy/": "Read the PropertyCost privacy policy for data handling, cookies, analytics, and account security practices.",
    "/renovation-roi/": "Use the Renovation ROI hub to estimate upgrade payback and learn which renovations add value by project type, city, and selling timeline.",
    "/rent-or-invest/": "Use the Rent or Invest hub to compare buying real estate vs investing capital with scenario analysis for returns, risk, and liquidity.",
    "/rent-vs-buy/": "Use the Rent vs Buy hub to compare long-term housing decisions with break-even analysis, taxes, maintenance, inflation, and opportunity cost.",
    "/terms/": "Read PropertyCost terms for platform rules, acceptable use, account responsibilities, payments, and refund policy details."
};

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSpace(str = "") {
    return String(str).replace(/\s+/g, " ").trim();
}

function unescapeHtml(str = "") {
    return String(str)
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function attrEscape(str = "") {
    const raw = unescapeHtml(str);
    return String(raw)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function truncateAtWord(str, maxLen) {
    const s = normalizeSpace(str);
    if (s.length <= maxLen) return s;
    const cut = s.slice(0, maxLen + 1);
    const idx = cut.lastIndexOf(" ");
    if (idx > Math.floor(maxLen * 0.6)) return cut.slice(0, idx).trim();
    return s.slice(0, maxLen).trim();
}

function tidySentenceEnd(str = "") {
    let out = normalizeSpace(str).replace(/[.!?]+$/g, "").replace(/[,:;\\-]+$/g, "").trim();
    const weakEndings = new Set(["and", "or", "to", "for", "with", "without", "vs", "vs.", "the", "a", "an", "of", "in", "on", "at"]);
    let parts = out.split(" ");
    while (parts.length > 4 && weakEndings.has(parts[parts.length - 1].toLowerCase())) {
        parts = parts.slice(0, -1);
    }
    out = parts.join(" ").trim();
    return out;
}

function fileToPath(absFile) {
    const rel = path.relative(HTML_ROOT, absFile).split(path.sep).join("/");
    if (rel === "index.html") return "/";
    return `/${rel.replace(/\/index\.html$/i, "")}/`;
}

function pathToAbsUrl(pagePath) {
    return `${SITE_URL}${pagePath}`;
}

function readFirstMatch(html, regex) {
    const m = html.match(regex);
    return m ? normalizeSpace(unescapeHtml(m[1])) : "";
}

function readTitle(html) {
    return readFirstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
}

function readMetaByName(html, name) {
    const n = escapeRegExp(name);
    return (
        readFirstMatch(html, new RegExp(`<meta[^>]*\\bname=["']${n}["'][^>]*\\bcontent=["']([\\s\\S]*?)["'][^>]*>`, "i")) ||
        readFirstMatch(html, new RegExp(`<meta[^>]*\\bcontent=["']([\\s\\S]*?)["'][^>]*\\bname=["']${n}["'][^>]*>`, "i"))
    );
}

function readMetaByProperty(html, prop) {
    const p = escapeRegExp(prop);
    return (
        readFirstMatch(html, new RegExp(`<meta[^>]*\\bproperty=["']${p}["'][^>]*\\bcontent=["']([\\s\\S]*?)["'][^>]*>`, "i")) ||
        readFirstMatch(html, new RegExp(`<meta[^>]*\\bcontent=["']([\\s\\S]*?)["'][^>]*\\bproperty=["']${p}["'][^>]*>`, "i"))
    );
}

function removeMetaByName(html, name) {
    const n = escapeRegExp(name);
    return html.replace(new RegExp(`<meta[^>]*\\bname=["']${n}["'][^>]*>\\s*`, "ig"), "");
}

function removeMetaByProperty(html, prop) {
    const p = escapeRegExp(prop);
    return html.replace(new RegExp(`<meta[^>]*\\bproperty=["']${p}["'][^>]*>\\s*`, "ig"), "");
}

function removeCanonical(html) {
    return html.replace(/<link[^>]*\brel=["']canonical["'][^>]*>\s*/ig, "");
}

function removeHreflang(html) {
    return html.replace(/<link[^>]*\brel=["']alternate["'][^>]*\bhreflang=["'][^"']+["'][^>]*>\s*/ig, "");
}

function replaceTitle(html, titleText) {
    const safe = attrEscape(titleText);
    if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) {
        return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${safe}</title>`);
    }
    const idx = html.search(/<\/head>/i);
    if (idx < 0) return `${html}\n<title>${safe}</title>\n`;
    return `${html.slice(0, idx)}    <title>${safe}</title>\n${html.slice(idx)}`;
}

function insertBeforeHeadClose(html, block) {
    const idx = html.search(/<\/head>/i);
    if (idx < 0) return `${html}\n${block}\n`;
    return `${html.slice(0, idx)}${block}\n${html.slice(idx)}`;
}

function appendSentenceIfNeeded(desc) {
    if (/[^.!?]$/.test(desc)) return `${desc}.`;
    return desc;
}

function normalizeDescription(rawDescription, pagePath, title) {
    const hasOverride = Boolean(descriptionOverrides[pagePath]);
    const rawNorm = normalizeSpace(rawDescription);
    let desc = normalizeSpace(descriptionOverrides[pagePath] || rawNorm);
    if (!desc) {
        const base = title.replace(/\s*\|\s*PropertyCost$/i, "").trim();
        desc = `Use PropertyCost to explore ${base.toLowerCase()} with calculators, scenario tests, and clearer decision guidance.`;
    }
    if (!hasOverride && rawNorm.length > 160) {
        const base = title.replace(/\s*\|\s*PropertyCost$/i, "").trim();
        desc = `${base}: practical guide with formulas, examples, common mistakes, and calculator links from PropertyCost.`;
    }
    if (desc.length < 70) {
        const addon = " Compare assumptions, stress-test scenarios, and make informed decisions.";
        desc = normalizeSpace(`${desc}${addon}`);
    }
    if (desc.length > 160) {
        desc = truncateAtWord(desc, 158);
    }
    desc = tidySentenceEnd(desc);
    return appendSentenceIfNeeded(desc);
}

function normalizeTitle(rawTitle, pagePath) {
    if (titleOverrides[pagePath]) return normalizeSpace(titleOverrides[pagePath]);

    let title = normalizeSpace(rawTitle)
        .replace(/\s+\|\s+/g, " | ")
        .replace(/\s+—\s+/g, " — ")
        .replace(/\s+-\s+/g, " - ");

    let base = title;
    base = base.replace(/\s*\|\s*PropertyCost$/i, "");
    base = base.replace(/\s*[-—]\s*PropertyCost$/i, "");

    if (base.length > 52) {
        const split = base.split(" — ");
        if (split.length > 1 && split[0].length >= 20) base = split[0].trim();
    }
    if (base.length > 52) {
        const split = base.split(":");
        if (split.length > 1 && split[0].length >= 20) base = split[0].trim();
    }
    if (base.length > 52) {
        base = truncateAtWord(base, 52);
    }
    if (base.length < 24) {
        base = `${base} Guide`;
    }

    let out = /^PropertyCost\b/i.test(base)
        ? base
        : `${base} | PropertyCost`;

    if (out.length > 65) {
        if (/^PropertyCost\b/i.test(base)) {
            out = truncateAtWord(base, 65);
        } else {
            const suffix = " | PropertyCost";
            const shortBase = truncateAtWord(base, 65 - suffix.length);
            out = `${shortBase}${suffix}`;
        }
    }

    if (out.length < 35) {
        const suffix = /^PropertyCost\b/i.test(out) ? "" : " | PropertyCost";
        const fallbackBase = truncateAtWord(base + " Guide", Math.max(24, 65 - suffix.length));
        out = /^PropertyCost\b/i.test(fallbackBase)
            ? fallbackBase
            : `${fallbackBase}${suffix}`;
    }

    return normalizeSpace(out);
}

function upsertMetaBlock(html, items) {
    let out = html;
    for (const item of items) {
        if (item.kind === "name") {
            out = removeMetaByName(out, item.key);
        } else if (item.kind === "property") {
            out = removeMetaByProperty(out, item.key);
        }
    }

    const lines = items.map((item) => {
        const content = attrEscape(item.value);
        if (item.kind === "name") return `    <meta name="${item.key}" content="${content}">`;
        return `    <meta property="${item.key}" content="${content}">`;
    });

    return insertBeforeHeadClose(out, `\n${lines.join("\n")}`);
}

function upsertCanonicalAndHreflang(html, absUrl) {
    let out = removeCanonical(html);
    out = removeHreflang(out);
    const block = `
    <link rel="canonical" href="${absUrl}">
    <link rel="alternate" hreflang="en" href="${absUrl}">
    <link rel="alternate" hreflang="x-default" href="${absUrl}">`;
    return insertBeforeHeadClose(out, block);
}

function walkIndexFiles(dirAbs, out = []) {
    const list = fs.readdirSync(dirAbs, { withFileTypes: true });
    for (const ent of list) {
        const abs = path.join(dirAbs, ent.name);
        if (ent.isDirectory()) {
            walkIndexFiles(abs, out);
        } else if (ent.isFile() && ent.name === "index.html") {
            out.push(abs);
        }
    }
    return out;
}

function countLen(text) {
    return normalizeSpace(text).length;
}

function main() {
    const files = walkIndexFiles(HTML_ROOT).sort();
    let touched = 0;
    let skippedNoindex = 0;

    for (const file of files) {
        const original = fs.readFileSync(file, "utf8");
        const pagePath = fileToPath(file);
        const absUrl = pathToAbsUrl(pagePath);

        const robotsValue = readMetaByName(original, "robots");
        if (/noindex/i.test(robotsValue)) {
            skippedNoindex += 1;
            continue;
        }

        let html = original;

        const oldTitle = readTitle(html);
        const newTitle = normalizeTitle(oldTitle, pagePath);
        html = replaceTitle(html, newTitle);

        const oldDesc = readMetaByName(html, "description");
        const newDesc = normalizeDescription(oldDesc, pagePath, newTitle);

        html = upsertCanonicalAndHreflang(html, absUrl);

        html = upsertMetaBlock(html, [
            { kind: "name", key: "description", value: newDesc },
            { kind: "name", key: "robots", value: "index, follow" },
            { kind: "property", key: "og:title", value: newTitle },
            { kind: "property", key: "og:description", value: newDesc },
            { kind: "property", key: "og:type", value: "website" },
            { kind: "property", key: "og:url", value: absUrl },
            { kind: "property", key: "og:image", value: DEFAULT_OG_IMAGE },
            { kind: "name", key: "twitter:card", value: "summary_large_image" },
            { kind: "name", key: "twitter:title", value: newTitle },
            { kind: "name", key: "twitter:description", value: newDesc },
            { kind: "name", key: "twitter:image", value: DEFAULT_OG_IMAGE }
        ]);

        if (html !== original) {
            fs.writeFileSync(file, html, "utf8");
            touched += 1;
        }
    }

    console.log(`Processed: ${files.length}`);
    console.log(`Updated: ${touched}`);
    console.log(`Skipped (noindex): ${skippedNoindex}`);

    // Post-run quick report.
    let longTitle = 0;
    let longDesc = 0;
    let missingCanonical = 0;
    let missingDesc = 0;
    let missingOgImage = 0;

    for (const file of files) {
        const html = fs.readFileSync(file, "utf8");
        const robots = readMetaByName(html, "robots");
        if (/noindex/i.test(robots)) continue;

        const title = readTitle(html);
        const desc = readMetaByName(html, "description");
        const canonical = readFirstMatch(html, /<link[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i)
            || readFirstMatch(html, /<link[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["'][^>]*>/i);
        const ogImage = readMetaByProperty(html, "og:image");

        if (!canonical) missingCanonical += 1;
        if (!desc) missingDesc += 1;
        if (!ogImage) missingOgImage += 1;
        if (countLen(title) > 65) longTitle += 1;
        if (countLen(desc) > 160) longDesc += 1;
    }

    console.log("Post-run summary (indexable pages):");
    console.log(`  longTitle>65: ${longTitle}`);
    console.log(`  longDesc>160: ${longDesc}`);
    console.log(`  missingCanonical: ${missingCanonical}`);
    console.log(`  missingDescription: ${missingDesc}`);
    console.log(`  missingOgImage: ${missingOgImage}`);
}

main();
