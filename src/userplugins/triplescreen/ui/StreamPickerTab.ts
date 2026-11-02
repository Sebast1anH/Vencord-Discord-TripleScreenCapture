/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

const logger = new Logger("TripleScreen:PickerTab");
const TAB_ATTR = "data-triplescreen-picker-tab";
const PANEL_ATTR = "data-triplescreen-picker-panel";
const DIALOG_ATTR = "data-triplescreen-picker-ready";

/** Discord stream-picker tab labels (EN + common locales). Multi-word allowed. */
const NATIVE_TAB_LABEL = /^(screens?|windows?|applications?|entire\s*screens?|devices?|camera|kamera|bildschirme?|fenster|anwendungen?|gesamter?\s*bildschirm|geräte?)$/i;

let opener: (() => void) | null = null;
let observer: MutationObserver | null = null;
let refreshTimer = 0;

export function setStreamPickerOpener(next: () => void) {
    opener = next;
}

function normalizeLabel(el: Element) {
    return (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
}

function isNativePickerTab(el: Element) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.getAttribute(TAB_ATTR) === "1") return false;
    return NATIVE_TAB_LABEL.test(normalizeLabel(el));
}

function isOurModal(node: Element) {
    return !!node.querySelector?.("[data-triplescreen-root]")
        || /Share Multiple Monitors|Open TripleScreen|Start composite stream/i.test(node.textContent || "");
}

/**
 * Current Discord Go Live picker uses Applications / Entire Screen / Devices
 * and often has no "Share Your Screen" title in the dialog text.
 */
function isDiscordStreamPicker(node: Element) {
    if (!(node instanceof HTMLElement)) return false;
    if (node.getAttribute("role") !== "dialog") return false;
    if (isOurModal(node)) return false;

    const tabStrip = findNativeTabStrip(node);
    if (!tabStrip) return false;

    const labels = [...tabStrip.querySelectorAll<HTMLElement>("[role='tab']")]
        .map(normalizeLabel)
        .filter(Boolean);
    const joined = labels.join(" | ");
    // Prefer the modern three-tab picker; also accept legacy Screens/Windows.
    const modern = /applications?/i.test(joined) && /entire\s*screen|devices?/i.test(joined);
    const legacy = /screens?|windows?|bildschirme?|fenster/i.test(joined);
    return modern || legacy || labels.filter(l => NATIVE_TAB_LABEL.test(l)).length >= 2;
}

function findPickerDialogs() {
    return [...document.querySelectorAll<HTMLElement>("[role='dialog']")]
        .filter(isDiscordStreamPicker);
}

function findNativeTabStrip(dialog: HTMLElement) {
    const tablists = [...dialog.querySelectorAll<HTMLElement>("[role='tablist']")]
        .filter(list => !list.hasAttribute("data-triplescreen-tabstrip"));

    for (const tablist of tablists) {
        const nativeInList = [...tablist.querySelectorAll<HTMLElement>("[role='tab']")]
            .filter(isNativePickerTab);
        if (nativeInList.length >= 1) return tablist;
    }

    const tabs = [...dialog.querySelectorAll<HTMLElement>("[role='tab']")]
        .filter(isNativePickerTab);
    if (tabs.length < 2) return null;

    const parents = new Map<HTMLElement, number>();
    for (const tab of tabs) {
        // Prefer the tablist / pill container, not an intermediate wrapper.
        const parent = tab.closest<HTMLElement>("[role='tablist']") || tab.parentElement;
        if (!parent) continue;
        parents.set(parent, (parents.get(parent) ?? 0) + 1);
    }
    let best: HTMLElement | null = null;
    let bestCount = 0;
    for (const [parent, count] of parents) {
        if (count > bestCount) {
            best = parent;
            bestCount = count;
        }
    }
    return bestCount >= 2 ? best : null;
}

function findContentHost(dialog: HTMLElement, tabStrip: HTMLElement) {
    const candidates = [...dialog.querySelectorAll<HTMLElement>("div")]
        .filter(el => {
            if (tabStrip.contains(el) || el.contains(tabStrip)) return false;
            if (el.querySelector("[data-triplescreen-root]")) return false;
            const rect = el.getBoundingClientRect();
            return rect.height > 120 && rect.width > 220;
        })
        .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
    return candidates[0] ?? dialog;
}

const TAB_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="flex:0 0 auto;display:block;">
  <rect x="2" y="5" width="6.5" height="11" rx="1.2" stroke="currentColor" stroke-width="1.8"></rect>
  <rect x="8.75" y="4" width="6.5" height="13" rx="1.2" stroke="currentColor" stroke-width="1.8"></rect>
  <rect x="15.5" y="5" width="6.5" height="11" rx="1.2" stroke="currentColor" stroke-width="1.8"></rect>
  <path d="M7 19h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
