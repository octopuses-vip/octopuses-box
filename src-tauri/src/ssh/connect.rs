use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{AuthResult, Config, Handle, Msg};
use russh::keys::{HashAlg, load_secret_key, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{Channel, Disconnect};
use tokio::time::timeout;

use super::types::*;

/// 建连（TCP + 密钥交换 + 认证）整体超时
pub(super) const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// 空闲保活间隔：命令长时间执行时也能探测连接是否仍存活
pub(super) const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// SFTP 单次读取上限与写入上限（字节）
pub(super) const SFTP_READ_LIMIT: u64 = 4 * 1024 * 1024;

pub(super) const SFTP_WRITE_LIMIT: usize = 8 * 1024 * 1024;

/// SFTP 协议层单次响应超时（秒）
pub(super) const SFTP_TIMEOUT_SECS: u64 = 30;

/// SFTP 子系统名
pub(super) const SFTP_SUBSYSTEM: &str = "sftp";

/// 主机密钥校验回调：TOFU 策略（开发者 Jan）
///
/// 未记录指纹时先接受并在连接成功后由 [`remember_fingerprint`] 落盘；
/// 已记录时严格比对，不一致直接拒绝，绝不自动覆盖。
pub(super) struct HostKeyCheck {
    /// 配置中已记录的指纹
    expected: Option<String>,
    /// 本次握手观测到的指纹，供调用方在失败时给出可读原因
    observed: Arc<Mutex<Option<String>>>,
}

impl russh::client::Handler for HostKeyCheck {
    type Error = russh::Error;

    /// 校验服务端主机密钥（开发者 Jan）
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = fingerprint_text(server_public_key);
        if let Ok(mut slot) = self.observed.lock() {
            *slot = Some(fingerprint.clone());
        }
        Ok(match &self.expected {
            // 首次连接：先放行，信任由后续落盘动作确立
            None => true,
            Some(expected) => expected == &fingerprint,
        })
    }
}

/// 从主机密钥/证书算出 SHA256 指纹文本（形如 `SHA256:xxx`）（开发者 Jan）
pub(super) fn fingerprint_text(key: &PublicKeyOrCertificate) -> String {
    match key {
        PublicKeyOrCertificate::PublicKey { key, hash_alg } => key
            .fingerprint(hash_alg.unwrap_or(HashAlg::Sha256))
            .to_string(),
        // 证书本身没有指纹方法，按其承载的公钥计算
        PublicKeyOrCertificate::Certificate(certificate) => {
            PublicKey::new(certificate.public_key().clone(), "")
                .fingerprint(HashAlg::Sha256)
                .to_string()
        }
    }
}

/// 一条已认证的 SSH 连接（开发者 Jan）
///
/// 生命周期与单次工具调用绑定：用完即 [`SshConnection::close`]，不跨调用复用。
pub(super) struct SshConnection {
    handle: Handle<HostKeyCheck>,
    observed: Arc<Mutex<Option<String>>>,
    pub(super) host_label: String,
}

impl SshConnection {
    /// 取本次握手观测到的指纹副本（开发者 Jan）
    pub(super) fn observed_fingerprint(&self) -> Option<String> {
        self.observed.lock().ok().and_then(|slot| slot.clone())
    }

    /// 主动断开连接（开发者 Jan）
    ///
    /// 仅发一次礼貌的 disconnect，失败也不上报——此时命令/传输结果已确定，
    /// 关连接只是回收资源。
    pub(super) async fn close(&self) -> Result<(), String> {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "")
            .await;
        Ok(())
    }

    /// 打开一个会话通道（开发者 Jan）
    pub(super) async fn open_session(&self) -> Result<Channel<Msg>, String> {
        self.handle
            .channel_open_session()
            .await
            .map_err(|error| format!("[{}] 打开 SSH 会话失败：{error}", self.host_label))
    }
}

