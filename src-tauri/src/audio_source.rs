//! Native file selection and bounded clipboard staging keep full recordings out of WebView IPC.
use crate::cache::base64_decode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, io::Write, path::Path, sync::Mutex, time::UNIX_EPOCH};

const STAGE_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioFile {
    kind: String,
    pub(crate) name: String,
    path: String,
    size: u64,
    #[serde(rename = "type")]
    mime: String,
    fingerprint: String,
    content_key: String,
}

struct StagedAudio {
    file: tempfile::NamedTempFile,
    name: String,
    expected: u64,
    written: u64,
    hash: Sha256,
}

#[derive(Default)]
pub struct AudioSourcesState(Mutex<HashMap<String, StagedAudio>>);

/// Recognize containers independently of the particular audio codec inside them.
fn audio_mime(name: &str) -> Result<&'static str, String> {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" | "mpeg" | "mpga" => Ok("audio/mpeg"),
        "mp4" | "m4a" => Ok("audio/mp4"),
        "flac" => Ok("audio/flac"),
        "wav" => Ok("audio/wav"),
        "ogg" => Ok("audio/ogg"),
        "webm" => Ok("audio/webm"),
        _ => Err("不支持此音视频文件格式".into()),
    }
}

/// Metadata fingerprints invalidate checkpoints when the selected file changes in place.
fn describe(path: &Path, name: &str, file: &File) -> Result<NativeAudioFile, String> {
    let meta = file.metadata().map_err(|_| "无法读取音视频文件信息")?;
    if !meta.is_file() || meta.len() == 0 {
        return Err("请选择非空的音视频文件".into());
    }
    let modified = meta
        .modified()
        .map_err(|_| "无法读取文件修改时间")?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let canonical = path
        .canonicalize()
        .map_err(|_| "音视频文件已不存在")?
        .to_string_lossy()
        .into_owned();
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(format!("{canonical}\0{}\0{modified}", meta.len()).as_bytes())
    );
    Ok(NativeAudioFile {
        kind: "nativeAudio".into(),
        name: name.into(),
        path: path.to_string_lossy().into_owned(),
        size: meta.len(),
        mime: audio_mime(name)?.into(),
        content_key: fingerprint.clone(),
        fingerprint,
    })
}

/// Revalidate the descriptor against the open file before and after decoding.
pub fn open_source(source: &NativeAudioFile) -> Result<File, String> {
    let file =
        File::open(&source.path).map_err(|_| "无法打开音视频文件，请检查文件是否仍然存在")?;
    let actual = describe(Path::new(&source.path), &source.name, &file)?;
    if actual.fingerprint != source.fingerprint {
        return Err("音视频文件已改变，请重新选择后再转写".into());
    }
    Ok(file)
}

/// Inspect only filesystem metadata; even multi-gigabyte recordings are not read into memory.
#[tauri::command]
pub fn audio_inspect(path: String, base: Option<String>) -> Result<NativeAudioFile, String> {
    let supplied = Path::new(&path);
    let absolute = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        Path::new(base.as_deref().ok_or("请提供绝对路径或项目目录")?).join(supplied)
    };
    let path = absolute.as_path();
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("音视频文件名无效")?;
    let file = File::open(path).map_err(|_| "无法打开音视频文件")?;
    describe(path, name, &file)
}

/// Persist only a user-selected source in the session cache; never decode, transcribe or upload it.
#[tauri::command]
pub async fn audio_attachment_import(
    cache_path: String,
    source: NativeAudioFile,
) -> Result<NativeAudioFile, String> {
    tauri::async_runtime::spawn_blocking(move || import_attachment(Path::new(&cache_path), &source))
        .await
        .map_err(|_| "保存音视频附件失败".to_string())?
}

/// A private directory prevents collisions; failed copies are removed before a reference is published.
fn import_attachment(root: &Path, source: &NativeAudioFile) -> Result<NativeAudioFile, String> {
    if !root.is_absolute() {
        return Err("缓存目录必须是绝对路径".into());
    }
    let name = &source.name;
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err("音视频文件名无效".into());
    }
    let mut input = open_source(source)?;
    let parent = root.join("sessions/attachments/audio");
    std::fs::create_dir_all(&parent).map_err(|_| "无法创建音视频附件目录")?;
    let directory = tempfile::Builder::new()
        .prefix("audio-")
        .tempdir_in(parent)
        .map_err(|_| "无法创建音视频附件目录")?;
    let path = directory.path().join(name);
    let mut output = File::create_new(&path).map_err(|_| "无法保存音视频附件")?;
    let copied = std::io::copy(&mut input, &mut output)
        .map_err(|_| "音视频附件保存失败，请检查磁盘空间")?;
    open_source(source)?;
    if copied != source.size {
        return Err("音视频文件已改变，请重新添加".into());
    }
    output.sync_all().map_err(|_| "音视频附件写入失败")?;
    let saved = describe(&path, name, &output)?;
    drop(output);
    let _ = directory.keep();
    Ok(saved)
}

