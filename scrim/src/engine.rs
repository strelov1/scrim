//! Page lifecycle and event loop: one QuickJS runtime per document, host functions for the JS
//! side (network, parsing, cookies, history), and a settle loop that runs timers in virtual time.
use crate::{css, html, net::Net};
use crate::js::Js;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::rc::Rc;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

/// Settle budget: how far timers may be fast-forwarded per settle, and the real-time cap.
pub const VIRTUAL_BUDGET_MS: f64 = 5000.0;
pub const REAL_BUDGET_MS: u64 = 10000;

pub struct FetchDone {
    gen: u64,
    seq: u64,
    frame: usize,
    id: f64,
    meta: String,
    body: String,
}

#[derive(Clone, Debug)]
pub struct Nav {
    pub url: String,
    pub method: String,
    pub body: Option<String>,
    pub content_type: Option<String>,
    pub replace: bool,
    pub reload_index: Option<usize>,
}

#[derive(Clone)]
struct Entry {
    url: String,
    doc: u64,
    state: String,
}

pub struct Host {
    pub net: Net,
    tx: Sender<FetchDone>,
    gen: u64,
    inflight: Vec<usize>,
    pub pending_nav: Option<Nav>,
    pending_traverse: Option<i64>,
    pending_frames: Vec<(usize, String)>,
    clock_start: Instant,
    skipped: f64,
    epoch_ms: f64,
    history: Vec<Entry>,
    hindex: usize,
    pub console: Vec<String>,
    storage: HashMap<String, String>,
    pub dialog_accept: bool,
    /// Session mode: virtual-only clock, seeded Math.random, responses delivered in request order,
    /// so replaying a document's action log reproduces it exactly.
    pub deterministic: bool,
    pub seed: f64,
    seq: u64,
    outstanding: VecDeque<u64>,
    /// State captured when the current document's navigation started (session mode).
    pub doc_start: Option<serde_json::Value>,
    pub restoring: bool,
}

impl Host {
    pub fn gen_id(&self) -> u64 {
        self.gen
    }
    pub fn epoch(&self) -> f64 {
        self.epoch_ms
    }
    pub fn set_epoch(&mut self, e: Option<f64>) {
        if let Some(e) = e {
            self.epoch_ms = e;
        }
    }
    pub fn now(&self) -> f64 {
        if self.deterministic {
            return self.skipped;
        }
        self.clock_start.elapsed().as_secs_f64() * 1000.0 + self.skipped
    }
}

pub struct Frame {
    url: String,
}

pub struct Session {
    pub host: Rc<RefCell<Host>>,
    rx: Receiver<FetchDone>,
    js: RefCell<Option<Js>>,
    pub frames: Vec<Frame>,
    pub url: String,
    pub status: u16,
    buffer: BTreeMap<u64, FetchDone>,
    /// A loaded document that runs no JavaScript and has not needed a JS DOM yet.
    lazy: Option<Lazy>,
}

/// A script-free document kept as the parsed arena; the JS DOM is built only on first need.
struct Lazy {
    doc: html::Doc,
    referrer: String,
    text: Option<String>,
    prescan: Option<crate::native::Prescan>,
}

impl Session {
    pub fn new() -> Session {
        let (tx, rx) = channel();
        let host = Host {
            net: Net::new(),
            tx,
            gen: 0,
            inflight: vec![],
            pending_nav: None,
            pending_traverse: None,
            pending_frames: vec![],
            clock_start: Instant::now(),
            skipped: 0.0,
            epoch_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0,
            history: vec![],
            hindex: 0,
            console: vec![],
            storage: HashMap::new(),
            dialog_accept: true,
            deterministic: false,
            seed: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos() as f64,
            seq: 0,
            outstanding: VecDeque::new(),
            doc_start: None,
            restoring: false,
        };
        Session { host: Rc::new(RefCell::new(host)), rx, js: RefCell::new(None), frames: vec![], url: "about:blank".into(), status: 0, buffer: BTreeMap::new(), lazy: None }
    }

