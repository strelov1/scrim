//! Stateless CLI: `scrim --session DIR <command> [args]`. No daemon. Each call is a new process
//! that rebuilds the page from the session directory, runs one command and saves the session.
//!
//! DIR/state.json holds: the cookies/storage/history captured when the current document's
//! navigation started, that navigation, the agent's action log since then, the recorded responses
//! of every request the document made (bodies in DIR/blobs/), and the latest cookies/storage/history.
//! Rebuilding = load the document and replay the log with the session in deterministic mode
//! (virtual clock, seeded Math.random, responses in request order) and every recorded request
//! answered from the recording, so the server never sees a request twice.
use crate::engine::{Nav, Session};
use crate::net::{Recorder, Response};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const READ_ONLY: &[&str] = &["text", "markdown", "snapshot", "links", "html", "url", "cookies", "console", "frames"];

fn fnv(b: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for x in b {
        h ^= *x as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Locator shorthand: `e12` (snapshot ref), `role=button:Save`, `label=Email`, `text=…`, `css=…`, or JSON.
pub fn parse_loc(s: &str) -> Value {
    let s = s.trim();
    if s.starts_with('{') {
        return serde_json::from_str(s).unwrap_or(json!({"text": s}));
    }
    if s.len() > 1 && s.starts_with('e') && s[1..].chars().all(|c| c.is_ascii_digit()) {
        return json!({"ref": s});
    }
    if let Some(r) = s.strip_prefix("role=") {
        return match r.split_once(':') {
            Some((role, name)) => json!({"role": role, "name": name}),
            None => json!({"role": r}),
        };
    }
    for k in ["label", "text", "css"] {
        if let Some(v) = s.strip_prefix(&format!("{k}=")) {
            return json!({k: v});
        }
    }
    json!({"text": s})
}

/// Turn CLI words into the request object the serve protocol uses.
fn request(args: &[String]) -> Result<Value, String> {
    let cmd = args.first().ok_or("missing command")?.as_str();
    let a = |i: usize| args.get(i).cloned().ok_or(format!("{cmd}: missing argument {i}"));
    Ok(match cmd {
        "goto" => json!({"cmd": "goto", "url": a(1)?}),
        "click" | "hover" => json!({"cmd": cmd, "loc": parse_loc(&a(1)?)}),
        "fill" | "select" => json!({"cmd": cmd, "loc": parse_loc(&a(1)?), "value": a(2)?}),
        "press" => match args.get(2) {
            Some(l) => json!({"cmd": "press", "key": a(1)?, "loc": parse_loc(l)}),
            None => json!({"cmd": "press", "key": a(1)?}),
        },
        "eval" => json!({"cmd": "eval", "js": a(1)?}),
        "wait" => json!({"cmd": "wait", "text": a(1)?, "timeout": args.get(2).and_then(|t| t.parse::<u64>().ok()).unwrap_or(5000)}),
        "scroll" | "back" | "forward" | "reload" | "url" => json!({"cmd": cmd}),
        c if READ_ONLY.contains(&c) => json!({"cmd": c}),
        _ => return Err(format!("unknown command {cmd}")),
    })
}

fn load_record(dir: &Path, v: &Value) -> Recorder {
    let mut r = Recorder::default();
    for e in v.as_array().into_iter().flatten() {
        let body = std::fs::read(dir.join("blobs").join(e["blob"].as_str().unwrap_or(""))).unwrap_or_default();
        let pairs = |k: &str| -> Vec<(String, String)> {
            e[k].as_array().into_iter().flatten().map(|p| (p[0].as_str().unwrap_or("").into(), p[1].as_str().unwrap_or("").into())).collect()
        };
        let resp = Response { status: e["status"].as_u64().unwrap_or(0) as u16, url: e["url"].as_str().unwrap_or("").into(), headers: pairs("headers"),
            body, redirected: e["redirected"].as_bool().unwrap_or(false), set_cookies: pairs("set_cookies") };
        r.entries.push((e["key"].as_str().unwrap_or("").into(), resp, false));
    }
    r
}

fn save_record(dir: &Path, r: &Recorder) -> Value {
    let blobs = dir.join("blobs");
    let _ = std::fs::create_dir_all(&blobs);
    Value::Array(r.entries.iter().map(|(key, resp, _)| {
        let name = fnv(&resp.body);
        let path = blobs.join(&name);
        if !path.exists() {
            let _ = std::fs::write(&path, &resp.body);
        }
        json!({"key": key, "status": resp.status, "url": resp.url, "headers": resp.headers, "redirected": resp.redirected,
               "set_cookies": resp.set_cookies, "blob": name})
    }).collect())
}

pub fn run(dir: &str, args: &[String]) -> Result<String, String> {
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let state_path = dir.join("state.json");
    let state: Value = std::fs::read_to_string(&state_path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
    let req = request(args)?;
    let cmd = req["cmd"].as_str().unwrap_or("").to_string();

    let mut s = Session::new();
    let rec = Arc::new(Mutex::new(Recorder::default()));
    {
        let mut h = s.host.borrow_mut();
        h.deterministic = true;
        if let Some(seed) = state["seed"].as_f64() {
            h.seed = seed;
        }
        h.set_epoch(state["epoch"].as_f64());
        h.net.recorder = Some(rec.clone());
    }
    let mut log: Vec<Value> = state["log"].as_array().cloned().unwrap_or_default();
    let mut replay_errors = vec![];

    if cmd == "goto" || state["doc"].is_null() {
        if cmd != "goto" {
            return Err("no page in this session yet: run `goto <url>` first".into());
        }
        // A new document: start from the latest cookies/storage/history, nothing to replay.
        if !state["now"].is_null() {
            s.import_state(&state["now"]);
            s.url = state["now"]["url"].as_str().unwrap_or("about:blank").into();
        }
    } else {
        // Rebuild the current document: its start state, its navigation, its action log.
        let doc = &state["doc"];
        s.import_state(&doc["state"]);
        s.url = doc["referrer"].as_str().unwrap_or("about:blank").into();
        *rec.lock().unwrap() = load_record(&dir, &state["record"]);
        let n = &doc["nav"];
        let nav = Nav {
            url: n["url"].as_str().unwrap_or("").into(),
            method: n["method"].as_str().unwrap_or("GET").into(),
            body: n["body"].as_str().map(String::from),
            content_type: n["content_type"].as_str().map(String::from),
            replace: n["replace"].as_bool().unwrap_or(false),
            reload_index: n["reload_index"].as_u64().map(|i| i as usize),
        };
        s.host.borrow_mut().restoring = true;
        s.host.borrow_mut().doc_start = Some(doc.clone());
        let r = s.navigate(nav);
        s.host.borrow_mut().restoring = false;
        r?;
        s.settle()?;
        for e in &log {
            if let Err(err) = crate::handle(&mut s, e) {
                replay_errors.push(format!("replay {}: {err}", e["cmd"]));
            }
        }
    }

    let gen0 = s.host.borrow().gen_id();
    let result = crate::handle(&mut s, &req);
    if !READ_ONLY.contains(&cmd.as_str()) && cmd != "wait" && result.is_ok() {
        if s.host.borrow().gen_id() != gen0 {
            log.clear(); // a new document: its log starts empty
        } else {
            let mut e = req.clone();
            if let Some(o) = e.as_object_mut() {
                o.remove("id");
            }
            log.push(e);
        }
    }

    // Save.
    let record = save_record(&dir, &rec.lock().unwrap());
    let mut now = s.export_state();
    now["url"] = json!(s.current_url());
    let (seed, epoch) = { let h = s.host.borrow(); (h.seed, h.epoch()) };
    let out = json!({"v": 1, "seed": seed, "epoch": epoch, "doc": s.host.borrow().doc_start.clone(), "log": log, "record": record, "now": now});
    let tmp = dir.join("state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&out).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &state_path).map_err(|e| e.to_string())?;
    for e in replay_errors {
        eprintln!("warning: {e}");
    }

    let r = result?;
    let out = match (cmd.as_str(), r) {
        ("goto" | "click" | "fill" | "select" | "press" | "hover" | "scroll" | "back" | "forward" | "reload" | "url", _) => s.current_url(),
        (_, Value::String(t)) => t,
        (_, v) => v.to_string(),
    };
    // The process ends right after printing: skip tearing down the JS heap and the arena.
    std::mem::forget(s);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locators() {
        assert_eq!(parse_loc("e12"), json!({"ref": "e12"}));
        assert_eq!(parse_loc("role=button:Add todo"), json!({"role": "button", "name": "Add todo"}));
        assert_eq!(parse_loc("label=Email"), json!({"label": "Email"}));
        assert_eq!(parse_loc("Configuration"), json!({"text": "Configuration"}));
    }
}
