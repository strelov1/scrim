//! The only CSS this browser understands: which rules hide content.
//! Scans a stylesheet, evaluates @media against a fixed viewport, and returns, in source order,
//! the rules that set `display`, `visibility` or `content-visibility`, as JSON:
//! `[[selector, property, value, important], ...]`. Everything else (layout, paint) is skipped.

pub const VIEWPORT_W: f64 = 1280.0;
pub const VIEWPORT_H: f64 = 800.0;

fn strip_comments(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains("/*") {
        return std::borrow::Cow::Borrowed(s);
    }
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut start = 0;
    while i + 1 < b.len() {
        if b[i] == b'/' && b[i + 1] == b'*' {
            out.push_str(&s[start..i]);
            match s[i + 2..].find("*/") {
                Some(j) => i = i + 2 + j + 2,
                None => i = b.len(),
            }
            start = i;
        } else if b[i] == b'"' || b[i] == b'\'' {
            let q = b[i];
            i += 1;
            while i < b.len() && b[i] != q {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
        } else {
            i += 1;
        }
    }
    if start < s.len() {
        out.push_str(&s[start.min(s.len())..]);
    }
    std::borrow::Cow::Owned(out)
}

/// Find the matching close brace for an open brace at `open`; also report nested blocks.
fn block_end(b: &[u8], open: usize) -> (usize, bool) {
    let mut depth = 0;
    let mut nested = false;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'{' => {
                depth += 1;
                nested |= depth > 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return (i, nested);
                }
            }
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    (b.len(), nested)
}

fn length_px(v: &str) -> Option<f64> {
    let v = v.trim();
    let (num, unit) = v.split_at(v.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(v.len()));
    let n: f64 = num.trim().parse().ok()?;
    Some(match unit {
        "px" | "" => n,
        "em" | "rem" => n * 16.0,
        _ => return None,
    })
}

fn feature(f: &str) -> bool {
    let f = f.trim().to_ascii_lowercase();
    // Range syntax: (width >= 600px), (400px <= width <= 700px)
    for op in [">=", "<=", ">", "<"] {
        if f.contains(op) {
            let parts: Vec<&str> = f.split(|c| c == '<' || c == '>').map(|p| p.trim_start_matches('=').trim()).collect();
            let dim = |name: &str| if name == "width" { Some(VIEWPORT_W) } else if name == "height" { Some(VIEWPORT_H) } else { None };
            let ops: Vec<&str> = f.matches(|c| c == '<' || c == '>').collect();
            let eqs: Vec<bool> = f.match_indices(|c| c == '<' || c == '>').map(|(i, _)| f[i + 1..].starts_with('=')).collect();
            let vals: Vec<Option<f64>> = parts.iter().map(|p| dim(p).or_else(|| length_px(p))).collect();
            if vals.iter().any(|v| v.is_none()) {
                return false;
            }
            let mut ok = true;
            for k in 0..ops.len() {
                let (a, b) = (vals[k].unwrap(), vals[k + 1].unwrap());
                ok &= match (ops[k], eqs[k]) {
                    ("<", true) => a <= b,
                    ("<", false) => a < b,
                    (">", true) => a >= b,
                    _ => a > b,
                };
            }
            return ok;
        }
    }
    let (name, val) = match f.split_once(':') {
        Some((n, v)) => (n.trim(), v.trim()),
        None => (f.as_str(), ""),
    };
    match name {
        "min-width" => length_px(val).is_some_and(|v| VIEWPORT_W >= v),
        "max-width" => length_px(val).is_some_and(|v| VIEWPORT_W <= v),
        "min-height" => length_px(val).is_some_and(|v| VIEWPORT_H >= v),
        "max-height" => length_px(val).is_some_and(|v| VIEWPORT_H <= v),
        "min-device-width" => length_px(val).is_some_and(|v| VIEWPORT_W >= v),
        "max-device-width" => length_px(val).is_some_and(|v| VIEWPORT_W <= v),
        "orientation" => val == "landscape",
        "prefers-color-scheme" => val == "light",
        "prefers-reduced-motion" | "prefers-reduced-transparency" | "prefers-contrast" => val == "no-preference",
        "hover" | "any-hover" => val.is_empty() || val == "hover",
        "pointer" | "any-pointer" => val.is_empty() || val == "fine",
        "forced-colors" | "inverted-colors" => val == "none",
        "display-mode" => val == "browser",
        "scripting" => val == "enabled",
        "update" => val == "fast",
        "color" | "grid" => name == "color",
        "min-resolution" | "-webkit-min-device-pixel-ratio" | "min--moz-device-pixel-ratio" => {
            val.trim_end_matches("dppx").trim_end_matches('x').parse::<f64>().is_ok_and(|v| v <= 1.0)
        }
        "max-resolution" | "-webkit-max-device-pixel-ratio" => {
            val.trim_end_matches("dppx").trim_end_matches('x').parse::<f64>().is_ok_and(|v| v >= 1.0)
        }
        "aspect-ratio" | "min-aspect-ratio" | "max-aspect-ratio" => true,
        _ => false,
    }
}

