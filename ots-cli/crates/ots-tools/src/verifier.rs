//! 验证器实现：用配置的测试命令客观判定本轮改动是否达标。
//!
//! 判定口径分两层：
//! 1. `passed` 完全由退出码决定（客观、不可伪造）；
//! 2. `score` 在输出中能解析出「通过/失败」用例数时给出分级分数（`通过数 / 总数`），
//!    否则退化为 `1.0 / 0.0`，使质量阈值条件只会在真实有分级信息时生效。

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ots_core::{CoreError, CoreResult, ExecGuard, Verification, VerificationContext, Verifier};

use crate::process::{self, ProcessOutcome};

/// 注入到 `details` 中的输出尾部行数。
const DETAIL_TAIL_LINES: usize = 15;

/// 关键词「通过」与其在测试输出中的常见写法。
const PASSED_KEYWORD: &str = "passed";
/// 关键词「失败」与其在测试输出中的常见写法。
const FAILED_KEYWORD: &str = "failed";

/// 通过执行测试命令来验证的验证器。
pub struct TestCommandVerifier {
    command: String,
    guard: Arc<dyn ExecGuard>,
    timeout: Duration,
}

impl TestCommandVerifier {
    /// 构造验证器。
    pub fn new(command: impl Into<String>, guard: Arc<dyn ExecGuard>, timeout: Duration) -> Self {
        Self { command: command.into(), guard, timeout }
    }

    /// 配置的测试命令。
    pub fn command(&self) -> &str {
        &self.command
    }
}

#[async_trait]
impl Verifier for TestCommandVerifier {
    /// 验证器名（开发者 Jan）：与配置里的 agent.verifier = "test-command" 对应
    fn name(&self) -> &str {
        "test-command"
    }

    /// 执行配置的测试命令并按结果判定（开发者 Jan）。
    ///
    /// 未配置命令时返回 skipped 而不是失败：验证是可选项，没配就不该阻断整轮运行。
    /// 执行前仍要过一遍 guard 的命令检查，避免配置里写进危险命令后被直接执行。
    async fn verify(&self, ctx: &VerificationContext) -> CoreResult<Verification> {
        if self.command.trim().is_empty() {
            return Ok(Verification::skipped("未配置 agent.test_command，跳过客观验证"));
        }
        self.guard.check_command(&self.command)?;

        let spec = process::shell_spec(
            self.guard.as_ref(),
            self.command.clone(),
            ctx.workspace.clone(),
            &BTreeMap::new(),
            self.timeout,
        );
        let outcome = process::run(spec, &ctx.cancel).await.map_err(|err| CoreError::Other(err.to_string()))?;

        if outcome.cancelled {
            return Err(CoreError::Cancelled);
        }
        if outcome.timed_out {
            return Ok(Verification::failed(0.0, format!("验证超时（超过 {} 秒）", self.timeout.as_secs()))
                .with_details([format!("命令: {}", self.command)]));
        }

        Ok(build_verification(&self.command, &outcome))
    }
}

/// 依据执行结果构造验证结论。
fn build_verification(command: &str, outcome: &ProcessOutcome) -> Verification {
    let exit_code = outcome.exit_code;
    let passed = outcome.is_success();
    let output = process::combine_output(outcome);
    let details = detail_lines(command, exit_code, &output);

    match (passed, summarize(&output)) {
        (true, _) => Verification::passed(1.0, "测试命令通过").with_details(details),
        (false, Some((success, failure))) => {
            let total = success + failure;
            let score = if total == 0 { 0.0 } else { success as f64 / total as f64 };
            Verification::failed(score, format!("测试失败：{success} 通过 / {failure} 失败")).with_details(details)
        }
        (false, None) => {
            let summary = match exit_code {
                Some(code) => format!("测试命令以退出码 {code} 结束"),
                None => "测试命令被信号终止".to_string(),
            };
            Verification::failed(0.0, summary).with_details(details)
        }
    }
}

/// 显式关闭客观验证的验证器。
///
/// 返回「跳过」而不是「通过」：循环据此判定为「模型声明完成即结束」，
/// 与「测试真的跑过了」区分开，避免 `--no-verify` 被误认为通过了验证。
#[derive(Debug, Clone, Copy, Default)]
pub struct NoVerifier;

#[async_trait]
impl Verifier for NoVerifier {
    /// 验证器名（开发者 Jan）：与配置里的 agent.verifier = "none" 对应
    fn name(&self) -> &str {
        "none"
    }

    /// 不做客观验证（开发者 Jan）：恒返回 skipped，把「完成」的判断权完全交给模型
    async fn verify(&self, _ctx: &VerificationContext) -> CoreResult<Verification> {
        Ok(Verification::skipped("已配置为不做客观验证（agent.verifier = \"none\"）"))
    }
}

/// 构造注入给模型的明细行。
fn detail_lines(command: &str, exit_code: Option<i32>, output: &str) -> Vec<String> {
    let mut details = vec![format!("命令: {command}")];
    details.push(match exit_code {
        Some(code) => format!("退出码: {code}"),
        None => "退出码: 进程被终止".to_string(),
    });

    let trimmed = output.trim_end();
    if trimmed.is_empty() {
        details.push("（命令没有产生任何输出）".to_string());
        return details;
    }

    let tail: Vec<&str> = trimmed.lines().rev().take(DETAIL_TAIL_LINES).collect();
    if tail.len() < trimmed.lines().count() {
        details.push("输出（末尾片段）:".to_string());
    } else {
        details.push("输出:".to_string());
    }
    details.extend(tail.into_iter().rev().map(str::to_string));
    details
}

