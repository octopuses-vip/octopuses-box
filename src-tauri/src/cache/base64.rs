

/// base64 标准字母表
pub(super) const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 把字节编码成标准 base64（带 `=` 填充）
///
/// 前端从图像接口拿到的就是 base64，产物落盘时直接透传给后端解码；读取方向同样回 base64，
/// 两端对称，避免为一条二进制通道引入额外依赖。
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or(0) as u32;
        let third = chunk.get(2).copied().unwrap_or(0) as u32;
        let merged = (first << 16) | (second << 8) | third;
        out.push(BASE64_ALPHABET[(merged >> 18) as usize & 0x3f] as char);
        out.push(BASE64_ALPHABET[(merged >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(merged >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[merged as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

/// 解码标准 base64：容忍换行与空白，非法字符或长度错误返回 Err
pub(crate) fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    /// 单个 base64 字符的 6 位取值
    fn sextet(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a') as u32 + 26),
            b'0'..=b'9' => Some((byte - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let bytes: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if bytes.len() % 4 != 0 {
        return Err("base64 长度不是 4 的倍数".to_string());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let mut merged = 0u32;
        let mut padding = 0usize;
        for byte in chunk {
            if *byte == b'=' {
                padding += 1;
                merged <<= 6;
            } else {
                if padding > 0 {
                    return Err("base64 填充位置非法".to_string());
                }
                merged =
                    (merged << 6) | sextet(*byte).ok_or_else(|| "base64 含非法字符".to_string())?;
            }
        }
        out.push((merged >> 16) as u8);
        if padding < 2 {
            out.push((merged >> 8) as u8);
        }
        if padding < 1 {
            out.push(merged as u8);
        }
    }
    Ok(out)
}
