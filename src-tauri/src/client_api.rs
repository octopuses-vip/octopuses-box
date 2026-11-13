//! octopuses-server 客户端接口封装。
//!
//! 用户登录与「当前用户可用模型」查询统一收敛在这里：服务端未开启 CORS，浏览器与 WebView
//! 里的 `fetch` 会被同源策略拦截，因此请求必须由 Rust 侧发起，前端只负责 `invoke` 命令并渲染。
//!
//! 契约见《Octopuses 客户端接口文档》：接口前缀 `/api/client`，**判定成功的标准是响应体
//! `code == 0` 而不是仅看 HTTP 200**，失败时 `data` 恒为 `null`。

use std::sync::OnceLock;

use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// 服务端默认监听地址，可由环境变量 `OCTOPUSES_HOST` 覆盖
const DEFAULT_HOST: &str = "127.0.0.1";
/// 服务端默认监听端口，可由环境变量 `OCTOPUSES_PORT` 覆盖
const DEFAULT_PORT: &str = "8000";
/// 客户端接口前缀
const API_PREFIX: &str = "/api/client";
/// 网络层失败（压根没拿到 HTTP 响应）时的错误码：取值与任何 HTTP 状态码都不冲突，
/// 前端据此区分「连不上服务端」和「服务端明确拒绝」
pub(crate) const CODE_NETWORK_ERROR: i32 = -1;

/// 读取环境变量的有效值：缺失或全为空白时返回 `None`，由调用方回落到默认值
fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 管理端（octopuses-server）接入地址。
///
/// 客户端首次启动时由用户填写，随后随配置持久化，并由前端在每次调用时显式传给命令，
/// 因此 Rust 侧不再自己拼地址——环境变量只作为首次配置时表单的预填值，
/// 地址的唯一来源收敛在 `Endpoint` 上，避免散落到各处。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// 主机：可带 https:// 前缀，不含路径；HTTP 仅允许回环地址。
    pub host: String,
    /// 端口：1-65535 的十进制数字串
    pub port: String,
}

impl Endpoint {
    /// 环境变量或默认值：用于首次配置时预填表单，缺失时回落 `127.0.0.1:8000`
    pub fn from_env_or_default() -> Self {
        Self {
            host: env_value("OCTOPUSES_HOST").unwrap_or_else(|| DEFAULT_HOST.to_string()),
            port: env_value("OCTOPUSES_PORT").unwrap_or_else(|| DEFAULT_PORT.to_string()),
        }
    }

    /// 去掉首尾空白：用户从别处粘贴地址时容易带上空格
    pub fn normalized(&self) -> Self {
        Self {
            host: self.host.trim().trim_end_matches('/').to_string(),
            port: self.port.trim().to_string(),
        }
    }

