use std::path::{Path, PathBuf};

use super::*;
use super::commands::*;
use super::config::*;
use super::connect::*;
use super::exec::*;
use super::guard::*;
use super::secret::*;
use super::sftp::*;
use super::types::*;

/// 每个用例独占的临时目录，避免相互干扰
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "octopuses-ssh-test-{}-{}",
        std::process::id(),
        name
    ));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).expect("清理测试目录失败");
    }
    std::fs::create_dir_all(&dir).expect("创建测试目录失败");
    dir
}

/// 构造一份最小可用的主机入参
fn host_input(id: &str) -> SaveSshHostInput {
    SaveSshHostInput {
        id: id.to_string(),
        name: format!("主机-{id}"),
        host: "10.0.0.1".to_string(),
        port: 0,
        username: "root".to_string(),
        auth: SshAuthKind::Password,
        key_path: None,
        secret: None,
        clear_secret: false,
        enabled: true,
        guard_prompt: None,
        overwrite: false,
    }
}

#[test]
fn validates_safe_host_ids() {
    for id in ["", ".", "..", "/tmp", "a/b", "a\\b", "主机", "a b"] {
        assert!(validate_host_id(id).is_err(), "应拒绝 {id}");
    }
    assert_eq!(validate_host_id("web-01_prod").unwrap(), "web-01_prod");
}

#[test]
fn save_requires_overwrite_and_normalizes_fields() {
    let cache = scratch("overwrite");
    let hosts = save_host(&cache, host_input("web")).unwrap();
    assert_eq!(hosts.len(), 1);
    // 端口为 0 时回落默认端口
    assert_eq!(hosts[0].port, DEFAULT_SSH_PORT);

    assert!(save_host(&cache, host_input("web"))
        .unwrap_err()
        .contains("覆盖"));

    let mut input = host_input("web");
    input.overwrite = true;
    input.name = "  生产机  ".to_string();
    input.port = 2222;
    let hosts = save_host(&cache, input).unwrap();
    assert_eq!(hosts[0].name, "生产机");
    assert_eq!(hosts[0].port, 2222);
    std::fs::remove_dir_all(&cache).ok();
}

#[test]
fn key_auth_requires_key_path() {
    let cache = scratch("keypath");
    let mut input = host_input("keyhost");
    input.auth = SshAuthKind::Key;
    assert!(save_host(&cache, input).unwrap_err().contains("私钥文件路径"));
    std::fs::remove_dir_all(&cache).ok();
}

#[test]
fn guard_prompt_is_trimmed_persisted_and_capped() {
    let cache = scratch("guard");
    let expected = "禁止 rm -rf 与 systemctl stop；改配置前先备份";
    let mut input = host_input("prod");
    input.guard_prompt = Some(format!("  {expected}\n "));
    save_host(&cache, input).unwrap();
    // 落盘 + 重读都要原样带出：前端编辑回填与运行期注入依赖同一个值
    assert_eq!(find_host(&cache, "prod").unwrap().guard_prompt.as_deref(), Some(expected));

    // 全空白即「未设置」：不落盘该字段，前端回填为空
    let mut blank = host_input("blank");
    blank.guard_prompt = Some("   \n  ".to_string());
    let hosts = save_host(&cache, blank).unwrap();
    let blank_host = hosts.iter().find(|host| host.id == "blank").expect("blank 未保存");
    assert!(blank_host.guard_prompt.is_none());
    let raw = std::fs::read_to_string(cache.join(SSH_DIR).join(HOSTS_FILE)).unwrap();
    // 全文件只允许出现一次 guardPrompt（prod 那条）：blank 未设置就整体省略字段，
    // 而不是落一个空串，否则前端回填与「是否设过限制」的判断都会失真
    assert_eq!(
        raw.matches("guardPrompt").count(),
        1,
        "未设置的提示词不应落盘该字段：{raw}"
    );

    // 超长直接报错，不静默截断——截断会让用户以为限制生效了
    let mut too_long = host_input("long");
    too_long.guard_prompt = Some("限".repeat(GUARD_PROMPT_LIMIT + 1));
    assert!(save_host(&cache, too_long).unwrap_err().contains("执行限制提示词"));
    std::fs::remove_dir_all(&cache).ok();
}

