//! Stream a completed generation directly to a local MP4. The signed URL needs no gateway credential.
use crate::{cache::artifact_path, client_api::client_for};
use futures::StreamExt;
use std::{io::Read, path::Path, time::Duration};
use tokio::io::AsyncWriteExt;

/// ISO base media files identify their container in the first box.
fn is_mp4(header: &[u8]) -> bool {
    header.len() >= 12 && &header[4..8] == b"ftyp"
}

/// Download into an unlisted staging directory on the destination filesystem and publish atomically.
#[tauri::command]
pub async fn video_download(dir: String, name: String, url: String) -> Result<(), String> {
    let root = Path::new(&dir);
    let target = artifact_path(root, &name)?;
    if !name.starts_with("video-") || !name.ends_with(".mp4") {
        return Err("视频文件名无效".into());
    }
    // The client gives every job a unique deterministic name. Recover after a crash after publication.
    if let Ok(mut file) = std::fs::File::open(&target) {
        let mut header = [0; 12];
        if file.read_exact(&mut header).is_ok() && is_mp4(&header) {
            return Ok(());
        }
        return Err("目标文件已存在".into());
    }
    let address = reqwest::Url::parse(&url).map_err(|_| "视频下载地址无效")?;
    if !matches!(address.scheme(), "http" | "https") {
        return Err("视频地址需要 HTTP(S)".into());
    }
    let response = client_for(&url)
        .get(address)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|_| "无法连接视频下载服务")?;
    if !response.status().is_success() {
        return Err(format!("视频下载失败（HTTP {}）", response.status()));
    }
    let staging = root.join(".video-downloads");
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let staging_file = tempfile::NamedTempFile::new_in(staging).map_err(|e| e.to_string())?;
    let (handle, temporary_path) = staging_file.into_parts();
    let mut file = tokio::fs::File::from_std(handle);
    let expected = response.content_length();
    let mut stream = response.bytes_stream();
    let mut header = Vec::with_capacity(12);
    let mut bytes = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "下载中断")?;
        if header.len() < 12 {
            header.extend_from_slice(&chunk[..chunk.len().min(12 - header.len())]);
            if header.len() == 12 && !is_mp4(&header) {
                return Err("下载内容不是 MP4 视频".into());
            }
        }
        bytes += chunk.len() as u64;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    if !is_mp4(&header) || expected.is_some_and(|n| n != bytes) {
        return Err("视频不完整".into());
    }
    file.flush().await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    temporary_path
        .persist_noclobber(target)
        .map_err(|e| e.error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn native_download_rejects_partial_responses_and_reuses_published_file() {
        let root = tempfile::tempdir().unwrap();
        let body = b"\0\0\0\x18ftypisom\0\0\0\0isommp42";
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/clip.mp4", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for length in [body.len() + 5, body.len()] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                let n = socket.read(&mut request).await.unwrap();
                assert!(!String::from_utf8_lossy(&request[..n])
                    .to_lowercase()
                    .contains("authorization:"));
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                socket.write_all(body).await.unwrap();
            }
        });
        let dir = root.path().to_str().unwrap().to_owned();
        let name = "video-test.mp4".to_owned();
        assert!(video_download(dir.clone(), name.clone(), url.clone())
            .await
            .is_err());
        assert!(!root.path().join(&name).exists());
        assert_eq!(
            std::fs::read_dir(root.path().join(".video-downloads"))
                .unwrap()
                .count(),
            0
        );
        video_download(dir.clone(), name.clone(), url.clone())
            .await
            .unwrap();
        assert_eq!(std::fs::read(root.path().join(&name)).unwrap(), body);
        server.await.unwrap();
        video_download(dir, name, url).await.unwrap();
    }
}