/// Evaluate a media query list for a 1280x800 light-mode screen.
pub fn media_matches(q: &str) -> bool {
    let q = q.trim();
    if q.is_empty() {
        return true;
    }
    q.split(',').any(|one| {
        let one = one.trim().to_ascii_lowercase();
        let (negate, rest) = match one.strip_prefix("not ") {
            Some(r) => (true, r.trim().to_string()),
            None => (false, one.trim_start_matches("only ").to_string()),
        };
        let mut ok = true;
        for part in rest.split(" and ") {
            let p = part.trim();
            if p.starts_with("not (") {
                ok &= !feature(p[4..].trim().trim_start_matches('(').trim_end_matches(')'));
            } else if p.starts_with('(') {
                ok &= feature(p.trim_start_matches('(').trim_end_matches(')'));
            } else {
                ok &= matches!(p, "screen" | "all" | "");
            }
        }
        ok != negate
    })
}

fn split_decls(body: &str) -> Vec<&str> {
    let b = body.as_bytes();
    let (mut out, mut depth, mut start, mut i) = (vec![], 0i32, 0, 0);
    while i < b.len() {
        match b[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
            }
            b';' if depth == 0 => {
                out.push(&body[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(&body[start.min(body.len())..]);
    out
}

/// Does a declaration block mention display or visibility? Substring search (vectorized by the
/// standard library); the common spellings are checked first, any other casing falls back to a
/// case-insensitive scan.
fn mentions_visibility(body: &str) -> bool {
    if body.contains("isplay") || body.contains("isibility") {
        return true;
    }
    if !body.bytes().any(|c| c.is_ascii_uppercase()) {
        return false;
    }
    let b = body.as_bytes();
    let n = b.len();
    (0..n).any(|i| (i + 7 <= n && b[i..i + 7].eq_ignore_ascii_case(b"display")) || (i + 10 <= n && b[i..i + 10].eq_ignore_ascii_case(b"visibility")))
}

fn rules(css: &str, out: &mut Vec<Rule>) {
    let b = css.as_bytes();
    let mut i = 0;
    while i < b.len() {
        // Read prelude up to '{' or ';'.
        let start = i;
        while i < b.len() && b[i] != b'{' && b[i] != b';' && b[i] != b'}' {
            if b[i] == b'"' || b[i] == b'\'' {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
            }
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let prelude = css[start..i].trim();
        if b[i] != b'{' {
            i += 1;
            continue;
        }
        let (end, nested) = block_end(b, i);
        let body = &css[i + 1..end.min(css.len())];
        i = end + 1;
        if let Some(at) = prelude.strip_prefix('@') {
            let (name, cond) = at.split_once(|c: char| c.is_whitespace() || c == '(').map(|(n, c)| (n, c)).unwrap_or((at, ""));
            let name = name.to_ascii_lowercase();
            match name.as_str() {
                "media" => {
                    let cond = &prelude[prelude.find(char::is_whitespace).unwrap_or(prelude.len())..];
                    if media_matches(cond) {
                        rules(body, out);
                    }
                }
                "supports" | "layer" | "container" | "scope" | "starting-style" => {
                    let _ = cond;
                    rules(body, out);
                }
                _ => {}
            }
            continue;
        }
        if prelude.is_empty() {
            continue;
        }
        // Most rules set neither property: skip them without splitting or allocating.
        if !mentions_visibility(body) {
            continue;
        }
        // Declarations before any nested rule.
        let decl_part = if nested {
            let head = body.split('{').next().unwrap_or("");
            match head.rfind(';') {
                Some(p) => &head[..p],
                None => head,
            }
        } else {
            body
        };
        for d in split_decls(decl_part) {
            let Some((prop, val)) = d.split_once(':') else { continue };
            let prop = prop.trim();
            let prop = if prop.eq_ignore_ascii_case("display") {
                "display"
            } else if prop.eq_ignore_ascii_case("visibility") {
                "visibility"
            } else if prop.eq_ignore_ascii_case("content-visibility") {
                "content-visibility"
            } else {
                continue;
            }
            .to_string();
            let mut val = val.trim().to_ascii_lowercase();
            let important = val.ends_with("!important");
            if important {
                val = val.trim_end_matches("!important").trim().to_string();
            }
            out.push(Rule { selector: prelude.to_string(), prop, val, important });
        }
    }
}

/// Split a stylesheet at top-level rule boundaries into pieces of about `target` bytes, so big
/// sheets can be scanned in parallel; concatenating the pieces' rules keeps source order.
pub fn split_top_level(css: &str, target: usize) -> Vec<&str> {
    let b = css.as_bytes();
    let (mut out, mut depth, mut start, mut i) = (vec![], 0i32, 0usize, 0usize);
    while i < b.len() {
        match b[i] {
            b'/' if i + 1 < b.len() && b[i + 1] == b'*' => {
                i = css[i + 2..].find("*/").map(|p| i + 2 + p + 2).unwrap_or(b.len());
                continue;
            }
            b'"' | b'\'' => {
                let q = b[i];
                i += 1;
                while i < b.len() && b[i] != q {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 && i + 1 - start >= target && css.is_char_boundary(i + 1) {
                    out.push(&css[start..i + 1]);
                    start = i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    if start < b.len() {
        out.push(&css[start..]);
    }
    out
}

/// One declaration that can hide content, in source order.
pub struct Rule {
    pub selector: String,
    pub prop: String,
    pub val: String,
    pub important: bool,
}

pub fn visibility_rule_list(css: &str) -> Vec<Rule> {
    let css = strip_comments(css);
    let mut out = vec![];
    rules(&css, &mut out);
    out
}

/// The same rules as JSON for the JS cascade: `[[selector, property, value, important], ...]`.
pub fn visibility_rules(css: &str) -> String {
    let v: Vec<serde_json::Value> = visibility_rule_list(css)
        .into_iter()
        .map(|r| serde_json::json!([r.selector, r.prop, r.val, if r.important { 1 } else { 0 }]))
        .collect();
    serde_json::to_string(&v).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media() {
        assert!(media_matches("screen and (min-width: 600px)"));
        assert!(!media_matches("(max-width: 400px)"));
        assert!(!media_matches("print"));
        assert!(media_matches("(width >= 1000px)"));
        assert!(media_matches("(400px <= width <= 1300px)"));
        assert!(!media_matches("not all and (min-width: 100px)"));
    }
    #[test]
    fn extract() {
        let r = visibility_rules(".a{color:red;display:none} @media (max-width:400px){.b{display:block}} @media screen{.c{visibility:hidden !important}} @font-face{src:url(x)}");
        assert_eq!(r, r#"[[".a","display","none",0],[".c","visibility","hidden",1]]"#);
    }
}
