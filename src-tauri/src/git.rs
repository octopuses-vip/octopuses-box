//! Git 与 worktree 管理：所有 Git 调用均通过 `Command` 参数数组执行，不经过 Shell。

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;

const WORKTREE_DIR: &str = "worktrees";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommandResult {
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryInfo {
    pub is_repository: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub clean: bool,
    pub status: Vec<String>,
    pub upstream: Option<String>,
    pub origin: Option<String>,
    pub compare_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub path: String,
    pub branch: String,
    pub result: GitCommandResult,
}

/// 把参数列表还原成一条可读的 git 命令（开发者 Jan），用于错误提示与界面回显。
///
/// 只含安全字符的参数直接原样输出，其余用 `{:?}` 加引号——命令文本会展示给用户，
/// 必须一眼能看出真实参数边界，同时避免路径里的空格造成误读。
fn command_text(args: &[String]) -> String {
    let body = args
        .iter()
        .map(|arg| {
            if arg
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "-._/:@".contains(ch))
            {
                arg.clone()
            } else {
                format!("{:?}", arg)
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("git {body}")
}

/// 把子进程输出整理成回前端的结构（开发者 Jan）；退出码取不到时记为 -1（如被信号终止） */
fn output_result(args: &[String], output: Output) -> GitCommandResult {
    GitCommandResult {
        command: command_text(args),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    }
}

/// 执行一条 git 命令并原样返回输出（开发者 Jan）：非零退出码不算错误，由调用方按需判定 */
fn run_git(args: &[String]) -> Result<GitCommandResult, String> {
    let mut command = Command::new("git");
    command.args(args);
    // Windows 上不设 CREATE_NO_WINDOW 的话，每次 git 调用都会闪一个控制台窗口
    crate::platform::hide_console(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("启动 Git 失败：{error}"))?;
    Ok(output_result(args, output))
}

/// 执行一条必须成功的 git 命令（开发者 Jan）：非零退出码转成 Err，优先用 stderr 当原因。
///
/// git 的失败原因通常写在 stderr（如「not a git repository」），直接透出去比自造文案更有用；
/// stderr 为空时才退回「<命令> 失败」。
fn run_git_ok(args: &[String]) -> Result<GitCommandResult, String> {
    let result = run_git(args)?;
    if result.exit_code == 0 {
        Ok(result)
    } else {
        Err(result
            .stderr
            .trim()
            .to_string()
            .if_empty(format!("{} 失败", result.command)))
    }
}

/// 空字符串回退到默认文案的小工具（开发者 Jan），用于「失败原因取不到」时的兜底
trait IfEmpty {
    /// 自身为空则返回 fallback（开发者 Jan）
    fn if_empty(self, fallback: String) -> String;
}

impl IfEmpty for String {
    /// 自身为空则返回 fallback（开发者 Jan）：git 没给出 stderr 时补一句可读的失败原因
    fn if_empty(self, fallback: String) -> String {
        if self.is_empty() {
            fallback
        } else {
            self
        }
    }
}

/// 规范化一个目录路径（开发者 Jan）：同时校验存在性与「确实是目录」。
///
/// `label` 用于拼出可读报错（如「项目目录不存在或无法访问」），
/// 因为同一个函数会用于项目目录与缓存目录两处。
fn canonical_dir(path: &str, label: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("{label}不存在或无法访问：{path}（{error}）"))?;
    if !canonical.is_dir() {
        return Err(format!("{label}不是目录：{}", canonical.display()));
    }
    Ok(canonical)
}

/// 校验一段会被拼进路径或分支名的标识（开发者 Jan）。
///
/// 只允许 ASCII 字母数字与 `-_`，并限长 120：这些值会直接参与目录名与分支名拼接，
/// 放行 `/`、`..`、空格或非 ASCII 都可能越出预期目录或生成 git 不认的引用名。
fn safe_component(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 120
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!("{label}不合法"));
    }
    Ok(value.to_string())
}

/// 生成一个项目在缓存目录中的稳定键（开发者 Jan），形如 `<项目ID>-<路径哈希>`。
///
/// 拼上路径哈希的原因：项目 ID 由用户命名、可能重名，而 Worktree 必须按
/// 「哪个目录的仓库」区分，否则两个同名项目会共用同一份 worktree 管理目录。
fn project_key(project_id: &str, project_path: &Path) -> Result<String, String> {
    let id = safe_component(project_id, "项目 ID")?;
    let mut hasher = DefaultHasher::new();
    project_path.to_string_lossy().hash(&mut hasher);
    Ok(format!("{}-{:016x}", id, hasher.finish()))
}