    /// Load a document (navigation). Blocks on the network; does not settle.
    pub fn navigate(&mut self, nav: Nav) -> Result<(), String> {
        let cur = self.current_url();
        let base = Url::parse(&cur).ok();
        let target = match base.as_ref().and_then(|b| b.join(&nav.url).ok()).or_else(|| Url::parse(&nav.url).ok()) {
            Some(u) => u,
            None => return Err(format!("bad url {}", nav.url)),
        };
        // Same-document fragment navigation.
        if nav.method == "GET" && !self.frames.is_empty() && nav.reload_index.is_none() {
            if let Ok(cur) = Url::parse(&cur) {
                let mut a = cur.clone();
                let mut b = target.clone();
                a.set_fragment(None);
                b.set_fragment(None);
                if a == b && target.fragment().is_some() {
                    self.url = target.to_string();
                    let u = self.url.clone();
                    self.call(0, "__scrim.hashNav", &[u])?;
                    return Ok(());
                }
            }
        }
        if self.host.borrow().deterministic && !self.host.borrow().restoring {
            let state = self.export_state();
            let net = self.host.borrow().net.clone();
            if let Some(r) = &net.recorder {
                r.lock().unwrap().entries.clear();
            }
            self.host.borrow_mut().doc_start = Some(serde_json::json!({
                "state": state, "referrer": cur,
                "nav": {"url": target.as_str(), "method": nav.method, "body": nav.body, "content_type": nav.content_type,
                        "replace": nav.replace, "reload_index": nav.reload_index},
            }));
        }
        let net = self.host.borrow().net.clone();
        let mut headers = vec![];
        if let Some(ct) = &nav.content_type {
            headers.push(("content-type".to_string(), ct.clone()));
        }
        headers.push(("accept".to_string(), "text/html,application/xhtml+xml,*/*;q=0.8".to_string()));
        // Fetch and parse on a worker thread while this thread prepares a JS context (dropped
        // again if the page turns out to run no JavaScript); start subresource loads at once.
        let prof = std::env::var_os("SCRIM_PROFILE").is_some();
        let tf = Instant::now();
        *self.js.borrow_mut() = None; // drop the previous document's heap before making a new one
        let (hint_tx, hint_rx) = channel::<bool>();
        let worker = {
            let (net, target, method, body) = (net.clone(), target.to_string(), nav.method.clone(), nav.body.clone());
            std::thread::spawn(move || {
                crate::qos::critical();
                // The parser runs on its own thread and consumes the body while it downloads.
                let (ctx, crx) = channel::<Vec<u8>>();
                let parser = std::thread::spawn(move || {
                    crate::qos::critical();
                    let mut p = html::StreamParser::default();
                    for c in crx {
                        p.feed(&c);
                    }
                    p.finish()
                });
                let tp = Instant::now();
                let mut hinted = false;
                // The style preload scan also runs beside the download, on its own thread.
                let (stx, srx) = channel::<Vec<u8>>();
                let pre = std::thread::spawn(move || {
                    crate::qos::critical();
                    let mut p = crate::native::Prescanner::default();
                    for c in srx {
                        p.feed(&c);
                    }
                    p
                });
                let mut on_chunk = |c: &[u8]| {
                    let _ = stx.send(c.to_vec());
                    if !hinted && crate::html::find_ci(c, b"<script").is_some() {
                        hinted = true;
                        let _ = hint_tx.send(true);
                    }
                    let _ = ctx.send(c.to_vec());
                };
                let fetched = net.fetch_streaming(&method, &target, &headers, body.map(|b| b.into_bytes()), &mut on_chunk);
                if std::env::var_os("SCRIM_PROFILE").is_some() { eprintln!("[prof] body received {:.1} ms", tp.elapsed().as_secs_f64() * 1e3); }
                drop(on_chunk);
                drop(ctx);
                drop(stx);
                let _ = hint_tx.send(hinted); // no-op if already sent
                // Body complete: start the style preload scan while the parser finishes.
                let (final_url, status, html_src, streamed_ok) = match fetched {
                    Ok(r) => {
                        let ct = r.header("content-type").unwrap_or("text/html").to_ascii_lowercase();
                        let (url, status) = (r.url.clone(), r.status);
                        let text = r.into_text();
                        if ct.contains("html") || ct.is_empty() {
                            (url, status, text, true)
                        } else {
                            (url, status, format!("<pre>{}</pre>", escape(&text)), false)
                        }
                    }
                    Err(e) => (target.clone(), 0, format!("<p>Navigation failed: {}</p>", escape(&e)), false),
                };
                let streamed = parser.join().map_err(|_| "parser panicked".to_string());
                let doc = if streamed_ok { streamed } else { Ok(html::parse_document_arena(&html_src)) };
                let scan = match pre.join() {
                    Ok(p) if streamed_ok => p.finish(),
                    _ => Default::default(),
                };
                let doc = doc?;
                if std::env::var_os("SCRIM_PROFILE").is_some() { eprintln!("[prof] body+parse done {:.1} ms", tp.elapsed().as_secs_f64() * 1e3); }
                for u in crate::native::subresources(&doc, &final_url) {
                    net.prefetch(u);
                }
                Ok::<_, String>((final_url, status, doc, html_src.len(), tp.elapsed(), scan))
            })
        };
        let spec_js = if hint_rx.recv().unwrap_or(true) {
            Some(Js::quick(self.host.clone(), net.clone()).and_then(|mut js| js.add_frame(0).map(|_| js)))
        } else {
            None
        };
        if prof { eprintln!("[prof] js context (parallel) {:.1} ms", tf.elapsed().as_secs_f64() * 1e3); }
        let (final_url, status, doc, html_len, parse_t, scan) = worker.join().map_err(|_| "document worker panicked".to_string())??;
        if prof { eprintln!("[prof] fetch+parse {:.1} ms (streamed {:.1} ms, {} bytes, {} nodes)", tf.elapsed().as_secs_f64() * 1e3, parse_t.as_secs_f64() * 1e3, html_len, doc.nodes.len()); }
        // History entry.
        {
            let mut h = self.host.borrow_mut();
            h.gen += 1;
            h.inflight.clear();
            h.pending_frames.clear();
            h.outstanding.clear();
            let doc = h.gen;
            let e = Entry { url: final_url.clone(), doc, state: "null".into() };
            if let Some(i) = nav.reload_index {
                h.history[i] = e;
                h.hindex = i;
            } else if nav.replace && !h.history.is_empty() {
                let i = h.hindex;
                h.history[i] = e;
            } else {
                let i = if h.history.is_empty() { 0 } else { h.hindex + 1 };
                h.history.truncate(i);
                h.history.push(e);
                h.hindex = i;
            }
        }
        let referrer = cur;
        self.frames.clear();
        self.lazy = None;
        self.url = final_url.clone();
        self.status = status;
        self.frames.push(Frame { url: final_url.clone() });
        if std::env::var_os("SCRIM_NO_NATIVE").is_none() && crate::native::script_free(&doc) {
            // No JavaScript runs while loading: keep the tree, start no JS engine.
            let prescan = Some(scan);
            self.lazy = Some(Lazy { doc, referrer, text: None, prescan });
            return Ok(());
        }
        // A document that loads megabytes of JavaScript runs on V8.
        let tw = Instant::now();
        let mut ready = spec_js.transpose()?;
        let weight = crate::native::script_bytes(&doc, &final_url, &net);
        if std::env::var_os("SCRIM_PROFILE").is_some() {
            eprintln!("[prof] js context + script sizes {:.1} ms ({weight} bytes)", tw.elapsed().as_secs_f64() * 1e3);
        }
        if weight > crate::js::HEAVY_JS_BYTES {
            let mut js = Js::for_weight(self.host.clone(), net.clone(), weight)?;
            js.add_frame(0)?;
            ready = Some(js);
        }
        self.start_js(doc, &referrer, ready)
    }

