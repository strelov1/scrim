//! Native read path for documents without JavaScript: the visibility cascade and the visible text
//! computed in Rust on the parsed arena, so a script-less page never starts a JS engine.
//! It mirrors `js/style.js` (cascade) and `js/agent.js` (text) rule for rule; `scrim check-native`
//! compares both outputs byte for byte, and a page with scripts always takes the JS path.
use crate::css;
use crate::html::{Doc, Kind, Ns, NONE};
use crate::net::Net;
use std::collections::HashMap;
use url::Url;

// ------------------------------------------------------------------ eligibility

const JS_TYPES: &[&str] = &["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript",
    "application/x-javascript", "text/jscript", "text/livescript", "text/x-javascript", "module"];
/// Event attributes that fire without user input during loading.
const AUTO_EVENTS: &[&str] = &["onload", "onerror", "onpageshow", "onreadystatechange", "onbeforeunload", "onhashchange", "onpopstate", "onmessage", "onstorage", "onresize", "onscroll", "onfocus", "onfocusin", "ontoggle"];

/// True when loading this document runs no JavaScript and needs no frames, so the parsed tree
/// is already the final DOM.
pub fn script_free(doc: &Doc) -> bool {
    for i in doc.elements() {
        let n = &doc.nodes[i];
        if n.ns == Ns::Html {
            match n.name.as_str() {
                "script" => {
                    let ty = doc.attr(i, "type").unwrap_or("").trim().to_ascii_lowercase();
                    if JS_TYPES.contains(&ty.as_str()) && !(ty != "module" && doc.attr(i, "nomodule").is_some()) {
                        return false;
                    }
                }
                "iframe" | "frame" | "object" | "embed" => return false,
                _ => {}
            }
        }
        if n.attrs.iter().any(|(k, v)| AUTO_EVENTS.contains(&k.as_str()) && !v.trim().is_empty()) {
            return false;
        }
    }
    true
}

/// Preload scan: stylesheets and executable external scripts the document will request.
pub fn subresources(doc: &Doc, url: &str) -> Vec<String> {
    subresource_list(doc, url).into_iter().map(|(_, u)| u).collect()
}

/// (is_script, absolute URL) for every stylesheet and executable external script.
fn subresource_list(doc: &Doc, url: &str) -> Vec<(bool, String)> {
    let Ok(mut base) = Url::parse(url) else { return vec![] };
    let els = doc.elements();
    if let Some(h) = els.iter().find(|&&i| doc.nodes[i].name == "base").and_then(|&i| doc.attr(i, "href")) {
        if let Ok(b) = base.join(h) {
            base = b;
        }
    }
    let mut out = vec![];
    for i in els {
        let n = &doc.nodes[i];
        if n.ns != Ns::Html {
            continue;
        }
        let is_script = n.name == "script";
        let href = match n.name.as_str() {
            "link" => {
                let rel = doc.attr(i, "rel").unwrap_or("").to_ascii_lowercase();
                let rels: Vec<&str> = rel.split_whitespace().collect();
                let ok = rels.contains(&"stylesheet") && !rels.contains(&"alternate") && doc.attr(i, "disabled").is_none()
                    && doc.attr(i, "media").is_none_or(css::media_matches);
                if ok { doc.attr(i, "href") } else { None }
            }
            "script" => {
                let ty = doc.attr(i, "type").unwrap_or("").trim().to_ascii_lowercase();
                let exec = JS_TYPES.contains(&ty.as_str()) && !(ty != "module" && doc.attr(i, "nomodule").is_some());
                if exec { doc.attr(i, "src") } else { None }
            }
            _ => None,
        };
        if let Some(u) = href.and_then(|h| base.join(h).ok()) {
            if matches!(u.scheme(), "http" | "https") {
                out.push((is_script, u.to_string()));
            }
        }
    }
    out
}

/// JavaScript the document will load: inline scripts plus prefetched external ones (waits for
/// those downloads, which the page needs next anyway).
pub fn script_bytes(doc: &Doc, url: &str, net: &Net) -> usize {
    let mut n = 0;
    for i in doc.elements() {
        let node = &doc.nodes[i];
        if node.ns == Ns::Html && node.name == "script" {
            let ty = doc.attr(i, "type").unwrap_or("").trim().to_ascii_lowercase();
            if JS_TYPES.contains(&ty.as_str()) && doc.attr(i, "src").is_none() {
                n += doc.text_content(i).len();
            }
        }
    }
    for (is_script, u) in subresource_list(doc, url) {
        if is_script {
            n += net.prefetched_len(&u).unwrap_or(0);
        }
    }
    n
}

// ------------------------------------------------------------------ selectors (port of dom.js)

#[derive(Clone, Copy, PartialEq)]
enum Comb {
    Desc,
    Child,
    Next,
    Later,
}

#[derive(Clone)]
struct AttrSel {
    name: String,
    op: Option<String>,
    val: Option<String>,
    ci: bool,
}

#[derive(Clone)]
enum Pseudo {
    Not(Vec<Cx>),
    /// :is/:where/:matches/-webkit-any/-moz-any; the u8 is how it counts for specificity
    /// (0: its most specific argument, 1: nothing (:where), 2: one class (-moz-any)).
    Is(Vec<Cx>, u8),
    Has(Vec<Cx>, bool),
    Nth { kind: &'static str, a: i64, b: i64, of: Option<Vec<Cx>> },
    Lang(String),
    Dir(String),
    Simple(String),
}

#[derive(Clone)]
struct Compound {
    tag: Option<String>,
    id: Option<String>,
    cls: Vec<String>,
    attrs: Vec<AttrSel>,
    pseudo: Vec<Pseudo>,
    pe: bool,
}

type Cx = Vec<(Comb, Compound)>;

const KNOWN: &[&str] = &["root", "scope", "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type", "empty",
    "checked", "disabled", "enabled", "focus", "focus-within", "focus-visible", "hover", "active", "visited", "link", "any-link", "target", "defined",
    "required", "optional", "read-only", "read-write", "placeholder-shown", "indeterminate", "default", "valid", "invalid", "in-range", "out-of-range",
    "lang", "dir", "open", "closed", "modal", "popover-open", "fullscreen", "autofill", "-webkit-autofill", "playing", "paused", "user-invalid", "user-valid", "state", "contains"];
const PE: &[&str] = &["before", "after", "first-line", "first-letter", "selection", "placeholder", "marker", "backdrop"];

struct P<'a> {
    s: &'a [char],
    i: usize,
}

fn is_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c')
}
fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || (c as u32) >= 160
}

