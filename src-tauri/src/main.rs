// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 桌面端进程入口（开发者 Jan）：只做转发，实际装配在 lib.rs 的 run()，
/// 便于把同一套逻辑复用到测试与移动端外壳。
fn main() {
    octopuses_lib::run()
}