    /// Build the JS DOM for the current document (at load, or later for a lazy one).
    fn start_js(&mut self, doc: html::Doc, referrer: &str, ready: Option<Js>) -> Result<(), String> {
        let net = self.host.borrow().net.clone();
        let prof = std::env::var_os("SCRIM_PROFILE").is_some();
        let js = match ready {
            Some(js) => js,
            None => {
                let t = Instant::now();
                let mut js = Js::quick(self.host.clone(), net)?;
                js.add_frame(0)?;
                if prof { eprintln!("[prof] runtime+bundle {:.1} ms", t.elapsed().as_secs_f64() * 1e3); }
                js
            }
        };
        *self.js.borrow_mut() = Some(js);
        let t = Instant::now();
        self.call(0, "__scrim.boot", &[self.url.clone(), referrer.to_string()])?;
        // Only one copy of the tree at a time: the arena goes before the JS DOM is built, and
        // the build's temporaries are collected right after.
        let ops = doc.ops_json();
        drop(doc);
        self.call(0, "__scrim.load", &[ops])?;
        if let Some(js) = self.js.borrow_mut().as_mut() {
            js.collect_garbage();
        }
        if prof { eprintln!("[prof] build+scripts {:.1} ms", t.elapsed().as_secs_f64() * 1e3); }
        Ok(())
    }