</svg>`;

function setTabLabelWithIcon(tab: HTMLElement, label: string) {
    const labeled = [...tab.querySelectorAll<HTMLElement>("*")]
        .reverse()
        .find(el => {
            const text = (el.textContent || "").replace(/\s+/g, " ").trim();
            return text.length > 0 && text.length < 24 && el.children.length === 0;
        });

    const host = labeled ?? tab;
    host.replaceChildren();
    host.style.display = "inline-flex";
    host.style.alignItems = "center";
    host.style.gap = "6px";

    const icon = document.createElement("span");
    icon.setAttribute("data-triplescreen-tab-icon", "1");
    icon.style.cssText = "display:inline-flex;align-items:center;line-height:0;color:currentColor;";
    icon.innerHTML = TAB_ICON_SVG;

    const text = document.createElement("span");
    text.textContent = label;

    host.append(icon, text);
}

function createTabFromTemplate(template: HTMLElement) {
    // Discord wraps each pill: tablist > itemWrapper > [role=tab]. Clone the wrapper.
    const wrapper = template.parentElement;
    const cloneWrapper = !!(wrapper && wrapper.parentElement?.getAttribute("role") === "tablist");
    const root = (cloneWrapper ? wrapper! : template).cloneNode(true) as HTMLElement;
    const tab = root.matches("[role='tab']")
        ? root
        : root.querySelector<HTMLElement>("[role='tab']") || root;

    tab.removeAttribute("aria-selected");
    tab.removeAttribute("aria-controls");
    tab.removeAttribute("id");
    tab.setAttribute("role", "tab");
    tab.setAttribute(TAB_ATTR, "1");
    tab.setAttribute("aria-selected", "false");
    tab.setAttribute("aria-label", "TripleScreen");
    for (const cls of [...tab.classList]) {
        if (/selected|active|checked/i.test(cls)) tab.classList.remove(cls);
    }

    setTabLabelWithIcon(tab, "TripleScreen");
    if (root !== tab) root.setAttribute(TAB_ATTR, "1");
    return { root, tab };
}

function setSelected(tab: HTMLElement, selected: boolean) {
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.style.color = selected
        ? "var(--interactive-active, #f2f3f5)"
        : "var(--interactive-normal, #b5bac1)";
    tab.style.opacity = selected ? "1" : "0.85";
    tab.style.boxShadow = "none";
    tab.style.borderBottom = "none";
    for (const cls of [...tab.classList]) {
        if (/selected|active|checked/i.test(cls)) {
            if (!selected) tab.classList.remove(cls);
        }
    }
}

function buildPanel(dialog: HTMLElement) {
    const panel = document.createElement("div");
    panel.setAttribute(PANEL_ATTR, "1");
    panel.style.cssText = [
        "display:none",
        "flex-direction:column",
        "gap:14px",
        "padding:18px",
        "box-sizing:border-box",
        "width:100%",
        "min-height:220px",
        "color:var(--text-default, #dbdee1)",
        "font:14px/1.4 var(--font-primary, sans-serif)"
    ].join(";");

    panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:40px;height:40px;border-radius:10px;background:var(--brand-500,#5865f2);display:flex;align-items:center;justify-content:center;flex:0 0 auto;">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="2" y="5" width="6.5" height="11" rx="1.2" stroke="#fff" stroke-width="1.8"></rect>
                    <rect x="8.75" y="4" width="6.5" height="13" rx="1.2" stroke="#fff" stroke-width="1.8"></rect>
                    <rect x="15.5" y="5" width="6.5" height="11" rx="1.2" stroke="#fff" stroke-width="1.8"></rect>
                    <path d="M7 19h10" stroke="#fff" stroke-width="1.8" stroke-linecap="round"></path>
                </svg>
            </div>
            <div>
                <div style="font-weight:700;font-size:16px;">TripleScreen</div>
                <div style="color:var(--text-muted,#949ba4);font-size:13px;">Share multiple monitors as one Discord stream</div>
            </div>
        </div>
        <p style="margin:0;color:var(--text-muted,#949ba4);">
            Arrange your displays on a custom canvas, then go live. Viewers do not need the plugin.
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;">
            <button type="button" data-ts-open style="
                appearance:none;cursor:pointer;border:none;border-radius:8px;
                background:var(--brand-500,#5865f2);color:#fff;
                font:600 14px/1 var(--font-primary,sans-serif);
                padding:12px 16px;">
                Open TripleScreen
            </button>
        </div>
    `;

    panel.querySelector<HTMLButtonElement>("[data-ts-open]")?.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        opener?.();
        const closeBtn = dialog.querySelector<HTMLElement>("[aria-label='Close'], [aria-label='Schließen'], button[class*='close']");
        closeBtn?.click();
        setTimeout(() => {
            dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }, 50);
    });

    return panel;
}

