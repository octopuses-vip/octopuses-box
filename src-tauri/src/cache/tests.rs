use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use super::artifacts::*;
use super::base64::*;
use super::commands::*;
use super::layout::*;

fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("octopuses-cache-test-{}-{}", std::process::id(), name));
    if dir.exists() {
        fs::remove_dir_all(&dir).expect("清理测试目录失败");
    }
    dir
}

#[test]
fn init_creates_subdirs_and_manifest() {
    let root = scratch("init");
    let info = init(&root).expect("初始化缓存目录失败");
    assert!(info.exists);
    assert_eq!(info.subdirs.len(), SUBDIRS.len());
    assert!(root.join(MANIFEST).is_file());
    assert_eq!(info.created_at, read_created_at(&root));
    fs::remove_dir_all(&root).ok();
}

#[test]
fn write_and_measure_files() {
    let root = scratch("write");
    init(&root).expect("初始化缓存目录失败");
    write_file(&root, "sessions/index.json", "[1,2,3]").expect("写入会话记录失败");
    write_file(&root, "outputs/2026-01-01/diff.json", "{}").expect("写入产物失败");
    let info = info(&root).expect("读取缓存信息失败");
    assert_eq!(info.total_files, 2);
    assert_eq!(info.total_bytes, 7 + 2);
    let sessions = info
        .subdirs
        .iter()
        .find(|item| item.name == "sessions")
        .unwrap();
    assert_eq!(sessions.file_count, 1);
    assert_eq!(sessions.bytes, 7);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn append_file_keeps_existing_content() {
    let root = scratch("append");
    init(&root).expect("初始化缓存目录失败");
    append_file(&root, "logs/app.log", "line-1\n").expect("追加日志失败");
    append_file(&root, "logs/app.log", "line-2\n").expect("追加日志失败");
    let body = fs::read_to_string(root.join("logs/app.log")).expect("读取日志失败");
    assert_eq!(body, "line-1\nline-2\n");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn clear_temp_keeps_other_subdirs() {
    let root = scratch("clear");
    init(&root).expect("初始化缓存目录失败");
    write_file(&root, "temp/run.json", "{}").expect("写入临时文件失败");
    write_file(&root, "sessions/index.json", "[]").expect("写入会话记录失败");
    let info = clear(&root, "temp").expect("清空临时文件失败");
    let temp = info
        .subdirs
        .iter()
        .find(|item| item.name == "temp")
        .unwrap();
    assert_eq!(temp.file_count, 0);
    assert_eq!(info.total_files, 1);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_rejects_paths_outside_root() {
    let root = Path::new("/tmp/octopuses-cache-root");
    assert!(resolve(root, "../escape.json").is_err());
    assert!(resolve(root, "/etc/passwd").is_err());
    assert!(resolve(root, "sessions/../../escape.json").is_err());
    assert_eq!(
        resolve(root, "temp/./run.json").unwrap(),
        root.join("temp/run.json")
    );
}

#[test]
fn clear_rejects_unknown_scope() {
    let root = scratch("scope");
    init(&root).expect("初始化缓存目录失败");
    assert!(clear(&root, "everything").is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn artifact_name_rejects_paths_and_hidden_files() {
    assert_eq!(artifact_name("  index.html  ").unwrap(), "index.html");
    assert!(artifact_name("").is_err());
    assert!(artifact_name("nested/index.html").is_err());
    assert!(artifact_name("../escape.html").is_err());
    assert!(artifact_name("/etc/passwd").is_err());
    assert!(artifact_name(".env").is_err());
}

#[test]
fn artifact_write_list_read_round_trip() {
    let root = scratch("artifact");
    // 产物目录由调用方给出：这里模拟项目目录下的 output/
    let dir = root.join("project/output");
    fs::create_dir_all(&dir).expect("创建产物目录失败");

    let info = write_artifact(&dir, "index.html", "<h1>你好</h1>").expect("写入产物失败");
    assert_eq!(info.path, dir.join("index.html").to_string_lossy());
    // 产物平铺在目标目录一层，不额外分子目录
    assert!(dir.join("index.html").is_file());
    assert!(write_artifact(&dir, "nested/x.html", "x").is_err());
    // 相对目录一律拒绝：产物不能落到进程当前目录这种不可预期的位置
    assert!(write_artifact(Path::new("relative/output"), "x.html", "x").is_err());

    let listed = list_artifacts(&dir).expect("列出产物失败");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "index.html");
    assert!(listed[0].bytes > 0);

    let body = read_artifact(&dir, "index.html").expect("读取产物失败");
    assert_eq!(body, "<h1>你好</h1>");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn list_artifacts_missing_dir_yields_empty() {
    let root = scratch("no-artifacts");
    assert!(list_artifacts(&root.join("output")).expect("列出产物失败").is_empty());
}

#[test]
fn migrate_legacy_moves_attributed_and_keeps_unmatched() {
    let root = scratch("migrate");
    let legacy = root.join(LEGACY_ARTIFACTS_DIR);
    let target = root.join("outputs/2026-10-15");
    fs::create_dir_all(&legacy).expect("创建旧产物目录失败");
    fs::write(legacy.join("a.md"), "old").expect("写入旧产物失败");
    fs::write(legacy.join("b.html"), "old").expect("写入旧产物失败");
    fs::write(legacy.join("unknown.txt"), "old").expect("写入旧产物失败");
    let dir = target.to_string_lossy().into_owned();

    let result = migrate_legacy(
        &root,
        &[
            ArtifactMigrationTarget { name: "a.md".to_string(), dir: dir.clone() },
            ArtifactMigrationTarget { name: "b.html".to_string(), dir: dir.clone() },
        ],
    )
    .expect("迁移旧产物失败");
    assert_eq!(result.moved, 2);
    // 认不出归属的文件原样留在旧目录，不猜也不删
    assert_eq!(result.skipped, 1);
    assert!(target.join("a.md").is_file());
    assert!(target.join("b.html").is_file());
    assert!(!legacy.join("a.md").exists());
    assert!(legacy.join("unknown.txt").is_file());

    // 目标已有同名文件时跳过：旧目录里的历史版本不该覆盖会话里更新的那份
    fs::write(legacy.join("a.md"), "older").expect("写入旧产物失败");
    let again = migrate_legacy(&root, &[ArtifactMigrationTarget { name: "a.md".to_string(), dir }])
        .expect("再次迁移旧产物失败");
    assert_eq!(again.moved, 0);
    // 两条都跳过：`a.md` 目标已有同名文件，`unknown.txt` 这次没给归属
    assert_eq!(again.skipped, 2);
    assert_eq!(fs::read_to_string(target.join("a.md")).expect("读取产物失败"), "old");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn migrate_legacy_missing_dir_is_noop() {
    let root = scratch("migrate-missing");
    let result = migrate_legacy(&root, &[]).expect("迁移旧产物失败");
    assert_eq!(result.moved, 0);
    assert_eq!(result.skipped, 0);
}

#[test]
fn migrate_legacy_skips_illegal_target() {
    let root = scratch("migrate-illegal");
    let legacy = root.join(LEGACY_ARTIFACTS_DIR);
    fs::create_dir_all(&legacy).expect("创建旧产物目录失败");
    fs::write(legacy.join("a.md"), "old").expect("写入旧产物失败");

    // 相对路径目标（项目未配置目录等）只跳过，不能让整批迁移失败
    let result = migrate_legacy(
        &root,
        &[ArtifactMigrationTarget { name: "a.md".to_string(), dir: "relative/output".to_string() }],
    )
    .expect("迁移旧产物失败");
    assert_eq!(result.moved, 0);
    assert_eq!(result.skipped, 1);
    assert!(legacy.join("a.md").is_file());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn prepare_dir_creates_dir_and_appends_gitignore_once() {
    let root = scratch("prepare");
    let dir = root.join("output");
    let gitignore = root.join(".gitignore");

    // 首次准备：建目录 + 补一行，且保留用户已有的忽略规则
    prepare_dir(&dir, Some(&gitignore), Some("output/")).expect("准备产物目录失败");
    assert!(dir.is_dir());
    assert_eq!(fs::read_to_string(&gitignore).expect("读取 .gitignore 失败"), "output/\n");

    // 重复准备不再追加，也不重复建目录
    prepare_dir(&dir, Some(&gitignore), Some("output/")).expect("再次准备产物目录失败");
    assert_eq!(fs::read_to_string(&gitignore).expect("读取 .gitignore 失败"), "output/\n");

    // 已有内容（末尾无换行）时补行，且识别等价写法 `output` 不重复追加
    fs::write(&gitignore, "target").expect("写入 .gitignore 失败");
    prepare_dir(&dir, Some(&gitignore), Some("output")).expect("准备产物目录失败");
    assert_eq!(fs::read_to_string(&gitignore).expect("读取 .gitignore 失败"), "target\noutput\n");

    // 临时会话不带 gitignore 参数：只建目录
    prepare_dir(&root.join("outputs/2026-01-01"), None, None).expect("准备产物目录失败");
    assert!(root.join("outputs/2026-01-01").is_dir());
    assert!(prepare_dir(Path::new("relative/output"), None, None).is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn artifact_kind_follows_extension() {
    assert_eq!(artifact_kind("preview.png"), "image");
    assert_eq!(artifact_kind("photo.JPEG"), "image");
    assert_eq!(artifact_kind("icon.svg"), "image");
    assert_eq!(artifact_kind("spec.pdf"), "pdf");
    assert_eq!(artifact_kind("report.md"), "text");
    assert_eq!(artifact_kind("data.csv"), "text");
    assert_eq!(artifact_kind("model.bin"), "binary");
    assert_eq!(artifact_kind("no-extension"), "binary");
}

#[test]
fn base64_round_trip_covers_padding() {
    // 长度 1 / 2 / 3 的三种余数、空串与二进制字节都要能原样还原
    let samples: Vec<Vec<u8>> = vec![
        Vec::new(),
        vec![0x4d],
        vec![0x4d, 0x61],
        vec![0x4d, 0x61, 0x6e],
        vec![0x00, 0xff, 0x10, 0x80, 0x7f],
    ];
    for sample in samples {
        let encoded = base64_encode(&sample);
        assert_eq!(base64_decode(&encoded).expect("解码失败"), sample);
    }
    assert_eq!(base64_encode(b"Man"), "TWFu");
    assert_eq!(base64_encode(b"Ma"), "TWE=");
    assert_eq!(base64_encode(b"M"), "TQ==");
}

#[test]
fn base64_decode_rejects_invalid_input() {
    assert!(base64_decode("TWF").is_err());
    assert!(base64_decode("TW*u").is_err());
    assert!(base64_decode("T=Fu").is_err());
}

#[test]
fn artifact_bytes_round_trip_and_kind() {
    let root = scratch("artifact-bytes");
    init(&root).expect("初始化缓存目录失败");

    // 产物目录由调用方给出：这里模拟临时会话的缓存 outputs/<日期>/
    let dir = root.join("outputs/2026-01-01");
    fs::create_dir_all(&dir).expect("创建产物目录失败");

    let png = [0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let info = write_artifact_bytes(&dir, "shot.png", &png).expect("写入二进制产物失败");
    assert_eq!(info.path, dir.join("shot.png").to_string_lossy());
    assert_eq!(info.bytes, png.len() as u64);
    assert!(write_artifact_bytes(&dir, "nested/shot.png", &png).is_err());

    let listed = list_artifacts(&dir).expect("列出产物失败");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].kind, "image");

    let body = read_artifact_bytes(&dir, "shot.png").expect("读取二进制产物失败");
    assert_eq!(body, png);
    // 文本通道读不了 PNG，正是需要独立字节通道的原因
    assert!(read_artifact(&dir, "shot.png").is_err());
    fs::remove_dir_all(&root).ok();
}