/// 从输出中解析「通过 / 失败」用例数，解析不到时返回 `None`。
///
/// 支持常见测试框架的汇总行，例如：
/// - `test result: FAILED. 57 passed; 3 failed; ...`（cargo test / libtest）
/// - `Tests: 3 failed, 7 passed, 10 total`（jest）
fn summarize(output: &str) -> Option<(u64, u64)> {
    for line in output.lines().rev() {
        let lower = line.to_ascii_lowercase();
        if !lower.contains(PASSED_KEYWORD) || !lower.contains(FAILED_KEYWORD) {
            continue;
        }
        if let (Some(success), Some(failure)) = (
            number_before(&lower, PASSED_KEYWORD),
            number_before(&lower, FAILED_KEYWORD),
        ) {
            return Some((success, failure));
        }
    }
    None
}

/// 读取关键词之前最近的整数。
///
/// 同一行可能多次出现关键词（例如 libtest 的 `FAILED. 57 passed; 3 failed`），
/// 因此逐个出现位置尝试，取第一个「前面紧邻数字」的位置。
fn number_before(line: &str, keyword: &str) -> Option<u64> {
    let mut from = 0;
    while let Some(relative) = line[from..].find(keyword) {
        let index = from + relative;
        if let Some(value) = trailing_number(&line[..index]) {
            return Some(value);
        }
        from = index + keyword.len();
    }
    None
}

/// 取文本末尾连续数字组成的整数。
fn trailing_number(prefix: &str) -> Option<u64> {
    let digits: String = prefix
        .trim_end()
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ots_core::PermissiveGuard;
    use tokio_util::sync::CancellationToken;

    fn context(workspace: &std::path::Path) -> VerificationContext {
        VerificationContext {
            iteration: 1,
            workspace: workspace.to_path_buf(),
            changed_files: Vec::new(),
            assistant_message: String::new(),
            cancel: CancellationToken::new(),
        }
    }

    fn verifier(command: &str) -> TestCommandVerifier {
        TestCommandVerifier::new(command, Arc::new(PermissiveGuard), Duration::from_secs(30))
    }

    #[tokio::test]
    async fn 命令通过时得满分() {
        let dir = tempfile::tempdir().expect("临时目录");
        let verification = verifier("exit 0").verify(&context(dir.path())).await.expect("验证执行");
        assert!(verification.passed);
        assert_eq!(verification.score, 1.0);
        assert!(!verification.skipped);
    }

    #[tokio::test]
    async fn 输出含用例统计时给出分级分数() {
        let dir = tempfile::tempdir().expect("临时目录");
        let script = "echo 'test result: FAILED. 57 passed; 3 failed; 0 ignored'; exit 1";
        let verification = verifier(script).verify(&context(dir.path())).await.expect("验证执行");
        assert!(!verification.passed);
        assert!((verification.score - 0.95).abs() < 1e-9, "score={}", verification.score);
        assert!(verification.summary.contains("57 通过"));
    }

    #[tokio::test]
    async fn 无法解析统计时按退出码判定() {
        let dir = tempfile::tempdir().expect("临时目录");
        let verification = verifier("echo boom >&2; exit 3").verify(&context(dir.path())).await.expect("验证执行");
        assert!(!verification.passed);
        assert_eq!(verification.score, 0.0);
        assert!(verification.details.iter().any(|line| line.contains("退出码: 3")));
        assert!(verification.details.iter().any(|line| line.contains("boom")));
    }

    #[tokio::test]
    async fn 未配置命令时跳过验证() {
        let dir = tempfile::tempdir().expect("临时目录");
        let verification = verifier("   ").verify(&context(dir.path())).await.expect("验证执行");
        assert!(verification.skipped);
    }

    #[tokio::test]
    async fn 超时判定为未通过() {
        let dir = tempfile::tempdir().expect("临时目录");
        let verifier = TestCommandVerifier::new(
            "sleep 5",
            Arc::new(PermissiveGuard),
            Duration::from_millis(200),
        );
        let verification = verifier.verify(&context(dir.path())).await.expect("验证执行");
        assert!(!verification.passed);
        assert!(verification.summary.contains("超时"));
    }

    #[test]
    fn 解析jest风格统计() {
        let output = "Tests:       3 failed, 7 passed, 10 total";
        assert_eq!(summarize(output), Some((7, 3)));
    }

    #[test]
    fn 无统计信息时返回空() {
        assert_eq!(summarize("error: could not compile"), None);
    }

    #[test]
    fn 详情截取输出尾部() {
        let output: String = (1..=50).map(|index| format!("line{index}\n")).collect();
        let details = detail_lines("cargo test", Some(1), &output);
        assert!(details.iter().any(|line| line.contains("末尾片段")));
        assert!(details.iter().any(|line| line == "line50"));
        assert!(!details.iter().any(|line| line == "line1"));
    }
}
