//! 应用内更新只信任编译时固定的 Minisign 公钥，不接受服务端下发替代公钥。
use minisign_verify::{PublicKey, Signature};

pub(crate) fn trusted_key() -> Result<PublicKey, String> {
    let encoded = option_env!("OCTOPUSES_UPDATE_PUBLIC_KEY")
        .filter(|value| !value.trim().is_empty())
        .ok_or("此发行包未配置更新验签公钥，不能执行应用内更新")?;
    PublicKey::from_base64(encoded.trim()).map_err(|_| "更新公钥格式无效".to_string())
}

/// 签名与安装包同路径，保留下载鉴权查询参数；拒绝非 HTTPS 或带账号的 URL。
pub(crate) fn signature_url(raw: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(raw).map_err(|_| "更新地址无效")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("更新地址必须是 HTTPS 且不能包含账号或片段".to_string());
    }
    url.set_path(&format!("{}.minisig", url.path()));
    Ok(url)
}

pub(crate) async fn fetch_signature(raw: &str) -> Result<Signature, String> {
    let url = signature_url(raw)?;
    let mut response = reqwest::Client::builder()
        .https_only(true)
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "无法创建签名下载连接")?
        .get(url)
        .send()
        .await
        .map_err(|_| "无法下载更新签名")?
        .error_for_status()
        .map_err(|_| "更新签名下载失败")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "签名下载中断")? {
        if bytes.len() + chunk.len() > 16384 {
            return Err("更新签名超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "签名编码无效")?;
    Signature::decode(text).map_err(|_| "更新签名格式无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    // 上游公开测试向量，不包含私钥：minisign-verify 0.2.5 文档。
    const KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIG: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

    #[test]
    fn authentic_file_passes_and_modified_file_fails() {
        let key = PublicKey::from_base64(KEY).unwrap();
        let signature = Signature::decode(SIG).unwrap();
        let mut verifier = key.verify_stream(&signature).unwrap();
        verifier.update(b"te");
        verifier.update(b"st");
        assert!(verifier.finalize().is_ok());
        assert!(key.verify(b"tampered", &signature, false).is_err());
        assert!(Signature::decode("invalid").is_err());
    }

    #[test]
    fn signature_location_requires_secure_url() {
        assert_eq!(
            signature_url("https://example.com/setup.exe?token=x")
                .unwrap()
                .as_str(),
            "https://example.com/setup.exe.minisig?token=x"
        );
        for url in [
            "http://example.com/a",
            "file:///a",
            "https://user:pass@example.com/a",
            "https://example.com/a#x",
        ] {
            assert!(signature_url(url).is_err());
        }
    }
}