    /// Turn a lazy document into a live JS one (first command that needs the DOM).
    fn materialize(&mut self) -> Result<(), String> {
        if let Some(l) = self.lazy.take() {
            self.start_js(l.doc, &l.referrer, None)?;
            self.settle_js()?;
        }
        Ok(())
    }

    /// Visible text from the native path, without a JS engine (lazy documents only).
    fn native_text(&mut self) -> Option<String> {
        let net = self.host.borrow().net.clone();
        let url = self.url.clone();
        let l = self.lazy.as_mut()?;
        if l.text.is_none() {
            let t = Instant::now();
            let (page, styles) = crate::native::Page::new(&l.doc, &url, &net, l.prescan.take().unwrap_or_default());
            l.text = Some(page.text(&styles));
            if std::env::var_os("SCRIM_PROFILE").is_some() { eprintln!("[prof] native cascade+text {:.1} ms", t.elapsed().as_secs_f64() * 1e3); }
        }
        l.text.clone()
    }

    /// Call a dotted JS function path with string args; returns its result as a string.
    pub fn call(&mut self, frame: usize, path: &str, args: &[String]) -> Result<String, String> {
        self.materialize()?;
        let mut js = self.js.borrow_mut();
        js.as_mut().ok_or("no page")?.call(frame, path, args)
    }

    fn run_jobs(&self) {
        let errs = match self.js.borrow_mut().as_mut() {
            Some(js) => js.run_jobs(),
            None => return,
        };
        for e in errs {
            self.host.borrow_mut().console.push(format!("[error] job: {e}"));
        }
    }

    fn load_frames(&mut self) -> Result<(), String> {
        let pending: Vec<(usize, String)> = std::mem::take(&mut self.host.borrow_mut().pending_frames);
        for (id, src) in pending {
            let url = match Url::parse(&self.url).and_then(|b| b.join(&src)) {
                Ok(u) => u.to_string(),
                Err(_) => continue,
            };
            let net = self.host.borrow().net.clone();
            let html_src = net.fetch("GET", &url, &[], None).map(|r| r.text()).unwrap_or_default();
            let idx = self.frames.len();
            match self.js.borrow_mut().as_mut() {
                Some(js) => js.add_frame(idx)?,
                None => break,
            }
            self.frames.push(Frame { url: url.clone() });
            let referrer = self.url.clone();
            self.call(idx, "__scrim.boot", &[url, referrer])?;
            self.call(idx, "__scrim.load", &[html::parse_doc(&html_src)])?;
            self.call(0, "__scrim.frameLoaded", &[id.to_string(), idx.to_string()])?;
        }
        Ok(())
    }