impl P<'_> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }
    fn ws(&mut self) {
        while self.peek().is_some_and(is_ws) {
            self.i += 1;
        }
    }
    fn ident(&mut self) -> String {
        let mut out = String::new();
        while let Some(c) = self.peek() {
            if c == '\\' {
                self.i += 1;
                let hex: String = self.s[self.i..].iter().take(6).take_while(|c| c.is_ascii_hexdigit()).collect();
                if !hex.is_empty() {
                    if let Some(ch) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                        out.push(ch);
                    }
                    self.i += hex.len();
                    if self.peek() == Some(' ') {
                        self.i += 1;
                    }
                } else if let Some(c) = self.peek() {
                    out.push(c);
                    self.i += 1;
                }
            } else if is_ident(c) {
                out.push(c);
                self.i += 1;
            } else {
                break;
            }
        }
        out
    }
    fn until(&mut self) -> Option<String> {
        let (mut depth, start) = (1, self.i);
        while let Some(c) = self.peek() {
            if c == '\\' {
                self.i += 2;
                continue;
            }
            if c == '"' || c == '\'' {
                self.i += 1;
                while self.peek().is_some_and(|x| x != c) {
                    if self.peek() == Some('\\') {
                        self.i += 1;
                    }
                    self.i += 1;
                }
                self.i += 1;
                continue;
            }
            if c == '(' || c == '[' {
                depth += 1;
            } else if c == ')' || c == ']' {
                depth -= 1;
                if depth == 0 {
                    let r: String = self.s[start..self.i].iter().collect();
                    self.i += 1;
                    return Some(r);
                }
            }
            self.i += 1;
        }
        None
    }
    fn compound(&mut self) -> Option<Compound> {
        let mut c = Compound { tag: None, id: None, cls: vec![], attrs: vec![], pseudo: vec![], pe: false };
        let mut any = false;
        if self.peek() == Some('*') {
            self.i += 1;
            any = true;
        } else if self.peek().is_some_and(|ch| is_ident(ch) || ch == '\\') {
            c.tag = Some(self.ident().to_lowercase());
            any = true;
        }
        if self.peek() == Some('|') {
            self.i += 1;
            if self.peek() == Some('*') {
                self.i += 1;
                c.tag = None;
            } else {
                c.tag = Some(self.ident().to_lowercase());
            }
        }
        loop {
            match self.peek() {
                Some('#') => {
                    self.i += 1;
                    c.id = Some(self.ident());
                    any = true;
                }
                Some('.') => {
                    self.i += 1;
                    c.cls.push(self.ident());
                    any = true;
                }
                Some('[') => {
                    self.i += 1;
                    let body = self.until()?;
                    c.attrs.push(parse_attr(&body)?);
                    any = true;
                }
                Some(':') => {
                    self.i += 1;
                    if self.peek() == Some(':') {
                        self.i += 1;
                        self.ident();
                        if self.peek() == Some('(') {
                            self.i += 1;
                            self.until()?;
                        }
                        c.pe = true;
                        any = true;
                        continue;
                    }
                    let name = self.ident().to_lowercase();
                    let mut arg = None;
                    if self.peek() == Some('(') {
                        self.i += 1;
                        arg = Some(self.until()?);
                    }
                    any = true;
                    if PE.contains(&name.as_str()) {
                        c.pe = true;
                        continue;
                    }
                    c.pseudo.push(make_pseudo(&name, arg)?);
                }
                _ => break,
            }
        }
        any.then_some(c)
    }
}

fn parse_attr(body: &str) -> Option<AttrSel> {
    // [name], [name op value i]
    let b = body.trim();
    let ops = ["~=", "|=", "^=", "$=", "*=", "!=", "="];
    let pos = b.char_indices().find(|(_, c)| matches!(c, '~' | '|' | '^' | '$' | '*' | '!' | '='));
    let Some((p, _)) = pos else {
        let name = b.rsplit('|').next()?.replace('\\', "").to_lowercase();
        return (!name.is_empty() && !name.contains(char::is_whitespace)).then_some(AttrSel { name, op: None, val: None, ci: false });
    };
    let name = b[..p].trim().rsplit('|').next()?.replace('\\', "").to_lowercase();
    let rest = &b[p..];
    let op = ops.iter().find(|o| rest.starts_with(*o))?;
    let v = rest[op.len()..].trim();
    let mut ci = false;
    let val = if v.starts_with('"') || v.starts_with('\'') {
        // Quoted value, then an optional i/s flag.
        let q = v.chars().next().unwrap();
        let mut end = None;
        let mut esc = false;
        for (k, c) in v.char_indices().skip(1) {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == q {
                end = Some(k);
                break;
            }
        }
        let end = end?;
        let flag = v[end + 1..].trim();
        match flag {
            "" | "s" | "S" => {}
            "i" | "I" => ci = true,
            _ => return None,
        }
        v[1..end].to_string()
    } else {
        let (val, flag) = match v.rsplit_once(char::is_whitespace) {
            Some((a, f)) => (a.trim_end(), f),
            None => (v, ""),
        };
        match flag {
            "" | "s" | "S" => {}
            "i" | "I" => ci = true,
            _ => return None,
        }
        if val.is_empty() || val.contains(char::is_whitespace) {
            return None;
        }
        val.to_string()
    };
    Some(AttrSel { name, op: Some(op.to_string()), val: Some(unescape(&val)), ci })
}

