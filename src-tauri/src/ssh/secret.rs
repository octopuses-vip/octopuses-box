

/// 系统凭据管理器中的服务名；账号即主机 id
pub(super) const KEYRING_SERVICE: &str = "octopuses-ssh";

/// 构造凭据条目；账号使用主机 id（开发者 Jan）
pub(super) fn secret_entry(host_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, host_id)
        .map_err(|error| format!("访问系统凭据管理器失败：{error}。请确认本机凭据管理器可用。"))
}

/// 写入凭据（开发者 Jan）
pub(super) fn set_secret(host_id: &str, secret: &str) -> Result<(), String> {
    secret_entry(host_id)?
        .set_password(secret)
        .map_err(|error| format!("保存凭据失败：{error}"))
}

/// 读取凭据；未保存过时返回 None（开发者 Jan）
pub(super) fn get_secret(host_id: &str) -> Result<Option<String>, String> {
    match secret_entry(host_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取凭据失败：{error}")),
    }
}

/// 清除凭据；未保存过时视为成功（开发者 Jan）
pub(super) fn delete_secret(host_id: &str) -> Result<(), String> {
    match secret_entry(host_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("清除凭据失败：{error}")),
    }
}

/// 该主机是否已保存凭据；任何异常都按「未保存」处理，不阻断列表渲染（开发者 Jan）
pub(super) fn has_secret(host_id: &str) -> bool {
    matches!(get_secret(host_id), Ok(Some(secret)) if !secret.is_empty())
}

// ---------------------------------------------------------------------------
// 连接层
// ---------------------------------------------------------------------------
