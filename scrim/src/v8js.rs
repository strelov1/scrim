//! V8 backend, used for documents that load a lot of JavaScript: one isolate reused across
//! documents, one context per frame, the same JS bundle and host functions as QuickJS.
use crate::engine::{host_call, Args, Host, Ret};
use crate::net::Net;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Once;
use v8::MapFnTo;
use url::Url;

/// Startup snapshot made by build.rs: a context with the host shim and the whole JS bundle loaded.
static SNAPSHOT: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/scrim.snap"));

thread_local! {
    /// Native callbacks referenced from the snapshot, in the order build.rs registered them.
    static REFS: &'static [v8::ExternalReference] = Box::leak(
        vec![
            v8::ExternalReference { function: host_cb.map_fn_to() },
            v8::ExternalReference { function: eval_cb.map_fn_to() },
            v8::ExternalReference { function: module_cb.map_fn_to() },
            v8::ExternalReference { pointer: std::ptr::null_mut() },
        ]
        .into_boxed_slice(),
    );
}

static INIT: Once = Once::new();

/// Rust string to V8 without V8's scalar UTF-8 decoder: ASCII is copied as one-byte data,
/// anything else is handed over as UTF-16.
fn v8_str<'s>(scope: &mut v8::PinScope<'s, '_>, s: &str) -> v8::Local<'s, v8::String> {
    if s.is_ascii() {
        v8::String::new_from_one_byte(scope, s.as_bytes(), v8::NewStringType::Normal).unwrap()
    } else {
        let u: Vec<u16> = s.encode_utf16().collect();
        v8::String::new_from_two_byte(scope, &u, v8::NewStringType::Normal).unwrap()
    }
}

/// Per-isolate state reachable from native callbacks.
struct Slot {
    host: Rc<RefCell<Host>>,
    net: Net,
    module_urls: HashMap<i32, String>,
    modules: HashMap<String, v8::Global<v8::Module>>,
}

pub struct Js {
    ctxs: Vec<v8::Global<v8::Context>>,
    /// Always Some while alive; returned to POOL on drop.
    isolate: Option<v8::OwnedIsolate>,
}

thread_local! {
    /// One isolate reused across documents: a fresh isolate per page leaves its memory
    /// mapped, so a long session's RSS would keep growing.
    static POOL: std::cell::RefCell<Option<v8::OwnedIsolate>> = const { std::cell::RefCell::new(None) };
}

impl Drop for Js {
    fn drop(&mut self) {
        self.ctxs.clear(); // the contexts' globals go before the heap is collected
        // No forced collection: a low-memory notification also drops V8's compilation cache,
        // which a session reloading the same scripts relies on; V8 collects on its own.
        if let Some(iso) = self.isolate.take() {
            POOL.with(|p| *p.borrow_mut() = Some(iso));
        }
    }
}

fn origin<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str, module: bool) -> v8::ScriptOrigin<'s> {
    let n = v8::String::new(scope, name).unwrap();
    v8::ScriptOrigin::new(scope, n.into(), 0, 0, false, 0, None, false, false, module, None)
}

fn exc_text(tc: &mut v8::PinnedRef<'_, v8::TryCatch<v8::HandleScope>>) -> String {
    let msg = tc.exception().map(|e| e.to_rust_string_lossy(tc)).unwrap_or_else(|| "unknown error".into());
    let stack = tc.stack_trace().map(|s| s.to_rust_string_lossy(tc)).unwrap_or_default();
    format!("{msg} {stack}")
}

fn set_ret(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, r: Ret) {
    match r {
        Ret::Undef => {}
        Ret::S(s) => rv.set(v8_str(scope, &s).into()),
        Ret::N(n) => rv.set(v8::Number::new(scope, n).into()),
        Ret::B(b) => rv.set(v8::Boolean::new(scope, b).into()),
        Ret::List(l) => {
            let arr = v8::Array::new(scope, l.len() as i32);
            for (i, s) in l.iter().enumerate() {
                let v = v8_str(scope, s);
                arr.set_index(scope, i as u32, v.into());
            }
            rv.set(arr.into());
        }
    }
}

fn host_cb(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let frame = args.get(0).to_rust_string_lossy(scope).parse().unwrap_or(0);
    let name = args.get(1).to_rust_string_lossy(scope);
    let mut a = Vec::with_capacity(args.length().max(2) as usize - 2);
    for i in 2..args.length() {
        a.push(args.get(i).to_rust_string_lossy(scope));
    }
    let host = scope.get_slot::<Slot>().unwrap().host.clone();
    let r = host_call(&host, frame, &name, Args(&a));
    set_ret(scope, &mut rv, r);
}

/// Classic script in the global scope (sloppy mode); rethrows to the JS caller.
fn eval_cb(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let src = args.get(0).to_string(scope).unwrap();
    v8::tc_scope!(let tc, scope);
    let o = origin(tc, "script", false);
    if let Some(script) = v8::Script::compile(tc, src, Some(&o)) {
        script.run(tc);
    }
    if tc.has_caught() {
        tc.rethrow();
    }
}

fn compile_module<'s>(scope: &mut v8::PinScope<'s, '_>, src: &str, url: &str) -> Option<v8::Local<'s, v8::Module>> {
    let s = v8_str(scope, src);
    let o = origin(scope, url, true);
    let mut source = v8::script_compiler::Source::new(s, Some(&o));
    let m = v8::script_compiler::compile_module(scope, &mut source)?;
    let g = v8::Global::new(scope, m);
    let slot = scope.get_slot_mut::<Slot>().unwrap();
    slot.module_urls.insert(m.get_identity_hash().get(), url.to_string());
    slot.modules.insert(url.to_string(), g);
    Some(m)
}

