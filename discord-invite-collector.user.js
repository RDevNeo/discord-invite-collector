// ==UserScript==
// @name         Discord Invite Collector
// @namespace    spokpay-crm
// @version      1.10.3
// @description  Collect Discord invite URLs from member profiles, Discover or a channel's messages.
// @match        https://discord.com/*
// @match        https://*.discord.com/*
// @grant        none
// @updateURL    https://spokpay-crm-lyart.vercel.app/api/userscript?key=589dab264b9024eb4ec66a3ddd7e834619a226048a2b7383
// @downloadURL  https://spokpay-crm-lyart.vercel.app/api/userscript?key=589dab264b9024eb4ec66a3ddd7e834619a226048a2b7383
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const DISCOVER_URL = "https://discord.com/discovery/servers";
  const DISCOVER_URL_PATH = "/discovery/servers";
  const DISCOVER_RESULTS_URL = "https://discord.com/servers";
  const DISCOVER_LANGUAGE_LABEL = "Português do Brasil";
  const SCRIPT_VERSION = "1.10.3";

  const LS_KEY = "discord_invite_url_collector_state";
  let _memState = null;
  let stopRequested = false;
  let restartTimer = null;
  let discoverWatchdogTimer = null;

  const ICONS = {
    play: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path>
      </svg>
    `,
    pause: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="14" y="3" width="5" height="18" rx="1" ry="1"></rect>
        <rect x="5" y="3" width="5" height="18" rx="1" ry="1"></rect>
      </svg>
    `,
    copy: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="8" y="8" width="14" height="14" rx="2" ry="2"></rect>
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
      </svg>
    `,
    trash: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
        <path d="M3 6h18"></path>
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
    `,
    log: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <path d="M14 2v6h6"></path>
        <path d="M8 13h8"></path>
        <path d="M8 17h8"></path>
        <path d="M8 9h2"></path>
      </svg>
    `,
  };

  function getLS() {
    try {
      const ls = window.localStorage;
      if (ls && typeof ls.getItem === "function") return ls;
    } catch (e) {}
    try {
      const ss = window.sessionStorage;
      if (ss && typeof ss.getItem === "function") return ss;
    } catch (e) {}
    return null;
  }

  function defaultState() {
    return {
      running: false,
      collectorMode: "sidebar",
      discoverQuery: "",
      discoverPhase: "idle",
      discoverSearchReady: false,
      discoverVisitedCardKeys: [],
      discoverCardCursor: 0,
      discoverCurrentCardKey: "",
      discoverLastAddedAt: 0,
      discoverLastCardOpenedAt: 0,
      discoverLastBrowseAt: 0,
      serverIndex: 0,
      inviteUrls: [],
      currentServer: null,
      log: "",
      statusText: "",
      inviteCount: 0,
    };
  }

  function getCollectorMode() {
    const state = loadState();
    return state.collectorMode === "discover" || state.collectorMode === "reader"
      ? state.collectorMode
      : "sidebar";
  }

  function setCollectorMode(mode) {
    const state = loadState();
    state.collectorMode = mode === "discover" || mode === "reader" ? mode : "sidebar";
    saveState(state);
    refreshUI();
  }

  function setIconButtonContent(button, label, iconMarkup) {
    if (!button) return;
    button.innerHTML = `${iconMarkup}<span class="dic-sr-only">${label}</span>`;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.type = "button";
  }

  function getDiscoverQuery() {
    const state = loadState();
    return String(state.discoverQuery || "").trim();
  }

  function normalizeDiscoverSearchValue(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function getDiscoverSearchInputValue() {
    const input = getDiscoverSearchInput();
    if (!input) return "";
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      return input.value || "";
    }
    return input.textContent || "";
  }

  function discoverSearchMatchesQuery(query) {
    const needle = normalizeDiscoverSearchValue(query);
    if (!needle) return false;

    const inputValue = normalizeDiscoverSearchValue(getDiscoverSearchInputValue());
    if (inputValue && inputValue.includes(needle)) return true;

    const urlValue = normalizeDiscoverSearchValue(location.href);
    if (urlValue.includes(needle)) return true;

    return false;
  }

  function setDiscoverQuery(value) {
    const state = loadState();
    state.discoverQuery = value;
    saveState(state);
  }

  function setNativeValue(element, value) {
    const proto =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    descriptor?.set?.call(element, value);
  }

  function dispatchValueEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  }

  function textMatches(element, needles) {
    const haystack = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.textContent,
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return needles.some((needle) => haystack.includes(needle.toLowerCase()));
  }

  function findClickableByText(needles, root = document) {
    const selectors =
      "button, [role='button'], a, [role='link'], input[type='button'], input[type='submit']";
    for (const element of root.querySelectorAll(selectors)) {
      if (!isVisible(element)) continue;
      if (textMatches(element, needles)) return element;
    }
    return null;
  }

  async function waitFor(predicate, timeoutMs = 10000, intervalMs = 250) {
    const started = Date.now();
    while (!stopRequested && Date.now() - started < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function loadState() {
    try {
      const ls = getLS();
      if (ls) {
        const raw = ls.getItem(LS_KEY);
        if (raw) return JSON.parse(raw);
      }
    } catch (e) {}
    return _memState || defaultState();
  }

  function saveState(state) {
    _memState = state;
    try {
      const ls = getLS();
      if (ls) ls.setItem(LS_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;
  const DISCORD_INVITE_REGEX =
    /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+/gi;

  function normalizeInvite(url) {
    if (!url) return null;
    let normalized = url.trim().replace(/[)\],.!?:;]+$/g, "");

    if (!/^https?:\/\//i.test(normalized)) {
      normalized = "https://" + normalized.replace(/^\/+/, "");
    }

    try {
      const parsed = new URL(normalized);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, "");

      if (host === "discord.gg") {
        const code = path.split("/").filter(Boolean)[0];
        return code ? `https://discord.gg/${code}` : null;
      }

      if (host === "discord.com") {
        const parts = path.split("/").filter(Boolean);
        if (parts[0] === "invite" && parts[1]) {
          return `https://discord.com/invite/${parts[1]}`;
        }
      }
    } catch (e) {}

    return null;
  }

  function extractInviteUrls(text) {
    if (!text) return [];
    const urls = text.match(URL_REGEX) || [];
    const rawInvites = text.match(DISCORD_INVITE_REGEX) || [];
    const combined = [...urls, ...rawInvites];
    const normalized = combined.map(normalizeInvite).filter(Boolean);
    return [...new Set(normalized)];
  }

  function formatCollectionSummary(inviteCount) {
    const invites = Math.max(0, Number(inviteCount) || 0);
    return `${invites} invite URL(s) collected.`;
  }

  function getCurrentGuildId() {
    const match = String(location.pathname || "").match(/^\/channels\/([^/]+)/i);
    return match?.[1] ? String(match[1]) : "";
  }

  function getTextLike(element) {
    return [
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("placeholder"),
      element.textContent,
      "value" in element ? element.value : "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  function isDiscoverPage() {
    return (
      location.hostname === "discord.com" &&
      (location.pathname === DISCOVER_URL_PATH || location.pathname === "/servers")
    );
  }

  function isDiscoverUrl() {
    return location.hostname === "discord.com" && location.pathname === DISCOVER_URL_PATH;
  }

  function getDiscoverSearchInput() {
    const selectors = [
      'input[placeholder*="Search communities"]',
      'input[aria-label*="Search communities"]',
      '[role="search"] input',
      'form[role="search"] input',
      'input[aria-label*="Search"]',
      'input[placeholder*="Search"]',
      'input[aria-label*="communities"]',
      'input[placeholder*="communities"]',
      'input[aria-label*="Pesquisar"]',
      'input[placeholder*="Pesquisar"]',
      'input[type="search"]',
      'textarea[aria-label*="Search"]',
      'textarea[placeholder*="Search"]',
      '[role="textbox"][aria-label*="Search"]',
      '[role="textbox"][aria-label*="Search communities"]',
      '[contenteditable="true"][aria-label*="Search"]',
    ];

    for (const selector of selectors) {
      const inputs = document.querySelectorAll(selector);
      for (const input of inputs) {
        if (!isVisible(input)) continue;
        if (input.closest('[role="dialog"]')) continue;
        if (input.closest("#dic-panel")) continue;
        if (
          !(
            /search|communities|pesquisar/i.test(
              [
                input.getAttribute("aria-label"),
                input.getAttribute("placeholder"),
                input.getAttribute("title"),
                input.textContent,
              ]
                .filter(Boolean)
                .join(" "),
            ) ||
            input.getAttribute("role") === "textbox" ||
            input.getAttribute("contenteditable") === "true"
          )
        ) {
          continue;
        }
        return input;
      }
    }

    return null;
  }

  function normalizeInlineText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeLanguageText(value) {
    return normalizeInlineText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function discoverLanguageMatches(value, targetLabel = DISCOVER_LANGUAGE_LABEL) {
    const normalized = normalizeLanguageText(value);
    const target = normalizeLanguageText(targetLabel);
    if (!normalized) return false;
    return (
      normalized === target ||
      normalized === "portugues brasil" ||
      normalized === "portugues (brasil)" ||
      normalized === "portuguese brazil" ||
      normalized === "portuguese (brazil)" ||
      normalized === "pt-br" ||
      normalized === "pt br"
    );
  }

  function getLabelledByText(element) {
    return String(element?.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => normalizeInlineText(document.getElementById(id)?.textContent || ""))
      .filter(Boolean)
      .join(" ");
  }

  function getComboboxContextText(input) {
    const context = [
      getLabelledByText(input),
      input.getAttribute("aria-label"),
      input.getAttribute("title"),
      input.getAttribute("placeholder"),
      input.value,
      input.closest("label")?.textContent,
      input.parentElement?.textContent,
      input.parentElement?.parentElement?.textContent,
    ];
    return normalizeInlineText(context.filter(Boolean).join(" "));
  }

  function getComboboxDirectLabelText(input) {
    const directLabel = [
      getLabelledByText(input),
      input.getAttribute("aria-label"),
      input.getAttribute("title"),
      input.getAttribute("placeholder"),
      input.closest("label")?.textContent,
    ];
    return normalizeInlineText(directLabel.filter(Boolean).join(" "));
  }

  function getDiscoverLanguageCombobox() {
    const inputs = [...document.querySelectorAll("input[role='combobox']")];
    const valuePattern =
      /all|english|português|portugues|portuguese|español|français|deutsch|italiano|nederlands|polski|русский|日本語|한국어|中文|dansk|čeština|magyar/i;
    const languageLabelPattern =
      /preferred language|idioma preferido|idioma de preferencia|linguagem preferida|\blanguage\b|\bidioma\b|\blinguagem\b/i;
    const nonLanguageLabelPattern =
      /category|categoria|sort|order|ordenar|classification|classifica/i;
    const scored = [];

    for (const input of inputs) {
      if (!isVisible(input)) continue;
      if (input.closest('[role="dialog"]')) continue;
      if (input.closest("#dic-panel")) continue;

      const directLabelText = getComboboxDirectLabelText(input);
      const contextText = getComboboxContextText(input);
      const valueText = normalizeInlineText(input.value || "");
      let score = 0;

      if (languageLabelPattern.test(directLabelText)) score += 180;
      else if (languageLabelPattern.test(contextText)) score += 70;
      if (valueText && valuePattern.test(valueText)) score += 35;
      if (discoverLanguageMatches(valueText)) score += 75;
      if (nonLanguageLabelPattern.test(directLabelText)) score -= 180;
      else if (nonLanguageLabelPattern.test(contextText)) score -= 60;

      if (score > 0) {
        scored.push({ input, score, contextText, valueText });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.input || null;
  }

  function getDiscoverLanguageOptionScroller(combobox) {
    const controlId = combobox?.getAttribute("aria-controls");
    const listbox = controlId ? document.getElementById(controlId) : null;

    let node = listbox;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 5) return node;
      node = node.parentElement;
    }

    const option = document.querySelector("[role='option']");
    node = option ? option.parentElement : null;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 5) return node;
      node = node.parentElement;
    }

    return null;
  }

  function getDiscoverLanguageOptions() {
    return [...document.querySelectorAll("[role='option']")]
      .map((option) => ({
        element: option,
        text: normalizeInlineText(option.textContent || ""),
        selected: option.getAttribute("aria-selected") === "true",
      }))
      .filter((option) => option.text);
  }

  async function openDiscoverLanguageCombobox(combobox) {
    if (!combobox) return false;
    if (combobox.getAttribute("aria-expanded") === "true" && getDiscoverLanguageOptions().length > 0) {
      return true;
    }

    dispatchHumanClick(combobox);
    await sleep(150);
    if (combobox.getAttribute("aria-expanded") === "true" && getDiscoverLanguageOptions().length > 0) {
      return true;
    }

    combobox.focus();
    combobox.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
        code: "ArrowDown",
        keyCode: 40,
        which: 40,
      }),
    );
    combobox.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
        code: "ArrowDown",
        keyCode: 40,
        which: 40,
      }),
    );

    return Boolean(
      await waitFor(
        () => combobox.getAttribute("aria-expanded") === "true" && getDiscoverLanguageOptions().length > 0,
        3000,
        100,
      ),
    );
  }

  async function ensureDiscoverLanguage(targetLabel = DISCOVER_LANGUAGE_LABEL) {
    const combobox = await waitFor(() => getDiscoverLanguageCombobox(), 8000, 150);
    if (!combobox) {
      log(`Could not find the Discover language combobox for "${targetLabel}".`);
      requestFlowRestart("Could not find the Discover language combobox.");
      return false;
    }

    const currentValue = normalizeInlineText(combobox.value || "");
    if (discoverLanguageMatches(currentValue, targetLabel)) {
      return true;
    }

    const opened = await openDiscoverLanguageCombobox(combobox);
    if (!opened) {
      log(`Could not open the Discover language combobox for "${targetLabel}".`);
      requestFlowRestart("Could not open the Discover language combobox.");
      return false;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const option = getDiscoverLanguageOptions().find((item) =>
        discoverLanguageMatches(item.text, targetLabel),
      );
      if (option?.element) {
        option.element.scrollIntoView({ block: "nearest" });
        dispatchHumanClick(option.element);
        const selected = await waitFor(
          () => discoverLanguageMatches(combobox.value || getDiscoverLanguageCombobox()?.value || "", targetLabel),
          5000,
          100,
        );
        if (!selected) {
          log(`Timed out waiting for Discover language "${targetLabel}" to apply.`);
          requestFlowRestart(`Discover language "${targetLabel}" did not apply.`);
          return false;
        }
        await sleep(600);
        return true;
      }

      const scroller = getDiscoverLanguageOptionScroller(combobox);
      if (!scroller) {
        log(`Could not find the Discover language option scroller for "${targetLabel}".`);
        requestFlowRestart("Could not find the Discover language option scroller.");
        return false;
      }

      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(120, scroller.clientHeight - 40), scroller.scrollHeight);
      if (scroller.scrollTop === before) break;
      await sleep(150);
    }

    log(`Could not find the Discover language option "${targetLabel}".`);
    requestFlowRestart(`Could not find Discover language option "${targetLabel}".`);
    return false;
  }

  async function verifyDiscoverLanguage(targetLabel = DISCOVER_LANGUAGE_LABEL) {
    const combobox = await waitFor(() => getDiscoverLanguageCombobox(), 5000, 150);
    const value = normalizeInlineText(combobox?.value || "");
    if (discoverLanguageMatches(value, targetLabel)) {
      return true;
    }

    log(`Discover language verification failed. Current value: "${value || "unknown"}".`);
    requestFlowRestart(`Discover language is not "${targetLabel}".`);
    return false;
  }

  async function getOptionalDiscoverLanguageCombobox(timeoutMs = 2500) {
    return waitFor(() => getDiscoverLanguageCombobox(), timeoutMs, 150);
  }

  async function typeIntoInput(input, value) {
    if (!input) return false;
    input.focus();
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      setNativeValue(input, value);
    } else if (input instanceof HTMLElement && input.isContentEditable) {
      input.textContent = value;
    } else {
      return false;
    }
    dispatchValueEvents(input);
    await sleep(100);
    return true;
  }

  async function waitForDiscoverPageReady() {
    if (!isDiscoverPage()) return false;

    const loaded = await waitFor(() => document.readyState === "complete", 30000, 250);
    if (!loaded) {
      log("Timed out waiting for the Discover page to finish loading.");
      setStatus("Waiting for Discover page timed out.");
      requestFlowRestart("Discover page did not finish loading.");
      return false;
    }

    await sleep(4000);

    return true;
  }

  function requestFlowRestart(reason) {
    if (stopRequested) return false;

    const state = loadState();
    if (!state.running) return false;
    if (restartTimer) return true;

    const message = reason ? String(reason) : "Unexpected error.";

    state.statusText = `${message} Restarting page...`;
    state.discoverPhase = "navigate";
    state.discoverSearchReady = false;
    state.discoverCurrentCardKey = "";
    state.discoverLastAddedAt = Date.now();
    state.discoverLastCardOpenedAt = Date.now();
    saveState(state);
    refreshUI();

    restartTimer = window.setTimeout(() => {
      restartTimer = null;
      if (stopRequested) return;
      if (!loadState().running) return;

      location.href = DISCOVER_URL;
    }, 1200);

    return true;
  }

  function stopDiscoverWatchdog() {
    if (discoverWatchdogTimer) {
      clearInterval(discoverWatchdogTimer);
      discoverWatchdogTimer = null;
    }
  }

  function startDiscoverWatchdog() {
    stopDiscoverWatchdog();
    discoverWatchdogTimer = window.setInterval(() => {
      if (stopRequested) return;
      const state = loadState();
      if (!state.running || getCollectorMode() !== "discover") return;

      const lastActivityAt = Math.max(
        Number(state.discoverLastAddedAt) || 0,
        Number(state.discoverLastCardOpenedAt) || 0,
        Number(state.discoverLastBrowseAt) || 0,
      );
      if (!lastActivityAt) {
        state.discoverLastAddedAt = Date.now();
        state.discoverLastCardOpenedAt = Date.now();
        saveState(state);
        return;
      }

      if (Date.now() - lastActivityAt >= 45000) {
        requestFlowRestart("No Discover progress was seen for 45 seconds.");
      }
    }, 2000);
  }

  async function performDiscoverSearch(query) {
    if (!isDiscoverPage()) {
      log("Discover mode needs the Discord Discover servers page to be open.");
      setStatus("Open Discord Discover servers before starting Discover mode.");
      return false;
    }

    const searchInput = await waitFor(() => getDiscoverSearchInput(), 20000);
    if (!searchInput) {
      log("Could not find the Discover search input.");
      requestFlowRestart("Could not find the Discover search input.");
      return false;
    }

    await typeIntoInput(searchInput, query);

    searchInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      }),
    );
    searchInput.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      }),
    );

    await sleep(1600);
    return true;
  }

  function setDiscoverPhase(phase) {
    const state = loadState();
    state.discoverPhase = phase;
    saveState(state);
  }

  function setDiscoverSearchReady(value) {
    const state = loadState();
    state.discoverSearchReady = Boolean(value);
    saveState(state);
  }

  function getDiscoverVisitedCardKeys() {
    const state = loadState();
    return new Set(Array.isArray(state.discoverVisitedCardKeys) ? state.discoverVisitedCardKeys : []);
  }

  function addDiscoverVisitedCardKey(key) {
    if (!key) return;
    const state = loadState();
    const keys = new Set(Array.isArray(state.discoverVisitedCardKeys) ? state.discoverVisitedCardKeys : []);
    keys.add(key);
    state.discoverVisitedCardKeys = [...keys];
    saveState(state);
  }

  function setDiscoverCardCursor(value) {
    const state = loadState();
    state.discoverCardCursor = Math.max(0, Number.isFinite(value) ? value : 0);
    saveState(state);
  }

  function setDiscoverCurrentCardKey(key) {
    const state = loadState();
    state.discoverCurrentCardKey = String(key || "");
    saveState(state);
  }

  function markDiscoverProgress() {
    const state = loadState();
    state.discoverLastAddedAt = Date.now();
    state.discoverLastCardOpenedAt = Date.now();
    saveState(state);
  }

  function markDiscoverBrowseProgress() {
    const state = loadState();
    state.discoverLastBrowseAt = Date.now();
    saveState(state);
  }

  function markDiscoverCardOpened() {
    markDiscoverProgress();
  }

  async function resumeDiscoverCollectionIfNeeded() {
    const state = loadState();
    if (!state.running) return;
    if (getCollectorMode() !== "discover") return;
    if (!isDiscoverPage()) return;
    if (state.discoverPhase !== "navigate" && state.discoverPhase !== "search" && state.discoverPhase !== "browse")
      return;

    startDiscoverWatchdog();
    await collectDiscoverInvites();
  }

  function getDiscoverCards() {
    const root = document.querySelector("main") || document.body;
    const selectors = [
      "a",
      "article",
      '[role="article"]',
      '[role="link"]',
      "[tabindex='0']",
      "div",
      "li",
    ].join(", ");
    const cards = [];
    let index = 0;
    for (const element of root.querySelectorAll(selectors)) {
      index++;
      if (!(element instanceof HTMLElement)) continue;
      if (!isVisible(element)) continue;
      if (element.closest('[role="dialog"]')) continue;
      if (element.closest("nav, header, aside, footer, [aria-label*='sidebar'], [class*='sidebar']"))
        continue;
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") continue;
      if (element.tagName === "BUTTON" || element.getAttribute("role") === "button") continue;
      if (!element.querySelector("img")) continue;

      const rect = element.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 150 || rect.width > 520 || rect.height > 520) continue;

      const text = getTextLike(element).replace(/\s+/g, " ").trim();
      if (text.length < 8) continue;
      if (/search results|filters|all|gaming|general chatting|entertainment|anime|meme/i.test(text))
        continue;
      if (/home|servers|quests|apps|download|friends|nitro|voice settings|output device/i.test(text))
        continue;
      const hasCardSignals =
        /online|members|servidor|server|community|comunidade|trading|trade|discord/i.test(text) ||
        element.querySelector("h1, h2, h3, h4, [role='heading']");
      if (!hasCardSignals) continue;

      const clickable = element.closest("a[href], [role='link']");
      const identity = getDiscoverCardIdentity(element, clickable, text);
      const score =
        rect.top * 1000 +
        rect.left +
        index -
        (clickable ? 5000 : 0) -
        (text.includes("Members") || text.includes("Online") ? 500 : 0);
      cards.push({
        element: clickable instanceof HTMLElement ? clickable : element,
        key: identity,
        label: text.slice(0, 80),
        score,
      });
    }

    return cards
      .sort((a, b) => a.score - b.score)
      .filter((card, index, array) => array.findIndex((item) => item.key === card.key) === index)
      .map((card, rank) => ({
        ...card,
        index: rank,
      }));
  }

  function getDiscoverNextCard(visitedKeys = getDiscoverVisitedCardKeys()) {
    const cards = getDiscoverCards();
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (!visitedKeys.has(card.key)) return card;
    }
    return null;
  }

  function isScrollableElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (!isVisible(element)) return false;
    const style = getComputedStyle(element);
    const overflowY = style.overflowY || "";
    return /(auto|scroll|overlay)/i.test(overflowY) && element.scrollHeight > element.clientHeight + 40;
  }

  function findScrollableAncestor(element) {
    let current = element instanceof HTMLElement ? element.parentElement : null;
    while (current && current !== document.body && current !== document.documentElement) {
      if (isScrollableElement(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function getDiscoverScrollContainer() {
    const visibleCards = getDiscoverCards();
    for (const card of visibleCards) {
      const ancestor = findScrollableAncestor(card.element);
      if (ancestor) return ancestor;
    }

    const roots = [document.querySelector("main"), document.body, document.documentElement].filter(Boolean);
    for (const root of roots) {
      if (root instanceof HTMLElement && isScrollableElement(root)) return root;

      if (!(root instanceof HTMLElement)) continue;
      const candidates = [
        ...root.querySelectorAll(
          "main, [role='main'], [class*='scroller'], [class*='scroll'], [data-list-id], [data-scrollable='true']",
        ),
      ];
      for (const candidate of candidates) {
        if (candidate instanceof HTMLElement && isScrollableElement(candidate)) return candidate;
      }
    }

    return null;
  }

  function scrollDiscoverResults(amount = 900) {
    const container = getDiscoverScrollContainer();
    if (container) {
      const before = container.scrollTop;
      container.scrollBy({ top: amount, behavior: "auto" });
      if (container.scrollTop !== before) {
        markDiscoverBrowseProgress();
        return {
          scrolled: true,
          mode: "container-scrollBy",
          before,
          after: container.scrollTop,
        };
      }

      container.scrollTop = Math.min(container.scrollTop + amount, container.scrollHeight);
      if (container.scrollTop !== before) {
        markDiscoverBrowseProgress();
        return {
          scrolled: true,
          mode: "container-scrollTop",
          before,
          after: container.scrollTop,
        };
      }
    }

    const before = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    window.scrollBy({ top: amount, behavior: "auto" });
    const after = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    if (after !== before) {
      markDiscoverBrowseProgress();
    }
    return {
      scrolled: after !== before,
      mode: "window-scrollBy",
      before,
      after,
    };
  }

  async function findNextDiscoverCardWithScroll(query, visitedKeys, startIndex) {
    const maxScrollAttempts = 20;
    const initialCards = getDiscoverCards();
    for (let attempt = 0; attempt <= maxScrollAttempts; attempt++) {
      const waitTime = attempt === 0 ? 5000 : 1800;
      const card = await waitFor(() => getDiscoverNextCard(visitedKeys), waitTime);
      if (card) return card;

      if (attempt >= maxScrollAttempts) break;

      const amount = attempt < 4 ? 1100 : attempt < 10 ? 1600 : 2400;
      const scrollResult = scrollDiscoverResults(amount);
      if (!scrollResult.scrolled) {
        break;
      }

      await sleep(attempt < 4 ? 1200 : 1600);
    }

    return null;
  }

  async function waitForDiscoverReturn(query, timeoutMs = 6000) {
    return waitFor(
      () => isDiscoverPage() && (discoverSearchMatchesQuery(query) || getDiscoverCards().length > 0),
      timeoutMs,
      250,
    );
  }

  function getDiscoverFirstCardGoButton(card) {
    if (!card || !(card.element instanceof HTMLElement)) return null;
    const buttons = [...card.element.querySelectorAll("button, [role='button'], a[href]")];
    for (const button of buttons) {
      if (!(button instanceof HTMLElement)) continue;
      if (!isVisible(button)) continue;
      const text = getTextLike(button).replace(/\s+/g, " ").trim().toLowerCase();
      if (text === "go to server" || text.includes("go to server") || text.includes("go to")) {
        return button;
      }
    }
    return null;
  }

  function dispatchHumanClick(element) {
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const x = rect.left + Math.max(24, Math.min(rect.width * 0.22, rect.width - 24));
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y };

    try {
      element.dispatchEvent(new PointerEvent("pointerdown", init));
      element.dispatchEvent(new PointerEvent("pointerup", init));
    } catch (e) {}

    element.dispatchEvent(new MouseEvent("mousedown", init));
    element.dispatchEvent(new MouseEvent("mouseup", init));
    element.dispatchEvent(new MouseEvent("click", init));
    element.click?.();
    return true;
  }

  function getDiscoverCardActivationTarget(cardElement, label) {
    if (!(cardElement instanceof HTMLElement)) return null;

    const normalizedLabel = String(label || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const labelWords = normalizedLabel.split(" ").filter(Boolean).slice(0, 4);
    const shortNeedle = labelWords.join(" ");
    const selectors = [
      "a[href]",
      "[role='link']",
      "[role='heading']",
      "h1",
      "h2",
      "h3",
      "h4",
      "span",
      "div",
    ].join(", ");

    let fallback = null;
    for (const element of cardElement.querySelectorAll(selectors)) {
      if (!(element instanceof HTMLElement)) continue;
      if (!isVisible(element)) continue;
      if (element.closest("button, [role='button']")) continue;
      const text = getTextLike(element).replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) continue;

      const isStrongMatch =
        (normalizedLabel && text === normalizedLabel) ||
        (normalizedLabel && text.includes(normalizedLabel)) ||
        (normalizedLabel && normalizedLabel.includes(text)) ||
        (shortNeedle && text.includes(shortNeedle));
      if (!isStrongMatch) continue;

      if (element.matches("a[href], [role='link'], [role='heading'], h1, h2, h3, h4")) {
        return element;
      }

      if (!fallback) fallback = element;
    }

    return fallback || cardElement;
  }

  function getInviteDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    return (
      dialogs.find((dialog) => {
        const text = (dialog.textContent || "").toLowerCase();
        return text.includes("invite") || text.includes("convite");
      }) || null
    );
  }

  function getInviteToServerButton() {
    const needles = [
      "Invite to Server",
      "Invite this server",
      "Invite to this server",
      "Invite to server",
      "Invite People",
      "Invite people",
      "Invite friends",
      "Invite friends to server",
      "Invite friends to this server",
      "Invite server members",
      "Invite members",
      "Convidar para o servidor",
      "Convidar pessoas",
      "Invite",
      "Convidar",
    ];
    const selectors = [
      '[aria-label="Invite to Server"]',
      '[aria-label^="Invite to Server"]',
      '[aria-label="Invite people"]',
      '[aria-label="Invite People"]',
      '[aria-label="Convidar para o servidor"]',
      "button",
      "[role='button']",
      "[aria-haspopup='dialog']",
      "[aria-haspopup='menu']",
    ].join(", ");
    const roots = [
      document.querySelector('nav[aria-label$="(server)"]'),
      document.querySelector("header"),
    ].filter(Boolean);

    for (const root of roots) {
      for (const element of root.querySelectorAll(selectors)) {
        if (!(element instanceof HTMLElement)) continue;
        if (!isVisible(element)) continue;
        if (element.closest("#dic-panel")) continue;
        if (element.closest('ul[aria-label="Channels"]')) continue;

        const rect = element.getBoundingClientRect();
        if (rect.top < 0 || rect.top > 220) continue;

        const label = getTextLike(element);
        if (!label) continue;

        if (!needles.some((needle) => label.toLowerCase().includes(needle.toLowerCase()))) continue;
        if (/invite to channel/i.test(label)) continue;
        if (/edit channel/i.test(label)) continue;
        if (/channel/i.test(label)) continue;
        if (/join|joined|preview/i.test(label)) continue;

        return element;
      }
    }

    const serverNav = document.querySelector('nav[aria-label$="(server)"], nav[aria-label*="server"]');
    const fallback = getServerHeaderInviteFallback(serverNav);
    if (fallback) return fallback;

    return null;
  }

  function getServerHeaderInviteFallback(serverNav) {
    if (!(serverNav instanceof HTMLElement)) return null;

    const candidates = [...serverNav.querySelectorAll("button, [role='button']")].filter(
      (element) => element instanceof HTMLElement && isVisible(element),
    );

    const exactLabel = candidates.find((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 220) return false;
      const text = getTextLike(element).replace(/\s+/g, " ").trim().toLowerCase();
      return text.includes("invite to server") || text.includes("invite people") || text.includes("convidar");
    });
    if (exactLabel) return exactLabel;

    const iconButton = candidates.find((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 220) return false;
      const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        getTextLike(element),
      ]
        .filter(Boolean)
        .join(" ")
        .trim()
        .toLowerCase();

      if (label.includes("invite to channel") || label.includes("edit channel")) return false;
      if (label.includes("invite to server") || label.includes("invite people") || label.includes("convidar")) {
        return true;
      }

      return !element.getAttribute("aria-label") && !element.getAttribute("title") && !getTextLike(element) && !!element.querySelector("svg");
    });

    return iconButton || null;
  }

  async function extractInviteFromDialog(dialog) {
    if (!dialog) return null;

    const inputs = [...dialog.querySelectorAll("input, textarea")];
    for (const input of inputs) {
      const value = "value" in input ? input.value : input.textContent || "";
      const invite = extractInviteUrls(value || getTextLike(input))[0];
      if (invite) return invite;
    }

    const anchors = [...dialog.querySelectorAll("a[href]")];
    for (const anchor of anchors) {
      const invite = normalizeInvite(anchor.href || anchor.getAttribute("href") || "");
      if (invite) return invite;
    }

    const dialogInvite = extractInviteUrls(dialog.textContent || "");
    if (dialogInvite.length > 0) return dialogInvite[0];

    return null;
  }

  async function configurePermanentInvite(dialog) {
    if (!dialog) return;

    const options = [
      {
        controlNeedles: ["Expires After", "Expire After", "Expira em", "Expira após", "Expiração"],
        optionNeedles: ["Never", "Nunca", "Não expira", "Sem expiração", "No expiration"],
      },
      {
        controlNeedles: ["Max Uses", "Maximum Uses", "Usos máximos", "Número máximo de usos"],
        optionNeedles: ["No Limit", "Sem limite", "Ilimitado", "Unlimited"],
      },
    ];

    for (const group of options) {
      const control = findClickableByText(group.controlNeedles, dialog);
      if (!control) continue;
      control.click();
      await sleep(400);

      const option = await waitFor(() => findClickableByText(group.optionNeedles, document), 2500);
      if (option) {
        option.click();
        await sleep(400);
      }
    }
  }

  async function openServerFromDiscoverCard(card) {
    const goButton = getDiscoverFirstCardGoButton(card);
    if (goButton) {
      dispatchHumanClick(goButton);
    } else {
      const activationTarget = getDiscoverCardActivationTarget(card.element, card.label || card.key);
      dispatchHumanClick(activationTarget || card.element);
    }
    await sleep(2400);

    return true;
  }

  async function clickInviteToServerFromServer(sourceLabel, serverName = "") {
    const resolvedServerName = extractServerNameFromLabel(serverName || sourceLabel);
    await revealServerHeaderActions(resolvedServerName);
    await sleep(350);

    const inviteButton = await waitFor(() => getInviteToServerButton(), 5000);

    if (!inviteButton) {
      await revealServerHeaderActions(resolvedServerName);
      await sleep(350);
    }

    const retryInviteButton = inviteButton || (await waitFor(() => getInviteToServerButton(), 3500));

    if (!retryInviteButton) {
      throw new Error("Could not find the Invite to Server button.");
    }

    dispatchHumanClick(retryInviteButton);
    await sleep(800);

    const dialog = await waitFor(() => getInviteDialog(), 5000);
    if (!dialog) {
      log("Could not find the invite dialog.");
      throw new Error("Could not find the invite dialog.");
    }

    const invite = await waitFor(() => extractInviteFromDialog(dialog), 5000);
    if (!invite) {
      log("Could not read the invite URL from the dialog.");
      throw new Error("Could not read the invite URL from the dialog.");
    }

    addInviteUrls([invite], sourceLabel);

    await closeInviteDialogAndReturnBack(sourceLabel, resolvedServerName);
    return true;
  }

  async function harvestDiscoverServer(card, query, ordinal) {
    const sourceLabel = `Discover: ${query}`;
    const label = card.label || sourceLabel;
    const sequenceNumber = Math.max(1, Number.isFinite(ordinal) ? ordinal : (Number(loadState().discoverCardCursor) || 0) + 1);

    addDiscoverVisitedCardKey(card.key);
    setDiscoverCurrentCardKey(card.key);
    markDiscoverCardOpened();
    setDiscoverCardCursor(sequenceNumber);

    const languageVerified = await verifyDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
    if (!languageVerified) {
      throw new Error(`Discover language is not "${DISCOVER_LANGUAGE_LABEL}" before opening "${label}".`);
    }

    await openServerFromDiscoverCard(card);
    if (stopRequested) return;

    await closeAllPopups();
    await sleep(400);

    await clickInviteToServerFromServer(sourceLabel, label);
  }

  async function collectDiscoverInvites() {
    const query = getDiscoverQuery();
    if (!query) {
      setStatus("Enter a Discover search term first.");
      return true;
    }

    if (!isDiscoverPage()) {
      setDiscoverPhase("navigate");
      setStatus("Opening Discord Discover servers...");
      if (!isDiscoverUrl()) {
        location.href = DISCOVER_URL;
      }
      return false;
    }

    setStatus("Waiting for Discover page to load...");
    const pageReady = await waitForDiscoverPageReady();
    if (!pageReady || stopRequested) return false;

    const preSearchLanguageCombobox = await getOptionalDiscoverLanguageCombobox();
    if (preSearchLanguageCombobox) {
      const languageReady = await ensureDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
      if (!languageReady || stopRequested) return false;
    }

    setDiscoverSearchReady(false);
    let state = loadState();
    if (!state.discoverSearchReady) {
      setDiscoverPhase("search");
      setStatus(`Searching Discover for "${query}"...`);

      const searchOk = await performDiscoverSearch(query);
      if (!searchOk || stopRequested) return false;

      setDiscoverSearchReady(true);
    }

    const postSearchLanguageReady = await ensureDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
    if (!postSearchLanguageReady || stopRequested) return false;

    const languageVerified = await verifyDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
    if (!languageVerified || stopRequested) return false;

    if (!discoverSearchMatchesQuery(query)) {
      setDiscoverSearchReady(false);
      setDiscoverPhase("search");
      setStatus(`Refreshing Discover search for "${query}"...`);

      const searchOk = await performDiscoverSearch(query);
      if (!searchOk || stopRequested) return false;

      setDiscoverSearchReady(true);

      const refreshedLanguageVerified = await verifyDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
      if (!refreshedLanguageVerified || stopRequested) return false;
    }

    setDiscoverPhase("browse");
    const visitedKeys = getDiscoverVisitedCardKeys();
    const startIndex = Math.max(0, Number(loadState().discoverCardCursor) || 0);
    const card = await findNextDiscoverCardWithScroll(query, visitedKeys, startIndex);
    if (!card) {
      const state = loadState();
      state.running = false;
      state.discoverPhase = "idle";
      state.discoverSearchReady = false;
      state.discoverCurrentCardKey = "";
      state.discoverLastAddedAt = 0;
      state.discoverLastCardOpenedAt = 0;
      state.discoverLastBrowseAt = 0;
      state.statusText = `Finished. No more unvisited Discover results for "${query}".`;
      state.inviteCount = (state.inviteUrls || []).length;
      saveState(state);
      refreshUI();

      return true;
    }

    const ordinal = startIndex + 1;

    try {
      await harvestDiscoverServer(card, query, ordinal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Discover capture error: ${message}`, err);
      await closeAllPopups();
      requestFlowRestart(message);
      return false;
    }

    return true;
  }

  async function closeInviteDialogAndReturnBack(sourceLabel, serverName) {
    const query = getDiscoverQuery();
    await closeAllPopups();
    await sleep(300);

    setDiscoverSearchReady(false);
    if (isDiscoverUrl()) {
      location.reload();
    } else {
      location.href = DISCOVER_URL;
    }
    const returned = await waitForDiscoverReturn(query, 6000);
    if (!returned) {
      throw new Error("Failed to return to the Discover page.");
    }
    return true;
  }

  function getBackButton() {
    const selectors = ["button", "[role='button']", "a"];
    const needles = ["back", "voltar"];

    for (const element of document.querySelectorAll(selectors.join(", "))) {
      if (!(element instanceof HTMLElement)) continue;
      if (!isVisible(element)) continue;
      if (element.closest("#dic-panel")) continue;

      const label = getTextLike(element).replace(/\s+/g, " ").trim().toLowerCase();
      if (!label) continue;
      if (!needles.some((needle) => label.includes(needle))) continue;

      return element;
    }

    return null;
  }

  function closeAllPopups() {
    return (async () => {
      for (let i = 0; i < 3; i++) {
        if (stopRequested) return;

        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((dialog) =>
          isVisible(dialog),
        );
        const dialog = dialogs[0];
        if (!dialog) break;

        const closeBtn = getDialogCloseButton(dialog);
        if (closeBtn) {
          dispatchHumanClick(closeBtn);
          await sleep(400);
          continue;
        }

        dialog.remove();
        await sleep(200);
      }

      const popouts = document.querySelectorAll(
        '[class*="layerContainer"] > [class*="layer"]:not([class*="baseLayer"])',
      );
      for (const popout of popouts) popout.remove();

      await sleep(200);
    })();
  }

  function extractServerNameFromLabel(label) {
    const text = String(label || "").replace(/\s+/g, " ").trim();
    if (!text) return "";

    const markers = [
      "The official community",
      "The unofficial community",
      "The official",
      "The unofficial",
    ];
    for (const marker of markers) {
      const index = text.indexOf(marker);
      if (index > 0) return text.slice(0, index).trim();
    }

    return text;
  }

  async function revealServerHeaderActions(serverName) {
    const targetName = String(serverName || "").trim().toLowerCase();
    const topBand = Math.max(160, Math.round(window.innerHeight * 0.22));
    const candidates = [...document.querySelectorAll("button, [role='button'], h1, h2, h3, [role='heading'], span, div")];

    const matches = candidates.filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.top > topBand) return false;

      const text = getTextLike(element).replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) return false;

      if (!targetName) return rect.left < window.innerWidth * 0.8;
      return text.includes(targetName) || targetName.includes(text);
    });

    const focusTarget =
      matches.find((element) => element.matches("button, [role='button']")) ||
      matches.find((element) => element.querySelector?.("button, [role='button']")) ||
      matches[0];

    const targets = focusTarget ? [focusTarget] : matches.slice(0, 3);
    if (targets.length === 0) return false;

    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      const points = [
        [rect.left + rect.width * 0.78, rect.top + rect.height / 2],
        [rect.left + rect.width - 18, rect.top + Math.max(12, rect.height / 2)],
        [rect.left + rect.width - 40, rect.top + Math.max(12, rect.height / 2)],
        [rect.left + rect.width * 0.65, rect.top + Math.min(18, rect.height - 4)],
      ];

      for (const [rawX, rawY] of points) {
        const x = Math.max(12, Math.min(rawX, window.innerWidth - 12));
        const y = Math.max(12, Math.min(rawY, window.innerHeight - 12));
        const hit = document.elementFromPoint(x, y) || target;

        try {
          for (const eventName of ["pointerover", "pointermove", "mouseover", "mouseenter", "mousemove"]) {
            hit.dispatchEvent(
              new MouseEvent(eventName, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
            );
          }
        } catch (e) {}
      }
    }

    return true;
  }

  function getDialogCloseButton(dialog) {
    if (!(dialog instanceof HTMLElement)) return null;

    const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter((el) =>
      el instanceof HTMLElement && isVisible(el),
    );
    if (buttons.length === 0) return null;

    const dialogRect = dialog.getBoundingClientRect();
    const scoreButton = (button) => {
      const rect = button.getBoundingClientRect();
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .trim()
        .toLowerCase();

      let score = 0;
      if (!label) score += 10;
      if (/\b(close|dismiss|fechar|encerrar)\b/.test(label)) score += 1000;
      if (label === "x" || label === "×") score += 1000;
      if (rect.width <= 56 && rect.height <= 56) score += 100;
      if (rect.left > dialogRect.left + dialogRect.width * 0.65) score += 250;
      if (rect.top < dialogRect.top + dialogRect.height * 0.25) score += 250;
      if (rect.left + rect.width > dialogRect.right - 80) score += 250;
      if (rect.top + rect.height < dialogRect.top + 80) score += 150;
      if (button.closest('[role="dialog"]') === dialog) score += 50;
      return score;
    };

    return buttons.sort((a, b) => scoreButton(b) - scoreButton(a))[0] || null;
  }

  function getServerItems() {
    const nav = document.querySelector('nav[aria-label="Servers sidebar"]');
    if (!nav) return [];

    const tree = nav.querySelector('[role="tree"]');
    if (!tree) return [];

    const items = tree.querySelectorAll('[role="treeitem"]');
    const servers = [];
    const skip = ["Direct Messages", "Add a Server", "Discover", "Download Apps"];

    for (const item of items) {
      const label = (item.textContent || "").trim();
      const dataId = item.getAttribute("data-list-item-id") || "";

      if (skip.some((entry) => label.startsWith(entry))) continue;
      if (item.getAttribute("aria-expanded") !== null) continue;
      if (!dataId.startsWith("guildsnav___")) continue;

      const name = label.replace(/^Unread messages, /, "").replace(/^\d+ mentions?, /, "");
      const guildId = dataId.replace("guildsnav___", "");
      servers.push({ name, element: item, guildId });
    }

    return servers;
  }

  const getMemberItems = () => document.querySelectorAll('[role="listitem"][class*="member__"]');

  const getMemberListContainer = () =>
    document.querySelector('[class*="members_"][class*="thin_"]');

  function getMemberCountFromList() {
    const container = getMemberListContainer();
    if (!container) return null;

    let total = 0;
    const seen = new Set();
    const headers = container.querySelectorAll('h3, [class*="membersGroup"], [aria-label]');

    for (const header of headers) {
      const text = (header.getAttribute("aria-label") || header.textContent || "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);

      const match = text.match(/(?:—|-|–|\s)(\d+)\s*$/);
      if (match) total += parseInt(match[1], 10);
    }

    return total > 0 ? total : null;
  }

  async function ensureMemberListOpen() {
    if (stopRequested) return;

    const btn = document.querySelector('button[aria-label="Show Member List"]');
    if (btn) {
      btn.click();
      await sleep(800);
    }
  }

  function getServerNameFromHeader() {
    const nav = document.querySelector('nav[aria-label$="(server)"]');
    if (!nav) return null;

    const h2 = nav.querySelector("h2");
    if (h2) return h2.textContent.trim();

    return (nav.getAttribute("aria-label") || "").replace(" (server)", "").trim();
  }

  function getCurrentChannelName() {
    const title = normalizeInlineText(document.title || "").replace(/^\(\d+\)\s*/, "");
    const titleMatch = title.match(/^Discord\s+\|\s+(.+?)\s+\|/i);
    if (titleMatch?.[1]) return titleMatch[1];

    const selectors = [
      '[aria-label^="Channel header"] [data-text-variant="heading-lg/semibold"]',
      '[aria-label^="Channel header"] [data-text-variant="heading-md/semibold"]',
      '[aria-label^="Channel header"] h1',
      '[aria-label^="Channel header"] h3',
      '[class*="titleWrapper"] [data-text-variant="heading-lg/semibold"]',
      '[class*="titleWrapper"] [data-text-variant="heading-md/semibold"]',
      'h1[class*="title_"]',
      'h3[class*="title_"]',
    ];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = normalizeInlineText(element.textContent || "");
        if (!text) continue;
        if (/members? online|welcome to|discover$/i.test(text)) continue;
        if (text === getServerNameFromHeader()) continue;
        if (text) return text;
      }
    }

    if (title) return title;
    return "current channel";
  }

  function getCurrentChannelMessages() {
    const selectors = [
      '[data-list-item-id^="chat-messages___"]',
      'li[id^="chat-messages-"]',
      'article[id^="chat-messages-"]',
    ];
    const seen = new Set();
    const messages = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement)) continue;
        const key = String(
          element.getAttribute("data-list-item-id") || element.id || element.dataset.listItemId || "",
        ).trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        messages.push({ element, key });
      }
    }

    return messages;
  }

  function getCurrentChannelMessageScroller() {
    const messages = getCurrentChannelMessages();
    const listRoot = document.querySelector('[data-list-id="chat-messages"]');
    const messageRoot = messages[0]?.element || listRoot;

    let node = listRoot || messageRoot;
    while (node) {
      if (
        node instanceof HTMLElement &&
        node.scrollHeight > node.clientHeight + 20 &&
        /auto|scroll/i.test(getComputedStyle(node).overflowY || "") &&
        node.contains(messageRoot)
      ) {
        return node;
      }
      node = node.parentElement;
    }

    const fallbackSelectors = [
      '[class*="scrollerInner"]',
      'main [class*="messagesWrapper"] [class*="scroller"]',
      'main [class*="chatContent"] [class*="scroller"]',
    ];

    for (const selector of fallbackSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement)) continue;
        if (!element.contains(messageRoot)) continue;
        if (element.scrollHeight > element.clientHeight + 20) return element;
      }
    }

    return null;
  }

  function extractInviteUrlsFromMessage(messageEl) {
    if (!(messageEl instanceof HTMLElement)) return [];

    const textInvites = [];
    const walker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = normalizeInlineText(node.textContent || "");
        if (!text) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("pre, code")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      for (const invite of extractInviteUrls(walker.currentNode.textContent || "")) {
        textInvites.push(invite);
      }
    }

    const hrefInvites = [...messageEl.querySelectorAll("a[href]")]
      .map((anchor) => normalizeInvite(anchor.getAttribute("href") || anchor.href || ""))
      .filter(Boolean);

    return [...new Set([...textInvites, ...hrefInvites])];
  }

  async function collectReaderInviteUrls() {
    const channelName = getCurrentChannelName();
    const scroller = await waitFor(() => getCurrentChannelMessageScroller(), 12000, 150);
    if (!scroller) {
      throw new Error("Could not find the current channel message list.");
    }

    setStatus(`Reading messages in ${channelName}...`);

    scroller.scrollTop = scroller.scrollHeight;
    await sleep(500);

    const visited = new Set();
    let stalePasses = 0;

    while (!stopRequested) {
      const messages = getCurrentChannelMessages();
      const oldestVisibleKey = messages[0]?.key || "";

      let foundNewMessage = false;

      for (const message of [...messages].reverse()) {
        if (stopRequested) break;
        if (visited.has(message.key)) continue;

        visited.add(message.key);
        foundNewMessage = true;
        message.element.scrollIntoView({ block: "nearest" });
        await sleep(50);

        const invites = extractInviteUrlsFromMessage(message.element);
        if (invites.length > 0) {
          addInviteUrls(invites, `Reader: ${channelName}`);
        }
      }

      const oldestVisible = messages[0]?.element || null;
      const before = scroller.scrollTop;
      if (oldestVisible instanceof HTMLElement) {
        oldestVisible.scrollIntoView({ block: "start" });
      }
      scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(500, Math.round(scroller.clientHeight * 0.75)));
      await sleep(1100);

      const after = scroller.scrollTop;
      const nextMessages = getCurrentChannelMessages();
      const nextOldestVisibleKey = nextMessages[0]?.key || "";

      if (!foundNewMessage && oldestVisibleKey === nextOldestVisibleKey) {
        stalePasses += 1;
      } else {
        stalePasses = 0;
      }

      if (after === 0 && !foundNewMessage && oldestVisibleKey === nextOldestVisibleKey) break;
      if (stalePasses >= 3) break;
    }

    refreshCounts();
  }

  function getVisibleMemberIds() {
    const items = getMemberItems();
    const output = [];

    for (const item of items) {
      const dataId =
        item.querySelector("[data-list-item-id]")?.getAttribute("data-list-item-id") || "";
      const text = (item.textContent || "").trim().substring(0, 60);
      output.push({ element: item, key: dataId || text });
    }

    return output;
  }

  function log(message) {
    const logEl = document.getElementById("dic-log");
    const timestamp = new Date().toLocaleTimeString();

    if (logEl) {
      logEl.textContent += `[${timestamp}] ${message}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    }

    const state = loadState();
    state.log += `[${timestamp}] ${message}\n`;
    saveState(state);
  }

  function formatError(err) {
    if (err instanceof Error) {
      return err.stack || `${err.name}: ${err.message}`;
    }

    if (typeof err === "string") return err;

    try {
      return JSON.stringify(err);
    } catch (jsonErr) {
      return String(err);
    }
  }

  function logError(message, err) {
    const details = formatError(err);
    console.error("[DIC]", message, err);
    log(`${message}${details ? ` | ${details}` : ""}`);
  }

  function getDiscoverCardIdentity(element, clickable, text) {
    const href =
      clickable instanceof HTMLElement ? (clickable.getAttribute("href") || clickable.href || "") : "";
    const dataId =
      element instanceof HTMLElement
        ? (element.getAttribute("data-list-item-id") || clickable?.getAttribute?.("data-list-item-id") || "")
        : "";
    const ariaLabel =
      element instanceof HTMLElement
        ? (element.getAttribute("aria-label") || clickable?.getAttribute?.("aria-label") || "")
        : "";

    const parts = [href, dataId, ariaLabel, text.slice(0, 120)]
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    return parts.join(" | ");
  }

  function setStatus(text) {
    const state = loadState();
    state.statusText = text;
    saveState(state);
  }

  function refreshCounts() {
    const state = loadState();
    state.inviteCount = (state.inviteUrls || []).length;
    saveState(state);
    refreshUI();
  }

  function refreshUI() {
    const state = loadState();
    const mode = getCollectorMode();
    const startButton = document.getElementById("dic-start");
    const stopButton = document.getElementById("dic-stop");
    const copyButton = document.getElementById("dic-copy");
    const clearInvitesButton = document.getElementById("dic-clear-invites");
    const clearLogButton = document.getElementById("dic-clear-log");
    const copyLogButton = document.getElementById("dic-copy-log");
    const modeSelect = document.getElementById("dic-mode");
    const discoverRow = document.getElementById("dic-discover-row");
    const discoverInput = document.getElementById("dic-discover-query");
    const status = document.getElementById("dic-status");
    const logEl = document.getElementById("dic-log");
    const countEl = document.getElementById("dic-count");
    const discoverCardEl = document.getElementById("dic-discover-card");
    const discoverCardValueEl = document.getElementById("dic-discover-card-value");
    const indicator = document.getElementById("dic-indicator");
    const startLabel =
      mode === "discover" ? "Start Discover" : mode === "reader" ? "Start Reader" : "Start";

    if (startButton) {
      startButton.disabled = state.running || (mode === "discover" && !getDiscoverQuery());
    }
    if (stopButton) stopButton.disabled = !state.running;
    if (copyButton) copyButton.disabled = state.running || (state.inviteUrls || []).length === 0;
    if (clearInvitesButton) clearInvitesButton.disabled = false;
    if (clearLogButton) clearLogButton.disabled = !(state.log || "").length;
    if (copyLogButton) copyLogButton.disabled = !(state.log || "").length;
    setIconButtonContent(startButton, startLabel, ICONS.play);
    setIconButtonContent(stopButton, "Pause", ICONS.pause);
    setIconButtonContent(copyButton, "Copy collected URLs", ICONS.copy);
    setIconButtonContent(clearInvitesButton, "Clear list", ICONS.trash);
    setIconButtonContent(clearLogButton, "Clear log", ICONS.trash);
    setIconButtonContent(copyLogButton, "Copy log", ICONS.copy);
    if (modeSelect) modeSelect.value = mode;
    if (discoverRow) discoverRow.style.display = mode === "discover" ? "block" : "none";
    if (discoverInput) discoverInput.value = state.discoverQuery || "";
    if (status) status.textContent = "";
    if (countEl) {
      countEl.textContent = `${(state.inviteUrls || []).length}`;
    }
    if (discoverCardEl) {
      const discoverCardIndex = state.running && mode === "discover" ? Number(state.discoverCardCursor) || 0 : 0;
      discoverCardEl.style.display = mode === "discover" ? "" : "none";
      if (discoverCardValueEl) discoverCardValueEl.textContent = `${discoverCardIndex}`;
    }
    if (indicator) {
      indicator.className = state.running ? "dic-indicator is-running" : "dic-indicator";
      indicator.title = state.running ? "Running" : "Idle";
    }

    if (logEl) {
      logEl.textContent = state.log || "";
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function stopScraping() {
    stopRequested = true;
    stopDiscoverWatchdog();

    const state = loadState();
    state.running = false;
    state.discoverPhase = "idle";
    state.discoverLastAddedAt = 0;
    state.statusText = `Stopped. ${formatCollectionSummary((state.inviteUrls || []).length)}`;
    saveState(state);

    refreshUI();
  }

  async function copyCollectedUrls() {
    const state = loadState();
    const text = (state.inviteUrls || []).join("\n");
    await navigator.clipboard.writeText(text);
    setStatus(`Copied invite URLs to clipboard. ${formatCollectionSummary(state.inviteUrls.length)}`);
  }

  function clearCollectedInvites() {
    const state = loadState();
    state.inviteUrls = [];
    state.inviteCount = 0;
    state.discoverCardCursor = 0;
    state.discoverVisitedCardKeys = [];
    state.discoverCurrentCardKey = "";
    saveState(state);
    refreshUI();
    setStatus("");
  }

  async function copyLogText() {
    const state = loadState();
    await navigator.clipboard.writeText(state.log || "");
    setStatus("Log copied to clipboard.");
  }

  function clearLogText() {
    const state = loadState();
    state.log = "";
    saveState(state);
    refreshUI();
    setStatus("");
  }

  function addInviteUrls(urls, sourceLabel) {
    if (!urls || !urls.length) return { added: 0, skippedInvalid: 0 };

    const state = loadState();
    const set = new Set(state.inviteUrls || []);
    let added = 0;
    let skippedInvalid = 0;

    for (const url of urls) {
      const normalized = normalizeInvite(url);
      if (!normalized) {
        skippedInvalid++;
        continue;
      }
      if (set.has(normalized)) continue;

      set.add(normalized);
      added++;
      log(`Collected invite URL from ${sourceLabel}: ${normalized}`);
    }

    if (added > 0) {
      state.inviteUrls = [...set];
      state.inviteCount = state.inviteUrls.length;
      saveState(state);
      if (getCollectorMode() === "discover") {
        markDiscoverProgress();
      }
      refreshUI();
    }

    return { added, skippedInvalid };
  }

  function createUI() {
    document.getElementById("dic-panel")?.remove();

    const panel = document.createElement("div");
    panel.id = "dic-panel";
    panel.innerHTML = `
      <style>
        /* Design tokens mirrored from the SpokPay design system (src/styles.css). */
        #dic-panel {
          --dic-radius: 0.75rem;
          --dic-radius-sm: calc(var(--dic-radius) - 4px);
          --dic-radius-lg: calc(var(--dic-radius) + 4px);
          --dic-background: oklch(0.14 0.01 280);
          --dic-foreground: oklch(0.97 0.005 280);
          --dic-card: oklch(0.18 0.015 280);
          --dic-primary: oklch(0.55 0.25 295);
          --dic-primary-foreground: oklch(0.98 0.005 280);
          --dic-secondary: oklch(0.24 0.02 280);
          --dic-muted: oklch(0.22 0.015 280);
          --dic-muted-foreground: oklch(0.7 0.02 280);
          --dic-accent: oklch(0.32 0.1 295);
          --dic-destructive: oklch(0.62 0.22 27);
          --dic-success: oklch(0.7 0.16 150);
          --dic-border: oklch(1 0 0 / 0.08);
          --dic-input: oklch(1 0 0 / 0.12);
          --dic-ring: oklch(0.55 0.25 295);
          --dic-gradient-brand: linear-gradient(135deg, oklch(0.6 0.25 295), oklch(0.7 0.18 250));
          --dic-shadow-card: 0 1px 2px oklch(0 0 0 / 0.2), 0 4px 16px oklch(0 0 0 / 0.35);
          --dic-shadow-card-hover: 0 2px 4px oklch(0 0 0 / 0.25), 0 12px 28px oklch(0 0 0 / 0.5);

          position: fixed;
          top: 12px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 99999;
          width: 460px;
          max-width: calc(100vw - 24px);
          background: var(--dic-background);
          border: 1px solid var(--dic-border);
          border-radius: var(--dic-radius-lg);
          color: var(--dic-foreground);
          font-family: Sora, 'gg sans', ui-sans-serif, system-ui, sans-serif;
          font-size: 13px;
          box-shadow: var(--dic-shadow-card);
        }
        #dic-panel *,
        #dic-panel *::before,
        #dic-panel *::after {
          box-sizing: border-box;
        }
        #dic-header {
          padding: 10px 14px 10px 12px;
          background: var(--dic-card);
          border-radius: var(--dic-radius-lg) var(--dic-radius-lg) 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid var(--dic-border);
          cursor: grab;
        }
        #dic-title {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        #dic-title span {
          font-weight: 600;
          font-size: 13px;
          letter-spacing: -0.01em;
        }
        #dic-header-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 0 auto;
        }
        #dic-version {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: .04em;
          color: var(--dic-muted-foreground);
          background: var(--dic-muted);
          border: 1px solid var(--dic-border);
          border-radius: 9999px;
          padding: 3px 8px;
          line-height: 1;
        }
        .dic-indicator {
          width: 10px;
          height: 10px;
          border-radius: 9999px;
          background: var(--dic-muted-foreground);
          opacity: .5;
          flex: none;
        }
        .dic-indicator.is-running {
          background: var(--dic-success);
          opacity: 1;
          box-shadow: 0 0 8px color-mix(in oklab, var(--dic-success) 70%, transparent);
        }
        #dic-traffic {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .dic-light {
          width: 12px;
          height: 12px;
          border-radius: 9999px;
          border: 1px solid var(--dic-border);
          box-shadow: inset 0 1px 0 oklch(1 0 0 / 0.14);
          cursor: pointer;
          padding: 0;
          display: inline-block;
        }
        .dic-light.yellow { background: oklch(0.78 0.16 75); }
        .dic-light.green { background: var(--dic-success); }
        #dic-body {
          padding: 12px;
        }
        #dic-mode-row,
        #dic-discover-row {
          margin-bottom: 10px;
        }
        #dic-mode-label,
        #dic-discover-label {
          display: block;
          font-size: 11px;
          font-weight: 600;
          color: var(--dic-muted-foreground);
          margin-bottom: 5px;
        }
        #dic-mode,
        #dic-discover-query {
          width: 100%;
          border: 1px solid var(--dic-input);
          border-radius: var(--dic-radius-sm);
          background: var(--dic-card);
          color: var(--dic-foreground);
          padding: 8px 10px;
          font-family: inherit;
          font-size: 12px;
          outline: none;
          transition: border-color .15s ease, box-shadow .15s ease;
        }
        #dic-mode:focus,
        #dic-discover-query:focus {
          border-color: var(--dic-ring);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--dic-ring) 25%, transparent);
        }
        #dic-discover-query::placeholder {
          color: var(--dic-muted-foreground);
        }
        #dic-actions {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .dic-btn {
          flex: 0 0 auto;
          padding: 6px 12px;
          border: 1px solid transparent;
          border-radius: 9999px;
          background: var(--dic-secondary);
          color: var(--dic-foreground);
          font-family: inherit;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          line-height: 1;
          transition: filter .15s ease, opacity .15s ease;
        }
        .dic-btn:hover:not(:disabled) {
          filter: brightness(1.15);
        }
        .dic-btn:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--dic-ring) 35%, transparent);
        }
        .dic-icon-btn {
          width: 30px;
          min-width: 30px;
          height: 30px;
          padding: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .dic-icon-btn svg {
          width: 14px;
          height: 14px;
          display: block;
          color: currentColor;
          flex: none;
        }
        .dic-btn:disabled {
          opacity: .4;
          cursor: default;
        }
        #dic-start {
          background: var(--dic-primary);
          color: var(--dic-primary-foreground);
        }
        #dic-stop {
          background: var(--dic-destructive);
          color: var(--dic-primary-foreground);
        }
        #dic-copy,
        #dic-clear-invites,
        #dic-clear-log,
        #dic-copy-log {
          background: var(--dic-secondary);
          border-color: var(--dic-border);
          color: var(--dic-muted-foreground);
        }
        #dic-copy:hover:not(:disabled),
        #dic-clear-invites:hover:not(:disabled),
        #dic-clear-log:hover:not(:disabled),
        #dic-copy-log:hover:not(:disabled) {
          color: var(--dic-foreground);
        }
        .dic-sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        #dic-status {
          display: none;
        }
        #dic-stats-card {
          margin-top: 10px;
        }
        #dic-stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 8px;
        }
        .dic-stat {
          position: relative;
          min-width: 0;
          padding: 10px 12px 10px 14px;
          border-radius: var(--dic-radius);
          border: 1px solid var(--dic-border);
          background: var(--dic-card);
          box-shadow: var(--dic-shadow-card);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          text-align: left;
          overflow: hidden;
        }
        .dic-stat::before {
          content: "";
          position: absolute;
          inset: 0 auto 0 0;
          width: 3px;
          background: var(--dic-gradient-brand);
        }
        .dic-stat-label {
          display: block;
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--dic-muted-foreground);
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dic-stat-value {
          display: block;
          min-width: 4ch;
          font-size: clamp(12px, 3.5vw, 17px);
          line-height: 1;
          font-weight: 700;
          color: var(--dic-foreground);
          text-align: right;
          flex: none;
          font-variant-numeric: tabular-nums;
          font-feature-settings: "tnum";
          letter-spacing: -0.02em;
          white-space: nowrap;
        }
        #dic-log-card {
          margin-top: 10px;
          background: var(--dic-card);
          border: 1px solid var(--dic-border);
          border-radius: var(--dic-radius);
          overflow: hidden;
        }
        #dic-log-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 8px 10px;
          border-bottom: 1px solid var(--dic-border);
          background: var(--dic-muted);
        }
        #dic-log-label {
          display: flex;
          align-items: center;
          gap: 7px;
          min-width: 0;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--dic-muted-foreground);
        }
        #dic-log-label svg {
          width: 14px;
          height: 14px;
          flex: none;
        }
        #dic-log-tools {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
        }
        #dic-log {
          padding: 8px 10px 10px;
          max-height: 220px;
          overflow-y: auto;
          font-size: 12px;
          font-family: ui-monospace, Consolas, monospace;
          color: var(--dic-muted-foreground);
          white-space: pre-wrap;
          word-break: break-word;
          scrollbar-width: thin;
          scrollbar-color: color-mix(in oklab, var(--dic-muted-foreground) 35%, transparent) transparent;
        }
        #dic-log::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        #dic-log::-webkit-scrollbar-track {
          background: transparent;
        }
        #dic-log::-webkit-scrollbar-thumb {
          background-color: color-mix(in oklab, var(--dic-muted-foreground) 30%, transparent);
          border-radius: 9999px;
        }
        #dic-log::-webkit-scrollbar-thumb:hover {
          background-color: color-mix(in oklab, var(--dic-muted-foreground) 55%, transparent);
        }
        @media (max-width: 420px) {
          #dic-panel {
            width: calc(100vw - 16px);
            top: 8px;
          }
          #dic-stats-grid {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <div id="dic-header">
        <div id="dic-title">
          <div id="dic-traffic" aria-label="Window controls">
            <button class="dic-light yellow" id="dic-minimize" title="Minimize"></button>
            <button class="dic-light green" id="dic-toggle-size" title="Toggle size"></button>
          </div>
          <span>Discord Invite Collector</span>
        </div>
        <div id="dic-header-meta">
          <div id="dic-version">v${SCRIPT_VERSION}</div>
          <div id="dic-indicator" class="dic-indicator" title="Idle"></div>
        </div>
      </div>
      <div id="dic-body">
        <div id="dic-mode-row">
          <label id="dic-mode-label" for="dic-mode">Mode</label>
          <select id="dic-mode">
            <option value="sidebar">Sidebar</option>
            <option value="discover">Discover</option>
            <option value="reader">Reader</option>
          </select>
        </div>
        <div id="dic-discover-row" style="display:none">
          <label id="dic-discover-label" for="dic-discover-query">Search</label>
          <input id="dic-discover-query" type="text" placeholder="ex: blox fruits" autocomplete="off" spellcheck="false" />
        </div>
        <div id="dic-actions">
          <button class="dic-btn dic-icon-btn" id="dic-start" aria-label="Start"></button>
          <button class="dic-btn dic-icon-btn" id="dic-stop" disabled aria-label="Pause"></button>
          <button class="dic-btn dic-icon-btn" id="dic-copy" disabled aria-label="Copy collected URLs"></button>
          <button class="dic-btn dic-icon-btn" id="dic-clear-invites" disabled aria-label="Clear list"></button>
        </div>
        <div id="dic-status">Idle</div>
        <div id="dic-stats-card">
          <div id="dic-stats-grid">
            <div class="dic-stat" id="dic-discover-card" style="display:none">
              <span class="dic-stat-label">Index</span>
              <span class="dic-stat-value" id="dic-discover-card-value">0</span>
            </div>
            <div class="dic-stat">
              <span class="dic-stat-label">Collected</span>
              <span class="dic-stat-value" id="dic-count">0</span>
            </div>
          </div>
        </div>
        <div id="dic-log-card">
          <div id="dic-log-head">
            <div id="dic-log-label">${ICONS.log}<span>Log</span></div>
            <div id="dic-log-tools">
              <button class="dic-btn dic-icon-btn" id="dic-clear-log" aria-label="Clear log"></button>
              <button class="dic-btn dic-icon-btn" id="dic-copy-log" aria-label="Copy log"></button>
            </div>
          </div>
          <div id="dic-log"></div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    let dragging = false;
    let dx = 0;
    let dy = 0;

    const header = panel.querySelector("#dic-header");
    const body = panel.querySelector("#dic-body");
    const minimizeButton = panel.querySelector("#dic-minimize");
    const toggleSizeButton = panel.querySelector("#dic-toggle-size");
    const modeSelect = panel.querySelector("#dic-mode");
    const discoverInput = panel.querySelector("#dic-discover-query");
    let minimized = false;
    let compact = false;

    header.addEventListener("mousedown", (e) => {
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      dragging = true;
      dx = e.clientX - panel.offsetLeft;
      dy = e.clientY - panel.offsetTop;
      header.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = `${e.clientX - dx}px`;
      panel.style.top = `${e.clientY - dy}px`;
      panel.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
      header.style.cursor = "grab";
    });

    minimizeButton.onclick = () => {
      minimized = !minimized;
      body.style.display = minimized ? "none" : "";
      panel.style.width = minimized ? "240px" : compact ? "340px" : "460px";
    };
    toggleSizeButton.onclick = () => {
      compact = !compact;
      if (!minimized) panel.style.width = compact ? "340px" : "460px";
    };
    modeSelect.onchange = () => setCollectorMode(modeSelect.value);
    discoverInput.oninput = () => setDiscoverQuery(discoverInput.value);
    discoverInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startCollection();
      }
    };
    panel.querySelector("#dic-start").onclick = startCollection;
    panel.querySelector("#dic-stop").onclick = stopScraping;
    panel.querySelector("#dic-copy").onclick = copyCollectedUrls;
    panel.querySelector("#dic-clear-invites").onclick = clearCollectedInvites;
    panel.querySelector("#dic-clear-log").onclick = clearLogText;
    panel.querySelector("#dic-copy-log").onclick = copyLogText;

    refreshUI();
  }

  async function scrapeProfile(memberEl) {
    if (stopRequested) return;

    memberEl.click();
    await sleep(1200);

    if (stopRequested) {
      await closeAllPopups();
      return;
    }

    const popup = document.querySelector('[role="dialog"]');
    if (!popup) return;

    let status = "";
    const statusEl = popup.querySelector('[class*="statusText_"]');
    if (statusEl) status = statusEl.textContent.trim();

    let hasFullProfile = false;
    for (const btn of popup.querySelectorAll('button, [role="button"]')) {
      if (stopRequested) break;

      const label = btn.getAttribute("aria-label") || btn.textContent?.trim();
      if (label === "View Full Profile") {
        btn.click();
        hasFullProfile = true;
        break;
      }
    }

    let bio = "";
    let hrefUrls = [];

    if (hasFullProfile && !stopRequested) {
      await sleep(1500);

      let profileDialog = null;
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (dialog.textContent?.includes("Member Since") || dialog.textContent?.includes("Bio")) {
          profileDialog = dialog;
          break;
        }
      }

      if (profileDialog) {
        const bioHeader = Array.from(profileDialog.querySelectorAll("h2")).find(
          (h) => h.textContent.trim() === "Bio",
        );

        if (bioHeader) {
          const section = bioHeader.closest("section") || bioHeader.parentElement;
          const markup = section?.querySelector('[class*="markup"]');
          if (markup) bio = markup.textContent.trim();
        }

        if (!bio) {
          for (const markup of profileDialog.querySelectorAll('[class*="markup"]')) {
            const text = markup.textContent.trim();
            if (text && !text.includes("Member Since")) {
              bio = text;
              break;
            }
          }
        }

        for (const anchor of profileDialog.querySelectorAll("a[href]")) {
          if (anchor.href?.startsWith("http")) hrefUrls.push(anchor.href);
        }
      }
    }

    const statusInvites = extractInviteUrls(status);
    const bioInvites = extractInviteUrls(bio);
    const hrefInvites = hrefUrls.map(normalizeInvite).filter(Boolean);

    const allInvites = [...new Set([...statusInvites, ...bioInvites, ...hrefInvites])];

    await closeAllPopups();

    if (allInvites.length > 0) {
      addInviteUrls(allInvites, getServerNameFromHeader() || "unknown server");
    }
  }

  async function scanCurrentServerMembers() {
    if (stopRequested) return;

    const serverName = getServerNameFromHeader() || "Unknown Server";
    const state = loadState();
    state.currentServer = serverName;
    saveState(state);

    setStatus(`Scanning members in ${serverName}...`);

    await ensureMemberListOpen();
    if (stopRequested) return;

    await sleep(1000);
    if (stopRequested) return;

    const container = getMemberListContainer();
    if (!container) {
      log("No member list found.");
      return;
    }

    container.scrollTop = 0;
    await sleep(500);

    const visited = new Set();
    let noNewCount = 0;

    while (!stopRequested) {
      const visible = getVisibleMemberIds();
      let foundNew = false;

      for (const { element, key } of visible) {
        if (stopRequested) break;
        if (visited.has(key)) continue;

        visited.add(key);
        foundNew = true;

        element.scrollIntoView({ block: "nearest" });
        await sleep(150);

        if (stopRequested) break;

        try {
          await scrapeProfile(element);
        } catch (err) {
          log(`Error reading member in ${serverName}: ${err.message}`);
          await closeAllPopups();
        }
      }

      if (!foundNew) {
        noNewCount++;
        if (noNewCount >= 3) break;
      } else {
        noNewCount = 0;
      }

      container.scrollTop += 300;
      await sleep(800);
    }
  }

  async function collectSidebarInviteUrls() {
    const nav = document.querySelector('nav[aria-label="Servers sidebar"]');
    const tree = nav?.querySelector('[role="tree"]');

    if (tree) {
      for (const folder of tree.querySelectorAll('[role="treeitem"][aria-expanded="false"]')) {
        if (stopRequested) break;
        if ((folder.getAttribute("data-list-item-id") || "").startsWith("guildsnav___")) {
          folder.click();
          await sleep(800);
        }
      }
    }

    if (stopRequested) return;

    await sleep(500);

    const servers = getServerItems();

    for (let index = 0; index < servers.length; index++) {
      if (stopRequested) break;

      const server = getServerItems()[index];
      if (!server) continue;

      const state = loadState();
      state.serverIndex = index;
      saveState(state);

      server.element.click();
      await sleep(2500);

      if (stopRequested) break;

      const firstChannel = document.querySelector(
        'a[href^="/channels/"][aria-label*="text channel"]',
      );
      if (firstChannel) {
        firstChannel.click();
        await sleep(1500);
      }

      if (stopRequested) break;

      await scanCurrentServerMembers();
    }

    refreshCounts();
  }

  async function startCollection() {
    try {
      stopRequested = false;

      const state = loadState();
      const mode = getCollectorMode();
      state.running = true;
      state.log = "";
      state.inviteUrls = [];
      state.serverIndex = 0;
      state.inviteCount = 0;
      state.discoverPhase = mode === "discover" ? "navigate" : "idle";
      state.discoverSearchReady = false;
      state.discoverVisitedCardKeys = [];
      state.discoverCardCursor = 0;
      state.discoverCurrentCardKey = "";
      state.discoverLastAddedAt = mode === "discover" ? Date.now() : 0;
      state.discoverLastCardOpenedAt = mode === "discover" ? Date.now() : 0;
      state.discoverLastBrowseAt = mode === "discover" ? Date.now() : 0;
      state.statusText =
        mode === "discover"
          ? "Discover scan running..."
          : mode === "reader"
            ? "Reader scan running..."
          : "Scanning Discord...";
      saveState(state);
        refreshUI();

      if (mode === "discover") {
        startDiscoverWatchdog();
        while (!stopRequested) {
          const completed = await collectDiscoverInvites();
          if (stopRequested) break;
          if (!completed) {
            await sleep(1000);
            continue;
          }

          if (!loadState().running) break;
          await sleep(900);
        }
      } else if (mode === "reader") {
        await collectReaderInviteUrls();
      } else {
        await collectSidebarInviteUrls();
      }

      const finalState = loadState();
      finalState.running = false;
      finalState.inviteCount = (finalState.inviteUrls || []).length;
      finalState.discoverPhase = "idle";
      finalState.discoverSearchReady = false;
      finalState.discoverCurrentCardKey = "";
      finalState.discoverLastAddedAt = 0;
      finalState.discoverLastCardOpenedAt = 0;
      finalState.discoverLastBrowseAt = 0;
      stopDiscoverWatchdog();

      if (stopRequested) {
        finalState.statusText = `Stopped. ${formatCollectionSummary(finalState.inviteUrls.length)}`;
      } else {
        finalState.statusText = `Finished. ${formatCollectionSummary(finalState.inviteUrls.length)}`;
      }

      saveState(finalState);
      refreshUI();
    } catch (err) {
      const state = loadState();
      const message = err instanceof Error ? err.message : String(err);
      logError(`ERROR: ${message}`, err);

      if (getCollectorMode() === "discover" && requestFlowRestart(message)) {
        return;
      }

      stopDiscoverWatchdog();
      if (state.running) {
        state.running = false;
        state.discoverPhase = "idle";
        state.discoverSearchReady = false;
        state.discoverCurrentCardKey = "";
        state.discoverLastAddedAt = 0;
        state.discoverLastCardOpenedAt = 0;
        state.discoverLastBrowseAt = 0;
        state.statusText = `Error: ${message}`;
        saveState(state);
        refreshUI();
      }
    }
  }

  createUI();
  resumeDiscoverCollectionIfNeeded().catch((err) => {
    logError("Resume failed", err);
  });
})();
