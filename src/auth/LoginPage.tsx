import { useState } from "react";

import { APP_NAME } from "../app/meta";
import { useAppStore } from "../app/state";
import { logCacheEvent } from "../cache/logger";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { ServerSetupPage } from "./ServerSetupPage";

/**
 * 登录页：账号密码登录，成功后按配置状态进入缓存路径配置或主界面。
 *
 * 页面底部另有「改用本地模型」出口：走到这一步的用户已经选了远程，但没有账号、
 * 或不想连管理端。之前唯一的切换入口在「设置 → 模型来源」，而设置页在登录之后才到得了，
 * 于是这类用户被卡在登录页上无路可走——出口必须留在这一页。
 * 点了即刻切换并落盘，路由随即放行到缓存目录配置（本地模式不需要地址与账号）；
 * 切换只清模型、不动登录态，因此误点也能在「设置 → 模型来源」一步切回远程，不再二次确认。
 */
export function LoginPage() {
  const login = useAppStore((state) => state.login);
  const loadModelConfig = useAppStore((state) => state.loadModelConfig);
  const setModelSource = useAppStore((state) => state.setModelSource);
  /** 会话在后台被判定失效（账号被禁用等）后退回登录页时留下的原因 */
  const sessionError = useAppStore((state) => state.modelConfigError);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 正在提交，期间禁止重复点击 */
  const [busy, setBusy] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState(false);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;
  /** 本地错误优先，其次展示后台判定失效的原因 */
  const message = error ?? sessionError;

/** 函数级说明（开发者 Jan）：执行 submit 的单一职责，并返回可供调用方继续处理的结果。 */
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    // 登录走 octopuses-server，失败文案由服务端给出（凭据错误 / 账号被禁用 / 连不上服务端）
    const result = await login(username, password);
    setBusy(false);
    if (result.ok) {
      setError(null);
      logCacheEvent("auth.login", username.trim());
      // 登录成功后从后台获取授权模型列表，失败不阻断使用
      void loadModelConfig();
      return;
    }
    setError(result.error ?? "登录失败，请稍后重试。");
    logCacheEvent("auth.login.failed", username.trim());
  };

  if (editingEndpoint) {
    return <ServerSetupPage onConfigured={() => { setError(null); setEditingEndpoint(false); }} onCancel={() => setEditingEndpoint(false)} />;
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__logo">
          <img className="login__logo-mark" src="/logo.png" alt="" />
          {APP_NAME}
        </div>
        <h1 className="login__title">登录</h1>
        <p className="login__sub">请使用账号密码登录，登录状态仅保存在本机。</p>

        <form
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="search-input">
            <Icon name="user" size={14} />
            <input
              type="text"
              value={username}
              placeholder="用户名"
              aria-label="用户名"
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="search-input">
            <Icon name="shield" size={14} />
            <input
              type="password"
              value={password}
              placeholder="密码"
              aria-label="密码"
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {message ? (
            <div className="list-row" style={{ marginBottom: 0 }}>
              <Icon name="alert" size={14} />
              <span className="list-row__desc">{message}</span>
            </div>
          ) : null}

          <div className="login__actions">
            <Button variant="primary" type="submit" disabled={!canSubmit}>
              {busy ? "登录中…" : "登录"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditingEndpoint(true)}>
              修改管理端地址
            </Button>
          </div>
        </form>

        {/*
          本地模式的出口（开发者 Jan）：与登录用一条分隔线隔开，不与主按钮并列——
          并列会让人以为「本地模型」是另一种登录方式，而它其实是登录的替代品。
        */}
        <div className="login__alt">
          <span className="muted">没有账号，或不想连管理端？</span>
          <Button
            variant="ghost"
            size="sm"
            icon="folder"
            onClick={() => setModelSource("local")}
          >
            改用本地模型
          </Button>
        </div>
      </div>
    </div>
  );
}