fn unescape(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            if let Some(n) = it.next() {
                out.push(n);
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_nth(a: &str) -> Option<(i64, i64)> {
    let a: String = a.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    if a == "odd" {
        return Some((2, 1));
    }
    if a == "even" {
        return Some((2, 0));
    }
    if let Some(np) = a.find('n') {
        let (k, rest) = (&a[..np], &a[np + 1..]);
        let k = match k {
            "" | "+" => 1,
            "-" => -1,
            k => k.parse().ok()?,
        };
        let b = if rest.is_empty() { 0 } else { rest.parse().ok()? };
        return Some((k, b));
    }
    Some((0, a.parse().ok()?))
}

fn make_pseudo(name: &str, arg: Option<String>) -> Option<Pseudo> {
    Some(match name {
        "not" => Pseudo::Not(parse_list(&arg?)?),
        "is" | "matches" | "-webkit-any" => Pseudo::Is(parse_list(&arg?)?, 0),
        "where" => Pseudo::Is(parse_list(&arg?)?, 1),
        "-moz-any" => Pseudo::Is(parse_list(&arg?)?, 2),
        "host" | "host-context" if arg.is_some() => Pseudo::Simple("host".into()),
        "has" => {
            let a = arg?;
            let t = a.trim_start();
            let sib = t.starts_with('+') || t.starts_with('~');
            let rel = if t.starts_with(['>', '+', '~']) { format!(":scope {t}") } else { a.clone() };
            Pseudo::Has(parse_list(&rel)?, sib)
        }
        n if n.starts_with("nth-") => {
            let a = arg?;
            let (expr, of) = match a.split_once(" of ") {
                Some((e, s)) => (e.to_string(), Some(parse_list(s)?)),
                None => (a.clone(), None),
            };
            let (k, b) = parse_nth(expr.trim())?;
            let kind: &'static str = match n {
                "nth-child" => "nth-child",
                "nth-last-child" => "nth-last-child",
                "nth-of-type" => "nth-of-type",
                "nth-last-of-type" => "nth-last-of-type",
                _ => return None,
            };
            Pseudo::Nth { kind, a: k, b, of }
        }
        "lang" => Pseudo::Lang(arg.unwrap_or_default()),
        "dir" => Pseudo::Dir(arg.unwrap_or_default()),
        n if KNOWN.contains(&n) => Pseudo::Simple(n.to_string()),
        _ => return None,
    })
}

fn parse_list(s: &str) -> Option<Vec<Cx>> {
    let chars: Vec<char> = s.trim().chars().collect();
    let mut p = P { s: &chars, i: 0 };
    let mut list = vec![];
    let mut cx: Cx = vec![];
    let mut comb = Comb::Desc;
    p.ws();
    while p.i < chars.len() {
        let c = p.compound()?;
        cx.push((comb, c));
        let before = p.i;
        p.ws();
        match p.peek() {
            Some(',') => {
                p.i += 1;
                p.ws();
                list.push(std::mem::take(&mut cx));
                comb = Comb::Desc;
            }
            Some('>') => {
                comb = Comb::Child;
                p.i += 1;
                p.ws();
            }
            Some('+') => {
                comb = Comb::Next;
                p.i += 1;
                p.ws();
            }
            Some('~') => {
                comb = Comb::Later;
                p.i += 1;
                p.ws();
            }
            None => break,
            _ if p.i > before => comb = Comb::Desc,
            _ => return None,
        }
    }
    if cx.is_empty() {
        return None;
    }
    list.push(cx);
    Some(list)
}

fn specificity(cx: &Cx) -> u64 {
    let (mut a, mut b, mut c) = (0u64, 0u64, 0u64);
    for (_, k) in cx {
        if k.id.is_some() {
            a += 1;
        }
        b += (k.cls.len() + k.attrs.len()) as u64;
        if k.tag.as_deref().is_some_and(|t| t != "*") {
            c += 1;
        }
        if k.pe {
            c += 1;
        }
        for p in &k.pseudo {
            match p {
                Pseudo::Is(_, 1) => {}
                Pseudo::Is(_, 2) => b += 1,
                Pseudo::Is(l, _) | Pseudo::Not(l) | Pseudo::Has(l, _) => {
                    let best = l.iter().map(specificity).max().unwrap_or(0);
                    a += best / 1_000_000;
                    b += (best / 1000) % 1000;
                    c += best % 1000;
                }
                _ => b += 1,
            }
        }
    }
    a * 1_000_000 + b * 1000 + c
}

// ------------------------------------------------------------------ matching

pub struct Page<'a> {
    pub doc: &'a Doc,
    url: Url,
    class_sets: Vec<Option<Vec<String>>>,
    root: usize,
}

fn nth_ok(a: i64, b: i64, pos: i64) -> bool {
    if a == 0 {
        return pos == b;
    }
    let d = pos - b;
    d % a == 0 && d / a >= 0
}

impl<'a> Page<'a> {
    fn parent_elem(&self, i: usize) -> Option<usize> {
        let p = self.doc.nodes[i].parent;
        (p != NONE && self.doc.is_elem(p)).then_some(p)
    }
    fn sibs(&self, i: usize) -> Vec<usize> {
        let p = self.doc.nodes[i].parent;
        if p == NONE {
            return self.doc.top.iter().copied().filter(|&k| self.doc.is_elem(k)).collect();
        }
        self.doc.elem_kids(p).collect()
    }
    fn tag(&self, i: usize) -> &str {
        &self.doc.nodes[i].name
    }
    fn is_disabled(&self, i: usize) -> bool {
        let t = self.tag(i);
        if self.doc.nodes[i].ns != Ns::Html || !matches!(t, "button" | "input" | "select" | "textarea" | "optgroup" | "option" | "fieldset") {
            return false;
        }
        if self.doc.attr(i, "disabled").is_some() {
            return true;
        }
        if t == "option" {
            let og = self.doc.nodes[i].parent;
            return og != NONE && self.tag(og) == "optgroup" && self.doc.attr(og, "disabled").is_some();
        }
        let mut p = self.parent_elem(i);
        while let Some(f) = p {
            if self.tag(f) == "fieldset" && self.doc.attr(f, "disabled").is_some() {
                let legend = self.doc.elem_kids(f).find(|&k| self.tag(k) == "legend");
                if !legend.is_some_and(|l| self.contains(l, i)) {
                    return true;
                }
            }
            p = self.parent_elem(f);
        }
        false
    }
    fn contains(&self, a: usize, b: usize) -> bool {
        let mut n = b;
        while n != NONE {
            if n == a {
                return true;
            }
            n = self.doc.nodes[n].parent;
        }
        false
    }
    fn input_type(&self, i: usize) -> String {
        self.doc.attr(i, "type").unwrap_or("").to_ascii_lowercase()
    }
    fn option_selected(&self, o: usize) -> bool {
        // Same rule as HTMLOptionElement.selected for an untouched document.
        let mut sel = None;
        let mut p = self.parent_elem(o);
        while let Some(x) = p {
            if self.tag(x) == "select" {
                sel = Some(x);
                break;
            }
            if self.tag(x) != "optgroup" {
                break;
            }
            p = self.parent_elem(x);
        }
        let Some(sel) = sel else { return self.doc.attr(o, "selected").is_some() };
        let opts: Vec<usize> = self.descendants(sel).into_iter().filter(|&k| self.tag(k) == "option").collect();
        let explicit: Vec<usize> = opts.iter().copied().filter(|&k| self.doc.attr(k, "selected").is_some()).collect();
        if self.doc.attr(sel, "multiple").is_some() {
            return explicit.contains(&o);
        }
        if let Some(&last) = explicit.last() {
            return last == o;
        }
        let size: i64 = self.doc.attr(sel, "size").and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        if size.max(1) > 1 {
            return false;
        }
        opts.iter().copied().find(|&k| !self.is_disabled(k)) == Some(o)
    }
    fn descendants(&self, i: usize) -> Vec<usize> {
        let mut out = vec![];
        let mut st: Vec<usize> = self.doc.nodes[i].kids.iter().rev().copied().collect();
        while let Some(n) = st.pop() {
            if self.doc.is_elem(n) {
                out.push(n);
                st.extend(self.doc.nodes[n].kids.iter().rev());
            }
        }
        out
    }
    fn value(&self, i: usize) -> String {
        match self.tag(i) {
            "textarea" => self.doc.text_content(i),
            "select" => self.descendants(i).into_iter().find(|&o| self.tag(o) == "option" && self.option_selected(o))
                .map(|o| self.doc.attr(o, "value").map(String::from).unwrap_or_else(|| collapse(&self.doc.text_content(o)))).unwrap_or_default(),
            _ => self.doc.attr(i, "value").unwrap_or("").replace(['\r', '\n'], ""),
        }
    }
    fn invalid(&self, i: usize) -> bool {
        let t = self.tag(i);
        if self.is_disabled(i) || t == "button" || t == "fieldset" || (t == "input" && matches!(self.input_type(i).as_str(), "hidden" | "button" | "submit" | "reset" | "image")) {
            return false;
        }
        if !matches!(t, "input" | "select" | "textarea") {
            return false;
        }
        let v = self.value(i);
        if self.doc.attr(i, "required").is_some() {
            let ty = self.input_type(i);
            if t == "input" && (ty == "checkbox" || ty == "radio") {
                if self.doc.attr(i, "checked").is_none() {
                    return true;
                }
            } else if v.is_empty() {
                return true;
            }
        }
        if !v.is_empty() && t == "input" {
            match self.input_type(i).as_str() {
                "email" => {
                    let parts: Vec<&str> = v.split('@').collect();
                    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() || v.contains(char::is_whitespace) {
                        return true;
                    }
                }
                "url" => {
                    if Url::parse(&v).is_err() {
                        return true;
                    }
                }
                _ => {}
            }
        }
        false
    }