    fn traverse(&mut self, delta: i64) -> Result<(), String> {
        let (target, same_doc) = {
            let h = self.host.borrow();
            let i = h.hindex as i64 + delta;
            if i < 0 || i as usize >= h.history.len() {
                return Ok(());
            }
            let e = h.history[i as usize].clone();
            (i as usize, e.doc == h.gen)
        };
        let e = self.host.borrow().history[target].clone();
        if same_doc {
            self.host.borrow_mut().hindex = target;
            self.url = e.url.clone();
            self.call(0, "__scrim.popstate", &[e.url, e.state])?;
            Ok(())
        } else {
            self.navigate(Nav { url: e.url, method: "GET".into(), body: None, content_type: None, replace: false, reload_index: Some(target) })
        }
    }

    /// Run the page until it is quiet: microtasks, network completions, timers (fast-forwarded
    /// up to VIRTUAL_BUDGET_MS), navigations and frames.
    pub fn settle(&mut self) -> Result<(), String> {
        if self.lazy.is_some() {
            return Ok(()); // no JavaScript, nothing pending
        }
        self.settle_js()
    }

    fn settle_js(&mut self) -> Result<(), String> {
        let real0 = Instant::now();
        let mut v0 = self.host.borrow().now();
        let prof = std::env::var_os("SCRIM_PROFILE").is_some();
        if prof {
            let _ = self.call(0, "__scrim.agent.eval", &["__scrim.profiling = true".into()]);
            // SCRIM_DOMPROF=<file>: a script that wraps DOM methods to time them (profiling only).
            if let Some(f) = std::env::var_os("SCRIM_DOMPROF") {
                if let Ok(src) = std::fs::read_to_string(f) {
                    let _ = self.call(0, "__scrim.agent.eval", &[src]);
                }
            }
        }
        let mut acc = [0f64; 5]; // jobs, pump, due, wait, iterations
        let mut tick = Instant::now();
        fn lap(acc: &mut [f64; 5], i: usize, t: &mut Instant) {
            acc[i] += t.elapsed().as_secs_f64() * 1e3;
            *t = Instant::now();
        }
        let result = (|| -> Result<(), String> {
        while real0.elapsed() < Duration::from_millis(REAL_BUDGET_MS) {
            acc[4] += 1.0;
            tick = Instant::now();
            self.run_jobs();
            lap(&mut acc, 0, &mut tick);
            let nav = self.host.borrow_mut().pending_nav.take();
            if let Some(nav) = nav {
                self.navigate(nav)?;
                v0 = self.host.borrow().now();
                continue;
            }
            let trav = self.host.borrow_mut().pending_traverse.take();
            if let Some(d) = trav {
                self.traverse(d)?;
                v0 = self.host.borrow().now();
                continue;
            }
            if !self.host.borrow().pending_frames.is_empty() {
                self.load_frames()?;
                continue;
            }
            // Network completions.
            let delivered = self.pump(None);
            lap(&mut acc, 1, &mut tick);
            if delivered {
                continue;
            }
            // One macrotask per frame.
            let now = self.host.borrow().now();
            let mut next = f64::INFINITY;
            let mut ran = false;
            for i in 0..self.frames.len() {
                let r: f64 = self.call(i, "__scrim.runDue", &[now.to_string()])?.parse().unwrap_or(-1.0);
                if r == -2.0 {
                    ran = true;
                } else if r >= 0.0 {
                    next = next.min(r);
                }
            }
            lap(&mut acc, 2, &mut tick);
            if ran {
                continue;
            }
            let inflight: usize = self.host.borrow().inflight.iter().sum();
            if inflight > 0 {
                let wait = if next.is_finite() && !self.host.borrow().deterministic { (next - now).clamp(1.0, 50.0) } else { 50.0 };
                self.pump(Some(Duration::from_millis(wait as u64)));
                lap(&mut acc, 3, &mut tick);
                continue;
            }
            if next.is_finite() && next - v0 <= VIRTUAL_BUDGET_MS {
                let mut h = self.host.borrow_mut();
                let n = h.now();
                if next > n {
                    h.skipped += next - n;
                }
                continue;
            }
            break;
        }
        Ok(())
        })();
        if prof {
            let _ = self.call(0, "__scrim.agent.eval", &["__scrim.profiling = false".into()]);
            if let Ok(top) = self.call(0, "__scrim.profDump", &[]) {
                eprintln!("[prof] slowest macrotasks:\n{top}");
            }
            if std::env::var_os("SCRIM_DOMPROF").is_some() {
                if let Ok(top) = self.call(0, "__scrim.domProfDump", &[]) {
                    eprintln!("[prof] DOM time by method (self, inclusive, calls):\n{top}");
                }
            }
            eprintln!("[prof] settle: jobs {:.1} ms, deliver {:.1} ms, timers {:.1} ms, waiting on network {:.1} ms, {} rounds, virtual time skipped {:.0} ms", acc[0], acc[1], acc[2], acc[3], acc[4], self.host.borrow().skipped);
        }
        result
    }

