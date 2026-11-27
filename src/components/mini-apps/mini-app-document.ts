import type { AppDocument } from "../../../shared/app";
import { APP_PROTOCOL_VERSION } from "../../../shared/app";
import { buildSrcdoc, stripDocumentPreamble } from "../../../shared/app-frame/document";
import { APP_THEME_STYLE } from "../../../shared/app-frame/helper";
import { hasMausUiOptIn, MAUS_MINI_APP_UI_CSS, MAUS_UI_SDK_HELPERS_SOURCE } from "../../../shared/mini-app-ui-kit";
import type { MiniAppDocument } from "../../../shared/mini-apps";
import { isEligibleGithubActivityDocument } from "./github-activity-host";
import { HONGGUO_FRAME_SDK_SOURCE } from "./hongguo-frame-sdk";
import type { MiniAppSite } from "./mini-app-site";

export const MINI_APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function buildMiniAppSdkSource(githubActivity: boolean, managedRelease: boolean, site: MiniAppSite | undefined, hongguo: boolean, roleEditor: boolean): string {
  return `(function () {
  "use strict";
  var parent = window.parent;
  var root = document.documentElement;
  var pending = new Map();
  var listeners = new Set();
  var selectionListeners = new Set();
  var siteListeners = new Set();
  var siteTarget = ${JSON.stringify(site ?? null)};
  var createdBlobUrls = new Set();
  var currentHostSelection = null;
  var sequence = 0;
  var closed = false;
  var markedReady = false;
  var canOpenSources = false;
  function post(message) { parent.postMessage(message, "*"); }
  function request(message) {
    if (closed) return Promise.reject(new Error("This app was closed."));
    return new Promise(function (resolve, reject) {
      var id = "mini:" + (++sequence);
      pending.set(id, { resolve: resolve, reject: reject });
      post(Object.assign({ id: id }, message));
    });
  }
  function apply(context) {
    if (!context || typeof context !== "object") return;
    if (context.theme === "light" || context.theme === "dark") {
      root.style.colorScheme = context.theme;
      root.setAttribute("data-theme", context.theme);
    }
    if (typeof context.locale === "string" && context.locale) root.lang = context.locale;
    var variables = context.styles && context.styles.variables;
    if (!variables || typeof variables !== "object") return;
    Object.keys(variables).forEach(function (name) {
      if (name.slice(0, 2) === "--" && typeof variables[name] === "string") root.style.setProperty(name, variables[name]);
    });
  }
  function close() {
    if (closed) return;
    closed = true;
    pending.forEach(function (entry) { entry.reject(new Error("This app was closed.")); });
    pending.clear();
    listeners.clear();
    selectionListeners.clear();
    siteListeners.clear();
    createdBlobUrls.forEach(function (url) { try { URL.revokeObjectURL(url); } catch (e) {} });
    createdBlobUrls.clear();
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent || !event.data || typeof event.data !== "object") return;
    var message = event.data;
    if (message.jsonrpc === "2.0") {
      if (message.method === "ui/notifications/host-context-changed") apply(message.params);
      else if (message.method === "ui/resource-teardown" && message.id !== undefined) {
        post({ jsonrpc: "2.0", id: message.id, result: {} });
        close();
      } else if (message.method === undefined && pending.has(message.id)) {
        var waiting = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(String(message.error.message || "The host refused this request.")));
        else waiting.resolve(message.result);
      }
      return;
    }
    if (message.mausMiniApp !== 1) return;
    if (message.type === "data-changed") listeners.forEach(function (listener) { listener(); });
    else if (message.type === "host-selection") {
      currentHostSelection = {
        editionKey: typeof message.editionKey === "string" ? message.editionKey : null,
        repo: typeof message.repo === "string" ? message.repo : null
      };
      selectionListeners.forEach(function (listener) {
        listener({ editionKey: currentHostSelection.editionKey, repo: currentHostSelection.repo });
      });
    } else if (message.type === "media-result" && pending.has(message.id)) {
      var mediaAnswer = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) mediaAnswer.reject(new Error(String(message.error)));
      else if (!message.bytes || (!(message.bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(message.bytes) && Object.prototype.toString.call(message.bytes) !== "[object ArrayBuffer]") || typeof message.mimeType !== "string" || typeof message.sha256 !== "string") {
        mediaAnswer.reject(new Error("Invalid media response."));
      } else {
        var blobUrl = URL.createObjectURL(new Blob([message.bytes], { type: message.mimeType }));
        createdBlobUrls.add(blobUrl);
        mediaAnswer.resolve({ blobUrl: blobUrl, mimeType: message.mimeType, sha256: message.sha256 });
      }
    } else if (message.type === "site-status" && siteTarget && message.site === siteTarget) {
      siteListeners.forEach(function (listener) {
        listener({ site: message.site, opening: message.opening, phase: message.phase });
      });
    } else if ((message.type === "query-result" || message.type === "dashboard-result" || message.type === "site-result") && pending.has(message.id)) {
      var answer = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) answer.reject(new Error(String(message.error)));
      else answer.resolve(message.result);
    }
  });
  window.addEventListener("pagehide", close);
  var ready = request({ jsonrpc: "2.0", method: "ui/initialize", params: {
    appInfo: { name: "mausbot-mini-app", version: "1" }, appCapabilities: {}, protocolVersion: "${APP_PROTOCOL_VERSION}"
  }}).then(function (answer) {
    canOpenSources = !!(answer && answer.hostCapabilities && answer.hostCapabilities.openLinks);
    apply(answer && answer.hostContext);
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  });
  function openSource(url) {
    return ready.then(function () { return request({ jsonrpc: "2.0", method: "ui/open-link", params: { url: url } }); }).then(function () {});
  }
  var base = {
    query: function (queryId, parameters, options) {
      return ready.then(function () { return request({ mausMiniApp: 1, type: "query", queryId: queryId, parameters: parameters, options: options }); });
    },
    dashboard: Object.freeze({ read: function (selection) {
      return ready.then(function () { return request({ mausMiniApp: 1, type: "dashboard-read", selection: selection }); });
    }${roleEditor ? ', openAgentEditor: function (selection) { return ready.then(function () { return request({ mausMiniApp: 1, type: "agent-md-edit", selection: selection }); }); }' : ""} }),
    onDataChanged: function (listener) {
      if (typeof listener !== "function") throw new TypeError("A listener is required.");
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    },
    get openSource() { return canOpenSources ? openSource : undefined; }
  };
  if (${githubActivity ? "true" : "false"}) {
    base.setSelection = function (selection) {
      return ready.then(function () {
        post({
          mausMiniApp: 1,
          type: "selection",
          editionKey: selection && typeof selection.editionKey === "string" ? selection.editionKey : null,
          repo: selection && typeof selection.repo === "string" ? selection.repo : null
        });
      });
    };
    base.onSelectionChanged = function (listener) {
      if (typeof listener !== "function") throw new TypeError("A listener is required.");
      selectionListeners.add(listener);
      if (currentHostSelection) {
        Promise.resolve().then(function () {
          if (!closed && selectionListeners.has(listener) && currentHostSelection) {
            listener({ editionKey: currentHostSelection.editionKey, repo: currentHostSelection.repo });
          }
        });
      }
      return function () { selectionListeners.delete(listener); };
    };
    base.readMedia = function (input) {
      if (!input || typeof input !== "object" || typeof input.url !== "string" || typeof input.sha256 !== "string") {
        return Promise.reject(new TypeError("Media url and sha256 are required."));
      }
      return ready.then(function () {
        return request({ mausMiniApp: 1, type: "media-read", url: input.url, sha256: input.sha256 });
      });
    };
  }
  if (${managedRelease ? "true" : "false"}) {
    base.markReady = function () {
      if (markedReady) return ready;
      markedReady = true;
      return ready.then(function () {
        if (!closed) post({ mausMiniApp: 1, type: "runtime-ready" });
      });
    };
  }
  if (siteTarget) {
    base.site = Object.freeze({
      show: function (target, viewport, options) {
        if (target !== siteTarget) return Promise.reject(new Error("This site is unavailable."));
        var message = { mausMiniApp: 1, type: "site-show", site: target, viewport: viewport };
        if (target !== "mojo-poetry") {
          message.opening = options && options.opening;
          if (options && options.retry === true) message.retry = true;
        }
        return ready.then(function () { return request(message); });
      },
      onStatusChanged: function (listener) {
        if (typeof listener !== "function") throw new TypeError("A listener is required.");
        siteListeners.add(listener);
        return function () { siteListeners.delete(listener); };
      }
    });
  }
  ${hongguo ? HONGGUO_FRAME_SDK_SOURCE : ""}
  ${MAUS_UI_SDK_HELPERS_SOURCE}
  var api = Object.freeze(base);
  Object.defineProperty(window, "mausApp", { value: api, enumerable: true });
})();`;
}

