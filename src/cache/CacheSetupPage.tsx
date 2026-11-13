import { useEffect, useState } from "react";

import { CACHE_SUBDIRS, defaultCacheDir, initCacheDir } from "../app/desktop/cache";
import { isDesktopRuntime } from "../app/desktop/runtime";
import { pickDirectory } from "../app/desktop/system";
import { APP_NAME } from "../app/meta";
import { useAppStore } from "../app/state";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { logCacheEvent } from "./logger";

/**
 * 首次登录必填步骤：配置缓存路径。
 * 确认后系统产生的文件与临时内容都会写入该目录，未配置不进入主界面。
 */
export function CacheSetupPage() {
  const setCachePath = useAppStore((state) => state.setCachePath);
  const desktop = isDesktopRuntime();

  const [defaultPath, setDefaultPath] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void defaultCacheDir()
      .then((value) => {
        if (cancelled) return;
        setDefaultPath(value);
        setPath((current) => current || value);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

/** 函数级说明（开发者 Jan）：执行 browse 的单一职责，并返回可供调用方继续处理的结果。 */
  const browse = async () => {
    const selected = await pickDirectory("选择缓存目录");
    if (!selected) {
      setError("未选择目录，可直接使用默认路径。");
      return;
    }
    setPath(selected);
    setError(null);
  };

/** 函数级说明（开发者 Jan）：执行 confirm 的单一职责，并返回可供调用方继续处理的结果。 */
  const confirm = async () => {
    const target = path.trim();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const info = await initCacheDir(target);
      logCacheEvent("cache.init", info.path);
      setCachePath(info.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        <h1 className="login__title">配置缓存路径</h1>
        <p className="login__sub">
          {APP_NAME} 会把运行过程中产生的文件与临时内容统一写入这个目录，首次登录需要先完成配置。
        </p>

        <div>
          <div className="page__section-label">缓存目录</div>
          {desktop ? (
            <div className="path-box">
              <Icon name="folder" size={13} />
              {path || "尚未选择"}
            </div>
          ) : (
            <div className="search-input">
              <Icon name="folder" size={14} />
              <input
                type="text"
                value={path}
                placeholder="缓存目录路径"
                aria-label="缓存路径"
                onChange={(event) => setPath(event.target.value)}
              />
            </div>
          )}
        </div>

        <div>
          <div className="page__section-label">目录结构</div>
          <div className="recent-list">
            {CACHE_SUBDIRS.map((item) => (
              <div key={item.name} className="list-row" style={{ marginBottom: 0 }}>
                <Icon name="folder" size={14} />
                <span className="list-row__main">
                  <span className="list-row__title mono">{item.name}/</span>
                  <span className="list-row__desc">{item.label}</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        {error ? (
          <div className="list-row" style={{ marginBottom: 0 }}>
            <Icon name="alert" size={14} />
            <span className="list-row__desc">{error}</span>
          </div>
        ) : null}

        <div className="login__actions">
          {desktop ? (
            <Button icon="folder" onClick={() => void browse()}>
              浏览文件夹…
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={!defaultPath || path === defaultPath}
            onClick={() => setPath(defaultPath)}
          >
            使用默认路径
          </Button>
        </div>

        <div className="login__actions">
          <Button variant="primary" disabled={!path.trim() || busy} onClick={() => void confirm()}>
            {busy ? "正在创建…" : "确认并进入"}
          </Button>
        </div>

        <p className="muted" style={{ fontSize: "var(--fs-xs)", margin: 0 }}>
          {desktop
            ? "选择的目录会被创建为缓存根目录，并写入 manifest.json 记录。"
            : "当前在浏览器中运行，路径仅做模拟记录；桌面端会真实创建目录并写入文件。"}
        </p>
      </div>
    </div>
  );
}