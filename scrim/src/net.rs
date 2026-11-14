//! HTTP with a cookie jar. Redirects are followed here (not by ureq) so every hop's
//! Set-Cookie is stored and the final URL is known.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) scrim/0.1 Safari/537.36";

#[derive(Clone, Debug)]
struct Cookie {
    name: String,
    value: String,
    domain: String,
    host_only: bool,
    path: String,
    expires: Option<f64>,
    secure: bool,
    http_only: bool,
}

fn now_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

#[derive(Default)]
pub struct Jar {
    cookies: Vec<Cookie>,
}

impl Jar {
    pub fn set(&mut self, url: &Url, header: &str, from_script: bool) {
        let mut parts = header.split(';');
        let Some((name, value)) = parts.next().and_then(|nv| nv.split_once('=')) else { return };
        let host = url.host_str().unwrap_or("").to_ascii_lowercase();
        let default_path = match url.path().rfind('/') {
            Some(0) | None => "/".to_string(),
            Some(i) => url.path()[..i].to_string(),
        };
        let mut c = Cookie {
            name: name.trim().to_string(),
            value: value.trim().to_string(),
            domain: host.clone(),
            host_only: true,
            path: default_path,
            expires: None,
            secure: false,
            http_only: false,
        };
        for attr in parts {
            let (k, v) = attr.split_once('=').map(|(k, v)| (k.trim(), v.trim())).unwrap_or((attr.trim(), ""));
            match k.to_ascii_lowercase().as_str() {
                "domain" => {
                    let d = v.trim_start_matches('.').to_ascii_lowercase();
                    if host == d || host.ends_with(&format!(".{d}")) {
                        c.domain = d;
                        c.host_only = false;
                    } else {
                        return;
                    }
                }
                "path" if v.starts_with('/') => c.path = v.to_string(),
                "max-age" => {
                    if let Ok(s) = v.parse::<f64>() {
                        c.expires = Some(now_s() + s);
                    }
                }
                "expires" if c.expires.is_none() => {
                    // Only "already expired" matters for us; treat any past-looking date as delete.
                    if v.contains("1970") || v.contains("Thu, 01 Jan") {
                        c.expires = Some(0.0);
                    }
                }
                "secure" => c.secure = true,
                "httponly" => c.http_only = true,
                _ => {}
            }
        }
        if from_script && c.http_only {
            return;
        }
        self.cookies.retain(|o| !(o.name == c.name && o.domain == c.domain && o.path == c.path));
        if c.expires.is_none_or(|e| e > now_s()) {
            self.cookies.push(c);
        }
    }

    pub fn header(&self, url: &Url, for_script: bool) -> String {
        let host = url.host_str().unwrap_or("").to_ascii_lowercase();
        let path = url.path();
        let t = now_s();
        let mut v: Vec<&Cookie> = self
            .cookies
            .iter()
            .filter(|c| {
                (if c.host_only { host == c.domain } else { host == c.domain || host.ends_with(&format!(".{}", c.domain)) })
                    && (path == c.path || path.starts_with(&format!("{}/", c.path.trim_end_matches('/'))) || c.path == "/")
                    && (!c.secure || url.scheme() == "https" || host == "127.0.0.1" || host == "localhost")
                    && c.expires.is_none_or(|e| e > t)
                    && !(for_script && c.http_only)
            })
            .collect();
        v.sort_by(|a, b| b.path.len().cmp(&a.path.len()));
        v.iter().map(|c| format!("{}={}", c.name, c.value)).collect::<Vec<_>>().join("; ")
    }

    /// Full jar (HttpOnly and expiry included), for session files.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::Value::Array(self.cookies.iter().map(|c| serde_json::json!([c.name, c.value, c.domain, c.host_only, c.path, c.expires, c.secure, c.http_only])).collect())
    }
    pub fn from_value(v: &serde_json::Value) -> Jar {
        let mut j = Jar::default();
        for c in v.as_array().into_iter().flatten() {
            let s = |i: usize| c[i].as_str().unwrap_or("").to_string();
            j.cookies.push(Cookie { name: s(0), value: s(1), domain: s(2), host_only: c[3].as_bool().unwrap_or(true), path: s(4),
                expires: c[5].as_f64(), secure: c[6].as_bool().unwrap_or(false), http_only: c[7].as_bool().unwrap_or(false) });
        }
        j
    }

    pub fn all_json(&self) -> String {
        let v: Vec<serde_json::Value> = self
            .cookies
            .iter()
            .map(|c| serde_json::json!({"name": c.name, "value": c.value, "domain": c.domain, "path": c.path, "httpOnly": c.http_only}))
            .collect();
        serde_json::to_string(&v).unwrap()
    }
}

