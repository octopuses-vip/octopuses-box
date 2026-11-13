import { useEffect, useState } from "react";

import { defaultEndpoint, parseApiError, probeEndpoint } from "../app/desktop/server";
import { APP_NAME } from "../app/meta";
import { useAppStore } from "../app/state";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";

/**
 * 首次启动必填步骤：配置管理端（octopuses-server）地址。
 *
 * 地址属于本机配置，只在从未配置过时出现一次；确认前会先探测管理端是否可达，
 * 避免把写错的地址存下来，跑到登录页才发现连不上。
 */
export function ServerSetupPage() {
  const setEndpoint = useAppStore((state) => state.setEndpoint);
  /** 表单中的主机与端口，用户改动前先由后端下发的默认值预填 */
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  /** 正在校验与探测，期间禁止重复提交 */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void defaultEndpoint()
      .then((value) => {
        if (cancelled) return;
        // 只填空值：用户可能在请求返回前就已经开始输入
        setHost((current) => current || value.host);
        setPort((current) => current || value.port);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(parseApiError(err).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canSubmit = host.trim().length > 0 && port.trim().length > 0 && !busy;

/** 函数级说明（开发者 Jan）：执行 confirm 的单一职责，并返回可供调用方继续处理的结果。 */
  const confirm = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // 后端先校验格式再探测连通性，成功时返回规范化后的地址
      setEndpoint(await probeEndpoint({ host, port }));
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__logo">
          <img className="login__logo-mark" src="/logo.png" alt="" />
          {APP_NAME}
        </div>
        <h1 className="login__title">配置管理端地址</h1>
        <p className="login__sub">
          请填写管理端主机名与端口，可使用 https:// 前缀。远程连接使用 HTTPS，HTTP 仅限本机开发。
        </p>

        <form
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <div style={{ display: "flex", gap: 10 }}>
            <div className="search-input" style={{ flex: 1 }}>
              <Icon name="globe" size={14} />
              <input
                type="text"
                value={host}
                placeholder="https://server.example.com"
                aria-label="管理端地址"
                onChange={(event) => setHost(event.target.value)}
              />
            </div>
            <div className="search-input" style={{ width: 118 }}>
              <Icon name="settings" size={14} />
              <input
                type="text"
                value={port}
                placeholder="端口"
                aria-label="管理端端口"
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
              />
            </div>
          </div>

          {error ? (
            <div className="list-row" style={{ marginBottom: 0 }}>
              <Icon name="alert" size={14} />
              <span className="list-row__desc">{error}</span>
            </div>
          ) : null}

          <div className="login__actions">
            <Button variant="primary" type="submit" disabled={!canSubmit}>
              {busy ? "正在连接…" : "确认并进入"}
            </Button>
          </div>
        </form>

        <p className="muted" style={{ fontSize: "var(--fs-xs)", margin: 0 }}>
          地址仅保存在本机，之后可以在「设置」中修改。
        </p>
      </div>
    </div>
  );
}
