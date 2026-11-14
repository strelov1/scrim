//! HTML parsing with html5ever into a flat arena (`Doc`). From the arena come both the op stream
//! (JSON) that the JS side turns into DOM nodes and the native read path for script-less pages.
//! Ops: `1, tag, [attrs]` HTML element open; `2, ns, tag, [attrs]` foreign (svg/math) element open;
//! `0` close; `3, text` text node; `8, text` comment. Template contents are emitted inside the template.
use html5ever::tendril::TendrilSink;
use html5ever::{ns, parse_document, parse_fragment, ParseOpts, QualName};
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use std::fmt::Write;

pub const NONE: usize = usize::MAX;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ns {
    Html,
    Svg,
    Math,
    Other,
}

pub enum Kind {
    Elem,
    Text,
    Comment,
}

pub struct Node {
    pub kind: Kind,
    pub ns: Ns,
    /// Local name for elements (html5ever's case: lowercase HTML, camelCase SVG), data for text/comments.
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub parent: usize,
    pub kids: Vec<usize>,
    /// Template contents (not children: they are never rendered).
    pub tpl: Vec<usize>,
}

pub struct Doc {
    pub nodes: Vec<Node>,
    /// Top-level nodes (the <html> element for documents, the fragment's nodes for fragments).
    pub top: Vec<usize>,
}

impl Doc {
    pub fn attr(&self, i: usize, name: &str) -> Option<&str> {
        self.nodes[i].attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    pub fn is_elem(&self, i: usize) -> bool {
        matches!(self.nodes[i].kind, Kind::Elem)
    }
    /// Element children only.
    pub fn elem_kids(&self, i: usize) -> impl Iterator<Item = usize> + '_ {
        self.nodes[i].kids.iter().copied().filter(|&k| self.is_elem(k))
    }
    pub fn root_elem(&self) -> Option<usize> {
        self.top.iter().copied().find(|&i| self.is_elem(i))
    }
    /// All elements in document order (template contents excluded).
    pub fn elements(&self) -> Vec<usize> {
        let mut out = vec![];
        let mut stack: Vec<usize> = self.top.iter().rev().copied().collect();
        while let Some(i) = stack.pop() {
            if self.is_elem(i) {
                out.push(i);
                stack.extend(self.nodes[i].kids.iter().rev());
            }
        }
        out
    }
    /// Concatenated text of all descendant text nodes (DOM textContent).
    pub fn text_content(&self, i: usize) -> String {
        let mut s = String::new();
        let mut stack = vec![i];
        while let Some(n) = stack.pop() {
            match self.nodes[n].kind {
                Kind::Text => s.push_str(&self.nodes[n].name),
                Kind::Elem => stack.extend(self.nodes[n].kids.iter().rev()),
                Kind::Comment => {}
            }
        }
        s
    }

    fn add(&mut self, h: &Handle, parent: usize) -> Option<usize> {
        let (kind, ns, name, attrs) = match &h.data {
            NodeData::Element { name, attrs, .. } => {
                let ns = if name.ns == ns!(html) { Ns::Html } else if name.ns == ns!(svg) { Ns::Svg } else if name.ns == ns!(mathml) { Ns::Math } else { Ns::Other };
                let attrs = attrs
                    .borrow()
                    .iter()
                    .map(|a| {
                        let k = match &a.name.prefix {
                            Some(p) => format!("{}:{}", p, a.name.local),
                            None => a.name.local.to_string(),
                        };
                        (k, a.value.to_string())
                    })
                    .collect();
                (Kind::Elem, ns, name.local.to_string(), attrs)
            }
            NodeData::Text { contents } => (Kind::Text, Ns::Html, contents.borrow().to_string(), vec![]),
            NodeData::Comment { contents } => (Kind::Comment, Ns::Html, contents.to_string(), vec![]),
            _ => return None,
        };
        let id = self.nodes.len();
        self.nodes.push(Node { kind, ns, name, attrs, parent, kids: vec![], tpl: vec![] });
        if let NodeData::Element { template_contents, .. } = &h.data {
            if let Some(t) = template_contents.borrow().as_ref() {
                for c in t.children.borrow().iter() {
                    if let Some(k) = self.add(c, id) {
                        self.nodes[id].tpl.push(k);
                    }
                }
            }
        }
        for c in h.children.borrow().iter() {
            if let Some(k) = self.add(c, id) {
                self.nodes[id].kids.push(k);
            }
        }
        Some(id)
    }