function activateTripleTab(tab: HTMLElement, panel: HTMLElement, contentHost: HTMLElement, nativeTabs: HTMLElement[]) {
    for (const native of nativeTabs) setSelected(native, false);
    setSelected(tab, true);
    panel.style.display = "flex";

    for (const child of [...contentHost.children] as HTMLElement[]) {
        if (child === panel) continue;
        if (!child.hasAttribute("data-ts-hidden")) {
            child.setAttribute("data-ts-hidden", child.style.display || "");
        }
        child.style.display = "none";
    }
}

function deactivateTripleTab(tab: HTMLElement, panel: HTMLElement, contentHost: HTMLElement) {
    setSelected(tab, false);
    panel.style.display = "none";
    for (const child of [...contentHost.children] as HTMLElement[]) {
        if (child === panel) continue;
        if (child.hasAttribute("data-ts-hidden")) {
            child.style.display = child.getAttribute("data-ts-hidden") || "";
            child.removeAttribute("data-ts-hidden");
        }
    }
}

function scrubFakeStrips() {
    document.querySelectorAll("[data-triplescreen-tabstrip]").forEach(node => node.remove());
    document.querySelectorAll("[data-triplescreen-root]").forEach(root => {
        root.closest("[role='dialog']")?.querySelectorAll(`[${TAB_ATTR}], [${PANEL_ATTR}]`).forEach(node => node.remove());
    });
}

function injectIntoDialog(dialog: HTMLElement) {
    if (isOurModal(dialog)) return false;
    if (dialog.getAttribute(DIALOG_ATTR) === "1" && dialog.querySelector(`[${TAB_ATTR}]`)) return true;

    const tabStrip = findNativeTabStrip(dialog);
    if (!tabStrip) {
        logger.debug("Stream picker found but no native tab strip yet");
        return false;
    }

    const template = [...tabStrip.querySelectorAll<HTMLElement>("[role='tab']")]
        .find(isNativePickerTab);
    if (!template) return false;

    const nativeTabs = [...tabStrip.querySelectorAll<HTMLElement>("[role='tab']")]
        .filter(el => el.getAttribute(TAB_ATTR) !== "1");

    let tab = dialog.querySelector<HTMLElement>(`[role='tab'][${TAB_ATTR}]`);
    if (!tab) {
        const { root, tab: created } = createTabFromTemplate(template);
        tab = created;
        setSelected(tab, false);
        tabStrip.appendChild(root);
    }

    const contentHost = findContentHost(dialog, tabStrip);
    let panel = dialog.querySelector<HTMLElement>(`[${PANEL_ATTR}]`);
    if (!panel) {
        panel = buildPanel(dialog);
        contentHost.appendChild(panel);
    }

    if (tab.getAttribute("data-ts-bound") !== "1") {
        tab.setAttribute("data-ts-bound", "1");
        tab.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            activateTripleTab(tab!, panel!, contentHost, nativeTabs);
        });

        for (const native of nativeTabs) {
            native.addEventListener("click", () => {
                deactivateTripleTab(tab!, panel!, contentHost);
            }, true);
        }
    }

    dialog.setAttribute(DIALOG_ATTR, "1");
    logger.info("Added TripleScreen tab to Discord's stream picker");
    return true;
}

function scan() {
    scrubFakeStrips();
    for (const dialog of findPickerDialogs()) {
        injectIntoDialog(dialog);
    }
}

function scheduleScan() {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
        refreshTimer = 0;
        scan();
    }, 80);
}

export function installStreamPickerTab() {
    scrubFakeStrips();
    if (!observer) {
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, { childList: true, subtree: true });
    }
    scan();
    logger.info("Watching Discord stream picker for TripleScreen tab");
}

export function uninstallStreamPickerTab() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (refreshTimer) {
        window.clearTimeout(refreshTimer);
        refreshTimer = 0;
    }
    scrubFakeStrips();
    document.querySelectorAll(`[${TAB_ATTR}], [${PANEL_ATTR}]`).forEach(node => node.remove());
    document.querySelectorAll(`[${DIALOG_ATTR}]`).forEach(node => node.removeAttribute(DIALOG_ATTR));
}
