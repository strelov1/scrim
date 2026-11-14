//! TLS trust anchors from the macOS trust store, without linking Security.framework.
//!
//! Linking Security (as rustls-platform-verifier does) loads CoreFoundation and the Objective-C
//! runtime into every scrim process, which costs about 1.5 ms per start. Instead the anchors are
//! exported once with the `security` tool and cached on disk; the cache is rebuilt when a keychain
//! or the admin trust settings change. Anchors are Apple's system roots plus certificates an
//! administrator marked as trusted (how TLS-inspecting proxies such as Netskope install their CA).
//! Falls back to the Mozilla roots (webpki) when the trust store cannot be read.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;
use ureq::tls::{Certificate, RootCerts};

const SYSTEM_ROOTS: &str = "/System/Library/Keychains/SystemRootCertificates.keychain";
const SYSTEM_KEYCHAIN: &str = "/Library/Keychains/System.keychain";
const ADMIN_TRUST: &str = "/Library/Security/Trust Settings/Admin.plist";
const CACHE_VERSION: u32 = 1;

fn cache_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches/scrim").join(format!("roots-v{CACHE_VERSION}.pem")))
}

fn signature() -> String {
    [SYSTEM_ROOTS, SYSTEM_KEYCHAIN, ADMIN_TRUST]
        .iter()
        .map(|p| {
            let t = std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
            format!("{p}={t}")
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn run(args: &[&str]) -> Option<String> {
    let out = Command::new("/usr/bin/security").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// SHA-1 hashes of certificates the admin trust settings trust as roots. An entry without
/// constraints means "always trust"; one whose constraints deny (result 3) is left out.
fn admin_trusted() -> Vec<String> {
    let dir = std::env::temp_dir().join(format!("scrim-trust-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("admin.plist");
    let mut out = Vec::new();
    if run(&["trust-settings-export", "-d", file.to_str().unwrap_or_default()]).is_some() {
        if let Ok(o) = Command::new("/usr/bin/plutil").args(["-convert", "xml1", "-o", "-"]).arg(&file).output() {
            let xml = String::from_utf8_lossy(&o.stdout);
            let keys: Vec<(usize, &str)> = xml
                .match_indices("<key>")
                .filter_map(|(i, _)| {
                    let k = &xml[i + 5..];
                    let end = k.find("</key>")?;
                    let key = &k[..end];
                    (key.len() == 40 && key.chars().all(|c| c.is_ascii_hexdigit())).then_some((i, key))
                })
                .collect();
            for (n, (start, key)) in keys.iter().enumerate() {
                let body = &xml[*start..keys.get(n + 1).map_or(xml.len(), |k| k.0)];
                let denied = body.contains("kSecTrustSettingsResult</key>") && body.split("kSecTrustSettingsResult</key>").skip(1).any(|r| r.trim_start().starts_with("<integer>3<") || r.trim_start().starts_with("<integer>4<"));
                if !denied {
                    out.push(key.to_uppercase());
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    out
}

/// `security find-certificate -Z -p` output: "SHA-1 hash: …" followed by the PEM.
fn certs_with_hashes(keychain: &str) -> Vec<(String, String)> {
    let Some(text) = run(&["find-certificate", "-a", "-Z", "-p", keychain]) else { return vec![] };
    let mut out = Vec::new();
    let mut hash = String::new();
    let mut pem = String::new();
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("SHA-1 hash: ") {
            hash = h.trim().to_uppercase();
        } else if line.starts_with("-----BEGIN CERTIFICATE-----") {
            pem = format!("{line}\n");
        } else if !pem.is_empty() {
            pem.push_str(line);
            pem.push('\n');
            if line.starts_with("-----END CERTIFICATE-----") {
                out.push((std::mem::take(&mut hash), std::mem::take(&mut pem)));
            }
        }
    }
    out
}

fn build() -> String {
    let mut pem: String = certs_with_hashes(SYSTEM_ROOTS).into_iter().map(|(_, p)| p).collect();
    let trusted = admin_trusted();
    for (hash, p) in certs_with_hashes(SYSTEM_KEYCHAIN) {
        if trusted.contains(&hash) {
            pem.push_str(&p);
        }
    }
    pem
}

fn load_pem() -> Option<String> {
    let sig = signature();
    let path = cache_path();
    if let Some(p) = &path {
        if let Ok(text) = std::fs::read_to_string(p) {
            if let Some(rest) = text.strip_prefix(&format!("# {sig}\n")) {
                return Some(rest.to_string());
            }
        }
    }
    let pem = build();
    if pem.is_empty() {
        return None;
    }
    if let Some(p) = &path {
        write_atomic(p, &format!("# {sig}\n{pem}"));
    }
    Some(pem)
}

fn write_atomic(p: &Path, text: &str) {
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = p.with_extension(format!("tmp{}", std::process::id()));
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, p);
    }
}

/// Root certificates for ureq: the macOS trust anchors, or webpki's when unavailable.
pub fn root_certs() -> RootCerts {
    let Some(pem) = load_pem() else { return RootCerts::WebPki };
    let certs: Vec<Certificate<'static>> = ureq::tls::parse_pem(pem.as_bytes())
        .filter_map(|item| match item {
            Ok(ureq::tls::PemItem::Certificate(c)) => Some(c),
            _ => None,
        })
        .collect();
    if certs.is_empty() {
        RootCerts::WebPki
    } else {
        RootCerts::new_with_certs(&certs)
    }
}
