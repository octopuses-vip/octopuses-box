import { useEffect, useState } from "react";

import { useAppStore } from "../app/state";
import {
  applyTheme,
  assertBootContract,
  readSystemScheme,
  resolveScheme,
  watchSystemScheme,
  type ResolvedScheme,
  type SchemePreference,
  type ThemeId,
} from "../app/theme";

export interface ThemeController {
  /** 当前配色主题 */
  themeId: ThemeId;
  /** 用户的明暗偏好（可能是「跟随系统」） */
  schemePreference: SchemePreference;
  /** 落定后的实际明暗模式，供色卡预览等需要确定值的场景使用 */
  resolvedScheme: ResolvedScheme;
  /** 切换配色主题（开发者 Jan） */
  setThemeId: (id: ThemeId) => void;
  /** 切换明暗偏好（开发者 Jan） */
  setSchemePreference: (preference: SchemePreference) => void;
}

/**
 * 主题桥接 hook（开发者 Jan）。
 *
 * 把三样东西接起来：store 里的偏好、系统当前的实际深浅色、`<html>` 上的主题属性。
 * 「跟随系统」时系统变化会实时反映到界面；手动指定时系统变化不改动最终模式，界面保持不动。
 *
 * 必须挂在 `App` 顶层而不是 `AppShell`：缓存目录页渲染在 `AppShell`
 * 之外，挂低了该界面就不会跟随主题。
 */
export function useTheme(): ThemeController {
  const themeId = useAppStore((state) => state.themeId);
  const schemePreference = useAppStore((state) => state.themeScheme);
  const setThemeId = useAppStore((state) => state.setThemeId);
  const setSchemePreference = useAppStore((state) => state.setThemeScheme);
  const [systemScheme, setSystemScheme] = useState<ResolvedScheme>(readSystemScheme);

  // 首屏防闪脚本与本模块的常量必须一致，开发模式下校验一次（生产环境该函数直接返回）
  useEffect(() => {
    assertBootContract();
  }, []);

  // 订阅系统深浅色：回调即 setState，卸载时由 watchSystemScheme 返回的函数取消订阅
  useEffect(() => watchSystemScheme(setSystemScheme), []);

  const resolvedScheme = resolveScheme(schemePreference, systemScheme);

  useEffect(() => {
    applyTheme(themeId, resolvedScheme);
  }, [themeId, resolvedScheme]);

  return { themeId, schemePreference, resolvedScheme, setThemeId, setSchemePreference };
}