    /// 校验地址格式。
    ///
    /// 用户输入属于系统边界，这里给出可直接展示的中文提示，避免把畸形地址拼进 URL 后
    /// 由底层 HTTP 库抛出难以理解的错误。校验前先规范化，粘贴带来的空格不算错误。
    pub fn validate(&self) -> Result<(), ApiError> {
        let endpoint = self.normalized();
        let host = endpoint.host.as_str();
        if host.is_empty() {
            return Err(invalid_endpoint("请填写管理端地址"));
        }
        if host.chars().any(char::is_whitespace) {
            return Err(invalid_endpoint("管理端地址不能包含空格"));
        }
        Self::validate_port(&endpoint.port)?;
        let url = reqwest::Url::parse(&endpoint.base_url())
            .map_err(|_| invalid_endpoint("请输入有效主机名，可带 https://，端口请单独填写"))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(invalid_endpoint(
                "管理端地址不能包含账号、路径、查询参数或片段",
            ));
        }
        if url.scheme() == "http" && !is_loopback_host(url.host_str().unwrap_or_default()) {
            return Err(invalid_endpoint(
                "远程管理端必须使用 HTTPS；HTTP 仅限本机开发",
            ));
        }
        Ok(())
    }

    /// 校验端口：必须是 1-65535 的十进制整数
    fn validate_port(port: &str) -> Result<(), ApiError> {
        let valid = !port.is_empty()
            && port.chars().all(|ch| ch.is_ascii_digit())
            && port.parse::<u16>().is_ok_and(|value| value > 0);
        if valid {
            return Ok(());
        }
        Err(invalid_endpoint("端口需要是 1-65535 之间的数字"))
    }

    /// 旧配置自动对远程主机使用 HTTPS，本机保留 HTTP。显式协议仍需通过 validate。
    pub fn base_url(&self) -> String {
        let endpoint = self.normalized();
        let prefix = if endpoint.host.contains("://") {
            ""
        } else if is_loopback_host(&endpoint.host) {
            "http://"
        } else {
            "https://"
        };
        format!("{}{}:{}", prefix, endpoint.host, endpoint.port)
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

/// 构造一个「地址格式不合法」的错误：`code` 取 400，与文档中该状态码的语义一致
fn invalid_endpoint(message: &str) -> ApiError {
    ApiError {
        code: 400,
        message: message.to_string(),
    }
}

/// 服务端统一响应信封
#[derive(Deserialize)]
struct ApiEnvelope<T> {
    /// 0 表示成功，其余取值与 HTTP 状态码一致
    code: i32,
    /// 可读的提示或错误文案
    #[serde(default)]
    message: String,
    /// 业务数据；成功时才有值。`Option` 字段天然可缺省，不加 `#[serde(default)]`，
    /// 否则 serde 会给泛型补出 `T: Default` 约束
    data: Option<T>,
}

/// 命令返回给前端的错误。
///
/// 特意带上服务端的 `code`，前端据此区分 401（令牌失效，静默回登录页）与
/// 403（账号被禁用，需要给出明确提示）。
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ApiError {
    /// 服务端错误码，或网络层失败时的 [`CODE_NETWORK_ERROR`]
    pub code: i32,
    /// 可直接展示给用户的中文文案
    pub message: String,
}

/// 登录成功后服务端下发的用户信息
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    /// 用户 ID
    pub id: i64,
    /// 账号
    pub username: String,
    /// 昵称，可能为空字符串
    #[serde(default)]
    pub nickname: String,
    /// 1 = 启用，0 = 禁用
    pub status: i32,
}

/// 登录接口返回体
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginData {
    /// 登录令牌
    pub token: String,
    /// 当前登录用户
    pub user: UserInfo,
}

/// 当前用户被授权、且处于启用状态的模型
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModel {
    /// 模型 ID
    pub id: i64,
    /// 模型标识，作为调用时的模型名
    pub code: String,
    /// 模型展示名称
    pub name: String,
    /// 供应商，如 `OpenAI`，可能为空字符串
    #[serde(default)]
    pub provider: String,
    /// 接入地址（OpenAI 兼容协议的基础 URL）
    pub base_url: String,
    /// 接入密钥，可能为空字符串
    #[serde(default)]
    pub api_key: String,
    /// 模型描述，可能为空字符串
    #[serde(default)]
    pub description: String,
    /// 该模型是否支持图片输入。
    ///
    /// 用 `Option` 而非 `bool`：老版本后台不返回此字段，`None` 表示「后台没有声明」，
    /// 客户端据此回落到用户在设置页的手动开关，而不是直接把能力关死。
    #[serde(default)]
    pub supports_images: Option<bool>,
}

/// 登录请求体，字段名与服务端约定一致
#[derive(Serialize)]
struct LoginRequest<'a> {
    /// 客户端账号，先去除首尾空白
    username: &'a str,
    /// 明文密码，由服务端加盐哈希比对
    password: &'a str,
}

