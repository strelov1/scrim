// Shared by the binary and build.rs (V8 snapshot): builds `__host` on top of the engine's
// `__hostcall(frame, name, ...stringArgs)`. JS null/undefined travel as "\u0000". The frame number
// lives in `__frameNo`, set per context after creation, so one V8 snapshot serves every frame.
// The names must match engine::host_call.
pub const SHIM: &str = r#"(function () {
  const h = {};
  const enc = (x) => (x == null ? '\u0000' : String(x));
  for (const n of ['parseDoc', 'parseFrag', 'cssRules', 'mediaMatches', 'urlParse', 'now', 'epoch', 'seed', 'log', 'cookieGet',
    'cookieSet', 'storage', 'dialog', 'navigate', 'historyPush', 'historyGo', 'historyLength', 'frameOpen', 'fetchStart', 'fetchSync', 'realMs'])
    h[n] = (...a) => __hostcall(String(globalThis.__frameNo | 0), n, ...a.map(enc));
  h.evalScript = (s) => __evalScript(s);
  h.runModule = (s, u) => __runModule(s, u);
  Object.defineProperty(h, 'frameId', { get: () => globalThis.__frameNo | 0 });
  globalThis.__host = h;
})();"#;