/// 建立连接并完成认证（开发者 Jan）
///
/// 超时覆盖「TCP 连接 + 密钥交换 + 认证」全过程；认证方式按主机配置显式选择，
/// 不做「密钥失败再试密码」的隐式回退，避免在错误凭据上反复冲击远端。
pub(super) async fn open_connection(host: &SshHost, secret: Option<String>) -> Result<SshConnection, String> {
    let label = format!("{}@{}:{}", host.username, host.host, host.port);
    let config = Arc::new(Config {
        inactivity_timeout: Some(CONNECT_TIMEOUT),
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        nodelay: true,
        ..Default::default()
    });
    let observed = Arc::new(Mutex::new(None));
    let handler = HostKeyCheck {
        expected: host.host_key_fingerprint.clone(),
        observed: Arc::clone(&observed),
    };

    let mut handle = match timeout(
        CONNECT_TIMEOUT,
        russh::client::connect(config, (host.host.as_str(), host.port), handler),
    )
    .await
    {
        Err(_) => {
            return Err(format!(
                "连接 {label} 超时（{} 秒）：请确认地址、端口与网络可达。",
                CONNECT_TIMEOUT.as_secs()
            ))
        }
        Ok(Err(error)) => {
            let seen = observed.lock().ok().and_then(|slot| slot.clone());
            return Err(describe_connect_error(host, seen, &error));
        }
        Ok(Ok(handle)) => handle,
    };

    authenticate(&mut handle, host, secret.as_deref()).await?;
    Ok(SshConnection {
        handle,
        observed,
        host_label: label,
    })
}

/// 把建连失败翻译成人可读的原因（开发者 Jan）
///
/// 主机密钥不一致是本模块最需要显式提示的情况：它既可能是中间人攻击，
/// 也可能是服务器正常轮换了密钥，必须让用户看清楚两个指纹后自行决定。
pub(super) fn describe_connect_error(host: &SshHost, seen: Option<String>, error: &russh::Error) -> String {
    match (&host.host_key_fingerprint, seen) {
        (Some(expected), Some(seen)) if expected != &seen => format!(
            "主机密钥与记录不一致，已拒绝连接。\n已记录：{expected}\n本次：{seen}\n\
             若确认服务器已更换密钥，请在「远程主机」页清除该主机指纹后重连。"
        ),
        _ => format!(
            "连接 {}@{}:{} 失败：{error}",
            host.username, host.host, host.port
        ),
    }
}

/// 按主机配置完成认证（开发者 Jan）
pub(super) async fn authenticate(
    handle: &mut Handle<HostKeyCheck>,
    host: &SshHost,
    secret: Option<&str>,
) -> Result<(), String> {
    // 空字符串等同于「没有填写」：避免把空口令当成有效口令送给解码器
    let secret = secret.filter(|value| !value.is_empty());
    let result = match host.auth {
        SshAuthKind::Key => {
            let key_path = host
                .key_path
                .as_deref()
                .ok_or_else(|| "该主机配置为私钥认证，但缺少私钥文件路径。".to_string())?;
            let key = load_secret_key(key_path, secret)
                .map_err(|error| format!("加载私钥失败（{key_path}）：{error}"))?;
            // RSA 走 sha2-256；非 RSA 键种会忽略该参数
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256));
            handle
                .authenticate_publickey(host.username.clone(), key)
                .await
                .map_err(|error| format!("私钥认证请求失败：{error}"))?
        }
        SshAuthKind::Password => {
            let password = secret.ok_or_else(|| {
                "该主机配置为密码认证，但系统凭据管理器中没有可用口令。".to_string()
            })?;
            handle
                .authenticate_password(host.username.clone(), password.to_string())
                .await
                .map_err(|error| format!("密码认证请求失败：{error}"))?
        }
    };

    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(match host.auth {
            SshAuthKind::Key => format!(
                "私钥认证被拒绝：{}@{}:{}。请确认公钥已写入远端 authorized_keys。",
                host.username, host.host, host.port
            ),
            SshAuthKind::Password => format!(
                "密码认证被拒绝：{}@{}:{}。请确认用户名与口令。",
                host.username, host.host, host.port
            ),
        }),
    }
}

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------