    fn from_handles(hs: &[Handle]) -> Doc {
        let mut d = Doc { nodes: Vec::new(), top: vec![] };
        for h in hs {
            if let Some(i) = d.add(h, NONE) {
                d.top.push(i);
            }
        }
        d
    }

    /// The op stream for the JS DOM builder.
    pub fn ops_json(&self) -> String {
        let mut out = String::with_capacity(self.nodes.len() * 24 + 1024);
        out.push('[');
        for &i in &self.top {
            self.emit(i, &mut out);
        }
        if out.ends_with(',') {
            out.pop();
        }
        out.push(']');
        out
    }

    fn emit(&self, i: usize, out: &mut String) {
        let n = &self.nodes[i];
        match n.kind {
            Kind::Elem => {
                match n.ns {
                    Ns::Html => out.push_str("1,"),
                    Ns::Svg => out.push_str("2,\"svg\","),
                    Ns::Math => out.push_str("2,\"math\","),
                    Ns::Other => out.push_str("2,\"\","),
                }
                push_str(out, &n.name);
                out.push_str(",[");
                for (k, (a, v)) in n.attrs.iter().enumerate() {
                    if k > 0 {
                        out.push(',');
                    }
                    push_str(out, a);
                    out.push(',');
                    push_str(out, v);
                }
                out.push_str("],");
                for &c in n.tpl.iter().chain(n.kids.iter()) {
                    self.emit(c, out);
                }
                out.push_str("0,");
            }
            Kind::Text => {
                out.push_str("3,");
                push_str(out, &n.name);
                out.push(',');
            }
            Kind::Comment => {
                out.push_str("8,");
                push_str(out, &n.name);
                out.push(',');
            }
        }
    }
}

fn push_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                // Pure-ASCII output: the JS engine can take it as one-byte data without transcoding.
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    let _ = write!(out, "\\u{:04x}", u);
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ------------------------------------------------------------------ html5ever sink straight into an arena

