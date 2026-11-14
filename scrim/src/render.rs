//! Screenshots: the page's current DOM (after scripts and actions) is styled, laid out and
//! painted by Blitz (Stylo + Taffy + Parley + Vello CPU) into a PNG. scrim itself still has no
//! layout: this runs only on request. Subresources (stylesheets, images, fonts) go through
//! scrim's own network stack, so the screenshot sees the session's cookies.
use crate::net::Net;
use anyrender::{render_to_buffer, PaintScene as _};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{util::Color, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use blitz_traits::shell::{ColorScheme, Viewport};
use peniko::kurbo::Rect;
use peniko::Fill;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub struct Options {
    pub width: u32,
    pub height: u32,
    pub full_page: bool,
    /// Give up waiting for subresources after this; whatever arrived is painted.
    pub net_timeout: Duration,
}

/// Tallest full-page capture, in CSS pixels; longer pages are cut here.
pub const MAX_HEIGHT: u32 = 16_000;
/// Concurrent subresource fetches.
const MAX_FETCHES: usize = 8;

struct ScrimNet {
    net: Net,
    pending: Arc<AtomicUsize>,
    slots: Arc<(std::sync::Mutex<usize>, std::sync::Condvar)>,
    /// Signalled when a fetch finishes, so the resolve loop wakes at once instead of polling.
    done: Arc<(std::sync::Mutex<u64>, std::sync::Condvar)>,
}

impl NetProvider for ScrimNet {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        if request.url.scheme() == "data" {
            match data_url::DataUrl::process(&url).ok().and_then(|d| d.decode_to_vec().ok()) {
                Some((body, _)) => handler.bytes(url, Bytes::from(body)),
                None => handler.error(url, "bad data: URL".into()),
            }
            return;
        }
        if !matches!(request.url.scheme(), "http" | "https") || request.method != blitz_traits::net::Method::GET {
            handler.error(url, "not fetched".into());
            return;
        }
        if let Some(r) = self.net.cached(&url) {
            handler.bytes(r.url.clone(), Bytes::from(r.body));
            return;
        }
        self.pending.fetch_add(1, Ordering::SeqCst);
        let (net, pending, slots, done) = (self.net.clone(), self.pending.clone(), self.slots.clone(), self.done.clone());
        std::thread::spawn(move || {
            {
                let (lock, cv) = &*slots;
                let mut busy = cv.wait_while(lock.lock().unwrap(), |n| *n >= MAX_FETCHES).unwrap();
                *busy += 1;
            }
            match net.fetch("GET", &url, &[], None) {
                Ok(r) if r.status < 400 => handler.bytes(r.url, Bytes::from(r.body)),
                Ok(r) => handler.error(url, format!("HTTP {}", r.status)),
                Err(e) => handler.error(url, e),
            }
            let (lock, cv) = &*slots;
            *lock.lock().unwrap() -= 1;
            cv.notify_one();
            pending.fetch_sub(1, Ordering::SeqCst);
            let (lock, cv) = &*done;
            *lock.lock().unwrap() += 1;
            cv.notify_all();
        });
    }
}

/// Paint `html` (resolved against `base_url`) and return it as PNG bytes plus its size.
pub fn screenshot(html: &str, base_url: &str, net: &Net, o: &Options) -> Result<(Vec<u8>, u32, u32), String> {
    let prof = std::env::var_os("SCRIM_PROFILE").is_some();
    let tp = Instant::now();
    let lap = |what: &str, t: &mut Instant| {
        if prof {
            eprintln!("[prof] render {what} {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
        }
        *t = Instant::now();
    };
    let mut tl = tp;
    let pending = Arc::new(AtomicUsize::new(0));
    let done: Arc<(std::sync::Mutex<u64>, std::sync::Condvar)> = Arc::new(Default::default());
    let provider = Arc::new(ScrimNet { net: net.clone(), pending: pending.clone(), slots: Arc::new(Default::default()), done: done.clone() });
    let fonts = crate::fonts::context_for(html);
    lap("fonts", &mut tl);
    let mut doc = HtmlDocument::from_html(
        html,
        DocumentConfig {
            base_url: Some(base_url.to_string()),
            net_provider: Some(provider as _),
            viewport: Some(Viewport::new(o.width, o.height, 1.0, ColorScheme::Light)),
            font_ctx: Some(fonts),
            ..Default::default()
        },
    );
    lap("from_html", &mut tl);
    let t0 = Instant::now();
    // Each resolve restyles and lays out the whole document, so wait for every outstanding fetch
    // before the next one instead of resolving after each completion; repeat only while a resolve
    // starts new fetches (fonts and @imports found by styling).
    loop {
        doc.resolve(0.0);
        if pending.load(Ordering::SeqCst) == 0 || t0.elapsed() > o.net_timeout {
            break;
        }
        let (lock, cv) = &*done;
        let mut guard = lock.lock().unwrap();
        while pending.load(Ordering::SeqCst) > 0 {
            let left = o.net_timeout.saturating_sub(t0.elapsed());
            if left.is_zero() {
                break;
            }
            guard = cv.wait_timeout(guard, left.min(Duration::from_millis(50))).unwrap().0;
        }
    }
    lap("net+resolve loop", &mut tl);
    doc.as_mut().resolve(0.0);
    lap("final resolve", &mut tl);
    let height = if o.full_page {
        {
            // The page's scroll height, as Blitz's own viewport scrolling computes it.
            let root = doc.as_ref().root_element();
            (root.final_layout().size.height.max(root.scroll_height()).ceil() as u32).clamp(o.height, MAX_HEIGHT)
        }
    } else {
        o.height
    };
    let (w, h) = (o.width, height);
    let rgba = render_to_buffer::<VelloCpuImageRenderer, _>(
        |scene| {
            scene.fill(Fill::NonZero, Default::default(), Color::WHITE, Default::default(), &Rect::new(0.0, 0.0, w as f64, h as f64));
            paint_scene(scene, doc.as_mut(), 1.0, w, h, 0, 0);
        },
        w,
        h,
    );
    lap("paint", &mut tl);
    let mut png_bytes = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png_bytes, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        // fdeflate: several times faster than the default level, slightly larger files.
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    }
    lap("png", &mut tl);
    Ok((png_bytes, w, h))
}