export function isCustomLocalMiniApp(app: Pick<MiniAppDocument["app"], "dashboardIdentity" | "nativeIdentity" | "shippedTemplateKind">): boolean {
  return !app.dashboardIdentity && !app.nativeIdentity && !app.shippedTemplateKind;
}

export function miniAppFrameDocument(document: MiniAppDocument, desktopOpenerAvailable: boolean, scope: { site?: MiniAppSite; hongguo?: boolean; roleEditor?: boolean } = {}): AppDocument {
  const managedRelease = document.app.status === "active" && Boolean((document.app as { release?: unknown }).release);
  const sdk = buildMiniAppSdkSource(isEligibleGithubActivityDocument(document), managedRelease, scope.site, scope.hongguo === true, scope.roleEditor === true);
  const uiStyle = hasMausUiOptIn(document.html) ? `<style>${MAUS_MINI_APP_UI_CSS}</style>` : "";
  const html = `<style>${APP_THEME_STYLE}</style>${uiStyle}<script>${sdk}</script>${stripDocumentPreamble(document.html)}`;
  return {
    v: 1,
    messageId: document.app.id,
    rev: document.app.templateVersion,
    srcdoc: buildSrcdoc({ html, csp: MINI_APP_CSP }),
    csp: MINI_APP_CSP,
    network: { connect: [], resources: [] },
    can: { serverTools: false, serverResources: false, message: false,
      openLinks: desktopOpenerAvailable && document.app.status === "active"
        && (document.app.shippedTemplateKind === "x_ai_digest"
          || document.app.shippedTemplateKind === "github_activity"
          || (document.app.dashboardIdentity === "agent-team" && document.app.dashboard?.kind === "agent-team" && document.app.dashboard.renderer === "html")
          || isCustomLocalMiniApp(document.app)),
      modelContext: false },
  };
}
