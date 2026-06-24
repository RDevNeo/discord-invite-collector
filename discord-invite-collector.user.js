// ==UserScript==
// @name         Discord Invite Collector
// @namespace    spokpay-crm
// @version      1.10.0
// @description  Collect Discord invite URLs from public profiles or Discover, skipping invites already in your site database or blacklist.
// @match        https://discord.com/*
// @match        https://*.discord.com/*
// @grant        GM_xmlhttpRequest
// @connect      spokpay-crm.vercel.app
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    // Set this to the deployed website that exposes /api/public routes.
    // Example: "https://your-site.com"
    BOARD_API_BASE_URL: "https://spokpay-crm.vercel.app",
  };

  const DISCOVER_URL = "https://discord.com/discovery/servers";
  const DISCOVER_URL_PATH = "/discovery/servers";
  const DISCOVER_RESULTS_URL = "https://discord.com/servers";
  const DISCOVER_LANGUAGE_LABEL = "Português do Brasil";
  const SCRIPT_VERSION = "1.10.0";

  const LS_KEY = "discord_invite_url_collector_state";
  let _memState = null;
  let stopRequested = false;
  let restartTimer = null;
  let discoverWatchdogTimer = null;

  const catalog = {
    loading: false,
    loaded: false,
    userLoaded: false,
    loadPromise: null,
    error: null,
    knownInviteUrls: new Set(),
    knownServerIds: new Set(),
  };

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

  function isConfigured(value) {
    return Boolean(value) && !String(value).includes("YOUR-");
  }

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
      catalogMatchKeys: [],
      catalogMatchCount: 0,
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

  function getCatalogMatchKeys() {
    const state = loadState();
    return new Set(Array.isArray(state.catalogMatchKeys) ? state.catalogMatchKeys : []);
  }

  function addCatalogMatch(matchKey, label = "") {
    const normalizedKey = String(matchKey || "").trim();
    if (!normalizedKey) return false;

    const state = loadState();
    const keys = new Set(Array.isArray(state.catalogMatchKeys) ? state.catalogMatchKeys : []);
    if (keys.has(normalizedKey)) return false;

    keys.add(normalizedKey);
    state.catalogMatchKeys = [...keys];
    state.catalogMatchCount = keys.size;
    saveState(state);
    refreshUI();

    if (label) {
      log(`Catalog match already known by the website: ${label}`);
    }

    return true;
  }

  function getCatalogMatchCount() {
    const state = loadState();
    const stored = Number(state.catalogMatchCount);
    return Number.isFinite(stored) && stored >= 0 ? stored : getCatalogMatchKeys().size;
  }

  function formatCollectionSummary(inviteCount, catalogMatchCount = getCatalogMatchCount()) {
    const invites = Math.max(0, Number(inviteCount) || 0);
    const known = Math.max(0, Number(catalogMatchCount) || 0);
    return known > 0
      ? `${invites} invite URL(s) collected, ${known} Database`
      : `${invites} invite URL(s) collected.`;
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
      log(`Stage: Discover language already "${targetLabel}"`);
      return true;
    }

    log(`Stage: change Discover language from "${currentValue || "unknown"}" to "${targetLabel}"`);

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
        log(`Stage: Discover language ready as "${targetLabel}"`);
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
      log(`Stage: scroll Discover language options for "${targetLabel}" (attempt ${attempt + 1}, ${before}->${scroller.scrollTop})`);
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
      log(`Stage: verified Discover language "${targetLabel}"`);
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

    log(
      `Restart requested: ${message} | phase=${state.discoverPhase} cursor=${state.discoverCardCursor} visited=${
        Array.isArray(state.discoverVisitedCardKeys) ? state.discoverVisitedCardKeys.length : 0
      } searchReady=${Boolean(state.discoverSearchReady)}`,
    );

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
        log(
          `Discover watchdog restart: phase=${state.discoverPhase} cursor=${state.discoverCardCursor} visited=${
            Array.isArray(state.discoverVisitedCardKeys) ? state.discoverVisitedCardKeys.length : 0
          } searchReady=${Boolean(state.discoverSearchReady)} lastAddedAgo=${
            Date.now() - (Number(state.discoverLastAddedAt) || 0)
          }ms lastOpenedAgo=${Date.now() - (Number(state.discoverLastCardOpenedAt) || 0)}ms lastBrowseAgo=${
            Date.now() - (Number(state.discoverLastBrowseAt) || 0)
          }ms`,
        );
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

    await loadWebsiteCatalog();
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
          target: describeScrollableElement(container),
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
          target: describeScrollableElement(container),
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
      target: `windowY=${before}->${after}`,
    };
  }

  async function findNextDiscoverCardWithScroll(query, visitedKeys, startIndex) {
    const maxScrollAttempts = 20;
    const initialCards = getDiscoverCards();
    log(
      `Discover scan snapshot for "${query}": cards=${initialCards.length}, visited=${visitedKeys.size}, cursor=${startIndex}, scroll=${describeScrollableElement(
        getDiscoverScrollContainer(),
      )}`,
    );
    if (initialCards.length) {
      log(`Discover card sample for "${query}": ${describeDiscoverCardSamples(initialCards)}`);
    }

    for (let attempt = 0; attempt <= maxScrollAttempts; attempt++) {
      const waitTime = attempt === 0 ? 5000 : 1800;
      const card = await waitFor(() => getDiscoverNextCard(visitedKeys), waitTime);
      if (card) {
        if (attempt > 0) {
          log(
            `Stage: found next Discover card for "${query}" after ${attempt} scroll attempt(s) from cursor ${startIndex}`,
          );
        }
        return card;
      }

      if (attempt >= maxScrollAttempts) break;

      const amount = attempt < 4 ? 1100 : attempt < 10 ? 1600 : 2400;
      const scrollResult = scrollDiscoverResults(amount);
      if (!scrollResult.scrolled) {
        log(
          `Discover scroll stalled for "${query}" (attempt ${attempt + 1}, amount ${amount}): ${scrollResult.target}`,
        );
        break;
      }

      log(
        `Stage: scroll Discover results for "${query}" to reveal more cards (attempt ${attempt + 1}, amount ${amount}, ${scrollResult.mode}, ${scrollResult.before}->${scrollResult.after})`,
      );
      await sleep(attempt < 4 ? 1200 : 1600);
    }

    const finalCards = getDiscoverCards();
    log(
      `Discover scan exhausted for "${query}": cards=${finalCards.length}, visited=${visitedKeys.size}, cursor=${startIndex}, scroll=${describeScrollableElement(
        getDiscoverScrollContainer(),
      )}`,
    );
    if (finalCards.length) {
      log(`Discover exhausted sample for "${query}": ${describeDiscoverCardSamples(finalCards)}`);
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

  function describeElement(element) {
    if (!(element instanceof HTMLElement)) return null;

    const rect = element.getBoundingClientRect();
    const text = getTextLike(element).replace(/\s+/g, " ").trim();
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || "",
      aria: (element.getAttribute("aria-label") || "").trim(),
      title: (element.getAttribute("title") || "").trim(),
      text: text.slice(0, 140),
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  function getInviteButtonCandidates() {
    const selectors = [
      '[aria-label*="Invite"]',
      '[title*="Invite"]',
      '[data-tooltip*="Invite"]',
      '[aria-label*="Convidar"]',
      '[title*="Convidar"]',
      '[data-tooltip*="Convidar"]',
      "button",
      "[role='button']",
    ].join(", ");

    return [...document.querySelectorAll(selectors)]
      .filter((element) => element instanceof HTMLElement && isVisible(element))
      .map(describeElement)
      .filter(Boolean)
      .filter((item) => {
        const hay = `${item.aria} ${item.title} ${item.text}`.toLowerCase();
        return hay.includes("invite") || hay.includes("convidar");
      })
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .slice(0, 12);
  }

  function logInviteButtonProbe(context) {
    const candidates = getInviteButtonCandidates();
    log(`${context} | page="${document.title}" url="${location.href}" invite_candidates=${JSON.stringify(candidates)}`);
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
      log(`Stage: click Discover card go button for "${card.label || card.key || "unknown"}"`);
      dispatchHumanClick(goButton);
    } else {
      const activationTarget = getDiscoverCardActivationTarget(card.element, card.label || card.key);
      log(`Stage: click Discover card activation target for "${card.label || card.key || "unknown"}"`);
      dispatchHumanClick(activationTarget || card.element);
    }
    await sleep(2400);

    return true;
  }

  async function clickInviteToServerFromServer(sourceLabel, serverName = "", options = {}) {
    const resolvedServerName = extractServerNameFromLabel(serverName || sourceLabel);
    log(`Stage: reveal server actions for "${resolvedServerName || sourceLabel}"`);
    await revealServerHeaderActions(resolvedServerName);
    await sleep(350);

    log(`Stage: locate invite button for "${resolvedServerName || sourceLabel}"`);
    const inviteButton = await waitFor(() => getInviteToServerButton(), 5000);

    if (!inviteButton) {
      logInviteButtonProbe(`Invite button not found after first probe for "${resolvedServerName || sourceLabel}"`);
      log(`Stage: retry server action reveal for "${resolvedServerName || sourceLabel}"`);
      await revealServerHeaderActions(resolvedServerName);
      await sleep(350);
    }

    const retryInviteButton = inviteButton || (await waitFor(() => getInviteToServerButton(), 3500));

    if (!retryInviteButton) {
      log("Could not find the Invite to Server button.");
      logInviteButtonProbe(`Invite button missing after retry for "${resolvedServerName || sourceLabel}"`);
      throw new Error("Could not find the Invite to Server button.");
    }

    log(
      `Stage: click invite button for "${resolvedServerName || sourceLabel}" candidate=${JSON.stringify(
        describeElement(retryInviteButton),
      )}`,
    );
    dispatchHumanClick(retryInviteButton);
    await sleep(800);

    log(`Stage: wait for invite dialog for "${resolvedServerName || sourceLabel}"`);
    const dialog = await waitFor(() => getInviteDialog(), 5000);
    if (!dialog) {
      log("Could not find the invite dialog.");
      throw new Error("Could not find the invite dialog.");
    }

    log(`Stage: extract invite URL from dialog for "${resolvedServerName || sourceLabel}"`);
    const invite = await waitFor(() => extractInviteFromDialog(dialog), 5000);
    if (!invite) {
      log("Could not read the invite URL from the dialog.");
      throw new Error("Could not read the invite URL from the dialog.");
    }

    addInviteUrls([invite], sourceLabel, options);
    log(`Copied invite URL from dialog for ${sourceLabel}: ${invite}`);

    await closeInviteDialogAndReturnBack(sourceLabel, resolvedServerName);
    return true;
  }

  async function harvestDiscoverServer(card, query, ordinal) {
    const sourceLabel = `Discover: ${query}`;
    const label = card.label || sourceLabel;
    const sequenceNumber = Math.max(1, Number.isFinite(ordinal) ? ordinal : (Number(loadState().discoverCardCursor) || 0) + 1);

    log(`Stage: open Discover result card "${label}"`);
    addDiscoverVisitedCardKey(card.key);
    setDiscoverCurrentCardKey(card.key);
    markDiscoverCardOpened();
    setDiscoverCardCursor(sequenceNumber);
    log(`Stage: advance Discover cursor to ${sequenceNumber} after "${label}"`);

    const languageVerified = await verifyDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
    if (!languageVerified) {
      throw new Error(`Discover language is not "${DISCOVER_LANGUAGE_LABEL}" before opening "${label}".`);
    }

    await openServerFromDiscoverCard(card);
    if (stopRequested) return;

    log(`Stage: close post-open popups for "${label}"`);
    await closeAllPopups();
    await sleep(400);

    const guildId = getCurrentGuildId();
    if (catalog.loaded && guildId && catalog.knownServerIds.has(guildId)) {
      addCatalogMatch(`guild:${guildId}`, `${label} (server ID ${guildId})`);
    }

    log(`Stage: start invite flow for "${label}"`);
    await clickInviteToServerFromServer(sourceLabel, label, {
      catalogMatchKey: guildId ? `guild:${guildId}` : "",
      catalogMatchLabel: label,
    });
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
      log(`Stage: navigate to Discover URL ${DISCOVER_URL} for "${query}"`);
      if (!isDiscoverUrl()) {
        location.href = DISCOVER_URL;
      }
      return false;
    }

    setStatus("Waiting for Discover page to load...");
    log(`Stage: wait for Discover page to be ready for "${query}"`);
    const pageReady = await waitForDiscoverPageReady();
    if (!pageReady || stopRequested) return false;

    const preSearchLanguageCombobox = await getOptionalDiscoverLanguageCombobox();
    if (preSearchLanguageCombobox) {
      log(`Stage: ensure Discover language "${DISCOVER_LANGUAGE_LABEL}" before search for "${query}"`);
      const languageReady = await ensureDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
      if (!languageReady || stopRequested) return false;
    } else {
      log(
        `Stage: Discover language combobox is not visible before search for "${query}"; will enforce "${DISCOVER_LANGUAGE_LABEL}" after search`,
      );
    }

    setDiscoverSearchReady(false);
    let state = loadState();
    if (!state.discoverSearchReady) {
      setDiscoverPhase("search");
      setStatus(`Searching Discover for "${query}"...`);
      log(`Stage: search Discover for "${query}" with language "${DISCOVER_LANGUAGE_LABEL}"`);

      const searchOk = await performDiscoverSearch(query);
      if (!searchOk || stopRequested) return false;

      setDiscoverSearchReady(true);
      log(`Stage: Discover search ready for "${query}"`);
    }

    log(`Stage: ensure Discover language "${DISCOVER_LANGUAGE_LABEL}" after search for "${query}"`);
    const postSearchLanguageReady = await ensureDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
    if (!postSearchLanguageReady || stopRequested) return false;

    const languageVerified = await verifyDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
    if (!languageVerified || stopRequested) return false;

    if (!discoverSearchMatchesQuery(query)) {
      log(`Stage: Discover search needs refresh after language verification for "${query}"`);
      setDiscoverSearchReady(false);
      setDiscoverPhase("search");
      setStatus(`Refreshing Discover search for "${query}"...`);
      log(`Stage: re-search Discover for "${query}" with language "${DISCOVER_LANGUAGE_LABEL}"`);

      const searchOk = await performDiscoverSearch(query);
      if (!searchOk || stopRequested) return false;

      setDiscoverSearchReady(true);
      log(`Stage: Discover search ready after language verification for "${query}"`);

      const refreshedLanguageVerified = await verifyDiscoverLanguage(DISCOVER_LANGUAGE_LABEL);
      if (!refreshedLanguageVerified || stopRequested) return false;
    }

    setDiscoverPhase("browse");
    const visitedKeys = getDiscoverVisitedCardKeys();
    const startIndex = Math.max(0, Number(loadState().discoverCardCursor) || 0);
    log(`Stage: wait for next Discover result card for "${query}" from cursor ${startIndex}`);
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

      log(
        `Stage: Discover results exhausted for "${query}" | cards=${getDiscoverCards().length} visited=${visitedKeys.size} cursor=${startIndex}`,
      );
      return true;
    }

    const ordinal = startIndex + 1;
    log(
      `Stage: open Discover result card #${ordinal} "${card.label}"${Number.isFinite(card.index) ? ` (visible rank ${card.index + 1})` : ""}`,
    );

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
    log(`Stage: close invite dialog for "${serverName || sourceLabel}"`);
    await closeAllPopups();
    await sleep(300);

    log(`Stage: return to Discover URL after copying invite for "${serverName || sourceLabel}"`);
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

  function gmRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest is not available"));
        return;
      }

      GM_xmlhttpRequest({
        method: options.method || "GET",
        url,
        headers: options.headers || {},
        data: options.data,
        responseType: "text",
        onload: (res) => {
          resolve({
            status: res.status,
            text: res.responseText || "",
            headers: res.responseHeaders || "",
          });
        },
        onerror: () => reject(new Error("NetworkError when attempting to fetch resource.")),
        ontimeout: () => reject(new Error("Request timed out")),
      });
    });
  }

  async function fetchJson(url, options = {}) {
    const useGM = typeof GM_xmlhttpRequest === "function";
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };

    let status = 0;
    let text = "";

    if (useGM) {
      const res = await gmRequest(url, {
        method: options.method || "GET",
        headers,
        data: options.body,
      });
      status = res.status;
      text = res.text;
    } else {
      const res = await fetch(url, {
        credentials: "omit",
        ...options,
        headers,
      });
      status = res.status;
      text = await res.text();
    }

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error(`Invalid JSON from ${url}`);
    }
    if (status < 200 || status >= 300) {
      throw new Error(data?.error || `HTTP ${status} from ${url}`);
    }
    return data;
  }

  async function loadWebsiteCatalog() {
    if (catalog.loaded) {
      catalog.userLoaded = true;
      return catalog;
    }
    if (catalog.loadPromise) return catalog.loadPromise;

    catalog.loadPromise = (async () => {
      if (!isConfigured(CONFIG.BOARD_API_BASE_URL)) {
        catalog.error = "Catalog config is incomplete. Set BOARD_API_BASE_URL.";
        log(catalog.error);
        return catalog;
      }

      catalog.loading = true;
      setStatus("Loading website server list and blacklist...");
      log("Loading existing servers and blacklist from the website...");

      try {
        const [serversData, blacklistData] = await Promise.all([
          fetchJson(`${CONFIG.BOARD_API_BASE_URL.replace(/\/+$/, "")}/api/public/servers`),
          fetchJson(`${CONFIG.BOARD_API_BASE_URL.replace(/\/+$/, "")}/api/public/blacklist`),
        ]);

        const serverRows = Array.isArray(serversData?.servers) ? serversData.servers : [];
        const blacklistRows = Array.isArray(blacklistData?.blacklist)
          ? blacklistData.blacklist
          : [];

        for (const row of serverRows) {
          const invite = normalizeInvite(row?.invite_url);
          if (invite) catalog.knownInviteUrls.add(invite);
          if (row?.discord_server_id) catalog.knownServerIds.add(String(row.discord_server_id));
        }

        for (const row of blacklistRows) {
          const invite = normalizeInvite(row?.invite_url);
          if (invite) catalog.knownInviteUrls.add(invite);
          if (row?.discord_server_id) catalog.knownServerIds.add(String(row.discord_server_id));
        }

        catalog.loaded = true;
        catalog.userLoaded = true;
        catalog.error = null;
        log(
          `Catalog loaded: ${catalog.knownInviteUrls.size} invite URL(s), ${catalog.knownServerIds.size} server ID(s).`,
        );
        setStatus("");
      } catch (err) {
        catalog.error = err instanceof Error ? err.message : String(err);
        logError(`Catalog load failed: ${catalog.error}`, err);
        setStatus("Catalog load failed. Scan will continue without filtering.");
      } finally {
        catalog.loading = false;
        refreshUI();
      }

      return catalog;
    })();

    try {
      return await catalog.loadPromise;
    } finally {
      catalog.loadPromise = null;
    }
  }

  async function reloadWebsiteCatalog() {
    catalog.loading = false;
    catalog.loaded = false;
    catalog.error = null;
    catalog.loadPromise = null;
    catalog.knownInviteUrls = new Set();
    catalog.knownServerIds = new Set();
    return loadWebsiteCatalog();
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
    log(`Stage: start Reader mode in "${channelName}"`);

    scroller.scrollTop = scroller.scrollHeight;
    await sleep(500);

    const visited = new Set();
    let stalePasses = 0;

    while (!stopRequested) {
      const messages = getCurrentChannelMessages();
      const oldestVisibleKey = messages[0]?.key || "";
      log(`Stage: Reader visible messages=${messages.length} visited=${visited.size} in "${channelName}"`);

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
          log(`Stage: Reader collected ${invites.length} invite candidate(s) from message ${message.key}`);
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
      log(
        `Stage: Reader scroll up in "${channelName}" ${before}->${after} visible=${nextMessages.length} oldest=${oldestVisibleKey} next_oldest=${nextOldestVisibleKey}`,
      );

      if (!foundNewMessage && oldestVisibleKey === nextOldestVisibleKey) {
        stalePasses += 1;
      } else {
        stalePasses = 0;
      }

      if (after === 0 && !foundNewMessage && oldestVisibleKey === nextOldestVisibleKey) break;
      if (stalePasses >= 3) break;
    }

    log(`Stage: Reader finished in "${channelName}" with ${visited.size} scanned message(s)`);
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
    console.log("[DIC]", message);
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

  function describeDiscoverCard(card) {
    if (!card) return "none";
    return `#${Number.isFinite(card.index) ? card.index + 1 : "?"} ${card.label || card.key || "unknown"}`;
  }

  function describeScrollableElement(element) {
    if (!(element instanceof HTMLElement)) return "none";

    const tag = element.tagName.toLowerCase();
    const className =
      typeof element.className === "string" && element.className.trim()
        ? `.${element.className.trim().replace(/\s+/g, ".").slice(0, 80)}`
        : "";
    const label = (element.getAttribute("aria-label") || element.getAttribute("data-list-id") || "").trim();

    return `${tag}${className}${label ? ` aria="${label.slice(0, 40)}"` : ""} scrollTop=${Math.round(
      element.scrollTop,
    )} scrollHeight=${Math.round(element.scrollHeight)} clientHeight=${Math.round(element.clientHeight)}`;
  }

  function describeDiscoverCardSamples(cards) {
    if (!Array.isArray(cards) || cards.length === 0) return "cards=[]";

    const sample = (card) => describeDiscoverCard(card);
    const first = cards.slice(0, 3).map(sample).join(" | ");
    const last = cards.slice(-3).map(sample).join(" | ");
    return `first=[${first}] last=[${last}]`;
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

  let globalErrorHooksInstalled = false;

  function installGlobalErrorHooks() {
    if (globalErrorHooksInstalled || typeof window === "undefined") return;
    globalErrorHooksInstalled = true;

    window.addEventListener("error", (event) => {
      const err = event?.error || event?.message || "Unknown window error";
      logError("Window error", err);
    });

    window.addEventListener("unhandledrejection", (event) => {
      const err = event?.reason || "Unknown promise rejection";
      logError("Unhandled promise rejection", err);
    });
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
    const knownCountEl = document.getElementById("dic-known-count");
    const countEl = document.getElementById("dic-count");
    const discoverCardEl = document.getElementById("dic-discover-card");
    const discoverCardValueEl = document.getElementById("dic-discover-card-value");
    const catalogEl = document.getElementById("dic-catalog");
    const indicator = document.getElementById("dic-indicator");
    const startLabel =
      mode === "discover" ? "Start Discover" : mode === "reader" ? "Start Reader" : "Start";

    if (startButton) {
      startButton.disabled =
        state.running ||
        catalog.loading ||
        !catalog.userLoaded ||
        (mode === "discover" && !getDiscoverQuery());
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
    const catalogMatchCount = getCatalogMatchCount();
    if (knownCountEl) {
      knownCountEl.textContent = `${catalogMatchCount}`;
    }
    if (countEl) {
      countEl.textContent = `${(state.inviteUrls || []).length}`;
    }
    if (discoverCardEl) {
      const discoverCardIndex = state.running && mode === "discover" ? Number(state.discoverCardCursor) || 0 : 0;
      discoverCardEl.style.display = mode === "discover" ? "" : "none";
      if (discoverCardValueEl) discoverCardValueEl.textContent = `${discoverCardIndex}`;
    }
    if (catalogEl) {
      if (catalog.loaded) {
        catalogEl.textContent = "";
      } else if (catalog.loading) {
        catalogEl.textContent = "";
      } else if (catalog.error) {
        catalogEl.textContent = "";
      } else {
        catalogEl.textContent = "";
      }
    }
    if (indicator) {
      indicator.className = catalog.loaded
        ? "mt-[1px] h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(74,222,128,0.9)]"
        : catalog.loading
          ? "mt-[1px] h-2.5 w-2.5 rounded-full bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.9)]"
          : "mt-[1px] h-2.5 w-2.5 rounded-full bg-zinc-500";
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

    log("Stop requested.");
    refreshUI();
  }

  async function copyCollectedUrls() {
    const state = loadState();
    const text = (state.inviteUrls || []).join("\n");
    await navigator.clipboard.writeText(text);
    const summary = formatCollectionSummary(state.inviteUrls.length);
    log(`Copied ${state.inviteUrls.length} invite URL(s) to clipboard. ${summary}`);
    setStatus(`Copied invite URLs to clipboard. ${summary}`);
  }

  function clearCollectedInvites() {
    const state = loadState();
    const count = (state.inviteUrls || []).length;
    state.inviteUrls = [];
    state.inviteCount = 0;
    state.catalogMatchKeys = [];
    state.catalogMatchCount = 0;
    state.discoverCardCursor = 0;
    state.discoverVisitedCardKeys = [];
    state.discoverCurrentCardKey = "";
    saveState(state);
    refreshUI();
    log(`Cleared ${count} collected invite URL(s) and reset DB-known count.`);
    setStatus("");
  }

  async function copyLogText() {
    const state = loadState();
    await navigator.clipboard.writeText(state.log || "");
    setStatus("Log copied to clipboard.");
    log("Copied full log to clipboard.");
  }

  function clearLogText() {
    const state = loadState();
    state.log = "";
    saveState(state);
    refreshUI();
    log("Log cleared.");
    setStatus("");
  }

  function addInviteUrls(urls, sourceLabel, options = {}) {
    if (!urls || !urls.length) return { added: 0, skippedKnown: 0, skippedInvalid: 0 };

    const state = loadState();
    const set = new Set(state.inviteUrls || []);
    const catalogMatchKey = String(options.catalogMatchKey || "").trim();
    const catalogMatchLabel = String(options.catalogMatchLabel || sourceLabel || "").trim();
    let added = 0;
    let skippedKnown = 0;
    let skippedInvalid = 0;

    for (const url of urls) {
      const normalized = normalizeInvite(url);
      if (!normalized) {
        skippedInvalid++;
        continue;
      }
      if (catalog.loaded && catalog.knownInviteUrls.has(normalized)) {
        skippedKnown++;
        addCatalogMatch(catalogMatchKey || `invite:${normalized}`, catalogMatchLabel);
        continue;
      }
      if (set.has(normalized)) continue;

      set.add(normalized);
      catalog.knownInviteUrls.add(normalized);
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

    if (skippedKnown > 0) {
      log(`Skipped ${skippedKnown} invite URL(s) already present in the website catalog.`);
    }
    if (skippedInvalid > 0) {
      log(`Ignored ${skippedInvalid} non-invite link(s).`);
    }

    return { added, skippedKnown, skippedInvalid };
  }

  function createUI() {
    document.getElementById("dic-panel")?.remove();

    const panel = document.createElement("div");
    panel.id = "dic-panel";
    panel.innerHTML = `
      <style>
        #dic-panel {
          position: fixed;
          top: 12px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 99999;
          width: 460px;
          max-width: calc(100vw - 24px);
          background: #1e1f22;
          border: 1px solid #34363c;
          border-radius: 14px;
          color: #dbdee1;
          font-family: 'gg sans', sans-serif;
          font-size: 13px;
          box-shadow: 0 8px 24px rgba(0,0,0,.4);
        }
        #dic-header {
          padding: 10px 14px 10px 12px;
          background: linear-gradient(180deg, #2b2d31 0%, #232428 100%);
          border-radius: 14px 14px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #34363c;
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
        }
        #dic-header-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 0 auto;
        }
        #dic-version {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: .04em;
          color: #a5abb3;
          background: rgba(255,255,255,.06);
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 9999px;
          padding: 3px 7px;
          line-height: 1;
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
          border: 1px solid rgba(255,255,255,.14);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.14);
          cursor: pointer;
          padding: 0;
          display: inline-block;
        }
        .dic-light.red { background: #ff5f57; }
        .dic-light.yellow { background: #febc2e; }
        .dic-light.green { background: #28c840; }
        #dic-body {
          padding: 10px 12px 12px;
        }
        #dic-mode-row,
        #dic-discover-row {
          margin-bottom: 8px;
        }
        #dic-mode-label,
        #dic-discover-label {
          display: block;
          font-size: 11px;
          font-weight: 600;
          color: #949ba4;
          margin-bottom: 4px;
        }
        #dic-mode,
        #dic-discover-query {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid #34363c;
          border-radius: 8px;
          background: #111214;
          color: #dbdee1;
          padding: 7px 9px;
          font-size: 12px;
          outline: none;
        }
        #dic-actions {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .dic-btn {
          flex: 0 0 auto;
          padding: 5px 10px;
          border: none;
          border-radius: 9999px;
          color: white;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          min-width: 0;
          line-height: 1;
        }
        .dic-icon-btn {
          width: 28px;
          min-width: 28px;
          height: 28px;
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
          opacity: .45;
          cursor: default;
        }
        #dic-start { background: #4d64ff; }
        #dic-stop { background: #da373c; }
        #dic-copy { background: #40444b; }
        #dic-clear-invites { background: #40444b; }
        #dic-clear-log { background: #40444b; }
        #dic-copy-log { background: #40444b; }
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
        #dic-catalog {
          display: none;
        }
        #dic-stats-card {
          margin-top: 8px;
          padding: 0;
          background: transparent;
          border: 0;
          box-shadow: none;
        }
        #dic-stats-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
        .dic-stat {
          min-width: 0;
          padding: 8px 10px;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background:
            linear-gradient(180deg, rgba(98, 77, 149, 0.98), rgba(70, 55, 107, 0.98));
          box-shadow:
            0 10px 24px rgba(0, 0, 0, 0.18),
            inset 0 1px 0 rgba(255, 255, 255, 0.08);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          text-align: left;
        }
        .dic-stat-label {
          display: block;
          margin-bottom: 0;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.74);
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dic-stat-value {
          display: block;
          min-width: 5ch;
          font-size: clamp(12px, 3.5vw, 16px);
          line-height: 1;
          font-weight: 800;
          color: #ffffff;
          text-align: right;
          flex: none;
          font-variant-numeric: tabular-nums;
          font-feature-settings: "tnum";
          letter-spacing: -0.02em;
          white-space: nowrap;
        }
        #dic-log-card {
          margin-top: 8px;
          background: #111214;
          border: 1px solid #34363c;
          border-radius: 10px;
          overflow: hidden;
        }
        #dic-log-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 8px 10px;
          border-bottom: 1px solid #34363c;
          background: rgba(255, 255, 255, 0.02);
        }
        #dic-log-label {
          display: flex;
          align-items: center;
          gap: 7px;
          min-width: 0;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: #dbdee1;
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
          margin-top: 0;
          padding: 8px 10px 10px;
          max-height: 220px;
          overflow-y: auto;
          font-size: 12px;
          font-family: Consolas, monospace;
          color: #b5bac1;
          white-space: pre-wrap;
          word-break: break-word;
          scrollbar-width: thin;
          scrollbar-color: rgba(185, 189, 197, 0.35) transparent;
        }
        #dic-log::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        #dic-log::-webkit-scrollbar-track {
          background: transparent;
        }
        #dic-log::-webkit-scrollbar-thumb {
          background-color: rgba(185, 189, 197, 0.3);
          border-radius: 9999px;
        }
        #dic-log::-webkit-scrollbar-thumb:hover {
          background-color: rgba(185, 189, 197, 0.55);
        }
        #dic-close {
          background: none;
          border: none;
          color: #949ba4;
          cursor: pointer;
          font-size: 18px;
          padding: 0 4px;
        }
        @media (max-width: 420px) {
          #dic-panel {
            width: calc(100vw - 16px);
            top: 8px;
          }
          #dic-stats-grid {
            grid-template-columns: 1fr;
          }
          .dic-stat {
            padding: 8px 10px;
          }
          .dic-stat-value {
            min-width: 4ch;
            font-size: clamp(12px, 5vw, 16px);
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
          <div id="dic-indicator" class="mt-[1px] h-2.5 w-2.5 rounded-full bg-zinc-500"></div>
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
        <div id="dic-catalog">Catalog not loaded.</div>
        <div id="dic-stats-card">
          <div id="dic-stats-grid">
            <div class="dic-stat" id="dic-discover-card" style="display:none">
              <span class="dic-stat-label">Index</span>
              <span class="dic-stat-value" id="dic-discover-card-value">0</span>
            </div>
            <div class="dic-stat">
              <span class="dic-stat-label">Database</span>
              <span class="dic-stat-value" id="dic-known-count">0</span>
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
    log(`Scanning members in ${serverName}`);

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
    log(`Found ${servers.length} servers to scan.`);

    for (let index = 0; index < servers.length; index++) {
      if (stopRequested) break;

      const server = getServerItems()[index];
      if (!server) continue;

      const state = loadState();
      state.serverIndex = index;
      saveState(state);

      log(`\n=== ${index + 1}/${servers.length}: ${server.name} ===`);

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
      if (!catalog.loaded) {
        setStatus("Loading catalog...");
        await loadWebsiteCatalog();
      }
      if (!catalog.loaded) {
        setStatus(catalog.error || "Catalog load failed.");
        return;
      }
      stopRequested = false;

      const state = loadState();
      const mode = getCollectorMode();
      state.running = true;
      state.log = "";
      state.inviteUrls = [];
      state.serverIndex = 0;
      state.inviteCount = 0;
      state.catalogMatchKeys = [];
      state.catalogMatchCount = 0;
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

      await loadWebsiteCatalog();
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
      finalState.catalogMatchCount = getCatalogMatchCount();
      finalState.discoverPhase = "idle";
      finalState.discoverSearchReady = false;
      finalState.discoverCurrentCardKey = "";
      finalState.discoverLastAddedAt = 0;
      finalState.discoverLastCardOpenedAt = 0;
      finalState.discoverLastBrowseAt = 0;
      stopDiscoverWatchdog();

      if (stopRequested) {
        finalState.statusText = `Stopped. ${formatCollectionSummary(finalState.inviteUrls.length, finalState.catalogMatchCount)}`;
      } else {
        finalState.statusText = `Finished. ${formatCollectionSummary(finalState.inviteUrls.length, finalState.catalogMatchCount)}`;
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
        state.catalogMatchCount = getCatalogMatchCount();
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
  installGlobalErrorHooks();
  loadWebsiteCatalog().catch(() => {});
  resumeDiscoverCollectionIfNeeded().catch((err) => {
    console.error("[DIC] resume error", err);
  });
  console.log("[DIC] ready");
})();
