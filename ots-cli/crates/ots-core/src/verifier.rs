//! 验证器抽象：循环的「测试」环节。

use std::path::PathBuf;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::error::CoreResult;

/// 验证输入上下文。
#[derive(Debug, Clone)]
pub struct VerificationContext {
    /// 当前迭代序号（从 1 开始）。
    pub iteration: u32,
    /// 工作区根目录。
    pub workspace: PathBuf,
    /// 本轮迭代中被工具改动过的文件。
    pub changed_files: Vec<PathBuf>,
    /// 模型本轮输出的文本。
    pub assistant_message: String,
    /// 取消令牌。
    pub cancel: CancellationToken,
}

/// 验证结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Verification {
    /// 是否通过。
    pub passed: bool,
    /// 质量分数，`0.0 ~ 1.0`，与质量阈值比较。
    pub score: f64,
    /// 一句话结论。
    pub summary: String,
    /// 明细行。
    #[serde(default)]
    pub details: Vec<String>,
    /// 是否因为缺少可执行验证手段而被跳过。
    #[serde(default)]
    pub skipped: bool,
}

impl Verification {
    /// 通过。
    pub fn passed(score: f64, summary: impl Into<String>) -> Self {
        Self { passed: true, score: score.clamp(0.0, 1.0), summary: summary.into(), details: Vec::new(), skipped: false }
    }

    /// 未通过。
    pub fn failed(score: f64, summary: impl Into<String>) -> Self {
        Self { passed: false, score: score.clamp(0.0, 1.0), summary: summary.into(), details: Vec::new(), skipped: false }
    }

    /// 跳过（没有配置验证手段）。
    pub fn skipped(summary: impl Into<String>) -> Self {
        Self { passed: false, score: 0.0, summary: summary.into(), details: Vec::new(), skipped: true }
    }

    /// 追加明细。
    #[must_use]
    pub fn with_details(mut self, details: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.details = details.into_iter().map(Into::into).collect();
        self
    }
}

/// 验证器契约。
#[async_trait]
pub trait Verifier: Send + Sync {
    /// 实现名。
    fn name(&self) -> &str;

    /// 执行验证。
    ///
    /// # Errors
    /// 验证过程本身无法执行（例如命令无法启动）时返回错误；业务上的「不通过」应表达为
    /// [`Verification`] 中 `passed = false`。
    async fn verify(&self, ctx: &VerificationContext) -> CoreResult<Verification>;
}