/// 取（必要时创建）某个项目的 worktree 管理目录（开发者 Jan），位于缓存目录的 `worktrees/` 下。
///
/// 每一层都做 `canonicalize`：返回的路径会被当作「允许操作范围」的基准，
/// 带着软链或未展开的相对路径会导致后续的越界判断失准。
fn managed_root(
    cache_path: &str,
    project_id: &str,
    project_path: &Path,
) -> Result<PathBuf, String> {
    let cache = Path::new(cache_path);
    fs::create_dir_all(cache).map_err(|error| format!("创建缓存目录失败：{error}"))?;
    let cache = fs::canonicalize(cache).map_err(|error| format!("缓存目录无法访问：{error}"))?;
    let root = cache
        .join(WORKTREE_DIR)
        .join(project_key(project_id, project_path)?);
    fs::create_dir_all(&root).map_err(|error| format!("创建 worktree 管理目录失败：{error}"))?;
    fs::canonicalize(&root).map_err(|error| format!("worktree 管理目录无法访问：{error}"))
}

/// 确认待操作的 worktree 确实位于管理目录之内（开发者 Jan），返回规范化后的路径。
///
/// 额外排除「等于管理目录本身」的情况：删除或强制清理一个等于根目录的路径
/// 会连带清掉同项目下其他会话的 worktree。
fn validate_managed_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("worktree 路径不存在：{}（{error}）", path.display()))?;
    if canonical == root || !canonical.starts_with(root) {
        return Err("拒绝操作应用管理目录之外的 worktree".to_string());
    }
    Ok(canonical)
}

/// 把任意文本压成适合做分支名的一段（开发者 Jan）。
///
/// 非字母数字一律折成单个 `-` 并去掉首尾的 `-`，超长按 limit 截断；
/// 结果为空时用 fallback 顶上——分支名不能为空，否则 git 会直接拒绝创建。
fn slug(value: &str, fallback: &str, limit: usize) -> String {
    let mut output = String::new();
    let mut dash = false;
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            output.push(ch);
            dash = false;
        } else if !dash && !output.is_empty() {
            output.push('-');
            dash = true;
        }
        if output.len() >= limit {
            break;
        }
    }
    let output = output.trim_matches('-');
    if output.is_empty() {
        fallback.to_string()
    } else {
        output.to_string()
    }
}

/// 校验分支名是否合法（开发者 Jan）。
///
/// 按 git 的 ref 规则挡掉一批会让命令失效或产生歧义的名字：以 `-` 开头（会被当成选项）、
/// 含 `..` / `@{` / 空白 / `~^:?*[\` 等特殊字符、以 `.` 或 `/` 或 `.lock` 结尾、
/// 以及含空段或以 `.` 开头结尾的路径段。
/// 这层校验的意义是：分支名最终会拼进命令行，放宽即等于给了参数注入的口子。
fn validate_ref(branch: &str) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.contains("..")
        || branch.contains("@{")
        || branch.ends_with('.')
        || branch.ends_with('/')
        || branch.ends_with(".lock")
        || branch
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || "~^:?*[\\;$`|&<>()".contains(ch))
        || branch
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with('.'))
    {
        return Err("Git 分支名不合法".to_string());
    }
    Ok(())
}

/// 按「会话 id + 任务标题」生成任务分支名（开发者 Jan），形如 `octopuses/<会话前10位>-<标题摘要>`。
///
/// 会话 id 截 10 位、标题压成最多 36 字符，保证分支名足够短且可读；
/// 生成后再过一遍 [`validate_ref`]，因为标题里的字符经 [`slug`] 处理后仍可能触发其他规则。
fn branch_name(thread_id: &str, title: &str) -> Result<String, String> {
    let thread = safe_component(thread_id, "会话 ID")?;
    let short = thread.chars().take(10).collect::<String>();
    let branch = format!(
        "octopuses/{}-{}",
        slug(&short, "thread", 10),
        slug(title, "task", 36)
    );
    validate_ref(&branch)?;
    Ok(branch)
}

