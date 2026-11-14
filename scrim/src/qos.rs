//! Thread priority on macOS: threads on the critical path (fetch, parse, style preload,
//! parallel matching) ask for performance cores.
#[cfg(target_os = "macos")]
extern "C" {
    fn pthread_set_qos_class_self_np(qos: u32, relpri: i32) -> i32;
}

#[cfg(target_os = "macos")]
pub fn critical() {
    // QOS_CLASS_USER_INTERACTIVE
    unsafe { pthread_set_qos_class_self_np(0x21, 0) };
}


#[cfg(not(target_os = "macos"))]
pub fn critical() {}