fn resolve_cb<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _attrs: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    let spec = specifier.to_rust_string_lossy(scope);
    let (base, net) = {
        let slot = scope.get_slot::<Slot>().unwrap();
        (slot.module_urls.get(&referrer.get_identity_hash().get()).cloned().unwrap_or_default(), slot.net.clone())
    };
    let url = Url::parse(&base).and_then(|b| b.join(&spec)).or_else(|_| Url::parse(&spec)).ok()?.to_string();
    if let Some(g) = scope.get_slot::<Slot>().unwrap().modules.get(&url) {
        return Some(v8::Local::new(scope, g));
    }
    let src = net.fetch("GET", &url, &[], None).ok()?.text();
    compile_module(scope, &src, &url)
}

/// `import.meta.url` of a module: the URL it was loaded from (bundlers resolve assets with
/// `new URL(path, import.meta.url)`).
unsafe extern "C" fn import_meta_cb(context: v8::Local<v8::Context>, module: v8::Local<v8::Module>, meta: v8::Local<v8::Object>) {
    v8::callback_scope!(unsafe scope, context);
    let url = scope.get_slot::<Slot>().and_then(|s| s.module_urls.get(&module.get_identity_hash().get()).cloned());
    if let Some(url) = url {
        let k = v8_str(scope, "url");
        let v = v8_str(scope, &url);
        meta.set(scope, k.into(), v.into());
    }
}

/// Module script: returns the evaluation promise (top-level await).
fn module_cb(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let src = args.get(0).to_rust_string_lossy(scope);
    let url = args.get(1).to_rust_string_lossy(scope);
    v8::tc_scope!(let tc, scope);
    let Some(m) = compile_module(tc, &src, &url) else {
        tc.rethrow();
        return;
    };
    if m.instantiate_module(tc, resolve_cb).is_none() {
        tc.rethrow();
        return;
    }
    match m.evaluate(tc) {
        Some(p) => rv.set(p),
        None => {
            tc.rethrow();
        }
    }
}

impl Js {
    pub fn new(host: Rc<RefCell<Host>>, net: Net) -> Result<Js, String> {
        INIT.call_once(|| {
            let platform = v8::new_default_platform(0, false).make_shared();
            v8::V8::initialize_platform(platform);
            v8::V8::initialize();
        });
        let mut isolate = POOL.with(|p| p.borrow_mut().take()).unwrap_or_else(|| {
            let params = v8::CreateParams::default()
                .heap_limits(0, 1 << 30)
                .snapshot_blob(SNAPSHOT.into())
                .external_references(std::borrow::Cow::Borrowed(REFS.with(|r| *r)));
            let mut iso = v8::Isolate::new(params);
            iso.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
            iso
        });
        isolate.set_slot(Slot { host, net, module_urls: HashMap::new(), modules: HashMap::new() });
        isolate.set_host_initialize_import_meta_object_callback(import_meta_cb);
        Ok(Js { ctxs: vec![], isolate: Some(isolate) })
    }

    /// A new context from the snapshot (bundle already loaded); only the frame number is set.
    pub fn add_frame(&mut self, frame: usize) -> Result<(), String> {
        let isolate = self.isolate.as_mut().unwrap();
        v8::scope!(let scope, isolate);
        let ctx = v8::Context::new(scope, Default::default());
        let global_ctx = v8::Global::new(scope, ctx);
        let scope = &mut v8::ContextScope::new(scope, ctx);
        let global = ctx.global(scope);
        let k = v8::String::new(scope, "__frameNo").unwrap();
        let v = v8::Integer::new(scope, frame as i32);
        global.set(scope, k.into(), v.into());
        self.ctxs.push(global_ctx);
        Ok(())
    }

    /// Call a dotted JS function path with string args; returns its result as a string.
    pub fn call(&mut self, frame: usize, path: &str, args: &[String]) -> Result<String, String> {
        let gctx = self.ctxs.get(frame).ok_or("no page")?.clone();
        let isolate = self.isolate.as_mut().unwrap();
        v8::scope!(let scope, isolate);
        let ctx = v8::Local::new(scope, &gctx);
        let scope = &mut v8::ContextScope::new(scope, ctx);
        v8::tc_scope!(let tc, scope);
        let mut obj: v8::Local<v8::Value> = ctx.global(tc).into();
        let mut recv = obj;
        for p in path.split('.') {
            let o = v8::Local::<v8::Object>::try_from(obj).map_err(|_| format!("{path}: not an object"))?;
            let k = v8::String::new(tc, p).unwrap();
            recv = obj;
            obj = o.get(tc, k.into()).ok_or(format!("{path}: missing {p}"))?;
        }
        let func = v8::Local::<v8::Function>::try_from(obj).map_err(|_| format!("{path} is not a function"))?;
        let argv: Vec<v8::Local<v8::Value>> = args.iter().map(|a| v8_str(tc, a).into()).collect();
        let r = match func.call(tc, recv, &argv) {
            Some(r) => r,
            None => return Err(exc_text(tc)),
        };
        Ok(if r.is_null_or_undefined() {
            String::new()
        } else if r.is_string() {
            r.to_rust_string_lossy(tc)
        } else {
            v8::json::stringify(tc, r).map(|s| s.to_rust_string_lossy(tc)).unwrap_or_default()
        })
    }

    /// V8 collects the build's temporaries on its own (see Drop).
    pub fn collect_garbage(&mut self) {}

    /// Run microtasks until none are left. V8 swallows their exceptions.
    pub fn run_jobs(&mut self) -> Vec<String> {
        self.isolate.as_mut().unwrap().perform_microtask_checkpoint();
        vec![]
    }
}
