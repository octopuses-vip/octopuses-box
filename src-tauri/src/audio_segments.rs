//! Decode long recordings incrementally and retain only one bounded PCM segment in memory.
use crate::{
    audio::upload_audio,
    audio_source::{open_source, NativeAudioFile},
    model_proxy::{ModelFetchResult, ModelProxyState},
};
use reqwest::multipart::Part;
use serde::Serialize;
use std::{
    collections::HashMap,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error,
    formats::FormatOptions,
    io::{MediaSource, MediaSourceStream},
    probe::Hint,
};
use tauri::Manager;

const MAX_SEGMENT_BYTES: usize = 20 * 1024 * 1024;

pub(crate) struct PreparedAudio {
    // Dropping the session removes all parts on success, failure, cancellation or app exit.
    directory: tempfile::TempDir,
    parts: Vec<PathBuf>,
}

#[derive(Default)]
pub struct AudioSegmentsState(Mutex<HashMap<String, PreparedAudio>>);

#[derive(Serialize)]
pub struct PreparedAudioInfo {
    id: String,
    count: usize,
}

/// Write independent PCM WAV files so every upload has valid container metadata.
fn wav_bytes(samples: &[i16], rate: u32) -> Vec<u8> {
    let size = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + size as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + size).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&size.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

/// Prefer a quiet quarter-second in the last ten seconds without removing or duplicating samples.
fn split_position(samples: &[i16], rate: usize) -> usize {
    let window = (rate / 4).max(1);
    let start = samples.len().saturating_sub(rate * 10);
    let quiet = samples[start..]
        .chunks_exact(window)
        .enumerate()
        .map(|(index, block)| {
            let energy: u64 = block
                .iter()
                .map(|x| i64::from(*x).unsigned_abs().pow(2))
                .sum();
            (
                energy / block.len() as u64,
                start + index * window + window / 2,
            )
        })
        .min_by_key(|(energy, _)| *energy);
    match quiet {
        Some((energy, at)) if energy < 200 * 200 && at > 0 => at,
        _ => samples.len(),
    }
}

/// Publish one complete chunk to a private temporary directory and retain the unconsumed tail.
fn flush_part(
    prepared: &mut PreparedAudio,
    samples: &mut Vec<i16>,
    rate: u32,
    end: usize,
) -> Result<(), String> {
    let path = prepared
        .directory
        .path()
        .join(format!("part-{:04}.wav", prepared.parts.len() + 1));
    let mut file = std::fs::File::create(&path).map_err(|_| "无法创建音频临时分段")?;
    file.write_all(&wav_bytes(&samples[..end], rate))
        .map_err(|_| "无法写入音频临时分段，请检查磁盘空间")?;
    prepared.parts.push(path);
    samples.drain(..end);
    Ok(())
}

/// Decode packets one at a time; preserve the source rate while mixing channels into mono PCM16.
fn prepare_audio(
    filename: &str,
    source: Box<dyn MediaSource>,
    cancelled: &AtomicBool,
) -> Result<PreparedAudio, String> {
    let mut hint = Hint::new();
    if let Some(extension) = filename.rsplit('.').next() {
        hint.with_extension(extension);
    }
    let source = MediaSourceStream::new(source, Default::default());
    let options = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let probed = symphonia::default::get_probe()
        .format(&hint, source, &options, &Default::default())
        .map_err(|_| {
            "无法读取此音频。大文件自动分段支持 MP3、WAV、M4A/AAC、FLAC、OGG/Vorbis；请检查录音格式"
        })?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| {
            track.codec_params.codec != CODEC_TYPE_NULL
                && symphonia::default::get_codecs()
                    .make(&track.codec_params, &DecoderOptions::default())
                    .is_ok()
        })
        .ok_or("此音频编码暂不支持本地分段，请转换为 MP3 或 WAV 后重试")?;
    let id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &Default::default())
        .map_err(|_| "无法解码音频，请转换为 MP3 或 WAV 后重试")?;
    let mut prepared = PreparedAudio {
        directory: tempfile::tempdir().map_err(|_| "无法创建音频临时目录")?,
        parts: Vec::new(),
    };
    let mut samples = Vec::new();
    let mut source_rate = 0;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("音频转写已取消".into());
        }
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                break
            }
            Err(_) => return Err("音频读取中断，未提交不完整的录音".into()),
        };
        if packet.track_id() != id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|_| "音频解码失败，请检查录音是否损坏")?;
        let spec = *decoded.spec();
        let channels = spec.channels.count();
        if !(8_000..=192_000).contains(&spec.rate) || channels == 0 || channels > 32 {
            return Err("音频采样率或声道数不受支持，请转换为标准 MP3 或 WAV".into());
        }
        if source_rate != 0 && source_rate != spec.rate {
            return Err("录音中途改变采样率，无法完整分段".into());
        }
        source_rate = spec.rate;
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        let limit = (source_rate as usize * 300).min((MAX_SEGMENT_BYTES - 44) / 2);
        for frame in buffer.samples().chunks_exact(channels) {
            let mono = (frame.iter().sum::<f32>() / channels as f32).clamp(-1.0, 1.0);
            samples.push((mono * 32767.0).round() as i16);
            if samples.len() >= limit {
                let end = split_position(&samples, source_rate as usize);
                flush_part(&mut prepared, &mut samples, source_rate, end)?;
            }
        }
    }
    if !samples.is_empty() {
        let end = samples.len();
        flush_part(&mut prepared, &mut samples, source_rate, end)?;
    }
    if prepared.parts.is_empty() {
        return Err("录音中没有可读取的音频".into());
    }
    Ok(prepared)
}