    fn pseudo(&self, el: usize, p: &Pseudo, scope: Option<usize>) -> bool {
        match p {
            Pseudo::Not(l) => !self.match_list(el, l, scope),
            Pseudo::Is(l, _) => self.match_list(el, l, scope),
            Pseudo::Has(l, sib) => {
                self.descendants(el).into_iter().any(|d| self.match_list(d, l, Some(el))) || (*sib && self.sibs(el).into_iter().any(|d| self.match_list(d, l, Some(el))))
            }
            Pseudo::Nth { kind, a, b, of } => {
                let tagged = |x: usize| self.tag(x) == self.tag(el);
                match *kind {
                    "nth-child" | "nth-last-child" => {
                        let s: Vec<usize> = self.sibs(el).into_iter().filter(|&x| of.as_ref().is_none_or(|l| self.match_list(x, l, scope))).collect();
                        let Some(i) = s.iter().position(|&x| x == el) else { return false };
                        nth_ok(*a, *b, if *kind == "nth-child" { i as i64 + 1 } else { (s.len() - i) as i64 })
                    }
                    _ => {
                        let s: Vec<usize> = self.sibs(el).into_iter().filter(|&x| tagged(x)).collect();
                        let i = s.iter().position(|&x| x == el).map(|i| i as i64).unwrap_or(-1);
                        nth_ok(*a, *b, if *kind == "nth-of-type" { i + 1 } else { s.len() as i64 - i })
                    }
                }
            }
            Pseudo::Lang(l) => {
                let mut n = Some(el);
                while let Some(x) = n {
                    if let Some(v) = self.doc.attr(x, "lang") {
                        return v.to_lowercase().starts_with(&l.to_lowercase());
                    }
                    n = self.parent_elem(x);
                }
                false
            }
            Pseudo::Dir(d) => d.trim() == "ltr",
            Pseudo::Simple(name) => {
                let d = self.doc;
                let t = self.tag(el);
                match name.as_str() {
                    "root" => el == self.root,
                    "scope" => scope.map_or(el == self.root, |s| s == el),
                    "first-child" => self.sibs(el).first() == Some(&el),
                    "last-child" => self.sibs(el).last() == Some(&el),
                    "only-child" => self.sibs(el).len() == 1,
                    "first-of-type" => self.sibs(el).into_iter().find(|&x| self.tag(x) == t) == Some(el),
                    "last-of-type" => self.sibs(el).into_iter().filter(|&x| self.tag(x) == t).last() == Some(el),
                    "only-of-type" => self.sibs(el).into_iter().filter(|&x| self.tag(x) == t).count() == 1,
                    "empty" => !d.nodes[el].kids.iter().any(|&k| match d.nodes[k].kind {
                        Kind::Elem => true,
                        Kind::Text => !d.nodes[k].name.is_empty(),
                        Kind::Comment => false,
                    }),
                    "checked" => {
                        (t == "input" && matches!(self.input_type(el).as_str(), "checkbox" | "radio") && d.attr(el, "checked").is_some())
                            || (t == "option" && self.option_selected(el))
                    }
                    "disabled" => self.is_disabled(el),
                    "enabled" => matches!(t, "input" | "button" | "select" | "textarea" | "option" | "optgroup" | "fieldset") && !self.is_disabled(el),
                    "link" | "any-link" => (t == "a" || t == "area") && d.attr(el, "href").is_some(),
                    "target" => self.url.fragment().is_some_and(|f| {
                        let f = percent_decode(f);
                        d.attr(el, "id") == Some(f.as_str())
                    }),
                    "defined" => !t.contains('-'),
                    "required" => d.attr(el, "required").is_some(),
                    "optional" => matches!(t, "input" | "select" | "textarea") && d.attr(el, "required").is_none(),
                    "read-only" => !matches!(t, "input" | "textarea") || d.attr(el, "readonly").is_some() || d.attr(el, "disabled").is_some(),
                    "read-write" => matches!(t, "input" | "textarea") && d.attr(el, "readonly").is_none() && d.attr(el, "disabled").is_none(),
                    "placeholder-shown" => d.attr(el, "placeholder").is_some() && self.value(el).is_empty(),
                    "open" => d.attr(el, "open").is_some(),
                    "closed" => d.attr(el, "open").is_none(),
                    "invalid" | "user-invalid" => self.invalid(el),
                    "valid" | "user-valid" => !self.invalid(el),
                    "in-range" => true,
                    "default" => (t == "option" && d.attr(el, "selected").is_some()) || d.attr(el, "checked").is_some(),
                    _ => false,
                }
            }
        }
    }

    fn compound(&self, el: usize, c: &Compound, scope: Option<usize>) -> bool {
        if c.pe {
            return false;
        }
        if let Some(t) = &c.tag {
            if t != "*" && self.tag(el).to_lowercase() != *t {
                return false;
            }
        }
        if let Some(id) = &c.id {
            if self.doc.attr(el, "id") != Some(id.as_str()) {
                return false;
            }
        }
        if !c.cls.is_empty() {
            let Some(set) = &self.class_sets[el] else { return false };
            if !c.cls.iter().all(|x| set.contains(x)) {
                return false;
            }
        }
        for a in &c.attrs {
            let Some(v) = self.doc.attr(el, &a.name) else { return false };
            if let (Some(op), Some(x)) = (&a.op, &a.val) {
                let (v, x) = if a.ci { (v.to_lowercase(), x.to_lowercase()) } else { (v.to_string(), x.clone()) };
                let ok = match op.as_str() {
                    "=" => v == x,
                    "~=" => !x.is_empty() && v.split_whitespace().any(|w| w == x),
                    "|=" => v == x || v.starts_with(&format!("{x}-")),
                    "^=" => !x.is_empty() && v.starts_with(&x),
                    "$=" => !x.is_empty() && v.ends_with(&x),
                    "*=" => !x.is_empty() && v.contains(&x),
                    "!=" => v != x,
                    _ => false,
                };
                if !ok {
                    return false;
                }
            }
        }
        c.pseudo.iter().all(|p| self.pseudo(el, p, scope))
    }

    fn complex(&self, el: usize, cx: &Cx, idx: usize, scope: Option<usize>) -> bool {
        if !self.compound(el, &cx[idx].1, scope) {
            return false;
        }
        if idx == 0 {
            return true;
        }
        match cx[idx].0 {
            Comb::Child => self.parent_elem(el).is_some_and(|p| self.complex(p, cx, idx - 1, scope)),
            Comb::Desc => {
                let mut p = self.parent_elem(el);
                while let Some(x) = p {
                    if self.complex(x, cx, idx - 1, scope) {
                        return true;
                    }
                    p = self.parent_elem(x);
                }
                false
            }
            Comb::Next | Comb::Later => {
                let s = self.sibs(el);
                let i = s.iter().position(|&x| x == el).unwrap_or(0);
                if cx[idx].0 == Comb::Next {
                    i > 0 && self.complex(s[i - 1], cx, idx - 1, scope)
                } else {
                    (0..i).rev().any(|j| self.complex(s[j], cx, idx - 1, scope))
                }
            }
        }
    }