/// Browser clipboard Blobs have no path: create a private staged source for bounded chunk transfer.
#[tauri::command]
pub fn audio_stage_create(
    state: tauri::State<AudioSourcesState>,
    id: String,
    name: String,
    size: u64,
) -> Result<(), String> {
    audio_mime(&name)?;
    if size == 0 {
        return Err("录音文件为空".into());
    }
    let mut files = state.0.lock().map_err(|_| "音频导入状态不可用")?;
    if files.contains_key(&id) {
        return Err("此音频导入任务已存在".into());
    }
    files.insert(
        id,
        StagedAudio {
            file: tempfile::NamedTempFile::new().map_err(|_| "无法创建音频临时文件")?,
            name,
            expected: size,
            written: 0,
            hash: Sha256::new(),
        },
    );
    Ok(())
}

/// Offset checks prevent retries or concurrent writes from duplicating/corrupting imported audio.
fn append_stage(staged: &mut StagedAudio, offset: u64, encoded: &str) -> Result<(), String> {
    if encoded.len() > STAGE_CHUNK_BYTES.div_ceil(3) * 4 {
        return Err("音频导入片段超过 1 MB".into());
    }
    let bytes = base64_decode(encoded)?;
    if bytes.is_empty()
        || bytes.len() > STAGE_CHUNK_BYTES
        || offset != staged.written
        || staged.written + bytes.len() as u64 > staged.expected
    {
        return Err("音频导入片段大小或位置无效".into());
    }
    staged
        .file
        .write_all(&bytes)
        .map_err(|_| "音频导入失败，请检查磁盘空间")?;
    staged.hash.update(&bytes);
    staged.written += bytes.len() as u64;
    Ok(())
}

/// Each IPC message is bounded regardless of original file size.
#[tauri::command]
pub fn audio_stage_append(
    state: tauri::State<AudioSourcesState>,
    id: String,
    offset: u64,
    encoded: String,
) -> Result<(), String> {
    let mut files = state.0.lock().map_err(|_| "音频导入状态不可用")?;
    append_stage(
        files.get_mut(&id).ok_or("音频导入已取消")?,
        offset,
        &encoded,
    )
}

/// A content hash lets a repeated paste resume an earlier transcription despite a new temporary path.
#[tauri::command]
pub fn audio_stage_finish(
    state: tauri::State<AudioSourcesState>,
    id: String,
) -> Result<NativeAudioFile, String> {
    let mut files = state.0.lock().map_err(|_| "音频导入状态不可用")?;
    let staged = files.get_mut(&id).ok_or("音频导入已取消")?;
    finish_stage(staged)
}

/// Refuse incomplete imports and give repeated clipboard copies a stable content identity.
fn finish_stage(staged: &mut StagedAudio) -> Result<NativeAudioFile, String> {
    if staged.written != staged.expected {
        return Err("音频导入尚未完成".into());
    }
    staged.file.flush().map_err(|_| "音频导入写入失败")?;
    let mut source = describe(staged.file.path(), &staged.name, staged.file.as_file())?;
    source.content_key = format!("{:x}", staged.hash.clone().finalize());
    Ok(source)
}

/// Dropping a staged source removes its temporary original without touching the user's file.
#[tauri::command]
pub fn audio_stage_release(
    state: tauri::State<AudioSourcesState>,
    id: String,
) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "音频导入状态不可用")?
        .remove(&id);
    Ok(())
}