#[test]
fn persisted_file_never_contains_secret_fields() {
    let cache = scratch("nosecret");
    let secret = "octopuses-selftest-secret-must-not-persist";
    // 凭据管理器可用的环境才校验明文不落盘；不可用时仍校验字段名不含凭据字段
    let keyring_ready = keyring::Entry::store_status().is_ok();
    let mut input = host_input("web");
    if keyring_ready {
        input.secret = Some(secret.to_string());
    }
    save_host(&cache, input).unwrap();
    let raw = std::fs::read_to_string(cache.join(SSH_DIR).join(HOSTS_FILE)).unwrap();
    // 只能校验凭据「字段名」：`auth` 的取值恰是 `password`，校验该字样会误报
    for forbidden in ["\"secret\"", "\"passphrase\"", "\"privateKey\"", "\"private_key\""] {
        assert!(
            !raw.contains(forbidden),
            "落盘文件不应包含字段 {forbidden}，实际内容：{raw}"
        );
    }
    if keyring_ready {
        assert!(!raw.contains(secret), "落盘文件不应包含凭据明文，实际内容：{raw}");
        delete_secret("web").unwrap();
    }
    std::fs::remove_dir_all(&cache).ok();
}

#[test]
fn delete_removes_host_and_rejects_missing() {
    let cache = scratch("delete");
    save_host(&cache, host_input("a")).unwrap();
    let mut second = host_input("b");
    second.name = "b".to_string();
    save_host(&cache, second).unwrap();

    let hosts = delete_host(
        &cache,
        DeleteSshHostInput {
            id: "a".to_string(),
        },
    )
    .unwrap();
    assert_eq!(hosts.len(), 1);
    assert_eq!(hosts[0].id, "b");
    assert!(delete_host(
        &cache,
        DeleteSshHostInput {
            id: "a".to_string()
        }
    )
    .unwrap_err()
    .contains("不存在"));
    std::fs::remove_dir_all(&cache).ok();
}

#[test]
fn disabled_host_is_rejected_by_enabled_lookup() {
    let cache = scratch("disabled");
    let mut input = host_input("off");
    input.enabled = false;
    save_host(&cache, input).unwrap();
    assert!(find_enabled_host(&cache, "off").unwrap_err().contains("停用"));
    // 未启用不影响按 id 读取用于界面展示
    assert!(find_host(&cache, "off").is_ok());
    std::fs::remove_dir_all(&cache).ok();
}

#[test]
fn fingerprint_is_only_established_once() {
    let cache = scratch("tofu");
    save_host(&cache, host_input("web")).unwrap();
    let first = Some("SHA256:first".to_string());
    remember_fingerprint(&cache, "web", &first).unwrap();
    assert_eq!(
        find_host(&cache, "web").unwrap().host_key_fingerprint,
        first
    );
    // 已有记录时不得被后续观测覆盖
    remember_fingerprint(&cache, "web", &Some("SHA256:second".to_string())).unwrap();
    assert_eq!(
        find_host(&cache, "web").unwrap().host_key_fingerprint,
        first
    );
    std::fs::remove_dir_all(&cache).ok();
}

#[test]
fn deny_list_blocks_destructive_commands() {
    for command in [
        "rm -rf /",
        "sudo mkfs.ext4 /dev/sda1",
        "shutdown -h now",
        "sudo reboot",
        "dd if=/dev/zero of=/dev/sda",
        ":(){ :|:& };:",
        "echo x > /dev/sda",
    ] {
        assert!(
            remote_deny_reason(command).is_some(),
            "应拒绝：{command}"
        );
    }
    // 正常运维命令不得误伤
    for command in [
        "uname -a",
        "df -h",
        "sudo systemctl restart nginx",
        "rm -rf /tmp/octopuses-cache",
        "docker ps --format '{{.Names}}'",
    ] {
        assert!(
            remote_deny_reason(command).is_none(),
            "不应拒绝：{command}"
        );
    }
}

#[test]
fn exec_timeout_falls_back_and_clamps() {
    assert_eq!(clamp_exec_timeout(0), EXEC_TIMEOUT_DEFAULT_SECS);
    assert_eq!(clamp_exec_timeout(30), 30);
    assert_eq!(clamp_exec_timeout(EXEC_TIMEOUT_MAX_SECS + 1), EXEC_TIMEOUT_MAX_SECS);
}

#[test]
fn secret_roundtrip_against_system_store() {
    // 本机凭据管理器不可用（如无 Secret Service 的 CI）时跳过，避免假失败
    if keyring::Entry::store_status().is_err() {
        return;
    }
    let account = format!("octopuses-ssh-selftest-{}", std::process::id());
    set_secret(&account, "s3cret").unwrap();
    assert_eq!(get_secret(&account).unwrap().as_deref(), Some("s3cret"));
    assert!(has_secret(&account));
    delete_secret(&account).unwrap();
    assert_eq!(get_secret(&account).unwrap(), None);
    assert!(!has_secret(&account));
}