/// 解包服务端响应，把两种失败统一收敛成 [`ApiError`]：
/// 「HTTP 状态码报错」与「HTTP 200 但 `code != 0`」。
///
/// 这是错误文案的唯一生成处，命令层不再各自判断，保证同一错误在各接口表现一致。
fn unwrap_envelope<T: DeserializeOwned>(status: u16, body: &str) -> Result<T, ApiError> {
    match serde_json::from_str::<ApiEnvelope<T>>(body) {
        // 成功响应但缺少数据，属于服务端契约异常，如实报错而不是返回一个空壳
        Ok(envelope) if envelope.code == 0 => envelope.data.ok_or(ApiError {
            code: status as i32,
            message: "服务端返回成功但未携带数据".to_string(),
        }),
        // 服务端已给出可读文案，直接透传，不在此处改写
        Ok(envelope) => Err(ApiError {
            code: envelope.code,
            message: envelope.message,
        }),
        // 非 JSON 响应（网关 HTML、空体等）：回落到状态码，避免把解析错误抛给用户
        Err(_) => Err(ApiError {
            code: status as i32,
            message: format!("服务端返回了无法解析的响应（HTTP {status}）"),
        }),
    }
}

/// 全局复用的 HTTP 客户端：内部维护连接池，避免每次请求重建。
///
/// 对 `pub(crate)` 可见：应用内更新下载安装包走的也是同一条连接池（见 [`crate::updater`]）。
pub(crate) fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// 内网直连客户端：显式 `no_proxy`，不继承任何环境变量代理（开发者 Jan）。
///
/// reqwest 默认会读 `http_proxy` / `ALL_PROXY` 等环境变量；本机挂着代理时，指向内网的
/// 请求会被送进代理，而代理出口在公网侧回不到内网，于是在建连阶段就报
/// `error sending request for url`——终端里 curl 能通正是因为 curl 对内网地址默认直连。
pub(crate) fn http_direct_client() -> &'static reqwest::Client {
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

/// 管理端请求不跟随重定向，避免登录正文或令牌被转发到其它服务或降级 HTTP。
fn management_client_for(url: &str) -> &'static reqwest::Client {
    static DIRECT: OnceLock<reqwest::Client> = OnceLock::new();
    static PROXIED: OnceLock<reqwest::Client> = OnceLock::new();
    let direct = should_bypass_proxy(url);
    let slot = if direct { &DIRECT } else { &PROXIED };
    slot.get_or_init(|| {
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(60));
        let builder = if direct { builder.no_proxy() } else { builder };
        builder.build().expect("构建管理端 HTTP 客户端失败")
    })
}

/// 发起一次客户端接口请求并解包结果。
///
/// `base_url` 由调用方从 [`Endpoint`] 取得，传输层不关心地址的来源与形态；
/// `path` 为接口路径（不含 [`API_PREFIX`]），`query` 为查询参数并由 reqwest 统一编码，
/// 避免调用方各自手工拼接与转义；`token` 非空时注入 `Authorization: Bearer`；
/// `body` 非空时以 JSON 提交。
/// 网络层失败（连不上、超时）同样收敛成 [`ApiError`]，让前端只需处理一种错误结构。
async fn request<T: DeserializeOwned>(
    base_url: &str,
    method: reqwest::Method,
    path: &str,
    query: &[(&str, &str)],
    token: Option<&str>,
    body: Option<serde_json::Value>,
) -> Result<T, ApiError> {
    let url = format!("{base_url}{API_PREFIX}{path}");
    let mut builder = management_client_for(&url).request(method, &url);
    if !query.is_empty() {
        builder = builder.query(query);
    }
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        builder = builder.bearer_auth(token);
    }
    if let Some(body) = body {
        builder = builder.json(&body);
    }

    let response = builder.send().await.map_err(|error| ApiError {
        code: CODE_NETWORK_ERROR,
        message: format!("无法连接服务端 {url}：{error}"),
    })?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|error| ApiError {
        code: status as i32,
        message: format!("读取服务端响应失败：{error}"),
    })?;
    unwrap_envelope(status, &text)
}

