// Web platform pieces QuickJS lacks: atob/btoa, a tiny Intl, TextEncoder/Decoder, URL, URLSearchParams,
// structuredClone, queueMicrotask, console.
(function (g) {
  'use strict';
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  g.atob = function (s) {
    s = String(s).replace(/[\s=]/g, '');
    let o = '', b = 0, n = 0;
    for (let i = 0; i < s.length; i++) {
      const v = B64.indexOf(s[i]);
      if (v < 0) throw new Error('InvalidCharacterError');
      b = (b << 6) | v; n += 6;
      if (n >= 8) { n -= 8; o += String.fromCharCode((b >> n) & 255); }
    }
    return o;
  };
  g.btoa = function (s) {
    s = String(s); let o = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      o += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4 || 0)] + (isNaN(b) ? '=' : B64[((b & 15) << 2) | (c >> 6 || 0)]) + (isNaN(c) ? '=' : B64[c & 63]);
    }
    return o;
  };

  // Intl: just enough for libraries that format numbers and dates at load time.
  if (!g.Intl) {
    function NumberFormat(locale, o) { this.o = o || {}; }
    NumberFormat.prototype.format = function (n) {
      const o = this.o; n = Number(n);
      const max = o.maximumFractionDigits != null ? o.maximumFractionDigits : (o.style === 'currency' ? 2 : 3);
      const min = o.minimumFractionDigits != null ? o.minimumFractionDigits : (o.style === 'currency' ? 2 : 0);
      let s = n.toFixed(max);
      if (max > min) s = s.replace(new RegExp('(\\.\\d{' + min + '}\\d*?)0+$'), '$1').replace(/\.$/, '');
      if (o.useGrouping !== false) { const p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = p.join('.'); }
      if (o.style === 'currency') s = ({ USD: '$', EUR: '€', GBP: '£' }[o.currency] || (o.currency + ' ')) + s;
      if (o.style === 'percent') s = (n * 100).toFixed(0) + '%';
      return s;
    };
    NumberFormat.prototype.formatToParts = function (n) { return [{ type: 'integer', value: this.format(n) }]; };
    NumberFormat.prototype.resolvedOptions = function () { return Object.assign({ locale: 'en-US', numberingSystem: 'latn' }, this.o); };
    function DateTimeFormat(locale, o) { this.o = o || {}; }
    DateTimeFormat.prototype.format = function (d) { d = d == null ? new Date() : new Date(d); return d.toLocaleDateString ? d.toISOString().slice(0, 10) : String(d); };
    DateTimeFormat.prototype.formatToParts = function (d) { return [{ type: 'literal', value: this.format(d) }]; };
    DateTimeFormat.prototype.resolvedOptions = function () { return { locale: 'en-US', timeZone: 'UTC', calendar: 'gregory', numberingSystem: 'latn' }; };
    function Collator() {} Collator.prototype.compare = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
    function PluralRules() {} PluralRules.prototype.select = function (n) { return n === 1 ? 'one' : 'other'; };
    function RelativeTimeFormat() {} RelativeTimeFormat.prototype.format = function (v, u) { return v + ' ' + u; };
    function Segmenter() {} Segmenter.prototype.segment = function (s) { return Array.from(s).map(function (c, i) { return { segment: c, index: i }; }); };
    function ListFormat() {} ListFormat.prototype.format = function (l) { return Array.from(l).join(', '); };
    g.Intl = { NumberFormat, DateTimeFormat, Collator, PluralRules, RelativeTimeFormat, Segmenter, ListFormat,
      getCanonicalLocales: function (l) { return [].concat(l || []); }, supportedValuesOf: function () { return []; } };
  }

  // UTF-8 TextEncoder / TextDecoder.
  g.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(s = '') {
      s = String(s); const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { const d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } }
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  };
  g.TextDecoder = class TextDecoder {
    constructor(label = 'utf-8') { this.encoding = String(label).toLowerCase(); }
    decode(buf) {
      if (buf == null) return '';
      const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ? buf.buffer : buf);
      let s = '';
      for (let i = 0; i < b.length;) {
        const c = b[i++];
        let cp;
        if (c < 0x80) cp = c;
        else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++] & 63);
        else if (c < 0xf0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        s += String.fromCodePoint(cp);
      }
      return s;
    }
  };

  // URLSearchParams.
  const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } };
  class URLSearchParams {
    constructor(init) {
      this._l = []; this._url = null;
      if (init == null) return;
      if (typeof init === 'string') this._parse(init);
      else if (init instanceof URLSearchParams) this._l = init._l.map((p) => p.slice());
      else if (typeof init[Symbol.iterator] === 'function') for (const [k, v] of init) this._l.push([String(k), String(v)]);
      else for (const k of Object.keys(init)) this._l.push([k, String(init[k])]);
    }
    _parse(s) { this._l = []; s = s.replace(/^\?/, ''); if (!s) return; for (const part of s.split('&')) { if (!part) continue; const i = part.indexOf('='); this._l.push(i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]); } }
    _sync() { if (this._url) { const q = this.toString(); this._url._set('search', q ? '?' + q : ''); } }
    append(k, v) { this._l.push([String(k), String(v)]); this._sync(); }
    delete(k) { this._l = this._l.filter((p) => p[0] !== k); this._sync(); }
    get(k) { const p = this._l.find((p) => p[0] === k); return p ? p[1] : null; }
    getAll(k) { return this._l.filter((p) => p[0] === k).map((p) => p[1]); }
    has(k) { return this._l.some((p) => p[0] === k); }
    set(k, v) { const i = this._l.findIndex((p) => p[0] === k); if (i < 0) this._l.push([k, String(v)]); else { this._l[i][1] = String(v); this._l = this._l.filter((p, j) => p[0] !== k || j === i); } this._sync(); }
    sort() { this._l.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._sync(); }
    forEach(f, t) { for (const [k, v] of this._l) f.call(t, v, k, this); }
    keys() { return this._l.map((p) => p[0])[Symbol.iterator](); }
    values() { return this._l.map((p) => p[1])[Symbol.iterator](); }
    entries() { return this._l.map((p) => p.slice())[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    get size() { return this._l.length; }
    toString() { return this._l.map(([k, v]) => enc(k) + '=' + enc(v)).join('&'); }
  }
  g.URLSearchParams = URLSearchParams;

  // URL, parsed by the host (rust-url, WHATWG compliant).
  class URL {
    constructor(input, base) {
      const r = base === undefined ? __host.urlParse(String(input), null) : __host.urlParse(String(input), String(base instanceof URL ? base.href : base));
      if (!r) throw new TypeError('Invalid URL: ' + input);
      this._c = JSON.parse(r);
      this._sp = new URLSearchParams(this._c.search); this._sp._url = this;
    }
    _set(part, v) {
      const c = this._c;
      let href;
      if (part === 'search') href = c.protocol + '//' + (c.username ? c.username + (c.password ? ':' + c.password : '') + '@' : '') + c.hostname + (c.port ? ':' + c.port : '') + c.pathname + (v && v[0] !== '?' ? '?' + v : v) + c.hash;
      else if (part === 'hash') href = c.href.replace(/#.*$/, '') + (v && v[0] !== '#' ? '#' + v : v);
      else if (part === 'pathname') href = c.protocol + '//' + c.hostname + (c.port ? ':' + c.port : '') + (v[0] === '/' ? v : '/' + v) + c.search + c.hash;
      else if (part === 'host') href = c.protocol + '//' + v + c.pathname + c.search + c.hash;
      else if (part === 'hostname') href = c.protocol + '//' + v + (c.port ? ':' + c.port : '') + c.pathname + c.search + c.hash;
      else if (part === 'port') href = c.protocol + '//' + c.hostname + (v ? ':' + v : '') + c.pathname + c.search + c.hash;
      else if (part === 'protocol') href = String(v).replace(/:?$/, ':') + c.href.slice(c.protocol.length);
      else href = v;
      const r = __host.urlParse(href, null);
      if (r) { this._c = JSON.parse(r); if (part !== 'search') this._sp._parse(this._c.search); }
    }
    get href() { return this._c.href; } set href(v) { this._set('href', v); }
    get origin() { return this._c.origin; }
    get protocol() { return this._c.protocol; } set protocol(v) { this._set('protocol', v); }
    get username() { return this._c.username; }
    get password() { return this._c.password; }
    get host() { return this._c.hostname + (this._c.port ? ':' + this._c.port : ''); } set host(v) { this._set('host', v); }
    get hostname() { return this._c.hostname; } set hostname(v) { this._set('hostname', v); }
    get port() { return this._c.port; } set port(v) { this._set('port', v); }
    get pathname() { return this._c.pathname; } set pathname(v) { this._set('pathname', v); }
    get search() { return this._c.search.length > 1 ? this._c.search : ''; } set search(v) { this._set('search', v); }
    get hash() { return this._c.hash.length > 1 ? this._c.hash : ''; } set hash(v) { this._set('hash', v); }
    get searchParams() { return this._sp; }
    toString() { return this.href; } toJSON() { return this.href; }
    static canParse(u, b) { try { new URL(u, b); return true; } catch (e) { return false; } }
    static createObjectURL() { return 'blob:scrim/' + Math.random().toString(36).slice(2); }
    static revokeObjectURL() {}
  }
  g.URL = URL;

  // Seeded Math.random (xorshift128+): a session replays the same random numbers.
  // Seeded on first use, so a V8 startup snapshot does not bake in the build-time seed.
  {
    let s0 = null, s1 = 0;
    Math.random = function () {
      if (s0 === null) { s0 = (__host.seed() >>> 0) || 0x9e3779b9; s1 = 0x85ebca6b ^ s0; }
      let x = s0, y = s1; s0 = y; x ^= x << 23; x ^= x >>> 17; x ^= y ^ (y >>> 26); s1 = x;
      return ((s0 + s1) >>> 0) / 4294967296;
    };
  }
  g.queueMicrotask = (f) => { Promise.resolve().then(f); };
  g.structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const fmt = (a) => Array.from(a).map((x) => {
    if (typeof x === 'string') return x;
    if (x instanceof Error) return x.message + '\n' + (x.stack || '');
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  }).join(' ');
  const con = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) con[level] = function () { __host.log(level, fmt(arguments)); };
  for (const k of ['group', 'groupCollapsed', 'groupEnd', 'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'assert', 'table', 'dir', 'dirxml', 'clear', 'profile', 'profileEnd']) con[k] = function () {};
  g.console = con;
})(globalThis);
