/**
 * 浏览器演示环境的登录回落（开发者 Jan）。
 *
 * 真实登录走 octopuses-server（`POST /api/client/login`），由 `src-tauri/src/client_api.rs`
 * 发起原生请求，见 `./desktop.ts` 的 `loginToServer`。服务端未开启 CORS，普通浏览器
 * 里的 fetch 会被同源策略拦截，因此**只有**在没有 Rust 侧的演示环境才使用本文件的内置账号，
 * 它不参与桌面端的任何鉴权判断。
 */

/** 一组用户名 / 密码（开发者 Jan）：演示环境下由前端直接比对 */
export interface Account {
  username: string;
  password: string;
}

/** 演示环境内置账号（开发者 Jan），仅用于 `pnpm dev` 直接用浏览器打开的场景 */
export const FIXED_ACCOUNT: Account = {
  username: "admin",
  password: "123456",
};

/** 校验用户名与密码是否匹配内置账号（开发者 Jan）；仅供演示回落使用，桌面端不调用 */
export function verifyCredentials(username: string, password: string): boolean {
  return username.trim() === FIXED_ACCOUNT.username && password === FIXED_ACCOUNT.password;
}
