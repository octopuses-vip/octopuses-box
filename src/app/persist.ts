/**
 * 持久化相关常量（开发者 Jan）。
 *
 * zustand persist 的落盘键有两处使用者：store 自身，以及 `index.html` 里
 * 抢在样式表之前执行的首屏防闪脚本（它要直接读 localStorage 才能避免闪屏）。
 * 抽成常量并由主题运行时在开发模式下断言，避免两边改名后不同步。
 */
export const STORE_PERSIST_KEY = "octopuses";