/// 探测管理端是否可达：直接 GET 用户填写的 IP 与端口，不调用业务接口或携带凭证。
///
/// 只要拿到 HTTP 响应就算可达，不解析响应体或校验状态码；
/// 只有网络层失败（连不上、超时、DNS 失败）才算不可达。
async fn probe(base_url: &str) -> Result<(), ApiError> {
    management_client_for(base_url)
        .request(reqwest::Method::GET, base_url)
        .send()
        .await
        .map(|_| ())
        .map_err(|error| ApiError {
            code: CODE_NETWORK_ERROR,
            message: format!("无法连接管理端 {base_url}：{error}"),
        })
}

/// 首次配置时预填的管理端地址：环境变量或默认值，由前端在「配置管理端地址」页展示
#[tauri::command]
pub fn client_default_endpoint() -> Endpoint {
    Endpoint::from_env_or_default()
}

/// 校验并探测管理端地址，成功后返回规范化后的地址供前端持久化。
///
/// 这是「配置管理端地址」页的确认动作：先挡住格式错误，再确认服务端可达，
/// 避免用户把写错的地址存下来、跑到登录页才发现连不上。
#[tauri::command]
pub async fn client_probe(endpoint: Endpoint) -> Result<Endpoint, ApiError> {
    let endpoint = endpoint.normalized();
    endpoint.validate()?;
    probe(&endpoint.base_url()).await?;
    Ok(endpoint)
}

/// 客户端登录：成功返回令牌与用户信息，失败文案由服务端给出（如「账号或密码错误」）。
///
/// 账号按文档约定先去除首尾空白，避免用户多打空格导致登录失败。
#[tauri::command]
pub async fn client_login(
    endpoint: Endpoint,
    username: String,
    password: String,
) -> Result<LoginData, ApiError> {
    let endpoint = endpoint.normalized();
    endpoint.validate()?;
    let body = serde_json::to_value(LoginRequest {
        username: username.trim(),
        password: &password,
    })
    .map_err(|error| ApiError {
        code: CODE_NETWORK_ERROR,
        message: format!("构造登录请求失败：{error}"),
    })?;
    request(
        &endpoint.base_url(),
        reqwest::Method::POST,
        "/login",
        &[],
        None,
        Some(body),
    )
    .await
}

/// 查询当前登录用户「已授权且启用」的模型列表，按模型 id 升序。
///
/// 用户没有任何授权时服务端返回空数组，这里如实回传空列表，由界面呈现为空而不报错。
#[tauri::command]
pub async fn client_models(
    endpoint: Endpoint,
    token: String,
) -> Result<Vec<RemoteModel>, ApiError> {
    let endpoint = endpoint.normalized();
    endpoint.validate()?;
    request(
        &endpoint.base_url(),
        reqwest::Method::GET,
        "/models",
        &[],
        Some(&token),
        None,
    )
    .await
}

/// 「检查更新」接口返回体（`GET /api/client/version/check`）。
///
/// 服务端在一次响应里同时给出「有无更新」与最新版本的展示信息，客户端据 `has_update`
/// 决定是否提示，无需再查一次版本详情；无已启用版本时各展示字段为空值且 `has_update` 为假。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// 客户端上报的当前版本号，服务端原样回显
    pub current_version: String,
    /// 是否存在比当前版本更新的已启用版本
    pub has_update: bool,
    /// 最新版本号；无已启用版本时空字符串
    pub latest_version: String,
    /// 更新说明，可能为空字符串
    pub description: String,
    /// 安装包字节数；无已启用版本时为 0
    pub file_size: i64,
    /// 是否强制更新：仅当确有更新且该版本被管理员标记为强制时为真
    pub force_update: bool,
    /// 安装包下载地址；无已启用版本时空字符串
    pub download_url: String,
    /// 最新版本的发布时间，可能为空字符串
    pub published_at: String,
}

