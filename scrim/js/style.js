// The cheap visibility model: a cascade for `display`, `visibility` and `content-visibility` only,
// plus inline style objects, getComputedStyle, matchMedia and a box heuristic. No layout.
(function (g) {
  'use strict';
  const S = g.__scrim;

  // ---------------------------------------------------------------- inline style
  const kebab = (p) => (p.startsWith('--') ? p : p === 'cssFloat' ? 'float' : p.replace(/^(webkit|moz|ms)([A-Z])/, '-$1$2').replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
  function parseDecls(text) {
    const out = new Map();
    if (!text) return out;
    for (const part of String(text).split(/;(?![^(]*\))/)) {
      const i = part.indexOf(':'); if (i < 0) continue;
      const k = part.slice(0, i).trim(); let v = part.slice(i + 1).trim();
      if (!k) continue;
      const imp = /!\s*important$/i.test(v); if (imp) v = v.replace(/!\s*important$/i, '').trim();
      out.set(k.startsWith('--') ? k : k.toLowerCase(), { v, imp });
    }
    return out;
  }
  class CSSStyleDeclaration {
    constructor(el, readonly) { this._el = el; this._ro = !!readonly; this._m = el ? parseDecls(el.getAttribute('style')) : new Map(); }
    _reparse() { this._m = parseDecls(this._el.getAttribute('style')); }
    _write() {
      if (!this._el) return;
      this._el._styleWriting = true;
      const t = this.cssText;
      if (t) this._el.setAttribute('style', t); else this._el.removeAttribute('style');
      this._el._styleWriting = false;
    }
    get cssText() { let s = ''; for (const [k, o] of this._m) s += (s ? ' ' : '') + k + ': ' + o.v + (o.imp ? ' !important' : '') + ';'; return s; }
    set cssText(t) { this._m = parseDecls(t); this._write(); }
    get length() { return this._m.size; }
    item(i) { return Array.from(this._m.keys())[i] || ''; }
    getPropertyValue(p) { const o = this._m.get(p.startsWith('--') ? p : p.toLowerCase()); return o ? o.v : ''; }
    getPropertyPriority(p) { const o = this._m.get(p.toLowerCase()); return o && o.imp ? 'important' : ''; }
    setProperty(p, v, prio) {
      if (this._ro) return;
      p = p.startsWith('--') ? p : p.toLowerCase();
      if (v === null || v === undefined || v === '') { this._m.delete(p); } else this._m.set(p, { v: String(v).trim(), imp: prio === 'important' });
      this._write();
    }
    removeProperty(p) { const v = this.getPropertyValue(p); this._m.delete(p.startsWith('--') ? p : p.toLowerCase()); this._write(); return v; }
    get parentRule() { return null; }
    [Symbol.iterator]() { return this._m.keys(); }
  }
  const STYLE_PROXY = {
    get(t, k, r) {
      if (typeof k !== 'string' || k in t) return Reflect.get(t, k, t);
      if (/^\d+$/.test(k)) return t.item(Number(k));
      return t.getPropertyValue(kebab(k));
    },
    set(t, k, v) {
      if (typeof k !== 'string' || k in t || k[0] === '_') { t[k] = v; return true; }
      t.setProperty(kebab(k), v === null ? '' : String(v)); return true;
    },
    has(t, k) { return k in t || (typeof k === 'string' && t._m.has(kebab(k))); },
  };
  S.inlineStyle = (el) => new Proxy(new CSSStyleDeclaration(el), STYLE_PROXY);
  g.CSSStyleDeclaration = CSSStyleDeclaration;

  // ---------------------------------------------------------------- stylesheets
  const parsedText = new Map(); // css text -> compiled rules
  const cssByUrl = new Map();
  class CSSStyleSheet {
    constructor(opts) { this._text = ''; this._inserted = []; this.ownerNode = null; this.href = null; this.media = { mediaText: (opts && opts.media) || '' }; this.disabled = false; }
    get cssRules() { return this._inserted.map((t) => ({ cssText: t, selectorText: t.split('{')[0].trim(), style: {} })).concat([]); }
    get rules() { return this.cssRules; }
    insertRule(rule, idx) { idx = idx === undefined ? 0 : idx; this._inserted.splice(idx, 0, String(rule)); S.gen++; S.sheetsGen++; return idx; }
    deleteRule(idx) { this._inserted.splice(idx, 1); S.gen++; S.sheetsGen++; }
    addRule(sel, body, idx) { return this.insertRule(sel + '{' + body + '}', idx === undefined ? this._inserted.length : idx); }
    removeRule(i) { this.deleteRule(i); }
    replaceSync(t) { this._text = String(t); this._inserted = []; S.gen++; S.sheetsGen++; }
    replace(t) { this.replaceSync(t); return Promise.resolve(this); }
    _css() { return this._text + '\n' + this._inserted.join('\n'); }
  }
  g.CSSStyleSheet = CSSStyleSheet;
  g.StyleSheet = CSSStyleSheet;
  S.sheetsGen = 0;
  S.sheetFor = function (el) {
    if (el._sheet) return el._sheet;
    if (el._local === 'link' && !/(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') || '')) return null;
    const s = new CSSStyleSheet(); s.ownerNode = el; s.href = el._local === 'link' ? el.href : null;
    el._sheet = s; return s;
  };
  S.styleSheets = (doc) => S.descendants(doc).filter((e) => e._local === 'style' || (e._local === 'link' && /(^|\s)stylesheet(\s|$)/i.test(e.getAttribute('rel') || ''))).map((e) => S.sheetFor(e));

  function specificity(cx) {
    let a = 0, b = 0, c = 0;
    const comp = (k) => {
      if (k.id) a++;
      b += k.cls.length + k.attrs.length;
      if (k.tag && k.tag !== '*') c++;
      if (k.pe) c++;
      for (const p of k.pseudo) {
        if (p.name === 'where') continue;
        if (p.sel && /^(not|is|matches|has|-webkit-any)$/.test(p.name)) {
          let best = 0; for (const x of p.sel) best = Math.max(best, specificity(x)); a += Math.floor(best / 1e6); b += Math.floor(best / 1e3) % 1e3; c += best % 1e3;
        } else b++;
      }
    };
    for (const part of cx) comp(part.c);
    return a * 1e6 + b * 1e3 + c;
  }
  function compile(cssText) {
    let r = parsedText.get(cssText);
    if (r) return r;
    r = [];
    let raw;
    try { raw = JSON.parse(__host.cssRules(cssText)); } catch (e) { raw = []; }
    for (const [sel, prop, val, imp] of raw) {
      let list;
      try { list = S.parseSel(sel); } catch (e) { continue; }
      for (const cx of list) {
        const last = cx[cx.length - 1].c;
        if (last.pe) continue;
        // Keys every ancestor compound needs (descendant/child chains only): a cheap reject filter.
        const need = [];
        let chain = true;
        for (let k = cx.length - 1; k > 0; k--) {
          if (cx[k].comb !== ' ' && cx[k].comb !== '>') { chain = false; break; }
          const a = cx[k - 1].c;
          const key = a.id ? '#' + a.id : a.cls.length ? '.' + a.cls[0] : a.tag && a.tag !== '*' ? a.tag : null;
          if (key) need.push(key);
        }
        r.push({ cx, prop, val, imp: !!imp, spec: specificity(cx), need: chain ? need : [], key: last.id ? '#' + last.id : last.cls.length ? '.' + last.cls[0] : last.tag && last.tag !== '*' ? last.tag : last.attrs.length ? '[' + last.attrs[0].name : '*' });
      }
    }
    parsedText.set(cssText, r);
    return r;
  }
  function linkCss(el) {
    const href = el.href; if (!href) return '';
    if (cssByUrl.has(href)) return cssByUrl.get(href);
    let text = '';
    try { const [meta, body] = __host.fetchSync('GET', href, '[]', null); const m = JSON.parse(meta); if (m.status >= 200 && m.status < 300) text = body; } catch (e) {}
    cssByUrl.set(href, text);
    return text;
  }
  S.cssLoaded = (url) => cssByUrl.has(url);
  // Rule index per tree root (document or shadow root), rebuilt when sheets change.
  function indexFor(root) {
    if (root._styleIndex && root._styleIndex.gen === S.gen) return root._styleIndex;
    const sig = [];
    const els = [];
    const walk = (n) => { for (const k of n._kids) if (k.nodeType === 1) { if (k._local === 'style' || k._local === 'link') els.push(k); if (k._local !== 'svg') walk(k); } };
    walk(root);
    const texts = [];
    for (const e of els) {
      if (e._local === 'link') {
        if (!/(^|\s)stylesheet(\s|$)/i.test(e.getAttribute('rel') || '') || /(^|\s)alternate(\s|$)/i.test(e.getAttribute('rel') || '') || e.hasAttribute('disabled')) continue;
        const media = e.getAttribute('media'); if (media && !__host.mediaMatches(media)) continue;
        texts.push(linkCss(e));
      } else {
        const media = e.getAttribute('media'); if (media && !__host.mediaMatches(media)) continue;
        const t = e.textContent; texts.push(t);
        if (e._sheet && e._sheet._inserted.length) texts.push(e._sheet._inserted.join('\n'));
      }
    }
    for (const s of root.adoptedStyleSheets || []) if (s && s._css) texts.push(s._css());
    for (const t of texts) sig.push(t.length + ':' + t.slice(0, 32));
    const signature = sig.join('|');
    if (root._styleIndex && root._styleIndex.sig === signature) { root._styleIndex.gen = S.gen; return root._styleIndex; }
    const buckets = new Map();
    let order = 0;
    for (const t of texts) for (const rule of compile(t)) {
      const e = { r: rule, order: order++ };
      const b = buckets.get(rule.key); if (b) b.push(e); else buckets.set(rule.key, [e]);
    }
    let attrKeys = false; for (const k of buckets.keys()) if (k[0] === '[') { attrKeys = true; break; }
    root._styleIndex = { sig: signature, buckets, gen: S.gen, attrKeys };
    return root._styleIndex;
  }

  // ---------------------------------------------------------------- computed display / visibility
  const BLOCK = new Set(['html', 'body', 'address', 'blockquote', 'center', 'div', 'figure', 'figcaption', 'footer', 'form', 'header', 'hr', 'legend', 'listing', 'main', 'p', 'plaintext', 'pre', 'search', 'xmp',
    'article', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'nav', 'section', 'details', 'summary', 'dd', 'dl', 'dt', 'fieldset', 'menu', 'ol', 'ul', 'dir', 'optgroup', 'option', 'frameset', 'frame']);
  const NONE = new Set(['head', 'script', 'style', 'template', 'title', 'meta', 'link', 'base', 'noscript', 'datalist', 'param', 'area', 'rp', 'noembed', 'noframes', 'slot-none']);
  const UA_TAG = new Map();
  for (const t of BLOCK) UA_TAG.set(t, 'block');
  for (const [t, d] of [['li', 'list-item'], ['table', 'table'], ['caption', 'table-caption'], ['tr', 'table-row'], ['td', 'table-cell'], ['th', 'table-cell'],
    ['thead', 'table-header-group'], ['tbody', 'table-row-group'], ['tfoot', 'table-footer-group'], ['col', 'table-column'], ['colgroup', 'table-column-group'],
    ['ruby', 'ruby'], ['rt', 'ruby-text']]) UA_TAG.set(t, d);
  for (const t of ['img', 'input', 'button', 'select', 'textarea', 'video', 'audio', 'canvas', 'iframe', 'meter', 'progress', 'marquee']) UA_TAG.set(t, 'inline-block');
  function uaDisplay(el) {
    const t = el._local;
    if (el._ns !== S.NS.html) return el._ns === S.NS.svg && t !== 'svg' && t !== 'foreignObject' && t !== 'text' && t !== 'tspan' && t !== 'a' && t !== 'g' ? (t === 'title' || t === 'desc' || t === 'style' || t === 'script' || t === 'defs' || t === 'symbol' || t === 'clipPath' || t === 'mask' || t === 'linearGradient' || t === 'radialGradient' || t === 'filter' || t === 'pattern' || t === 'marker' ? 'none' : 'inline') : 'inline';
    if (NONE.has(t)) return 'none';
    if (el.hasAttribute('hidden') && el.getAttribute('hidden') !== 'until-found') return 'none';
    if (t === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return 'none';
    if (t === 'dialog') return el.hasAttribute('open') ? 'block' : 'none';
    if (el.hasAttribute('popover') && !el.hasAttribute('popover-open')) return 'none';
    if (BLOCK.has(t)) return 'block';
    switch (t) {
      case 'li': return 'list-item';
      case 'table': return 'table';
      case 'caption': return 'table-caption';
      case 'tr': return 'table-row';
      case 'td': case 'th': return 'table-cell';
      case 'thead': return 'table-header-group';
      case 'tbody': return 'table-row-group';
      case 'tfoot': return 'table-footer-group';
      case 'col': return 'table-column';
      case 'colgroup': return 'table-column-group';
      case 'ruby': return 'ruby';
      case 'rt': return 'ruby-text';
      case 'img': case 'input': case 'button': case 'select': case 'textarea': case 'video': case 'audio': case 'canvas': case 'iframe': case 'meter': case 'progress': case 'marquee': return 'inline-block';
      default: return 'inline';
    }
  }
  const composedParent = (n) => { const p = n._parent; if (!p) return null; if (p.nodeType === 11 && p.host) return p.host; return p.nodeType === 1 ? p : null; };
  // Union of tag/#id/.class keys of all ancestors (light-tree parents), memoized per mutation generation.
  function ancestorKeys(el) {
    const p = el._parent;
    if (!p || p.nodeType !== 1) return EMPTY;
    if (p._ancGen === S.gen) return p._anc;
    let s;
    s = new Set(ancestorKeys(p));
    s.add(p._local);
    const id = p.getAttribute('id'); if (id) s.add('#' + id);
    const cl = S.classes(p); if (cl) for (const c of cl) s.add('.' + c);
    p._anc = s; p._ancGen = S.gen;
    return s;
  }
  const EMPTY = new Set();

  // Hot path: one pass over the attributes, no per-element arrays or objects except the result.
  function computed(el, knownRoot) {
    let c = el._cs;
    if (c && c.gen === S.gen) return c;
    let id = null, cls = null, style = null, hidden = null, popover = false, popOpen = false, type = null, open = false;
    const attrs = el._attrs;
    for (let i = 0; i < attrs.length; i++) {
      const n = attrs[i][0];
      switch (n) {
        case 'id': id = attrs[i][1]; break;
        case 'class': cls = attrs[i][1]; break;
        case 'style': style = attrs[i][1]; break;
        case 'hidden': hidden = attrs[i][1]; break;
        case 'popover': popover = true; break;
        case 'popover-open': popOpen = true; break;
        case 'type': type = attrs[i][1]; break;
        case 'open': open = true; break;
      }
    }
    // Winners per property: [val, imp, spec, order]
    let wd = null, wv = null, wc = null;
    const root = knownRoot || el.getRootNode();
    const idx = root.nodeType === 9 || (root.nodeType === 11 && root.host) ? indexFor(root) : null;
    if (idx && idx.buckets.size) {
      const buckets = idx.buckets;
      const apply = (b) => {
        for (let k = 0; k < b.length; k++) {
          const e = b[k], r = e.r;
          const cur = r.prop === 'display' ? wd : r.prop === 'visibility' ? wv : wc;
          if (cur && (cur[1] > r.imp || (cur[1] === r.imp && (cur[2] > r.spec || (cur[2] === r.spec && cur[3] > e.order))))) continue;
          if (r.need.length) { const anc = treeAnc || ancestorKeys(el); let ok = true; for (const k2 of r.need) if (!anc.has(k2)) { ok = false; break; } if (!ok) continue; }
          if (!S.matchComplex(el, r.cx, r.cx.length - 1, null)) continue;
          const w = [r.val, r.imp, r.spec, e.order];
          if (r.prop === 'display') wd = w; else if (r.prop === 'visibility') wv = w; else wc = w;
        }
      };
      let b = buckets.get('*'); if (b) apply(b);
      b = buckets.get(el._local); if (b) apply(b);
      if (idx.attrKeys) for (let i = 0; i < attrs.length; i++) { b = buckets.get('[' + attrs[i][0]); if (b) apply(b); }
      if (id) { b = buckets.get('#' + id); if (b) apply(b); }
      if (cls) { const set = S.classes(el); for (const k of set) if (k) { b = buckets.get('.' + k); if (b) apply(b); } }
    }
    // Inline style beats non-important sheet rules.
    if (style && /display|visibility/i.test(style)) {
      const m = el._styleDecl ? el._styleDecl._m : parseDecls(style);
      let o = m.get('display'); if (o && (!wd || !wd[1] || o.imp)) wd = [o.v.toLowerCase(), o.imp];
      o = m.get('visibility'); if (o && (!wv || !wv[1] || o.imp)) wv = [o.v.toLowerCase(), o.imp];
      o = m.get('content-visibility'); if (o && (!wc || !wc[1] || o.imp)) wc = [o.v.toLowerCase(), o.imp];
    }
    let display = wd ? wd[0] : uaDisplayFast(el, hidden, popover, popOpen, type, open);
    if (display === 'revert' || display === 'initial' || display === 'unset' || display === 'revert-layer') display = display === 'initial' ? 'inline' : uaDisplayFast(el, hidden, popover, popOpen, type, open);
    let visibility = wv ? wv[0] : 'inherit';
    if (visibility === 'inherit' || visibility === 'unset' || visibility === 'revert') {
      const parent = composedParent(el);
      visibility = parent ? computed(parent, parent._parent && parent._parent.nodeType === 11 ? undefined : knownRoot).visibility : 'visible';
    }
    if (visibility === 'initial') visibility = 'visible';
    c = { gen: S.gen, display, visibility, cv: wc ? wc[0] : 'visible' };
    el._cs = c;
    return c;
  }
  function uaDisplayFast(el, hidden, popover, popOpen, type, open) {
    const t = el._local;
    if (el._ns !== S.NS.html) return uaDisplay(el);
    if (NONE.has(t)) return 'none';
    if (hidden !== null && hidden !== 'until-found') return 'none';
    if (t === 'input' && type !== null && type.toLowerCase() === 'hidden') return 'none';
    if (t === 'dialog') return open ? 'block' : 'none';
    if (popover && !popOpen) return 'none';
    return UA_TAG.get(t) || 'inline';
  }
  S.computed = computed;
  // Whole-document pass in tree order with a live multiset of ancestor keys (no per-node copies).
  // Agent reads (text, snapshot, locators) call this once per mutation generation.
  let treeAnc = null, treeGen = -1;
  class Counter {
    constructor() { this.m = new Map(); }
    has(k) { return (this.m.get(k) || 0) > 0; }
    add(k) { this.m.set(k, (this.m.get(k) || 0) + 1); }
    del(k) { this.m.set(k, this.m.get(k) - 1); }
  }
  S.styleTree = function () {
    if (treeGen === S.gen) return;
    const anc = new Counter();
    const doc = S.doc;
    const keysOf = (el) => { const k = [el._local]; const id = S.attr(el, 'id'); if (id) k.push('#' + id); const cl = S.classes(el); if (cl) for (const c of cl) k.push('.' + c); return k; };
    const visit = (el) => {
      treeAnc = anc; const c = computed(el, doc); treeAnc = null;
      if (c.display === 'none') return; // hidden subtrees are never read
      const ks = keysOf(el);
      for (const k of ks) anc.add(k);
      for (const c of el._kids) if (c.nodeType === 1) visit(c);
      for (const k of ks) anc.del(k);
    };
    const root = S.doc.documentElement;
    if (root) visit(root);
    treeGen = S.gen;
  };
  // Is the element in the render tree (display chain, closed details, unslotted light DOM)?
  S.isRendered = function (el, opts) {
    if (!el.isConnected) return false;
    for (let n = el; n; ) {
      if (n.nodeType !== 1) break;
      const c = computed(n);
      if (c.display === 'none') return false;
      if (n !== el && c.cv === 'hidden') return false;
      const p = n._parent;
      if (p && p.nodeType === 1) {
        if (p._local === 'details' && !p.hasAttribute('open') && p._ns === S.NS.html) { const sum = p.children.find((x) => x._local === 'summary'); if (sum !== n) return false; }
        if (p._shadow && !S.slotted(n)) return false;
      }
      n = composedParent(n);
    }
    if (opts && (opts.visibilityProperty || opts.checkVisibilityCSS) && computed(el).visibility !== 'visible') return false;
    return true;
  };
  // A light-DOM child of a shadow host renders only if a <slot> takes it.
  S.slotted = function (n) {
    const host = n._parent, sr = host._shadow;
    const slots = S.descendants(sr).filter((s) => s._local === 'slot');
    if (!slots.length) return false;
    const name = n.nodeType === 1 ? n.getAttribute('slot') || '' : '';
    return slots.some((s) => (s.getAttribute('name') || '') === name);
  };

  // ---------------------------------------------------------------- getComputedStyle
  const DEFAULTS = { color: 'rgb(0, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)', 'font-size': '16px', 'font-weight': '400', 'font-style': 'normal', 'font-family': 'sans-serif',
    'line-height': 'normal', position: 'static', opacity: '1', width: 'auto', height: 'auto', overflow: 'visible', 'overflow-x': 'visible', 'overflow-y': 'visible',
    'pointer-events': 'auto', 'z-index': 'auto', 'box-sizing': 'content-box', 'text-align': 'start', 'white-space': 'normal', cursor: 'auto', transform: 'none',
    'margin-top': '0px', 'margin-bottom': '0px', 'margin-left': '0px', 'margin-right': '0px', 'padding-top': '0px', 'padding-bottom': '0px', 'padding-left': '0px', 'padding-right': '0px',
    'border-top-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px', 'border-right-width': '0px', 'transition-duration': '0s', 'animation-duration': '0s',
    'animation-name': 'none', 'transition-property': 'all', direction: 'ltr', 'writing-mode': 'horizontal-tb', float: 'none', clear: 'none', 'list-style-type': 'disc', 'user-select': 'auto' };
  g.getComputedStyle = function (el, pseudo) {
    if (!el || el.nodeType !== 1) throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.");
    const c = pseudo ? { display: 'none', visibility: 'visible' } : computed(el);
    const inline = parseDecls(el.getAttribute('style'));
    const decl = new CSSStyleDeclaration(null, true);
    const get = (p) => {
      if (p === 'display') return S.isRendered(el) || !el.isConnected ? c.display : (c.display === 'none' ? 'none' : c.display);
      if (p === 'visibility') return c.visibility;
      const o = inline.get(p); if (o) return o.v;
      return DEFAULTS[p] !== undefined ? DEFAULTS[p] : '';
    };
    decl.getPropertyValue = (p) => get(String(p).startsWith('--') ? p : String(p).toLowerCase());
    return new Proxy(decl, { get(t, k) { if (typeof k !== 'string') return t[k]; if (k in t) return t[k]; if (k === 'cssText') return ''; return get(kebab(k)); }, set() { return true; } });
  };
  g.matchMedia = function (q) {
    const m = { media: String(q), matches: __host.mediaMatches(String(q)), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
    return m;
  };

  // Box heuristic: rendered elements get a non-empty box inside the viewport; no geometry is computed.
  S.rect = function (el) {
    const z = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return this; } };
    if (!el || !S.isRendered(el)) return z;
    const d = computed(el).display;
    const block = !/^inline/.test(d) || el === el._doc.documentElement;
    const w = el === el._doc.documentElement || el._local === 'body' ? g.innerWidth : block ? 800 : 100;
    const h = el === el._doc.documentElement || el._local === 'body' ? g.innerHeight : 20;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON() { return this; } };
  };

  g.CSS = {
    supports() { return true; },
    escape(s) {
      s = String(s); let out = '';
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i), ch = s[i];
        if (c === 0) out += '�';
        else if ((c >= 1 && c <= 31) || c === 127 || (i === 0 && c >= 48 && c <= 57) || (i === 1 && c >= 48 && c <= 57 && s.charCodeAt(0) === 45)) out += '\\' + c.toString(16) + ' ';
        else if (i === 0 && c === 45 && s.length === 1) out += '\\' + ch;
        else if (c >= 128 || c === 45 || c === 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) out += ch;
        else out += '\\' + ch;
      }
      return out;
    },
    registerProperty() {}, px: (n) => n + 'px', number: (n) => n,
  };
})(globalThis);
