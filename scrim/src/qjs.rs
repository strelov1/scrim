//! QuickJS backend (default): rquickjs runtime per document, one context per frame, the JS
//! bundle loaded from bytecode compiled by build.rs.
use crate::engine::{host_call, Args, Host, Ret};
use crate::net::Net;
use rquickjs::function::Rest;
use rquickjs::loader::{Loader, Resolver};
use rquickjs::{CatchResultExt, Context, Ctx, Function, IntoJs, Module, Runtime, Value};
use std::cell::RefCell;
use std::rc::Rc;
use url::Url;

const BUNDLE: &[(&str, &[u8])] = &[
    ("prelude", include_bytes!(concat!(env!("OUT_DIR"), "/prelude.qbc"))),
    ("dom", include_bytes!(concat!(env!("OUT_DIR"), "/dom.qbc"))),
    ("html", include_bytes!(concat!(env!("OUT_DIR"), "/html.qbc"))),
    ("style", include_bytes!(concat!(env!("OUT_DIR"), "/style.qbc"))),
    ("window", include_bytes!(concat!(env!("OUT_DIR"), "/window.qbc"))),
    ("agent", include_bytes!(concat!(env!("OUT_DIR"), "/agent.qbc"))),
];

struct ModResolver;
impl Resolver for ModResolver {
    fn resolve<'js>(&mut self, _ctx: &Ctx<'js>, base: &str, name: &str) -> rquickjs::Result<String> {
        let b = Url::parse(base).map_err(|_| rquickjs::Error::new_resolving(base, name))?;
        b.join(name).map(|u| u.to_string()).map_err(|_| rquickjs::Error::new_resolving(base, name))
    }
}
struct ModLoader {
    net: Net,
}
impl Loader for ModLoader {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str) -> rquickjs::Result<Module<'js, rquickjs::module::Declared>> {
        let src = self.net.fetch("GET", name, &[], None).map(|r| r.text()).map_err(|_| rquickjs::Error::new_loading(name))?;
        let m = Module::declare(ctx.clone(), name, src)?;
        m.meta()?.set("url", name)?;
        Ok(m)
    }
}

fn js_err(ctx: &Ctx, e: rquickjs::Error) -> String {
    if let rquickjs::Error::Exception = e {
        let v = ctx.catch();
        if let Some(ex) = v.as_exception() {
            return format!("{} {}", ex.message().unwrap_or_default(), ex.stack().unwrap_or_default());
        }
        return format!("{v:?}");
    }
    e.to_string()
}

impl<'js> IntoJs<'js> for Ret {
    fn into_js(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        match self {
            Ret::Undef => Ok(Value::new_undefined(ctx.clone())),
            Ret::S(s) => s.into_js(ctx),
            Ret::N(n) => n.into_js(ctx),
            Ret::B(b) => b.into_js(ctx),
            Ret::List(l) => l.into_js(ctx),
        }
    }
}

fn run_module<'js>(ctx: Ctx<'js>, src: String, name: String) -> rquickjs::Result<Value<'js>> {
    let m = Module::declare(ctx.clone(), name.clone(), src)?;
    // import.meta.url: bundlers resolve assets with `new URL(path, import.meta.url)`.
    m.meta()?.set("url", name)?;
    let (_, promise) = m.eval()?;
    Ok(promise.into_value())
}

fn eval_script<'js>(ctx: Ctx<'js>, src: String) -> rquickjs::Result<()> {
    let mut o = rquickjs::context::EvalOptions::default();
    o.strict = false;
    ctx.eval_with_options::<(), _>(src, o)
}

pub struct Js {
    rt: Runtime,
    ctxs: Vec<Context>,
    host: Rc<RefCell<Host>>,
}

impl Js {
    pub fn new(host: Rc<RefCell<Host>>, net: Net) -> Result<Js, String> {
        let t = std::time::Instant::now();
        let rt = Runtime::new().map_err(|e| e.to_string())?;
        if std::env::var_os("SCRIM_PROFILE").is_some() { eprintln!("[prof] qjs runtime {:.2} ms", t.elapsed().as_secs_f64()*1e3); }
        rt.set_memory_limit(1 << 30);
        rt.set_max_stack_size(4 << 20);
        rt.set_loader(ModResolver, ModLoader { net });
        Ok(Js { rt, ctxs: vec![], host })
    }