/// 检查客户端是否有新版本（**免登录接口**，未登录时也能调用）。
///
/// `current_version` 由前端从应用元信息传入；服务端在缺少合法版本号时按「有新版本」返回，
/// 用于引导用户下载，因此这里如实透传结果，不做二次判空或改写。
#[tauri::command]
pub async fn client_check_update(
    endpoint: Endpoint,
    current_version: String,
) -> Result<UpdateCheck, ApiError> {
    let endpoint = endpoint.normalized();
    endpoint.validate()?;
    request(
        &endpoint.base_url(),
        reqwest::Method::GET,
        "/version/check",
        &[("currentVersion", current_version.as_str())],
        None,
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试内会读写进程级环境变量，加锁串行执行，避免并行用例互相污染
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 清掉客户端相关的环境变量，让用例从默认值出发
    fn clear_env() {
        std::env::remove_var("OCTOPUSES_HOST");
        std::env::remove_var("OCTOPUSES_PORT");
    }

    /// 构造一个待校验的地址，让用例只写关心的字段
    fn endpoint(host: &str, port: &str) -> Endpoint {
        Endpoint {
            host: host.to_string(),
            port: port.to_string(),
        }
    }

    #[test]
    fn default_endpoint_falls_back_to_defaults() {
        let _guard = env_lock();
        clear_env();
        assert_eq!(
            endpoint("127.0.0.1", "8000"),
            Endpoint::from_env_or_default()
        );
        assert_eq!(
            Endpoint::from_env_or_default().base_url(),
            "http://127.0.0.1:8000"
        );
    }

    #[test]
    fn default_endpoint_honours_environment_overrides() {
        let _guard = env_lock();
        clear_env();

        std::env::set_var("OCTOPUSES_HOST", "10.0.0.8");
        std::env::set_var("OCTOPUSES_PORT", "9527");
        assert_eq!(
            Endpoint::from_env_or_default().base_url(),
            "https://10.0.0.8:9527"
        );

        // 全空白等同于未配置，应回落默认值而不是拼出畸形地址
        std::env::set_var("OCTOPUSES_HOST", "   ");
        std::env::set_var("OCTOPUSES_PORT", "");
        assert_eq!(
            Endpoint::from_env_or_default().base_url(),
            "http://127.0.0.1:8000"
        );

        clear_env();
    }

    #[test]
    fn validate_accepts_hosts_and_ip_with_valid_port() {
        assert!(endpoint("127.0.0.1", "8000").validate().is_ok());
        assert!(endpoint("octopuses.internal", "1").validate().is_ok());
        assert!(endpoint("10.0.0.8", "65535").validate().is_ok());
        // 粘贴带来的首尾空白先被规范化，不算错误
        assert!(endpoint("  10.0.0.8  ", " 8000 ").validate().is_ok());
        assert_eq!(
            endpoint("  10.0.0.8  ", " 8000 ").base_url(),
            "https://10.0.0.8:8000"
        );
    }

    #[test]
    fn validate_rejects_empty_host() {
        let error = endpoint("   ", "8000").validate().unwrap_err();
        assert_eq!(error.code, 400);
        assert_eq!(error.message, "请填写管理端地址");
    }

    #[test]
    fn validate_accepts_https_and_rejects_insecure_remote_or_url_extras() {
        assert!(endpoint("https://server.example.com", "443")
            .validate()
            .is_ok());
        assert!(endpoint("http://127.0.0.1", "8000").validate().is_ok());
        for host in [
            "http://10.0.0.8",
            "https://user:pass@server.example.com",
            "https://server.example.com/api",
            "https://server.example.com?x=1",
            "https://server.example.com#x",
            "ftp://server.example.com",
        ] {
            assert!(endpoint(host, "8000").validate().is_err(), "{host}");
        }
        assert_eq!(
            endpoint("localhost", "8000").base_url(),
            "http://localhost:8000"
        );
        assert_eq!(
            endpoint("server.example.com", "443").base_url(),
            "https://server.example.com:443"
        );
    }

    #[test]
    fn validate_rejects_bad_port() {
        for port in ["", "abc", "70 0", "0", "65536", "70000"] {
            let error = endpoint("127.0.0.1", port).validate().unwrap_err();
            assert_eq!(error.code, 400, "端口 {port} 应当被拒绝");
            assert_eq!(error.message, "端口需要是 1-65535 之间的数字");
        }
    }

    #[test]
    fn unwrap_envelope_reads_successful_payload() {
        let body = r#"{"code":0,"message":"ok","data":{"token":"t","user":{"id":1,"username":"demo","nickname":"演示账号","status":1}}}"#;
        let data: LoginData = unwrap_envelope(200, body).unwrap();
        assert_eq!(data.token, "t");
        assert_eq!(data.user.username, "demo");
        assert_eq!(data.user.nickname, "演示账号");
        assert_eq!(data.user.status, 1);
    }

    #[test]
    fn unwrap_envelope_maps_model_list() {
        let body = r#"{"code":0,"message":"ok","data":[{"id":1,"code":"gpt-4o","name":"GPT-4o","provider":"OpenAI","baseUrl":"https://api.openai.com/v1","apiKey":"","description":"通用多模态大模型"}]}"#;
        let models: Vec<RemoteModel> = unwrap_envelope(200, body).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].code, "gpt-4o");
        assert_eq!(models[0].base_url, "https://api.openai.com/v1");
        assert_eq!(models[0].api_key, "");
        assert_eq!(models[0].description, "通用多模态大模型");
    }

    #[test]
    fn unwrap_envelope_maps_update_check() {
        let body = r#"{"code":0,"message":"ok","data":{"currentVersion":"0.39.0","hasUpdate":true,"latestVersion":"0.40.0","description":"修复若干问题","fileSize":10240,"forceUpdate":true,"downloadUrl":"http://127.0.0.1:8000/api/client/version/download/2","publishedAt":"2026-10-02 14:51:06"}}"#;
        let result: UpdateCheck = unwrap_envelope(200, body).unwrap();
        assert_eq!(result.current_version, "0.39.0");
        assert!(result.has_update);
        assert_eq!(result.latest_version, "0.40.0");
        assert_eq!(result.file_size, 10240);
        assert!(result.force_update);
        assert!(result
            .download_url
            .ends_with("/api/client/version/download/2"));
    }

    #[test]
    fn unwrap_envelope_maps_update_check_without_enabled_version() {
        // 服务端没有已启用版本时字段为空值且 hasUpdate 为假，客户端据此不提示更新
        let body = r#"{"code":0,"message":"ok","data":{"currentVersion":"0.39.0","hasUpdate":false,"latestVersion":"","description":"","fileSize":0,"forceUpdate":false,"downloadUrl":"","publishedAt":""}}"#;
        let result: UpdateCheck = unwrap_envelope(200, body).unwrap();
        assert!(!result.has_update);
        assert_eq!(result.latest_version, "");
        assert_eq!(result.file_size, 0);
        assert!(!result.force_update);
    }

    #[test]
    fn unwrap_envelope_keeps_server_message_and_code() {
        // HTTP 401 + code 401：文案与 code 都取自服务端，前端才分得清 401 与 403
        let body = r#"{"code":401,"data":null,"message":"未登录或登录已过期"}"#;
        let error = unwrap_envelope::<Vec<RemoteModel>>(401, body).unwrap_err();
        assert_eq!(error.code, 401);
        assert_eq!(error.message, "未登录或登录已过期");

        let banned = r#"{"code":403,"data":null,"message":"账号已被禁用，请联系管理员"}"#;
        let error = unwrap_envelope::<LoginData>(403, banned).unwrap_err();
        assert_eq!(error.code, 403);
        assert_eq!(error.message, "账号已被禁用，请联系管理员");
    }

    #[test]
    fn unwrap_envelope_survives_non_json_body() {
        // 网关返回 HTML 之类的非 JSON 体时，给出可读错误而不是 panic
        let error = unwrap_envelope::<LoginData>(500, "<html>500</html>").unwrap_err();
        assert_eq!(error.code, 500);
        assert!(error.message.contains("HTTP 500"));
    }
}