/// 拼一条带 `-C <工作区>` 的 git 参数（开发者 Jan）：让命令在指定仓库里执行，无需切换进程工作目录 */
fn repo_args(workspace: &Path, tail: &[&str]) -> Vec<String> {
    let mut args = vec!["-C".to_string(), workspace.to_string_lossy().into_owned()];
    args.extend(tail.iter().map(|value| value.to_string()));
    args
}

/// 读取一条 git 查询结果（开发者 Jan），失败或结果为空时返回 `None`。
///
/// 只用于「取信息」而非「执行动作」：仓库未初始化、分支不存在、没有 origin 等
/// 都属于正常情况，不该报错中断界面渲染，因此这里把失败统一折成 None。
fn git_value(workspace: &Path, tail: &[&str]) -> Option<String> {
    let args = repo_args(workspace, tail);
    run_git(&args)
        .ok()
        .filter(|result| result.exit_code == 0)
        .map(|result| result.stdout.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 推导「在远端查看/比较该分支」的网页链接（开发者 Jan）。
///
/// 支持 `git@host:path` 与 http(s) 两种 origin 形态，前者转成 https 形式；
/// 其他形态（本地路径、自建协议）无法推导网页地址，返回 `None`。
/// 分支名先经 [`validate_ref`] 校验再拼进 URL，避免把特殊字符带进链接。
fn compare_url(origin: Option<&str>, branch: Option<&str>) -> Option<String> {
    let origin = origin?
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let branch = branch?;
    validate_ref(branch).ok()?;
    let base = if let Some(rest) = origin.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        format!("https://{host}/{path}")
    } else if origin.starts_with("https://") || origin.starts_with("http://") {
        origin.to_string()
    } else {
        return None;
    };
    Some(format!("{base}/compare/{branch}"))
}

/// 汇总一个工作区的仓库概况（开发者 Jan）：是否仓库、当前分支、HEAD、改动列表、upstream 与比较链接。
///
/// 先探一次 `rev-parse --is-inside-work-tree`：不是仓库就返回一份「空但合法」的结果，
/// 让界面能正常显示「未初始化 Git」而不是报错。
/// 改动列表用 `--untracked-files=all`，使新建的嵌套文件也能被逐条列出。
fn repository_info(workspace: &Path) -> Result<GitRepositoryInfo, String> {
    let probe = run_git(&repo_args(
        workspace,
        &["rev-parse", "--is-inside-work-tree"],
    ))?;
    if probe.exit_code != 0 || probe.stdout.trim() != "true" {
        return Ok(GitRepositoryInfo {
            is_repository: false,
            branch: None,
            head: None,
            clean: true,
            status: Vec::new(),
            upstream: None,
            origin: None,
            compare_url: None,
        });
    }
    let status = git_value(
        workspace,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )
    .unwrap_or_default()
    .lines()
    .map(str::to_string)
    .collect::<Vec<_>>();
    let branch = git_value(workspace, &["branch", "--show-current"]);
    let origin = git_value(workspace, &["remote", "get-url", "origin"]);
    Ok(GitRepositoryInfo {
        is_repository: true,
        head: git_value(workspace, &["rev-parse", "HEAD"]),
        upstream: git_value(
            workspace,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        ),
        compare_url: compare_url(origin.as_deref(), branch.as_deref()),
        origin,
        branch,
        clean: status.is_empty(),
        status,
    })
}

/// 解析 `git worktree list --porcelain` 的输出（开发者 Jan）。
///
/// 输出以空行分隔多个 worktree，每块由若干 `key value` 行组成；
/// 只提取界面需要的字段，遇到不认识的键直接忽略，以便兼容 git 后续版本新增的字段。
fn parse_worktrees(text: &str) -> Vec<GitWorktree> {
    text.split("\n\n")
        .filter_map(|block| {
            let mut item = GitWorktree {
                path: String::new(),
                head: None,
                branch: None,
                bare: false,
                detached: false,
                locked: false,
                prunable: false,
            };
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("worktree ") {
                    item.path = value.to_string();
                } else if let Some(value) = line.strip_prefix("HEAD ") {
                    item.head = Some(value.to_string());
                } else if let Some(value) = line.strip_prefix("branch ") {
                    item.branch = Some(value.trim_start_matches("refs/heads/").to_string());
                } else if line == "bare" {
                    item.bare = true;
                } else if line == "detached" {
                    item.detached = true;
                } else if line.starts_with("locked") {
                    item.locked = true;
                } else if line.starts_with("prunable") {
                    item.prunable = true;
                }
            }
            (!item.path.is_empty()).then_some(item)
        })
        .collect()
}