    fn match_list(&self, el: usize, list: &[Cx], scope: Option<usize>) -> bool {
        list.iter().any(|cx| self.complex(el, cx, cx.len() - 1, scope))
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn collapse(s: &str) -> String {
    s.split([' ', '\t', '\n', '\r', '\x0c']).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

// ------------------------------------------------------------------ cascade (port of style.js)

/// One parsed rule: selector, property (0 display, 1 visibility, 2 content-visibility), value,
/// !important, specificity.
type PRule = (Cx, u8, String, bool, u64);

/// Parse many sheets; big ones are cut at top-level rules so all cores share the work.
fn parse_sheets(texts: &[&str]) -> Vec<Vec<PRule>> {
    let total: usize = texts.iter().map(|t| t.len()).sum();
    if total <= 256 * 1024 {
        return texts.iter().map(|t| parse_sheet(t)).collect();
    }
    let piece = (total / (threads() * 4)).max(32 * 1024);
    let work: Vec<(usize, &str)> = texts.iter().enumerate().flat_map(|(i, t)| css::split_top_level(t, piece).into_iter().map(move |p| (i, p))).collect();
    let done = par_map(&work, |(_, p)| parse_sheet(p));
    let mut out: Vec<Vec<PRule>> = vec![vec![]; texts.len()];
    for ((i, _), rules) in work.iter().zip(done) {
        out[*i].extend(rules);
    }
    out
}

fn parse_sheet(text: &str) -> Vec<PRule> {
    let mut v = vec![];
    for r in css::visibility_rule_list(text) {
        let Some(list) = parse_list(&r.selector) else { continue };
        let prop = match r.prop.as_str() {
            "display" => 0,
            "visibility" => 1,
            _ => 2,
        };
        for cx in list {
            if cx[cx.len() - 1].1.pe {
                continue;
            }
            let spec = specificity(&cx);
            v.push((cx, prop, r.val.clone(), r.important, spec));
        }
    }
    v
}

/// Rules of the document's <style> blocks, parsed from the raw HTML while html5ever builds the
/// tree. Looked up by exact sheet text, so anything the scan got wrong is just a cache miss.
#[derive(Default)]
pub struct Prescan {
    texts: Vec<String>,
    /// text length -> (index into texts, parsed rules), one entry per block occurrence.
    by_len: HashMap<usize, Vec<(usize, Vec<PRule>)>>,
}

impl Prescan {
    fn take(&mut self, text: &str) -> Option<Vec<PRule>> {
        let v = self.by_len.get_mut(&text.len())?;
        let i = v.iter().position(|(t, _)| self.texts[*t] == text)?;
        Some(v.swap_remove(i).1)
    }
}

/// Cheap identity for dedup: length plus FNV of the first and last 256 bytes; equal keys are
/// confirmed with a full comparison.
fn quick_key(t: &str) -> (usize, u64) {
    let b = t.as_bytes();
    let mut h: u64 = 0xcbf29ce484222325;
    for &x in b.iter().take(256).chain(b.iter().rev().take(256)) {
        h ^= x as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    (b.len(), h)
}

/// Streaming preload scan: fed the document bytes as they download; every `<style>` block that
/// closes goes to its own parse thread at once (identical blocks are parsed once).
#[derive(Default)]
pub struct Prescanner {
    buf: Vec<u8>,
    pos: usize,
    /// An open block waiting for its `</style`: (content start, where to resume the search).
    open: Option<(usize, usize)>,
    jobs: Vec<(String, Job)>,
    seen: HashMap<(usize, u64), Vec<usize>>,
}

enum Job {
    Parse(std::thread::JoinHandle<Vec<PRule>>),
    Same(usize),
}

const TAG_END: fn(u8) -> bool = |c| matches!(c, b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/');

impl Prescanner {
    pub fn feed(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        self.scan(false);
    }

    /// Dispatch every complete block from `pos`; at the end of input an unclosed block runs to EOF.
    fn scan(&mut self, eof: bool) {
        loop {
            if let Some((start, from)) = self.open {
                let b = &self.buf;
                let mut k = from;
                let end = loop {
                    match crate::html::find_ci(&b[k..], b"</style") {
                        Some(o) if k + o + 7 < b.len() => {
                            if TAG_END(b[k + o + 7]) { break Some(k + o); }
                            k = k + o + 7;
                        }
                        Some(o) => { k += o; break if eof { Some(b.len()) } else { None }; }
                        None => { k = b.len().saturating_sub(7).max(k); break if eof { Some(b.len()) } else { None }; }
                    }
                };
                let Some(end) = end else {
                    self.open = Some((start, k));
                    return;
                };
                let text = crate::html::raw_text(&String::from_utf8_lossy(&self.buf[start..end]));
                self.open = None;
                self.pos = end;
                self.dispatch(text);
                if end >= self.buf.len() {
                    return;
                }
                continue;
            }
            let b = &self.buf;
            let Some(off) = crate::html::find_ci(&b[self.pos..], b"<style") else {
                // Keep a few bytes: "<style" may straddle chunks.
                self.pos = b.len().saturating_sub(6).max(self.pos);
                return;
            };
            let s0 = self.pos + off;
            let mut j = s0 + 6;
            if j >= b.len() {
                if eof { return; }
                self.pos = s0;
                return;
            }
            if !TAG_END(b[j]) {
                self.pos = j;
                continue;
            }
            let mut q = 0u8;
            while j < b.len() {
                let c = b[j];
                if q != 0 {
                    if c == q { q = 0; }
                } else if c == b'"' || c == b'\'' {
                    q = c;
                } else if c == b'>' {
                    break;
                }
                j += 1;
            }
            if j >= b.len() {
                if !eof { self.pos = s0; }
                return;
            }
            self.open = Some((j + 1, j + 1));
        }
    }

    fn dispatch(&mut self, text: String) {
        let cands = self.seen.entry(quick_key(&text)).or_default();
        if let Some(&u) = cands.iter().find(|&&u| self.jobs[u].0 == text) {
            self.jobs.push((text, Job::Same(u)));
            return;
        }
        cands.push(self.jobs.len());
        let t = text.clone();
        let h = std::thread::spawn(move || {
            crate::qos::critical();
            parse_sheets(&[t.as_str()]).pop().unwrap_or_default()
        });
        self.jobs.push((text, Job::Parse(h)));
    }

    pub fn finish(mut self) -> Prescan {
        let t0 = std::time::Instant::now();
        self.scan(true);
        let mut parsed: Vec<Option<Vec<PRule>>> = Vec::with_capacity(self.jobs.len());
        let mut texts = vec![];
        let mut by_len: HashMap<usize, Vec<(usize, Vec<PRule>)>> = HashMap::new();
        for (k, (text, job)) in self.jobs.into_iter().enumerate() {
            let rules = match job {
                Job::Parse(h) => h.join().unwrap_or_default(),
                Job::Same(u) => parsed[u].clone().unwrap_or_default(),
            };
            by_len.entry(text.len()).or_default().push((k, rules.clone()));
            parsed.push(Some(rules));
            texts.push(text);
        }
        if std::env::var_os("SCRIM_PROFILE").is_some() {
            eprintln!("[prof] style prescan wait {:.1} ms ({} blocks)", t0.elapsed().as_secs_f64() * 1e3, texts.len());
        }
        Prescan { texts, by_len }
    }
}

struct CRule {
    cx: Cx,
    prop: u8, // 0 display, 1 visibility, 2 content-visibility
    val: String,
    imp: bool,
    spec: u64,
    order: usize,
}


const BLOCK: &[&str] = &["html", "body", "address", "blockquote", "center", "div", "figure", "figcaption", "footer", "form", "header", "hr", "legend", "listing", "main", "p", "plaintext", "pre", "search", "xmp",
    "article", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "hgroup", "nav", "section", "details", "summary", "dd", "dl", "dt", "fieldset", "menu", "ol", "ul", "dir", "optgroup", "option", "frameset", "frame"];
const UA_NONE: &[&str] = &["head", "script", "style", "template", "title", "meta", "link", "base", "noscript", "datalist", "param", "area", "rp", "noembed", "noframes", "slot-none"];

fn ua_display(d: &Doc, i: usize) -> &'static str {
    let n = &d.nodes[i];
    let t = n.name.as_str();
    if n.ns != Ns::Html {
        if n.ns == Ns::Svg && !matches!(t, "svg" | "foreignObject" | "text" | "tspan" | "a" | "g") {
            return if matches!(t, "title" | "desc" | "style" | "script" | "defs" | "symbol" | "clipPath" | "mask" | "linearGradient" | "radialGradient" | "filter" | "pattern" | "marker") { "none" } else { "inline" };
        }
        return "inline";
    }
    if UA_NONE.contains(&t) {
        return "none";
    }
    if d.attr(i, "hidden").is_some_and(|v| v != "until-found") {
        return "none";
    }
    if t == "input" && d.attr(i, "type").is_some_and(|v| v.eq_ignore_ascii_case("hidden")) {
        return "none";
    }
    if t == "dialog" {
        return if d.attr(i, "open").is_some() { "block" } else { "none" };
    }
    if d.attr(i, "popover").is_some() && d.attr(i, "popover-open").is_none() {
        return "none";
    }
    if BLOCK.contains(&t) {
        return "block";
    }
    match t {
        "li" => "list-item",
        "table" => "table",
        "caption" => "table-caption",
        "tr" => "table-row",
        "td" | "th" => "table-cell",
        "thead" => "table-header-group",
        "tbody" => "table-row-group",
        "tfoot" => "table-footer-group",
        "col" => "table-column",
        "colgroup" => "table-column-group",
        "ruby" => "ruby",
        "rt" => "ruby-text",
        "img" | "input" | "button" | "select" | "textarea" | "video" | "audio" | "canvas" | "iframe" | "meter" | "progress" | "marquee" => "inline-block",
        _ => "inline",
    }
}

/// Inline style declarations that matter here: (property index, value lowercased, important).
fn inline_decls(style: &str) -> Vec<(u8, String, bool)> {
    let lower = style.to_ascii_lowercase();
    if !lower.contains("display") && !lower.contains("visibility") {
        return vec![];
    }
    let mut out: HashMap<u8, (String, bool)> = HashMap::new();
    let (mut depth, mut start) = (0i32, 0usize);
    let mut parts = vec![];
    for (i, c) in style.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ';' if depth <= 0 => {
                parts.push(&style[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&style[start..]);
    for p in parts {
        let Some((k, v)) = p.split_once(':') else { continue };
        let k = k.trim().to_ascii_lowercase();
        let mut v = v.trim().to_string();
        let lv = v.to_ascii_lowercase();
        let imp = lv.trim_end().ends_with("important") && lv.contains('!') && {
            let t = lv.trim_end().trim_end_matches("important").trim_end();
            t.ends_with('!')
        };
        if imp {
            let cut = v.to_ascii_lowercase().rfind('!').unwrap();
            v = v[..cut].trim().to_string();
        }
        let idx = match k.as_str() {
            "display" => 0,
            "visibility" => 1,
            "content-visibility" => 2,
            _ => continue,
        };
        out.insert(idx, (v.to_lowercase(), imp));
    }
    let mut v: Vec<(u8, String, bool)> = out.into_iter().map(|(k, (v, i))| (k, v, i)).collect();
    v.sort_by_key(|x| x.0);
    v
}

impl<'a> Page<'a> {
    pub fn new(doc: &'a Doc, url: &str, net: &Net, prescan: Prescan) -> (Page<'a>, Vec<Style>) {
        let url = Url::parse(url).unwrap_or_else(|_| Url::parse("about:blank").unwrap());
        let class_sets = doc
            .nodes
            .iter()
            .map(|n| n.attrs.iter().find(|(k, _)| k == "class").map(|(_, v)| { let mut c: Vec<String> = v.split([' ', '\t', '\n', '\x0c', '\r']).filter(|s| !s.is_empty()).map(String::from).collect(); c.dedup(); c }))
            .collect();
        let root = doc.root_elem().unwrap_or(NONE);
        let page = Page { doc, url, class_sets, root };
        let styles = page.cascade(net, prescan);
        (page, styles)
    }

    fn base_url(&self) -> Url {
        for i in self.doc.elements() {
            if self.tag(i) == "base" {
                if let Some(h) = self.doc.attr(i, "href") {
                    if let Ok(u) = self.url.join(h) {
                        return u;
                    }
                }
            }
        }
        self.url.clone()
    }

    fn sheets(&self, net: &Net) -> Vec<std::borrow::Cow<'a, str>> {
        let mut texts = vec![];
        let base = self.base_url();
        let mut st: Vec<usize> = self.doc.top.iter().rev().copied().collect();
        while let Some(i) = st.pop() {
            if !self.doc.is_elem(i) {
                continue;
            }
            let n = &self.doc.nodes[i];
            if n.name == "style" || n.name == "link" {
                let media_ok = self.doc.attr(i, "media").is_none_or(css::media_matches);
                if n.name == "link" {
                    let rel = self.doc.attr(i, "rel").unwrap_or("").to_ascii_lowercase();
                    let rels: Vec<&str> = rel.split_whitespace().collect();
                    if rels.contains(&"stylesheet") && !rels.contains(&"alternate") && self.doc.attr(i, "disabled").is_none() && media_ok {
                        let text = self.doc.attr(i, "href").and_then(|h| base.join(h).ok()).and_then(|u| net.fetch("GET", u.as_str(), &[], None).ok())
                            .filter(|r| (200..300).contains(&r.status)).map(|r| r.text()).unwrap_or_default();
                        texts.push(text.into());
                    }
                } else if media_ok {
                    // Usually one text child: borrow it instead of copying.
                    let kids = &self.doc.nodes[i].kids;
                    let doc: &'a Doc = self.doc;
                    if kids.len() == 1 && matches!(doc.nodes[kids[0]].kind, Kind::Text) {
                        texts.push(std::borrow::Cow::Borrowed(doc.nodes[kids[0]].name.as_str()));
                    } else {
                        texts.push(doc.text_content(i).into());
                    }
                }
            }
            if n.name != "svg" {
                st.extend(n.kids.iter().rev());
            }
        }
        texts
    }

    fn cascade(&self, net: &Net, mut prescan: Prescan) -> Vec<Style> {
        let prof = std::env::var_os("SCRIM_PROFILE").is_some();
        let t0 = std::time::Instant::now();
        let mut sheets = self.sheets(net);
        // A sheet repeated later contributes nothing: its later copy has the same rules with a
        // later source order, so every tie goes to the copy. Keep only the last occurrence.
        {
            let mut seen: HashMap<(usize, u64), Vec<usize>> = HashMap::new();
            let mut keep = vec![true; sheets.len()];
            for i in (0..sheets.len()).rev() {
                let c = seen.entry(quick_key(&sheets[i])).or_default();
                if c.iter().any(|&j| sheets[j] == sheets[i]) {
                    keep[i] = false;
                } else {
                    c.push(i);
                }
            }
            let mut k = keep.into_iter();
            sheets.retain(|_| k.next().unwrap());
        }
        let css_bytes: usize = sheets.iter().map(|s| s.len()).sum();
        // Sheets the preload scan already parsed come from its cache; the rest are parsed here,
        // in parallel when there is a lot of CSS. Source order is kept.
        let mut cached: Vec<Option<Vec<PRule>>> = sheets.iter().map(|t| prescan.take(t)).collect();
        let missing: Vec<&str> = sheets.iter().zip(&cached).filter(|(_, c)| c.is_none()).map(|(t, _)| t.as_ref()).collect();
        let mut fresh = parse_sheets(&missing).into_iter();
        let per_sheet: Vec<Vec<PRule>> = cached.iter_mut().map(|c| c.take().unwrap_or_else(|| fresh.next().unwrap_or_default())).collect();
        let mut rules: Vec<CRule> = vec![];
        let mut idx = Buckets::default();
        for (cx, prop, val, imp, spec) in per_sheet.into_iter().flatten() {
            idx.add(&cx[cx.len() - 1].1, rules.len());
            let order = rules.len();
            rules.push(CRule { cx, prop, val, imp, spec, order });
        }
        if prof {
            eprintln!("[prof] native css {:.1} ms ({} KB, {} rules)", t0.elapsed().as_secs_f64() * 1e3, css_bytes / 1024, rules.len());
        }
        let t1 = std::time::Instant::now();
        // Matching is independent per element: chunks in parallel on big documents.
        let els = self.doc.elements();
        let matched: Vec<(usize, Option<String>, Option<String>)> = if els.len() > 2000 && !rules.is_empty() {
            par_map_chunks(&els, |&el| self.match_element(el, &rules, &idx))
        } else {
            els.iter().map(|&el| self.match_element(el, &rules, &idx)).collect()
        };
        // Inheritance in document order (parents first).
        let mut out: Vec<Style> = vec![Style::default(); self.doc.nodes.len()];
        for (el, display, vis) in matched {
            let mut display = display.unwrap_or_else(|| ua_display(self.doc, el).to_string());
            if matches!(display.as_str(), "revert" | "initial" | "unset" | "revert-layer") {
                display = if display == "initial" { "inline".into() } else { ua_display(self.doc, el).to_string() };
            }
            let visible = match vis.as_deref().unwrap_or("inherit") {
                "inherit" | "unset" | "revert" => self.parent_elem(el).map(|p| out[p].visible).unwrap_or(true),
                "initial" | "visible" => true,
                _ => false,
            };
            out[el] = Style { display, visible };
        }
        if prof {
            eprintln!("[prof] native match {:.1} ms ({} elements)", t1.elapsed().as_secs_f64() * 1e3, els.len());
        }
        out
    }

    /// Winning display and visibility values for one element (author rules, then inline style).
    fn match_element(&self, el: usize, rules: &[CRule], idx: &Buckets) -> (usize, Option<String>, Option<String>) {
        let mut win: [Option<(usize, bool)>; 2] = [None, None];
        let mut apply = |ids: &Vec<usize>| {
            for &ri in ids {
                let r = &rules[ri];
                if r.prop > 1 {
                    continue; // content-visibility does not affect text
                }
                if let Some((wi, _)) = win[r.prop as usize] {
                    let w = &rules[wi];
                    if w.imp && !r.imp || (w.imp == r.imp && (w.spec > r.spec || (w.spec == r.spec && w.order > r.order))) {
                        continue;
                    }
                }
                if self.complex(el, &r.cx, r.cx.len() - 1, None) {
                    win[r.prop as usize] = Some((ri, r.imp));
                }
            }
        };
        let n = &self.doc.nodes[el];
        if !rules.is_empty() {
            apply(&idx.star);
            if let Some(v) = idx.tag.get(n.name.as_str()) {
                apply(v);
            }
            for (k, _) in &n.attrs {
                if let Some(v) = idx.attr.get(k.as_str()) {
                    apply(v);
                }
            }
            if let Some(v) = self.doc.attr(el, "id").and_then(|id| idx.id.get(id)) {
                apply(v);
            }
            if let Some(set) = &self.class_sets[el] {
                for c in set {
                    if let Some(v) = idx.cls.get(c.as_str()) {
                        apply(v);
                    }
                }
            }
        }
        let mut vals: [Option<String>; 2] = [0, 1].map(|p| win[p].map(|(ri, _)| rules[ri].val.clone()));
        if let Some(st) = self.doc.attr(el, "style") {
            for (p, v, imp) in inline_decls(st) {
                if p > 1 {
                    continue;
                }
                let cur_imp = win[p as usize].map(|w| w.1);
                if cur_imp.is_none() || cur_imp == Some(false) || imp {
                    win[p as usize] = Some((usize::MAX, imp));
                    vals[p as usize] = Some(v);
                }
            }
        }
        let [d, v] = vals;
        (el, d, v)
    }
}

/// Rules bucketed by the rightmost compound's id, class, tag or attribute (else `star`).
#[derive(Default)]
struct Buckets {
    id: HashMap<String, Vec<usize>>,
    cls: HashMap<String, Vec<usize>>,
    tag: HashMap<String, Vec<usize>>,
    attr: HashMap<String, Vec<usize>>,
    star: Vec<usize>,
}

impl Buckets {
    fn add(&mut self, last: &Compound, i: usize) {
        if let Some(id) = &last.id {
            self.id.entry(id.clone()).or_default().push(i);
        } else if let Some(c) = last.cls.first() {
            self.cls.entry(c.clone()).or_default().push(i);
        } else if let Some(t) = last.tag.as_ref().filter(|t| *t != "*") {
            self.tag.entry(t.clone()).or_default().push(i);
        } else if let Some(a) = last.attrs.first() {
            self.attr.entry(a.name.clone()).or_default().push(i);
        } else {
            self.star.push(i);
        }
    }
}

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(4)
}

/// Map each item on its own scoped thread pool slice, results in input order.
fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let n = threads().min(items.len()).max(1);
    // Spread big and small sheets: thread k takes items k, k+n, k+2n, ...
    let mut parts: Vec<Vec<(usize, R)>> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..n).map(|k| {
            let f = &f;
            s.spawn(move || {
                crate::qos::critical();
                items.iter().enumerate().skip(k).step_by(n).map(|(i, x)| (i, f(x))).collect::<Vec<_>>()
            })
        }).collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut all: Vec<(usize, R)> = parts.drain(..).flatten().collect();
    all.sort_by_key(|(i, _)| *i);
    all.into_iter().map(|(_, r)| r).collect()
}

/// Contiguous chunks in parallel, results in input order.
fn par_map_chunks<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let n = threads();
    let size = items.len().div_ceil(n).max(1);
    std::thread::scope(|s| {
        let hs: Vec<_> = items.chunks(size).map(|c| {
            let f = &f;
            s.spawn(move || c.iter().map(f).collect::<Vec<R>>())
        }).collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    })
}

#[derive(Clone, Default)]
pub struct Style {
    pub display: String,
    pub visible: bool,
}

// ------------------------------------------------------------------ text (port of agent.js)

enum Item {
    S(String),
    Br,
    N(u8),
}

const BLOCKISH: &[&str] = &["block", "flex", "grid", "list-item", "table", "table-caption", "flow-root", "table-row-group", "table-header-group", "table-footer-group"];
const NO_TEXT: &[&str] = &["input", "textarea", "select", "img", "video", "audio", "canvas", "svg", "object", "embed", "math", "meter", "progress"];

fn ws_collapse(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c') {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

impl Page<'_> {
    fn kids_of(&self, i: usize) -> std::borrow::Cow<'_, [usize]> {
        let n = &self.doc.nodes[i];
        if n.ns == Ns::Html && n.name == "details" && self.doc.attr(i, "open").is_none() {
            return self.doc.elem_kids(i).filter(|&k| self.tag(k) == "summary").take(1).collect::<Vec<_>>().into();
        }
        std::borrow::Cow::Borrowed(&n.kids)
    }