    pub fn add_frame(&mut self, frame: usize) -> Result<(), String> {
        let ctx = Context::full(&self.rt).map_err(|e| e.to_string())?;
        let host = self.host.clone();
        ctx.with(|ctx| -> Result<(), String> {
            let g = ctx.globals();
            let f = Function::new(ctx.clone(), move |fr: String, name: String, args: Rest<String>| -> Ret {
                host_call(&host, fr.parse().unwrap_or(frame), &name, Args(&args.0))
            })
                .map_err(|e| e.to_string())?;
            g.set("__hostcall", f).map_err(|e| e.to_string())?;
            g.set("__evalScript", Function::new(ctx.clone(), eval_script).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            g.set("__runModule", Function::new(ctx.clone(), run_module).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            ctx.eval::<(), _>(format!("globalThis.__frameNo={frame};{}", crate::shim::SHIM)).map_err(|e| js_err(&ctx, e))?;
            for (name, bytes) in BUNDLE {
                let t = std::time::Instant::now();
                // SAFETY: the bytecode was produced by build.rs with the same QuickJS version.
                let m = unsafe { Module::load(ctx.clone(), bytes) }.map_err(|e| format!("{name}: {}", js_err(&ctx, e)))?;
                let t1 = t.elapsed();
                m.eval().map_err(|e| format!("{name}: {}", js_err(&ctx, e)))?;
                if std::env::var_os("SCRIM_PROFILE").is_some() { eprintln!("[prof] qjs {name}: load {:.2} eval {:.2} ms", t1.as_secs_f64()*1e3, (t.elapsed()-t1).as_secs_f64()*1e3); }
            }
            Ok(())
        })?;
        self.ctxs.push(ctx);
        Ok(())
    }

    /// Call a dotted JS function path with string args; returns its result as a string.
    pub fn call(&mut self, frame: usize, path: &str, args: &[String]) -> Result<String, String> {
        let f = self.ctxs.get(frame).ok_or("no page")?;
        f.with(|ctx| {
            let mut obj: Value = ctx.globals().into_value();
            let mut func: Option<Function> = None;
            let parts: Vec<&str> = path.split('.').collect();
            for (i, p) in parts.iter().enumerate() {
                let o = obj.as_object().ok_or(format!("{path}: not an object"))?.clone();
                let v: Value = o.get(*p).map_err(|e| e.to_string())?;
                if i == parts.len() - 1 {
                    func = v.as_function().cloned();
                }
                obj = v;
            }
            let func = func.ok_or(format!("{path} is not a function"))?;
            let a: Vec<Value> = args.iter().map(|s| rquickjs::String::from_str(ctx.clone(), s).unwrap().into_value()).collect();
            let mut argv = rquickjs::function::Args::new(ctx.clone(), a.len());
            for v in a {
                argv.push_arg(v).map_err(|e| e.to_string())?;
            }
            let r: Value = func.call_arg(argv).catch(&ctx).map_err(|e| e.to_string())?;
            Ok(if r.is_undefined() || r.is_null() {
                String::new()
            } else if let Some(s) = r.as_string() {
                s.to_string().unwrap_or_default()
            } else {
                ctx.json_stringify(r).ok().flatten().and_then(|s| s.to_string().ok()).unwrap_or_default()
            })
        })
    }

    /// Full collection (after building a document: drops the op stream and other temporaries).
    pub fn collect_garbage(&mut self) {
        self.rt.run_gc();
    }

    /// Run microtasks until none are left; returns the errors they threw.
    pub fn run_jobs(&mut self) -> Vec<String> {
        let mut errs = vec![];
        for _ in 0..100000 {
            match self.rt.execute_pending_job() {
                Ok(true) => {}
                Ok(false) => break,
                Err(e) => errs.push(e.0.with(|ctx| {
                    let v = ctx.catch();
                    v.as_exception().map(|x| x.message().unwrap_or_default()).unwrap_or_else(|| format!("{v:?}"))
                })),
            }
        }
        errs
    }
}