/// 确认路径是一个 Git 仓库（开发者 Jan），否则报错中断后续操作
fn ensure_repo(path: &Path) -> Result<(), String> {
    let info = repository_info(path)?;
    if !info.is_repository {
        return Err("所选项目不是 Git 仓库".to_string());
    }
    Ok(())
}

/// 推送前的分支守卫（开发者 Jan）：拒绝直推 main / master，其余分支再走常规合法性校验。
///
/// 前后端各有一道：前端给用户即时反馈，后端作为最终防线——
/// 只要有一条路径漏判，受保护分支就可能被直接推送。
fn reject_protected_push(branch: &str) -> Result<(), String> {
    if branch == "main" || branch == "master" {
        Err("禁止直接推送 main/master，请使用任务分支".to_string())
    } else {
        validate_ref(branch)
    }
}

/// 读取工作区的 Git 概况（开发者 Jan）：当前分支、HEAD、改动列表与比较链接
#[tauri::command]
pub async fn git_repository_info(workspace_path: String) -> Result<GitRepositoryInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        repository_info(&canonical_dir(&workspace_path, "工作区")?)
    })
    .await
    .map_err(|error| format!("读取 Git 状态失败：{error}"))?
}

/// 读取工作区的完整差异文本（开发者 Jan），供右栏「差异」tab 逐行渲染。
///
/// 分两段拼：先取已跟踪文件相对 HEAD 的差异（-U3 给足三行上下文，
/// 便于按行做评论定位），再把未跟踪的新文件用 --no-index 与 /dev/null 比出差异。
/// 新文件最多取 20 个，避免刚生成的产物目录把整份差异撑爆。
/// --no-index 在存在差异时固定返回退出码 1，因此这里把 1 也视为正常。
#[tauri::command]
pub async fn git_read_diff(workspace_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = canonical_dir(&workspace_path, "工作区")?;
        ensure_repo(&workspace)?;
        let tracked = run_git_ok(&repo_args(
            &workspace,
            &["diff", "--no-color", "-U3", "HEAD"],
        ))?;
        let untracked = run_git_ok(&repo_args(
            &workspace,
            &["ls-files", "--others", "--exclude-standard"],
        ))?;
        let mut output = tracked.stdout;
        for path in untracked
            .stdout
            .lines()
            .filter(|value| !value.trim().is_empty())
            .take(20)
        {
            let args = repo_args(
                &workspace,
                &[
                    "diff",
                    "--no-color",
                    "-U3",
                    "--no-index",
                    "--",
                    "/dev/null",
                    path,
                ],
            );
            let result = run_git(&args)?;
            if result.exit_code != 0 && result.exit_code != 1 {
                return Err(result
                    .stderr
                    .trim()
                    .to_string()
                    .if_empty(format!("{} 失败", result.command)));
            }
            output.push_str(&result.stdout);
        }
        Ok(output)
    })
    .await
    .map_err(|error| format!("读取 Git 差异失败：{error}"))?
}

/// 列出本项目的全部 worktree（开发者 Jan）：供界面区分「主目录」与各会话的独立执行目录
#[tauri::command]
pub async fn git_list_worktrees(project_path: String) -> Result<Vec<GitWorktree>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = canonical_dir(&project_path, "项目目录")?;
        ensure_repo(&project)?;
        let result = run_git_ok(&repo_args(&project, &["worktree", "list", "--porcelain"]))?;
        Ok(parse_worktrees(&result.stdout))
    })
    .await
    .map_err(|error| format!("列出 worktree 失败：{error}"))?
}