    fn collect(&self, styles: &[Style], n: usize, out: &mut Vec<Item>, vis: bool, pre: bool) {
        let node = &self.doc.nodes[n];
        match node.kind {
            Kind::Text => {
                if !vis {
                    return;
                }
                let t = if pre { node.name.clone() } else { ws_collapse(&node.name) };
                if !t.is_empty() {
                    out.push(Item::S(t));
                }
            }
            Kind::Comment => {}
            Kind::Elem => {
                let c = &styles[n];
                if c.display == "none" {
                    return;
                }
                let t = node.name.as_str();
                let v = c.visible;
                if t == "br" {
                    if v {
                        out.push(Item::Br);
                    }
                    return;
                }
                if t == "select" && node.ns == Ns::Html {
                    if !v {
                        return;
                    }
                    out.push(Item::N(1));
                    for o in self.descendants(n) {
                        if self.tag(o) == "option" {
                            let x = collapse(&self.doc.text_content(o));
                            if !x.is_empty() {
                                out.push(Item::S(x));
                                out.push(Item::N(1));
                            }
                        }
                    }
                    return;
                }
                if node.ns == Ns::Html && NO_TEXT.contains(&t) {
                    return;
                }
                if node.ns == Ns::Svg && !matches!(t, "svg" | "text" | "tspan" | "a" | "g" | "foreignObject") {
                    return;
                }
                let breaks = if t == "p" { 2 } else if BLOCKISH.contains(&c.display.as_str()) { 1 } else { 0 };
                if c.display == "table-cell" && v {
                    let p = node.parent;
                    if p != NONE && self.doc.is_elem(p) {
                        for k in self.doc.nodes[p].kids.iter().copied() {
                            if k == n {
                                break;
                            }
                            if self.doc.is_elem(k) && styles[k].display == "table-cell" {
                                out.push(Item::S("\t".into()));
                                break;
                            }
                        }
                    }
                }
                if breaks > 0 {
                    out.push(Item::N(breaks));
                }
                let mut is_pre = pre || matches!(t, "pre" | "listing" | "xmp" | "plaintext");
                if !is_pre {
                    if let Some(st) = self.doc.attr(n, "style") {
                        let l = st.to_ascii_lowercase();
                        if let Some(p) = l.find("white-space") {
                            let rest = l[p + "white-space".len()..].trim_start();
                            if let Some(r) = rest.strip_prefix(':') {
                                if r.trim_start().starts_with("pre") {
                                    is_pre = true;
                                }
                            }
                        }
                    }
                }
                for &k in self.kids_of(n).iter() {
                    self.collect(styles, k, out, v, is_pre);
                }
                if c.display == "table-row" {
                    out.push(Item::N(1));
                }
                if breaks > 0 {
                    out.push(Item::N(breaks));
                }
            }
        }
    }

