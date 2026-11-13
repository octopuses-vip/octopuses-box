//! ots 命令行程序入口。
//!
//! 这里只做三件事：解析命令行、调用 [`app::run`]、把错误渲染成给终端用户看的形态。
//! 退出码约定：0 成功、130 用户中断、2 参数或环境错误、1 运行失败。

mod app;
mod cli;
mod sink;

use std::process::ExitCode;

use clap::Parser;

use crate::cli::Cli;

#[tokio::main]
/// CLI 进程入口（开发者 Jan）：解析参数后交给 app::run，
/// 并把返回的退出码原样交给 shell，便于在脚本里按退出码判断成败。
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match app::run(cli).await {
        Ok(code) => code,
        Err(err) => {
            eprintln!("错误: {err:#}");
            ExitCode::from(2)
        }
    }
}
