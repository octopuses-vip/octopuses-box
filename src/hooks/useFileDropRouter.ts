/**
 * 启动统一拖放路由的挂载钩子（开发者 Jan）。
 *
 * 拖放是全局行为（落点由窗口决定，不由某个组件决定），因此只在应用根组件调用一次；
 * 内部幂等，重复挂载不会重复注册监听。
 */

import { useEffect } from "react";

import { startDropRouter } from "../app/fileDrop";

/** 挂载全局拖放路由（开发者 Jan）：把拖进来的文件按类型分发到图片 / 图纸 / 文本等处理入口 */
export function useFileDropRouter(): void {
  useEffect(() => {
    startDropRouter();
  }, []);
}
