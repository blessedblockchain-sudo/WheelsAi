/*!
 * WheelsAI web chat widget.
 *
 *   <script src="https://APP/widget.js" data-wheelsai-key="wpk_..." data-api="https://API" async></script>
 *
 * One file, no dependencies, nothing global except window.WheelsAI. It draws
 * inside a shadow root, under an element that resets every property, so the
 * host page's styles neither match nor are inherited and its own do not leak
 * out; the stylesheet is constructed, not inlined, so a host
 * Content-Security-Policy needs no 'unsafe-inline' for styles (it needs this
 * script's origin in script-src and the API's origin in connect-src).
 *
 * The key is public. What it may do is decided on the server: which sites
 * may use it, how many messages, and which tools the agent may use for an
 * anonymous visitor. This file only shows what the server answers. Every
 * string that comes from the network is written with textContent.
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var KEY_PATTERN = /^wpk_[A-Za-z0-9_-]{32}$/;
  var COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
  var DEFAULT_COLOR = "#2563eb";
  // The server's own limits (GET config) replace these once it answers.
  var DEFAULT_LIMITS = { maxMessageChars: 4000, maxMessages: 20, maxTotalChars: 16000 };
  var STORED_MESSAGES = 60;

  var script = document.currentScript;
  var warn = function (message) {
    if (window.console && console.warn) console.warn("[WheelsAI widget] " + message);
  };

  if (window.WheelsAI && window.WheelsAI.loaded) {
    warn("the script is on this page twice; the second copy did nothing.");
    return;
  }
  if (!script) {
    warn("load this file with a <script src> tag, not as a module or through eval.");
    return;
  }
  var publicKey = script.getAttribute("data-wheelsai-key") || "";
  var apiBase = (script.getAttribute("data-api") || "").replace(/\/+$/, "");
  if (!KEY_PATTERN.test(publicKey)) {
    warn("data-wheelsai-key is missing or is not a web chat key (wpk_...).");
    return;
  }
  if (!/^https?:\/\/[^\s/]+/i.test(apiBase)) {
    warn("data-api is missing; copy the whole snippet from your WheelsAI dashboard.");
    return;
  }
  var endpoint = apiBase + "/api/widget/" + publicKey;

  // ------------------------------------------------------------------
  // What survives a page change: this tab's conversation, nothing else.
  // ------------------------------------------------------------------

  var storageKey = "wheelsai:w:" + publicKey;

  function newSessionId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.prototype.map
        .call(bytes, function (b) {
          return ("0" + b.toString(16)).slice(-2);
        })
        .join("");
    } catch (_) {
      return "s" + String(Date.now()) + String(Math.random()).slice(2, 14) + "0000000000000000".slice(0, 8);
    }
  }

  function loadStored() {
    try {
      var raw = window.sessionStorage.getItem(storageKey);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.sessionId !== "string" || !Array.isArray(parsed.messages)) return null;
      var messages = [];
      for (var i = 0; i < parsed.messages.length; i++) {
        var m = parsed.messages[i];
        if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content) {
          messages.push({ role: m.role, content: m.content });
        }
      }
      return { sessionId: parsed.sessionId, messages: messages };
    } catch (_) {
      // Storage can be blocked (private mode, a sandboxed frame). The chat
      // still works; it just starts over on the next page.
      return null;
    }
  }

  function saveStored() {
    try {
      window.sessionStorage.setItem(
        storageKey,
        JSON.stringify({ sessionId: state.sessionId, messages: state.messages.slice(-STORED_MESSAGES) }),
      );
    } catch (_) {}
  }

  var stored = loadStored();
  var state = {
    open: false,
    /** null until the server answered; then its config. */
    config: null,
    configLoading: false,
    /** A refusal that ends the chat on this page (wrong site, no such key). */
    blocked: null,
    sessionId: stored ? stored.sessionId : newSessionId(),
    messages: stored ? stored.messages : [],
    sending: false,
    abort: null,
    /** Epoch ms until which the server asked us to wait. */
    waitUntil: 0,
    timer: null,
  };

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var name in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, name)) node.setAttribute(name, attrs[name]);
      }
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  function icon(pathData) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pathData);
    svg.appendChild(path);
    return svg;
  }

  var CSS = [
    // The host element sits in the page's own tree, where the page's rules
    // (a `* { ... !important }` reset, say) still reach it and would be
    // inherited from it. So it carries nothing: everything hangs off .wa,
    // inside the shadow root, where no page rule can match, and .wa starts
    // every property over.
    ":host{all:initial}",
    ".wa{all:initial;position:fixed;z-index:2147483000;bottom:20px;right:20px;display:block;",
    "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;",
    "--wa-primary:" + DEFAULT_COLOR + ";--wa-on-primary:#fff;",
    "--wa-bg:#fff;--wa-fg:#0f172a;--wa-muted:#475569;--wa-border:#cbd5e1;--wa-bubble:#f1f5f9;",
    "--wa-danger-bg:#fef2f2;--wa-danger-fg:#991b1b;color:var(--wa-fg)}",
    ".wa[data-position='bottom-left']{right:auto;left:20px}",
    "@media (prefers-color-scheme:dark){.wa{--wa-bg:#0f172a;--wa-fg:#f1f5f9;--wa-muted:#94a3b8;--wa-border:#334155;",
    "--wa-bubble:#1e293b;--wa-danger-bg:#450a0a;--wa-danger-fg:#fecaca}}",
    "*,*::before,*::after{box-sizing:border-box}",
    "[hidden]{display:none!important}",
    "button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;padding:0;margin:0}",
    "button:disabled{cursor:not-allowed;opacity:.55}",
    ":focus-visible{outline:2px solid var(--wa-primary);outline-offset:2px}",
    ".launcher{width:56px;height:56px;border-radius:50%;background:var(--wa-primary);color:var(--wa-on-primary);",
    "display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(15,23,42,.28);",
    "transition:transform .15s ease}",
    ".launcher:hover{transform:scale(1.05)}",
    ".launcher:focus-visible{outline-color:var(--wa-fg)}",
    "svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".panel{position:absolute;bottom:68px;right:0;width:380px;max-width:calc(100vw - 40px);height:560px;",
    "max-height:calc(100vh - 108px);display:flex;flex-direction:column;background:var(--wa-bg);color:var(--wa-fg);",
    "border:1px solid var(--wa-border);border-radius:14px;overflow:hidden;box-shadow:0 16px 48px rgba(15,23,42,.3);",
    "animation:wa-in .16s ease-out}",
    ".wa[data-position='bottom-left'] .panel{right:auto;left:0}",
    "@keyframes wa-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
    ".head{display:flex;align-items:center;gap:8px;padding:12px 12px 12px 16px;background:var(--wa-primary);",
    "color:var(--wa-on-primary)}",
    ".title{flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;",
    "white-space:nowrap}",
    ".icon-btn{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;",
    "color:inherit}",
    ".icon-btn svg{width:18px;height:18px}",
    ".icon-btn:hover{background:rgba(127,127,127,.25)}",
    ".head .icon-btn:focus-visible{outline-color:var(--wa-on-primary)}",
    ".log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}",
    ".msg{max-width:86%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}",
    ".msg.assistant{align-self:flex-start;background:var(--wa-bubble);border-bottom-left-radius:4px}",
    ".msg.user{align-self:flex-end;background:var(--wa-primary);color:var(--wa-on-primary);border-bottom-right-radius:4px}",
    ".msg.pending{color:var(--wa-muted);font-style:italic}",
    ".note{align-self:center;margin:0;font-size:12px;color:var(--wa-muted);text-align:center}",
    ".alert{margin:0 14px 10px;padding:9px 12px;border-radius:10px;background:var(--wa-danger-bg);",
    "color:var(--wa-danger-fg);font-size:13px;display:flex;gap:10px;align-items:center}",
    ".alert span{flex:1}",
    ".alert button{font-weight:600;text-decoration:underline;white-space:nowrap}",
    ".form{display:flex;gap:8px;align-items:flex-end;padding:10px 12px;border-top:1px solid var(--wa-border)}",
    "textarea{flex:1;min-height:40px;max-height:120px;resize:none;font:inherit;color:var(--wa-fg);",
    "background:var(--wa-bg);border:1px solid var(--wa-border);border-radius:10px;padding:9px 10px;margin:0}",
    "textarea::placeholder{color:var(--wa-muted)}",
    "textarea:disabled{opacity:.6}",
    ".send{width:40px;height:40px;flex:none;border-radius:10px;background:var(--wa-primary);color:var(--wa-on-primary);",
    "display:flex;align-items:center;justify-content:center}",
    ".send svg{width:18px;height:18px}",
    ".foot{display:flex;justify-content:space-between;gap:8px;padding:0 14px 10px;font-size:11px;color:var(--wa-muted)}",
    ".foot a{color:inherit;text-decoration:underline}",
    ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
    "@media (max-width:480px){.panel{position:fixed;inset:0;width:100%;max-width:none;height:100%;max-height:none;",
    "border:0;border-radius:0}.wa[data-open] .launcher{display:none}}",
    "@media (prefers-reduced-motion:reduce){.panel{animation:none}.launcher{transition:none}",
    ".launcher:hover{transform:none}}",
    "@media (forced-colors:active){.launcher,.send,.head{border:1px solid ButtonText}}",
  ].join("");

  var host = el("div", { "data-wheelsai-widget": "" });
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : null;
  if (!root) {
    warn("this browser has no shadow DOM, so the widget cannot isolate itself and did not load.");
    return;
  }

  (function applyStyles() {
    try {
      if ("adoptedStyleSheets" in root && typeof CSSStyleSheet === "function") {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (_) {}
    // Older browsers. Under a strict style-src this needs the script's
    // nonce, which is passed on when the host gave the script one.
    var style = el("style");
    if (script.nonce) style.setAttribute("nonce", script.nonce);
    style.textContent = CSS;
    root.appendChild(style);
  })();

  var frame = el("div", { class: "wa" });
  root.appendChild(frame);

  var panelId = "wheelsai-panel";
  var launcher = el("button", {
    type: "button",
    class: "launcher",
    "aria-label": "Open chat",
    "aria-expanded": "false",
    "aria-controls": panelId,
    "aria-haspopup": "dialog",
  });
  var launcherOpenIcon = icon("M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z");
  var launcherCloseIcon = icon("M6 6l12 12M18 6L6 18");
  launcherCloseIcon.setAttribute("hidden", "");
  launcher.appendChild(launcherOpenIcon);
  launcher.appendChild(launcherCloseIcon);

  var panel = el("div", { id: panelId, class: "panel", role: "dialog", "aria-labelledby": "wheelsai-title", hidden: "" });
  var head = el("div", { class: "head" });
  var title = el("h2", { id: "wheelsai-title", class: "title" }, "Chat");
  var resetButton = el("button", { type: "button", class: "icon-btn", "aria-label": "Start a new conversation" });
  resetButton.appendChild(icon("M3 12a9 9 0 1 0 3-6.7M3 4v5h5"));
  var closeButton = el("button", { type: "button", class: "icon-btn", "aria-label": "Close chat" });
  closeButton.appendChild(icon("M6 6l12 12M18 6L6 18"));
  head.appendChild(title);
  head.appendChild(resetButton);
  head.appendChild(closeButton);

  // role=log announces additions politely; a streaming answer is announced
  // once, when it is complete (the sr-only line below), not token by token.
  var log = el("div", { class: "log", role: "log", "aria-label": "Conversation", "aria-live": "off", tabindex: "0" });
  var announcer = el("div", { class: "sr", "aria-live": "polite", "aria-atomic": "true" });

  var alertBox = el("div", { class: "alert", role: "alert", hidden: "" });
  var alertText = el("span");
  var alertAction = el("button", { type: "button", hidden: "" }, "Try again");
  alertBox.appendChild(alertText);
  alertBox.appendChild(alertAction);

  var form = el("form", { class: "form", novalidate: "" });
  var inputLabel = el("label", { class: "sr", for: "wheelsai-input" }, "Your message");
  var input = el("textarea", {
    id: "wheelsai-input",
    rows: "1",
    placeholder: "Type a message",
    maxlength: String(DEFAULT_LIMITS.maxMessageChars),
    autocomplete: "off",
    enterkeyhint: "send",
  });
  var sendButton = el("button", { type: "submit", class: "send", "aria-label": "Send message" });
  sendButton.appendChild(icon("M5 12h14M13 6l6 6-6 6"));
  form.appendChild(inputLabel);
  form.appendChild(input);
  form.appendChild(sendButton);

  var foot = el("div", { class: "foot", hidden: "" });
  var transcriptNote = el("span", { hidden: "" }, "This conversation is saved by the site owner.");
  // The link goes where this script came from, which is the WheelsAI site
  // that issued the key; no address is written into this file.
  var homeUrl = "";
  try {
    homeUrl = new URL(script.src, document.baseURI).origin;
  } catch (_) {}
  var poweredBy = el(
    homeUrl && homeUrl !== "null" ? "a" : "span",
    homeUrl && homeUrl !== "null" ? { href: homeUrl, target: "_blank", rel: "noopener noreferrer", hidden: "" } : { hidden: "" },
    "Powered by WheelsAI",
  );
  foot.appendChild(transcriptNote);
  foot.appendChild(poweredBy);

  panel.appendChild(head);
  panel.appendChild(log);
  panel.appendChild(announcer);
  panel.appendChild(alertBox);
  panel.appendChild(form);
  panel.appendChild(foot);
  frame.appendChild(panel);
  frame.appendChild(launcher);

  /** Black or white, whichever reads better on the owner's colour (WCAG relative luminance). */
  function textOn(hex) {
    var channel = function (offset) {
      var v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    var luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    return luminance > 0.179 ? "#0f172a" : "#ffffff";
  }

  function applyConfig(config) {
    var appearance = (config && config.appearance) || {};
    var agentName = config && config.agent && typeof config.agent.name === "string" ? config.agent.name : "";
    var name = typeof appearance.title === "string" && appearance.title ? appearance.title : agentName || "Chat";
    title.textContent = name;
    launcher.setAttribute("aria-label", state.open ? "Close chat" : config ? "Open chat with " + name : "Open chat");
    var color = COLOR_PATTERN.test(appearance.primaryColor || "") ? appearance.primaryColor : DEFAULT_COLOR;
    // Set through the CSSOM, which a style-src policy does not restrict.
    frame.style.setProperty("--wa-primary", color);
    frame.style.setProperty("--wa-on-primary", textOn(color));
    if (appearance.position === "bottom-left") frame.setAttribute("data-position", "bottom-left");
    else frame.removeAttribute("data-position");
    var limits = limitsNow();
    input.setAttribute("maxlength", String(limits.maxMessageChars));
    if (config) {
      // Shown unless the server says the owner's plan lets them hide it.
      poweredBy.hidden = config.poweredBy === false;
      transcriptNote.hidden = config.transcriptsStored !== true;
      foot.hidden = poweredBy.hidden && transcriptNote.hidden;
    }
  }

  function limitsNow() {
    var given = (state.config && state.config.limits) || {};
    var pick = function (name) {
      return typeof given[name] === "number" && given[name] > 0 ? given[name] : DEFAULT_LIMITS[name];
    };
    return {
      maxMessageChars: pick("maxMessageChars"),
      maxMessages: pick("maxMessages"),
      maxTotalChars: pick("maxTotalChars"),
    };
  }

  function bubble(role, text) {
    var node = el("p", { class: "msg " + role });
    // textContent, always: an answer that contains markup is shown as text.
    node.textContent = text;
    node.appendChild(el("span", { class: "sr" }, role === "user" ? " (you)" : " (assistant)"));
    return node;
  }

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }

  function renderLog() {
    while (log.firstChild) log.removeChild(log.firstChild);
    var greeting = state.config && state.config.appearance && state.config.appearance.greeting;
    if (typeof greeting === "string" && greeting) log.appendChild(bubble("assistant", greeting));
    for (var i = 0; i < state.messages.length; i++) {
      log.appendChild(bubble(state.messages[i].role, state.messages[i].content));
    }
    if (state.configLoading) log.appendChild(el("p", { class: "note" }, "Loading..."));
    scrollDown();
  }

  function showAlert(message, retry) {
    alertText.textContent = message;
    alertAction.hidden = !retry;
    alertAction.onclick = retry || null;
    alertBox.hidden = false;
  }

  function clearAlert() {
    alertBox.hidden = true;
    alertAction.onclick = null;
  }

  function refreshControls() {
    var waiting = state.waitUntil > Date.now();
    var unusable = Boolean(state.blocked) || !state.config;
    input.disabled = unusable;
    sendButton.disabled = unusable || state.sending || waiting;
    resetButton.disabled = state.messages.length === 0 && !state.sending;
  }

  // ------------------------------------------------------------------
  // Refusals, said plainly
  // ------------------------------------------------------------------

  function clip(text, max) {
    return typeof text === "string" && text ? text.slice(0, max) : "";
  }

  /** How long the server asked us to wait, in seconds, or 0. */
  function retryAfter(response, body) {
    var header = null;
    try {
      header = response.headers.get("retry-after");
    } catch (_) {}
    var seconds = Number(header);
    if (!(seconds > 0) && body && typeof body.retryAfterSeconds === "number") seconds = body.retryAfterSeconds;
    return seconds > 0 && isFinite(seconds) ? Math.min(Math.ceil(seconds), 86400) : 0;
  }

  function duration(seconds) {
    if (seconds < 60) return seconds + (seconds === 1 ? " second" : " seconds");
    var minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? " minute" : " minutes");
    var hours = Math.ceil(minutes / 60);
    return hours + (hours === 1 ? " hour" : " hours");
  }

  /** Counts a wait down in the alert, then lets the visitor send again. */
  function startWait(message, seconds, retry) {
    state.waitUntil = Date.now() + seconds * 1000;
    if (state.timer) clearInterval(state.timer);
    var tick = function () {
      var left = Math.ceil((state.waitUntil - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(state.timer);
        state.timer = null;
        state.waitUntil = 0;
        showAlert(message + " You can try again now.", retry);
        refreshControls();
        return;
      }
      showAlert(message + " Try again in " + duration(left) + ".", null);
    };
    tick();
    state.timer = setInterval(tick, 1000);
    refreshControls();
  }

  /**
   * A refused request, as the visitor should read it. `blocking` refusals
   * are about this page, not this moment: retrying cannot help.
   */
  function describe(status, body) {
    var code = body && typeof body.error === "string" ? body.error : "";
    if (status === 403 || code === "origin_not_allowed") {
      return { blocking: true, message: "This chat is not set up for this site. The site owner needs to allow it." };
    }
    if (status === 404) {
      return { blocking: true, message: "This chat is no longer available." };
    }
    if (status === 429) {
      if (code === "rate_limited" && body && body.scope === "ip") {
        return { message: "You are sending messages too quickly." };
      }
      return { message: "This chat has reached its message limit for now." };
    }
    if (status === 400 || status === 413) {
      return { message: clip(body && body.message, 200) || "That message could not be sent." };
    }
    if (status === 501) return { message: "This agent cannot answer in a chat window yet." };
    if (status === 502) return { message: "The agent could not answer just now." };
    if (status === 503) return { message: "This chat is temporarily unavailable." };
    return { message: "Something went wrong." };
  }

  function readJson(response) {
    return response.text().then(function (text) {
      try {
        var parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (_) {
        return null;
      }
    });
  }

  function refuse(response, retry) {
    return readJson(response).then(function (body) {
      var said = describe(response.status, body);
      if (said.blocking) {
        state.blocked = said.message;
        showAlert(said.message, null);
        refreshControls();
        return;
      }
      var seconds = retryAfter(response, body);
      if (seconds > 0) startWait(said.message, seconds, retry);
      else showAlert(said.message, retry);
    });
  }

  // ------------------------------------------------------------------
  // The two requests
  // ------------------------------------------------------------------

  function loadConfig() {
    if (state.config || state.configLoading || state.blocked) return;
    state.configLoading = true;
    clearAlert();
    renderLog();
    fetch(endpoint + "/config", { method: "GET", credentials: "omit", mode: "cors" })
      .then(function (response) {
        if (!response.ok) return refuse(response, loadConfig);
        return readJson(response).then(function (config) {
          if (!config) throw new Error("unreadable");
          state.config = config;
          applyConfig(config);
        });
      })
      .catch(function () {
        showAlert("The chat service could not be reached.", loadConfig);
      })
      .then(function () {
        state.configLoading = false;
        renderLog();
        refreshControls();
        if (state.open && state.config) input.focus();
      });
  }

  /** The newest turns that fit the server's limits, starting with one of the visitor's. */
  function outgoing() {
    var limits = limitsNow();
    var picked = [];
    var total = 0;
    for (var i = state.messages.length - 1; i >= 0 && picked.length < limits.maxMessages; i--) {
      var message = state.messages[i];
      var content = message.content.slice(0, limits.maxMessageChars);
      if (total + content.length > limits.maxTotalChars) break;
      total += content.length;
      picked.unshift({ role: message.role, content: content });
    }
    while (picked.length > 1 && picked[0].role !== "user") picked.shift();
    return picked;
  }

  /**
   * Reads the answer as it arrives. Resolves with the text; rejects with
   * { partial } when the stream said it failed or ended without finishing.
   */
  function readStream(response, onDelta, onTools) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var text = "";
    var finished = false;

    function handle(line) {
      if (line.slice(0, 5) !== "data:") return;
      var data = line.slice(5).trim();
      if (data === "[DONE]") {
        finished = true;
        return;
      }
      var parsed;
      try {
        parsed = JSON.parse(data);
      } catch (_) {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      // A failure can arrive inside a 200 stream. A half answer is never
      // shown as a whole one.
      if (parsed.error) throw { streamError: true };
      if (parsed.wheelsai && Array.isArray(parsed.wheelsai.toolCalls)) onTools(parsed.wheelsai.toolCalls);
      var choice = parsed.choices && parsed.choices[0];
      var delta = choice && choice.delta && choice.delta.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        onDelta(text);
      }
    }

    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) {
          if (buffer) handle(buffer);
          if (!finished) throw { streamError: true };
          return text;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (var i = 0; i < lines.length; i++) {
          handle(lines[i].replace(/\r$/, ""));
          if (finished) return text;
        }
        return pump();
      });
    }

    return pump().catch(function (err) {
      try {
        reader.cancel();
      } catch (_) {}
      throw { partial: text, aborted: Boolean(err && err.name === "AbortError") };
    });
  }

  function toolNote(calls) {
    var names = [];
    for (var i = 0; i < calls.length; i++) {
      var call = calls[i];
      if (!call || typeof call.name !== "string") continue;
      names.push(clip(call.name, 64) + (call.status === "ok" ? "" : " (not available)"));
    }
    return names.length ? "Used: " + names.join(", ") : "";
  }

  /** Sends what is in state.messages (its last turn is the visitor's). */
  function deliver() {
    if (state.sending || state.blocked || !state.config) return;
    var body = outgoing();
    if (!body.length || body[body.length - 1].role !== "user") return;

    state.sending = true;
    clearAlert();
    var pending = el("p", { class: "msg assistant pending" }, "Thinking...");
    log.appendChild(pending);
    scrollDown();
    refreshControls();

    var controller = typeof AbortController === "function" ? new AbortController() : null;
    state.abort = controller;
    var failed = function (message) {
      if (pending.parentNode) pending.parentNode.removeChild(pending);
      showAlert(message, deliver);
    };

    fetch(endpoint + "/chat", {
      method: "POST",
      mode: "cors",
      // Never the visitor's cookies: this is a call from someone else's site.
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: body, sessionId: state.sessionId, stream: true }),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (response) {
        if (!response.ok) {
          if (pending.parentNode) pending.parentNode.removeChild(pending);
          return refuse(response, deliver);
        }
        var type = response.headers.get("content-type") || "";
        var done = function (text) {
          if (!text) return failed("The agent sent an empty answer.");
          pending.className = "msg assistant";
          pending.textContent = text;
          pending.appendChild(el("span", { class: "sr" }, " (assistant)"));
          state.messages.push({ role: "assistant", content: text });
          saveStored();
          announcer.textContent = text;
          scrollDown();
        };
        if (type.indexOf("text/event-stream") === -1 || !response.body) {
          return readJson(response).then(function (answer) {
            done(answer && answer.message && typeof answer.message.content === "string" ? answer.message.content : "");
          });
        }
        return readStream(
          response,
          function (text) {
            pending.className = "msg assistant";
            pending.textContent = text;
            scrollDown();
          },
          function (calls) {
            var note = toolNote(calls);
            if (note) log.insertBefore(el("p", { class: "note" }, note), pending);
          },
        ).then(done);
      })
      .catch(function (err) {
        if (err && (err.aborted || err.name === "AbortError")) {
          if (pending.parentNode) pending.parentNode.removeChild(pending);
          return;
        }
        if (err && typeof err.partial === "string") {
          return failed(
            err.partial
              ? "The answer was cut off before it finished, so it is not shown."
              : "The agent could not answer just now.",
          );
        }
        failed("The chat service could not be reached.");
      })
      .then(function () {
        state.sending = false;
        state.abort = null;
        refreshControls();
      });
  }

  function submit() {
    var text = input.value.replace(/^\s+|\s+$/g, "");
    if (!text || state.sending || state.blocked || !state.config || state.waitUntil > Date.now()) return;
    var limits = limitsNow();
    if (text.length > limits.maxMessageChars) {
      showAlert("Messages can be up to " + limits.maxMessageChars + " characters.", null);
      return;
    }
    state.messages.push({ role: "user", content: text });
    saveStored();
    log.appendChild(bubble("user", text));
    input.value = "";
    autosize();
    deliver();
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight + 2, 120) + "px";
  }

  // ------------------------------------------------------------------
  // Opening, closing, keys
  // ------------------------------------------------------------------

  function open() {
    if (state.open) return;
    state.open = true;
    panel.hidden = false;
    frame.setAttribute("data-open", "");
    launcher.setAttribute("aria-expanded", "true");
    launcher.setAttribute("aria-label", "Close chat");
    launcherOpenIcon.setAttribute("hidden", "");
    launcherCloseIcon.removeAttribute("hidden");
    renderLog();
    refreshControls();
    if (state.blocked) showAlert(state.blocked, null);
    loadConfig();
    if (state.config && !state.blocked) input.focus();
    else closeButton.focus();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    panel.hidden = true;
    frame.removeAttribute("data-open");
    launcher.setAttribute("aria-expanded", "false");
    launcherOpenIcon.removeAttribute("hidden");
    launcherCloseIcon.setAttribute("hidden", "");
    applyConfig(state.config);
    // Back to where the visitor was before they opened it.
    launcher.focus();
  }

  function reset() {
    if (state.abort) state.abort.abort();
    state.messages = [];
    state.sessionId = newSessionId();
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch (_) {}
    if (!state.blocked && state.waitUntil <= Date.now()) clearAlert();
    renderLog();
    refreshControls();
    if (state.open && state.config) input.focus();
  }

  function destroy() {
    if (state.abort) state.abort.abort();
    if (state.timer) clearInterval(state.timer);
    if (host.parentNode) host.parentNode.removeChild(host);
    if (window.WheelsAI === api) delete window.WheelsAI;
  }

  launcher.addEventListener("click", function () {
    if (state.open) close();
    else open();
  });
  closeButton.addEventListener("click", close);
  resetButton.addEventListener("click", reset);
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    submit();
  });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", function (event) {
    // Enter sends; Shift+Enter is a new line. Not while an IME is composing.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  root.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.open) {
      event.stopPropagation();
      close();
    }
  });

  var api = {
    loaded: true,
    version: VERSION,
    open: open,
    close: close,
    toggle: function () {
      if (state.open) close();
      else open();
    },
    /** Forgets this tab's conversation and starts another. */
    reset: reset,
    /** Removes the widget from the page. */
    destroy: destroy,
  };
  window.WheelsAI = api;

  applyConfig(null);
  refreshControls();

  function mount() {
    if (!host.parentNode) document.body.appendChild(host);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
