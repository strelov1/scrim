// What an agent sees and does: visible text, markdown, an accessibility-style snapshot with refs,
// locators (role+name, label, text, css, ref) and actions (click, fill, select, press, scroll).
(function (g) {
  'use strict';
  const S = g.__scrim, doc = S.doc;
  const norm = (s) => String(s == null ? '' : s).replace(/[ \t\n\r\f]+/g, ' ').trim();

  // ---------------------------------------------------------------- visible text (innerText rules)
  const BLOCKISH = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'table-caption', 'flow-root', 'table-row-group', 'table-header-group', 'table-footer-group']);
  const NO_TEXT = new Set(['input', 'textarea', 'select', 'img', 'video', 'audio', 'canvas', 'svg', 'object', 'embed', 'math', 'meter', 'progress']);
  function kidsOf(el) {
    if (el._shadow) {
      const out = [];
      const expand = (n) => {
        for (const c of n._kids) {
          if (c.nodeType === 1 && c._local === 'slot') {
            const name = c.getAttribute('name') || '';
            const assigned = el._kids.filter((k) => (k.nodeType === 1 ? (k.getAttribute('slot') || '') === name : name === '' && k.nodeType === 3));
            if (assigned.length) out.push(...assigned); else expand(c);
          } else out.push(c);
        }
      };
      expand(el._shadow);
      return out;
    }
    if (el._local === 'details' && !el.hasAttribute('open') && el._ns === S.NS.html) return el._kids.filter((c) => c.nodeType === 1 && c._local === 'summary').slice(0, 1);
    return el._kids;
  }
  function collect(n, out, vis, pre) {
    if (n.nodeType === 3) {
      if (!vis) return;
      let t = n._data;
      if (!pre) t = t.replace(/[ \t\n\r\f]+/g, ' ');
      if (t) out.push(t);
      return;
    }
    if (n.nodeType !== 1) return;
    const c = S.computed(n);
    if (c.display === 'none') return;
    const t = n._local;
    const v = c.visibility === 'visible';
    if (t === 'br') { if (v) out.push('\n'); return; }
    if (t === 'iframe') { if (n._frameIdx) { out.push(1); out.push('\u0001F' + n._frameIdx + '\u0001'); out.push(1); } return; }
    if (t === 'select' && n._ns === S.NS.html) {
      // Chrome's innerText lists every option of a select on its own line.
      if (!v) return;
      out.push(1);
      for (const o of n.options) { const x = o.text; if (x) { out.push(x); out.push(1); } }
      return;
    }
    if (NO_TEXT.has(t) && n._ns === S.NS.html) return;
    if (n._ns === S.NS.svg && t !== 'svg' && t !== 'text' && t !== 'tspan' && t !== 'a' && t !== 'g' && t !== 'foreignObject') return;
    let breaks = 0;
    if (t === 'p') breaks = 2;
    else if (BLOCKISH.has(c.display)) breaks = 1;
    if (c.display === 'table-cell' && v) {
      const p = n._parent;
      if (p && p.nodeType === 1) for (const k of p._kids) { if (k === n) break; if (k.nodeType === 1 && S.computed(k).display === 'table-cell') { out.push('\t'); break; } }
    }
    if (breaks) out.push(breaks);
    let isPre = pre || t === 'pre' || t === 'listing' || t === 'xmp' || t === 'plaintext';
    if (!isPre) { const st = n.getAttribute('style'); if (st && /white-space\s*:\s*pre/i.test(st)) isPre = true; }
    for (const k of kidsOf(n)) collect(k, out, v, isPre);
    if (c.display === 'table-row') out.push(1);
    if (breaks) out.push(breaks);
  }
  function joinText(out) {
    // Linear: pieces go to an array; only the last character is inspected.
    const parts = [];
    let want = 0, started = false, last = '';
    for (const x of out) {
      if (typeof x === 'number') { if (started) want = Math.max(want, x); continue; }
      if (x === '\n') { parts.push('\n'); last = '\n'; continue; }
      let piece = x;
      if (want || last === '\n' || last === '') piece = piece.replace(/^ +/, '');
      else if (last === ' ' && piece[0] === ' ') piece = piece.slice(1);
      if (!piece) continue;
      if (want) {
        if (last === ' ') { const p = parts[parts.length - 1]; parts[parts.length - 1] = p.replace(/ +$/, ''); }
        parts.push('\n'.repeat(want)); want = 0;
      }
      parts.push(piece); started = true; last = piece[piece.length - 1];
    }
    return parts.join('').replace(/ +\n/g, '\n').trim();
  }
  S.renderText = function (root) { S.styleTree(); const out = []; collect(root, out, S.computed(root).visibility === 'visible', false); return joinText(out); };
  S.innerText = function (el) { if (!el.isConnected || !S.isRendered(el)) return el.textContent; return S.renderText(el); };

  // ---------------------------------------------------------------- accessibility: role and name
  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox', password: 'textbox' };
  function role(el) {
    const r = el.getAttribute('role');
    if (r) return r.trim().split(/\s+/)[0];
    switch (el._local) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : '';
      case 'button': return 'button';
      case 'input': { const ty = el.type; if (ty === 'hidden') return ''; if ((ty === 'text' || ty === 'search' || ty === 'email' || ty === 'tel' || ty === 'url') && el.hasAttribute('list')) return 'combobox'; return INPUT_ROLES[ty] || 'textbox'; }
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'option': return 'option';
      case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return 'banner';
      case 'footer': return 'contentinfo';
      case 'aside': return 'complementary';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'form': return 'form';
      case 'dialog': return 'dialog';
      case 'summary': return 'button';
      case 'fieldset': return 'group';
      case 'details': return 'group';
      case 'progress': return 'progressbar';
      case 'meter': return 'meter';
      case 'hr': return 'separator';
      case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
      case 'article': return 'article';
      case 'p': return 'paragraph';
      default: return '';
    }
  }
  const isNameFromContent = (r) => /^(button|link|heading|tab|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|radio|switch|treeitem|cell|columnheader|rowheader|row|tooltip|gridcell|listitem|term|legend|caption|sectionhead)$/.test(r);
  function textAlt(n, skip, depth) {
    if (depth > 20) return '';
    let s = '';
    for (const c of kidsOf(n)) {
      if (c.nodeType === 3) { s += c._data; continue; }
      if (c.nodeType !== 1 || c === skip) continue;
      if (c._local === 'style' || c._local === 'script' || c._local === 'template') continue;
      if (!S.isRendered(c, { visibilityProperty: true })) continue;
      if (c.getAttribute('aria-hidden') === 'true') continue;
      const al = c.getAttribute('aria-label');
      if (al && norm(al)) { s += ' ' + al + ' '; continue; }
      if (c._local === 'img') { s += ' ' + (c.getAttribute('alt') || '') + ' '; continue; }
      if (c._local === 'input' && /^(text|search|email|tel|url|number)$/.test(c.type)) { s += ' ' + c.value + ' '; continue; }
      if (c._local === 'select') { const o = c.options.find((x) => x.selected); s += ' ' + (o ? o.text : '') + ' '; continue; }
      if (c._local === 'textarea' || c._local === 'input') continue;
      const d = S.computed(c).display;
      const inl = /^inline/.test(d);
      s += (inl ? '' : ' ') + textAlt(c, skip, depth + 1) + (inl ? '' : ' ');
    }
    return s;
  }
  function byIds(el, attr) {
    const ids = el.getAttribute(attr); if (!ids) return null;
    const root = el.getRootNode();
    const parts = ids.split(/\s+/).map((id) => { const t = root.getElementById ? root.getElementById(id) : doc.getElementById(id); return t ? (t.getAttribute('aria-label') || textAlt(t, null, 0)) : ''; });
    return norm(parts.join(' '));
  }
  function accName(el) {
    const lb = byIds(el, 'aria-labelledby'); if (lb) return lb;
    const al = el.getAttribute('aria-label'); if (al && norm(al)) return norm(al);
    const t = el._local;
    if (/^(input|select|textarea|meter|progress)$/.test(t) && !(t === 'input' && /^(button|submit|reset|image)$/.test(el.type))) {
      const labels = [];
      const id = el.getAttribute('id');
      if (id) { const root = el.getRootNode(); for (const l of S.descendants(root)) if (l._local === 'label' && l.getAttribute('for') === id) labels.push(l); }
      const wrap = el.closest('label'); if (wrap && !labels.includes(wrap) && !wrap.hasAttribute('for')) labels.push(wrap);
      if (labels.length) return norm(labels.map((l) => textAlt(l, el, 0)).join(' '));
      return norm(el.getAttribute('title') || el.getAttribute('placeholder') || '');
    }
    if (t === 'input') { if (el.type === 'image') return norm(el.getAttribute('alt') || el.getAttribute('value') || 'Submit'); return norm(el.getAttribute('value') || { submit: 'Submit', reset: 'Reset' }[el.type] || ''); }
    if (t === 'img') return norm(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (t === 'fieldset') { const lg = el.children.find((c) => c._local === 'legend'); return lg ? norm(textAlt(lg, null, 0)) : ''; }
    if (t === 'table') { const cap = el.children.find((c) => c._local === 'caption'); if (cap) return norm(textAlt(cap, null, 0)); }
    if (t === 'svg') { const ti = el.children.find((c) => c._local === 'title'); if (ti) return norm(ti.textContent); }
    const r = role(el);
    if (isNameFromContent(r) || (!r && el.closest && false)) { const n = norm(textAlt(el, null, 0)); if (n) return n; }
    return norm(el.getAttribute('title') || '');
  }
  S.role = role; S.accName = accName;

  // ---------------------------------------------------------------- locators
  function* walkAll(root) {
    for (const c of root._kids) {
      if (c.nodeType !== 1) continue;
      yield c;
      if (c._shadow) yield* walkAll(c._shadow);
      yield* walkAll(c);
    }
  }
  const visible = (el) => S.isRendered(el, { visibilityProperty: true }) && !el.closest('[aria-hidden="true"]');
  function find(loc) {
    S.styleTree();
    if (loc.ref) { const id = Number(String(loc.ref).replace(/^e/, '')); for (const el of walkAll(doc)) if (el._nid === id) return el; return null; }
    if (loc.css) { try { return doc.querySelector(loc.css); } catch (e) { return null; } }
    let best = null;
    const want = loc.name !== undefined ? norm(loc.name) : loc.label !== undefined ? norm(loc.label) : null;
    const txt = loc.text !== undefined ? norm(loc.text) : null;
    for (const el of walkAll(doc)) {
      if (loc.role) { if (role(el) === loc.role && visible(el) && (want === null || accName(el) === want)) return el; continue; }
      if (loc.label !== undefined) { if (role(el) && /^(textbox|searchbox|combobox|listbox|checkbox|radio|spinbutton|slider|switch)$/.test(role(el)) && visible(el) && accName(el) === want) return el; continue; }
      if (txt !== null) {
        if (best && !best.contains(el) && !(best._shadow && best._shadow.contains(el))) break;
        if (/^(script|style|html|head|body|title|template|noscript)$/.test(el._local)) continue;
        if (norm(el.textContent).includes(txt) && visible(el)) best = el;
      }
    }
    if (txt === null && loc.label !== undefined) {
      // Fallback: any element whose name is the label (e.g. aria-label on a custom control).
      for (const el of walkAll(doc)) if (role(el) && visible(el) && accName(el) === want) return el;
    }
    return best;
  }
  S.find = find;

  // ---------------------------------------------------------------- actions
  const MOUSE = { bubbles: true, cancelable: true, composed: true, view: g, button: 0, detail: 1 };
  function focusTarget(el) { for (let n = el; n && n.nodeType === 1; n = n._parent || (n.host || null)) if (S.isFocusable(n)) return n; return null; }
  function click(el) {
    if (S.isDisabled(el)) return 'disabled';
    el.dispatchEvent(new g.PointerEvent('pointerover', MOUSE)); el.dispatchEvent(new g.MouseEvent('mouseover', MOUSE));
    const down = el.dispatchEvent(new g.PointerEvent('pointerdown', MOUSE)) & el.dispatchEvent(new g.MouseEvent('mousedown', Object.assign({ buttons: 1 }, MOUSE)));
    if (down) { const f = focusTarget(el); if (f) S.focus(f); else S.focus(null); }
    el.dispatchEvent(new g.PointerEvent('pointerup', MOUSE)); el.dispatchEvent(new g.MouseEvent('mouseup', MOUSE));
    el.dispatchEvent(new g.PointerEvent('click', Object.assign({ pointerId: 1, pointerType: 'mouse' }, MOUSE)));
    return '';
  }
  function setValue(el, v) {
    const proto = el._local === 'textarea' ? g.HTMLTextAreaElement.prototype : g.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  }
  function selectOption(el, value) {
    const opts = el.options;
    const o = opts.find((x) => x.label === value || x.text === value) || opts.find((x) => x.value === value);
    if (!o) return 'ERR:no option ' + value;
    o.selected = true;
    el.dispatchEvent(new g.InputEvent('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return '';
  }
  function resolve(req) {
    const loc = req.loc || req;
    const el = find(loc);
    return el;
  }
  const control = (el) => (el && el._local === 'label' ? S.labelControl(el) || el : el);
  S.agent = {
    text: () => S.renderText(doc.documentElement || doc),
    html: () => '<!DOCTYPE html>' + (doc.documentElement ? S.serialize(doc.documentElement) : ''),
    title: () => doc.title,
    url: () => S.url,
    click(reqJson) {
      const el = resolve(JSON.parse(reqJson));
      if (!el) return 'ERR:not found: ' + reqJson;
      return click(el);
    },
    hover(reqJson) { const el = resolve(JSON.parse(reqJson)); if (!el) return 'ERR:not found'; for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) el.dispatchEvent(new g.MouseEvent(t, Object.assign({}, MOUSE, { bubbles: !/enter/.test(t) }))); return ''; },
    fill(reqJson) {
      const req = JSON.parse(reqJson);
      const el = control(resolve(req));
      if (!el) return 'ERR:not found: ' + reqJson;
      const v = String(req.value == null ? '' : req.value);
      if (el._local === 'select') return selectOption(el, v);
      S.focus(focusTarget(el));
      if (el._local === 'input' || el._local === 'textarea') {
        if (el._local === 'input' && (el.type === 'checkbox' || el.type === 'radio')) { if (el.checked !== (v !== '' && v !== 'false')) click(el); return ''; }
        setValue(el, v);
      } else if (el.isContentEditable) el.textContent = v;
      else return 'ERR:not fillable: ' + el._local;
      el.dispatchEvent(new g.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: v }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return '';
    },
    select(reqJson) {
      const req = JSON.parse(reqJson);
      const el = control(resolve(req));
      if (!el || el._local !== 'select') return 'ERR:no select: ' + reqJson;
      S.focus(el);
      return selectOption(el, String(req.value));
    },
    press(reqJson) {
      const req = JSON.parse(reqJson);
      const key = req.key || 'Enter';
      const el = (req.loc || req.role || req.css || req.label || req.text || req.ref) ? control(resolve(req)) : doc._active || doc.body;
      if (!el) return 'ERR:not found';
      const code = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ' ': 32 }[key] || key.toUpperCase().charCodeAt(0);
      const init = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true };
      const ok = el.dispatchEvent(new g.KeyboardEvent('keydown', init));
      if (ok && (key === 'Enter' || key.length === 1)) el.dispatchEvent(new g.KeyboardEvent('keypress', Object.assign({}, init, { charCode: code })));
      if (ok && key === 'Enter') {
        if (el._local === 'input' && el.form) {
          const f = el.form;
          const btn = f.elements.find((e) => (e._local === 'button' && e.type === 'submit') || (e._local === 'input' && (e.type === 'submit' || e.type === 'image')));
          if (btn) { if (!S.isDisabled(btn)) click(btn); } else S.requestSubmit(f, null);
        } else if (el._local === 'a' || el._local === 'button') click(el);
      }
      el.dispatchEvent(new g.KeyboardEvent('keyup', init));
      return '';
    },
    scroll() {
      g.scrollY = g.pageYOffset = 100000;
      S.scrolled();
      S.queueTask(() => { doc.dispatchEvent(new Event('scroll', { bubbles: true })); g.dispatchEvent(new Event('scroll')); });
      return '';
    },
    go(d) { __host.historyGo(Number(d)); return ''; },
    eval(js) {
      const r = (0, eval)(js);
      if (r && typeof r.then === 'function') { r.then((v) => { S.lastEval = v; }, (e) => { S.lastEval = 'Error: ' + e; }); return '[promise]'; }
      return typeof r === 'string' ? r : r === undefined ? '' : JSON.stringify(r);
    },
    // The DOM as it is now, for a painter that runs no JS (render.rs): live form state written
    // as attributes, CSSOM rules (insertRule, adoptedStyleSheets) written into <style>, and no
    // scripts or noscript (the page already ran with scripting on).
    renderHtml() {
      const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const escA = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/;
      const RAW = /^(style|xmp|iframe|noembed|noframes|plaintext)$/;
      const ser = (n) => {
        if (n.nodeType === 3) return n._parent && n._parent.nodeType === 1 && RAW.test(n._parent._local) ? n._data : esc(n._data);
        if (n.nodeType === 9 || n.nodeType === 11) return n._kids.map(ser).join('');
        if (n.nodeType !== 1) return '';
        const t = n._local;
        if (t === 'script' || t === 'noscript' || t === 'template') return '';
        const attrs = new Map(n._attrs);
        if (n._ns === S.NS.html) {
          if (t === 'input') {
            if (n.type === 'checkbox' || n.type === 'radio') { if (n.checked) attrs.set('checked', ''); else attrs.delete('checked'); }
            else if (n.type !== 'file' && n.type !== 'password') attrs.set('value', n.value);
          } else if (t === 'option') { if (n.selected) attrs.set('selected', ''); else attrs.delete('selected'); }
        }
        let s = '<' + t;
        for (const [k, v] of attrs) s += ' ' + k + '="' + escA(v) + '"';
        s += '>';
        if (n._ns === S.NS.html && VOID.test(t)) return s;
        if (t === 'textarea' && n._ns === S.NS.html) return s + esc(n.value) + '</textarea>';
        if (t === 'style') return s + n.textContent + (n._sheet && n._sheet._inserted.length ? '\n' + n._sheet._inserted.join('\n') : '') + '</style>';
        s += n._kids.map(ser).join('');
        if (t === 'head') for (const sh of doc.adoptedStyleSheets || []) if (sh && sh._css) s += '<style>' + sh._css() + '</style>';
        return s + '</' + t + '>';
      };
      return '<!DOCTYPE html>' + (doc.documentElement ? ser(doc.documentElement) : '');
    },
    links() {
      const out = [];
      for (const el of walkAll(doc)) if ((el._local === 'a' || el._local === 'area') && el.hasAttribute('href') && visible(el)) out.push({ text: accName(el), href: el.href });
      return JSON.stringify(out);
    },
    // Accessibility-style outline with refs for interactive elements.
    snapshot() {
      S.styleTree();
      const lines = [];
      const INTERACTIVE = /^(link|button|textbox|searchbox|combobox|listbox|checkbox|radio|tab|menuitem|menuitemcheckbox|menuitemradio|option|switch|slider|spinbutton|treeitem)$/;
      const walk = (n, depth) => {
        for (const c of kidsOf(n)) {
          if (c.nodeType === 3) { const t = norm(c._data); if (t && n.nodeType === 1 && S.computed(n).visibility === 'visible' && !INTERACTIVE.test(role(n)) && role(n) !== 'heading') lines.push('  '.repeat(depth) + '- text: ' + t); continue; }
          if (c.nodeType !== 1 || !S.isRendered(c) || c.getAttribute('aria-hidden') === 'true') continue;
          if (c._local === 'iframe' && c._frameIdx) { lines.push('  '.repeat(depth) + '- iframe:'); lines.push('\u0001F' + c._frameIdx + '\u0001'); continue; }
          const r = role(c);
          if (INTERACTIVE.test(r) || r === 'heading' || r === 'img') {
            const id = 'e' + c._nid;
            let line = '  '.repeat(depth) + '- ' + r + ' "' + accName(c) + '"';
            const attrs = [];
            if (r === 'heading') attrs.push('level=' + (c.getAttribute('aria-level') || (/^h\d$/.test(c._local) ? c._local[1] : '2')));
            if (r === 'checkbox' || r === 'radio' || r === 'switch') attrs.push('checked=' + (c._local === 'input' ? c.checked : c.getAttribute('aria-checked') === 'true'));
            if (r === 'tab' || r === 'option') { const s = c._local === 'option' ? c.selected : c.getAttribute('aria-selected') === 'true'; if (s) attrs.push('selected'); }
            if (S.isDisabled(c) || c.getAttribute('aria-disabled') === 'true') attrs.push('disabled');
            if (c.getAttribute('aria-expanded')) attrs.push('expanded=' + c.getAttribute('aria-expanded'));
            attrs.push('ref=' + id);
            line += ' [' + attrs.join('] [') + ']';
            // Password values never leave the page: agents and logs read this snapshot.
            if (r === 'textbox' || r === 'searchbox' || r === 'spinbutton') line += ': "' + (c._local === 'input' && c.type === 'password' ? (c.value ? '••••••' : '') : c.value !== undefined ? c.value : norm(c.textContent)) + '"';
            if (r === 'combobox' && c._local === 'select') { const o = c.options.find((x) => x.selected); line += ': "' + (o ? o.text : '') + '"'; }
            if (r === 'link') line += ' -> ' + c.getAttribute('href');
            lines.push(line);
            if (r === 'combobox' || r === 'listbox' || r === 'textbox') continue;
            if (r !== 'heading' && r !== 'link' && r !== 'button' && r !== 'tab') walk(c, depth + 1);
            continue;
          }
          if (/^(navigation|main|banner|contentinfo|complementary|form|dialog|list|table|region|group)$/.test(r)) {
            const nm = accName(c);
            lines.push('  '.repeat(depth) + '- ' + r + (nm ? ' "' + nm + '"' : '') + ':');
            walk(c, depth + 1);
            continue;
          }
          walk(c, depth);
        }
      };
      walk(doc.documentElement || doc, 0);
      return 'URL: ' + S.url + '\nTitle: ' + doc.title + '\n' + lines.join('\n');
    },
    markdown() {
      S.styleTree();
      const out = [];
      const inline = (n) => {
        let s = '';
        for (const c of kidsOf(n)) {
          if (c.nodeType === 3) { if (S.computed(n).visibility === 'visible') s += c._data.replace(/[ \t\n\r\f]+/g, ' '); continue; }
          if (c.nodeType !== 1 || S.computed(c).display === 'none') continue;
          const t = c._local;
          if (t === 'br') s += '\n';
          else if (t === 'a' && c.hasAttribute('href')) { const x = norm(inline(c)); if (x) s += '[' + x + '](' + c.href + ')'; }
          else if (t === 'img') { const a = c.getAttribute('alt'); if (a) s += '![' + a + ']'; }
          else if ((t === 'strong' || t === 'b') && norm(inline(c))) s += '**' + norm(inline(c)) + '**';
          else if ((t === 'em' || t === 'i') && norm(inline(c))) s += '*' + norm(inline(c)) + '*';
          else if (t === 'code') s += '`' + c.textContent + '`';
          else if (t === 'iframe' && c._frameIdx) s += '\n\u0001F' + c._frameIdx + '\u0001\n';
          else if (!NO_TEXT.has(t)) s += inline(c);
        }
        return s;
      };
      const block = (n, prefix) => {
        for (const c of kidsOf(n)) {
          if (c.nodeType === 3) { const t = norm(S.computed(n).visibility === 'visible' ? c._data : ''); if (t) out.push(prefix + t); continue; }
          if (c.nodeType !== 1 || S.computed(c).display === 'none') continue;
          const t = c._local;
          if (/^h[1-6]$/.test(t)) out.push('\n' + '#'.repeat(+t[1]) + ' ' + norm(inline(c)) + '\n');
          else if (t === 'p') { const x = norm(inline(c)); if (x) out.push('\n' + prefix + x + '\n'); }
          else if (t === 'pre') out.push('\n```\n' + c.textContent.replace(/\n$/, '') + '\n```\n');
          else if (t === 'ul' || t === 'ol') { let i = 1; for (const li of c.children) if (li._local === 'li' && S.computed(li).display !== 'none') { const x = norm(inline(li)); if (x) out.push(prefix + (t === 'ol' ? i++ + '. ' : '- ') + x); } out.push(''); }
          else if (t === 'table') {
            const rows = S.descendants(c).filter((r) => r._local === 'tr' && r.closest('table') === c && S.isRendered(r));
            rows.forEach((r, i) => { out.push('| ' + r.children.filter((x) => x._local === 'td' || x._local === 'th').map((x) => norm(inline(x)).replace(/\|/g, '\\|')).join(' | ') + ' |'); if (i === 0) out.push('|' + ' --- |'.repeat(r.children.length)); });
            out.push('');
          } else if (t === 'blockquote') block(c, prefix + '> ');
          else if (t === 'iframe' && c._frameIdx) out.push('\u0001F' + c._frameIdx + '\u0001');
          else if (NO_TEXT.has(t)) continue;
          else if (/^(inline|inline-block)$/.test(S.computed(c).display) && !c.children.some((k) => !/^inline/.test(S.computed(k).display))) { const x = norm(inline(c)); if (x) out.push(prefix + (t === 'a' && c.hasAttribute('href') ? '[' + x + '](' + c.href + ')' : x)); }
          else block(c, prefix);
        }
      };
      block(doc.body || doc.documentElement || doc, '');
      return ('# ' + doc.title + '\n\n' + out.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
    },
  };
})(globalThis);
