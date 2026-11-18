//! Multipart audio uploads use the native model connection, never a temporary file or a log dump.
use crate::{client_api::client_for, model_proxy::ModelFetchResult};
use futures::{channel::oneshot, StreamExt};
use reqwest::multipart::{Form, Part};
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Keep cancellation active while sending AND reading the response, including stalled response bodies.
pub(crate) async fn upload_audio(
    url: &str,
    key: &str,
    model: String,
    part: Part,
    mut cancel: oneshot::Receiver<()>,
) -> Result<ModelFetchResult, String> {
    let address = reqwest::Url::parse(url).map_err(|_| "音频服务地址无效")?;
    if !matches!(address.scheme(), "http" | "https") || address.host_str().is_none() {
        return Err("音频服务需要 HTTP(S) 地址".into());
    }
    if model.trim().is_empty() {
        return Err("尚未选择音频转文字模型".into());
    }
    let form = Form::new()
        .text("model", model)
        .text("response_format", "json")
        .part("file", part);
    let mut request = client_for(url)
        .post(address)
        .timeout(Duration::from_secs(600))
        .multipart(form);
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let upload = async {
        let response = request.send().await.map_err(|_| "无法连接音频转写服务")?;
        let status = response.status().as_u16();
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "读取音频转写结果失败")?;
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("音频转写结果超过大小上限".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(ModelFetchResult {
            status,
            body: String::from_utf8_lossy(&bytes).into_owned(),
            aborted: false,
        })
    };
    tokio::select! {
        biased;
        _ = &mut cancel => Ok(ModelFetchResult { status: 0, body: String::new(), aborted: true }),
        result = upload => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    async fn read_request(socket: &mut TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        loop {
            let n = socket.read(&mut chunk).await.unwrap();
            assert_ne!(n, 0);
            request.extend_from_slice(&chunk[..n]);
            if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&request[..end]).to_lowercase();
                let length: usize = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                if request.len() >= end + 4 + length {
                    return request;
                }
            }
        }
    }

    #[tokio::test]
    async fn native_upload_sends_multipart_audio_and_preserves_http_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/v1/audio/transcriptions",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            for status in [200, 429] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                let readable = String::from_utf8_lossy(&request);
                assert!(readable.starts_with("POST /v1/audio/transcriptions HTTP/1.1"));
                assert!(readable.contains("multipart/form-data; boundary="));
                assert!(readable.contains("authorization: Bearer test-token"));
                assert!(readable.contains("name=\"model\"\r\n\r\nasr-model"));
                assert!(readable.contains("name=\"response_format\"\r\n\r\njson"));
                assert!(readable.contains("filename=\"clip.wav\""));
                assert!(readable.contains("Content-Type: audio/wav"));
                assert!(!readable.contains("private-folder"));
                assert!(request.windows(3).any(|part| part == [0, 255, 65]));
                let body = if status == 200 {
                    "{\"text\":\"你好\"}"
                } else {
                    "{\"error\":\"quota\"}"
                };
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        for status in [200, 429] {
            let (_sender, cancel) = oneshot::channel();
            let part = Part::bytes(vec![0, 255, 65])
                .file_name("clip.wav")
                .mime_str("audio/wav")
                .unwrap();
            let result = upload_audio(&url, "test-token", "asr-model".into(), part, cancel)
                .await
                .unwrap();
            assert_eq!(result.status, status);
            assert!(!result.aborted);
            if status == 200 {
                assert_eq!(result.body, "{\"text\":\"你好\"}");
            }
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/audio/transcriptions",
            listener.local_addr().unwrap()
        );
        let (ready, headers_sent) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                .await
                .unwrap();
            ready.send(()).unwrap();
            let mut remaining = Vec::new();
            socket.read_to_end(&mut remaining).await.unwrap();
        });
        let (stop, cancel) = oneshot::channel();
        let task = tokio::spawn(async move {
            upload_audio(
                &url,
                "",
                "asr".into(),
                Part::bytes(b"abc".to_vec())
                    .file_name("clip.wav")
                    .mime_str("audio/wav")
                    .unwrap(),
                cancel,
            )
            .await
        });
        headers_sent.await.unwrap();
        stop.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(result.aborted);
        assert_eq!(result.status, 0);
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn native_response_is_bounded_even_without_content_length() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/audio/transcriptions",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            let _ = socket.write_all(&vec![b'x'; MAX_RESPONSE_BYTES + 1]).await;
        });
        let (_sender, cancel) = oneshot::channel();
        let result = upload_audio(
            &url,
            "",
            "asr".into(),
            Part::bytes(b"abc".to_vec())
                .file_name("clip.mp3")
                .mime_str("audio/mpeg")
                .unwrap(),
            cancel,
        )
        .await;
        assert!(result.err().unwrap().contains("大小上限"));
        server.await.unwrap();
    }
}
