use serde::{Deserialize, Serialize};

use super::config::*;

/// 认证方式：私钥文件或密码（开发者 Jan）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthKind {
    /// 私钥文件认证；私钥口令（如有）存系统凭据管理器
    Key,
    /// 密码认证
    Password,
}

/// 一条远程主机配置；**只含非敏感字段**，可安全落盘（开发者 Jan）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    /// 唯一标识，单层目录名，同时作为凭据管理器中的账号
    pub id: String,
    /// 展示名
    pub name: String,
    /// 主机名或 IP
    pub host: String,
    /// 端口；缺省为 SSH 默认端口
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    /// 登录用户名
    pub username: String,
    /// 认证方式
    pub auth: SshAuthKind,
    /// 私钥文件路径（`auth = key` 时必填）；只存路径，不存私钥本体
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// 已信任的主机密钥 SHA256 指纹；为空表示尚未建立信任（TOFU 首次连接时回填）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key_fingerprint: Option<String>,
    /// 是否启用；停用的主机不向模型暴露，也不允许经工具执行
    #[serde(default)]
    pub enabled: bool,
    /// 该主机的「执行限制」提示词：模型每次对这台主机发起调用时回灌进上下文，
    /// 用来限定哪些命令禁止执行（如生产机禁 `rm -rf`、禁改 systemd 单元）。
    /// 空表示未设置；它只是提示层，真正的兜底仍是人工审批与 [`remote_deny_reason`]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard_prompt: Option<String>,
}

/// 回前端的主机视图：脱敏后再补一个「是否已保存凭据」的提示位（开发者 Jan）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostView {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuthKind,
    pub key_path: Option<String>,
    pub host_key_fingerprint: Option<String>,
    pub enabled: bool,
    /// 该主机的「执行限制」提示词，原样回前端供编辑与运行期注入
    pub guard_prompt: Option<String>,
    /// 系统凭据管理器中是否已保存该主机的凭据
    pub has_secret: bool,
}

/// 新增/更新主机入参（开发者 Jan）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSshHostInput {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub port: u16,
    pub username: String,
    pub auth: SshAuthKind,
    #[serde(default)]
    pub key_path: Option<String>,
    /// 明文口令：只进系统凭据管理器；为空表示不修改已保存的凭据
    #[serde(default)]
    pub secret: Option<String>,
    /// 主动清除已保存的凭据
    #[serde(default)]
    pub clear_secret: bool,
    #[serde(default)]
    pub enabled: bool,
    /// 该主机的「执行限制」提示词；空或全空白视为未设置
    #[serde(default)]
    pub guard_prompt: Option<String>,
    /// 同 id 覆盖需显式确认为 true
    #[serde(default)]
    pub overwrite: bool,
}

/// 删除主机入参
#[derive(Debug, Deserialize)]
pub struct DeleteSshHostInput {
    pub id: String,
}

/// 凭据状态：本机凭据管理器是否可用 + 该主机是否已保存凭据（开发者 Jan）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSecretStatus {
    /// 本机凭据管理器是否可用；false 表示无法安全保存口令
    pub available: bool,
    /// 该主机是否已保存凭据
    pub has_secret: bool,
}

/// 连接自检结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub ok: bool,
    pub message: String,
    /// 本次连接观测到的主机密钥指纹
    pub fingerprint: Option<String>,
}

/// 远程命令执行结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshExecResult {
    pub ok: bool,
    /// 远端退出码；未上报时为 [`NO_EXIT_CODE`]
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    /// 是否因超时被中断
    pub timed_out: bool,
    /// 输出是否超过上限被截断
    pub truncated: bool,
}

/// 远程目录条目
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 远程文件内容
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileContent {
    pub path: String,
    pub content: String,
    /// 文件大于读取上限，内容只取前 [`SFTP_READ_LIMIT`] 字节
    pub truncated: bool,
}