use html5ever::tendril::StrTendril;
use html5ever::tree_builder::{ElemName, ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::{Attribute, LocalName, Namespace};
use std::borrow::Cow;
use std::cell::RefCell;

enum SData {
    Document,
    Frag,
    Elem { name: QualName, attrs: Vec<Attribute>, tpl: usize },
    Text(StrTendril),
    Comment(StrTendril),
    Other,
}

struct SNode {
    data: SData,
    parent: usize,
    kids: Vec<usize>,
}

/// Tree builder target: plain indices into one vector, no reference counting per node.
struct Sink {
    nodes: RefCell<Vec<SNode>>,
}

#[derive(Debug)]
struct OwnedName(QualName);
impl ElemName for OwnedName {
    fn ns(&self) -> &Namespace {
        &self.0.ns
    }
    fn local_name(&self) -> &LocalName {
        &self.0.local
    }
}

impl Sink {
    fn new_node(&self, data: SData) -> usize {
        let mut n = self.nodes.borrow_mut();
        n.push(SNode { data, parent: NONE, kids: vec![] });
        n.len() - 1
    }
    fn detach(nodes: &mut [SNode], c: usize) {
        let p = nodes[c].parent;
        if p != NONE {
            nodes[p].kids.retain(|&k| k != c);
            nodes[c].parent = NONE;
        }
    }
    /// Insert `child` into `parent` at `pos` (end when None), merging adjacent text.
    fn insert(&self, parent: usize, pos: Option<usize>, child: NodeOrText<usize>) {
        let mut nodes = self.nodes.borrow_mut();
        let at = pos.unwrap_or(nodes[parent].kids.len());
        match child {
            NodeOrText::AppendText(t) => {
                if at > 0 {
                    let prev = nodes[parent].kids[at - 1];
                    if let SData::Text(ref mut x) = nodes[prev].data {
                        x.push_tendril(&t);
                        return;
                    }
                }
                nodes.push(SNode { data: SData::Text(t), parent, kids: vec![] });
                let id = nodes.len() - 1;
                nodes[parent].kids.insert(at, id);
            }
            NodeOrText::AppendNode(c) => {
                Self::detach(&mut nodes, c);
                let at = pos.map(|_| at).unwrap_or(nodes[parent].kids.len()).min(nodes[parent].kids.len());
                nodes[c].parent = parent;
                nodes[parent].kids.insert(at, c);
            }
        }
    }
}

impl TreeSink for Sink {
    type Handle = usize;
    type Output = Self;
    type ElemName<'a> = OwnedName where Self: 'a;
    fn finish(self) -> Self {
        self
    }
    fn parse_error(&self, _msg: Cow<'static, str>) {}
    fn get_document(&self) -> usize {
        0
    }
    fn elem_name<'a>(&'a self, target: &'a usize) -> OwnedName {
        match &self.nodes.borrow()[*target].data {
            SData::Elem { name, .. } => OwnedName(name.clone()),
            _ => panic!("not an element"),
        }
    }
    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> usize {
        let tpl = if flags.template { self.new_node(SData::Frag) } else { NONE };
        self.new_node(SData::Elem { name, attrs, tpl })
    }
    fn create_comment(&self, text: StrTendril) -> usize {
        self.new_node(SData::Comment(text))
    }
    fn create_pi(&self, _target: StrTendril, _data: StrTendril) -> usize {
        self.new_node(SData::Other)
    }
    fn append(&self, parent: &usize, child: NodeOrText<usize>) {
        self.insert(*parent, None, child);
    }
    fn append_based_on_parent_node(&self, element: &usize, prev: &usize, child: NodeOrText<usize>) {
        if self.nodes.borrow()[*element].parent != NONE {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev, child);
        }
    }
    fn append_doctype_to_document(&self, _n: StrTendril, _p: StrTendril, _s: StrTendril) {}
    fn get_template_contents(&self, target: &usize) -> usize {
        match &self.nodes.borrow()[*target].data {
            SData::Elem { tpl, .. } => *tpl,
            _ => panic!("not a template"),
        }
    }
    fn same_node(&self, x: &usize, y: &usize) -> bool {
        x == y
    }
    fn set_quirks_mode(&self, _mode: QuirksMode) {}
    fn append_before_sibling(&self, sibling: &usize, new_node: NodeOrText<usize>) {
        let (parent, pos) = {
            let nodes = self.nodes.borrow();
            let p = nodes[*sibling].parent;
            (p, nodes[p].kids.iter().position(|&k| k == *sibling).unwrap())
        };
        if let NodeOrText::AppendNode(c) = &new_node {
            // Detaching first may shift the sibling's index.
            let mut nodes = self.nodes.borrow_mut();
            Self::detach(&mut nodes, *c);
            let pos = nodes[parent].kids.iter().position(|&k| k == *sibling).unwrap();
            nodes[*c].parent = parent;
            nodes[parent].kids.insert(pos, *c);
            return;
        }
        self.insert(parent, Some(pos), new_node);
    }
    fn add_attrs_if_missing(&self, target: &usize, attrs: Vec<Attribute>) {
        if let SData::Elem { attrs: ref mut have, .. } = self.nodes.borrow_mut()[*target].data {
            for a in attrs {
                if !have.iter().any(|h| h.name == a.name) {
                    have.push(a);
                }
            }
        }
    }
    fn remove_from_parent(&self, target: &usize) {
        Self::detach(&mut self.nodes.borrow_mut(), *target);
    }
    fn reparent_children(&self, node: &usize, new_parent: &usize) {
        let mut nodes = self.nodes.borrow_mut();
        let kids = std::mem::take(&mut nodes[*node].kids);
        for &k in &kids {
            nodes[k].parent = *new_parent;
        }
        nodes[*new_parent].kids.extend(kids);
    }
}

