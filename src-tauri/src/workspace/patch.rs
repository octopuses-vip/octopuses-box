//! Unified diff 解析与试算，不执行文件写入。

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PatchLine {
    pub(super) kind: char,
    pub(super) text: String,
}

#[derive(Debug, Clone)]
pub(super) struct Hunk {
    pub(super) old_start: usize,
    pub(super) lines: Vec<PatchLine>,
}

impl Hunk {
    /// 取 hunk 里的旧文件行（开发者 Jan）：`+` 行是新加的，比对旧内容时必须排除。
    fn old_lines(&self) -> Vec<&PatchLine> {
        self.lines.iter().filter(|line| line.kind != '+').collect()
    }

    /// 取 hunk 应用后的新文件行文本（开发者 Jan）：`-` 行是被删掉的，不进结果。
    fn new_texts(&self) -> Vec<String> {
        self.lines
            .iter()
            .filter(|line| line.kind != '-')
            .map(|line| line.text.clone())
            .collect()
    }

    /// 旧侧行数（开发者 Jan）：用于校验 hunk 头部范围、并按差值推算后续 hunk 的位移。
    fn old_count(&self) -> usize {
        self.lines.iter().filter(|line| line.kind != '+').count()
    }

    /// 新侧行数（开发者 Jan）：与 [`Hunk::old_count`] 相减即为该 hunk 造成的行号偏移。
    fn new_count(&self) -> usize {
        self.lines.iter().filter(|line| line.kind != '-').count()
    }
}

#[derive(Debug, Clone)]
pub(super) struct FilePatch {
    pub(super) old_path: Option<String>,
    pub(super) new_path: Option<String>,
    pub(super) hunks: Vec<Hunk>,
}

impl FilePatch {
    /// 该文件块实际要写入的路径（开发者 Jan）：优先新路径，删除型补丁（`+++ /dev/null`）才退回旧路径。
    pub(super) fn target(&self) -> Option<&str> {
        self.new_path.as_deref().or(self.old_path.as_deref())
    }
}

/// 解析 unified diff 文本（开发者 Jan），按文件块分组返回。
///
/// 只认标准三行头：`--- ` 起一个文件块、`+++ ` 补上新路径、`@@` 起一个 hunk。
/// 顺序出错（如 `@@` 出现在 `---` 之前、`+++` 出现在 `---` 之前）都会带行号报错，
/// 因为这类补丁往往是模型生成时漏了上下文，静默容错只会让后续 hunk 匹配得更离谱。
/// 每个文件块既可能是修改，也可能是新建（无 `---`）或删除（`+++ /dev/null`）。
pub(super) fn parse_patch(text: &str) -> Result<Vec<FilePatch>, String> {
    let mut patches = Vec::new();
    let mut current: Option<FilePatch> = None;
    let mut hunk: Option<Hunk> = None;

    for (index, raw) in text.lines().enumerate() {
        let line_no = index + 1;
        if raw.starts_with("@@") {
            let patch = current
                .as_mut()
                .ok_or_else(|| format!("第 {line_no} 行的 @@ 之前缺少文件头"))?;
            if let Some(finished) = hunk.take() {
                patch.hunks.push(finished);
            }
            hunk = Some(Hunk {
                old_start: parse_hunk_header(raw, line_no)?,
                lines: Vec::new(),
            });
            continue;
        }
        if let Some(pending) = hunk.as_mut() {
            if raw.starts_with("--- ") {
                if let Some(finished) = hunk.take() {
                    current.as_mut().expect("存在文件补丁").hunks.push(finished);
                }
            } else {
                if let Some(line) = parse_hunk_line(raw, line_no)? {
                    pending.lines.push(line);
                }
                continue;
            }
        }
        if let Some(rest) = raw.strip_prefix("--- ") {
            if let Some(finished) = current.take() {
                patches.push(finished);
            }
            current = Some(FilePatch {
                old_path: parse_patch_path(rest),
                new_path: None,
                hunks: Vec::new(),
            });
        } else if let Some(rest) = raw.strip_prefix("+++ ") {
            let patch = current
                .as_mut()
                .ok_or_else(|| format!("第 {line_no} 行的 +++ 之前缺少 ---"))?;
            patch.new_path = parse_patch_path(rest);
        }
    }
    if let Some(mut patch) = current {
        if let Some(finished) = hunk {
            patch.hunks.push(finished);
        }
        patches.push(patch);
    }
    Ok(patches)
}