    /// Visible text, as `S.agent.text()` produces it.
    pub fn text(&self, styles: &[Style]) -> String {
        let Some(root) = self.doc.root_elem() else { return String::new() };
        let mut items = vec![];
        self.collect(styles, root, &mut items, styles[root].visible, false);
        join(items)
    }
}

/// Port of joinText: block break counts collapse to their maximum, spaces trimmed around breaks.
fn join(items: Vec<Item>) -> String {
    let mut parts: Vec<String> = vec![];
    let (mut want, mut started) = (0u8, false);
    let mut last: Option<char> = None;
    for x in items {
        match x {
            Item::N(n) => {
                if started {
                    want = want.max(n);
                }
            }
            Item::Br => {
                parts.push("\n".into());
                last = Some('\n');
            }
            Item::S(s) if s == "\n" => {
                parts.push(s);
                last = Some('\n');
            }
            Item::S(s) => {
                let mut piece = s;
                if want > 0 || last == Some('\n') || last.is_none() {
                    piece = piece.trim_start_matches(' ').to_string();
                } else if last == Some(' ') && piece.starts_with(' ') {
                    piece.remove(0);
                }
                if piece.is_empty() {
                    continue;
                }
                if want > 0 {
                    if last == Some(' ') {
                        if let Some(p) = parts.last_mut() {
                            let t = p.trim_end_matches(' ').len();
                            p.truncate(t);
                        }
                    }
                    parts.push("\n".repeat(want as usize));
                    want = 0;
                }
                last = piece.chars().last();
                parts.push(piece);
                started = true;
            }
        }
    }
    let s = parts.concat();
    // JS: .replace(/ +\n/g, '\n').trim()
    let mut out = String::with_capacity(s.len());
    let mut spaces = 0usize;
    for c in s.chars() {
        if c == ' ' {
            spaces += 1;
            continue;
        }
        if c != '\n' {
            out.extend(std::iter::repeat_n(' ', spaces));
        }
        spaces = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n(' ', spaces));
    out.trim().to_string()
}
