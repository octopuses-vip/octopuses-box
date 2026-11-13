import { useCallback } from "react";

import { useConfirm } from "../components/ConfirmProvider";

/**
 * 退出登录的二次确认（开发者 Jan）。
 *
 * 退出登录会清空令牌与派生数据并跳回登录页，属于不可逆操作，因此侧栏底部、
 * 顶栏头像、设置页、命令面板与缓存目录页五处入口都要先过这道确认。
 * 文案与判定集中在这里，避免各入口各写一份后出现措辞或行为不一致。
 */

/** 确认弹窗文案：写明后果，用户才知道确认后需要重新登录 */
const LOGOUT_CONFIRM_MESSAGE = "确认退出登录吗？退出后需要重新登录。";

/**
 * 返回一个「先确认、再退出」的动作（开发者 Jan）。
 *
 * 用户点「取消」时不执行传入的退出动作；返回值表示本次是否真的退出了，
 * 供调用方决定后续流程（例如命令面板取消时应保持面板不关闭）。
 */
export function useRequestLogout(): (logout: () => void) => Promise<boolean> {
  const confirm = useConfirm();
  return useCallback(
    async (logout: () => void) => {
      const ok = await confirm({
        title: "退出登录",
        message: LOGOUT_CONFIRM_MESSAGE,
        confirmText: "退出登录",
      });
      if (!ok) return false;
      logout();
      return true;
    },
    [confirm],
  );
}