pub struct Response {
    pub status: u16,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub redirected: bool,
    /// Every Set-Cookie seen along the redirect chain, with the URL it applied to.
    pub set_cookies: Vec<(String, String)>,
}

/// Recorded responses of one document. In session mode every request is answered from here
/// first (in request order per key), so a replay never repeats a side effect on the server.
#[derive(Default)]
pub struct Recorder {
    pub entries: Vec<(String, Response, bool)>,
}

pub fn request_key(method: &str, url: &str, body: &Option<Vec<u8>>) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in body.iter().flatten() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{} {} {:016x}", method.to_ascii_uppercase(), url, h)
}

impl Clone for Response {
    fn clone(&self) -> Response {
        Response { status: self.status, url: self.url.clone(), headers: self.headers.clone(), body: self.body.clone(), redirected: self.redirected, set_cookies: self.set_cookies.clone() }
    }
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    /// The body as text without copying when it is valid UTF-8.
    pub fn into_text(self) -> String {
        String::from_utf8(self.body).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
    }
}

enum Pending {
    Waiting(std::sync::mpsc::Receiver<Result<Response, String>>),
    Ready(Result<Response, String>),
}

/// The HTTPS agent, built on first use: loading the trust anchors (roots.rs) costs ~1 ms, which
/// plain-HTTP sessions never pay.
fn tls_agent() -> &'static ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .user_agent(USER_AGENT)
            // The macOS trust store, so TLS-inspecting proxies with a locally trusted CA work.
            .tls_config(ureq::tls::TlsConfig::builder().root_certs({
                let t = std::time::Instant::now();
                let r = crate::roots::root_certs();
                if std::env::var_os("SCRIM_PROFILE").is_some() {
                    eprintln!("[prof] trust anchors {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
                }
                r
            }).build())
            .build()
            .into()
    })
}

#[derive(Clone)]
pub struct Net {
    /// Plain HTTP; HTTPS goes through tls_agent().
    agent: ureq::Agent,
    pub jar: Arc<Mutex<Jar>>,
    pub recorder: Option<Arc<Mutex<Recorder>>>,
    /// Subresources requested ahead of use (preload scan): plain GETs, taken by the first fetch.
    prefetched: Arc<Mutex<HashMap<String, Pending>>>,
    /// Plain-GET subresources (not documents) this session received, for screenshots: they paint
    /// with the stylesheets and images the page already loaded instead of downloading them again.
    recent: Arc<Mutex<Recent>>,
}

#[derive(Default)]
struct Recent {
    map: HashMap<String, Response>,
    order: std::collections::VecDeque<String>,
    bytes: usize,
}
const RECENT_BYTES: usize = 64 << 20;

impl Net {
    pub fn new() -> Net {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .user_agent(USER_AGENT)
            .build()
            .into();
        Net { agent, jar: Arc::new(Mutex::new(Jar::default())), recorder: None, prefetched: Arc::new(Mutex::new(HashMap::new())), recent: Default::default() }
    }

