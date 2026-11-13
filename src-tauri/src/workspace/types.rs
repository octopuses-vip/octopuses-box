//! 文件命令的序列化响应契约。
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWriteResult {
    pub(super) path: String,
    pub(super) bytes: usize,
    pub(super) checkpoint_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePatchResult {
    pub(super) files: Vec<String>,
    pub(super) checkpoint_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    pub(super) checkpoint_id: String,
    pub(super) files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub(super) path: String,
    pub(super) line: usize,
    pub(super) text: String,
}
