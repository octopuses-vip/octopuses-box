use std::path::{Path, PathBuf};

use super::guard::*;
use super::secret::*;
use super::types::*;

/// 远程主机配置目录（相对缓存目录）与配置文件（开发者 Jan）
pub(super) const SSH_DIR: &str = "ssh";

pub(super) const HOSTS_FILE: &str = "hosts.json";

/// 未显式指定端口时使用 SSH 默认端口
pub(super) const DEFAULT_SSH_PORT: u16 = 22;

/// serde 默认端口（开发者 Jan）
pub(super) fn default_ssh_port() -> u16 {
    DEFAULT_SSH_PORT
}

/// 校验主机 id：仅允许单层目录名 + ASCII 字母数字与 `-_`（开发者 Jan）
///
/// 该 id 同时用作凭据管理器中的账号与配置文件里的主键，因此必须收紧字符集，
/// 避免路径穿越与凭据条目串味。
pub(super) fn validate_host_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() || id == "." || id == ".." {
        return Err("远程主机 id 不能为空，也不能是 . 或 ..。".to_string());
    }
    if id.starts_with('/') || id.contains('/') || id.contains('\\') {
        return Err("远程主机 id 只能是单层目录名，不能包含路径分隔符。".to_string());
    }
    if !id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("远程主机 id 只允许 ASCII 字母、数字、短横线和下划线。".to_string());
    }
    Ok(id.to_string())
}

/// 主机配置目录，不存在时创建（开发者 Jan）
pub(super) fn hosts_root(cache_dir: &Path) -> Result<PathBuf, String> {
    let root = cache_dir.join(SSH_DIR);
    std::fs::create_dir_all(&root).map_err(|error| format!("创建远程主机配置目录失败: {error}"))?;
    Ok(root)
}

/// 读取主机配置；文件不存在或为空时视为没有主机（开发者 Jan）
pub(super) fn load_hosts(cache_dir: &Path) -> Result<Vec<SshHost>, String> {
    let file = hosts_root(cache_dir)?.join(HOSTS_FILE);
    Ok(crate::json_store::read_json::<Vec<SshHost>>(&file)?.unwrap_or_default())
}

/// 原子写主机配置（开发者 Jan）
pub(super) fn store_hosts(cache_dir: &Path, hosts: &[SshHost]) -> Result<(), String> {
    let root = hosts_root(cache_dir)?;
    crate::json_store::write_json(&root.join(HOSTS_FILE), hosts)
}

/// 读取校验后的主机信息，并归一化字段（开发者 Jan）
///
/// 端口为 0 视为「未填写」，回落默认端口；其余必填项逐个校验非空。
pub(super) fn normalize_host(input: &SaveSshHostInput) -> Result<SshHost, String> {
    let id = validate_host_id(&input.id)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err("远程主机名称不能为空。".to_string());
    }
    let host = input.host.trim();
    if host.is_empty() {
        return Err("远程主机地址不能为空。".to_string());
    }
    let username = input.username.trim();
    if username.is_empty() {
        return Err("远程主机登录用户名不能为空。".to_string());
    }
    let key_path = input
        .key_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if input.auth == SshAuthKind::Key && key_path.is_none() {
        return Err("私钥认证必须填写私钥文件路径。".to_string());
    }
    // 执行限制提示词：去空白后为空即「未设置」，不做静默截断
    let guard_prompt = input
        .guard_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(prompt) = guard_prompt.as_deref() {
        if prompt.chars().count() > GUARD_PROMPT_LIMIT {
            return Err(format!(
                "执行限制提示词不能超过 {GUARD_PROMPT_LIMIT} 个字符（当前 {} 个）。",
                prompt.chars().count()
            ));
        }
    }
    Ok(SshHost {
        id,
        name: name.to_string(),
        host: host.to_string(),
        port: if input.port == 0 {
            DEFAULT_SSH_PORT
        } else {
            input.port
        },
        username: username.to_string(),
        auth: input.auth,
        key_path,
        // 指纹由连接过程 TOFU 建立，不允许前端直接写入
        host_key_fingerprint: None,
        enabled: input.enabled,
        guard_prompt,
    })
}

/// 把主机配置脱敏成前端视图（开发者 Jan）
///
/// 配置本身已不含秘密字段，这里只补上「凭据是否已保存」这一运行时信息。
pub(super) fn redact_host(host: &SshHost) -> SshHostView {
    SshHostView {
        id: host.id.clone(),
        name: host.name.clone(),
        host: host.host.clone(),
        port: host.port,
        username: host.username.clone(),
        auth: host.auth,
        key_path: host.key_path.clone(),
        host_key_fingerprint: host.host_key_fingerprint.clone(),
        enabled: host.enabled,
        guard_prompt: host.guard_prompt.clone(),
        has_secret: has_secret(&host.id),
    }
}

