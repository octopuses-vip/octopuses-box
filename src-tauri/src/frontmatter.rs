//! 聚焦 frontmatter 字符串解析；不是通用 YAML 解析器，不解释标签、锚点或集合。

use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub(crate) struct Frontmatter {
    pub fields: BTreeMap<String, String>,
    pub body: String,
}

/// 解析首个非空行的 frontmatter，仅读取顶层目标字段（开发者 Jan）。
/// 块标量遵循缩进、折叠与 chomping；未知元数据允许为嵌套 YAML。
pub(crate) fn parse(text: &str, keys: &[&str]) -> Result<Frontmatter, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text.lines().collect();
    let Some(start) = lines.iter().position(|line| !line.trim().is_empty()) else {
        return Ok(Frontmatter { body: text.to_string(), ..Default::default() });
    };
    if lines[start].trim_end() != "---" {
        return Ok(Frontmatter { body: text.to_string(), ..Default::default() });
    }
    // 只接受顶格边界，块标量内部缩进的 --- 是正文而非结束符。
    let close = (start + 1..lines.len())
        .find(|&i| matches!(lines[i].trim_end(), "---" | "..."))
        .ok_or_else(|| format!("第 {} 行：frontmatter 缺少结束边界 ---", start + 1))?;
    let mut parsed = Frontmatter {
        body: lines[close + 1..].join("\n"),
        ..Default::default()
    };
    let mut i = start + 1;
    while i < close {
        let line = lines[i];
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            i += 1;
            continue;
        }
        if line.starts_with('\t') {
            return Err(format!("第 {} 行：YAML 缩进不能使用制表符", i + 1));
        }
        if line.starts_with(' ') {
            i += 1; // 未读取的嵌套元数据，不能覆盖顶层字段。
            continue;
        }
        let Some((key, raw)) = line.split_once(':') else {
            return Err(format!("第 {} 行：frontmatter 应为 key: value", i + 1));
        };
        let key = key.trim();
        if !keys.contains(&key) {
            i += 1;
            continue;
        }
        if !raw.is_empty() && !raw.starts_with(char::is_whitespace) {
            return Err(format!("第 {} 行：字段 {key} 的冒号后缺少空白", i + 1));
        }
        let raw = raw.trim();
        let field_line = i + 1;
        let value = if raw.starts_with(['>', '|']) {
            let header = raw.split(" #").next().unwrap().trim_end();
            let mut chomp = ' ';
            let mut indent = None;
            for c in header[1..].chars() {
                match c {
                    '+' | '-' if chomp == ' ' => chomp = c,
                    '1'..='9' if indent.is_none() => indent = c.to_digit(10).map(|n| n as usize),
                    _ => return Err(format!("第 {field_line} 行：字段 {key} 的块标量标记无效")),
                }
            }
            i += 1;
            let begin = i;
            while i < close && (lines[i].trim().is_empty() || lines[i].starts_with(' ')) {
                i += 1;
            }
            let block = &lines[begin..i];
            let indent = indent.unwrap_or_else(|| block.iter()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.bytes().take_while(|b| *b == b' ').count()).unwrap_or(0));
            let mut content = Vec::new();
            for (offset, line) in block.iter().enumerate() {
                if line.trim().is_empty() {
                    content.push("");
                } else if line.bytes().take_while(|b| *b == b' ').count() < indent {
                    return Err(format!("第 {} 行：字段 {key} 的块标量缩进不足", begin + offset + 1));
                } else {
                    content.push(&line[indent..]);
                }
            }
            block_scalar(&content, header.starts_with('>'), chomp)
        } else {
            i += 1;
            if lines[i..close].iter().find(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
                .is_some_and(|line| line.starts_with([' ', '\t'])) {
                return Err(format!("第 {field_line} 行：字段 {key} 的多行字符串请使用 > 或 | 块标量"));
            }
            scalar(raw).map_err(|error| format!("第 {field_line} 行：字段 {key}：{error}"))?
        };
        // 保留既有同名键首次生效的约定。
        parsed.fields.entry(key.to_string()).or_insert(value);
    }
    Ok(parsed)
}

/// 折叠普通文本行，保留空段和更深缩进，再应用 strip / clip / keep（开发者 Jan）。
fn block_scalar(lines: &[&str], folded: bool, chomp: char) -> String {
    let mut value = String::new();
    for (i, line) in lines.iter().enumerate() {
        value.push_str(line);
        let next = lines.get(i + 1).copied();
        if folded && !line.is_empty() && !line.starts_with([' ', '\t'])
            && next.is_some_and(|next| !next.is_empty() && !next.starts_with([' ', '\t'])) {
            value.push(' ');
        } else if folded && line.is_empty()
            && lines[..i].iter().rev().find(|line| !line.is_empty())
                .is_some_and(|previous| !previous.starts_with([' ', '\t']))
            && next.is_some_and(|next| !next.is_empty() && !next.starts_with([' ', '\t'])) {
            // 普通段落之间 N 个空行变成 N 个换行。
        } else {
            value.push('\n');
        }
    }
    if chomp != '+' {
        let end = value.trim_end_matches('\n').len();
        value.truncate(end);
        if chomp != '-' && lines.iter().any(|line| !line.is_empty()) {
            value.push('\n');
        }
    }
    value
}

