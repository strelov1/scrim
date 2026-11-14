// Lean DOM: nodes, events, selectors, serialization, mutation observers, custom elements.
// Designed for QuickJS: plain arrays for children, attributes as a small array, no live collections.
(function (g) {
  'use strict';
  const S = (g.__scrim = g.__scrim || {});
  S.gen = 0; // bumped on every mutation; invalidates the style cache
  const HTML_NS = 'http://www.w3.org/1999/xhtml', SVG_NS = 'http://www.w3.org/2000/svg', MATH_NS = 'http://www.w3.org/1998/Math/MathML';
  S.NS = { html: HTML_NS, svg: SVG_NS, math: MATH_NS };

  function DOMException(message, name) { const e = new Error(message); e.name = name || 'Error'; Object.setPrototypeOf(e, DOMException.prototype); return e; }
  DOMException.prototype = Object.create(Error.prototype);
  DOMException.prototype.constructor = DOMException;
  g.DOMException = DOMException;

  // ---------------------------------------------------------------- events
  class Event {
    constructor(type, init) {
      if (arguments.length === 0) throw new TypeError('Event: type required');
      init = init || {};
      this.type = String(type);
      this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.composed = !!init.composed;
      this.defaultPrevented = false; this.isTrusted = false; this.eventPhase = 0;
      this.target = null; this.currentTarget = null; this.srcElement = null;
      this.timeStamp = __host.now(); this._stop = false; this._stopImm = false; this._path = [];
    }
    preventDefault() { if (this.cancelable && !this._passive) this.defaultPrevented = true; }
    get returnValue() { return !this.defaultPrevented; } set returnValue(v) { if (!v) this.preventDefault(); }
    stopPropagation() { this._stop = true; }
    get cancelBubble() { return this._stop; } set cancelBubble(v) { if (v) this._stop = true; }
    stopImmediatePropagation() { this._stop = true; this._stopImm = true; }
    composedPath() { return this._path.slice(); }
    initEvent(type, bubbles, cancelable) { this.type = type; this.bubbles = !!bubbles; this.cancelable = !!cancelable; }
  }
  Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;
  const evCls = (name, Base, fields) => {
    const C = class extends Base {
      constructor(type, init) { super(type, init); init = init || {}; for (const k in fields) this[k] = init[k] !== undefined ? init[k] : fields[k]; }
    };
    Object.defineProperty(C, 'name', { value: name });
    g[name] = C; return C;
  };
  g.Event = Event;
  evCls('CustomEvent', Event, { detail: null });
  g.CustomEvent.prototype.initCustomEvent = function (t, b, c, d) { this.initEvent(t, b, c); this.detail = d; };
  const UIEvent = evCls('UIEvent', Event, { detail: 0, view: null, which: 0 });
  const mouse = { screenX: 0, screenY: 0, clientX: 0, clientY: 0, pageX: 0, pageY: 0, offsetX: 0, offsetY: 0, x: 0, y: 0, movementX: 0, movementY: 0,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, button: 0, buttons: 0, relatedTarget: null };
  const MouseEvent = evCls('MouseEvent', UIEvent, mouse);
  MouseEvent.prototype.getModifierState = function () { return false; };
  evCls('PointerEvent', MouseEvent, { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0 });
  evCls('WheelEvent', MouseEvent, { deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0 });
  evCls('DragEvent', MouseEvent, { dataTransfer: null });
  const KeyboardEvent = evCls('KeyboardEvent', UIEvent, { key: '', code: '', keyCode: 0, charCode: 0, location: 0, repeat: false, isComposing: false, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
  KeyboardEvent.prototype.getModifierState = function () { return false; };
  evCls('InputEvent', UIEvent, { data: null, inputType: '', isComposing: false, dataTransfer: null });
  evCls('FocusEvent', UIEvent, { relatedTarget: null });
  evCls('CompositionEvent', UIEvent, { data: '' });
  evCls('TouchEvent', UIEvent, { touches: [], targetTouches: [], changedTouches: [] });
  evCls('PopStateEvent', Event, { state: null });
  evCls('HashChangeEvent', Event, { oldURL: '', newURL: '' });
  evCls('PageTransitionEvent', Event, { persisted: false });
  evCls('SubmitEvent', Event, { submitter: null });
  evCls('ErrorEvent', Event, { message: '', filename: '', lineno: 0, colno: 0, error: null });
  evCls('PromiseRejectionEvent', Event, { promise: null, reason: undefined });
  evCls('ProgressEvent', Event, { lengthComputable: false, loaded: 0, total: 0 });
  evCls('MessageEvent', Event, { data: null, origin: '', lastEventId: '', source: null, ports: [] });
  evCls('StorageEvent', Event, { key: null, oldValue: null, newValue: null, url: '', storageArea: null });
  evCls('AnimationEvent', Event, { animationName: '', elapsedTime: 0, pseudoElement: '' });
  evCls('TransitionEvent', Event, { propertyName: '', elapsedTime: 0, pseudoElement: '' });
  evCls('ToggleEvent', Event, { oldState: '', newState: '' });
  evCls('ClipboardEvent', Event, { clipboardData: null });
  evCls('BeforeUnloadEvent', Event, {});

  S.reportError = function (e) {
    __host.log('error', (e && e.message ? e.message : String(e)) + (e && e.stack ? '\n' + e.stack : ''));
    try { if (g.dispatchEvent && !S._inError) { S._inError = true; g.dispatchEvent(new g.ErrorEvent('error', { message: String(e && e.message || e), error: e, cancelable: true })); } } catch (x) {}
    S._inError = false;
  };

  class EventTarget {
    constructor() { this._ls = null; }
    addEventListener(type, fn, opts) {
      if (!fn) return;
      const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      const once = !!(opts && typeof opts === 'object' && opts.once), passive = !!(opts && typeof opts === 'object' && opts.passive);
      const ls = this._ls || (this._ls = Object.create(null));
      const l = ls[type] || (ls[type] = []);
      if (l.some((e) => e.fn === fn && e.capture === capture)) return;
      const entry = { fn, capture, once, passive, removed: false };
      l.push(entry);
      if (opts && typeof opts === 'object' && opts.signal) opts.signal.addEventListener('abort', () => this.removeEventListener(type, fn, capture));
    }
    removeEventListener(type, fn, opts) {
      const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
      const l = this._ls && this._ls[type];
      if (!l) return;
      const i = l.findIndex((e) => e.fn === fn && e.capture === capture);
      if (i >= 0) { l[i].removed = true; l.splice(i, 1); }
    }
    dispatchEvent(ev) { return S.dispatch(this, ev); }
  }
  g.EventTarget = EventTarget;

  function invoke(ct, ev, phase) {
    const l = ct._ls && ct._ls[ev.type];
    if (!l || !l.length) return;
    ev.currentTarget = ct;
    for (const e of l.slice()) {
      if (e.removed) continue;
      if (phase === 1 && !e.capture) continue;
      if (phase === 3 && e.capture) continue;
      if (e.once) ct.removeEventListener(ev.type, e.fn, e.capture);
      ev._passive = e.passive;
      try {
        if (typeof e.fn === 'function') e.fn.call(ct, ev);
        else if (e.fn && typeof e.fn.handleEvent === 'function') e.fn.handleEvent(ev);
      } catch (x) { S.reportError(x); }
      ev._passive = false;
      if (ev._stopImm) break;
    }
  }

  // Composed parent for event paths: node -> parent / shadow host -> document -> window.
  function eventParent(n, ev) {
    if (n.nodeType === 11 && n.host) return ev.composed ? n.host : null;
    if (n.nodeType === 9) return ev.type === 'load' ? null : n.defaultView || null;
    return n._parent;
  }
  S.dispatch = function (target, ev) {
    if (ev._dispatching) throw DOMException('event already dispatching', 'InvalidStateError');
    ev._dispatching = true; ev._stop = false; ev._stopImm = false;
    const path = [], targets = [];
    let t = target, retarget = target;
    for (let n = target; n; n = eventParent(n, ev)) {
      path.push(n);
      if (n.nodeType === 11 && n.host) { targets.push(retarget); retarget = n.host; continue; }
      targets.push(retarget);
    }
    ev._path = path;
    ev.target = ev.srcElement = target;
    const act = ev.type === 'click' && S.findActivation ? S.findActivation(target, ev) : null;
    if (act && act.pre) act.pre();
    for (let i = path.length - 1; i > 0 && !ev._stop; i--) { ev.eventPhase = 1; ev.target = targets[i]; invoke(path[i], ev, 1); }
    if (!ev._stop) { ev.eventPhase = 2; ev.target = target; invoke(target, ev, 2); }
    if (ev.bubbles) for (let i = 1; i < path.length && !ev._stop; i++) { ev.eventPhase = 3; ev.target = targets[i]; invoke(path[i], ev, 3); }
    ev.eventPhase = 0; ev.currentTarget = null; ev.target = target; ev._dispatching = false;
    if (act) { if (ev.defaultPrevented) { if (act.cancel) act.cancel(); } else if (act.run) act.run(); }
    return !ev.defaultPrevented;
  };

  // ---------------------------------------------------------------- nodes
  const isContainer = (n) => n.nodeType === 1 || n.nodeType === 9 || n.nodeType === 11;
  function contains(a, b) { for (let n = b; n; n = n._parent) if (n === a) return true; return false; }
  function rootOf(n) { while (n._parent) n = n._parent; return n; }

  class Node extends EventTarget {
    get parentNode() { return this._parent; }
    get parentElement() { const p = this._parent; return p && p.nodeType === 1 ? p : null; }
    get childNodes() { return this._kids || (this._kids0 || (this._kids0 = [])); }
    get firstChild() { const k = this._kids; return k && k.length ? k[0] : null; }
    get lastChild() { const k = this._kids; return k && k.length ? k[k.length - 1] : null; }
    get nextSibling() { const p = this._parent; if (!p) return null; const k = p._kids; const i = k.indexOf(this); return k[i + 1] || null; }
    get previousSibling() { const p = this._parent; if (!p) return null; const k = p._kids; const i = k.indexOf(this); return i > 0 ? k[i - 1] : null; }
    get ownerDocument() { return this.nodeType === 9 ? null : this._doc; }
    get isConnected() { const r = rootOf(this); return r.nodeType === 9 || (r.nodeType === 11 && r.host ? r.host.isConnected : false); }
    hasChildNodes() { return !!(this._kids && this._kids.length); }
    contains(o) { return !!o && contains(this, o); }
    getRootNode(opts) { let r = rootOf(this); if (opts && opts.composed) while (r.nodeType === 11 && r.host) r = rootOf(r.host); return r; }
    isSameNode(o) { return this === o; }
    isEqualNode(o) { return !!o && S.serialize(this, true) === S.serialize(o, true); }
    compareDocumentPosition(o) {
      if (o === this) return 0;
      if (contains(this, o)) return 20; if (contains(o, this)) return 10;
      if (rootOf(this) !== rootOf(o)) return 33;
      // Tree order from the ancestor chains: compare the children of the closest common ancestor.
      const chain = (n) => { const c = []; for (; n; n = n._parent) c.push(n); return c.reverse(); };
      const a = chain(this), b = chain(o);
      let i = 0; while (a[i] === b[i]) i++;
      const sibs = a[i - 1]._kids;
      return sibs.indexOf(b[i]) > sibs.indexOf(a[i]) ? 4 : 2;
    }
    get textContent() {
      if (this.nodeType === 3 || this.nodeType === 8) return this._data;
      if (this.nodeType === 9) return null;
      let s = '';
      (function walk(n) { for (const c of n._kids) { if (c.nodeType === 3) s += c._data; else if (c.nodeType === 1) walk(c); } })(this);
      return s;
    }
    set textContent(v) {
      if (this.nodeType === 3 || this.nodeType === 8) { this.data = v; return; }
      if (this.nodeType === 9) return;
      S.replaceAll(this, v === null || v === '' || v === undefined ? null : this._doc.createTextNode(String(v)));
    }
    get nodeValue() { return this.nodeType === 3 || this.nodeType === 8 ? this._data : null; }
    set nodeValue(v) { if (this.nodeType === 3 || this.nodeType === 8) this.data = v; }
    appendChild(c) { return S.insert(this, c, null); }
    insertBefore(c, ref) { return S.insert(this, c, ref === undefined ? null : ref); }
    removeChild(c) {
      if (!c || c._parent !== this) throw DOMException('The node to be removed is not a child of this node.', 'NotFoundError');
      S.remove(c); return c;
    }
    replaceChild(n, old) {
      if (!old || old._parent !== this) throw DOMException('The node to be replaced is not a child of this node.', 'NotFoundError');
      if (n === old) return old;
      const next = old.nextSibling === n ? n.nextSibling : old.nextSibling;
      S.remove(old); S.insert(this, n, next); return old;
    }
    cloneNode(deep) { return S.clone(this, !!deep, this._doc || this); }
    normalize() {
      for (const c of this.childNodes.slice()) {
        if (c.nodeType === 3) { if (!c._data) S.remove(c); else { let n = c.nextSibling; while (n && n.nodeType === 3) { c._data += n._data; const x = n; n = n.nextSibling; S.remove(x); } } }
        else if (c.nodeType === 1) c.normalize();
      }
    }
    lookupNamespaceURI() { return null; }
    isDefaultNamespace(ns) { return ns === HTML_NS; }
  }
  Object.assign(Node, { ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4, PROCESSING_INSTRUCTION_NODE: 7, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10, DOCUMENT_FRAGMENT_NODE: 11,
    DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINS: 8, DOCUMENT_POSITION_CONTAINED_BY: 16 });
  Object.assign(Node.prototype, { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 });
  g.Node = Node;

  // ParentNode / ChildNode mixins.
  const toNode = (doc, a) => (typeof a === 'string' ? doc.createTextNode(a) : a);
  function nodesFrag(doc, args) {
    if (args.length === 1) return toNode(doc, args[0]);
    const f = doc.createDocumentFragment(); for (const a of args) f.appendChild(toNode(doc, a)); return f;
  }
  const parentMixin = {
    get children() { return this._kids.filter((c) => c.nodeType === 1); },
    get childElementCount() { let n = 0; for (const c of this._kids) if (c.nodeType === 1) n++; return n; },
    get firstElementChild() { for (const c of this._kids) if (c.nodeType === 1) return c; return null; },
    get lastElementChild() { for (let i = this._kids.length - 1; i >= 0; i--) if (this._kids[i].nodeType === 1) return this._kids[i]; return null; },
    append(...a) { if (a.length) this.appendChild(nodesFrag(this._doc || this, a)); },
    prepend(...a) { if (a.length) this.insertBefore(nodesFrag(this._doc || this, a), this.firstChild); },
    replaceChildren(...a) { S.replaceAll(this, a.length ? nodesFrag(this._doc || this, a) : null); },
    querySelector(s) { return S.qs(this, s, true)[0] || null; },
    querySelectorAll(s) { return S.nodeList(S.qs(this, s, false)); },
    getElementsByTagName(t) { t = String(t).toLowerCase(); return S.nodeList(S.descendants(this).filter((e) => t === '*' || e.localName.toLowerCase() === t)); },
    getElementsByTagNameNS(ns, t) { return this.getElementsByTagName(t); },
    getElementsByClassName(c) {
      const cs = String(c).split(/[ \t\n\f\r]+/).filter(Boolean);
      if (!cs.length) return S.nodeList([]);
      const fast = S.byClass(this, cs);
      if (fast) return S.nodeList(fast);
      return S.nodeList(S.descendants(this).filter((e) => { const set = S.classes(e); return !!set && cs.every((x) => set.has(x)); }));
    },
  };
  const childMixin = {
    remove() { if (this._parent) S.remove(this); },
    before(...a) { const p = this._parent; if (p && a.length) p.insertBefore(nodesFrag(this._doc, a), this); },
    after(...a) { const p = this._parent; if (p && a.length) p.insertBefore(nodesFrag(this._doc, a), this.nextSibling); },
    replaceWith(...a) { const p = this._parent; if (!p) return; const n = this.nextSibling; S.remove(this); if (a.length) p.insertBefore(nodesFrag(this._doc, a), n && n._parent === p ? n : null); },
    get nextElementSibling() { const p = this._parent; if (!p) return null; const k = p._kids; for (let i = k.indexOf(this) + 1; i < k.length; i++) if (k[i].nodeType === 1) return k[i]; return null; },
    get previousElementSibling() { const p = this._parent; if (!p) return null; const k = p._kids; for (let i = k.indexOf(this) - 1; i >= 0; i--) if (k[i].nodeType === 1) return k[i]; return null; },
  };
  const mix = (C, m) => { for (const k of Object.getOwnPropertyNames(m)) Object.defineProperty(C.prototype, k, Object.getOwnPropertyDescriptor(m, k)); };
  S.nodeList = (arr) => { arr.item = function (i) { return this[i] || null; }; return arr; };

  class CharacterData extends Node {
    get data() { return this._data; }
    set data(v) {
      v = v == null ? '' : String(v);
      const old = this._data; this._data = v; S.gen++;
      S.mutation('characterData', this, { oldValue: old });
    }
    get length() { return this._data.length; }
    appendData(s) { this.data = this._data + s; }
    substringData(o, c) { return this._data.substr(o, c); }
    insertData(o, s) { this.data = this._data.slice(0, o) + s + this._data.slice(o); }
    deleteData(o, c) { this.data = this._data.slice(0, o) + this._data.slice(o + c); }
    replaceData(o, c, s) { this.data = this._data.slice(0, o) + s + this._data.slice(o + c); }
  }
  mix(CharacterData, childMixin);
  g.CharacterData = CharacterData;
  class Text extends CharacterData {
    constructor(d) { super(); S.initNode(this, 3, '#text', S.doc); this._data = d === undefined ? '' : String(d); }
    get wholeText() { return this._data; }
    splitText(off) { const t = this._doc.createTextNode(this._data.slice(off)); this.data = this._data.slice(0, off); if (this._parent) this._parent.insertBefore(t, this.nextSibling); return t; }
    get assignedSlot() { return null; }
  }
  g.Text = Text;
  class Comment extends CharacterData { constructor(d) { super(); S.initNode(this, 8, '#comment', S.doc); this._data = d === undefined ? '' : String(d); } }
  g.Comment = Comment;
  class CDATASection extends Text {}
  g.CDATASection = CDATASection;
  class ProcessingInstruction extends CharacterData {}
  g.ProcessingInstruction = ProcessingInstruction;

  class DocumentFragment extends Node {
    constructor() { super(); S.initNode(this, 11, '#document-fragment', S.doc); this._kids = []; }
    getElementById(id) { id = String(id); const fast = S.byId(this, id); if (fast !== undefined) return fast; return S.descendants(this).find((e) => e.getAttribute('id') === id) || null; }
  }
  mix(DocumentFragment, parentMixin);
  g.DocumentFragment = DocumentFragment;
  class ShadowRoot extends DocumentFragment {
    get innerHTML() { return S.serializeChildren(this); }
    set innerHTML(h) { S.setInnerHTML(this, h, 'div'); }
    get activeElement() { const a = this._doc.activeElement; return a && contains(this, a) ? a : null; }
    get styleSheets() { return []; }
    get adoptedStyleSheets() { return this._adopted || []; } set adoptedStyleSheets(v) { this._adopted = v; }
    getSelection() { return null; }
  }
  g.ShadowRoot = ShadowRoot;

  class DocumentType extends Node {}
  mix(DocumentType, childMixin);
  g.DocumentType = DocumentType;

  S.initNode = function (n, type, name, doc) { n._ls = null; n.nodeType = type; n.nodeName = name; n._parent = null; n._doc = doc; n._kids = type === 1 || type === 9 || type === 11 ? [] : null; };

  // ---------------------------------------------------------------- attributes
  class Attr {
    constructor(name, value, el) { this.name = name; this._v = value; this.ownerElement = el || null; this.namespaceURI = null; this.prefix = null; }
    get localName() { return this.name; } get nodeName() { return this.name; } get nodeType() { return 2; }
    get value() { return this._v; } set value(v) { if (this.ownerElement) this.ownerElement.setAttribute(this.name, v); else this._v = String(v); }
    get nodeValue() { return this._v; } get textContent() { return this._v; } get specified() { return true; }
  }
  g.Attr = Attr;

  class DOMTokenList {
    constructor(el, attr) { this._el = el; this._a = attr; }
    _get() { return (this._el.getAttribute(this._a) || '').split(/[ \t\n\f\r]+/).filter(Boolean); }
    _set(l) { this._el.setAttribute(this._a, Array.from(new Set(l)).join(' ')); }
    get length() { return this._get().length; }
    get value() { return this._el.getAttribute(this._a) || ''; } set value(v) { this._el.setAttribute(this._a, v); }
    item(i) { return this._get()[i] || null; }
    contains(t) { return this._get().includes(t); }
    add(...t) { const l = this._get(); let ch = false; for (const x of t) if (!l.includes(x)) { l.push(x); ch = true; } if (ch || !this._el.hasAttribute(this._a)) this._set(l); }
    remove(...t) { const l = this._get(); const n = l.filter((x) => !t.includes(x)); if (n.length !== l.length) this._set(n); }
    toggle(t, force) { const has = this.contains(t); const want = force === undefined ? !has : !!force; if (want && !has) this.add(t); else if (!want && has) this.remove(t); return want; }
    replace(a, b) { const l = this._get(); const i = l.indexOf(a); if (i < 0) return false; l[i] = b; this._set(l); return true; }
    supports() { return true; }
    forEach(f, t) { this._get().forEach(f, t); }
    entries() { return this._get().entries(); } keys() { return this._get().keys(); } values() { return this._get().values(); }
    [Symbol.iterator]() { return this._get()[Symbol.iterator](); }
    toString() { return this.value; }
  }
  g.DOMTokenList = DOMTokenList;

  // ---------------------------------------------------------------- element
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'bgsound', 'frame', 'keygen']);
  S.VOID = VOID;
  class Element extends Node {
    get tagName() { return this._tag; }
    get localName() { return this._local; }
    get namespaceURI() { return this._ns; }
    get prefix() { return null; }
    get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; } set className(v) { this.setAttribute('class', v); }
    get classList() { return this._cl || (this._cl = new DOMTokenList(this, 'class')); }
    get slot() { return this.getAttribute('slot') || ''; } set slot(v) { this.setAttribute('slot', v); }
    get attributes() {
      const a = this._attrs.map((x) => { const at = new Attr(x[0], x[1], this); return at; });
      a.getNamedItem = (n) => a.find((x) => x.name === String(n).toLowerCase()) || null;
      a.item = (i) => a[i] || null;
      a.removeNamedItem = (n) => this.removeAttribute(n);
      a.setNamedItem = (at) => this.setAttribute(at.name, at.value);
      return a;
    }
    _norm(n) { n = String(n); return this._ns === HTML_NS ? n.toLowerCase() : n; }
    getAttribute(n) { n = this._norm(n); const a = this._attrs; for (let i = 0; i < a.length; i++) if (a[i][0] === n) return a[i][1]; return null; }
    getAttributeNS(ns, n) { return this.getAttribute(n); }
    hasAttribute(n) { return this.getAttribute(n) !== null; }
    hasAttributeNS(ns, n) { return this.hasAttribute(n); }
    hasAttributes() { return this._attrs.length > 0; }
    getAttributeNames() { return this._attrs.map((a) => a[0]); }
    getAttributeNode(n) { const v = this.getAttribute(n); return v === null ? null : new Attr(this._norm(n), v, this); }
    setAttribute(n, v) {
      n = this._norm(n); v = String(v);
      if (!/^[^\s"'>\/=]+$/.test(n)) throw DOMException("Failed to execute 'setAttribute': '" + n + "' is not a valid attribute name.", 'InvalidCharacterError');
      const a = this._attrs; let old = null, found = false;
      for (let i = 0; i < a.length; i++) if (a[i][0] === n) { old = a[i][1]; a[i][1] = v; found = true; break; }
      if (!found) a.push([n, v]);
      S.attrChanged(this, n, old, v);
    }
    setAttributeNS(ns, qn, v) { this.setAttribute(qn, v); }
    setAttributeNode(at) { this.setAttribute(at.name, at.value); }
    removeAttribute(n) {
      n = this._norm(n); const a = this._attrs;
      for (let i = 0; i < a.length; i++) if (a[i][0] === n) { const old = a[i][1]; a.splice(i, 1); S.attrChanged(this, n, old, null); return; }
    }
    removeAttributeNS(ns, n) { this.removeAttribute(n); }
    removeAttributeNode(at) { this.removeAttribute(at.name); return at; }
    toggleAttribute(n, force) { const has = this.hasAttribute(n); const want = force === undefined ? !has : !!force; if (want && !has) this.setAttribute(n, ''); else if (!want && has) this.removeAttribute(n); return want; }
    matches(s) { return S.matches(this, s); }
    webkitMatchesSelector(s) { return this.matches(s); }
    closest(s) { const sel = S.parseSel(s); for (let n = this; n && n.nodeType === 1; n = n._parent) if (S.matchList(n, sel, this)) return n; return null; }
    get innerHTML() { return S.serializeChildren(this.localName === 'template' ? this.content : this); }
    set innerHTML(h) { S.setInnerHTML(this.localName === 'template' ? this.content : this, h, this.localName); }
    get outerHTML() { return S.serialize(this); }
    set outerHTML(h) {
      const p = this._parent; if (!p) return;
      const f = this._doc.createDocumentFragment(); S.setInnerHTML(f, h, p.nodeType === 1 ? p.localName : 'body');
      p.replaceChild(f, this);
    }
    insertAdjacentHTML(pos, h) {
      const f = this._doc.createDocumentFragment();
      const ctx = /^(beforebegin|afterend)$/i.test(pos) ? (this._parent && this._parent.localName) || 'body' : this.localName;
      S.setInnerHTML(f, h, ctx);
      this.insertAdjacentElement(pos, f);
    }
    insertAdjacentElement(pos, el) {
      switch (String(pos).toLowerCase()) {
        case 'beforebegin': if (this._parent) this._parent.insertBefore(el, this); break;
        case 'afterbegin': this.insertBefore(el, this.firstChild); break;
        case 'beforeend': this.appendChild(el); break;
        case 'afterend': if (this._parent) this._parent.insertBefore(el, this.nextSibling); break;
      }
      return el;
    }
    insertAdjacentText(pos, t) { this.insertAdjacentElement(pos, this._doc.createTextNode(t)); }
    attachShadow(init) {
      if (this._shadow) throw DOMException('Shadow root cannot be created on a host which already hosts a shadow tree.', 'NotSupportedError');
      const r = Object.create(ShadowRoot.prototype);
      S.initNode(r, 11, '#document-fragment', this._doc);
      r.host = this; r.mode = (init && init.mode) || 'open'; r.delegatesFocus = !!(init && init.delegatesFocus);
      this._shadow = r; S.gen++;
      return r;
    }
    get shadowRoot() { return this._shadow && this._shadow.mode === 'open' ? this._shadow : null; }
    get assignedSlot() { return null; }
    getBoundingClientRect() { return S.rect(this); }
    getClientRects() { const r = S.rect(this); return r.width || r.height ? [r] : []; }
    scrollIntoView() {} scrollIntoViewIfNeeded() {} scrollTo() {} scrollBy() {} scroll() {}
    get scrollTop() { return 0; } set scrollTop(v) {} get scrollLeft() { return 0; } set scrollLeft(v) {}
    get scrollWidth() { return S.rect(this).width; } get scrollHeight() { return S.rect(this).height; }
    get clientWidth() { return this === this._doc.documentElement ? g.innerWidth : S.rect(this).width; }
    get clientHeight() { return this === this._doc.documentElement ? g.innerHeight : S.rect(this).height; }
    get clientTop() { return 0; } get clientLeft() { return 0; }
    checkVisibility(opts) { return S.isRendered ? S.isRendered(this, opts) : true; }
    animate() { const a = { finished: Promise.resolve(), cancel() {}, finish() {}, play() {}, pause() {}, reverse() {}, onfinish: null, playState: 'finished', addEventListener() {}, removeEventListener() {} }; Promise.resolve().then(() => { if (a.onfinish) a.onfinish({}); }); return a; }
    getAnimations() { return []; }
    requestFullscreen() { return Promise.reject(new Error('not supported')); }
    requestPointerLock() {} releasePointerCapture() {} setPointerCapture() {} hasPointerCapture() { return false; }
    computedStyleMap() { return new Map(); }
  }
  mix(Element, parentMixin);
  mix(Element, childMixin);
  g.Element = Element;
  S.Element = Element;

  // ---------------------------------------------------------------- tree mutation
  S.descendants = function (root) {
    const out = [];
    (function walk(n) { for (const c of n._kids) if (c.nodeType === 1) { out.push(c); walk(c); } })(root);
    return out;
  };
  S.preorder = function (root) { const out = [root]; (function walk(n) { if (n._kids) for (const c of n._kids) { out.push(c); walk(c); } })(root); return out; };

  function validateInsert(parent, node) {
    if (!node || typeof node !== 'object' || !(node instanceof Node)) throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
    if (!isContainer(parent)) throw DOMException('This node type does not support this method.', 'HierarchyRequestError');
    if (contains(node, parent)) throw DOMException('The new child element contains the parent.', 'HierarchyRequestError');
  }
  S.insert = function (parent, node, ref) {
    validateInsert(parent, node);
    if (ref && ref._parent !== parent) throw DOMException("Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.", 'NotFoundError');
    if (ref === node) ref = node.nextSibling;
    const nodes = node.nodeType === 11 ? node._kids.slice() : [node];
    if (node.nodeType === 11) { for (const c of nodes) c._parent = null; node._kids.length = 0; S.mutation('childList', node, { removed: nodes }); }
    for (const n of nodes) {
      if (n._parent) S.remove(n);
      const k = parent._kids;
      const i = ref ? k.indexOf(ref) : -1;
      if (i < 0) k.push(n); else k.splice(i, 0, n);
      n._parent = parent;
      if (n._doc !== (parent._doc || parent)) S.adopt(n, parent.nodeType === 9 ? parent : parent._doc);
    }
    S.gen++;
    if (S.ixAdd) for (const n of nodes) S.ixAdd(n);
    S.mutation('childList', parent, { added: nodes, next: ref });
    if (parent.isConnected) for (const n of nodes) S.connected(n);
    return node;
  };
  S.remove = function (n) {
    const p = n._parent; if (!p) return;
    if (S.ixRemove) S.ixRemove(n);
    const k = p._kids; const i = k.indexOf(n);
    const next = k[i + 1] || null;
    k.splice(i, 1); n._parent = null; S.gen++;
    const wasConnected = rootOf(p).nodeType === 9 || p.isConnected;
    S.mutation('childList', p, { removed: [n], next });
    if (wasConnected) S.disconnected(n);
    const d = (p._doc || p);
    if (d.nodeType === 9 && d._active && contains(n, d._active)) d._active = null;
  };
  S.replaceAll = function (parent, node) {
    for (const c of parent._kids.slice()) S.remove(c);
    if (node) S.insert(parent, node, null);
  };
  S.adopt = function (n, doc) { n._doc = doc; if (n._kids) for (const c of n._kids) S.adopt(c, doc); if (n._shadow) S.adopt(n._shadow, doc); if (n._content) S.adopt(n._content, doc); };
  // Fast append for the parser: no events, no observers.
  S.appendFast = function (parent, n) { parent._kids.push(n); n._parent = parent; if (S.ixAdd) S.ixAdd(n); };

  // Hooks on connect / disconnect (custom elements, scripts, iframes, stylesheets).
  S.connected = function (n) {
    if (n.nodeType !== 1) return;
    const stack = [n];
    while (stack.length) {
      const e = stack.pop();
      if (e.nodeType !== 1) continue;
      if (S.onConnect) S.onConnect(e);
      if (e._local.indexOf('-') > 0) S.ceConnected(e);
      if (e._shadow) for (let i = e._shadow._kids.length - 1; i >= 0; i--) stack.push(e._shadow._kids[i]);
      for (let i = e._kids.length - 1; i >= 0; i--) stack.push(e._kids[i]);
    }
  };
  S.disconnected = function (n) {
    if (n.nodeType !== 1) return;
    for (const e of [n].concat(S.descendants(n))) {
      if (S.onDisconnect) S.onDisconnect(e);
      const def = e._ceDef;
      if (def && def.disconnected) try { def.disconnected.call(e); } catch (x) { S.reportError(x); }
    }
  };
  S.attrChanged = function (el, name, old, val) {
    S.gen++;
    if ((name === 'id' || name === 'class') && S.ixAttr) S.ixAttr(el, name, old, val);
    S.mutation('attributes', el, { name, oldValue: old });
    if (el._cl === undefined) {}
    if (name === 'style' && el._styleDecl && !el._styleWriting) el._styleDecl._reparse();
    if (name.length > 2 && name[0] === 'o' && name[1] === 'n' && el._ns === HTML_NS) S.inlineHandler(el, name.slice(2), val);
    const def = el._ceDef;
    if (def && def.attrChanged && def.observed.includes(name)) try { def.attrChanged.call(el, name, old, val); } catch (x) { S.reportError(x); }
    if (S.onAttr) S.onAttr(el, name, old, val);
  };

  // Inline event handler attributes and on* properties share one listener slot per type.
  S.handlerSlot = function (target, type, fn) {
    const slots = target._onslots || (target._onslots = Object.create(null));
    if (!slots[type]) {
      slots[type] = { fn: null };
      const slot = slots[type];
      target.addEventListener(type, function (ev) {
        const f = slot.fn; if (!f) return;
        const r = f.call(this, ev);
        if (r === false && type !== 'mouseover') ev.preventDefault();
      });
    }
    slots[type].fn = fn;
  };
  S.inlineHandler = function (el, type, code) {
    if (code === null) { if (el._onslots && el._onslots[type]) el._onslots[type].fn = null; return; }
    let fn = null;
    try { fn = new Function('event', code); } catch (e) { S.reportError(e); }
    S.handlerSlot(el, type, fn);
  };

  // ---------------------------------------------------------------- mutation observers
  const observers = [];
  S.observers = observers;
  S.mutation = function (type, target, info) {
    if (!observers.length) return;
    for (const o of observers) {
      for (const reg of o._targets) {
        const t = reg.target, opt = reg.opts;
        if (t !== target && !(opt.subtree && contains(t, target))) continue;
        if (type === 'childList' && !opt.childList) continue;
        if (type === 'attributes' && !opt.attributes) continue;
        if (type === 'attributes' && opt.attributeFilter && !opt.attributeFilter.includes(info.name)) continue;
        if (type === 'characterData' && !opt.characterData) continue;
        o._records.push({ type, target, addedNodes: S.nodeList((info.added || []).slice()), removedNodes: S.nodeList((info.removed || []).slice()),
          previousSibling: null, nextSibling: info.next || null, attributeName: info.name || null, attributeNamespace: null,
          oldValue: (type === 'attributes' && opt.attributeOldValue) || (type === 'characterData' && opt.characterDataOldValue) ? info.oldValue : null });
        if (!o._scheduled) { o._scheduled = true; Promise.resolve().then(() => { o._scheduled = false; const r = o.takeRecords(); if (r.length) try { o._cb.call(o, r, o); } catch (x) { S.reportError(x); } }); }
        break;
      }
    }
  };
  class MutationObserver {
    constructor(cb) { this._cb = cb; this._targets = []; this._records = []; this._scheduled = false; }
    observe(target, opts) {
      opts = Object.assign({}, opts);
      if (opts.attributeOldValue || opts.attributeFilter) opts.attributes = true;
      if (opts.characterDataOldValue) opts.characterData = true;
      const ex = this._targets.find((r) => r.target === target);
      if (ex) ex.opts = opts; else this._targets.push({ target, opts });
      if (!observers.includes(this)) observers.push(this);
    }
    disconnect() { this._targets = []; this._records = []; const i = observers.indexOf(this); if (i >= 0) observers.splice(i, 1); }
    takeRecords() { const r = this._records; this._records = []; return r; }
  }
  g.MutationObserver = MutationObserver;
  g.WebKitMutationObserver = MutationObserver;

  // ---------------------------------------------------------------- custom elements
  const ceDefs = new Map(), ceByCtor = new Map(), ceWhen = new Map();
  S.ceDefs = ceDefs; S.ceByCtor = ceByCtor;
  S.ceUpgrade = function (el, def) {
    if (el._ceDef) return;
    Object.setPrototypeOf(el, def.ctor.prototype);
    S._upgrading = el;
    try { new def.ctor(); } catch (x) { S.reportError(x); } finally { S._upgrading = null; }
    el._ceDef = def;
    if (def.attrChanged) for (const [n, v] of el._attrs.slice()) if (def.observed.includes(n)) try { def.attrChanged.call(el, n, null, v); } catch (x) { S.reportError(x); }
  };
  S.ceConnected = function (el) {
    if (!el._ceDef) { const def = ceDefs.get(el._local); if (def && el._ns === HTML_NS) S.ceUpgrade(el, def); else return; }
    const def = el._ceDef;
    if (def && def.connected) try { def.connected.call(el); } catch (x) { S.reportError(x); }
  };
  g.customElements = {
    define(name, ctor, opts) {
      if (ceDefs.has(name)) throw DOMException("the name '" + name + "' has already been used with this registry", 'NotSupportedError');
      const p = ctor.prototype;
      const def = { name, ctor, connected: p.connectedCallback, disconnected: p.disconnectedCallback, attrChanged: p.attributeChangedCallback,
        observed: (ctor.observedAttributes ? Array.from(ctor.observedAttributes) : []).map(String), ext: opts && opts.extends };
      ceDefs.set(name, def); ceByCtor.set(ctor, def);
      const doc = S.doc;
      if (doc) {
        const all = [];
        (function walk(n) { for (const c of n._kids) if (c.nodeType === 1) { all.push(c); if (c._shadow) walk(c._shadow); walk(c); } })(doc);
        for (const el of all) if (el._local === name && !el._ceDef) { S.ceUpgrade(el, def); if (def.connected) try { def.connected.call(el); } catch (x) { S.reportError(x); } }
      }
      const w = ceWhen.get(name); if (w) { w.resolve(ctor); ceWhen.delete(name); }
    },
    get(name) { const d = ceDefs.get(name); return d ? d.ctor : undefined; },
    getName(ctor) { const d = ceByCtor.get(ctor); return d ? d.name : null; },
    whenDefined(name) {
      if (ceDefs.has(name)) return Promise.resolve(ceDefs.get(name).ctor);
      let w = ceWhen.get(name);
      if (!w) { w = {}; w.promise = new Promise((r) => { w.resolve = r; }); ceWhen.set(name, w); }
      return w.promise;
    },
    upgrade(root) { for (const el of S.descendants(root)) { const d = ceDefs.get(el._local); if (d) S.ceUpgrade(el, d); } },
  };

  // ---------------------------------------------------------------- selectors
  const selCache = new Map();
  function tokenizeSel(s) {
    // Returns a list of complex selectors; each is an array of {comb, compound}.
    let i = 0;
    const n = s.length;
    const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
    const isIdent = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c >= 160;
    const ws = () => { while (i < n && isWs(s.charCodeAt(i))) i++; };
    const ident = () => {
      let out = '';
      while (i < n) {
        const c = s[i];
        if (c === '\\') {
          i++;
          const hex = /^[0-9a-fA-F]{1,6}/.exec(s.slice(i));
          if (hex) { out += String.fromCodePoint(parseInt(hex[0], 16)); i += hex[0].length; if (s[i] === ' ') i++; }
          else out += s[i++];
        } else if (isIdent(s.charCodeAt(i))) { out += c; i++; } else break;
      }
      return out;
    };
    const until = (close) => {
      let depth = 1, start = i;
      while (i < n) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '"' || c === "'") { const q = c; i++; while (i < n && s[i] !== q) { if (s[i] === '\\') i++; i++; } i++; continue; }
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') { depth--; if (depth === 0) { const r = s.slice(start, i); i++; return r; } }
        i++;
      }
      throw new SyntaxError('bad selector ' + s);
    };
    const list = [];
    let complex = [], comb = ' ';
    const compound = () => {
      const c = { tag: null, id: null, cls: [], attrs: [], pseudo: [], pe: false };
      let any = false;
      if (s[i] === '*') { i++; any = true; }
      else if (i < n && (isIdent(s.charCodeAt(i)) || s[i] === '\\')) { c.tag = ident().toLowerCase(); any = true; }
      if (s[i] === '|') { i++; c.tag = s[i] === '*' ? (i++, null) : ident().toLowerCase(); }
      for (;;) {
        const ch = s[i];
        if (ch === '#') { i++; c.id = ident(); any = true; }
        else if (ch === '.') { i++; c.cls.push(ident()); any = true; }
        else if (ch === '[') {
          i++; const body = until(']');
          const m = /^\s*([^\s~|^$*!=]+)\s*(?:([~|^$*!]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]]+)))?\s*([iIsS])?\s*$/.exec(body);
          if (!m) throw new SyntaxError('bad attribute selector ' + body);
          const val = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
          c.attrs.push({ name: m[1].replace(/^.*\|/, '').replace(/\\(.)/g, '$1').toLowerCase(), op: m[2] || null, val: val === undefined ? null : val.replace(/\\(.)/g, '$1'), ci: m[6] === 'i' || m[6] === 'I' });
          any = true;
        } else if (ch === ':') {
          i++;
          if (s[i] === ':') { i++; ident(); if (s[i] === '(') { i++; until(')'); } c.pe = true; any = true; continue; }
          const name = ident().toLowerCase();
          let arg = null;
          if (s[i] === '(') { i++; arg = until(')'); }
          if (['before', 'after', 'first-line', 'first-letter', 'selection', 'placeholder', 'marker', 'backdrop'].includes(name)) c.pe = true;
          else c.pseudo.push({ name, arg });
          any = true;
        } else break;
      }
      if (!any) throw new SyntaxError("'" + s + "' is not a valid selector");
      return c;
    };
    ws();
    while (i < n) {
      complex.push({ comb, c: compound() });
      const before = i; ws();
      const ch = s[i];
      if (ch === ',') { i++; ws(); list.push(complex); complex = []; comb = ' '; continue; }
      if (ch === '>' || ch === '+' || ch === '~') { comb = ch; i++; ws(); continue; }
      if (i >= n) break;
      if (i > before) { comb = ' '; continue; }
      throw new SyntaxError("'" + s + "' is not a valid selector");
    }
    if (!complex.length) throw new SyntaxError("'" + s + "' is not a valid selector");
    list.push(complex);
    for (const cx of list) for (const part of cx) for (const p of part.c.pseudo) {
      if (['not', 'is', 'where', 'matches', '-webkit-any', '-moz-any', 'host', 'host-context'].includes(p.name) && p.arg != null) p.sel = parseSel(p.arg);
      else if (p.name === 'has') p.sel = parseSel(p.arg.replace(/^\s*([>+~])/, ':scope $1'));
      else if (/^nth-/.test(p.name)) {
        const m = /^\s*(.+?)(?:\s+of\s+(.+))?\s*$/.exec(p.arg || '');
        p.nth = parseNth(m ? m[1] : ''); if (m && m[2]) p.sel = parseSel(m[2]);
      } else if (!KNOWN_PSEUDO.has(p.name)) throw new SyntaxError("'" + s + "' is not a valid selector (:" + p.name + ')');
    }
    return list;
  }
  const KNOWN_PSEUDO = new Set(['root', 'scope', 'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'empty',
    'checked', 'disabled', 'enabled', 'focus', 'focus-within', 'focus-visible', 'hover', 'active', 'visited', 'link', 'any-link', 'target', 'defined',
    'required', 'optional', 'read-only', 'read-write', 'placeholder-shown', 'indeterminate', 'default', 'valid', 'invalid', 'in-range', 'out-of-range',
    'lang', 'dir', 'open', 'closed', 'modal', 'popover-open', 'fullscreen', 'autofill', '-webkit-autofill', 'playing', 'paused', 'user-invalid', 'user-valid', 'state', 'contains']);
  function parseNth(a) {
    a = a.replace(/\s+/g, '').toLowerCase();
    if (a === 'odd') return [2, 1]; if (a === 'even') return [2, 0];
    const m = /^([+-]?\d*)?n([+-]\d+)?$/.exec(a);
    if (m) return [m[1] === undefined || m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0];
    const v = parseInt(a, 10); if (isNaN(v)) throw new SyntaxError('bad nth ' + a); return [0, v];
  }
  function parseSel(s) {
    s = String(s);
    let r = selCache.get(s);
    if (!r) { r = tokenizeSel(s.trim()); selCache.set(s, r); }
    return r;
  }
  S.parseSel = parseSel;
  const nthOk = (nth, pos) => { const [a, b] = nth; if (a === 0) return pos === b; const k = (pos - b) / a; return Number.isInteger(k) && k >= 0; };
  function siblingsEls(el) { const p = el._parent; return p ? p._kids.filter((c) => c.nodeType === 1) : [el]; }
  function attrMatch(el, a) {
    let v = el.getAttribute(a.name);
    if (v === null) return false;
    if (!a.op) return true;
    let x = a.val;
    if (a.ci) { v = v.toLowerCase(); x = x.toLowerCase(); }
    switch (a.op) {
      case '=': return v === x;
      case '~=': return x !== '' && v.split(/\s+/).includes(x);
      case '|=': return v === x || v.startsWith(x + '-');
      case '^=': return x !== '' && v.startsWith(x);
      case '$=': return x !== '' && v.endsWith(x);
      case '*=': return x !== '' && v.includes(x);
      case '!=': return v !== x;
    }
    return false;
  }
  function pseudoMatch(el, p, scope) {
    switch (p.name) {
      case 'not': return !matchList(el, p.sel, scope);
      case 'is': case 'where': case 'matches': case '-webkit-any': case '-moz-any': return matchList(el, p.sel, scope);
      case 'has': return S.descendants(el).some((d) => matchList(d, p.sel, el)) || (p.arg.trim()[0] === '+' || p.arg.trim()[0] === '~' ? siblingsEls(el).some((d) => matchList(d, p.sel, el)) : false);
      case 'root': return el === el._doc.documentElement;
      case 'scope': return scope ? el === scope : el === el._doc.documentElement;
      case 'first-child': return siblingsEls(el)[0] === el;
      case 'last-child': { const s = siblingsEls(el); return s[s.length - 1] === el; }
      case 'only-child': return siblingsEls(el).length === 1;
      case 'first-of-type': return siblingsEls(el).find((x) => x._local === el._local) === el;
      case 'last-of-type': { const s = siblingsEls(el).filter((x) => x._local === el._local); return s[s.length - 1] === el; }
      case 'only-of-type': return siblingsEls(el).filter((x) => x._local === el._local).length === 1;
      case 'nth-child': { const s = siblingsEls(el).filter((x) => !p.sel || matchList(x, p.sel, scope)); const i = s.indexOf(el); return i >= 0 && nthOk(p.nth, i + 1); }
      case 'nth-last-child': { const s = siblingsEls(el).filter((x) => !p.sel || matchList(x, p.sel, scope)); const i = s.indexOf(el); return i >= 0 && nthOk(p.nth, s.length - i); }
      case 'nth-of-type': { const s = siblingsEls(el).filter((x) => x._local === el._local); return nthOk(p.nth, s.indexOf(el) + 1); }
      case 'nth-last-of-type': { const s = siblingsEls(el).filter((x) => x._local === el._local); return nthOk(p.nth, s.length - s.indexOf(el)); }
      case 'empty': return !el._kids.some((c) => c.nodeType === 1 || (c.nodeType === 3 && c._data.length));
      case 'checked': return (el._local === 'input' && (el.type === 'checkbox' || el.type === 'radio') && el.checked) || (el._local === 'option' && el.selected);
      case 'disabled': return S.isDisabled ? S.isDisabled(el) : el.hasAttribute('disabled');
      case 'enabled': return /^(input|button|select|textarea|option|optgroup|fieldset)$/.test(el._local) && !(S.isDisabled ? S.isDisabled(el) : el.hasAttribute('disabled'));
      case 'focus': return el._doc.activeElement === el;
      case 'focus-within': { const a = el._doc._active; return !!a && contains(el, a); }
      case 'link': case 'any-link': return (el._local === 'a' || el._local === 'area') && el.hasAttribute('href');
      case 'target': { const h = g.location && g.location.hash; return !!h && el.id === decodeURIComponent(h.slice(1)); }
      case 'defined': return el._local.indexOf('-') < 0 || !!el._ceDef;
      case 'required': return el.hasAttribute('required');
      case 'optional': return /^(input|select|textarea)$/.test(el._local) && !el.hasAttribute('required');
      case 'read-only': return !/^(input|textarea)$/.test(el._local) || el.hasAttribute('readonly') || el.hasAttribute('disabled');
      case 'read-write': return /^(input|textarea)$/.test(el._local) && !el.hasAttribute('readonly') && !el.hasAttribute('disabled');
      case 'placeholder-shown': return el.hasAttribute('placeholder') && !el.value;
      case 'open': return el.hasAttribute('open');
      case 'closed': return !el.hasAttribute('open');
      case 'lang': { for (let n = el; n && n.nodeType === 1; n = n._parent) { const l = n.getAttribute('lang'); if (l !== null) return l.toLowerCase().startsWith(String(p.arg).toLowerCase()); } return false; }
      case 'invalid': case 'user-invalid': return !!(el.checkValidity && !el.checkValidity());
      case 'valid': case 'user-valid': return !el.checkValidity || el.checkValidity();
      case 'in-range': return true;
      case 'default': return (el._local === 'option' && el.hasAttribute('selected')) || (el.hasAttribute && el.hasAttribute('checked'));
      case 'host': return false;
      case 'dir': return String(p.arg).trim() === 'ltr';
      default: return false; // hover, active, visited, focus-visible, modal, popover-open, ...
    }
  }
  // Class set per element, recomputed only when the class attribute string changes.
  // Attribute lookup for internal callers: names are already lowercase.
  S.attr = function (el, n) { const a = el._attrs; for (let i = 0; i < a.length; i++) if (a[i][0] === n) return a[i][1]; return null; };
  S.classes = function (el) {
    const k = S.attr(el, 'class');
    if (k === null) return null;
    if (el._clsKey !== k) { el._clsKey = k; el._clsSet = new Set(k.split(/[ \t\n\f\r]+/)); }
    return el._clsSet;
  };
  function compoundMatch(el, c, scope) {
    if (c.pe) return false;
    if (c.tag && c.tag !== '*' && el._local.toLowerCase() !== c.tag) return false;
    if (c.id !== null && S.attr(el, 'id') !== c.id) return false;
    if (c.cls.length) {
      const parts = S.classes(el); if (!parts) return false;
      for (const x of c.cls) if (!parts.has(x)) return false;
    }
    for (const a of c.attrs) if (!attrMatch(el, a)) return false;
    for (const p of c.pseudo) if (!pseudoMatch(el, p, scope)) return false;
    return true;
  }
  function matchComplex(el, cx, idx, scope) {
    if (!compoundMatch(el, cx[idx].c, scope)) return false;
    if (idx === 0) return true;
    const comb = cx[idx].comb;
    if (comb === '>') { const p = el._parent; return !!p && p.nodeType === 1 && matchComplex(p, cx, idx - 1, scope); }
    if (comb === ' ') { for (let p = el._parent; p && p.nodeType === 1; p = p._parent) if (matchComplex(p, cx, idx - 1, scope)) return true; return false; }
    const sibs = siblingsEls(el); const i = sibs.indexOf(el);
    if (comb === '+') return i > 0 && matchComplex(sibs[i - 1], cx, idx - 1, scope);
    if (comb === '~') { for (let j = i - 1; j >= 0; j--) if (matchComplex(sibs[j], cx, idx - 1, scope)) return true; return false; }
    return false;
  }
  function matchList(el, list, scope) { for (const cx of list) if (matchComplex(el, cx, cx.length - 1, scope)) return true; return false; }
  S.matchList = matchList;
  S.matchComplex = matchComplex;
  S.matches = (el, s) => matchList(el, parseSel(s), el);
  // Per-document index for selector lookups: element sets by id, class and tag. Built on the
  // first lookup, then kept current by insert/remove/attribute hooks, so a page that alternates
  // DOM changes and queries (MediaWiki, jQuery) never rescans the whole document.
  const KINDS = ['ids', 'cls', 'tags'];
  const ixKeys = (e, kind, f) => {
    if (kind === 'ids') { const id = S.attr(e, 'id'); if (id !== null && id !== '') f(id); }
    else if (kind === 'cls') { const cl = S.classes(e); if (cl) for (const c of cl) if (c) f(c); }
    else f(e._lower || (e._lower = e._local.toLowerCase()));
  };
  const ixPut = (m, key, e) => { const set = m.get(key); if (set) set.add(e); else m.set(key, new Set([e])); };
  const ixDel = (m, key, e) => { const set = m.get(key); if (set) { set.delete(e); if (!set.size) m.delete(key); } };
  const eachEl = (n, f) => { if (n.nodeType !== 1) return; const st = [n]; while (st.length) { const e = st.pop(); if (e.nodeType !== 1) continue; f(e); const k = e._kids; for (let i = k.length - 1; i >= 0; i--) st.push(k[i]); } };
  /** The document a node is connected to, or null (detached trees, fragments, shadow roots). */
  function indexedDoc(n) {
    if (n.nodeType === 9) return n;
    if (n.nodeType !== 1) return null;
    let r = n; while (r._parent) r = r._parent;
    return r.nodeType === 9 ? r : null;
  }
  /** One map of the document index (ids, cls or tags), built on first use. */
  function ixMap(d, kind) {
    const ix = d._ix || (d._ix = {});
    if (ix[kind]) return ix[kind];
    const m = new Map();
    for (const c of d._kids) eachEl(c, (e) => ixKeys(e, kind, (key) => ixPut(m, key, e)));
    return (ix[kind] = m);
  }
  S.docIndex = (d) => { for (const k of KINDS) ixMap(d, k); return d._ix; };
  const ixEach = (n, f) => { if (n.nodeType !== 1) return; const d = indexedDoc(n); if (!d || !d._ix) return; for (const kind of KINDS) { const m = d._ix[kind]; if (m) eachEl(n, (e) => ixKeys(e, kind, (key) => f(m, key, e))); } };
  S.ixAdd = (n) => ixEach(n, ixPut);
  S.ixRemove = (n) => ixEach(n, ixDel);
  S.ixAttr = function (el, name, old, val) {
    const d = indexedDoc(el); if (!d || !d._ix) return;
    if (name === 'id') { const m = d._ix.ids; if (!m) return; if (old) ixDel(m, old, el); if (val) ixPut(m, val, el); return; }
    const m = d._ix.cls; if (!m) return;
    const before = new Set(old ? old.split(/[ \t\n\f\r]+/).filter(Boolean) : []), after = new Set(val ? val.split(/[ \t\n\f\r]+/).filter(Boolean) : []);
    for (const c of before) if (!after.has(c)) ixDel(m, c, el);
    for (const c of after) if (!before.has(c)) ixPut(m, c, el);
  };
  const within = (el, root) => { if (root.nodeType === 9) return true; for (let p = el._parent; p; p = p._parent) if (p === root) return true; return false; };
  /** Sort elements of one document into tree order (path of child indices from the root). */
  function treeOrder(els) {
    if (els.length < 2) return els;
    const path = new Map();
    for (const e of els) { const p = []; for (let n = e; n._parent; n = n._parent) p.push(n._parent._kids.indexOf(n)); path.set(e, p.reverse()); }
    return els.sort((a, b) => { const x = path.get(a), y = path.get(b); for (let i = 0; i < x.length && i < y.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; });
  }
  const MAX_CANDIDATES = 400;
  /** Elements one complex selector can match, from the index: the rightmost compound's id/class/tag
   *  set, or every descendant of an ancestor compound's id/class set when that is smaller (only across
   *  descendant and child combinators). Null when nothing indexable narrows it enough. */
  function complexCandidates(d, cx) {
    let best = null, bestJ = -1, bestSize = Infinity;
    for (let j = cx.length - 1; j >= 0; j--) {
      if (j < cx.length - 1 && cx[j + 1].comb !== ' ' && cx[j + 1].comb !== '>') break;
      const c = cx[j].c;
      const set = c.id !== null ? ixMap(d, 'ids').get(c.id) : c.cls.length ? ixMap(d, 'cls').get(c.cls[0]) : j === cx.length - 1 && c.tag && c.tag !== '*' ? ixMap(d, 'tags').get(c.tag) : undefined;
      if (set === undefined && !(c.id !== null || c.cls.length || (j === cx.length - 1 && c.tag && c.tag !== '*'))) continue;
      const size = set ? set.size : 0;
      if (size < bestSize) { best = set; bestJ = j; bestSize = size; }
      if (size === 0) break;
    }
    if (bestJ < 0 || bestSize > MAX_CANDIDATES) return null;
    if (!best) return { els: [], ordered: true };
    if (bestJ === cx.length - 1) return { els: [...best], ordered: false };
    // Descendants of the ancestor matches, already in tree order (nested matches are skipped:
    // their subtrees are inside an outer one).
    const roots = treeOrder([...best]).filter((a, i, arr) => !arr.some((b, k) => k < i && within(a, b)));
    const out = [];
    for (const a of roots) for (const k of a._kids) { eachEl(k, (e) => out.push(e)); if (out.length > MAX_DESCENDANTS) return null; }
    return { els: out, ordered: true };
  }
  const MAX_DESCENDANTS = 2000;
  function candidates(d, list) {
    if (list.length === 1) { const c = complexCandidates(d, list[0]); return c && (c.ordered ? c.els : treeOrder(c.els)); }
    const all = new Set();
    for (const cx of list) { const c = complexCandidates(d, cx); if (!c) return null; for (const e of c.els) all.add(e); }
    return all.size > MAX_CANDIDATES ? null : treeOrder([...all]);
  }
  S.byClass = function (root, cs) {
    const d = indexedDoc(root); if (!d) return null;
    const set = ixMap(d, 'cls').get(cs[0]); if (!set) return [];
    if (set.size > MAX_CANDIDATES) return null;
    return treeOrder([...set].filter((e) => e !== root && within(e, root) && cs.every((x) => S.classes(e).has(x))));
  };
  S.byId = function (root, id) {
    const d = indexedDoc(root); if (!d) return undefined;
    const set = ixMap(d, 'ids').get(id); if (!set) return null;
    const hits = [...set].filter((e) => e !== root && within(e, root));
    return treeOrder(hits)[0] || null;
  };
  S.qs = function (root, s, first) {
    const list = parseSel(s);
    const scope = root.nodeType === 1 ? root : null;
    const out = [];
    const d = indexedDoc(root);
    if (d) {
      const cands = candidates(d, list);
      if (cands) {
        for (const k of cands) if (k !== root && within(k, root) && matchList(k, list, scope)) { out.push(k); if (first) break; }
        return out;
      }
    }
    // Fast path: plain #id
    if (list.length === 1 && list[0].length === 1) {
      const c = list[0][0].c;
      if (c.id && !c.tag && !c.cls.length && !c.attrs.length && !c.pseudo.length) {
        const walk = (n) => { for (const k of n._kids) if (k.nodeType === 1) { if (k.getAttribute('id') === c.id) { out.push(k); if (first) return true; } if (walk(k)) return true; } return false; };
        walk(root); return out;
      }
    }
    const walk = (n) => {
      for (const k of n._kids) if (k.nodeType === 1) {
        if (matchList(k, list, scope)) { out.push(k); if (first) return true; }
        if (walk(k)) return true;
      }
      return false;
    };
    walk(root);
    return out;
  };

  // ---------------------------------------------------------------- serialization
  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');
  const RAW = new Set(['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'noscript']);
  S.serialize = function (n) {
    if (n.nodeType === 3) return n._parent && n._parent.nodeType === 1 && RAW.has(n._parent._local) ? n._data : escText(n._data);
    if (n.nodeType === 8) return '<!--' + n._data + '-->';
    if (n.nodeType === 9 || n.nodeType === 11) return S.serializeChildren(n);
    if (n.nodeType !== 1) return '';
    const tag = n._ns === HTML_NS ? n._local : n._local;
    let s = '<' + tag;
    for (const [k, v] of n._attrs) s += ' ' + k + '="' + escAttr(v) + '"';
    s += '>';
    if (n._ns === HTML_NS && VOID.has(n._local)) return s;
    s += S.serializeChildren(n._local === 'template' && n._content ? n._content : n);
    return s + '</' + tag + '>';
  };
  S.serializeChildren = function (n) { let s = ''; for (const c of n._kids) s += S.serialize(c); return s; };

  // Build nodes from the host parser's op stream.
  S.buildOps = function (parent, ops, doc, hooks) {
    const stack = [parent];
    let cur = parent;
    for (let i = 0; i < ops.length;) {
      const op = ops[i++];
      if (op === 1 || op === 2) {
        const ns = op === 1 ? HTML_NS : (S.NS[ops[i++]] || HTML_NS);
        const tag = ops[i++], attrs = ops[i++];
        const el = S.createElement(doc, ns, tag, true);
        for (let k = 0; k < attrs.length; k += 2) el._attrs.push([attrs[k], attrs[k + 1]]);
        if (hooks && hooks.attrs) hooks.attrs(el);
        const target = cur._local === 'template' && cur._content ? cur._content : cur;
        S.appendFast(target, el);
        stack.push(el); cur = el;
      } else if (op === 0) {
        const el = stack.pop(); cur = stack[stack.length - 1];
        if (hooks && hooks.close) hooks.close(el);
      } else {
        const data = ops[i++];
        const target = cur._local === 'template' && cur._content ? cur._content : cur;
        const t = Object.create(op === 3 ? Text.prototype : Comment.prototype);
        S.initNode(t, op, op === 3 ? '#text' : '#comment', doc);
        t._data = data;
        S.appendFast(target, t);
      }
    }
  };
  S.setInnerHTML = function (container, html, ctxTag) {
    const doc = container._doc || container;
    const frag = Object.create(DocumentFragment.prototype); S.initNode(frag, 11, '#document-fragment', doc);
    const ops = JSON.parse(__host.parseFrag(String(html == null ? '' : html), ctxTag || 'div'));
    S.buildOps(frag, ops, doc, { attrs: (el) => { if (el._local === 'script') el._started = true; for (const [k, v] of el._attrs) if (k.length > 2 && k[0] === 'o' && k[1] === 'n') S.inlineHandler(el, k.slice(2), v); } });
    S.replaceAll(container, frag._kids.length ? frag : null);
  };

  S.clone = function (n, deep, doc) {
    let c;
    if (n.nodeType === 1) {
      c = S.createElement(doc, n._ns, n._local, false);
      for (const [k, v] of n._attrs) c._attrs.push([k, v]);
      for (const [k] of n._attrs) if (k.length > 2 && k[0] === 'o' && k[1] === 'n') S.inlineHandler(c, k.slice(2), n.getAttribute(k));
      if (S.cloneExtra) S.cloneExtra(n, c);
      if (n._local === 'template' && n._content && deep) for (const k of n._content._kids) S.appendFast(c._content, S.clone(k, true, doc));
    } else if (n.nodeType === 3 || n.nodeType === 8) {
      c = Object.create(n.nodeType === 3 ? Text.prototype : Comment.prototype); S.initNode(c, n.nodeType, n.nodeName, doc); c._data = n._data;
    } else if (n.nodeType === 11) {
      c = Object.create(DocumentFragment.prototype); S.initNode(c, 11, '#document-fragment', doc);
    } else if (n.nodeType === 9) {
      c = S.createDocument(); doc = c;
    } else { c = Object.create(Object.getPrototypeOf(n)); Object.assign(c, n); c._parent = null; return c; }
    if (deep && n._kids) for (const k of n._kids) S.appendFast(c, S.clone(k, true, doc));
    return c;
  };
})(globalThis);
