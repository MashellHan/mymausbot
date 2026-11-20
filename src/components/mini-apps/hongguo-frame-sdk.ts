export const HONGGUO_FRAME_SDK_SOURCE = String.raw`
(function (base, parent, ready, post) {
  var requests = new Map();
  var listeners = new Set();
  var players = new Set();
  var lifetime = new AbortController();
  var sequence = 0;
  function aborted() { return new DOMException("The request was cancelled.", "AbortError"); }
  function stop() {
    lifetime.abort();
    requests.forEach(function (request) { request.reject(aborted()); });
    requests.clear();
    listeners.clear();
    players.clear();
  }
  function call(operation, input, options) {
    var signal = options && options.signal;
    return ready.then(function () {
      if (lifetime.signal.aborted || (signal && signal.aborted)) throw aborted();
      return new Promise(function (resolve, reject) {
        var id = "hongguo:" + (++sequence);
        function cancel() {
          requests.delete(id);
          post({ mausMiniApp: 1, type: "hongguo-cancel", id: id });
          reject(aborted());
        }
        function done() {
          if (signal) signal.removeEventListener("abort", cancel);
          requests.delete(id);
        }
        requests.set(id, {
          resolve: function (result) { done(); resolve(result); },
          reject: function (error) { done(); reject(error); }
        });
        if (signal) signal.addEventListener("abort", cancel, { once: true });
        try { post({ mausMiniApp: 1, type: "hongguo-request", id: id, operation: operation, input: input }); }
        catch (error) { done(); reject(error); }
      });
    });
  }
  function allow(operation) {
    return function (input, options) { return call(operation, input, options); };
  }
  function subscribe(set, listener) {
    if (typeof listener !== "function") throw new TypeError("A listener is required.");
    set.add(listener);
    return function () { set.delete(listener); };
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent || !event.data || typeof event.data !== "object") return;
    var message = event.data;
    if (message.jsonrpc === "2.0" && message.method === "ui/resource-teardown") { stop(); return; }
    if (message.mausMiniApp !== 1) return;
    if (message.type === "hongguo-result" && requests.has(message.id)) {
      var request = requests.get(message.id);
      if (message.error) {
        request.reject(message.error.aborted === true ? aborted() : Object.assign(new Error("Hongguo request unavailable."), { status: message.error.status }));
      } else request.resolve(message.result);
    } else if (message.type === "hongguo-context") {
      listeners.forEach(function (listener) { listener(message.context); });
    } else if (message.type === "hongguo-player-event") {
      players.forEach(function (listener) { listener(message.event); });
    }
  }, { signal: lifetime.signal });
  window.addEventListener("pagehide", stop, { signal: lifetime.signal });
  base.getContext = function () { return call("context", {}); };
  base.onContextChanged = function (listener) { return subscribe(listeners, listener); };
  base.hongguo = Object.freeze({
    catalog: allow("catalog"), series: allow("series"), playback: allow("playback"), history: allow("history"),
    preferences: allow("preferences"), cover: allow("cover"),
    player: Object.freeze({
      attach: allow("player.attach"), setBounds: allow("player.setBounds"),
      detach: allow("player.detach"), fullscreen: allow("player.fullscreen"),
      onEvent: function (listener) { return subscribe(players, listener); }
    })
  });
})(base, parent, ready, post);`;
