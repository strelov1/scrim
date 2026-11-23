//! scrim: a minimal headless browser for AI agents.
//!
//! scrim fetch <url> [--dump text|markdown|snapshot|html|links] [--eval <js>]
//! scrim serve        JSON lines on stdin/stdout: {"id":1,"cmd":"goto","url":"..."}
mod css;
mod engine;
mod html;
mod native;
mod net;
mod qos;
mod render;
mod fonts;
mod roots;
mod js;
mod qjs;
mod v8js;
mod session;
mod shim;

use engine::{Nav, Session};

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

fn goto(s: &mut Session, url: &str) -> Result<(), String> {
    let t = std::time::Instant::now();
    s.navigate(Nav { url: url.into(), method: "GET".into(), body: None, content_type: None, replace: false, reload_index: None })?;
    let t1 = std::time::Instant::now();
    let r = s.settle();
    if std::env::var_os("SCRIM_PROFILE").is_some() {
        eprintln!("[prof] navigate {:.1} ms, settle {:.1} ms", (t1 - t).as_secs_f64() * 1e3, t1.elapsed().as_secs_f64() * 1e3);
    }
    r
}

fn dump(s: &mut Session, what: &str) -> Result<String, String> {
    match what {
        "text" => s.text("__scrim.agent.text"),
        "markdown" => s.text("__scrim.agent.markdown"),
        "snapshot" => s.text("__scrim.agent.snapshot"),
        "links" => s.call(0, "__scrim.agent.links", &[]),
        "html" => s.call(0, "__scrim.agent.html", &[]),
        _ => Err(format!("unknown dump {what}")),
    }
}

/// Run an agent action in the page, then settle. Returns the action's result string.
fn act(s: &mut Session, f: &str, arg: &Value) -> Result<String, String> {
    let r = s.call(0, f, &[arg.to_string()])?;
    if let Some(err) = r.strip_prefix("ERR:") {
        return Err(err.to_string());
    }
    s.settle()?;
    Ok(r)
}

pub(crate) fn handle(s: &mut Session, req: &Value) -> Result<Value, String> {
    let cmd = req["cmd"].as_str().unwrap_or("");
    let res = match cmd {
        "goto" => {
            goto(s, req["url"].as_str().ok_or("url required")?)?;
            json!({"status": s.status})
        }
        "click" | "fill" | "select" | "press" | "hover" => json!(act(s, &format!("__scrim.agent.{cmd}"), req)?),
        "scroll" => json!(act(s, "__scrim.agent.scroll", req)?),
        "back" | "forward" => {
            s.call(0, "__scrim.agent.go", &[if cmd == "back" { "-1".into() } else { "1".into() }])?;
            s.settle()?;
            json!(null)
        }
        "reload" => {
            let u = s.current_url();
            goto(s, &u)?;
            json!(null)
        }
        "text" | "markdown" | "snapshot" | "html" | "links" => json!(dump(s, cmd)?),
        "eval" => {
            let r = s.call(0, "__scrim.agent.eval", &[req["js"].as_str().unwrap_or("").to_string()])?;
            s.settle()?;
            json!(r)
        }
        "wait" => {
            let needle = req["text"].as_str().unwrap_or("");
            let t0 = Instant::now();
            let timeout = Duration::from_millis(req["timeout"].as_u64().unwrap_or(5000));
            loop {
                s.settle()?;
                if s.text("__scrim.agent.text")?.contains(needle) {
                    break json!(true);
                }
                if t0.elapsed() > timeout {
                    return Err(format!("wait timeout: {needle}"));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        "screenshot" => {
            // Paint the current DOM into a PNG at `path` (the caller picks where it goes).
            let path = req["path"].as_str().ok_or("path required")?;
            let opts = render::Options {
                width: req["width"].as_u64().unwrap_or(1280).clamp(200, 3840) as u32,
                height: req["height"].as_u64().unwrap_or(800).clamp(200, render::MAX_HEIGHT as u64) as u32,
                full_page: req["fullPage"].as_bool().unwrap_or(false),
                net_timeout: Duration::from_millis(req["netTimeout"].as_u64().unwrap_or(10_000).min(60_000)),
            };
            let th = Instant::now();
            let html = s.call(0, "__scrim.agent.renderHtml", &[])?;
            if std::env::var_os("SCRIM_PROFILE").is_some() {
                eprintln!("[prof] renderHtml {:.1} ms ({} bytes)", th.elapsed().as_secs_f64() * 1e3, html.len());
            }
            let net = s.host.borrow().net.clone();
            let (png, width, height) = render::screenshot(&html, &s.current_url(), &net, &opts)?;
            std::fs::write(path, png).map_err(|e| format!("write {path}: {e}"))?;
            json!({"path": path, "width": width, "height": height})
        }
        "cookies" => serde_json::from_str(&s.host.borrow().net.jar.lock().unwrap().all_json()).unwrap(),
        "console" => json!(s.host.borrow().console.clone()),
        "frames" => json!(s.frame_urls()),
        "url" => json!(s.current_url()),
        "reset" => {
            *s = Session::new();
            json!(null)
        }
        _ => return Err(format!("unknown cmd {cmd}")),
    };
    Ok(res)
}

fn serve() {
    let mut s = Session::new();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(out, "{}", json!({"ok": false, "error": e.to_string()}));
                continue;
            }
        };
        if req["cmd"] == "quit" {
            break;
        }
        let resp = match handle(&mut s, &req) {
            Ok(r) => json!({"id": req["id"], "ok": true, "result": r, "url": s.current_url()}),
            Err(e) => json!({"id": req["id"], "ok": false, "error": e, "url": s.current_url()}),
        };
        let _ = writeln!(out, "{resp}");
        let _ = out.flush();
    }
    // The session ends with the process: let the OS reclaim the JS heaps, the arena and the
    // sockets instead of running every destructor (as `fetch` does).
    let _ = out.flush();
    std::process::exit(0);
}