/// 为某个会话创建独立 worktree（开发者 Jan），基于当前 HEAD 新建任务分支。
///
/// 目录名直接用会话 id（已过 safe_component 校验），因此一个会话最多一个 worktree；
/// 已存在则直接报错，避免复用旧目录导致里面残留上一轮改动。
/// 创建成功后再次校验托管路径，确认 git 确实把目录建在了管理范围内。
#[tauri::command]
pub async fn git_create_worktree(
    cache_path: String,
    project_id: String,
    project_path: String,
    thread_id: String,
    title: String,
) -> Result<CreatedWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = canonical_dir(&project_path, "项目目录")?;
        ensure_repo(&project)?;
        let root = managed_root(&cache_path, &project_id, &project)?;
        let thread = safe_component(&thread_id, "会话 ID")?;
        let path = root.join(thread);
        if path.exists() {
            return Err("该会话的 worktree 已存在".to_string());
        }
        let branch = branch_name(&thread_id, &title)?;
        let args = vec![
            "-C".to_string(),
            project.to_string_lossy().into_owned(),
            "worktree".to_string(),
            "add".to_string(),
            "-b".to_string(),
            branch.clone(),
            path.to_string_lossy().into_owned(),
            "HEAD".to_string(),
        ];
        let result = run_git_ok(&args)?;
        let canonical = validate_managed_path(&root, &path)?;
        Ok(CreatedWorktree {
            path: canonical.to_string_lossy().into_owned(),
            branch,
            result,
        })
    })
    .await
    .map_err(|error| format!("创建 worktree 失败：{error}"))?
}

/// 移除一个会话的 worktree（开发者 Jan）。
///
/// 移除前先看该 worktree 是否干净：有未提交改动且未显式 force 时拒绝执行，
/// 避免把用户还没保存的工作一起删掉。
/// 目标路径必须先经托管路径校验，确保只删应用自己管理的那份目录。
#[tauri::command]
pub async fn git_remove_worktree(
    cache_path: String,
    project_id: String,
    project_path: String,
    worktree_path: String,
    force: bool,
) -> Result<GitCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = canonical_dir(&project_path, "项目目录")?;
        ensure_repo(&project)?;
        let root = managed_root(&cache_path, &project_id, &project)?;
        let worktree = validate_managed_path(&root, Path::new(&worktree_path))?;
        let info = repository_info(&worktree)?;
        if !info.clean && !force {
            return Err("worktree 存在未提交改动，需要显式确认后才能强制移除".to_string());
        }
        let mut args = repo_args(&project, &["worktree", "remove"]);
        if force {
            args.push("--force".to_string());
        }
        args.push(worktree.to_string_lossy().into_owned());
        run_git_ok(&args)
    })
    .await
    .map_err(|error| format!("移除 worktree 失败：{error}"))?
}

/// 校验「交付操作」的目标工作区（开发者 Jan），返回规范化路径。
///
/// 允许两种目标：项目主目录本身，或本项目在缓存目录下的某个 worktree。
/// 二者之外一律拒绝——暂存 / 提交 / 推送都会改仓库状态，
/// 必须确保操作对象是用户自己选中的那个工作区。
fn validate_delivery_workspace(
    project_path: &str,
    workspace_path: &str,
    cache_path: &str,
    project_id: &str,
) -> Result<PathBuf, String> {
    let project = canonical_dir(project_path, "项目目录")?;
    let workspace = canonical_dir(workspace_path, "工作区")?;
    if workspace == project {
        return Ok(workspace);
    }
    let root = managed_root(cache_path, project_id, &project)?;
    validate_managed_path(&root, &workspace)
}

/// 暂存改动（开发者 Jan）：path 为空或空白表示暂存全部改动。
///
/// 参数后固定跟 `--` 分隔符：让用户传入的路径只被当作路径，
/// 即使它以 `-` 开头也不会被 git 解析成选项。
#[tauri::command]
pub async fn git_stage(
    cache_path: String,
    project_id: String,
    project_path: String,
    workspace_path: String,
    path: Option<String>,
) -> Result<GitCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace =
            validate_delivery_workspace(&project_path, &workspace_path, &cache_path, &project_id)?;
        let mut args = repo_args(&workspace, &["add", "--"]);
        args.push(
            path.filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| ".".to_string()),
        );
        run_git_ok(&args)
    })
    .await
    .map_err(|error| format!("暂存失败：{error}"))?
}

/// 取消暂存（开发者 Jan）：把文件从索引退回工作区，改动本身不丢；
/// path 为空或空白表示全部取消。与暂存同理，路径前固定加 `--` 分隔符。
#[tauri::command]
pub async fn git_unstage(
    cache_path: String,
    project_id: String,
    project_path: String,
    workspace_path: String,
    path: Option<String>,
) -> Result<GitCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace =
            validate_delivery_workspace(&project_path, &workspace_path, &cache_path, &project_id)?;
        let mut args = repo_args(&workspace, &["restore", "--staged", "--"]);
        args.push(
            path.filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| ".".to_string()),
        );
        run_git_ok(&args)
    })
    .await
    .map_err(|error| format!("取消暂存失败：{error}"))?
}