    /// Receive finished requests (waiting up to `block` when none is ready) and deliver them.
    /// Deterministic mode delivers strictly in request order. Returns whether anything was delivered.
    fn pump(&mut self, block: Option<Duration>) -> bool {
        let mut got = false;
        while let Ok(d) = self.rx.try_recv() {
            self.buffer.insert(d.seq, d);
            got = true;
        }
        if !got {
            if let Some(b) = block {
                if let Ok(d) = self.rx.recv_timeout(b) {
                    self.buffer.insert(d.seq, d);
                }
            }
        }
        let gen = self.host.borrow().gen;
        self.buffer.retain(|_, d| d.gen == gen);
        let mut delivered = false;
        if self.host.borrow().deterministic {
            loop {
                let head = self.host.borrow().outstanding.front().copied();
                let Some(seq) = head else { break };
                let Some(d) = self.buffer.remove(&seq) else { break };
                self.host.borrow_mut().outstanding.pop_front();
                delivered |= self.deliver(d);
                self.run_jobs();
            }
        } else {
            for (_, d) in std::mem::take(&mut self.buffer) {
                delivered |= self.deliver(d);
            }
        }
        delivered
    }

    /// Cookies, storage and history: what a session file carries between processes.
    pub fn export_state(&self) -> serde_json::Value {
        let h = self.host.borrow();
        let jar = h.net.jar.lock().unwrap().to_value();
        serde_json::json!({
            "jar": jar, "storage": h.storage, "gen": h.gen, "hindex": h.hindex,
            "history": h.history.iter().map(|e| serde_json::json!([e.url, e.doc, e.state])).collect::<Vec<_>>(),
        })
    }

    pub fn import_state(&mut self, v: &serde_json::Value) {
        let mut h = self.host.borrow_mut();
        *h.net.jar.lock().unwrap() = crate::net::Jar::from_value(&v["jar"]);
        h.storage = v["storage"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()).unwrap_or_default();
        h.gen = v["gen"].as_u64().unwrap_or(0);
        h.hindex = v["hindex"].as_u64().unwrap_or(0) as usize;
        h.history = v["history"].as_array().into_iter().flatten()
            .map(|e| Entry { url: e[0].as_str().unwrap_or("").into(), doc: e[1].as_u64().unwrap_or(0), state: e[2].as_str().unwrap_or("null").into() })
            .collect();
    }

    fn deliver(&mut self, d: FetchDone) -> bool {
        {
            let mut h = self.host.borrow_mut();
            if d.gen != h.gen {
                return false;
            }
            if let Some(n) = h.inflight.get_mut(d.frame) {
                *n = n.saturating_sub(1);
            }
        }
        if d.frame < self.frames.len() {
            let _ = self.call(d.frame, "__scrim.onFetch", &[d.id.to_string(), d.meta, d.body]);
            return true;
        }
        false
    }

    /// Visible text of the page, iframes inlined at their position.
    pub fn text(&mut self, fname: &str) -> Result<String, String> {
        if fname == "__scrim.agent.text" {
            if let Some(t) = self.native_text() {
                return Ok(t);
            }
        }
        let mut t = self.call(0, fname, &[])?;
        for i in 1..self.frames.len() {
            let ft = self.call(i, fname, &[])?;
            t = t.replace(&format!("\u{1}F{i}\u{1}"), &ft);
        }
        Ok(t)
    }