    /// Start a GET in the background; the next plain GET of the same URL takes its result.
    pub fn prefetch(&self, url: String) {
        let mut map = self.prefetched.lock().unwrap();
        if map.contains_key(&url) {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        map.insert(url.clone(), Pending::Waiting(rx));
        let net = self.clone();
        std::thread::spawn(move || {
            let _ = tx.send(net.fetch_now("GET", &url, &[], None, None));
        });
    }

    /// Body size of a prefetched URL, waiting for it to arrive; the response stays for the fetch.
    pub fn prefetched_len(&self, url: &str) -> Option<usize> {
        let p = self.prefetched.lock().unwrap().remove(url)?;
        let r = match p {
            Pending::Ready(r) => r,
            Pending::Waiting(rx) => rx.recv().ok()?,
        };
        let len = r.as_ref().map(|x| x.body.len()).ok();
        self.prefetched.lock().unwrap().insert(url.to_string(), Pending::Ready(r));
        len
    }

    pub fn fetch(&self, method: &str, url: &str, headers: &[(String, String)], body: Option<Vec<u8>>) -> Result<Response, String> {
        let plain = method.eq_ignore_ascii_case("GET") && body.is_none() && headers.is_empty();
        let mut r = None;
        if plain {
            match self.prefetched.lock().unwrap().remove(url) {
                Some(Pending::Ready(x)) => r = Some(x),
                Some(Pending::Waiting(rx)) => r = rx.recv().ok(),
                None => {}
            }
        }
        let r = match r {
            Some(r) => r,
            None => self.fetch_now(method, url, headers, body, None),
        };
        if plain {
            if let Ok(resp) = &r {
                self.remember(url, resp);
            }
        }
        r
    }

    fn remember(&self, url: &str, resp: &Response) {
        let html = resp.header("content-type").is_some_and(|t| t.to_ascii_lowercase().contains("html"));
        if resp.status >= 400 || html || resp.body.len() > RECENT_BYTES / 4 {
            return;
        }
        let mut c = self.recent.lock().unwrap();
        if c.map.contains_key(url) {
            return;
        }
        c.bytes += resp.body.len();
        c.order.push_back(url.to_string());
        c.map.insert(url.to_string(), resp.clone());
        while c.bytes > RECENT_BYTES {
            let Some(old) = c.order.pop_front() else { break };
            if let Some(r) = c.map.remove(&old) {
                c.bytes -= r.body.len();
            }
        }
    }

    /// A subresource this session already received (see `recent`).
    pub fn cached(&self, url: &str) -> Option<Response> {
        self.recent.lock().unwrap().map.get(url).cloned()
    }

    /// Like `fetch`, handing the final body to `chunk` piece by piece as it arrives (the parser
    /// starts before the download ends). The returned response still holds the whole body.
    pub fn fetch_streaming(&self, method: &str, url: &str, headers: &[(String, String)], body: Option<Vec<u8>>, chunk: &mut dyn FnMut(&[u8])) -> Result<Response, String> {
        self.fetch_now(method, url, headers, body, Some(chunk))
    }

    /// One request; in session mode answered from the recording when it holds this request.
    fn fetch_now(&self, method: &str, url: &str, headers: &[(String, String)], body: Option<Vec<u8>>, chunk: Option<&mut dyn FnMut(&[u8])>) -> Result<Response, String> {
        let Some(rec) = &self.recorder else { return self.fetch_net(method, url, headers, body, chunk) };
        let key = request_key(method, url, &body);
        let hit = {
            let mut r = rec.lock().unwrap();
            r.entries.iter_mut().find(|(k, _, used)| !*used && *k == key).map(|e| {
                e.2 = true;
                e.1.clone()
            })
        };
        if let Some(resp) = hit {
            let mut jar = self.jar.lock().unwrap();
            for (u, c) in &resp.set_cookies {
                if let Ok(u) = Url::parse(u) {
                    jar.set(&u, c, false);
                }
            }
            if let Some(c) = chunk {
                c(&resp.body);
            }
            return Ok(resp);
        }
        let resp = self.fetch_net(method, url, headers, body, chunk)?;
        rec.lock().unwrap().entries.push((key, resp.clone(), true));
        Ok(resp)
    }

    /// One request with redirect following and cookie handling.
    fn fetch_net(&self, method: &str, url: &str, headers: &[(String, String)], body: Option<Vec<u8>>, chunk: Option<&mut dyn FnMut(&[u8])>) -> Result<Response, String> {
        if std::env::var_os("SCRIM_NETLOG").is_some() {
            let t = std::time::Instant::now();
            let r = self.fetch_net_inner(method, url, headers, body, chunk);
            static T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
            let t0 = *T0.get_or_init(std::time::Instant::now);
            eprintln!("[net] start {:.0} took {:.0} ms {method} {} -> {}", (t - t0).as_secs_f64() * 1e3, t.elapsed().as_secs_f64() * 1e3, &url[..url.len().min(140)], r.as_ref().map(|r| r.status.to_string()).unwrap_or_else(|e| e.clone()));
            return r;
        }
        self.fetch_net_inner(method, url, headers, body, chunk)
    }

    fn fetch_net_inner(&self, method: &str, url: &str, headers: &[(String, String)], body: Option<Vec<u8>>, chunk: Option<&mut dyn FnMut(&[u8])>) -> Result<Response, String> {
        let mut set_cookies: Vec<(String, String)> = vec![];
        let mut url = Url::parse(url).map_err(|e| format!("bad url {url}: {e}"))?;
        let mut method = method.to_ascii_uppercase();
        let mut body = body;
        let mut redirected = false;
        for _ in 0..20 {
            if url.scheme() == "data" {
                return Ok(data_url(&url));
            }
            if url.scheme() != "http" && url.scheme() != "https" {
                return Err(format!("unsupported scheme {}", url.scheme()));
            }
            let mut req = ureq::http::Request::builder().method(method.as_str()).uri(url.as_str());
            let has = |n: &str| headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(n));
            for (k, v) in headers {
                if !k.eq_ignore_ascii_case("cookie") && !k.eq_ignore_ascii_case("host") && !k.eq_ignore_ascii_case("content-length") {
                    req = req.header(k.as_str(), v.as_str());
                }
            }
            if !has("accept") {
                req = req.header("accept", "*/*");
            }
            if !has("accept-language") {
                req = req.header("accept-language", "en-US,en;q=0.9");
            }
            let cookie = self.jar.lock().unwrap().header(&url, false);
            if !cookie.is_empty() {
                req = req.header("cookie", cookie);
            }
            let agent = if url.scheme() == "https" { tls_agent() } else { &self.agent };
            let res = match &body {
                Some(b) => agent.run(req.body(b.clone()).map_err(|e| e.to_string())?),
                None => agent.run(req.body(()).map_err(|e| e.to_string())?),
            };
            let mut res = res.map_err(|e| e.to_string())?;
            let status = res.status().as_u16();
            let hdrs: Vec<(String, String)> = res
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
                .collect();
            {
                let mut jar = self.jar.lock().unwrap();
                for (k, v) in &hdrs {
                    if k.eq_ignore_ascii_case("set-cookie") {
                        jar.set(&url, v, false);
                        set_cookies.push((url.to_string(), v.clone()));
                    }
                }
            }
            if (300..400).contains(&status) && status != 304 {
                if let Some(loc) = hdrs.iter().find(|(k, _)| k.eq_ignore_ascii_case("location")).map(|(_, v)| v.clone()) {
                    url = url.join(&loc).map_err(|e| e.to_string())?;
                    redirected = true;
                    if status == 303 || ((status == 301 || status == 302) && method == "POST") {
                        method = "GET".into();
                        body = None;
                    }
                    continue;
                }
            }
            let bytes = match chunk {
                None => res.body_mut().with_config().limit(256 << 20).read_to_vec().map_err(|e| e.to_string())?,
                Some(c) => {
                    use std::io::Read;
                    let mut all = Vec::new();
                    let mut buf = vec![0u8; 64 * 1024];
                    let mut r = res.body_mut().with_config().limit(256 << 20).reader();
                    loop {
                        let n = r.read(&mut buf).map_err(|e| e.to_string())?;
                        if n == 0 {
                            break;
                        }
                        c(&buf[..n]);
                        all.extend_from_slice(&buf[..n]);
                    }
                    all
                }
            };
            return Ok(Response { status, url: url.to_string(), headers: hdrs, body: bytes, redirected, set_cookies });
        }
        Err("too many redirects".into())
    }
}

fn data_url(url: &Url) -> Response {
    let s = url.as_str();
    let rest = &s[5..];
    let (meta, data) = rest.split_once(',').unwrap_or((rest, ""));
    let decoded = percent_decode(data);
    let body = if meta.ends_with(";base64") { b64(&String::from_utf8_lossy(&decoded)) } else { decoded };
    let ct = meta.trim_end_matches(";base64");
    Response {
        status: 200,
        url: s.to_string(),
        headers: vec![("content-type".into(), if ct.is_empty() { "text/plain".into() } else { ct.to_string() })],
        body,
        redirected: false,
        set_cookies: vec![],
    }
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn b64(s: &str) -> Vec<u8> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut out, mut buf, mut n) = (Vec::new(), 0u32, 0);
    for c in s.bytes() {
        let Some(v) = T.iter().position(|&t| t == c) else { continue };
        buf = (buf << 6) | v as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((buf >> n) as u8);
        }
    }
    out
}