/// `--help`. Agents read this before anything else, so it carries the whole contract: every mode,
/// every command, the locator grammar, the exit codes and runnable examples.
const HELP: &str = concat!(
    "scrim ", env!("CARGO_PKG_VERSION"), " - a minimal headless browser for AI agents.

Reads a page as text, markdown or an accessibility tree, and clicks, fills and navigates it.
There is no layout and no paint, so there are no pixel coordinates: elements are addressed by
role, label or visible text.

USAGE
  scrim fetch <url> [options]           one page, one process, print and exit
  scrim serve                           long-lived session, JSON lines on stdin and stdout
  scrim --session <dir> <command> ...   one process per command, state kept in <dir>

FETCH OPTIONS
  --dump <what>        text (default) | markdown | snapshot | html | links
  --eval <js>          run JavaScript in the page before dumping, and print its result
  --screenshot <file>  paint the page to a PNG (the only path that runs layout)
  --width <n>          screenshot width in CSS pixels (default 1280)
  --height <n>         screenshot height in CSS pixels (default 800)
  --full-page          capture the whole scroll height instead of one viewport

COMMANDS (serve and --session)
  read    text | markdown | snapshot | links | html | url | cookies
  act     click <loc> | fill <loc> <value> | select <loc> <value> | press <key> [loc] | scroll
  move    goto <url> | back | forward | reload
  script  eval <js> | wait <text> [timeout_ms]

LOCATORS
  role=button:Save     ARIA role plus accessible name - the most robust form
  label=Email          form control found by its label
  text=Continue        visible text
  css=.result > a      CSS selector, when nothing else fits
  e152                 a ref printed by the previous snapshot

AGENT USAGE
  Run `snapshot` first. It prints the accessibility tree with a [ref=eNN] on every element, and
  those refs are what the locators above accept. Every command returns only once the page is
  quiet - microtasks, network, timers and navigation all settled - so never sleep or poll.
  Use `serve` for a multi-step task in one process; use `--session` when the task must survive
  between separate process invocations. Results go to stdout, diagnostics to stderr.

EXIT CODES
  0  success
  1  the page or the command failed (reason on stderr)
  2  the command line was wrong (reason on stderr)

ENVIRONMENT
  SCRIM_NO_NATIVE=1  always use the JS engine, never the Rust read path (for parity testing)
  SCRIM_PROFILE=1    print a timing breakdown on stderr
  SCRIM_DEBUG=1      print the page's console output on stderr
  SCRIM_NETLOG=1     log every request on stderr

EXAMPLES
  scrim fetch https://example.com --dump markdown
  scrim fetch https://example.com --screenshot page.png --full-page
  scrim fetch https://example.com --eval 'document.title'

  scrim --session /tmp/s goto https://example.com/login
  scrim --session /tmp/s snapshot
  scrim --session /tmp/s fill 'label=Email' me@example.com
  scrim --session /tmp/s click 'role=button:Sign in'
  scrim --session /tmp/s text"
);