/// Replace checkpoints atomically so interruption cannot destroy the last completed-segment record.
#[tauri::command]
pub fn audio_checkpoint_save(
    cache_path: String,
    key: String,
    contents: String,
) -> Result<(), String> {
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("转写进度标识无效".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(&contents).map_err(|_| "转写进度数据无效")?;
    let directory = Path::new(&cache_path).join("temp/audio-transcriptions");
    std::fs::create_dir_all(&directory).map_err(|_| "无法创建转写进度目录")?;
    crate::json_store::write_json(&directory.join(format!("{key}.json")), &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::base64_encode;

    #[test]
    fn attachment_keeps_original_bytes_name_and_survives_source_deletion() {
        let originals = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let path = originals.path().join("采访.MP3");
        let bytes = [b'I', b'D', b'3', 0, 255, 128, 65];
        std::fs::write(&path, bytes).unwrap();
        let source = audio_inspect(path.to_string_lossy().into_owned(), None).unwrap();
        let first = import_attachment(cache.path(), &source).unwrap();
        let second = import_attachment(cache.path(), &source).unwrap();
        assert_ne!(first.path, source.path);
        assert_ne!(first.path, second.path);
        assert_eq!(first.name, "采访.MP3");
        assert_eq!(first.mime, "audio/mpeg");
        assert_eq!(first.size, bytes.len() as u64);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(path).unwrap();
        for saved in [first, second] {
            let persisted: NativeAudioFile =
                serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
            assert!(open_source(&persisted).is_ok());
            assert_eq!(std::fs::read(persisted.path).unwrap(), bytes);
        }
    }

    #[test]
    fn attachment_rejects_changed_sources_and_invalid_names_before_creating_files() {
        let originals = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let path = originals.path().join("recording.mp3");
        std::fs::write(&path, [0, 255]).unwrap();
        let mut source = audio_inspect(path.to_string_lossy().into_owned(), None).unwrap();
        assert!(import_attachment(Path::new("relative-cache"), &source).is_err());
        source.name = "../escape.mp3".into();
        assert!(import_attachment(cache.path(), &source).is_err());
        source.name = "recording.mp3".into();
        std::fs::write(path, [0, 255, 65]).unwrap();
        assert!(import_attachment(cache.path(), &source).is_err());
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    }

    #[test]
    fn checkpoints_replace_previous_progress_and_reject_path_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_string_lossy().into_owned();
        let key = "a".repeat(64);
        audio_checkpoint_save(
            root.clone(),
            key.clone(),
            r#"{"count":2,"texts":["first",null]}"#.into(),
        )
        .unwrap();
        audio_checkpoint_save(
            root.clone(),
            key.clone(),
            r#"{"count":2,"texts":["first","second"]}"#.into(),
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                directory
                    .path()
                    .join(format!("temp/audio-transcriptions/{key}.json")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value["texts"][1], "second");
        assert!(audio_checkpoint_save(root, "../../escape".into(), "{}".into()).is_err());
    }

    #[test]
    fn sparse_multigigabyte_files_are_described_without_reading_their_contents() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.wav");
        let file = File::create(&path).unwrap();
        file.set_len(5 * 1024 * 1024 * 1024).unwrap();
        let source = audio_inspect(path.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(source.size, 5 * 1024 * 1024 * 1024);
        assert!(open_source(&source).is_ok());
        file.set_len(5 * 1024 * 1024 * 1024 + 1).unwrap();
        assert!(open_source(&source).err().unwrap().contains("改变"));
        assert!(audio_inspect(directory.path().to_string_lossy().into_owned(), None).is_err());
    }

    #[test]
    fn clipboard_import_is_bounded_ordered_complete_and_content_addressed() {
        let make = || StagedAudio {
            file: tempfile::NamedTempFile::new().unwrap(),
            name: "clip.mp3".into(),
            expected: 3,
            written: 0,
            hash: Sha256::new(),
        };
        let mut first = make();
        assert!(finish_stage(&mut first).is_err());
        append_stage(&mut first, 0, &base64_encode(&[0, 255])).unwrap();
        assert!(append_stage(&mut first, 0, "YQ==").is_err());
        assert!(append_stage(
            &mut first,
            2,
            &"A".repeat(STAGE_CHUNK_BYTES.div_ceil(3) * 4 + 4)
        )
        .is_err());
        append_stage(&mut first, 2, &base64_encode(&[65])).unwrap();
        let original = finish_stage(&mut first).unwrap();
        let mut second = make();
        append_stage(&mut second, 0, &base64_encode(&[0, 255, 65])).unwrap();
        let copy = finish_stage(&mut second).unwrap();
        assert_ne!(original.fingerprint, copy.fingerprint);
        assert_eq!(original.content_key, copy.content_key);
        assert_eq!(std::fs::read(&original.path).unwrap(), [0, 255, 65]);
        let path = original.path.clone();
        drop(first);
        assert!(!Path::new(&path).exists());
    }
}
