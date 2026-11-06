import type { AppDocument } from "../../../shared/app";
import { APP_PROTOCOL_VERSION } from "../../../shared/app";
import { buildSrcdoc, stripDocumentPreamble } from "../../../shared/app-frame/document";
import { APP_THEME_STYLE } from "../../../shared/app-frame/helper";
import type { MiniAppDocument } from "../../../shared/mini-apps";

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

const MINI_APP_SDK_SOURCE = `(function () {
  "use strict";
  var parent = window.parent;
  var root = document.documentElement;
  var pending = new Map();
  var listeners = new Set();
  var sequence = 0;
  var closed = false;
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
    else if (message.type === "query-result" && pending.has(message.id)) {
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
    apply(answer && answer.hostContext);
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  });
  var api = Object.freeze({
    query: function (queryId, parameters, options) {
      return ready.then(function () { return request({ mausMiniApp: 1, type: "query", queryId: queryId, parameters: parameters, options: options }); });
    },
    onDataChanged: function (listener) {
      if (typeof listener !== "function") throw new TypeError("A listener is required.");
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }
  });
  Object.defineProperty(window, "mausApp", { value: api, enumerable: true });
})();`;

export function miniAppFrameDocument(document: MiniAppDocument): AppDocument {
  const html = `<style>${APP_THEME_STYLE}</style><script>${MINI_APP_SDK_SOURCE}</script>${stripDocumentPreamble(document.html)}`;
  return {
    v: 1,
    messageId: document.app.id,
    rev: document.app.templateVersion,
    srcdoc: buildSrcdoc({ html, csp: MINI_APP_CSP }),
    csp: MINI_APP_CSP,
    network: { connect: [], resources: [] },
    can: { serverTools: false, serverResources: false, message: false, openLinks: false, modelContext: false },
  };
}