impl Sink {
    /// Convert to the public arena: names and text as Strings, template contents split out.
    fn into_doc(self) -> Doc {
        let nodes = self.nodes.into_inner();
        let mut d = Doc { nodes: Vec::with_capacity(nodes.len()), top: vec![] };
        fn conv(src: &[SNode], i: usize, parent: usize, d: &mut Doc) -> Option<usize> {
            let (kind, ns, name, attrs, tpl) = match &src[i].data {
                SData::Elem { name, attrs, tpl } => {
                    let ns = if name.ns == ns!(html) { Ns::Html } else if name.ns == ns!(svg) { Ns::Svg } else if name.ns == ns!(mathml) { Ns::Math } else { Ns::Other };
                    let attrs = attrs.iter().map(|a| {
                        let k = match &a.name.prefix {
                            Some(p) => format!("{}:{}", p, a.name.local),
                            None => a.name.local.to_string(),
                        };
                        (k, a.value.to_string())
                    }).collect();
                    (Kind::Elem, ns, name.local.to_string(), attrs, *tpl)
                }
                SData::Text(t) => (Kind::Text, Ns::Html, t.to_string(), vec![], NONE),
                SData::Comment(t) => (Kind::Comment, Ns::Html, t.to_string(), vec![], NONE),
                _ => return None,
            };
            let id = d.nodes.len();
            d.nodes.push(Node { kind, ns, name, attrs, parent, kids: vec![], tpl: vec![] });
            if tpl != NONE {
                for &k in &src[tpl].kids {
                    if let Some(c) = conv(src, k, id, d) {
                        d.nodes[id].tpl.push(c);
                    }
                }
            }
            for &k in &src[i].kids {
                if let Some(c) = conv(src, k, id, d) {
                    d.nodes[id].kids.push(c);
                }
            }
            Some(id)
        }
        for &k in &nodes[0].kids {
            if matches!(nodes[k].data, SData::Elem { .. }) {
                if let Some(c) = conv(&nodes, k, NONE, &mut d) {
                    d.top.push(c);
                }
            }
        }
        d
    }
}

// ------------------------------------------------------------------ raw <style> text, outside html5ever

pub fn find_ci(hay: &[u8], needle: &[u8]) -> Option<usize> {
    let first = needle[0];
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        i += hay[i..].iter().position(|&c| c == first)?;
        if i + needle.len() > hay.len() {
            return None;
        }
        if hay[i..i + needle.len()].eq_ignore_ascii_case(needle) {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Raw text as the tokenizer delivers it: newlines normalized, NUL replaced.
pub fn raw_text(s: &str) -> String {
    if !s.contains(['\r', '\0']) {
        return s.to_string();
    }
    s.replace("\r\n", "\n").replace('\r', "\n").replace('\0', "\u{fffd}")
}

/// Parse a whole document into the arena (top = the <html> element).
pub fn parse_document_arena(html: &str) -> Doc {
    parse_plain(html)
}

/// Incremental document parser fed with raw bytes (UTF-8, lossy) as they arrive.
pub struct StreamParser(html5ever::tendril::stream::Utf8LossyDecoder<html5ever::Parser<Sink>>);

impl Default for StreamParser {
    fn default() -> Self {
        let sink = Sink { nodes: RefCell::new(vec![SNode { data: SData::Document, parent: NONE, kids: vec![] }]) };
        StreamParser(parse_document(sink, ParseOpts::default()).from_utf8())
    }
}

impl StreamParser {
    pub fn feed(&mut self, bytes: &[u8]) {
        self.0.process(html5ever::tendril::ByteTendril::from_slice(bytes));
    }
    pub fn finish(self) -> Doc {
        self.0.finish().into_doc()
    }
}

fn parse_plain(html: &str) -> Doc {
    let sink = Sink { nodes: RefCell::new(vec![SNode { data: SData::Document, parent: NONE, kids: vec![] }]) };
    parse_document(sink, ParseOpts::default()).one(html).into_doc()
}


/// Parse a whole document; returns the op stream of the <html> element.
pub fn parse_doc(html: &str) -> String {
    parse_document_arena(html).ops_json()
}

/// Parse a fragment in the context of an element (innerHTML, insertAdjacentHTML).
pub fn parse_frag(html: &str, context: &str) -> String {
    let ctx = QualName::new(None, ns!(html), context.to_ascii_lowercase().as_str().into());
    let dom = parse_fragment(RcDom::default(), ParseOpts::default(), ctx, vec![], false).one(html);
    // The fragment parser puts the result under a synthetic <html> root.
    let kids: Vec<Handle> = dom.document.children.borrow().first().map(|r| r.children.borrow().clone()).unwrap_or_default();
    Doc::from_handles(&kids).ops_json()
}
