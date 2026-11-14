// HTML document and element classes, forms, focus, and click activation behaviour.
(function (g) {
  'use strict';
  const S = g.__scrim, HTML_NS = S.NS.html, SVG_NS = S.NS.svg;
  const Element = g.Element, Node = g.Node;

  // ---------------------------------------------------------------- reflection helpers
  const def = (C, name, get, set) => Object.defineProperty(C.prototype, name, { get, set, configurable: true, enumerable: true });
  const rStr = (C, map) => { for (const p in map) { const a = map[p]; def(C, p, function () { return this.getAttribute(a) || ''; }, function (v) { this.setAttribute(a, v); }); } };
  const rBool = (C, map) => { for (const p in map) { const a = map[p]; def(C, p, function () { return this.hasAttribute(a); }, function (v) { if (v) this.setAttribute(a, ''); else this.removeAttribute(a); }); } };
  const rUrl = (C, map) => { for (const p in map) { const a = map[p]; def(C, p, function () { const v = this.getAttribute(a); if (v === null) return ''; try { return new URL(v, this._doc.baseURI).href; } catch (e) { return v; } }, function (v) { this.setAttribute(a, v); }); } };
  const rNum = (C, map) => { for (const p in map) { const [a, d] = map[p]; def(C, p, function () { const v = parseInt(this.getAttribute(a), 10); return isNaN(v) ? d : v; }, function (v) { this.setAttribute(a, String(v)); }); } };

  // ---------------------------------------------------------------- HTMLElement (custom-element aware)
  class HTMLElement extends Element {
    constructor() {
      if (S._upgrading) { const e = S._upgrading; S._upgrading = null; return e; }
      const d = S.ceByCtor.get(new.target);
      if (!d) throw new TypeError('Illegal constructor');
      super();
      S.initElement(this, S.doc, HTML_NS, d.name);
      this._ceDef = d;
    }
    get innerText() { return S.innerText ? S.innerText(this) : this.textContent; }
    set innerText(v) { this.textContent = v; }
    get outerText() { return this.innerText; }
    get dataset() {
      if (this._ds) return this._ds;
      const el = this;
      const toAttr = (k) => 'data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
      return (this._ds = new Proxy({}, {
        get(t, k) { if (typeof k !== 'string') return undefined; const v = el.getAttribute(toAttr(k)); return v === null ? undefined : v; },
        set(t, k, v) { el.setAttribute(toAttr(k), v); return true; },
        deleteProperty(t, k) { el.removeAttribute(toAttr(k)); return true; },
        has(t, k) { return el.hasAttribute(toAttr(k)); },
        ownKeys() { return el._attrs.filter((a) => a[0].startsWith('data-')).map((a) => a[0].slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())); },
        getOwnPropertyDescriptor(t, k) { const v = el.getAttribute(toAttr(k)); return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; },
      }));
    }
    get style() { return this._styleDecl || (this._styleDecl = S.inlineStyle(this)); }
    set style(v) { this.setAttribute('style', v); }
    get tabIndex() { const v = parseInt(this.getAttribute('tabindex'), 10); return isNaN(v) ? (S.isFocusable(this) ? 0 : -1) : v; }
    set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
    get isContentEditable() { for (let n = this; n && n.nodeType === 1; n = n._parent) { const v = n.getAttribute('contenteditable'); if (v !== null) return v !== 'false'; } return false; }
    get contentEditable() { const v = this.getAttribute('contenteditable'); return v === null ? 'inherit' : v === '' ? 'true' : v; }
    set contentEditable(v) { this.setAttribute('contenteditable', v); }
    get offsetWidth() { return S.rect(this).width; } get offsetHeight() { return S.rect(this).height; }
    get offsetTop() { return S.rect(this).top; } get offsetLeft() { return S.rect(this).left; }
    get offsetParent() { return S.isRendered(this) && this._local !== 'body' ? this._doc.body : null; }
    focus(opts) { S.focus(this); }
    blur() { if (this._doc._active === this) S.focus(null); }
    click() { if (S.isDisabled(this)) return; S.fireClick(this, false); }
    showPopover() { this.setAttribute('popover-open', ''); } hidePopover() { this.removeAttribute('popover-open'); } togglePopover() {}
    attachInternals() { return { setFormValue() {}, setValidity() {}, checkValidity() { return true; }, states: new Set(), form: null, labels: [] }; }
  }
  rStr(HTMLElement, { title: 'title', lang: 'lang', dir: 'dir', accessKey: 'accesskey', nonce: 'nonce', autocapitalize: 'autocapitalize', enterKeyHint: 'enterkeyhint', inputMode: 'inputmode', popover: 'popover' });
  rBool(HTMLElement, { hidden: 'hidden', inert: 'inert', autofocus: 'autofocus' });
  def(HTMLElement, 'draggable', function () { return this.getAttribute('draggable') === 'true'; }, function (v) { this.setAttribute('draggable', String(!!v)); });
  def(HTMLElement, 'spellcheck', function () { return this.getAttribute('spellcheck') !== 'false'; }, function (v) { this.setAttribute('spellcheck', String(!!v)); });
  g.HTMLElement = HTMLElement;

  const EVENTS = ['abort', 'animationend', 'animationiteration', 'animationstart', 'auxclick', 'beforeinput', 'blur', 'cancel', 'canplay', 'change', 'click', 'close',
    'contextmenu', 'copy', 'cut', 'dblclick', 'drag', 'dragend', 'dragenter', 'dragleave', 'dragover', 'dragstart', 'drop', 'ended', 'error', 'focus', 'focusin',
    'focusout', 'formdata', 'input', 'invalid', 'keydown', 'keypress', 'keyup', 'load', 'loadeddata', 'loadedmetadata', 'loadstart', 'mousedown', 'mouseenter',
    'mouseleave', 'mousemove', 'mouseout', 'mouseover', 'mouseup', 'paste', 'pause', 'play', 'playing', 'pointercancel', 'pointerdown', 'pointerenter', 'pointerleave',
    'pointermove', 'pointerout', 'pointerover', 'pointerup', 'progress', 'reset', 'resize', 'scroll', 'scrollend', 'search', 'select', 'selectionchange', 'submit', 'toggle',
    'touchcancel', 'touchend', 'touchmove', 'touchstart', 'transitionend', 'wheel'];
  S.defineHandlers = (target, names) => {
    for (const n of names) Object.defineProperty(target, 'on' + n, {
      get() { return (this._onslots && this._onslots[n] && this._onslots[n].fn) || null; },
      set(f) { S.handlerSlot(this, n, typeof f === 'function' ? f : null); }, configurable: true, enumerable: true });
  };
  S.defineHandlers(HTMLElement.prototype, EVENTS);

  // ---------------------------------------------------------------- element classes
  const classes = Object.create(null);
  const mk = (name, tags, Base, body) => {
    const C = body ? body(Base || HTMLElement) : class extends (Base || HTMLElement) {};
    Object.defineProperty(C, 'name', { value: name });
    g[name] = C;
    for (const t of tags) classes[t] = C;
    return C;
  };
  const plain = { HTMLDivElement: ['div'], HTMLSpanElement: ['span'], HTMLParagraphElement: ['p'], HTMLHeadingElement: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    HTMLUListElement: ['ul'], HTMLDListElement: ['dl'], HTMLBRElement: ['br'], HTMLHRElement: ['hr'], HTMLPreElement: ['pre', 'listing', 'xmp'],
    HTMLQuoteElement: ['blockquote', 'q'], HTMLModElement: ['ins', 'del'], HTMLHeadElement: ['head'], HTMLHtmlElement: ['html'], HTMLBodyElement: ['body'],
    HTMLTableCaptionElement: ['caption'], HTMLTableColElement: ['col', 'colgroup'], HTMLPictureElement: ['picture'], HTMLMenuElement: ['menu'],
    HTMLDataListElement: ['datalist'], HTMLLegendElement: ['legend'], HTMLParamElement: ['param'], HTMLMapElement: ['map'], HTMLFontElement: ['font'],
    HTMLDirectoryElement: ['dir'], HTMLFrameSetElement: ['frameset'], HTMLMarqueeElement: ['marquee'], HTMLUnknownElement: [], HTMLEmbedElement: ['embed'],
    HTMLObjectElement: ['object'], HTMLSourceElement: ['source'], HTMLTrackElement: ['track'], HTMLTableSectionElement: ['thead', 'tbody', 'tfoot'] };
  for (const n in plain) mk(n, plain[n]);
  rStr(g.HTMLObjectElement, { data: 'data', type: 'type', name: 'name' });
  rUrl(g.HTMLSourceElement, { src: 'src' }); rStr(g.HTMLSourceElement, { srcset: 'srcset', type: 'type', media: 'media' });
  rUrl(g.HTMLEmbedElement, { src: 'src' });
  rNum(mk('HTMLOListElement', ['ol']), { start: ['start', 1] }); rBool(g.HTMLOListElement, { reversed: 'reversed' });
  rNum(mk('HTMLLIElement', ['li']), { value: ['value', 0] });
  rStr(mk('HTMLMetaElement', ['meta']), { name: 'name', content: 'content', httpEquiv: 'http-equiv', charset: 'charset', media: 'media' });
  rUrl(mk('HTMLBaseElement', ['base']), { href: 'href' }); rStr(g.HTMLBaseElement, { target: 'target' });
  mk('HTMLTitleElement', ['title'], null, (B) => class extends B { get text() { return this.textContent; } set text(v) { this.textContent = v; } });
  rStr(mk('HTMLDataElement', ['data']), { value: 'value' });
  rStr(mk('HTMLTimeElement', ['time']), { dateTime: 'datetime' });
  mk('HTMLTableElement', ['table'], null, (B) => class extends B {
    get rows() { return S.descendants(this).filter((e) => e._local === 'tr' && e.closest('table') === this); }
    get tBodies() { return this.children.filter((e) => e._local === 'tbody'); }
    get tHead() { return this.children.find((e) => e._local === 'thead') || null; }
    get tFoot() { return this.children.find((e) => e._local === 'tfoot') || null; }
    get caption() { return this.children.find((e) => e._local === 'caption') || null; }
  });
  mk('HTMLTableRowElement', ['tr'], null, (B) => class extends B {
    get cells() { return this.children.filter((e) => e._local === 'td' || e._local === 'th'); }
    get rowIndex() { const t = this.closest('table'); return t ? t.rows.indexOf(this) : -1; }
  });
  mk('HTMLTableCellElement', ['td', 'th'], null, (B) => class extends B { get cellIndex() { const p = this._parent; return p ? p.children.indexOf(this) : -1; } });
  rNum(g.HTMLTableCellElement, { colSpan: ['colspan', 1], rowSpan: ['rowspan', 1] }); rStr(g.HTMLTableCellElement, { headers: 'headers', scope: 'scope', abbr: 'abbr' });

  const urlParts = ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin', 'username', 'password'];
  const anchorLike = (B) => {
    const C = class extends B { toString() { return this.href; } get text() { return this.textContent; } set text(v) { this.textContent = v; }
      get relList() { return new g.DOMTokenList(this, 'rel'); } };
    for (const p of urlParts) def(C, p, function () { try { return new URL(this.href)[p]; } catch (e) { return ''; } }, function (v) { try { const u = new URL(this.href); u[p] = v; this.setAttribute('href', u.href); } catch (e) {} });
    return C;
  };
  mk('HTMLAnchorElement', ['a'], null, anchorLike); mk('HTMLAreaElement', ['area'], null, anchorLike);
  for (const C of [g.HTMLAnchorElement, g.HTMLAreaElement]) { rUrl(C, { href: 'href' }); rStr(C, { target: 'target', rel: 'rel', download: 'download', hreflang: 'hreflang', type: 'type', referrerPolicy: 'referrerpolicy', ping: 'ping', name: 'name' }); }

  mk('HTMLImageElement', ['img'], null, (B) => class extends B {
    get complete() { return true; } get naturalWidth() { return 0; } get naturalHeight() { return 0; } get currentSrc() { return this.src; }
    get width() { return parseInt(this.getAttribute('width'), 10) || 0; } set width(v) { this.setAttribute('width', v); }
    get height() { return parseInt(this.getAttribute('height'), 10) || 0; } set height(v) { this.setAttribute('height', v); }
    decode() { return Promise.resolve(); }
  });
  rUrl(g.HTMLImageElement, { src: 'src' }); rStr(g.HTMLImageElement, { alt: 'alt', srcset: 'srcset', sizes: 'sizes', loading: 'loading', decoding: 'decoding', useMap: 'usemap', referrerPolicy: 'referrerpolicy', fetchPriority: 'fetchpriority' });
  def(g.HTMLImageElement, 'crossOrigin', function () { return this.getAttribute('crossorigin'); }, function (v) { if (v == null) this.removeAttribute('crossorigin'); else this.setAttribute('crossorigin', v); });
  rBool(g.HTMLImageElement, { isMap: 'ismap' });
  g.Image = function (w, h) { const i = S.doc.createElement('img'); if (w !== undefined) i.width = w; if (h !== undefined) i.height = h; return i; };
  g.Image.prototype = g.HTMLImageElement.prototype;

  mk('HTMLScriptElement', ['script'], null, (B) => class extends B {
    get text() { return this.textContent; } set text(v) { this.textContent = v; }
    static supports(t) { return t === 'classic' || t === 'module'; }
  });
  rUrl(g.HTMLScriptElement, { src: 'src' }); rStr(g.HTMLScriptElement, { type: 'type', charset: 'charset', integrity: 'integrity', referrerPolicy: 'referrerpolicy', event: 'event', htmlFor: 'for' });
  rBool(g.HTMLScriptElement, { defer: 'defer', noModule: 'nomodule' });
  def(g.HTMLScriptElement, 'async', function () { return this._forceAsync !== undefined ? this._forceAsync : this.hasAttribute('async'); }, function (v) { this._forceAsync = undefined; if (v) this.setAttribute('async', ''); else this.removeAttribute('async'); });
  def(g.HTMLScriptElement, 'crossOrigin', function () { return this.getAttribute('crossorigin'); }, function (v) { if (v == null) this.removeAttribute('crossorigin'); else this.setAttribute('crossorigin', v); });

  mk('HTMLLinkElement', ['link'], null, (B) => class extends B { get relList() { return new g.DOMTokenList(this, 'rel'); } get sheet() { return S.sheetFor ? S.sheetFor(this) : null; } });
  rUrl(g.HTMLLinkElement, { href: 'href' }); rStr(g.HTMLLinkElement, { rel: 'rel', media: 'media', type: 'type', as: 'as', hreflang: 'hreflang', integrity: 'integrity', referrerPolicy: 'referrerpolicy', sizes: 'sizes' });
  rBool(g.HTMLLinkElement, { disabled: 'disabled' });
  def(g.HTMLLinkElement, 'crossOrigin', function () { return this.getAttribute('crossorigin'); }, function (v) { if (v == null) this.removeAttribute('crossorigin'); else this.setAttribute('crossorigin', v); });
  mk('HTMLStyleElement', ['style'], null, (B) => class extends B { get sheet() { return S.sheetFor ? S.sheetFor(this) : null; } });
  rStr(g.HTMLStyleElement, { media: 'media', type: 'type' }); rBool(g.HTMLStyleElement, { disabled: 'disabled' });

  mk('HTMLIFrameElement', ['iframe'], null, (B) => class extends B { get contentWindow() { return null; } get contentDocument() { return null; } });
  rUrl(g.HTMLIFrameElement, { src: 'src' }); rStr(g.HTMLIFrameElement, { srcdoc: 'srcdoc', name: 'name', width: 'width', height: 'height', allow: 'allow', loading: 'loading', referrerPolicy: 'referrerpolicy' });
  mk('HTMLFrameElement', ['frame']);

  mk('HTMLTemplateElement', ['template'], null, (B) => class extends B { get content() { return this._content; } });
  mk('HTMLSlotElement', ['slot'], null, (B) => class extends B {
    assignedNodes(o) { const r = this.getRootNode(); if (!r.host) return []; const n = this.name; return r.host.childNodes.filter((c) => (c.nodeType === 1 ? (c.getAttribute('slot') || '') === n : !n && c.nodeType === 3)); }
    assignedElements(o) { return this.assignedNodes(o).filter((c) => c.nodeType === 1); }
    assign() {}
  });
  rStr(g.HTMLSlotElement, { name: 'name' });
  mk('HTMLDetailsElement', ['details']); rBool(g.HTMLDetailsElement, { open: 'open' }); rStr(g.HTMLDetailsElement, { name: 'name' });
  mk('HTMLDialogElement', ['dialog'], null, (B) => class extends B {
    show() { this.setAttribute('open', ''); } showModal() { this.setAttribute('open', ''); this._modal = true; }
    close(rv) { if (!this.hasAttribute('open')) return; if (rv !== undefined) this.returnValue = rv; this.removeAttribute('open'); this.dispatchEvent(new Event('close')); }
    requestClose(rv) { this.close(rv); }
  });
  rBool(g.HTMLDialogElement, { open: 'open' }); g.HTMLDialogElement.prototype.returnValue = '';
  const media = (B) => class extends B {
    play() { return Promise.resolve(); } pause() {} load() {} canPlayType() { return ''; } fastSeek() {} addTextTrack() { return {}; }
    get paused() { return true; } get ended() { return false; } get duration() { return NaN; } get readyState() { return 0; } get networkState() { return 0; }
    get currentTime() { return 0; } set currentTime(v) {} get volume() { return 1; } set volume(v) {} get textTracks() { return []; } get buffered() { return { length: 0 }; }
  };
  mk('HTMLMediaElement', [], null, media);
  mk('HTMLVideoElement', ['video'], g.HTMLMediaElement); mk('HTMLAudioElement', ['audio'], g.HTMLMediaElement);
  for (const C of [g.HTMLMediaElement]) { rUrl(C, { src: 'src' }); rBool(C, { controls: 'controls', autoplay: 'autoplay', loop: 'loop', muted: 'muted', playsInline: 'playsinline' }); rStr(C, { preload: 'preload', poster: 'poster' }); }
  g.Audio = function (src) { const a = S.doc.createElement('audio'); if (src) a.src = src; return a; };
  mk('HTMLCanvasElement', ['canvas'], null, (B) => class extends B {
    getContext() {
      const noop = () => {};
      return new Proxy({ canvas: this, measureText: (t) => ({ width: String(t).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h }), createLinearGradient: () => ({ addColorStop: noop }),
        createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => ({}), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), getContextAttributes: () => ({}), isPointInPath: () => false },
        { get(t, k) { return k in t ? t[k] : noop; }, set(t, k, v) { t[k] = v; return true; } });
    }
    toDataURL() { return 'data:,'; } toBlob(cb) { cb && cb(null); } captureStream() { return {}; }
    get width() { return parseInt(this.getAttribute('width'), 10) || 300; } set width(v) { this.setAttribute('width', v); }
    get height() { return parseInt(this.getAttribute('height'), 10) || 150; } set height(v) { this.setAttribute('height', v); }
  });

  // SVG and MathML.
  class SVGElement extends Element {
    get className() { const el = this; return { get baseVal() { return el.getAttribute('class') || ''; }, set baseVal(v) { el.setAttribute('class', v); }, get animVal() { return el.getAttribute('class') || ''; } }; }
    set className(v) { this.setAttribute('class', v); }
    get ownerSVGElement() { let p = this._parent; while (p && p._local !== 'svg') p = p._parent; return p || null; }
    get style() { return this._styleDecl || (this._styleDecl = S.inlineStyle(this)); }
    get dataset() { return Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'dataset').get.call(this); }
    getBBox() { return { x: 0, y: 0, width: 0, height: 0 }; } getCTM() { return null; } getScreenCTM() { return null; }
    getTotalLength() { return 0; } getPointAtLength() { return { x: 0, y: 0 }; }
    focus() { S.focus(this); } blur() { if (this._doc._active === this) S.focus(null); }
    get tabIndex() { return -1; }
  }
  S.defineHandlers(SVGElement.prototype, EVENTS);
  g.SVGElement = SVGElement;
  for (const n of ['SVGGraphicsElement', 'SVGSVGElement', 'SVGPathElement', 'SVGGElement', 'SVGTextElement', 'SVGUseElement', 'SVGRectElement', 'SVGCircleElement']) {
    const C = class extends SVGElement {}; Object.defineProperty(C, 'name', { value: n }); g[n] = C;
  }
  const svgClasses = { svg: g.SVGSVGElement, path: g.SVGPathElement, g: g.SVGGElement, text: g.SVGTextElement, use: g.SVGUseElement, rect: g.SVGRectElement, circle: g.SVGCircleElement };
  class MathMLElement extends Element {}
  g.MathMLElement = MathMLElement;

  // ---------------------------------------------------------------- forms
  const LISTED = new Set(['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea']);
  function formOwner(el) {
    const f = el.getAttribute('form');
    if (f !== null) { const t = el._doc.getElementById(f); return t && t._local === 'form' ? t : null; }
    for (let p = el._parent; p; p = p._parent) if (p._local === 'form') return p;
    return null;
  }
  S.isDisabled = function (el) {
    if (!/^(button|input|select|textarea|optgroup|option|fieldset)$/.test(el._local)) return false;
    if (el.hasAttribute('disabled')) return true;
    if (el._local === 'option') { const og = el._parent; return !!(og && og._local === 'optgroup' && og.hasAttribute('disabled')); }
    for (let p = el._parent; p && p.nodeType === 1; p = p._parent) {
      if (p._local === 'fieldset' && p.hasAttribute('disabled')) {
        const legend = p.children.find((c) => c._local === 'legend');
        if (!(legend && legend.contains(el))) return true;
      }
    }
    return false;
  };
  const formProps = (C) => {
    def(C, 'form', function () { return formOwner(this); });
    def(C, 'labels', function () {
      const id = this.id; const out = [];
      for (const l of S.descendants(this._doc)) if (l._local === 'label' && ((id && l.getAttribute('for') === id) || (!l.hasAttribute('for') && l.contains(this) && S.labelControl(l) === this))) out.push(l);
      return S.nodeList(out);
    });
    rStr(C, { name: 'name', autocomplete: 'autocomplete' });
    rBool(C, { disabled: 'disabled', required: 'required' });
    def(C, 'willValidate', function () { return !S.isDisabled(this); });
    def(C, 'validity', function () { return S.validity(this); });
    def(C, 'validationMessage', function () { return S.validity(this).valid ? '' : (this._customMsg || 'Please fill out this field.'); });
    C.prototype.checkValidity = function () { const ok = S.validity(this).valid; if (!ok) this.dispatchEvent(new Event('invalid', { cancelable: true })); return ok; };
    C.prototype.reportValidity = C.prototype.checkValidity;
    C.prototype.setCustomValidity = function (m) { this._customMsg = String(m); };
  };
  S.validity = function (el) {
    const v = { valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: !!el._customMsg, valid: true };
    if (S.isDisabled(el) || el._local === 'button' || el._local === 'fieldset' || (el._local === 'input' && /^(hidden|button|submit|reset|image)$/.test(el.type))) return v;
    const val = el._local === 'select' ? el.value : el.value;
    if (el.hasAttribute('required')) {
      if (el._local === 'input' && el.type === 'checkbox') v.valueMissing = !el.checked;
      else if (el._local === 'input' && el.type === 'radio') { const f = el.form; const name = el.name; v.valueMissing = !S.radioGroup(el).some((r) => r.checked); void f; void name; }
      else v.valueMissing = val === '';
    }
    if (val && el._local === 'input') {
      if (el.type === 'email') v.typeMismatch = !/^[^@\s]+@[^@\s]+$/.test(val);
      if (el.type === 'url') v.typeMismatch = !/^[a-z][a-z0-9+.-]*:/i.test(val);
      const pat = el.getAttribute('pattern'); if (pat) try { v.patternMismatch = !new RegExp('^(?:' + pat + ')$', 'v').test(val); } catch (e) { try { v.patternMismatch = !new RegExp('^(?:' + pat + ')$').test(val); } catch (x) {} }
      const ml = parseInt(el.getAttribute('minlength'), 10); if (!isNaN(ml) && el._dirty) v.tooShort = val.length < ml;
    }
    v.valid = !(v.valueMissing || v.typeMismatch || v.patternMismatch || v.tooShort || v.customError);
    return v;
  };
  S.radioGroup = function (el) {
    const name = el.getAttribute('name'); if (!name) return [el];
    const f = formOwner(el); const root = f || el.getRootNode();
    return S.descendants(root).filter((r) => r._local === 'input' && r.type === 'radio' && r.getAttribute('name') === name && formOwner(r) === f);
  };

  const INPUT_TYPES = new Set(['hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button']);
  class HTMLInputElement extends HTMLElement {
    get type() { const t = (this.getAttribute('type') || '').toLowerCase(); return INPUT_TYPES.has(t) ? t : 'text'; }
    set type(v) { this.setAttribute('type', v); }
    get value() {
      const t = this.type;
      if (t === 'checkbox' || t === 'radio') { const v = this.getAttribute('value'); return v === null ? 'on' : v; }
      if (t === 'hidden' || t === 'submit' || t === 'reset' || t === 'button' || t === 'image') return this.getAttribute('value') || '';
      if (t === 'file') return this._files && this._files.length ? 'C:\\fakepath\\' + this._files[0].name : '';
      return this._value !== undefined ? this._value : (this.getAttribute('value') || '').replace(/[\r\n]/g, '');
    }
    set value(v) {
      v = v == null ? '' : String(v);
      const t = this.type;
      if (t === 'checkbox' || t === 'radio' || t === 'hidden' || t === 'submit' || t === 'reset' || t === 'button' || t === 'image') { this.setAttribute('value', v); return; }
      if (t === 'file') return;
      if (t === 'number' && v !== '' && isNaN(Number(v))) v = '';
      this._value = v; this._dirty = true; S.gen++;
    }
    get defaultValue() { return this.getAttribute('value') || ''; } set defaultValue(v) { this.setAttribute('value', v); }
    get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
    set checked(v) {
      v = !!v; this._checked = v; S.gen++;
      if (v && this.type === 'radio') for (const r of S.radioGroup(this)) if (r !== this) { r._checked = false; }
    }
    get defaultChecked() { return this.hasAttribute('checked'); } set defaultChecked(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }
    get valueAsNumber() { const n = parseFloat(this.value); return isNaN(n) ? NaN : n; } set valueAsNumber(n) { this.value = String(n); }
    get valueAsDate() { return null; } set valueAsDate(d) { if (d) this.value = d.toISOString().slice(0, 10); }
    get files() { return this.type === 'file' ? (this._files || []) : null; }
    get selectionStart() { return this.value.length; } set selectionStart(v) {}
    get selectionEnd() { return this.value.length; } set selectionEnd(v) {}
    get selectionDirection() { return 'none'; }
    setSelectionRange() {} setRangeText(t) { this.value = t; } select() {} showPicker() {}
    stepUp(n) { this.value = String((parseFloat(this.value) || 0) + (n || 1) * (parseFloat(this.getAttribute('step')) || 1)); }
    stepDown(n) { this.stepUp(-(n || 1)); }
    get list() { const id = this.getAttribute('list'); return id ? this._doc.getElementById(id) : null; }
  }
  rStr(HTMLInputElement, { placeholder: 'placeholder', min: 'min', max: 'max', step: 'step', pattern: 'pattern', accept: 'accept', alt: 'alt', dirName: 'dirname',
    formAction: 'formaction', formMethod: 'formmethod', formEnctype: 'formenctype', formTarget: 'formtarget' });
  rUrl(HTMLInputElement, { src: 'src' });
  rBool(HTMLInputElement, { readOnly: 'readonly', multiple: 'multiple', formNoValidate: 'formnovalidate' });
  rNum(HTMLInputElement, { maxLength: ['maxlength', -1], minLength: ['minlength', -1], size: ['size', 20] });
  HTMLInputElement.prototype.indeterminate = false;
  formProps(HTMLInputElement);
  g.HTMLInputElement = HTMLInputElement; classes.input = HTMLInputElement;
  const CHECKED = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');

  class HTMLTextAreaElement extends HTMLElement {
    get type() { return 'textarea'; }
    get value() { return this._value !== undefined ? this._value : this.textContent; }
    set value(v) { this._value = v == null ? '' : String(v); this._dirty = true; S.gen++; }
    get defaultValue() { return this.textContent; } set defaultValue(v) { this.textContent = v; }
    get textLength() { return this.value.length; }
    get selectionStart() { return this.value.length; } set selectionStart(v) {} get selectionEnd() { return this.value.length; } set selectionEnd(v) {}
    setSelectionRange() {} select() {} setRangeText(t) { this.value = t; }
  }
  rStr(HTMLTextAreaElement, { placeholder: 'placeholder', wrap: 'wrap', dirName: 'dirname' }); rBool(HTMLTextAreaElement, { readOnly: 'readonly' });
  rNum(HTMLTextAreaElement, { rows: ['rows', 2], cols: ['cols', 20], maxLength: ['maxlength', -1], minLength: ['minlength', -1] });
  formProps(HTMLTextAreaElement);
  g.HTMLTextAreaElement = HTMLTextAreaElement; classes.textarea = HTMLTextAreaElement;

  class HTMLSelectElement extends HTMLElement {
    get type() { return this.multiple ? 'select-multiple' : 'select-one'; }
    get options() { const o = S.descendants(this).filter((e) => e._local === 'option'); o.namedItem = (n) => o.find((x) => x.id === n || x.getAttribute('name') === n) || null; o.add = (x, b) => this.add(x, b); o.remove = (i) => this.remove(i); Object.defineProperty(o, 'selectedIndex', { get: () => this.selectedIndex, set: (i) => { this.selectedIndex = i; } }); return o; }
    get length() { return this.options.length; } set length(n) { const o = this.options; while (o.length > n) o.pop().remove(); }
    item(i) { return this.options[i] || null; }
    namedItem(n) { return this.options.namedItem(n); }
    get selectedOptions() { return S.nodeList(this.options.filter((o) => o.selected)); }
    get selectedIndex() { return S.descendants(this).filter((e) => e._local === 'option').findIndex((o) => o.selected); }
    set selectedIndex(i) { this.options.forEach((o, k) => { o._selected = k === i; }); S.gen++; }
    get value() { const o = this.options.find((x) => x.selected); return o ? o.value : ''; }
    set value(v) { let hit = false; for (const o of this.options) { o._selected = !hit && o.value === String(v); if (o._selected) hit = true; } S.gen++; }
    add(opt, before) { if (typeof before === 'number') before = this.options[before]; (before && before._parent) ? before._parent.insertBefore(opt, before) : this.appendChild(opt); }
    remove(i) { if (i === undefined) return Element.prototype.remove.call(this); const o = this.options[i]; if (o) o.remove(); }
    showPicker() {}
  }
  rBool(HTMLSelectElement, { multiple: 'multiple' }); rNum(HTMLSelectElement, { size: ['size', 0] });
  formProps(HTMLSelectElement);
  g.HTMLSelectElement = HTMLSelectElement; classes.select = HTMLSelectElement;

  function ownerSelect(o) { for (let p = o._parent; p && p.nodeType === 1; p = p._parent) { if (p._local === 'select') return p; if (p._local !== 'optgroup') return null; } return null; }
  class HTMLOptionElement extends HTMLElement {
    get value() { const v = this.getAttribute('value'); return v !== null ? v : this.text; } set value(v) { this.setAttribute('value', v); }
    get text() { return this.textContent.replace(/[ \t\n\f\r]+/g, ' ').trim(); } set text(v) { this.textContent = v; }
    get label() { const l = this.getAttribute('label'); return l !== null ? l : this.text; } set label(v) { this.setAttribute('label', v); }
    get defaultSelected() { return this.hasAttribute('selected'); } set defaultSelected(v) { if (v) this.setAttribute('selected', ''); else this.removeAttribute('selected'); }
    get selected() {
      if (this._selected !== undefined) return this._selected;
      const sel = ownerSelect(this);
      if (!sel) return this.hasAttribute('selected');
      const opts = sel.options;
      const explicit = opts.filter((o) => (o._selected !== undefined ? o._selected : o.hasAttribute('selected')));
      if (sel.multiple) return explicit.includes(this);
      if (explicit.length) return explicit[explicit.length - 1] === this && !opts.some((o) => o._selected === true && o !== this);
      if ((sel.size || 1) > 1) return false;
      return opts.find((o) => !S.isDisabled(o)) === this;
    }
    set selected(v) {
      const sel = ownerSelect(this);
      if (v && sel && !sel.multiple) for (const o of sel.options) o._selected = false;
      this._selected = !!v; S.gen++;
    }
    get index() { const s = ownerSelect(this); return s ? s.options.indexOf(this) : 0; }
    get form() { const s = ownerSelect(this); return s ? s.form : null; }
  }
  rBool(HTMLOptionElement, { disabled: 'disabled' });
  g.HTMLOptionElement = HTMLOptionElement; classes.option = HTMLOptionElement;
  g.Option = function (text, value, defSel, sel) {
    const o = S.doc.createElement('option'); if (text !== undefined) o.text = text; if (value !== undefined) o.value = value;
    if (defSel) o.defaultSelected = true; if (sel) o.selected = true; return o;
  };
  g.Option.prototype = HTMLOptionElement.prototype;
  mk('HTMLOptGroupElement', ['optgroup']); rStr(g.HTMLOptGroupElement, { label: 'label' }); rBool(g.HTMLOptGroupElement, { disabled: 'disabled' });

  class HTMLButtonElement extends HTMLElement {
    get type() { const t = (this.getAttribute('type') || '').toLowerCase(); return t === 'button' || t === 'reset' ? t : 'submit'; }
    set type(v) { this.setAttribute('type', v); }
  }
  rStr(HTMLButtonElement, { value: 'value', formAction: 'formaction', formMethod: 'formmethod', formEnctype: 'formenctype', formTarget: 'formtarget', popoverTargetAction: 'popovertargetaction' });
  rBool(HTMLButtonElement, { formNoValidate: 'formnovalidate' });
  formProps(HTMLButtonElement);
  g.HTMLButtonElement = HTMLButtonElement; classes.button = HTMLButtonElement;

  class HTMLFieldSetElement extends HTMLElement { get type() { return 'fieldset'; } get elements() { return S.descendants(this).filter((e) => LISTED.has(e._local)); } }
  formProps(HTMLFieldSetElement);
  g.HTMLFieldSetElement = HTMLFieldSetElement; classes.fieldset = HTMLFieldSetElement;
  mk('HTMLOutputElement', ['output'], null, (B) => class extends B { get value() { return this.textContent; } set value(v) { this.textContent = v; } get type() { return 'output'; } });
  formProps(g.HTMLOutputElement);
  mk('HTMLProgressElement', ['progress'], null, (B) => class extends B { get value() { return parseFloat(this.getAttribute('value')) || 0; } set value(v) { this.setAttribute('value', v); } get max() { return parseFloat(this.getAttribute('max')) || 1; } set max(v) { this.setAttribute('max', v); } get position() { return this.value / this.max; } });
  mk('HTMLMeterElement', ['meter'], null, (B) => class extends B { get value() { return parseFloat(this.getAttribute('value')) || 0; } set value(v) { this.setAttribute('value', v); } });

  S.labelControl = function (l) {
    const f = l.getAttribute('for');
    if (f !== null) { const t = l.getRootNode().getElementById ? l.getRootNode().getElementById(f) : l._doc.getElementById(f); return t && S.isLabelable(t) ? t : null; }
    return S.descendants(l).find((e) => S.isLabelable(e)) || null;
  };
  S.isLabelable = (e) => /^(button|meter|output|progress|select|textarea)$/.test(e._local) || (e._local === 'input' && e.type !== 'hidden');
  class HTMLLabelElement extends HTMLElement { get control() { return S.labelControl(this); } get form() { const c = this.control; return c ? c.form : null; } }
  rStr(HTMLLabelElement, { htmlFor: 'for' });
  g.HTMLLabelElement = HTMLLabelElement; classes.label = HTMLLabelElement;

  class HTMLFormElement extends HTMLElement {
    get elements() {
      const out = S.descendants(this._doc).filter((e) => LISTED.has(e._local) && !(e._local === 'input' && e.type === 'image') && formOwner(e) === this);
      for (const e of out) { const n = e.getAttribute('name') || e.id; if (n && !(n in out)) out[n] = e; }
      out.namedItem = (n) => out[n] || null; out.item = (i) => out[i] || null;
      return out;
    }
    get length() { return this.elements.length; }
    get action() { const a = this.getAttribute('action'); try { return new URL(a === null || a === '' ? this._doc.URL : a, this._doc.baseURI).href; } catch (e) { return this._doc.URL; } }
    set action(v) { this.setAttribute('action', v); }
    get method() { const m = (this.getAttribute('method') || 'get').toLowerCase(); return m === 'post' || m === 'dialog' ? m : 'get'; } set method(v) { this.setAttribute('method', v); }
    get enctype() { const e = (this.getAttribute('enctype') || '').toLowerCase(); return e === 'multipart/form-data' || e === 'text/plain' ? e : 'application/x-www-form-urlencoded'; }
    set enctype(v) { this.setAttribute('enctype', v); }
    get encoding() { return this.enctype; }
    submit() { S.submitForm(this, null); }
    requestSubmit(submitter) { S.requestSubmit(this, submitter || null); }
    reset() {
      if (!this.dispatchEvent(new Event('reset', { bubbles: true, cancelable: true }))) return;
      for (const e of this.elements) { e._value = undefined; e._checked = undefined; e._dirty = false; if (e._local === 'select') for (const o of e.options) o._selected = undefined; }
      S.gen++;
    }
    checkValidity() { return this.elements.every((e) => !e.checkValidity || e.checkValidity()); }
    reportValidity() { return this.checkValidity(); }
  }
  rStr(HTMLFormElement, { name: 'name', target: 'target', acceptCharset: 'accept-charset', autocomplete: 'autocomplete', rel: 'rel' });
  rBool(HTMLFormElement, { noValidate: 'novalidate' });
  g.HTMLFormElement = HTMLFormElement; classes.form = HTMLFormElement;

  S.entryList = function (form, submitter) {
    const out = [];
    for (const e of form.elements) {
      if (S.isDisabled(e) || e._local === 'fieldset' || e._local === 'object' || e._local === 'output') continue;
      const name = e.getAttribute('name');
      if (e._local === 'button' || (e._local === 'input' && /^(submit|reset|button|image)$/.test(e.type))) { if (e === submitter && name) out.push([name, e.value]); continue; }
      if (!name) continue;
      if (e._local === 'input' && (e.type === 'checkbox' || e.type === 'radio') && !e.checked) continue;
      if (e._local === 'input' && e.type === 'file') { out.push([name, '']); continue; }
      if (e._local === 'select') { for (const o of e.options) if (o.selected && !S.isDisabled(o)) out.push([name, o.value]); continue; }
      if (e._local === 'textarea') { out.push([name, e.value.replace(/\r?\n/g, '\r\n')]); continue; }
      out.push([name, e.value]);
    }
    if (submitter && submitter._local === 'input' && submitter.type === 'image') { const n = submitter.name ? submitter.name + '.' : ''; out.push([n + 'x', '0'], [n + 'y', '0']); }
    return out;
  };
  S.requestSubmit = function (form, submitter) {
    const novalidate = form.noValidate || (submitter && submitter.hasAttribute('formnovalidate'));
    if (!novalidate) {
      const bad = form.elements.filter((e) => !S.validity(e).valid);
      if (bad.length) { for (const e of bad) e.dispatchEvent(new Event('invalid', { cancelable: true })); S.lastInvalid = bad; return; }
    }
    const ev = new g.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter });
    if (!form.dispatchEvent(ev)) return;
    S.submitForm(form, submitter);
  };
  S.submitForm = function (form, submitter) {
    const pick = (attr, prop) => (submitter && submitter.hasAttribute(attr) ? submitter.getAttribute(attr) : null) || form[prop];
    let action = form.action;
    if (submitter && submitter.hasAttribute('formaction')) action = new URL(submitter.getAttribute('formaction'), form._doc.baseURI).href;
    const method = String(pick('formmethod', 'method')).toLowerCase();
    const enctype = String(pick('formenctype', 'enctype')).toLowerCase();
    const entries = S.entryList(form, submitter);
    if (method === 'dialog') { const d = form.closest('dialog'); if (d) d.close(submitter ? submitter.value : undefined); return; }
    if (/^javascript:/i.test(action)) { try { (0, eval)(decodeURIComponent(action.slice(11))); } catch (e) { S.reportError(e); } return; }
    if (method === 'get') {
      const u = new URL(action); u.search = new URLSearchParams(entries).toString(); u.hash = '';
      S.navigate(u.href, 'GET', null, null);
    } else if (enctype === 'multipart/form-data') {
      const b = '----scrimFormBoundary' + Math.random().toString(36).slice(2);
      const body = entries.map(([k, v]) => '--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n').join('') + '--' + b + '--\r\n';
      S.navigate(action, 'POST', body, 'multipart/form-data; boundary=' + b);
    } else if (enctype === 'text/plain') {
      S.navigate(action, 'POST', entries.map(([k, v]) => k + '=' + v).join('\r\n') + '\r\n', 'text/plain');
    } else {
      S.navigate(action, 'POST', new URLSearchParams(entries).toString(), 'application/x-www-form-urlencoded');
    }
  };

  // ---------------------------------------------------------------- focus and clicks
  S.isFocusable = (el) => {
    if (S.isDisabled(el)) return false;
    if (el.hasAttribute('tabindex')) return true;
    if (el.isContentEditable) return true;
    return /^(button|select|textarea|iframe)$/.test(el._local) || (el._local === 'input' && el.type !== 'hidden') || ((el._local === 'a' || el._local === 'area') && el.hasAttribute('href')) || el._local === 'summary';
  };
  S.focus = function (el) {
    const doc = S.doc; const old = doc._active || null;
    if (el && !S.isFocusable(el)) return;
    if (old === el) return;
    doc._active = el;
    if (old) { old.dispatchEvent(new g.FocusEvent('blur', { relatedTarget: el, composed: true })); old.dispatchEvent(new g.FocusEvent('focusout', { bubbles: true, relatedTarget: el, composed: true })); }
    if (el) { el.dispatchEvent(new g.FocusEvent('focus', { relatedTarget: old, composed: true })); el.dispatchEvent(new g.FocusEvent('focusin', { bubbles: true, relatedTarget: old, composed: true })); }
  };
  S.fireClick = function (el) {
    const ev = new g.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, view: g, button: 0, pointerId: -1, pointerType: '' });
    return el.dispatchEvent(ev);
  };
  const isInteractive = (e) => /^(a|button|details|embed|iframe|label|select|textarea)$/.test(e._local) || (e._local === 'input' && e.type !== 'hidden');

  S.findActivation = function (target, ev) {
    for (let el = target; el; el = el._parent || (el.host && ev.composed ? el.host : null)) {
      if (el.nodeType !== 1) continue;
      const t = el._local;
      if (t === 'input') {
        const ty = el.type;
        // Internal state changes bypass instance-level property overrides (React's value tracker).
        const setC = (x, v) => CHECKED.set.call(x, v);
        const getC = (x) => CHECKED.get.call(x);
        if (ty === 'checkbox') { let old; return { pre() { old = getC(el); setC(el, !old); el.indeterminate = false; }, cancel() { setC(el, old); }, run() { S.fireInputChange(el); } }; }
        if (ty === 'radio') {
          let prev;
          return { pre() { prev = S.radioGroup(el).find((r) => getC(r)) || null; if (!getC(el)) setC(el, true); },
            cancel() { if (prev) setC(prev, true); else setC(el, false); },
            run() { if (prev !== el) S.fireInputChange(el); } };
        }
        if (ty === 'submit' || ty === 'image') return { run() { const f = el.form; if (f && !S.isDisabled(el)) S.requestSubmit(f, el); } };
        if (ty === 'reset') return { run() { const f = el.form; if (f) f.reset(); } };
        if (ty === 'button') return null;
        return null;
      }
      if (t === 'button') {
        if (S.isDisabled(el)) return null;
        const ty = el.type;
        return { run() {
          const f = el.form;
          if (ty === 'submit' && f) S.requestSubmit(f, el);
          else if (ty === 'reset' && f) f.reset();
          const pt = el.getAttribute('popovertarget') || el.getAttribute('commandfor');
          if (pt) { const p = el._doc.getElementById(pt); if (p) { if (p.hasAttribute('popover-open')) p.removeAttribute('popover-open'); else p.setAttribute('popover-open', ''); } }
        } };
      }
      if ((t === 'a' || t === 'area') && el.hasAttribute('href')) return { run() { S.followLink(el); } };
      if (t === 'summary') {
        const d = el._parent;
        if (d && d._local === 'details' && d.children.find((c) => c._local === 'summary') === el) return { run() { d.open = !d.open; d.dispatchEvent(new Event('toggle')); } };
      }
      if (t === 'label') {
        return { run() {
          for (let n = target; n && n !== el; n = n._parent) if (n.nodeType === 1 && isInteractive(n)) return;
          const c = S.labelControl(el);
          if (c && c !== target && !S.isDisabled(c)) { c.focus(); S.fireClick(c); }
        } };
      }
    }
    return null;
  };
  S.fireInputChange = function (el) {
    el.dispatchEvent(new g.InputEvent('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  S.followLink = function (a) {
    const href = a.getAttribute('href');
    if (href === null) return;
    if (/^\s*javascript:/i.test(href)) { try { (0, eval)(decodeURIComponent(href.replace(/^\s*javascript:/i, ''))); } catch (e) { S.reportError(e); } return; }
    if (a.hasAttribute('download')) return;
    S.navigate(a.href, 'GET', null, null);
  };

  // ---------------------------------------------------------------- element creation
  S.initElement = function (el, doc, ns, local) {
    S.initNode(el, 1, '', doc);
    el._nid = S.nodeSeq = (S.nodeSeq || 0) + 1; // stable across replays: refs are e<_nid>
    el._ns = ns; el._local = local; el._tag = ns === HTML_NS ? local.toUpperCase() : local; el.nodeName = el._tag; el._attrs = [];
    if (local === 'template' && ns === HTML_NS) { const f = Object.create(g.DocumentFragment.prototype); S.initNode(f, 11, '#document-fragment', doc); el._content = f; }
  };
  S.createElement = function (doc, ns, local, fromParser) {
    if (ns === HTML_NS && !fromParser && local.indexOf('-') > 0) {
      const d = S.ceDefs.get(local);
      if (d) { const el = new d.ctor(); return el; }
    }
    const C = ns === HTML_NS ? (classes[local] || HTMLElement) : ns === SVG_NS ? (svgClasses[local] || SVGElement) : ns === S.NS.math ? MathMLElement : Element;
    const el = Object.create(C.prototype);
    S.initElement(el, doc, ns, local);
    if (fromParser && ns === HTML_NS && local.indexOf('-') > 0) { const d = S.ceDefs.get(local); if (d) el._ceDefPending = d; }
    return el;
  };
  S.cloneExtra = function (src, dst) {
    if (src._value !== undefined) dst._value = src._value;
    if (src._checked !== undefined) dst._checked = src._checked;
  };

  // ---------------------------------------------------------------- document
  class Document extends Node {
    constructor() { super(); S.initNode(this, 9, '#document', null); this._doc = this; this._readyState = 'complete'; this._url = 'about:blank'; }
    get documentElement() { return this._kids.find((c) => c.nodeType === 1) || null; }
    get head() { const h = this.documentElement; return h ? h.children.find((c) => c._local === 'head') || null : null; }
    get body() { const h = this.documentElement; return h ? h.children.find((c) => c._local === 'body' || c._local === 'frameset') || null : null; }
    set body(b) { const h = this.documentElement; const old = this.body; if (old) h.replaceChild(b, old); else h.appendChild(b); }
    get title() { const t = S.descendants(this).find((e) => e._local === 'title'); return t ? t.textContent.replace(/[ \t\n\f\r]+/g, ' ').trim() : ''; }
    set title(v) { let t = S.descendants(this).find((e) => e._local === 'title'); if (!t) { t = this.createElement('title'); (this.head || this.documentElement).appendChild(t); } t.textContent = v; }
    get URL() { return this._url; } get documentURI() { return this._url; }
    get baseURI() {
      // Every a.href resolves against this: cache it per mutation generation and URL instead of walking the document each time.
      if (this._baseGen === S.gen && this._baseFor === this._url) return this._base;
      let base = this._url;
      const b = S.descendants(this).find((e) => e._local === 'base' && e.hasAttribute('href'));
      if (b) try { base = new URL(b.getAttribute('href'), this._url).href; } catch (e) {}
      this._baseGen = S.gen; this._baseFor = this._url; this._base = base;
      return base;
    }
    get location() { return this === S.doc ? g.location : null; } set location(v) { if (this === S.doc) g.location.href = v; }
    get domain() { try { return new URL(this._url).hostname; } catch (e) { return ''; } } set domain(v) {}
    get referrer() { return this._referrer || ''; }
    get cookie() { return this === S.doc ? __host.cookieGet(this._url) : ''; }
    set cookie(v) { if (this === S.doc) __host.cookieSet(this._url, String(v)); }
    get readyState() { return this._readyState; }
    get characterSet() { return 'UTF-8'; } get charset() { return 'UTF-8'; } get inputEncoding() { return 'UTF-8'; }
    get contentType() { return 'text/html'; } get compatMode() { return 'CSS1Compat'; } get designMode() { return 'off'; } set designMode(v) {}
    get dir() { const h = this.documentElement; return h ? h.getAttribute('dir') || '' : ''; } set dir(v) { if (this.documentElement) this.documentElement.setAttribute('dir', v); }
    get visibilityState() { return 'visible'; } get hidden() { return false; } hasFocus() { return true; }
    get activeElement() { const a = this._active; return a && a.isConnected ? a : this.body; }
    get defaultView() { return this === S.doc ? g : null; }
    get forms() { return S.nodeList(S.descendants(this).filter((e) => e._local === 'form')); }
    get images() { return S.nodeList(S.descendants(this).filter((e) => e._local === 'img')); }
    get links() { return S.nodeList(S.descendants(this).filter((e) => (e._local === 'a' || e._local === 'area') && e.hasAttribute('href'))); }
    get anchors() { return S.nodeList(S.descendants(this).filter((e) => e._local === 'a' && e.hasAttribute('name'))); }
    get scripts() { return S.nodeList(S.descendants(this).filter((e) => e._local === 'script')); }
    get embeds() { return S.nodeList(S.descendants(this).filter((e) => e._local === 'embed')); }
    get plugins() { return this.embeds; }
    get all() { return S.nodeList(S.descendants(this)); }
    get currentScript() { return S.currentScript || null; }
    get scrollingElement() { return this.documentElement; }
    get fullscreenElement() { return null; } get fullscreenEnabled() { return false; } get pointerLockElement() { return null; } get pictureInPictureElement() { return null; }
    get styleSheets() { return S.styleSheets ? S.styleSheets(this) : []; }
    get adoptedStyleSheets() { return this._adopted || []; } set adoptedStyleSheets(v) { this._adopted = v; }
    get fonts() { return S.fonts || (S.fonts = { ready: Promise.resolve(), status: 'loaded', check: () => true, load: () => Promise.resolve([]), add() {}, delete() {}, has: () => false, forEach() {}, addEventListener() {}, removeEventListener() {}, size: 0 }); }
    get implementation() {
      return { createHTMLDocument: (title) => { const d = S.createDocument(); const h = d.createElement('html'); d.appendChild(h); h.appendChild(d.createElement('head')); h.appendChild(d.createElement('body')); if (title !== undefined) d.title = title; return d; },
        createDocument: () => S.createDocument(), createDocumentType: (n) => { const t = Object.create(g.DocumentType.prototype); S.initNode(t, 10, n, null); t.name = n; return t; }, hasFeature: () => true };
    }
    get doctype() { return null; }
    get timeline() { return { currentTime: __host.now() }; }
    createElement(tag, opts) {
      tag = String(tag);
      if (!/^[A-Za-z][^\s\/>\0]*$/.test(tag)) throw DOMException("Failed to execute 'createElement' on 'Document': The tag name provided ('" + tag + "') is not a valid name.", 'InvalidCharacterError');
      return S.createElement(this, HTML_NS, tag.toLowerCase(), false);
    }
    createElementNS(ns, qn) { const local = String(qn).replace(/^.*:/, ''); return S.createElement(this, ns || null, ns === HTML_NS ? local.toLowerCase() : local, false); }
    createTextNode(d) { const t = Object.create(g.Text.prototype); S.initNode(t, 3, '#text', this); t._data = String(d); return t; }
    createComment(d) { const t = Object.create(g.Comment.prototype); S.initNode(t, 8, '#comment', this); t._data = String(d); return t; }
    createCDATASection(d) { return this.createTextNode(d); }
    createProcessingInstruction(t, d) { return this.createComment('?' + t + ' ' + d + '?'); }
    createDocumentFragment() { const f = Object.create(g.DocumentFragment.prototype); S.initNode(f, 11, '#document-fragment', this); return f; }
    createAttribute(n) { return new g.Attr(String(n).toLowerCase(), '', null); }
    createEvent(type) {
      const m = { event: Event, events: Event, htmlevents: Event, uievent: g.UIEvent, uievents: g.UIEvent, mouseevent: g.MouseEvent, mouseevents: g.MouseEvent,
        keyboardevent: g.KeyboardEvent, keyboardevents: g.KeyboardEvent, customevent: g.CustomEvent, focusevent: g.FocusEvent, messageevent: g.MessageEvent, touchevent: g.TouchEvent };
      const C = m[String(type).toLowerCase()]; if (!C) throw DOMException('The provided event type is invalid.', 'NotSupportedError');
      const e = new C(''); return e;
    }
    createRange() { return S.createRange(this); }
    createTreeWalker(root, what, filter) { return S.treeWalker(root, what === undefined ? 0xffffffff : what, filter); }
    createNodeIterator(root, what, filter) { const w = S.treeWalker(root, what === undefined ? 0xffffffff : what, filter); w.referenceNode = root; w.detach = () => {}; return w; }
    getElementById(id) { id = String(id); return id === '' ? null : S.byId(this, id); }
    getElementsByName(n) { return S.nodeList(S.descendants(this).filter((e) => e.getAttribute('name') === n)); }
    elementFromPoint() { return null; } elementsFromPoint() { return []; } caretRangeFromPoint() { return null; }
    getSelection() { return g.getSelection(); }
    execCommand() { return false; } queryCommandSupported() { return false; } queryCommandState() { return false; } queryCommandEnabled() { return false; }
    importNode(n, deep) { return S.clone(n, !!deep, this); }
    adoptNode(n) { if (n._parent) S.remove(n); S.adopt(n, this); return n; }
    open() { return this; } close() {}
    write(...a) { S.docWrite(this, a.join('')); } writeln(...a) { S.docWrite(this, a.join('') + '\n'); }
    exitFullscreen() { return Promise.resolve(); } exitPointerLock() {}
    startViewTransition(cb) { const p = Promise.resolve().then(() => cb && cb()); return { finished: p, ready: p, updateCallbackDone: p, skipTransition() {} }; }
    hasStorageAccess() { return Promise.resolve(true); } requestStorageAccess() { return Promise.resolve(); }
  }
  for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(g.DocumentFragment.prototype) === Node.prototype ? {} : {})) void k;
  // ParentNode mixin on Document.
  for (const k of ['children', 'childElementCount', 'firstElementChild', 'lastElementChild', 'append', 'prepend', 'replaceChildren', 'querySelector', 'querySelectorAll', 'getElementsByTagName', 'getElementsByTagNameNS', 'getElementsByClassName'])
    Object.defineProperty(Document.prototype, k, Object.getOwnPropertyDescriptor(Element.prototype, k));
  S.defineHandlers(Document.prototype, EVENTS.concat(['readystatechange', 'visibilitychange', 'DOMContentLoaded', 'pointerlockchange', 'fullscreenchange']));
  g.Document = Document;
  class HTMLDocument extends Document {}
  g.HTMLDocument = HTMLDocument;
  class XMLDocument extends Document {}
  g.XMLDocument = XMLDocument;
  S.createDocument = function () { const d = Object.create(HTMLDocument.prototype); S.initNode(d, 9, '#document', null); d._doc = d; d._readyState = 'complete'; d._url = 'about:blank'; return d; };

  S.docWrite = function (doc, html) {
    const sc = S.currentScript;
    if (doc._readyState === 'loading' && sc && sc._parent) {
      const f = doc.createDocumentFragment(); S.setInnerHTML(f, html, sc._parent.nodeType === 1 ? sc._parent._local : 'body');
      for (const s of S.descendants(f)) if (s._local === 'script') s._started = false;
      sc._parent.insertBefore(f, sc.nextSibling);
    }
  };

  // TreeWalker / NodeIterator (one implementation, document order).
  S.treeWalker = function (root, what, filter) {
    const accept = (n) => {
      const bit = 1 << (n.nodeType - 1);
      if (!(what & bit)) return 3;
      if (!filter) return 1;
      const r = typeof filter === 'function' ? filter(n) : filter.acceptNode(n);
      return r;
    };
    const next = (n) => { if (n._kids && n._kids.length) return n._kids[0]; for (let x = n; x && x !== root; x = x._parent) { const s = x.nextSibling; if (s) return s; } return null; };
    const prev = (n) => { if (n === root) return null; const s = n.previousSibling; if (s) { let x = s; while (x._kids && x._kids.length) x = x._kids[x._kids.length - 1]; return x; } return n._parent; };
    const w = { root, whatToShow: what, filter, currentNode: root,
      nextNode() { for (let n = next(this.currentNode); n; n = next(n)) if (accept(n) === 1) { this.currentNode = n; return n; } return null; },
      previousNode() { for (let n = prev(this.currentNode); n; n = prev(n)) if (accept(n) === 1) { this.currentNode = n; return n; } return null; },
      parentNode() { for (let n = this.currentNode._parent; n && n !== root._parent; n = n._parent) if (accept(n) === 1) { this.currentNode = n; return n; } return null; },
      firstChild() { const k = this.currentNode._kids; if (k) for (const c of k) if (accept(c) === 1) { this.currentNode = c; return c; } return null; },
      lastChild() { const k = this.currentNode._kids; if (k) for (let i = k.length - 1; i >= 0; i--) if (accept(k[i]) === 1) { this.currentNode = k[i]; return k[i]; } return null; },
      nextSibling() { for (let n = this.currentNode.nextSibling; n; n = n.nextSibling) if (accept(n) === 1) { this.currentNode = n; return n; } return null; },
      previousSibling() { for (let n = this.currentNode.previousSibling; n; n = n.previousSibling) if (accept(n) === 1) { this.currentNode = n; return n; } return null; } };
    return w;
  };
  g.NodeFilter = { FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3, SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 1, SHOW_ATTRIBUTE: 2, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8, SHOW_COMMENT: 128, SHOW_DOCUMENT: 256, SHOW_DOCUMENT_TYPE: 512, SHOW_DOCUMENT_FRAGMENT: 1024, SHOW_PROCESSING_INSTRUCTION: 64 };
  g.TreeWalker = function () { throw new TypeError('Illegal constructor'); };
  g.NodeIterator = g.TreeWalker;

  // Range: enough for libraries that create one and read text or rects.
  S.createRange = function (doc) {
    const r = { startContainer: doc, startOffset: 0, endContainer: doc, endOffset: 0, collapsed: true, commonAncestorContainer: doc,
      setStart(n, o) { this.startContainer = n; this.startOffset = o; }, setEnd(n, o) { this.endContainer = n; this.endOffset = o; this.collapsed = false; },
      setStartBefore(n) { this.setStart(n._parent, 0); }, setStartAfter(n) { this.setStart(n._parent, 0); }, setEndBefore(n) { this.setEnd(n._parent, 0); }, setEndAfter(n) { this.setEnd(n._parent, 0); },
      selectNode(n) { this.startContainer = this.endContainer = this.commonAncestorContainer = n; }, selectNodeContents(n) { this.selectNode(n); }, collapse() { this.collapsed = true; },
      cloneContents() { return doc.createDocumentFragment(); }, deleteContents() {}, extractContents() { return doc.createDocumentFragment(); }, insertNode(n) { if (this.startContainer.nodeType === 1) this.startContainer.insertBefore(n, this.startContainer._kids[this.startOffset] || null); },
      surroundContents() {}, cloneRange() { return Object.assign({}, this); }, detach() {}, toString() { return this.startContainer.textContent || ''; },
      getBoundingClientRect() { return S.rect(null); }, getClientRects() { return []; },
      createContextualFragment(h) { const f = doc.createDocumentFragment(); S.setInnerHTML(f, h, 'body'); for (const s of S.descendants(f)) if (s._local === 'script') s._started = false; return f; },
      compareBoundaryPoints() { return 0; }, comparePoint() { return 0; }, isPointInRange() { return false; }, intersectsNode() { return false; } };
    return r;
  };
  g.Range = function () { return S.createRange(S.doc); };
  g.StaticRange = g.Range;

  g.DOMParser = class DOMParser {
    parseFromString(s, type) {
      const d = S.createDocument();
      const ops = JSON.parse(__host.parseDoc(String(s)));
      S.buildOps(d, ops, d, { attrs: (el) => { if (el._local === 'script') el._started = true; } });
      return d;
    }
  };
  g.XMLSerializer = class XMLSerializer { serializeToString(n) { return S.serialize(n); } };
})(globalThis);
