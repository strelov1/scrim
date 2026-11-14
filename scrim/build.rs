//! Precompile the JS bundle to QuickJS bytecode so each new page context loads it
//! instead of parsing ~150 KB of JavaScript.
use rquickjs::{Context, Module, Runtime};

const FILES: &[&str] = &["prelude", "dom", "html", "style", "window", "agent"];

fn main() {
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    v8_snapshot::make(&out);
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    for f in FILES {
        let path = format!("js/{f}.js");
        println!("cargo:rerun-if-changed={path}");
        println!("cargo:rerun-if-changed=src/shim.rs");
        let src = std::fs::read_to_string(&path).unwrap();
        let bytes = ctx.with(|ctx| {
            let m = Module::declare(ctx.clone(), format!("scrim:{f}"), src).unwrap_or_else(|e| panic!("{path}: {e}"));
            m.write_le().unwrap()
        });
        std::fs::write(out.join(format!("{f}.qbc")), bytes).unwrap();
    }
}

/// V8 startup snapshot: a context with the host shim and the bundle already evaluated.
/// Native callbacks are placeholders here; the binary registers the real ones in the same order.
mod v8_snapshot {
    use v8::MapFnTo;

    fn placeholder(_: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {}
    fn placeholder2(_: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {}
    fn placeholder3(_: &mut v8::PinScope, _: v8::FunctionCallbackArguments, _: v8::ReturnValue) {}

    pub fn make(out: &std::path::Path) {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
        let refs: &'static [v8::ExternalReference] = Box::leak(
            vec![
                v8::ExternalReference { function: placeholder.map_fn_to() },
                v8::ExternalReference { function: placeholder2.map_fn_to() },
                v8::ExternalReference { function: placeholder3.map_fn_to() },
                v8::ExternalReference { pointer: std::ptr::null_mut() },
            ]
            .into_boxed_slice(),
        );
        let mut iso = v8::Isolate::snapshot_creator(Some(std::borrow::Cow::Borrowed(refs)), None);
        {
            v8::scope!(let scope, &mut iso);
            let ctx = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, ctx);
            let global = ctx.global(scope);
            let fns = [
                ("__hostcall", v8::Function::new(scope, placeholder).unwrap()),
                ("__evalScript", v8::Function::new(scope, placeholder2).unwrap()),
                ("__runModule", v8::Function::new(scope, placeholder3).unwrap()),
            ];
            for (k, f) in fns {
                let k = v8::String::new(scope, k).unwrap();
                global.set(scope, k.into(), f.into());
            }
            let mut sources = vec![("shim".to_string(), SHIM.to_string())];
            for f in super::FILES {
                let path = format!("js/{f}.js");
                sources.push((path.clone(), std::fs::read_to_string(&path).unwrap()));
            }
            for (name, src) in sources {
                v8::tc_scope!(let tc, scope);
                let s = v8::String::new(tc, &src).unwrap();
                let ok = v8::Script::compile(tc, s, None).and_then(|sc| sc.run(tc)).is_some();
                if !ok {
                    let e = tc.exception().map(|e| e.to_rust_string_lossy(tc)).unwrap_or_default();
                    panic!("snapshot: {name}: {e}");
                }
            }
            // Warm-up: run the hot paths once so their bytecode is in the snapshot, then reset.
            {
                v8::tc_scope!(let tc, scope);
                let s = v8::String::new(tc, WARMUP).unwrap();
                if v8::Script::compile(tc, s, None).and_then(|sc| sc.run(tc)).is_none() {
                    let e = tc.exception().map(|e| e.to_rust_string_lossy(tc)).unwrap_or_default();
                    panic!("snapshot warm-up: {e}");
                }
            }
            scope.set_default_context(ctx);
        }
        let blob = iso.create_blob(v8::FunctionCodeHandling::Keep).expect("snapshot blob");
        std::fs::write(out.join("scrim.snap"), &*blob).unwrap();
    }

    include!("src/shim.rs");

    /// Exercises parse-build, cascade, text, snapshot and locators on a throwaway tree in the
    /// window's document, then empties it and resets the counters, so nothing leaks into pages.
    const WARMUP: &str = r#"(function () {
      const S = __scrim, doc = S.doc;
      const ops = [1, 'html', [], 1, 'head', [], 1, 'title', [], 3, 'w', 0, 0, 1, 'body', ['class', 'a b', 'id', 'x'],
        1, 'nav', ['class', 'n'], 1, 'a', ['href', '/x'], 3, 'link', 0, 0, 1, 'div', ['class', 'c', 'style', 'display:none'], 3, 'hidden', 0,
        1, 'p', [], 3, ' some  text ', 1, 'b', [], 3, 'bold', 0, 0, 1, 'ul', [], 1, 'li', [], 3, 'one', 0, 1, 'li', [], 3, 'two', 0, 0,
        1, 'table', [], 1, 'tbody', [], 1, 'tr', [], 1, 'td', [], 3, 'a', 0, 1, 'td', [], 3, 'b', 0, 0, 0, 0,
        1, 'form', [], 1, 'label', ['for', 'q'], 3, 'Query', 0, 1, 'input', ['id', 'q', 'name', 'q'], 0, 1, 'select', [], 1, 'option', [], 3, 'o', 0, 0,
        1, 'button', [], 3, 'Go', 0, 0, 0, 0];
      for (let i = 0; i < 20; i++) {
        S.replaceAll(doc, null);
        S.buildOps(doc, ops, doc, { attrs() {}, close() {} });
        S.gen++;
        S.agent.text(); S.agent.snapshot(); S.agent.markdown();
        S.find({ role: 'button', name: 'Go' }); S.find({ label: 'Query' }); S.find({ text: 'bold' });
        doc.querySelectorAll('li, .c, #x a[href]');
      }
      S.replaceAll(doc, null);
      S.nodeSeq = 0; S.gen = 0; doc._styleIndex = null;
    })();"#;
}