/// Register cancellation before decoding, then retain only opaque identifiers for the frontend.
#[tauri::command]
pub async fn audio_prepare(
    app: tauri::AppHandle,
    request_id: String,
    source: NativeAudioFile,
    on_ready: tauri::ipc::Channel<()>,
) -> Result<PreparedAudioInfo, String> {
    let mut cancel = app.state::<ModelProxyState>().begin(&request_id);
    let _ = on_ready.send(());
    let stopped = Arc::new(AtomicBool::new(false));
    let worker_stop = stopped.clone();
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        let file = open_source(&source)?;
        let prepared = prepare_audio(&source.name, Box::new(file), &worker_stop)?;
        // Detect replacement/modification during decoding before any network upload.
        open_source(&source)?;
        Ok(prepared)
    });
    let outcome = tokio::select! {
        biased;
        _ = &mut cancel => {
            stopped.store(true, Ordering::Relaxed);
            let _ = task.await;
            Err("音频转写已取消".to_string())
        },
        result = &mut task => result.map_err(|_| "本地音频分段失败".to_string()).and_then(|result| result),
    };
    app.state::<ModelProxyState>().finish(&request_id);
    let prepared = outcome?;
    let count = prepared.parts.len();
    app.state::<AudioSegmentsState>()
        .0
        .lock()
        .map_err(|_| "音频分段状态不可用")?
        .insert(request_id.clone(), prepared);
    Ok(PreparedAudioInfo {
        id: request_id,
        count,
    })
}

/// Read only a generated segment from a live session, never an arbitrary frontend-supplied path.
#[tauri::command]
pub async fn audio_transcribe_segment(
    app: tauri::AppHandle,
    request_id: String,
    url: String,
    key: String,
    model: String,
    prepared_id: String,
    index: usize,
    on_ready: tauri::ipc::Channel<()>,
) -> Result<ModelFetchResult, String> {
    let path = app
        .state::<AudioSegmentsState>()
        .0
        .lock()
        .map_err(|_| "音频分段状态不可用")?
        .get(&prepared_id)
        .and_then(|prepared| prepared.parts.get(index))
        .cloned()
        .ok_or("音频分段已清理或序号无效，请重新选择录音")?;
    let state = app.state::<ModelProxyState>();
    let cancel = state.begin(&request_id);
    let _ = on_ready.send(());
    let result = async {
        if tokio::fs::metadata(&path)
            .await
            .map_err(|_| "无法读取音频分段")?
            .len()
            > MAX_SEGMENT_BYTES as u64
        {
            return Err("音频分段超出大小上限".into());
        }
        let part = Part::file(path)
            .await
            .map_err(|_| "无法读取音频分段")?
            .file_name(format!("part-{}.wav", index + 1))
            .mime_str("audio/wav")
            .map_err(|_| "音频类型无效")?;
        upload_audio(&url, &key, model, part, cancel).await
    }
    .await;
    state.finish(&request_id);
    result
}