    /// The document URL as the page sees it (pushState and fragment changes included).
    pub fn current_url(&mut self) -> String {
        if self.lazy.is_some() || self.frames.is_empty() {
            return self.url.clone();
        }
        match self.call(0, "__scrim.agent.url", &[]) {
            Ok(u) if !u.is_empty() => u,
            _ => self.url.clone(),
        }
    }

    pub fn frame_urls(&self) -> Vec<String> {
        self.frames.iter().map(|f| f.url.clone()).collect()
    }
}

/// Arguments arrive as strings; JS null/undefined arrive as "\u{0}".
pub struct Args<'a>(pub &'a [String]);
impl Args<'_> {
    fn s(&self, i: usize) -> String {
        self.opt(i).unwrap_or_default()
    }
    fn opt(&self, i: usize) -> Option<String> {
        self.0.get(i).filter(|v| v.as_str() != "\u{0}").cloned()
    }
    fn f(&self, i: usize) -> f64 {
        self.0.get(i).and_then(|v| v.parse().ok()).unwrap_or(0.0)
    }
    fn b(&self, i: usize) -> bool {
        self.0.get(i).is_some_and(|v| v == "true")
    }
}

pub enum Ret {
    Undef,
    S(String),
    N(f64),
    B(bool),
    List(Vec<String>),
}

