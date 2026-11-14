// Window, location/history, timers (virtual time), fetch/XHR, storage, observers and the
// document load sequence driven by the host.
(function (g) {
  'use strict';
  const S = g.__scrim;
  const doc = (S.doc = S.createDocument());
  S.url = 'about:blank';

  // ---------------------------------------------------------------- window object
  function Window() { throw new TypeError('Illegal constructor'); }
  Window.prototype = Object.create(g.EventTarget.prototype, { constructor: { value: Window } });
  try { Object.setPrototypeOf(g, Window.prototype); } catch (e) { for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent']) g[k] = g.EventTarget.prototype[k]; }
  g._ls = null;
  // Window methods work unbound (`addEventListener(...)` in strict code).
  for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent']) { const f = g.EventTarget.prototype[k]; g[k] = function (a, b, c) { return f.call(g, a, b, c); }; }
  g.Window = Window;
  const ro = (k, v) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true, enumerable: true });
  for (const k of ['window', 'self', 'top', 'parent', 'frames', 'globalThis']) ro(k, g);
  Object.assign(g, { document: doc, frameElement: null, opener: null, closed: false, name: '', length: 0, innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 900,
    devicePixelRatio: 1, screenX: 0, screenY: 0, screenLeft: 0, screenTop: 0, scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0, isSecureContext: true, crossOriginIsolated: false,
    status: '', defaultStatus: '', toolbar: { visible: true }, menubar: { visible: true }, locationbar: { visible: true }, statusbar: { visible: true }, personalbar: { visible: true }, scrollbars: { visible: true } });
  g.screen = { width: 1280, height: 800, availWidth: 1280, availHeight: 800, availTop: 0, availLeft: 0, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0, addEventListener() {}, removeEventListener() {} } };
  g.visualViewport = { width: 1280, height: 800, scale: 1, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, addEventListener() {}, removeEventListener() {} };
  g.navigator = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) scrim/0.1 Safari/537.36', appName: 'Netscape', appVersion: '5.0', appCodeName: 'Mozilla', product: 'Gecko', vendor: '',
    platform: 'MacIntel', language: 'en-US', languages: ['en-US', 'en'], cookieEnabled: true, onLine: true, webdriver: false, hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, doNotTrack: null, pdfViewerEnabled: false,
    plugins: [], mimeTypes: [], javaEnabled: () => false, sendBeacon: () => true, vibrate: () => false, registerProtocolHandler() {},
    clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve(''), write: () => Promise.resolve(), read: () => Promise.resolve([]) },
    permissions: { query: () => Promise.resolve({ state: 'prompt', addEventListener() {} }) }, mediaDevices: { enumerateDevices: () => Promise.resolve([]), addEventListener() {} },
    storage: { estimate: () => Promise.resolve({ quota: 1e9, usage: 0 }), persist: () => Promise.resolve(false), persisted: () => Promise.resolve(false) },
    connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false, addEventListener() {} }, locks: { request: (n, o, cb) => Promise.resolve((cb || o)({ name: n })) },
    userActivation: { hasBeenActive: true, isActive: true }, scheduling: { isInputPending: () => false },
    getBattery: () => Promise.resolve({ charging: true, level: 1, addEventListener() {} }), getGamepads: () => [] };
  S.defineHandlers(g, ['abort', 'blur', 'change', 'click', 'error', 'focus', 'input', 'keydown', 'keyup', 'load', 'message', 'resize', 'scroll', 'submit', 'unload', 'beforeunload',
    'hashchange', 'popstate', 'storage', 'online', 'offline', 'pageshow', 'pagehide', 'unhandledrejection', 'rejectionhandled', 'languagechange', 'messageerror', 'DOMContentLoaded']);

  // Virtual clock.
  const RealDate = Date;
  const vnow = () => __host.now();
  class VDate extends RealDate { constructor(...a) { if (a.length === 0) super(__host.epoch() + vnow()); else super(...a); } static now() { return Math.floor(__host.epoch() + vnow()); } }
  VDate.UTC = RealDate.UTC; VDate.parse = RealDate.parse;
  g.Date = VDate;
  S.timeOrigin = 0;
  g.performance = {
    now: () => vnow() - S.timeOrigin, get timeOrigin() { return __host.epoch() + S.timeOrigin; },
    timing: { navigationStart: 0, fetchStart: 0, domLoading: 0, domInteractive: 0, domContentLoadedEventStart: 0, domContentLoadedEventEnd: 0, domComplete: 0, loadEventStart: 0, loadEventEnd: 0, responseStart: 0, responseEnd: 0, requestStart: 0, connectStart: 0, connectEnd: 0 },
    navigation: { type: 0, redirectCount: 0 }, mark: (n) => ({ name: n, startTime: vnow() - S.timeOrigin }), measure: (n) => ({ name: n, duration: 0 }), clearMarks() {}, clearMeasures() {},
    getEntries: () => [], getEntriesByName: () => [], getEntriesByType: (t) => (t === 'navigation' ? [{ type: 'navigate', name: S.url, startTime: 0, duration: 0, transferSize: 0 }] : []),
    setResourceTimingBufferSize() {}, clearResourceTimings() {}, addEventListener() {}, removeEventListener() {}, toJSON() { return {}; }, memory: { usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 0 } };
  g.PerformanceObserver = class { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } static get supportedEntryTypes() { return []; } };

  // ---------------------------------------------------------------- tasks and timers
  const tasks = [];
  let timers = [];
  const timerById = new Map();
  let timerSeq = 0;
  S.queueTask = (f) => { tasks.push(f); };
  function addTimer(fn, ms, args, repeat) {
    const id = ++timerSeq;
    ms = Number(ms) || 0; if (ms < 0) ms = 0;
    const t = { id, at: vnow() + ms, fn, args, repeat: repeat ? Math.max(ms, 4) : 0, seq: id };
    insertTimer(t); timerById.set(id, t);
    return id;
  }
  function insertTimer(t) {
    let i = timers.length;
    while (i > 0 && (timers[i - 1].at > t.at || (timers[i - 1].at === t.at && timers[i - 1].seq > t.seq))) i--;
    timers.splice(i, 0, t);
  }
  function clearTimer(id) { const t = timerById.get(id); if (t) { t.dead = true; timerById.delete(id); const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } }
  g.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
  g.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
  g.clearTimeout = g.clearInterval = (id) => clearTimer(id);
  g.setImmediate = (fn, ...args) => addTimer(fn, 0, args, false);
  g.clearImmediate = clearTimer;
  g.requestAnimationFrame = (cb) => addTimer(() => cb(g.performance.now()), 16, [], false);
  g.cancelAnimationFrame = clearTimer;
  g.requestIdleCallback = (cb) => addTimer(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1, [], false);
  g.cancelIdleCallback = clearTimer;
  // One macrotask: -2 when something ran, else the next timer's due time, or -1.
  // SCRIM_PROFILE: wall time of each macrotask, the slowest kept for S.profDump().
  const prof = [];
  const timed = (label, f) => {
    if (!S.profiling) return f();
    const t0 = __host.realMs();
    try { return f(); } finally { const ms = __host.realMs() - t0; if (ms > 2) prof.push([ms, label]); }
  };
  S.profDump = () => prof.sort((a, b) => b[0] - a[0]).slice(0, 15).map(([ms, l]) => ms.toFixed(1) + ' ms  ' + l).join('\n');
  S.runDue = function (nowStr) {
    const now = Number(nowStr);
    if (tasks.length) { const f = tasks.shift(); timed('task ' + String(f).slice(0, 100).replace(/\s+/g, ' '), () => { try { f(); } catch (e) { S.reportError(e); } }); return -2; }
    if (timers.length && timers[0].at <= now) {
      const t = timers.shift();
      if (t.repeat) { t.at = Math.max(t.at + t.repeat, now); t.seq = ++timerSeq; insertTimer(t); } else timerById.delete(t.id);
      timed('timer ' + String(t.fn).slice(0, 100).replace(/\s+/g, ' '), () => { try { if (typeof t.fn === 'function') t.fn.apply(g, t.args); else (0, eval)(String(t.fn)); } catch (e) { S.reportError(e); } });
      return -2;
    }
    return timers.length ? timers[0].at : -1;
  };

  // ---------------------------------------------------------------- location and history
  const parseUrl = (u) => new URL(u);
  S.navigate = function (url, method, body, ct, replace) {
    let target;
    try { target = new URL(url, doc.baseURI).href; } catch (e) { return; }
    if ((method || 'GET') === 'GET' && !body) {
      const a = S.url.replace(/#.*$/, ''), b = target.replace(/#.*$/, '');
      if (a === b && target.indexOf('#') >= 0) { S.hashNav(target, replace); return; }
    }
    __host.navigate(target, method || 'GET', body == null ? undefined : String(body), ct || undefined, !!replace);
  };
  S.hashNav = function (url, replace) {
    const old = S.url; S.url = url; doc._url = url;
    __host.historyPush(url, 'null', !!replace);
    if (old !== url) S.queueTask(() => g.dispatchEvent(new g.HashChangeEvent('hashchange', { oldURL: old, newURL: url })));
  };
  const location = {};
  for (const p of ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin', 'username', 'password']) {
    Object.defineProperty(location, p, { enumerable: true, get() { return parseUrl(S.url)[p]; },
      set(v) { if (p === 'origin') return; const u = parseUrl(S.url); u[p] = v; S.navigate(u.href, 'GET'); } });
  }
  Object.defineProperty(location, 'href', { enumerable: true, get() { return S.url; }, set(v) { S.navigate(String(v), 'GET'); } });
  Object.assign(location, { assign(u) { S.navigate(String(u), 'GET'); }, replace(u) { S.navigate(String(u), 'GET', null, null, true); },
    reload() { __host.navigate(S.url, 'GET', undefined, undefined, true); }, toString() { return S.url; }, valueOf() { return this; }, ancestorOrigins: [] });
  Object.defineProperty(g, 'location', { get() { return location; }, set(v) { S.navigate(String(v), 'GET'); }, configurable: true, enumerable: true });
  S.historyState = null;
  g.history = {
    get length() { return __host.historyLength(); }, get state() { return S.historyState; }, scrollRestoration: 'auto',
    pushState(state, title, url) { S.pushState(state, url, false); }, replaceState(state, title, url) { S.pushState(state, url, true); },
    back() { __host.historyGo(-1); }, forward() { __host.historyGo(1); }, go(n) { if (!n) location.reload(); else __host.historyGo(n | 0); },
  };
  S.pushState = function (state, url, replace) {
    let target = S.url;
    if (url !== undefined && url !== null) {
      target = new URL(String(url), doc.baseURI).href;
      if (new URL(target).origin !== new URL(S.url).origin) throw new g.DOMException('Failed to execute pushState: different origin', 'SecurityError');
    }
    S.historyState = state === undefined ? null : g.structuredClone(state);
    S.url = target; doc._url = target;
    let js = 'null'; try { js = JSON.stringify(S.historyState); } catch (e) {}
    __host.historyPush(target, js === undefined ? 'null' : js, replace);
  };
  S.popstate = function (url, stateJson) {
    const old = S.url;
    S.url = url; doc._url = url;
    try { S.historyState = JSON.parse(stateJson); } catch (e) { S.historyState = null; }
    g.dispatchEvent(new g.PopStateEvent('popstate', { state: S.historyState }));
    if (old.replace(/^[^#]*/, '') !== url.replace(/^[^#]*/, '')) g.dispatchEvent(new g.HashChangeEvent('hashchange', { oldURL: old, newURL: url }));
  };

  // ---------------------------------------------------------------- dialogs and misc
  g.alert = (m) => { __host.dialog('alert', String(m === undefined ? '' : m)); };
  g.confirm = (m) => __host.dialog('confirm', String(m === undefined ? '' : m));
  g.prompt = (m, d) => (__host.dialog('prompt', String(m === undefined ? '' : m)) ? (d === undefined ? '' : String(d)) : null);
  g.print = () => {}; g.stop = () => {}; g.focus = () => {}; g.blur = () => {}; g.close = () => {}; g.moveTo = g.moveBy = g.resizeTo = g.resizeBy = () => {};
  g.open = (u) => { if (u) S.navigate(String(u), 'GET'); return null; };
  g.scrollTo = g.scroll = (x, y) => { const top = typeof x === 'object' && x ? x.top || 0 : y || 0; g.scrollY = g.pageYOffset = top; S.queueTask(() => { g.dispatchEvent(new Event('scroll')); }); };
  g.scrollBy = (x, y) => g.scrollTo(0, g.scrollY + (typeof x === 'object' && x ? x.top || 0 : y || 0));
  g.getSelection = () => ({ rangeCount: 0, isCollapsed: true, type: 'None', anchorNode: null, focusNode: null, toString: () => '', addRange() {}, removeAllRanges() {}, removeRange() {}, collapse() {}, collapseToEnd() {}, collapseToStart() {}, extend() {}, selectAllChildren() {}, getRangeAt() { return S.createRange(doc); }, containsNode: () => false, empty() {}, setBaseAndExtent() {}, modify() {} });
  g.postMessage = (data, origin) => { const src = g; S.queueTask(() => g.dispatchEvent(new g.MessageEvent('message', { data, origin: location.origin, source: src }))); };
  g.reportError = (e) => S.reportError(e);
  g.crypto = { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; },
    randomUUID() { const h = '0123456789abcdef'; let s = ''; for (let i = 0; i < 36; i++) s += i === 8 || i === 13 || i === 18 || i === 23 ? '-' : i === 14 ? '4' : h[Math.floor(Math.random() * 16)]; return s; }, subtle: undefined };
  g.Notification = class { static get permission() { return 'default'; } static requestPermission() { return Promise.resolve('default'); } };

  // ---------------------------------------------------------------- messaging and observers
  class MessagePort extends g.EventTarget {
    constructor() { super(); this._other = null; this.onmessage = null; }
    postMessage(data) { const o = this._other; S.queueTask(() => { const ev = new g.MessageEvent('message', { data }); if (o.onmessage) o.onmessage(ev); o.dispatchEvent(ev); }); }
    start() {} close() {}
  }
  g.MessagePort = MessagePort;
  g.MessageChannel = class { constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); this.port1._other = this.port2; this.port2._other = this.port1; } };
  g.BroadcastChannel = class extends g.EventTarget { constructor(n) { super(); this.name = n; } postMessage() {} close() {} };
  g.Worker = class extends g.EventTarget { constructor() { super(); } postMessage() {} terminate() {} };
  g.SharedWorker = g.Worker;
  g.WebSocket = class extends g.EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; S.queueTask(() => { this.readyState = 3; const e = new Event('error'); if (this.onerror) this.onerror(e); this.dispatchEvent(e); const c = new Event('close'); if (this.onclose) this.onclose(c); this.dispatchEvent(c); }); }
    send() {} close() { this.readyState = 3; }
  };
  Object.assign(g.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  g.EventSource = class extends g.EventTarget { constructor(url) { super(); this.url = url; this.readyState = 2; } close() {} };

  const ioList = new Set();
  g.IntersectionObserver = class IntersectionObserver {
    constructor(cb, opts) { this._cb = cb; this._t = []; this.root = (opts && opts.root) || null; this.rootMargin = (opts && opts.rootMargin) || '0px'; this.thresholds = [].concat((opts && opts.threshold) || 0); }
    observe(t) { if (!this._t.includes(t)) { this._t.push(t); ioList.add(this); this._notify([t]); } }
    unobserve(t) { this._t = this._t.filter((x) => x !== t); }
    disconnect() { this._t = []; ioList.delete(this); }
    takeRecords() { return []; }
    _notify(targets) {
      S.queueTask(() => {
        const live = targets.filter((t) => this._t.includes(t));
        if (!live.length) return;
        const now = g.performance.now();
        const entries = live.map((t) => { const vis = S.isRendered(t); const r = S.rect(t); return { target: t, isIntersecting: vis, intersectionRatio: vis ? 1 : 0, boundingClientRect: r, intersectionRect: r, rootBounds: S.rect(doc.documentElement), time: now, isVisible: vis }; });
        try { this._cb(entries, this); } catch (e) { S.reportError(e); }
      });
    }
  };
  g.IntersectionObserverEntry = function () {};
  S.scrolled = function () { for (const o of ioList) o._notify(o._t.slice()); };
  g.ResizeObserver = class ResizeObserver {
    constructor(cb) { this._cb = cb; this._t = []; }
    observe(t) { this._t.push(t); S.queueTask(() => { if (!this._t.includes(t)) return; const r = S.rect(t); try { this._cb([{ target: t, contentRect: r, borderBoxSize: [{ inlineSize: r.width, blockSize: r.height }], contentBoxSize: [{ inlineSize: r.width, blockSize: r.height }] }], this); } catch (e) { S.reportError(e); } }); }
    unobserve(t) { this._t = this._t.filter((x) => x !== t); } disconnect() { this._t = []; }
  };

  // ---------------------------------------------------------------- storage
  class Storage {
    constructor(kind) { this._k = kind; }
    _p() { return this._k + '|' + location.origin + '|'; }
    getItem(k) { const v = __host.storage('get', this._p() + k, null); return v === undefined ? null : v; }
    setItem(k, v) { __host.storage('set', this._p() + k, String(v)); }
    removeItem(k) { __host.storage('del', this._p() + k, null); }
    clear() { for (const k of this._keys()) __host.storage('del', this._p() + k, null); }
    _keys() { const p = this._p(); return JSON.parse(__host.storage('keys', p, null) || '[]').map((k) => k.slice(p.length)); }
    key(i) { return this._keys()[i] || null; }
    get length() { return this._keys().length; }
  }
  const storageProxy = (kind) => new Proxy(new Storage(kind), {
    get(t, k) { if (typeof k !== 'string' || k in t) { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } return t.getItem(k) === null ? undefined : t.getItem(k); },
    set(t, k, v) { if (k in t) t[k] = v; else t.setItem(k, v); return true; },
    deleteProperty(t, k) { t.removeItem(k); return true; },
    ownKeys(t) { return t._keys(); }, getOwnPropertyDescriptor(t, k) { const v = t.getItem(k); return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; },
  });
  g.Storage = Storage;
  g.localStorage = storageProxy('local');
  g.sessionStorage = storageProxy('session');
  g.indexedDB = undefined;
  g.caches = undefined;

  // ---------------------------------------------------------------- fetch and friends
  class Headers {
    constructor(init) {
      this._m = [];
      if (!init) return;
      if (init instanceof Headers) this._m = init._m.map((p) => p.slice());
      else if (Array.isArray(init) || typeof init[Symbol.iterator] === 'function') for (const [k, v] of init) this.append(k, v);
      else for (const k of Object.keys(init)) this.append(k, init[k]);
    }
    append(k, v) { this._m.push([String(k).toLowerCase(), String(v)]); }
    set(k, v) { k = String(k).toLowerCase(); this._m = this._m.filter((p) => p[0] !== k); this._m.push([k, String(v)]); }
    get(k) { k = String(k).toLowerCase(); const v = this._m.filter((p) => p[0] === k).map((p) => p[1]); return v.length ? v.join(', ') : null; }
    getSetCookie() { return this._m.filter((p) => p[0] === 'set-cookie').map((p) => p[1]); }
    has(k) { k = String(k).toLowerCase(); return this._m.some((p) => p[0] === k); }
    delete(k) { k = String(k).toLowerCase(); this._m = this._m.filter((p) => p[0] !== k); }
    forEach(f, t) { for (const [k, v] of this.entries()) f.call(t, v, k, this); }
    entries() { const keys = Array.from(new Set(this._m.map((p) => p[0]))).sort(); return keys.map((k) => [k, this.get(k)])[Symbol.iterator](); }
    keys() { return Array.from(this.entries()).map((p) => p[0])[Symbol.iterator](); }
    values() { return Array.from(this.entries()).map((p) => p[1])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
  }
  g.Headers = Headers;
  const toUtf8 = (s) => new g.TextEncoder().encode(s);
  class Blob {
    constructor(parts, opts) {
      this._s = (parts || []).map((p) => (p instanceof Blob ? p._s : typeof p === 'string' ? p : p && (p.buffer || p instanceof ArrayBuffer) ? new g.TextDecoder().decode(p) : String(p))).join('');
      this.type = (opts && opts.type) || '';
    }
    get size() { return toUtf8(this._s).length; }
    text() { return Promise.resolve(this._s); }
    arrayBuffer() { return Promise.resolve(toUtf8(this._s).buffer); }
    bytes() { return Promise.resolve(toUtf8(this._s)); }
    slice(a, b, t) { return new Blob([this._s.slice(a, b)], { type: t || this.type }); }
    stream() { return null; }
  }
  g.Blob = Blob;
  g.File = class File extends Blob { constructor(parts, name, opts) { super(parts, opts); this.name = name; this.lastModified = (opts && opts.lastModified) || Date.now(); } };
  g.FileReader = class FileReader extends g.EventTarget {
    constructor() { super(); this.result = null; this.readyState = 0; }
    _done(r) { this.result = r; this.readyState = 2; S.queueTask(() => { const e = new g.ProgressEvent('load'); if (this.onload) this.onload(e); this.dispatchEvent(e); const l = new g.ProgressEvent('loadend'); if (this.onloadend) this.onloadend(l); this.dispatchEvent(l); }); }
    readAsText(b) { this._done(b._s); } readAsDataURL(b) { this._done('data:' + (b.type || 'application/octet-stream') + ';base64,' + g.btoa(unescape(encodeURIComponent(b._s)))); }
    readAsArrayBuffer(b) { this._done(toUtf8(b._s).buffer); } abort() {}
  };
  class FormData {
    constructor(form, submitter) { this._l = form ? S.entryList(form, submitter || null) : []; }
    append(k, v, fn) { this._l.push([String(k), v instanceof Blob ? v : String(v)]); }
    set(k, v) { this.delete(k); this.append(k, v); }
    get(k) { const p = this._l.find((p) => p[0] === k); return p ? p[1] : null; }
    getAll(k) { return this._l.filter((p) => p[0] === k).map((p) => p[1]); }
    has(k) { return this._l.some((p) => p[0] === k); }
    delete(k) { this._l = this._l.filter((p) => p[0] !== k); }
    forEach(f, t) { for (const [k, v] of this._l) f.call(t, v, k, this); }
    entries() { return this._l.map((p) => p.slice())[Symbol.iterator](); }
    keys() { return this._l.map((p) => p[0])[Symbol.iterator](); }
    values() { return this._l.map((p) => p[1])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
  }
  g.FormData = FormData;

  class AbortSignal extends g.EventTarget {
    constructor() { super(); this.aborted = false; this.reason = undefined; this.onabort = null; }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    _abort(r) { if (this.aborted) return; this.aborted = true; this.reason = r === undefined ? new g.DOMException('signal is aborted without reason', 'AbortError') : r; const e = new Event('abort'); if (this.onabort) this.onabort(e); this.dispatchEvent(e); }
    static abort(r) { const s = new AbortSignal(); s._abort(r); return s; }
    static timeout(ms) { const s = new AbortSignal(); g.setTimeout(() => s._abort(new g.DOMException('signal timed out', 'TimeoutError')), ms); return s; }
    static any(list) { const s = new AbortSignal(); for (const x of list) { if (x.aborted) s._abort(x.reason); else x.addEventListener('abort', () => s._abort(x.reason)); } return s; }
  }
  g.AbortSignal = AbortSignal;
  g.AbortController = class AbortController { constructor() { this.signal = new AbortSignal(); } abort(r) { this.signal._abort(r); } };

  function encodeBody(body, headers) {
    if (body == null) return undefined;
    if (typeof body === 'string') { if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8'); return body; }
    if (body instanceof g.URLSearchParams) { if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8'); return body.toString(); }
    if (body instanceof FormData) {
      const b = '----scrimFormBoundary' + Math.random().toString(36).slice(2);
      headers.set('content-type', 'multipart/form-data; boundary=' + b);
      return body._l.map(([k, v]) => '--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"' + (v instanceof Blob ? '; filename="' + (v.name || 'blob') + '"\r\nContent-Type: ' + (v.type || 'application/octet-stream') : '') + '\r\n\r\n' + (v instanceof Blob ? v._s : v) + '\r\n').join('') + '--' + b + '--\r\n';
    }
    if (body instanceof Blob) { if (body.type && !headers.has('content-type')) headers.set('content-type', body.type); return body._s; }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new g.TextDecoder().decode(body);
    return String(body);
  }
  class Body {
    _initBody(text) { this._text = text; this.bodyUsed = false; }
    _take() { if (this.bodyUsed) return Promise.reject(new TypeError('Body has already been consumed.')); this.bodyUsed = true; return Promise.resolve(this._text == null ? '' : this._text); }
    text() { return this._take(); }
    json() { return this._take().then((t) => JSON.parse(t)); }
    arrayBuffer() { return this._take().then((t) => toUtf8(t).buffer); }
    bytes() { return this._take().then((t) => toUtf8(t)); }
    blob() { return this._take().then((t) => new Blob([t], { type: this.headers.get('content-type') || '' })); }
    formData() { return this._take().then((t) => { const f = new FormData(); for (const [k, v] of new g.URLSearchParams(t)) f.append(k, v); return f; }); }
    get body() { const t = this._text; if (t == null) return null; const self = this; return { getReader() { let done = false; return { read() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; self.bodyUsed = true; return Promise.resolve({ done: false, value: toUtf8(t) }); }, releaseLock() {}, cancel() { return Promise.resolve(); } }; }, locked: false }; }
  }
  class Request extends Body {
    constructor(input, init) {
      super(); init = init || {};
      const base = input instanceof Request ? input : null;
      this.url = new URL(base ? base.url : String(input), doc.baseURI).href;
      this.method = String(init.method || (base && base.method) || 'GET').toUpperCase();
      this.headers = new Headers(init.headers || (base && base.headers));
      this.credentials = init.credentials || (base && base.credentials) || 'same-origin';
      this.mode = init.mode || 'cors'; this.cache = init.cache || 'default'; this.redirect = init.redirect || 'follow';
      this.signal = init.signal || (base && base.signal) || new AbortSignal(); this.referrer = 'about:client'; this.integrity = ''; this.keepalive = !!init.keepalive;
      this._initBody(init.body !== undefined ? encodeBody(init.body, this.headers) : base ? base._text : undefined);
    }
    clone() { return new Request(this, { body: this._text }); }
  }
  g.Request = Request;
  class Response extends Body {
    constructor(body, init) {
      super(); init = init || {};
      this.status = init.status === undefined ? 200 : init.status; this.statusText = init.statusText || ''; this.headers = new Headers(init.headers);
      this.ok = this.status >= 200 && this.status < 300; this.url = init.url || ''; this.redirected = !!init.redirected; this.type = init.type || 'basic';
      this._initBody(body == null ? null : encodeBody(body, this.headers));
    }
    clone() { return new Response(this._text, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url }); }
    static json(d, init) { const r = new Response(JSON.stringify(d), init); r.headers.set('content-type', 'application/json'); return r; }
    static error() { return new Response(null, { status: 0, type: 'error' }); }
    static redirect(u, s) { return new Response(null, { status: s || 302, headers: { location: u } }); }
  }
  g.Response = Response;

  const pending = new Map();
  let fetchSeq = 0;
  S.startFetch = function (method, url, headers, body, cb) {
    const id = ++fetchSeq;
    pending.set(id, cb);
    __host.fetchStart(id, method, url, JSON.stringify(Array.from(headers._m)), body === undefined ? undefined : String(body));
    return id;
  };
  S.onFetch = function (id, metaStr, body) {
    const cb = pending.get(Number(id));
    if (!cb) return;
    pending.delete(Number(id));
    let meta; try { meta = JSON.parse(metaStr); } catch (e) { meta = { error: String(e) }; }
    try { cb(meta, body); } catch (e) { S.reportError(e); }
  };
  g.fetch = function (input, init) {
    let req;
    try { req = new Request(input, init); } catch (e) { return Promise.reject(e); }
    return new Promise((resolve, reject) => {
      if (req.signal.aborted) { reject(req.signal.reason); return; }
      let done = false;
      req.signal.addEventListener('abort', () => { if (!done) { done = true; reject(req.signal.reason); } });
      S.startFetch(req.method, req.url, req.headers, req._text, (meta, body) => {
        if (done) return; done = true;
        if (meta.error) { reject(new TypeError('Failed to fetch')); return; }
        resolve(new Response(body, { status: meta.status, headers: meta.headers, url: meta.url, redirected: meta.redirected }));
      });
    });
  };

  class XMLHttpRequest extends g.EventTarget {
    constructor() { super(); this.readyState = 0; this.status = 0; this.statusText = ''; this.responseText = ''; this.responseXML = null; this.responseType = ''; this.responseURL = ''; this.timeout = 0; this.withCredentials = false; this._h = new Headers(); this._rh = []; this.upload = new g.EventTarget(); }
    open(method, url, async) { this._m = String(method).toUpperCase(); this._u = new URL(String(url), doc.baseURI).href; this._async = async !== false; this._fire('readystatechange', 1); }
    setRequestHeader(k, v) { this._h.append(k, v); }
    getResponseHeader(k) { k = String(k).toLowerCase(); const v = this._rh.filter((p) => p[0].toLowerCase() === k).map((p) => p[1]); return v.length ? v.join(', ') : null; }
    getAllResponseHeaders() { return this._rh.map((p) => p[0].toLowerCase() + ': ' + p[1]).join('\r\n') + (this._rh.length ? '\r\n' : ''); }
    overrideMimeType() {}
    get response() { if (this.readyState !== 4) return this.responseType === '' || this.responseType === 'text' ? '' : null; if (this.responseType === 'json') { try { return JSON.parse(this.responseText); } catch (e) { return null; } } if (this.responseType === 'arraybuffer') return toUtf8(this.responseText).buffer; if (this.responseType === 'blob') return new Blob([this.responseText]); if (this.responseType === 'document') return new g.DOMParser().parseFromString(this.responseText, 'text/html'); return this.responseText; }
    _fire(type, state) { if (state !== undefined) this.readyState = state; const e = type === 'readystatechange' ? new Event(type) : new g.ProgressEvent(type); const h = this['on' + type]; if (typeof h === 'function') try { h.call(this, e); } catch (x) { S.reportError(x); } this.dispatchEvent(e); }
    _finish(meta, body) {
      if (this._aborted) return;
      if (meta.error) { this.readyState = 4; this.status = 0; this._fire('readystatechange'); this._fire('error'); this._fire('loadend'); return; }
      this.status = meta.status; this.statusText = meta.status === 200 ? 'OK' : ''; this._rh = meta.headers || []; this.responseURL = meta.url;
      this._fire('readystatechange', 2); this._fire('readystatechange', 3);
      this.responseText = body; this._fire('readystatechange', 4); this._fire('load'); this._fire('loadend');
    }
    send(body) {
      const b = encodeBody(body === undefined ? null : body, this._h);
      this._fire('loadstart');
      if (!this._async) { const [meta, text] = __host.fetchSync(this._m, this._u, JSON.stringify(this._h._m), b); this._finish(JSON.parse(meta), text); return; }
      S.startFetch(this._m, this._u, this._h, b, (meta, text) => this._finish(meta, text));
    }
    abort() { this._aborted = true; this.readyState = 0; this._fire('abort'); }
  }
  Object.assign(XMLHttpRequest, { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 });
  g.XMLHttpRequest = XMLHttpRequest;
  g.XMLHttpRequestEventTarget = g.EventTarget;

  // ---------------------------------------------------------------- scripts
  const JS_TYPES = /^(|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|application\/x-javascript|text\/jscript|text\/livescript|text\/x-javascript|module)$/i;
  const scriptKind = (el) => {
    const t = (el.getAttribute('type') || '').trim().toLowerCase();
    if (t === 'module') return 'module';
    if (!JS_TYPES.test(t)) { const lang = el.getAttribute('language'); return t === '' && lang && !/^javascript/i.test(lang) ? null : null; }
    if (el.hasAttribute('nomodule')) return null;
    return 'classic';
  };
  S.runClassic = function (code, el) {
    const prev = S.currentScript; S.currentScript = el || null;
    try { __host.evalScript(code); } catch (e) { S.reportError(e); }
    S.currentScript = prev;
  };
  S.runModule = function (code, url) {
    try { const p = __host.runModule(code, url); if (p && p.then) p.then(null, (e) => S.reportError(e)); } catch (e) { S.reportError(e); }
  };
  let inlineModules = 0;
  const fireEl = (el, type) => S.queueTask(() => el.dispatchEvent(new Event(type)));
  function fetchScriptSync(url) {
    try { const [meta, body] = __host.fetchSync('GET', url, '[]', null); const m = JSON.parse(meta); return m.error || m.status >= 400 ? null : body; } catch (e) { return null; }
  }
  // Dynamically inserted scripts (createElement + append) run asynchronously; inline ones run now.
  function dynamicScript(el) {
    if (el._started) return;
    const kind = scriptKind(el); if (!kind) return;
    el._started = true;
    if (el.hasAttribute('src')) {
      const url = el.src;
      S.startFetch('GET', url, new Headers(), undefined, (meta, body) => {
        if (meta.error || meta.status >= 400) { fireEl(el, 'error'); return; }
        if (kind === 'module') S.runModule(body, url); else S.runClassic(body, el);
        el.dispatchEvent(new Event('load'));
      });
    } else {
      const code = el.textContent;
      if (kind === 'module') S.runModule(code, S.url + '#inline-module-' + ++inlineModules); else S.runClassic(code, el);
    }
  }
  S.onConnect = function (el) {
    const t = el._local;
    if (t === 'script' && el._ns === S.NS.html) dynamicScript(el);
    else if (t === 'iframe' && !el._frameId) openFrame(el);
    else if (t === 'img' && el._onslots && el._onslots.load) fireEl(el, 'load');
    else if (t === 'link' && /stylesheet/i.test(el.getAttribute('rel') || '') && (el._ls || el._onslots)) fireEl(el, 'load');
  };
  S.onAttr = function (el, name) {
    if (name === 'src' && el._local === 'script' && el.isConnected && !el._started && el._parserDone !== false) dynamicScript(el);
  };
  function openFrame(el) {
    const src = el.getAttribute('src');
    if (!src || /^(about:|javascript:)/i.test(src)) return;
    let url; try { url = new URL(src, doc.baseURI).href; } catch (e) { return; }
    el._frameId = __host.frameOpen(url);
  }
  S.frameLoaded = function (id, idx) {
    for (const el of S.descendants(doc)) if (el._frameId === Number(id)) { el._frameIdx = Number(idx); fireEl(el, 'load'); }
  };

  // ---------------------------------------------------------------- document load
  S.boot = function (url, referrer) {
    S.url = url; doc._url = url; doc._referrer = referrer && referrer !== 'about:blank' ? referrer : '';
    S.timeOrigin = vnow();
  };
  S.load = function (opsJson) {
    const ops = JSON.parse(opsJson);
    doc._readyState = 'loading';
    const deferred = [], asyncs = [];
    S.buildOps(doc, ops, doc, {
      attrs(el) {
        if (el._local === 'script') el._parserInserted = true;
        if (el._attrs.length) for (const [k, v] of el._attrs) if (k.length > 2 && k[0] === 'o' && k[1] === 'n') S.inlineHandler(el, k.slice(2), v);
        if (el._ceDefPending) { S.ceUpgrade(el, el._ceDefPending); el._ceDefPending = null; }
      },
      close(el) {
        const t = el._local;
        if (t === 'script' && el._ns === S.NS.html) {
          el._started = true;
          const kind = scriptKind(el); if (!kind) return;
          if (kind === 'module') { deferred.push(el); return; }
          if (el.hasAttribute('src')) {
            if (el.hasAttribute('async')) asyncs.push(el);
            else if (el.hasAttribute('defer')) deferred.push(el);
            else { const code = fetchScriptSync(el.src); if (code === null) fireEl(el, 'error'); else { S.runClassic(code, el); fireEl(el, 'load'); } }
          } else S.runClassic(el.textContent, el);
        } else if (t === 'iframe') openFrame(el);
        else if (t.indexOf('-') > 0) S.ceConnected(el);
      },
    });
    S.gen++;
    doc._readyState = 'interactive';
    for (const el of deferred) {
      if (scriptKind(el) === 'module') {
        if (el.hasAttribute('src')) { const code = fetchScriptSync(el.src); if (code !== null) S.runModule(code, el.src); }
        else S.runModule(el.textContent, S.url + '#inline-module-' + ++inlineModules);
      } else { const code = fetchScriptSync(el.src); if (code !== null) { S.runClassic(code, el); fireEl(el, 'load'); } }
    }
    for (const el of asyncs) S.queueTask(() => { const code = fetchScriptSync(el.src); if (code !== null) { S.runClassic(code, el); el.dispatchEvent(new Event('load')); } });
    doc.dispatchEvent(new Event('readystatechange'));
    doc.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    S.queueTask(() => {
      doc._readyState = 'complete';
      doc.dispatchEvent(new Event('readystatechange'));
      g.dispatchEvent(new Event('load'));
      g.dispatchEvent(new g.PageTransitionEvent('pageshow', { persisted: false }));
    });
  };
})(globalThis);
