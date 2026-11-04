//! `network.system_proxy`：宿主自己发起的 HTTP（TSim、消息图片下载）是否走系统代理。
//! 官方页面的连接由系统 WebView 管理，不受这里影响。

use std::sync::atomic::{AtomicBool, Ordering};

static USE_SYSTEM_PROXY: AtomicBool = AtomicBool::new(true);

pub fn set_use_system_proxy(enabled: bool) {
    USE_SYSTEM_PROXY.store(enabled, Ordering::Relaxed);
}

pub fn use_system_proxy() -> bool {
    USE_SYSTEM_PROXY.load(Ordering::Relaxed)
}

/// 按当前开关配置一次性 client。
pub fn apply(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    if use_system_proxy() {
        builder
    } else {
        builder.no_proxy()
    }
}
