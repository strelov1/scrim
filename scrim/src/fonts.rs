//! Fonts for screenshots without scanning every system font per document.
//!
//! Scanning every system font on each screenshot costs ~130 ms cold, ~30 ms warm. Instead an
//! index "family name -> font files" is built once per machine and cached on disk, and each screenshot registers only the families its CSS names,
//! the generic defaults, and fallbacks for the scripts its text uses.
use fontique::{Collection, CollectionOptions, FamilyId, GenericFamily, Script, SourceKind};
use parley::FontContext;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

const FONT_DIRS: &[&str] = &["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts"];
const INDEX_VERSION: u32 = 2;

/// CSS generic families, in the order macOS browsers resolve them.
const GENERICS: &[(GenericFamily, &[&str])] = &[
    (GenericFamily::SansSerif, &["Helvetica", "Arial"]),
    (GenericFamily::Serif, &["Times", "Times New Roman"]),
    (GenericFamily::Monospace, &["Courier", "Courier New", "Menlo"]),
    // The system UI font (SFNS.ttf) names its family "System Font".
    (GenericFamily::SystemUi, &["System Font", "Helvetica Neue"]),
    (GenericFamily::UiSansSerif, &["System Font", "Helvetica Neue"]),
    (GenericFamily::UiMonospace, &[".SF NS Mono", "Menlo"]),
    (GenericFamily::Cursive, &["Apple Chancery"]),
    (GenericFamily::Fantasy, &["Papyrus"]),
    (GenericFamily::Emoji, &["Apple Color Emoji"]),
];
/// Families CSS often names that map to the system UI font.
const ALIASES: &[(&str, &str)] = &[("-apple-system", "system font"), ("blinkmacsystemfont", "system font"), ("system-ui", "system font")];

/// Script fallbacks: (script tag, codepoint ranges that trigger it, families).
const SCRIPTS: &[(&[u8; 4], &[(u32, u32)], &[&str])] = &[
    (b"Hani", &[(0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF)], &["PingFang SC", "Hiragino Sans GB", "Heiti SC"]),
    (b"Hira", &[(0x3040, 0x309F)], &["Hiragino Sans", "Hiragino Kaku Gothic ProN"]),
    (b"Kana", &[(0x30A0, 0x30FF)], &["Hiragino Sans", "Hiragino Kaku Gothic ProN"]),
    (b"Hang", &[(0xAC00, 0xD7AF), (0x1100, 0x11FF)], &["Apple SD Gothic Neo"]),
    (b"Arab", &[(0x0600, 0x06FF), (0x0750, 0x077F)], &["Geeza Pro", "SF Arabic"]),
    (b"Hebr", &[(0x0590, 0x05FF)], &["Arial Hebrew", "Lucida Grande"]),
    (b"Thai", &[(0x0E00, 0x0E7F)], &["Thonburi"]),
    (b"Deva", &[(0x0900, 0x097F)], &["Kohinoor Devanagari"]),
    (b"Armn", &[(0x0530, 0x058F)], &["SF Armenian"]),
    (b"Geor", &[(0x10A0, 0x10FF)], &["SF Georgian"]),
    (b"Zsye", &[(0x1F300, 0x1FAFF), (0x2600, 0x27BF)], &["Apple Color Emoji"]),
];

/// Family name (lowercase) -> font files that hold it.
struct Index {
    families: HashMap<String, Vec<PathBuf>>,
}

fn cache_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches/scrim").join(format!("fonts-v{INDEX_VERSION}.json")))
}

/// Changes when fonts are installed or removed: the font directories' modification times.
fn signature() -> String {
    let user = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Fonts"));
    FONT_DIRS
        .iter()
        .map(PathBuf::from)
        .chain(user)
        .map(|d| {
            let t = std::fs::metadata(&d).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            format!("{}={t}", d.display())
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Scan of the font directories, once per machine (or after fonts change). fontique reads the
/// files itself (no CoreText), so scrim links no Apple framework for fonts.
fn build_index() -> Index {
    let mut col = Collection::new(CollectionOptions { shared: false, system_fonts: false });
    let user = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Fonts"));
    col.load_fonts_from_paths(FONT_DIRS.iter().map(PathBuf::from).chain(user).filter(|d| d.is_dir()));
    let names: Vec<String> = col.family_names().map(str::to_string).collect();
    let mut families: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for name in names {
        let Some(info) = col.family_by_name(&name) else { continue };
        let mut paths = BTreeSet::new();
        for f in info.fonts() {
            if let SourceKind::Path(p) = f.source().kind() {
                paths.insert(p.to_path_buf());
            }
        }
        if !paths.is_empty() {
            families.insert(name.to_lowercase(), paths.into_iter().collect());
        }
    }
    Index { families }
}

fn load_index() -> Index {
    let sig = signature();
    let path = cache_path();
    if let Some(p) = &path {
        if let Ok(text) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if v["signature"] == sig.as_str() {
                    if let Ok(families) = serde_json::from_value::<HashMap<String, Vec<PathBuf>>>(v["families"].clone()) {
                        return Index { families };
                    }
                }
            }
        }
    }
    let index = build_index();
    if let Some(p) = &path {
        let sorted: BTreeMap<_, _> = index.families.iter().collect();
        let doc = serde_json::json!({ "signature": sig, "families": sorted });
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Write then rename, so a concurrent reader never sees half a file.
        let tmp = p.with_extension(format!("tmp{}", std::process::id()));
        if std::fs::write(&tmp, doc.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, p);
        }
    }
    index
}

fn index() -> &'static Index {
    static INDEX: OnceLock<Index> = OnceLock::new();
    INDEX.get_or_init(load_index)
}