/// Every host function the JS side calls, for both JS engines.
pub fn host_call(host: &Rc<RefCell<Host>>, frame: usize, name: &str, a: Args) -> Ret {
    match name {
        "parseDoc" => Ret::S(html::parse_doc(&a.s(0))),
        "parseFrag" => Ret::S(html::parse_frag(&a.s(0), &a.s(1))),
        "cssRules" => Ret::S(css::visibility_rules(&a.s(0))),
        "mediaMatches" => Ret::B(css::media_matches(&a.s(0))),
        "urlParse" => {
            let input = a.s(0);
            let parsed = match a.opt(1).filter(|b| !b.is_empty()) {
                Some(b) => Url::parse(&b).and_then(|b| b.join(&input)),
                None => Url::parse(&input),
            };
            Ret::S(match parsed {
                Ok(u) => serde_json::json!({
                    "href": u.as_str(), "protocol": format!("{}:", u.scheme()), "username": u.username(),
                    "password": u.password().unwrap_or(""), "hostname": u.host_str().unwrap_or(""),
                    "port": u.port().map(|p| p.to_string()).unwrap_or_default(), "pathname": u.path(),
                    "search": u.query().map(|q| format!("?{q}")).unwrap_or_default(),
                    "hash": u.fragment().map(|q| format!("#{q}")).unwrap_or_default(),
                    "origin": u.origin().ascii_serialization(),
                })
                .to_string(),
                Err(_) => String::new(),
            })
        }
        "now" => Ret::N(host.borrow().now()),
        // Wall-clock milliseconds since process start, for SCRIM_PROFILE only (page time is virtual).
        "realMs" => {
            static T0: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
            Ret::N(T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1e3)
        }
        "epoch" => Ret::N(host.borrow().epoch_ms),
        "seed" => Ret::N(host.borrow().seed),
        "log" => {
            let (level, msg) = (a.s(0), a.s(1));
            let mut h = host.borrow_mut();
            if h.console.len() < 500 {
                h.console.push(format!("[{level}] {msg}"));
            }
            if std::env::var_os("SCRIM_DEBUG").is_some() {
                eprintln!("[js {level}] {msg}");
            }
            Ret::Undef
        }
        "cookieGet" => Ret::S(Url::parse(&a.s(0)).map(|u| host.borrow().net.jar.lock().unwrap().header(&u, true)).unwrap_or_default()),
        "cookieSet" => {
            if let Ok(u) = Url::parse(&a.s(0)) {
                host.borrow().net.jar.lock().unwrap().set(&u, &a.s(1), true);
            }
            Ret::Undef
        }
        "storage" => {
            let (op, key) = (a.s(0), a.s(1));
            let mut h = host.borrow_mut();
            match op.as_str() {
                "get" => h.storage.get(&key).cloned().map(Ret::S).unwrap_or(Ret::Undef),
                "set" => {
                    h.storage.insert(key, a.s(2));
                    Ret::Undef
                }
                "del" => {
                    h.storage.remove(&key);
                    Ret::Undef
                }
                "keys" => {
                    let ks: Vec<&String> = h.storage.keys().filter(|k| k.starts_with(&key)).collect();
                    Ret::S(serde_json::to_string(&ks).unwrap())
                }
                _ => Ret::Undef,
            }
        }
        "dialog" => {
            let mut h = host.borrow_mut();
            h.console.push(format!("[dialog:{}] {}", a.s(0), a.s(1)));
            Ret::B(h.dialog_accept)
        }
        "navigate" => {
            if frame == 0 {
                host.borrow_mut().pending_nav = Some(Nav { url: a.s(0), method: a.s(1), body: a.opt(2), content_type: a.opt(3), replace: a.b(4), reload_index: None });
            }
            Ret::Undef
        }
        "historyPush" => {
            if frame == 0 {
                let mut h = host.borrow_mut();
                let doc = h.gen;
                let e = Entry { url: a.s(0), doc, state: a.s(1) };
                if a.b(2) {
                    let i = h.hindex;
                    if let Some(cur) = h.history.get_mut(i) {
                        *cur = e;
                    }
                } else {
                    let i = h.hindex + 1;
                    h.history.truncate(i);
                    h.history.push(e);
                    h.hindex = i;
                }
            }
            Ret::Undef
        }
        "historyGo" => {
            if frame == 0 {
                host.borrow_mut().pending_traverse = Some(a.f(0) as i64);
            }
            Ret::Undef
        }
        "historyLength" => Ret::N(host.borrow().history.len() as f64),
        "frameOpen" => {
            let mut h = host.borrow_mut();
            let id = h.pending_frames.len() + 1000;
            h.pending_frames.push((id, a.s(0)));
            Ret::N(id as f64)
        }
        "fetchStart" => {
            let mut h = host.borrow_mut();
            let (net, tx, gen) = (h.net.clone(), h.tx.clone(), h.gen);
            h.seq += 1;
            let seq = h.seq;
            if h.deterministic {
                h.outstanding.push_back(seq);
            }
            if h.inflight.len() <= frame {
                h.inflight.resize(frame + 1, 0);
            }
            h.inflight[frame] += 1;
            let (id, method, url) = (a.f(0), a.s(1), a.s(2));
            let hdrs: Vec<(String, String)> = serde_json::from_str::<Vec<(String, String)>>(&a.s(3)).unwrap_or_default();
            let body = a.opt(4).map(|b| b.into_bytes());
            std::thread::spawn(move || {
                let (meta, text) = fetch_result(&net, &method, &url, &hdrs, body);
                let _ = tx.send(FetchDone { gen, seq, frame, id, meta, body: text });
            });
            Ret::Undef
        }
        "fetchSync" => {
            let net = host.borrow().net.clone();
            let hdrs: Vec<(String, String)> = serde_json::from_str::<Vec<(String, String)>>(&a.s(2)).unwrap_or_default();
            let (meta, text) = fetch_result(&net, &a.s(0), &a.s(1), &hdrs, a.opt(3).map(|b| b.into_bytes()));
            Ret::List(vec![meta, text])
        }
        _ => Ret::Undef,
    }
}

fn fetch_result(net: &Net, method: &str, url: &str, headers: &[(String, String)], body: Option<Vec<u8>>) -> (String, String) {
    match net.fetch(method, url, headers, body) {
        Ok(r) => {
            let meta = serde_json::json!({"status": r.status, "url": r.url, "headers": r.headers, "redirected": r.redirected});
            (meta.to_string(), r.text())
        }
        Err(e) => (serde_json::json!({"error": e}).to_string(), String::new()),
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
