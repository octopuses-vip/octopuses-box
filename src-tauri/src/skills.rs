//! 技能（Skill）扫描与索引及本地生命周期管理。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const SKILLS_DIR: &str = "skills";
const INDEX_FILE: &str = "SKILLS.md";
const SKILL_FILE: &str = "SKILL.md";
/// 单个技能目录内参考文档的枚举上限，防止误挂进来的大目录把索引撑爆
const MAX_EXTRA_FILES: usize = 60;
/// 参考文档向下递归的最大层数
const MAX_EXTRA_DEPTH: usize = 3;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    id: String,
    name: String,
    description: String,
    body: String,
    path: String,
    /// 技能目录内 `SKILL.md` 之外的参考文档（相对技能目录、以 `/` 分隔），供 `read_skill` 的 `file` 参数取用
    files: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkillInput {
    id: String,
    name: String,
    description: String,
    body: String,
    overwrite: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSkillInput {
    original_id: String,
    id: String,
    name: String,
    description: String,
    body: String,
    overwrite: bool,
}

#[derive(Deserialize)]
pub struct DeleteSkillInput {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillInput {
    source_dir: String,
    id: Option<String>,
    overwrite: bool,
}

/// 从 SKILL.md 解析字符串与块标量；失败时提供行号诊断（开发者 Jan）。
fn parse_frontmatter(text: &str) -> Result<(Option<String>, Option<String>), String> {
    let mut parsed = crate::frontmatter::parse(text, &["name", "description"])?;
    Ok((parsed.fields.remove("name"), parsed.fields.remove("description")))
}

/// 收集技能目录内 `SKILL.md` 之外的参考文档（开发者 Jan），返回相对技能目录的路径。
///
/// 技能常自带一份参考文档（如 `DB_DOC.MD`、字段字典、示例数据），导入时是整目录复制的，
/// 但正文只注入 `SKILL.md`——不枚举这些文件，模型就只知道「技能里应该包含」却没有任何工具能读到它。
///
/// 只收「普通文件且能按 UTF-8 读出」的条目：二进制读出来是乱码，列给模型只会让它白跑一次调用；
/// 软链（含软链目录）一律跳过，与 `scan_root` 对 `SKILL.md` 的处置一致，防止技能目录把内容指向缓存之外。
/// 隐藏条目（以 `.` 开头）跳过：导入过程留下的 `.skill-import-*` 临时/备份目录不该出现在索引里。
fn collect_extra_files(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    walk_extra_files(dir, dir, 0, &mut found);
    found.sort();
    found
}

/// `collect_extra_files` 的递归实现（开发者 Jan），`base` 为技能根目录、用于换算相对路径
fn walk_extra_files(base: &Path, dir: &Path, depth: usize, found: &mut Vec<String>) {
    if depth >= MAX_EXTRA_DEPTH || found.len() >= MAX_EXTRA_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if found.len() >= MAX_EXTRA_FILES {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // `entry.path()` 每次调用都新建 PathBuf，先绑成局部变量再复用，否则借用会超出生命周期
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            walk_extra_files(base, &path, depth + 1, found);
            continue;
        }
        if !meta.is_file() || name == SKILL_FILE {
            continue;
        }
        // 读一次确认是文本：读不出来的文件列在索引里等于给模型挖坑
        if fs::read_to_string(&path).is_err() {
            continue;
        }
        let Ok(relative) = path.strip_prefix(base) else { continue };
        let relative = relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if !relative.is_empty() {
            found.push(relative);
        }
    }
}

/// 扫描一个技能根目录下的全部技能（开发者 Jan），按名称排序返回。
///
/// 只认「目录 + 目录内 SKILL.md 是普通文件」的结构：SKILL.md 是软链的目录直接跳过，
/// 避免技能内容被指向工作区外的文件。
/// 名称缺失时退回目录名，使手工放进来的技能也能被识别；读不出的文件整条跳过，
/// 不让单个坏文件影响其余技能的可用性。
fn scan_root(root: &Path) -> Vec<SkillInfo> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || dir.join(SKILL_FILE).is_symlink() {
            continue;
        }
        let file = dir.join(SKILL_FILE);
        if !file.is_file() {
            continue;
        }
        let body = match fs::read_to_string(&file) {
            Ok(body) => body,
            Err(_) => continue,
        };
        let dir_name = dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if dir_name.is_empty() {
            continue;
        }
        let (name, description) = match parse_frontmatter(&body) {
            Ok(fields) => fields,
            Err(error) => {
                let diagnostic = format!("frontmatter 解析失败（{}）：{error}", file.display());
                crate::trace::write(&diagnostic);
                (None, Some(diagnostic))
            }
        };
        found.push(SkillInfo {
            id: dir_name.clone(),
            name: name.filter(|value| !value.is_empty()).unwrap_or(dir_name),
            description: description.unwrap_or_default(),
            body,
            path: file.to_string_lossy().into_owned(),
            files: collect_extra_files(&dir),
        });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// 渲染技能索引 SKILLS.md（开发者 Jan）：列出每个技能的名称、说明与路径。
///
/// 索引是模型了解「有哪些技能可用」的唯一入口，因此正文刻意不写进索引——
/// 技能正文可能很长，全部塞进系统提示会挤占上下文，模型需要时再用 read_skill 按名取全文。
/// 没有技能时也写一份占位说明，避免模型看到空文件后反复重试。
fn render_index(skills: &[SkillInfo]) -> String {
    if skills.is_empty() {
        return "# 技能目录\n\n当前没有可用技能。\n".to_string();
    }
    let mut lines = vec![
        "# 技能目录".to_string(),
        String::new(),
        format!(
            "共 {} 个可用技能。需要某个技能的完整说明时，调用 read_skill 并传入技能名；该技能自带参考文档时，再传入 file 读取对应文档。",
            skills.len()
        ),
        String::new(),
    ];
    for skill in skills {
        lines.push(format!("## {}", skill.name));
        lines.push(format!(
            "- 说明：{}",
            if skill.description.is_empty() {
                "（无说明）"
            } else {
                skill.description.as_str()
            }
        ));
        lines.push(format!("- 路径：{SKILLS_DIR}/{}/SKILL.md", skill.id));
        if !skill.files.is_empty() {
            lines.push(format!(
                "- 参考文档（read_skill 传 name=\"{}\" 与 file 读取）：{}",
                skill.id,
                skill.files.join("、")
            ));
        }
        lines.push(String::new());
    }
    lines.join("\n")
}

/// 扫描技能目录并刷新索引（开发者 Jan），返回最新技能列表。
///
/// 每次调用都会重建 SKILLS.md：技能可能被用户直接改文件系统，索引必须与目录现状一致，
/// 因此不做缓存。目录不存在时先创建，让首次启动即可用。
pub fn scan(cache_dir: &Path) -> Result<Vec<SkillInfo>, String> {
    let root = cache_dir.join(SKILLS_DIR);
    fs::create_dir_all(&root).map_err(|error| format!("创建技能目录失败: {error}"))?;
    let skills = scan_root(&root);
    fs::write(cache_dir.join(INDEX_FILE), render_index(&skills))
        .map_err(|error| format!("写入技能索引失败: {error}"))?;
    Ok(skills)
}

/// 读取技能内容（开发者 Jan）：`name` 为空时返回索引，否则返回该技能的 `SKILL.md` 全文；
/// 再传 `file` 时返回该技能目录内的参考文档（见 `read_skill_file`）。
///
/// 先扫一遍再按名称或 id 匹配（两者都认，模型可能用任一形式引用）；
/// 找不到时不是干巴巴地报「未找到」，而是把当前可用技能一并列出，
/// 让模型能自行纠正技能名后重试，而不是直接卡住。
pub fn read(cache_dir: &Path, name: Option<&str>, file: Option<&str>) -> Result<String, String> {
    let skills = scan(cache_dir)?;
    let target = name.map(str::trim).filter(|name| !name.is_empty());
    let wanted = file.map(str::trim).filter(|file| !file.is_empty());
    match (target, wanted) {
        (None, Some(_)) => Err("读取技能参考文档必须同时传入技能名（name）与文档相对路径（file）。".to_string()),
        (None, None) => fs::read_to_string(cache_dir.join(INDEX_FILE))
            .map_err(|error| format!("读取技能索引失败: {error}")),
        (Some(target), wanted) => match skills
            .iter()
            .find(|skill| skill.name == target || skill.id == target)
        {
            Some(skill) => match wanted {
                None => Ok(body_with_reference_docs(skill)),
                Some(relative) => read_skill_file(
                    &cache_dir.join(SKILLS_DIR).join(&skill.id),
                    relative,
                    &skill.files,
                ),
            },
            None => {
                let available = if skills.is_empty() {
                    "（当前没有可用技能）".to_string()
                } else {
                    skills
                        .iter()
                        .map(|skill| skill.name.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                };
                Err(format!(
                    "未找到名为「{target}」的技能。可用技能：{available}"
                ))
            }
        },
    }
}

/// 读取技能目录内的参考文档（开发者 Jan），`relative` 是相对技能目录的路径。
///
/// 这条通路把「技能自带的文档」暴露给模型，作用域必须锁死在技能目录内：
/// 拒绝绝对路径、盘符与 `..`，并逐级 `symlink_metadata` 确认没有软链——
/// 否则一个技能名就能把 `read_skill` 变成读任意本地文件的口子。
/// 找不到时把该技能实际有哪些文档一并列出，让模型自行纠正文件名，而不是卡住。
fn read_skill_file(dir: &Path, relative: &str, available: &[String]) -> Result<String, String> {
    let cleaned = relative.replace('\\', "/");
    if cleaned.starts_with('/') || cleaned.chars().next() == Some('.') {
        return Err("参考文档路径必须是技能目录内的相对路径，不能是绝对路径或隐藏文件。".to_string());
    }
    let head: Vec<char> = cleaned.chars().take(2).collect();
    if head.len() == 2 && head[1] == ':' && head[0].is_ascii_alphabetic() {
        return Err("参考文档路径不能带盘符或 Unix 根路径。".to_string());
    }
    let mut current = dir.to_path_buf();
    for segment in cleaned.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err("参考文档路径不能包含 ..。".to_string());
        }
        current = current.join(segment);
        let Ok(meta) = fs::symlink_metadata(&current) else {
            return Err(missing_doc_message(available));
        };
        if meta.file_type().is_symlink() {
            return Err("参考文档不能是符号链接。".to_string());
        }
    }
    if !current.is_file() {
        return Err(missing_doc_message(available));
    }
    fs::read_to_string(&current).map_err(|error| {
        format!("读取参考文档失败（可能是二进制或非法 UTF-8）: {error}")
    })
}