/// Family names in `font-family` and `font` declarations (CSS text and style attributes).
fn css_families(html: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let lower = html.to_ascii_lowercase();
    for key in ["font-family:", "font:"] {
        let mut from = 0;
        while let Some(i) = lower[from..].find(key) {
            let start = from + i + key.len();
            let end = lower[start..].find(|c| c == ';' || c == '}' || c == '<' || c == '\n').map_or(lower.len(), |e| start + e);
            let decl = &lower[start..end.min(start + 400)];
            // In the `font` shorthand the family list follows the size: take what follows the last
            // token with a digit before the first comma.
            let list = if key == "font:" {
                let first = decl.split(',').next().unwrap_or("");
                match first.rfind(|c: char| c.is_ascii_digit()) {
                    Some(d) => {
                        let rest = &decl[d + 1..];
                        rest.find(' ').map_or("", |s| &rest[s..])
                    }
                    None => decl,
                }
            } else {
                decl
            };
            for name in list.split(',') {
                let n = name.trim().trim_matches(|c| c == '"' || c == '\'' || c == '\\').trim().trim_end_matches("!important").trim();
                if !n.is_empty() && n.len() < 64 {
                    out.insert(n.to_string());
                }
            }
            from = end.max(start);
        }
    }
    out
}

fn used_scripts(html: &str) -> Vec<usize> {
    let mut hit = vec![false; SCRIPTS.len()];
    for c in html.chars() {
        let cp = c as u32;
        if cp < 0x0530 {
            continue;
        }
        for (i, (_, ranges, _)) in SCRIPTS.iter().enumerate() {
            if !hit[i] && ranges.iter().any(|&(a, b)| cp >= a && cp <= b) {
                hit[i] = true;
            }
        }
    }
    hit.iter().enumerate().filter(|(_, h)| **h).map(|(i, _)| i).collect()
}

/// A font context holding just the fonts this page can use.
pub fn context_for(html: &str) -> FontContext {
    let idx = index();
    let first_present = |names: &[&str]| names.iter().map(|n| n.to_lowercase()).find(|n| idx.families.contains_key(n));
    let css = css_families(html);
    // Generic families: the first installed choice of each one the page names, plus serif and
    // monospace, which the UA stylesheet uses for unstyled text and <pre>/<code>.
    let generic_names: &[(GenericFamily, &str)] = &[
        (GenericFamily::Serif, "serif"), (GenericFamily::SansSerif, "sans-serif"), (GenericFamily::Monospace, "monospace"),
        (GenericFamily::SystemUi, "system-ui"), (GenericFamily::UiSansSerif, "ui-sans-serif"), (GenericFamily::UiMonospace, "ui-monospace"),
        (GenericFamily::Cursive, "cursive"), (GenericFamily::Fantasy, "fantasy"), (GenericFamily::Emoji, "emoji"),
    ];
    let mut generics: Vec<(GenericFamily, String)> = Vec::new();
    for (g, names) in GENERICS {
        let css_name = generic_names.iter().find(|(x, _)| x == g).map(|(_, n)| *n).unwrap_or("");
        let named = css.contains(css_name) || (*g == GenericFamily::SystemUi && css.iter().any(|n| ALIASES.iter().any(|(a, _)| a == n)));
        if named || *g == GenericFamily::Serif || *g == GenericFamily::Monospace {
            if let Some(f) = first_present(names) {
                generics.push((*g, f));
            }
        }
    }
    let mut wanted: BTreeSet<String> = generics.iter().map(|(_, f)| f.clone()).collect();
    for name in css {
        let n = ALIASES.iter().find(|(a, _)| *a == name).map(|(_, t)| t.to_lowercase()).unwrap_or(name);
        wanted.insert(n);
    }
    // One fallback family per script the text uses (CJK families alone are 20-100 MB each).
    let scripts: Vec<(usize, String)> = used_scripts(html).into_iter().filter_map(|i| first_present(SCRIPTS[i].2).map(|f| (i, f))).collect();
    wanted.extend(scripts.iter().map(|(_, f)| f.clone()));
    let mut files: BTreeSet<&Path> = BTreeSet::new();
    for name in &wanted {
        if let Some(paths) = idx.families.get(name) {
            files.extend(paths.iter().map(PathBuf::as_path));
        }
    }
    let mut col = Collection::new(CollectionOptions { shared: false, system_fonts: false });
    col.load_fonts_from_paths(files);
    // The index keys are lowercase; fontique matches family names case-insensitively.
    for (g, f) in generics {
        let id: Vec<FamilyId> = col.family_id(&f).into_iter().collect();
        col.set_generic_families(g, id.into_iter());
    }
    for (i, f) in scripts {
        let id: Vec<FamilyId> = col.family_id(&f).into_iter().collect();
        col.set_fallbacks(Script::from_bytes(*SCRIPTS[i].0), id.into_iter());
    }
    FontContext { collection: col, source_cache: Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_from_css() {
        let f = css_families(r#"<style>body{font-family:"Inter", -apple-system, sans-serif} h1{font: bold 2em/1.2 Georgia, serif}</style>"#);
        assert!(f.contains("inter") && f.contains("-apple-system") && f.contains("sans-serif"), "{f:?}");
        assert!(f.contains("georgia") && f.contains("serif"), "{f:?}");
    }

    #[test]
    fn scripts_from_text() {
        let s: Vec<&[u8; 4]> = used_scripts("Hello שלום 你好").into_iter().map(|i| SCRIPTS[i].0).collect();
        assert_eq!(s, vec![b"Hani", b"Hebr"]);
    }
}
