//! 原生侧共享的 HTTP 客户端。
//!
//! 模型请求代理（`model_proxy`）与网页抓取（`web`）都要求复用连接池，并且访问内网目标时
//! 必须绕过系统代理，因此客户端的构造与选择统一收敛在这里，调用方只关心目标 URL。

use std::sync::OnceLock;

/// 全局复用的 HTTP 客户端：内部维护连接池，避免每次请求重建。
pub(crate) fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// 内网直连客户端：显式 `no_proxy`，不继承任何环境变量代理（开发者 Jan）。
///
/// reqwest 默认会读 `http_proxy` / `ALL_PROXY` 等环境变量；本机挂着代理时，指向内网的
/// 请求会被送进代理，而代理出口在公网侧回不到内网，于是在建连阶段就报
/// `error sending request for url`——终端里 curl 能通正是因为 curl 对内网地址默认直连。
fn http_direct_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("构建内网直连 HTTP 客户端失败")
    })
}

/**
 * 判断目标 URL 是否应绕过代理直连（开发者 Jan）。
 *
 * 只对「代理几乎必然不可达」的内网目标直连：回环、私有网段（RFC1918）、链路本地、
 * IPv6 回环与唯一本地段、`localhost` 与 `*.local`。公网地址（如经代理访问的境外
 * 模型 API）保持继承代理的原行为，不影响需要代理才能出网的场景。
 * 解析不出主机的 URL 交回默认客户端，由后续请求流程自行报错。
 */
pub(crate) fn should_bypass_proxy(url: &str) -> bool {
    let parsed = match reqwest::Url::parse(url) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    // fc00::/7 唯一本地地址（ULA）：is_unique_local 仍在稳定化之外，按位判断
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
            }
        };
    }
    host == "localhost" || host.ends_with(".local")
}

/// 按 URL 选客户端：内网直连、公网走共享连接池（含代理语义）。
pub(crate) fn client_for(url: &str) -> &'static reqwest::Client {
    if should_bypass_proxy(url) {
        http_direct_client()
    } else {
        http_client()
    }
}