/// 「参考文档不存在」的可读提示（开发者 Jan）：把该技能实际有哪些文档列出来供模型纠正
fn missing_doc_message(available: &[String]) -> String {
    if available.is_empty() {
        return "该技能目录下没有参考文档（只有 SKILL.md）。".to_string();
    }
    format!("未找到该参考文档。该技能可用的参考文档：{}", available.join("、"))
}

/// 技能正文 + 参考文档提示（开发者 Jan）。
///
/// 模型自行调用 `read_skill(name)` 取正文时，若正文说「去查某份文档」而这份文档既不在
/// 项目工作区、工具输出又不说明它在哪、怎么读，模型就会先拿 read_file / search_code 去项目里找
/// （够不到缓存目录），找不到便改用联网检索或连远程主机——本轮执行就绕开了技能本身。
/// 因此在正文末尾补一条「自带哪些参考文档、用哪两个参数读」，让模型读完正文当场就知道
/// 下一步该调 `read_skill(name, file)`，而不是绕去别的通路。没有参考文档时正文原样返回。
fn body_with_reference_docs(skill: &SkillInfo) -> String {
    if skill.files.is_empty() {
        return skill.body.clone();
    }
    format!(
        "{}\n\n该技能目录还自带 {} 份参考文档：{}。需要其中的内容时，调用 read_skill 并同时传入 name=\"{}\" 与 file=文档相对路径。这些文档在技能目录里、不在项目工作区内，read_file 与 search_code 读不到。",
        skill.body,
        skill.files.len(),
        skill.files.join("、"),
        skill.id
    )
}