/// 解析 hunk 头部（开发者 Jan），返回旧侧起始行号。
///
/// 形如 `@@ -12,5 +12,7 @@`，这里只取旧侧的起始行号：新侧范围可由
/// [`Hunk::new_count`] 推算，多解析一份反而容易与补丁实际内容不一致。
fn parse_hunk_header(raw: &str, line_no: usize) -> Result<usize, String> {
    let spec = raw
        .trim_start_matches("@@")
        .trim()
        .split("@@")
        .next()
        .unwrap_or("")
        .trim();
    let old = spec
        .split_whitespace()
        .next()
        .ok_or_else(|| format!("第 {line_no} 行 hunk 缺少旧范围"))?;
    old.strip_prefix('-')
        .ok_or_else(|| format!("第 {line_no} 行 hunk 旧范围非法"))?
        .split(',')
        .next()
        .unwrap_or("")
        .parse::<usize>()
        .map_err(|_| format!("第 {line_no} 行 hunk 行号非法：{raw}"))
}

/// 解析 hunk 内的一行内容（开发者 Jan）。
///
/// 首个字符是标记：空格为上下文、`-` 为删除、`+` 为新增；
/// 空行按上下文行处理（补丁里空上下文行的标记常被生成方省掉），
/// 以反斜杠开头的 `\ No newline at end of file` 返回 `None` 表示不参与比对。
fn parse_hunk_line(raw: &str, line_no: usize) -> Result<Option<PatchLine>, String> {
    let mut chars = raw.chars();
    match chars.next() {
        None => Ok(Some(PatchLine {
            kind: ' ',
            text: String::new(),
        })),
        Some('\\') => Ok(None),
        Some(kind @ (' ' | '-' | '+')) => Ok(Some(PatchLine {
            kind,
            text: chars.as_str().to_string(),
        })),
        Some(other) => Err(format!("第 {line_no} 行 hunk 内容前缀非法：{other}")),
    }
}

/// 从补丁头里取出文件路径（开发者 Jan）。
///
/// git 生成的补丁会带 `a/` 或 `b/` 前缀与制表符后的时间戳，这里一并剥掉；
/// `/dev/null` 返回 `None`——它是删除或新建的标记，不代表真实路径。
pub(super) fn parse_patch_path(raw: &str) -> Option<String> {
    let token = raw.split('\t').next().unwrap_or("").trim();
    if token.is_empty() || token == "/dev/null" {
        return None;
    }
    Some(
        token
            .strip_prefix("a/")
            .or_else(|| token.strip_prefix("b/"))
            .unwrap_or(token)
            .to_string(),
    )
}

/// 把一个文件的全部 hunk 依次应用到原内容上（开发者 Jan），返回新内容。
///
/// 每个 hunk 的期望位置都要叠加前面 hunk 造成的行数偏移（offset），否则
/// 一处增删就会让后续 hunk 全部错位。定位失败时给出「请先读取文件后重新生成补丁」
/// 的提示，引导模型重新读取现状而不是硬猜。
/// 末尾换行按原文件风格还原：原文件以换行结尾时结果也补一个，避免产生多余 diff。
pub(super) fn apply_hunks(original: &str, hunks: &[Hunk], shown: &str) -> Result<String, String> {
    let trailing_newline = original.is_empty() || original.ends_with('\n');
    let mut lines: Vec<String> = original.lines().map(str::to_string).collect();
    let mut offset: i64 = 0;
    for (index, hunk) in hunks.iter().enumerate() {
        let pattern = hunk.old_lines();
        let expected = if pattern.is_empty() {
            hunk.old_start as i64 + offset
        } else {
            hunk.old_start as i64 - 1 + offset
        }
        .max(0) as usize;
        let position = locate(&lines, &pattern, expected).ok_or_else(|| {
            format!(
                "{shown}: 第 {} 个 hunk 无法匹配上下文，请先读取文件后重新生成补丁",
                index + 1
            )
        })?;
        lines.splice(position..position + pattern.len(), hunk.new_texts());
        offset += hunk.new_count() as i64 - hunk.old_count() as i64;
    }
    let mut out = lines.join("\n");
    if trailing_newline && !out.is_empty() {
        out.push('\n');
    }
    Ok(out)
}

/// 在文件行里定位某个 hunk 的上下文（开发者 Jan），返回起始下标。
///
/// 上下文可能在文件中重复出现，因此不取首个命中，而是取**离期望行号最近**的那个，
/// 这样同一段代码在文件里出现多次时也能落到正确位置。
/// 纯新增 hunk（没有上下文行）没有可比对的内容，直接按期望行号插入。
fn locate(lines: &[String], pattern: &[&PatchLine], expected: usize) -> Option<usize> {
    if pattern.is_empty() {
        return Some(expected.min(lines.len()));
    }
    let max_start = lines.len().checked_sub(pattern.len())?;
    let mut best: Option<usize> = None;
    for start in 0..=max_start {
        if pattern
            .iter()
            .enumerate()
            .all(|(index, line)| lines[start + index] == line.text)
        {
            match best {
                Some(current) if current.abs_diff(expected) <= start.abs_diff(expected) => {}
                _ => best = Some(start),
            }
        }
    }
    best
}