/// 批量脱敏
pub(super) fn redact_all(hosts: &[SshHost]) -> Vec<SshHostView> {
    hosts.iter().map(redact_host).collect()
}

/// 按 id 查找主机；不存在即报错（开发者 Jan）
pub(super) fn find_host(cache_dir: &Path, host_id: &str) -> Result<SshHost, String> {
    let id = validate_host_id(host_id)?;
    load_hosts(cache_dir)?
        .into_iter()
        .find(|host| host.id == id)
        .ok_or_else(|| format!("远程主机不存在：{id}"))
}

/// 按 id 查找**已启用**的主机；停用主机在此被拦下（开发者 Jan）
///
/// Agent 工具的执行路径统一走这里，避免「界面停用了却仍能被模型调用」。
pub(super) fn find_enabled_host(cache_dir: &Path, host_id: &str) -> Result<SshHost, String> {
    let host = find_host(cache_dir, host_id)?;
    if !host.enabled {
        return Err(format!("远程主机已停用：{}。", host.name));
    }
    Ok(host)
}

/// 新增或更新一条主机；同 id 覆盖需显式 overwrite（开发者 Jan）
///
/// 凭据处理与配置落盘分开：`secret` 有值才写入凭据管理器，
/// `clear_secret` 为真则清除；两者都不满足时保持原凭据不变。
pub(super) fn save_host(cache_dir: &Path, input: SaveSshHostInput) -> Result<Vec<SshHost>, String> {
    let host = normalize_host(&input)?;
    let mut hosts = load_hosts(cache_dir)?;
    let existing = hosts.iter().position(|item| item.id == host.id);
    let previous_fingerprint = existing
        .map(|index| hosts[index].host_key_fingerprint.clone())
        .unwrap_or(None);
    match existing {
        Some(_) if !input.overwrite => {
            return Err(format!("远程主机已存在：{}。如需覆盖请明确确认。", host.id));
        }
        Some(index) => {
            hosts[index] = SshHost {
                // 指纹属于连接期信任信息，不因编辑表单而丢失
                host_key_fingerprint: previous_fingerprint.or(host.host_key_fingerprint),
                ..host
            }
        }
        None => hosts.push(host),
    }

    // 凭据先于配置落盘：若凭据写入失败，配置保持原样，避免出现「配好了但连不上」的中间态
    if input.clear_secret {
        delete_secret(&validate_host_id(&input.id)?)?;
    } else if let Some(secret) = input.secret.as_deref().map(str::trim) {
        if !secret.is_empty() {
            set_secret(&validate_host_id(&input.id)?, secret)?;
        }
    }

    hosts.sort_by(|a, b| a.name.cmp(&b.name));
    store_hosts(cache_dir, &hosts)?;
    Ok(hosts)
}

/// 删除一条主机，并同步清除其凭据（开发者 Jan）
///
/// 主机不存在时报错，不做静默成功；凭据清除失败不阻断删除，
/// 因为残留凭据无法再被任何配置引用（账号就是主机 id）。
pub(super) fn delete_host(cache_dir: &Path, input: DeleteSshHostInput) -> Result<Vec<SshHost>, String> {
    let id = validate_host_id(&input.id)?;
    let mut hosts = load_hosts(cache_dir)?;
    let before = hosts.len();
    hosts.retain(|host| host.id != id);
    if hosts.len() == before {
        return Err(format!("远程主机不存在：{id}"));
    }
    store_hosts(cache_dir, &hosts)?;
    let _ = delete_secret(&id);
    Ok(hosts)
}

/// 把 TOFU 观测到的指纹回填到主机配置（开发者 Jan）
///
/// 仅在「该主机尚未记录指纹」且「本次确实观测到指纹」时写入；
/// 已有记录时绝不覆盖——一旦记录在案，密钥变化只能由用户显式清除。
pub(super) fn remember_fingerprint(
    cache_dir: &Path,
    host_id: &str,
    observed: &Option<String>,
) -> Result<(), String> {
    let Some(fingerprint) = observed.as_deref() else {
        return Ok(());
    };
    let id = validate_host_id(host_id)?;
    let mut hosts = load_hosts(cache_dir)?;
    let Some(index) = hosts.iter().position(|host| host.id == id) else {
        return Ok(());
    };
    if hosts[index].host_key_fingerprint.is_some() {
        return Ok(());
    }
    hosts[index].host_key_fingerprint = Some(fingerprint.to_string());
    store_hosts(cache_dir, &hosts)
}

// ---------------------------------------------------------------------------
// 凭据存取：只进系统凭据管理器，绝不落盘
// ---------------------------------------------------------------------------