/// 校验技能 id（开发者 Jan），返回去空白后的合法 id。
///
/// id 会作为单层目录名参与路径拼接，因此必须挡住 `.` / `..`、路径分隔符
/// 与非 ASCII 字符——否则「技能 id」就能被用来把目录写到技能根目录之外。
fn validate_skill_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() || id == "." || id == ".." {
        return Err("技能 id 不能为空，也不能是 . 或 ..。".to_string());
    }
    if id.starts_with('/') || id.contains('/') || id.contains('\\') {
        return Err("技能 id 只能是单层目录名，不能包含路径分隔符。".to_string());
    }
    if !id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("技能 id 只允许 ASCII 字母、数字、短横线和下划线。".to_string());
    }
    Ok(id.to_string())
}

/// 取技能根目录（开发者 Jan），不存在时创建
fn skills_root(cache_dir: &Path) -> Result<PathBuf, String> {
    let root = cache_dir.join(SKILLS_DIR);
    fs::create_dir_all(&root).map_err(|error| format!("创建技能目录失败: {error}"))?;
    Ok(root)
}

/// 把技能的三个字段拼成一份带 frontmatter 的 SKILL.md（开发者 Jan）。
///
/// 名称与说明 trim 后编码为 YAML 兼容的 JSON 双引号字符串，避免换行、冒号、
/// 引号与注释符改变字段结构；正文保持原样。
fn render_skill(name: &str, description: &str, body: &str) -> String {
    format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}",
        serde_json::to_string(name.trim()).expect("字符串序列化不会失败"),
        serde_json::to_string(description.trim()).expect("字符串序列化不会失败"),
        body
    )
}

