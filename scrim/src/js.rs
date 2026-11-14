//! The page's JavaScript engine, chosen per document: QuickJS for kilobytes of script (it starts
//! faster), V8 when the document loads a lot of JavaScript (a JIT pays off for megabytes).
use crate::engine::Host;
use crate::net::Net;
use std::cell::RefCell;
use std::rc::Rc;

/// JavaScript a document loads (inline plus external scripts) above which V8 is used.
pub const HEAVY_JS_BYTES: usize = 256 * 1024;

pub enum Js {
    Quick(crate::qjs::Js),
    V8(crate::v8js::Js),
}

macro_rules! each {
    ($self:ident, $js:ident => $e:expr) => {
        match $self {
            Js::Quick($js) => $e,
                    Js::V8($js) => $e,
        }
    };
}

impl Js {
    pub fn quick(host: Rc<RefCell<Host>>, net: Net) -> Result<Js, String> {
        Ok(Js::Quick(crate::qjs::Js::new(host, net)?))
    }

    /// The engine for a document loading `js_bytes` of script.
    pub fn for_weight(host: Rc<RefCell<Host>>, net: Net, js_bytes: usize) -> Result<Js, String> {
            if js_bytes > HEAVY_JS_BYTES {
            return Ok(Js::V8(crate::v8js::Js::new(host, net)?));
        }
        Self::quick(host, net)
    }

    pub fn add_frame(&mut self, frame: usize) -> Result<(), String> {
        each!(self, js => js.add_frame(frame))
    }
    pub fn call(&mut self, frame: usize, path: &str, args: &[String]) -> Result<String, String> {
        each!(self, js => js.call(frame, path, args))
    }
    pub fn run_jobs(&mut self) -> Vec<String> {
        each!(self, js => js.run_jobs())
    }
    pub fn collect_garbage(&mut self) {
        each!(self, js => js.collect_garbage())
    }
}