/// 提交已暂存的改动（开发者 Jan）。
///
/// 提交信息由用户显式填写，这里只做非空校验——空提交信息在 git 里会被直接拒绝，
/// 提前拦下能给出更明确的中文提示。
#[tauri::command]
pub async fn git_commit(
    cache_path: String,
    project_id: String,
    project_path: String,
    workspace_path: String,
    message: String,
) -> Result<GitCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let message = message.trim();
        if message.is_empty() {
            return Err("提交信息不能为空".to_string());
        }
        let workspace =
            validate_delivery_workspace(&project_path, &workspace_path, &cache_path, &project_id)?;
        let args = repo_args(&workspace, &["commit", "-m", message]);
        run_git_ok(&args)
    })
    .await
    .map_err(|error| format!("提交失败：{error}"))?
}

/// 推送当前分支（开发者 Jan）。
///
/// 先取当前分支名：detached HEAD 下没有分支可推，直接报错说明原因。
/// 再经 reject_protected_push 挡掉 main / master。
/// 已有 upstream 时直接 push；没有则用 --set-upstream origin 建立跟踪关系，
/// 这样用户下次推送不必再手动指定远端。
#[tauri::command]
pub async fn git_push(
    cache_path: String,
    project_id: String,
    project_path: String,
    workspace_path: String,
) -> Result<GitCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace =
            validate_delivery_workspace(&project_path, &workspace_path, &cache_path, &project_id)?;
        let branch = git_value(&workspace, &["branch", "--show-current"])
            .ok_or_else(|| "当前处于 detached HEAD，无法推送".to_string())?;
        reject_protected_push(&branch)?;
        let args = if git_value(
            &workspace,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .is_some()
        {
            repo_args(&workspace, &["push"])
        } else {
            repo_args(&workspace, &["push", "--set-upstream", "origin", &branch])
        };
        run_git_ok(&args)
    })
    .await
    .map_err(|error| format!("推送失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_branch_names_and_rejects_injection() {
        assert!(validate_ref("octopuses/thread-123-safe-title").is_ok());
        for value in [
            "--upload-pack=evil",
            "main lock",
            "x;touch-pwned",
            "x..y",
            "x@{1}",
            "x.lock",
        ] {
            assert!(validate_ref(value).is_err(), "应拒绝 {value}");
        }
    }

    #[test]
    fn generated_branch_is_safe_and_bounded() {
        let branch =
            branch_name("thread_1234567890", "修复 Git; $(touch pwned)").expect("生成分支失败");
        assert!(branch.starts_with("octopuses/thread-123"));
        assert!(validate_ref(&branch).is_ok());
        assert!(!branch.contains(';'));
        assert!(!branch.contains('$'));
    }

    #[test]
    fn managed_root_stays_under_cache() {
        let cache = std::env::temp_dir().join(format!("octopuses-git-test-{}", std::process::id()));
        let project = cache.join("project");
        fs::create_dir_all(&project).expect("创建测试目录失败");
        let root = managed_root(cache.to_string_lossy().as_ref(), "project_1", &project)
            .expect("创建管理目录失败");
        assert!(root.starts_with(fs::canonicalize(&cache).expect("规范化缓存目录失败")));
        assert!(root.to_string_lossy().contains("worktrees/project_1-"));
        fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn rejects_main_and_master_push() {
        assert!(reject_protected_push("main").is_err());
        assert!(reject_protected_push("master").is_err());
        assert!(reject_protected_push("octopuses/task").is_ok());
    }

    #[test]
    fn command_arguments_remain_separate() {
        let args = repo_args(
            Path::new("/tmp/project;touch-pwned"),
            &["add", "--", "a;rm -rf x"],
        );
        assert_eq!(
            args,
            vec!["-C", "/tmp/project;touch-pwned", "add", "--", "a;rm -rf x"]
        );
    }

    #[test]
    fn parses_worktree_porcelain() {
        let items = parse_worktrees("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/task\nHEAD def\nbranch refs/heads/octopuses/task\nlocked reason\n");
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].branch.as_deref(), Some("octopuses/task"));
        assert!(items[1].locked);
    }
}