/// 原子写入一个技能文件（开发者 Jan）：先写同目录下的临时文件，再 rename 覆盖目标。
///
/// 直接截断重写目标文件时，中途失败会留下半份内容；rename 在同一文件系统内是原子的，
/// 因此要么是旧内容、要么是新内容。失败时顺手清掉临时文件，避免技能目录里堆积残留。
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "技能文件路径无父目录。".to_string())?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().unwrap().to_string_lossy(),
        std::process::id()
    ));
    fs::write(&temp, contents).map_err(|error| format!("写入临时技能文件失败: {error}"))?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("替换技能文件失败: {error}"));
    }
    Ok(())
}

/// 递归复制目录，并拒绝任何符号链接（开发者 Jan）。
///
/// 导入来源由用户自选，可能带有指向系统目录的软链；若原样复制，
/// 技能目录里就会出现指向工作区外的入口，后续读取会越出缓存范围。
/// 因此在每一层都先看 symlink_metadata，遇到软链立即报错；非普通文件与目录的类型也拒绝。
fn copy_dir_without_symlinks(source: &Path, target: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| format!("读取导入目录失败: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("导入目录不能包含符号链接。".to_string());
    }
    fs::create_dir_all(target).map_err(|error| format!("创建导入目录失败: {error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("读取导入目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取导入目录项失败: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("读取导入目录项失败: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("导入目录不能包含符号链接。".to_string());
        }
        if metadata.is_dir() {
            copy_dir_without_symlinks(&source_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("复制导入文件失败: {error}"))?;
        } else {
            return Err("导入目录包含不支持的文件类型。".to_string());
        }
    }
    Ok(())
}

/// 删除一个技能目录及其全部内容（开发者 Jan）
fn remove_dir(path: &Path) -> Result<(), String> {
    fs::remove_dir_all(path).map_err(|error| format!("删除技能目录失败: {error}"))
}

/// 新建一个技能（开发者 Jan），返回最新技能列表。
///
/// 已存在且未显式 overwrite 时拒绝，避免悄悄覆盖用户已调好的技能；
/// 写入失败时把刚建出的目录删掉，不留半个空技能。
/// 成功与否都会重扫一次目录，保证返回的列表与磁盘一致。
pub fn create(cache_dir: &Path, input: CreateSkillInput) -> Result<Vec<SkillInfo>, String> {
    let id = validate_skill_id(&input.id)?;
    let root = skills_root(cache_dir)?;
    let dir = root.join(&id);
    if dir.exists() && !input.overwrite {
        return Err(format!("技能已存在：{id}。如需覆盖请明确确认。"));
    }
    if dir.exists() {
        remove_dir(&dir)?;
    }
    fs::create_dir_all(&dir).map_err(|error| format!("创建技能目录失败: {error}"))?;
    if let Err(error) = write_atomic(
        &dir.join(SKILL_FILE),
        &render_skill(&input.name, &input.description, &input.body),
    ) {
        let _ = fs::remove_dir_all(&dir);
        return Err(error);
    }
    scan(cache_dir)
}

/// 更新一个技能（开发者 Jan），支持同时改 id（改名目录）。
///
/// 分两种情况：id 不变时直接原子重写 SKILL.md；id 变化时先把新内容写进临时目录，
/// 再把旧目录改名为备份、把临时目录改名为正式目录，任何一步失败都回滚。
/// 走两步 rename 而不是「删旧再建新」，是因为改名过程本身可能失败，
/// 而用户改 id 时最怕的正是原技能被弄丢。
pub fn update(cache_dir: &Path, input: UpdateSkillInput) -> Result<Vec<SkillInfo>, String> {
    let original_id = validate_skill_id(&input.original_id)?;
    let id = validate_skill_id(&input.id)?;
    let root = skills_root(cache_dir)?;
    let original = root.join(&original_id);
    let target = root.join(&id);
    if !original.is_dir() || !original.join(SKILL_FILE).is_file() {
        return Err(format!("原技能不存在：{original_id}"));
    }
    if original != target && target.exists() && !input.overwrite {
        return Err(format!("目标技能已存在：{id}。如需覆盖请明确确认。"));
    }
    if original == target {
        write_atomic(
            &target.join(SKILL_FILE),
            &render_skill(&input.name, &input.description, &input.body),
        )?;
    } else {
        let temp = root.join(format!(".skill-update-{}-{}", id, std::process::id()));
        if temp.exists() {
            let _ = fs::remove_dir_all(&temp);
        }
        fs::create_dir_all(&temp).map_err(|error| format!("创建临时技能目录失败: {error}"))?;
        if let Err(error) = write_atomic(
            &temp.join(SKILL_FILE),
            &render_skill(&input.name, &input.description, &input.body),
        ) {
            let _ = fs::remove_dir_all(&temp);
            return Err(error);
        }
        let backup = root.join(format!(".skill-backup-{}-{}", id, std::process::id()));
        if target.exists() {
            fs::rename(&target, &backup).map_err(|error| format!("备份目标技能失败: {error}"))?;
        }
        if let Err(error) = fs::rename(&temp, &target) {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            let _ = fs::remove_dir_all(&temp);
            return Err(format!("替换目标技能失败: {error}"));
        }
        let _ = fs::remove_dir_all(&backup);
        remove_dir(&original)?;
    }
    scan(cache_dir)
}

/// 删除一个技能（开发者 Jan）：技能不存在时报错，避免「以为删掉了其实没删」
pub fn delete(cache_dir: &Path, input: DeleteSkillInput) -> Result<Vec<SkillInfo>, String> {
    let id = validate_skill_id(&input.id)?;
    let root = skills_root(cache_dir)?;
    let dir = root.join(&id);
    if !dir.is_dir() || !dir.join(SKILL_FILE).is_file() {
        return Err(format!("技能不存在：{id}"));
    }
    remove_dir(&dir)?;
    scan(cache_dir)
}

/// 从本机目录导入一个技能（开发者 Jan），返回最新技能列表。
///
/// 先校验来源：必须是普通目录（不能是软链）且含可读的 SKILL.md，避免导入空壳目录。
/// id 未指定时沿用源目录名。落盘同样走「临时目录 + 备份改名」的两步替换，
/// 并在覆盖前确认目标已存在但未授权覆盖时直接拒绝，防止误覆盖。
pub fn import(cache_dir: &Path, input: ImportSkillInput) -> Result<Vec<SkillInfo>, String> {
    let source = PathBuf::from(input.source_dir.trim());
    let source_meta =
        fs::symlink_metadata(&source).map_err(|error| format!("读取导入目录失败: {error}"))?;
    if !source_meta.is_dir() || source_meta.file_type().is_symlink() {
        return Err("导入来源必须是普通目录，不能是符号链接。".to_string());
    }
    let source_skill = source.join(SKILL_FILE);
    if !source_skill.is_file() || source_skill.is_symlink() {
        return Err("导入目录必须包含可读的 SKILL.md。".to_string());
    }
    fs::read_to_string(&source_skill).map_err(|error| format!("读取 SKILL.md 失败: {error}"))?;
    let default_id = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let id = validate_skill_id(input.id.as_deref().unwrap_or(&default_id))?;
    let root = skills_root(cache_dir)?;
    let target = root.join(&id);
    if target.exists() && !input.overwrite {
        return Err(format!("技能已存在：{id}。如需覆盖请明确确认。"));
    }
    let temp = root.join(format!(".skill-import-{}-{}", id, std::process::id()));
    if temp.exists() {
        let _ = fs::remove_dir_all(&temp);
    }
    if let Err(error) = copy_dir_without_symlinks(&source, &temp) {
        let _ = fs::remove_dir_all(&temp);
        return Err(error);
    }
    let backup = root.join(format!(
        ".skill-import-backup-{}-{}",
        id,
        std::process::id()
    ));
    if target.exists() {
        fs::rename(&target, &backup).map_err(|error| format!("备份目标技能失败: {error}"))?;
    }
    if let Err(error) = fs::rename(&temp, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_dir_all(&temp);
        return Err(format!("导入技能失败: {error}"));
    }
    let _ = fs::remove_dir_all(&backup);
    scan(cache_dir)
}

/// 扫描技能目录并刷新索引（开发者 Jan）；前端技能页与启动流程都走这个命令
#[tauri::command]
pub fn scan_skills(cache_dir: String) -> Result<Vec<SkillInfo>, String> {
    scan(Path::new(&cache_dir))
}

/// 读取技能索引、某个技能正文，或该技能目录内的参考文档（开发者 Jan）
#[tauri::command]
pub fn read_skill(
    cache_dir: String,
    name: Option<String>,
    file: Option<String>,
) -> Result<String, String> {
    read(Path::new(&cache_dir), name.as_deref(), file.as_deref())
}

/// 新建技能（开发者 Jan）：已存在且未授权覆盖时报错
#[tauri::command]
pub fn create_skill(cache_dir: String, input: CreateSkillInput) -> Result<Vec<SkillInfo>, String> {
    create(Path::new(&cache_dir), input)
}

/// 更新技能（开发者 Jan）：支持改 id（改名目录），失败时回滚保留原技能
#[tauri::command]
pub fn update_skill(cache_dir: String, input: UpdateSkillInput) -> Result<Vec<SkillInfo>, String> {
    update(Path::new(&cache_dir), input)
}

/// 删除技能（开发者 Jan）：连带删除其目录并重建索引
#[tauri::command]
pub fn delete_skill(cache_dir: String, input: DeleteSkillInput) -> Result<Vec<SkillInfo>, String> {
    delete(Path::new(&cache_dir), input)
}

/// 从本机目录导入技能（开发者 Jan）：来源必须是含 SKILL.md 的普通目录
#[tauri::command]
pub fn import_skill(cache_dir: String, input: ImportSkillInput) -> Result<Vec<SkillInfo>, String> {
    import(Path::new(&cache_dir), input)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("octopuses-skills-test-{}-{}", std::process::id(), name));
        if dir.exists() {
            fs::remove_dir_all(&dir).expect("清理测试目录失败");
        }
        dir
    }

    fn write_skill(cache: &Path, dir_name: &str, body: &str) {
        let dir = cache.join(SKILLS_DIR).join(dir_name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_FILE), body).unwrap();
    }

    fn create_input(id: &str) -> CreateSkillInput {
        CreateSkillInput {
            id: id.to_string(),
            name: id.to_string(),
            description: "说明".to_string(),
            body: "正文".to_string(),
            overwrite: false,
        }
    }

    #[test]
    fn parses_frontmatter_fields() {
        let text = "---\nname: code-review\ndescription: \"按团队规范审查 diff\"\n---\n\n正文内容";
        let (name, description) = parse_frontmatter(text).unwrap();
        assert_eq!(name.as_deref(), Some("code-review"));
        assert_eq!(description.as_deref(), Some("按团队规范审查 diff"));
    }

    #[test]
    fn tolerates_missing_frontmatter_and_extra_lines() {
        let (name, description) = parse_frontmatter("# 没有 frontmatter\nname: 不该被读取\n").unwrap();
        assert!(name.is_none());
        assert!(description.is_none());
        let (name, description) = parse_frontmatter("---\ndescription: '单引号说明'\n---\n").unwrap();
        assert!(name.is_none());
        assert_eq!(description.as_deref(), Some("单引号说明"));
    }

    #[test]
    fn block_description_rebuilds_index_and_keeps_body_and_references() {
        let cache = scratch("block-index");
        let source = "---\nname: folded\ndescription: >-\n  first line\n  second line\n---\n正文";
        write_skill(&cache, "folded", source);
        fs::write(cache.join(SKILLS_DIR).join("folded/ref.md"), "参考").unwrap();
        fs::write(cache.join(INDEX_FILE), "旧索引：>-").unwrap();
        let skills = scan(&cache).unwrap();
        assert_eq!(skills[0].description, "first line second line");
        assert_eq!(skills[0].body, source);
        let index = fs::read_to_string(cache.join(INDEX_FILE)).unwrap();
        assert!(index.contains("first line second line"));
        assert!(!index.contains(">-"));
        let body = read(&cache, Some("folded"), None).unwrap();
        assert!(body.starts_with(source));
        assert!(body.contains("ref.md"));
        fs::remove_dir_all(cache).ok();
    }

    #[test]
    fn invalid_frontmatter_is_visible_without_dropping_skill() {
        let cache = scratch("invalid-frontmatter");
        let source = "---\ndescription: >invalid\n---\n正文";
        write_skill(&cache, "broken", source);
        let skills = scan(&cache).unwrap();
        assert_eq!(skills[0].name, "broken");
        assert!(skills[0].description.contains("frontmatter 解析失败"));
        assert!(skills[0].description.contains("SKILL.md"));
        assert!(skills[0].description.contains("第 2 行"));
        assert_eq!(read(&cache, Some("broken"), None).unwrap(), source);
        fs::remove_dir_all(cache).ok();
    }

    #[test]
    fn rendered_skill_roundtrips_special_characters() {
        let source = render_skill("name: quoted # name", "first\nsecond: 'quoted' # text", "正文");
        let (name, description) = parse_frontmatter(&source).unwrap();
        assert_eq!(name.as_deref(), Some("name: quoted # name"));
        assert_eq!(description.as_deref(), Some("first\nsecond: 'quoted' # text"));
    }

    #[test]
    fn scan_reads_skill_dirs_and_ignores_others() {
        let cache = scratch("scan");
        write_skill(
            &cache,
            "beta",
            "---\nname: beta\ndescription: 第二个\n---\nbeta 正文",
        );
        write_skill(&cache, "alpha", "alpha 正文");
        fs::create_dir_all(cache.join(SKILLS_DIR).join("not-a-skill")).unwrap();
        fs::write(cache.join(SKILLS_DIR).join("README.md"), "忽略我").unwrap();
        let skills = scan(&cache).expect("扫描技能失败");
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].id, "alpha");
        assert_eq!(skills[1].name, "beta");
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn scan_creates_dir_and_writes_index() {
        let cache = scratch("index");
        write_skill(
            &cache,
            "code-review",
            "---\nname: code-review\ndescription: 审查 diff\n---\n正文",
        );
        let skills = scan(&cache).expect("扫描技能失败");
        assert_eq!(skills.len(), 1);
        let index = fs::read_to_string(cache.join(INDEX_FILE)).unwrap();
        assert!(index.contains("共 1 个可用技能"));
        assert!(index.contains("审查 diff"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn scan_empty_dir_writes_placeholder_index() {
        let cache = scratch("empty");
        assert!(scan(&cache).unwrap().is_empty());
        assert!(fs::read_to_string(cache.join(INDEX_FILE))
            .unwrap()
            .contains("当前没有可用技能"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn read_without_name_returns_index_and_with_name_returns_body() {
        let cache = scratch("read");
        write_skill(
            &cache,
            "code-review",
            "---\nname: code-review\n---\n审查正文",
        );
        assert!(read(&cache, None, None).unwrap().contains("## code-review"));
        assert!(read(&cache, Some("code-review"), None)
            .unwrap()
            .contains("审查正文"));
        fs::remove_dir_all(&cache).ok();
    }

    /// 技能目录内的参考文档：扫描时枚举进索引，读取时按相对路径取回全文
    #[test]
    fn scan_lists_and_read_fetches_sibling_docs() {
        let cache = scratch("sibling");
        write_skill(&cache, "erp", "---\nname: ERP 取数\n---\n先查 DB_DOC.MD");
        let dir = cache.join(SKILLS_DIR).join("erp");
        fs::write(dir.join("DB_DOC.MD"), "# 部门表\n\ncDepCode 部门编码").unwrap();
        fs::create_dir_all(dir.join("refs")).unwrap();
        fs::write(dir.join("refs").join("fields.md"), "字段字典").unwrap();
        fs::write(dir.join("blob.bin"), [0u8, 159, 146, 128]).unwrap();

        let skills = scan(&cache).unwrap();
        assert_eq!(skills[0].files, vec!["DB_DOC.MD".to_string(), "refs/fields.md".to_string()]);
        assert!(read(&cache, None, None).unwrap().contains("DB_DOC.MD"));
        // 读正文时要顺带点名参考文档与读法，否则模型读完正文不知道下一步该调 read_skill(name, file)
        let body = read(&cache, Some("erp"), None).unwrap();
        assert!(body.contains("先查 DB_DOC.MD"));
        assert!(body.contains("name=\"erp\""));
        assert!(body.contains("DB_DOC.MD"));

        let content = read(&cache, Some("erp"), Some("DB_DOC.MD")).unwrap();
        assert!(content.contains("cDepCode"));
        assert!(read(&cache, Some("erp"), Some("refs/fields.md"))
            .unwrap()
            .contains("字段字典"));
        // 不存在的文件名：把可用文档列出来让模型自行纠正
        let error = read(&cache, Some("erp"), Some("DEPT.md")).unwrap_err();
        assert!(error.contains("DB_DOC.MD"));
        // 只有 SKILL.md 的技能明确说明没有参考文档，正文也不追加文档提示
        write_skill(&cache, "plain", "---\nname: plain\n---\n正文");
        assert!(read(&cache, Some("plain"), Some("x.md"))
            .unwrap_err()
            .contains("没有参考文档"));
        assert_eq!(read(&cache, Some("plain"), None).unwrap(), "---\nname: plain\n---\n正文");
        fs::remove_dir_all(&cache).ok();
    }

    /// 参考文档路径必须锁在技能目录内：绝对路径、盘符、`..`、隐藏文件一律拒绝
    #[test]
    fn read_sibling_doc_rejects_paths_outside_skill_dir() {
        let cache = scratch("escape");
        write_skill(&cache, "erp", "---\nname: erp\n---\n正文");
        fs::write(cache.join("secret.md"), "缓存根目录外的内容").unwrap();
        for path in [
            "../secret.md",
            "../../secret.md",
            "/etc/passwd",
            "C:/Windows/win.ini",
            "\\\\server\\share\\x.md",
            ".hidden.md",
        ] {
            assert!(read(&cache, Some("erp"), Some(path)).is_err(), "应拒绝 {path}");
        }
        // 只传 file 不传 name 同样拒绝，否则无从确定作用域
        assert!(read(&cache, None, Some("DB_DOC.MD")).is_err());
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn read_unknown_skill_reports_available() {
        let cache = scratch("unknown");
        write_skill(&cache, "code-review", "---\nname: code-review\n---\n正文");
        let error = read(&cache, Some("不存在"), None).unwrap_err();
        assert!(error.contains("未找到"));
        assert!(error.contains("code-review"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn validates_safe_skill_ids() {
        for id in ["", ".", "..", "/tmp", "a/b", "a\\b", "a..b", "技能"] {
            assert!(validate_skill_id(id).is_err(), "应拒绝 {id}");
        }
        assert_eq!(validate_skill_id("code-review_2").unwrap(), "code-review_2");
    }

    #[test]
    fn create_requires_explicit_overwrite() {
        let cache = scratch("create");
        create(&cache, create_input("demo")).unwrap();
        let error = create(&cache, create_input("demo")).unwrap_err();
        assert!(error.contains("覆盖"));
        let mut input = create_input("demo");
        input.overwrite = true;
        input.body = "新正文".to_string();
        let skills = create(&cache, input).unwrap();
        assert!(skills[0].body.contains("新正文"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn update_renames_and_keeps_old_on_validation_failure() {
        let cache = scratch("update");
        create(&cache, create_input("old")).unwrap();
        let mut input = UpdateSkillInput {
            original_id: "old".into(),
            id: "new".into(),
            name: "new".into(),
            description: "".into(),
            body: "body".into(),
            overwrite: false,
        };
        update(&cache, input.clone()).unwrap();
        assert!(
            !cache.join(SKILLS_DIR).join("old").exists(),
            "重命名后旧技能目录不应存在"
        );
        assert!(cache.join(SKILLS_DIR).join("new").exists());
        input.original_id = "missing".into();
        assert!(update(&cache, input).is_err());
        assert!(cache.join(SKILLS_DIR).join("new").join(SKILL_FILE).exists());
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn delete_rejects_missing_skill_and_deletes_one_directory() {
        let cache = scratch("delete");
        create(&cache, create_input("demo")).unwrap();
        assert!(delete(
            &cache,
            DeleteSkillInput {
                id: "missing".into()
            }
        )
        .is_err());
        delete(&cache, DeleteSkillInput { id: "demo".into() }).unwrap();
        assert!(!cache.join(SKILLS_DIR).join("demo").exists());
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn import_rejects_missing_skill_file_and_symlink() {
        let cache = scratch("import");
        let source = scratch("source");
        fs::create_dir_all(&source).unwrap();
        assert!(import(
            &cache,
            ImportSkillInput {
                source_dir: source.to_string_lossy().into(),
                id: None,
                overwrite: false
            }
        )
        .is_err());
        fs::write(source.join(SKILL_FILE), "---\nname: imported\n---\n正文").unwrap();
        // 符号链接场景只在 Unix 成立（Windows 建符号链接需要额外权限），单独按平台编译
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let linked = source.join("linked.txt");
            fs::write(source.join("real.txt"), "x").unwrap();
            symlink(source.join("real.txt"), &linked).unwrap();
            assert!(import(
                &cache,
                ImportSkillInput {
                    source_dir: source.to_string_lossy().into(),
                    id: None,
                    overwrite: false
                }
            )
            .is_err());
            fs::remove_file(linked).unwrap();
        }
        let skills = import(
            &cache,
            ImportSkillInput {
                source_dir: source.to_string_lossy().into(),
                id: Some("imported".into()),
                overwrite: false,
            },
        )
        .unwrap();
        assert_eq!(skills[0].id, "imported");
        fs::remove_dir_all(&cache).ok();
        fs::remove_dir_all(&source).ok();
    }
}