/// 解码单行字符串，拒绝无法可靠解释的 YAML 语法（开发者 Jan）。
fn scalar(raw: &str) -> Result<String, String> {
    if raw.starts_with('"') {
        // JSON 字符串是 YAML 双引号标量的兼容子集；额外 YAML 转义显式报错。
        let mut stream = serde_json::Deserializer::from_str(raw).into_iter::<String>();
        let value = stream.next().ok_or("缺少双引号字符串")?
            .map_err(|error| format!("双引号字符串无效（支持 JSON 转义）：{error}"))?;
        let tail = raw[stream.byte_offset()..].trim();
        if !tail.is_empty() && !tail.starts_with('#') {
            return Err("引号结束后存在非注释内容".into());
        }
        return Ok(value);
    }
    if let Some(rest) = raw.strip_prefix('\'') {
        let mut chars = rest.chars().peekable();
        let mut value = String::new();
        while let Some(c) = chars.next() {
            if c == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                    value.push('\'');
                } else {
                    let tail: String = chars.collect();
                    if !tail.trim().is_empty() && !tail.trim_start().starts_with('#') {
                        return Err("引号结束后存在非注释内容".into());
                    }
                    return Ok(value);
                }
            } else {
                value.push(c);
            }
        }
        return Err("单引号字符串未闭合".into());
    }
    if raw.starts_with(['[', '{', '&', '!', '*']) && raw != "*" {
        return Err("目标字段只支持字符串，不支持集合、锚点或标签".into());
    }
    let value = raw.split(" #").next().unwrap().trim_end();
    if value.contains(": ") {
        return Err("包含冒号与空白的字符串必须加引号".into());
    }
    Ok(if value.starts_with('#') { "" } else { value }.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn description(source: &str) -> String {
        parse(source, &["description"]).unwrap().fields.remove("description").unwrap()
    }

    #[test]
    fn block_styles_and_chomping() {
        for (style, expected) in [(">", "first second\n"), (">-", "first second"),
            (">+", "first second\n\n"), ("|", "first\nsecond\n"),
            ("|-", "first\nsecond"), ("|+", "first\nsecond\n\n")] {
            assert_eq!(description(&format!("---\ndescription: {style}\n  first\n  second\n\n---\nbody")), expected, "{style}");
        }
    }

    #[test]
    fn folding_paragraphs_indentation_and_boundaries() {
        assert_eq!(description("---\ndescription: >-\n  first\n\n  second\n\n\n  third\n    code\n  last\n  ---\n---\n"), "first\nsecond\n\nthird\n  code\nlast ---");
        assert_eq!(description("\u{feff}\r\n---\r\ndescription: |2- # comment\r\n  \"quoted\"\r\n    code\r\n...\r\nbody"), "\"quoted\"\n  code");
    }

    #[test]
    fn quotes_nested_metadata_and_missing_frontmatter() {
        assert_eq!(description("---\nmetadata:\n  description: ignored\ndescription: 'it''s # text' # comment\n---"), "it's # text");
        assert_eq!(description("---\ndescription: \"line\\n\\\"quoted\\\"\" # comment\n---"), "line\n\"quoted\"");
        let parsed = parse("# body\ndescription: ignored", &["description"]).unwrap();
        assert!(parsed.fields.is_empty());
        assert_eq!(parsed.body, "# body\ndescription: ignored");
    }

    #[test]
    fn empty_blocks_explicit_indent_and_duplicate_keys() {
        for style in [">", ">-", ">+", "|", "|-", "|+"] {
            assert_eq!(description(&format!("---\ndescription: {style}\n---")), "");
        }
        assert_eq!(description("---\ndescription: >2-\n  first\n  second\ndescription: ignored\n---"), "first second");
        assert_eq!(description("---\ndescription: |+\n\n\n---"), "\n\n");
        assert_eq!(description("---\ndescription: >-\n\n  first\n\n  second\n---"), "\nfirst\nsecond");
    }

    #[test]
    fn invalid_frontmatter_reports_line_and_field() {
        for source in ["---\ndescription: >wat\n---", "---\ndescription: 'broken\n---",
            "---\ndescription: >-\n    first\n  bad\n---", "---\ndescription: [not, string]\n---"] {
            let error = parse(source, &["description"]).unwrap_err();
            assert!(error.contains("description"), "{error}");
            assert!(error.contains("行"), "{error}");
        }
        assert!(parse("---\ndescription: missing", &["description"]).unwrap_err().contains("边界"));
    }
}
