//! Agent 循环内核：生成 → 执行 → 验证 → 继续/终止。
//!
//! 循环本身不感知任何具体实现：模型来自 [`Generator`]，工具来自 [`ToolRuntime`]，
//! 权限来自 [`PolicyEngine`]，人工审批来自 [`ApprovalBroker`]，结论来自 [`Verifier`]。

include!("looping.part-01.rs");
include!("looping.part-02.rs");
include!("looping.part-03.rs");