/// A wrong command line: say what is wrong, point at the help, exit 2. Never panic on user input.
fn usage_error(msg: &str) -> ! {
    eprintln!("error: {msg}");
    eprintln!("run `scrim --help` for usage");
    std::process::exit(2);
}

fn main() {
    let t_main = std::time::Instant::now();
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        // A bare `scrim` is how an agent discovers the tool, so it prints the help on stdout
        // and succeeds rather than erroring out.
        None | Some("-h") | Some("--help") | Some("help") => {
            println!("{HELP}");
            std::process::exit(0);
        }
        Some("-V") | Some("--version") => {
            println!("scrim {}", env!("CARGO_PKG_VERSION"));
            std::process::exit(0);
        }
        Some("--session") | Some("-s") => {
            let dir = match args.get(2) {
                Some(d) => d,
                None => usage_error("--session needs a directory, e.g. `scrim --session /tmp/s goto <url>`"),
            };
            if args.len() < 4 {
                usage_error("--session needs a command, e.g. `scrim --session <dir> snapshot`");
            }
            match session::run(dir, &args[3..]) {
                Ok(out) => {
                    println!("{out}");
                    let _ = std::io::stdout().flush();
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
        }
        Some("serve") => serve(),
        Some("fetch") => {
            let url = match args.get(2) {
                Some(u) if !u.starts_with('-') => u,
                _ => usage_error("fetch needs a url, e.g. `scrim fetch https://example.com`"),
            };
            let what = args.iter().position(|a| a == "--dump").and_then(|i| args.get(i + 1)).map(String::as_str).unwrap_or("text");
            let tn = std::time::Instant::now();
            let mut s = Session::new();
            if std::env::var_os("SCRIM_PROFILE").is_some() {
                eprintln!("[prof] session init {:.2} ms (process start to here {:.2} ms)", tn.elapsed().as_secs_f64() * 1e3, t_main.elapsed().as_secs_f64() * 1e3);
            }
            if let Err(e) = goto(&mut s, url) {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
            let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
            if let Some(path) = flag("--screenshot") {
                // One-shot screenshot: `scrim fetch <url> --screenshot out.png [--width W] [--height H] [--full-page]`.
                let mut req = json!({"cmd": "screenshot", "path": path, "fullPage": args.iter().any(|a| a == "--full-page")});
                for k in ["width", "height"] {
                    if let Some(v) = flag(&format!("--{k}")).and_then(|v| v.parse::<u64>().ok()) {
                        req[k] = json!(v);
                    }
                }
                let code = match handle(&mut s, &req) {
                    Ok(r) => {
                        println!("{r}");
                        0
                    }
                    Err(e) => {
                        eprintln!("error: {e}");
                        1
                    }
                };
                let _ = std::io::stdout().flush();
                std::process::exit(code);
            }
            if let Some(js) = args.iter().position(|a| a == "--eval").and_then(|i| args.get(i + 1)) {
                match s.call(0, "__scrim.agent.eval", &[js.clone(), "throw".into()]) {
                    Ok(result) => println!("{result}"),
                    Err(e) => {
                        eprintln!("error: {e}");
                        std::process::exit(1);
                    }
                }
            }
            let t = std::time::Instant::now();
            let d = dump(&mut s, what);
            if std::env::var_os("SCRIM_PROFILE").is_some() { eprintln!("[prof] dump {what} {:.1} ms", t.elapsed().as_secs_f64() * 1e3); }
            let d_ok = d.is_ok();
            match d {
                Ok(t) => println!("{t}"),
                Err(e) => eprintln!("error: {e}"),
            }
            if std::env::var_os("SCRIM_PROFILE").is_some() {
                eprintln!("[prof] main total {:.1} ms", t_main.elapsed().as_secs_f64() * 1e3);
            }
            if std::env::var_os("SCRIM_DEBUG").is_some() {
                for l in &s.host.borrow().console {
                    eprintln!("{l}");
                }
            }
            // One-shot command: let the OS reclaim the JS heap, the arena and open sockets
            // instead of running every destructor.
            let _ = std::io::stdout().flush();
            std::process::exit(if d_ok { 0 } else { 1 });
        }
        // An unknown command is a hard failure, not a guess: an agent should discover the real
        // interface from --help rather than be steered by a fuzzy match.
        Some(other) => usage_error(&format!("unknown command `{other}`; expected fetch, serve or --session")),
    }
}