/// Release temporary recordings even if a later segment fails or the user cancels.
#[tauri::command]
pub fn audio_release(app: tauri::AppHandle, prepared_id: String) -> Result<(), String> {
    app.state::<AudioSegmentsState>()
        .0
        .lock()
        .map_err(|_| "音频分段状态不可用")?
        .remove(&prepared_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prepare_test_audio(
        name: &str,
        bytes: Vec<u8>,
        cancelled: &AtomicBool,
    ) -> Result<PreparedAudio, String> {
        prepare_audio(name, Box::new(std::io::Cursor::new(bytes)), cancelled)
    }

    #[test]
    fn native_large_file_reads_a_bounded_prefix_and_can_cancel() {
        use std::io::{Read, Seek, SeekFrom};
        use std::sync::atomic::AtomicUsize;
        struct CountedFile {
            file: std::fs::File,
            count: Arc<AtomicUsize>,
            cancel: Arc<AtomicBool>,
        }
        impl Read for CountedFile {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let n = self.file.read(buffer)?;
                if self.count.fetch_add(n, Ordering::Relaxed) + n >= 65_536 {
                    self.cancel.store(true, Ordering::Relaxed);
                }
                Ok(n)
            }
        }
        impl Seek for CountedFile {
            fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
                self.file.seek(pos)
            }
        }
        impl MediaSource for CountedFile {
            fn is_seekable(&self) -> bool {
                true
            }
            fn byte_len(&self) -> Option<u64> {
                self.file.metadata().ok().map(|metadata| metadata.len())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.wav");
        let size = 300 * 1024 * 1024u32;
        let mut header = wav_bytes(&[], 16_000);
        header[4..8].copy_from_slice(&(size + 36).to_le_bytes());
        header[40..44].copy_from_slice(&size.to_le_bytes());
        std::fs::write(&path, header).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(size as u64 + 44)
            .unwrap();
        let descriptor =
            crate::audio_source::audio_inspect(path.to_string_lossy().into_owned(), None).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let cancel = Arc::new(AtomicBool::new(false));
        let input = CountedFile {
            file: open_source(&descriptor).unwrap(),
            count: count.clone(),
            cancel: cancel.clone(),
        };
        assert!(prepare_audio("large.wav", Box::new(input), &cancel)
            .err()
            .unwrap()
            .contains("取消"));
        assert!(count.load(Ordering::Relaxed) < 1024 * 1024);
    }

    #[test]
    fn oversized_mp3_decodes_and_splits_without_truncation() {
        // A generated 440 Hz sine tone, encoded with lamejs; contains no recorded speech.
        let tone = include_bytes!("../../tests/fixtures/tone.mp3");
        let baseline =
            prepare_test_audio("tone.mp3", tone.to_vec(), &AtomicBool::new(false)).unwrap();
        let frames_per_tone: usize = baseline
            .parts
            .iter()
            .map(|path| (std::fs::metadata(path).unwrap().len() as usize - 44) / 2)
            .sum();
        let copies = (26 * 1024 * 1024usize).div_ceil(tone.len());
        let input = tone.repeat(copies);
        assert!(input.len() > 25 * 1024 * 1024);
        let prepared = prepare_test_audio("interview.mp3", input, &AtomicBool::new(false)).unwrap();
        assert!(prepared.parts.len() > 1);
        let mut frames = 0;
        for path in &prepared.parts {
            let size = std::fs::metadata(path).unwrap().len() as usize;
            assert!(size <= MAX_SEGMENT_BYTES);
            frames += (size - 44) / 2;
        }
        assert_eq!(frames, frames_per_tone * copies);
    }

    #[test]
    fn oversized_wav_splits_into_decodable_parts_with_every_sample_preserved() {
        let rate = 44_100u32;
        let frames = 14 * 1024 * 1024; // 28 MiB mono PCM, above the old 25 MiB rejection.
        let samples: Vec<i16> = (0..frames).map(|i| ((i % 16_000) as i16) - 8_000).collect();
        let input = wav_bytes(&samples, rate);
        assert!(input.len() > 25 * 1024 * 1024);
        let prepared = prepare_test_audio("long.wav", input, &AtomicBool::new(false)).unwrap();
        assert!(prepared.parts.len() > 1);
        let mut output = Vec::new();
        for path in &prepared.parts {
            let bytes = std::fs::read(path).unwrap();
            assert!(bytes.len() <= MAX_SEGMENT_BYTES);
            assert_eq!(&bytes[..4], b"RIFF");
            assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), rate);
            output.extend(
                bytes[44..]
                    .chunks_exact(2)
                    .map(|value| i16::from_le_bytes(value.try_into().unwrap())),
            );
            // Verify a service can decode each segment independently, with valid header sizes.
            let again = prepare_test_audio("part.wav", bytes, &AtomicBool::new(false)).unwrap();
            assert!(!again.parts.is_empty());
        }
        assert_eq!(output.len(), samples.len());
        assert!(output
            .iter()
            .zip(&samples)
            .all(|(actual, expected)| (i32::from(*actual) - i32::from(*expected)).abs() <= 1));
        let directory = prepared.directory.path().to_path_buf();
        drop(prepared);
        assert!(!directory.exists());
    }

    #[test]
    fn splitting_cancels_and_rejects_corrupt_audio_without_skipping_packets() {
        let samples = vec![20; 8_000];
        assert!(prepare_test_audio(
            "cancel.wav",
            wav_bytes(&samples, 8_000),
            &AtomicBool::new(true)
        )
        .err()
        .unwrap()
        .contains("取消"));
        assert!(
            prepare_test_audio("broken.mp3", b"not audio".to_vec(), &AtomicBool::new(false))
                .is_err()
        );
    }

    #[test]
    fn prefers_silence_and_keeps_quiet_splitting_positions_inside_the_buffer() {
        let mut samples = vec![1000; 16_000 * 15];
        samples[16_000 * 12..16_000 * 13].fill(0);
        let at = split_position(&samples, 16_000);
        assert!((16_000 * 12..16_000 * 13).contains(&at));
        assert_eq!(split_position(&[3000; 1000], 8_000), 1000);
    }
}
