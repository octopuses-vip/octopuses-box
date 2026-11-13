import { APP_NAME } from "../app/meta";
import { useAppStore } from "../app/state";
import { Icon } from "../components/Icon";

/**
 * 首次启动第一步：选择模型来源（远程管理端 / 本地模型文件）。
 *
 * 这一步排在「配置管理端地址」与「登录」之前——选了本地，整条登录链路就不存在，
 * 先问地址再问来源等于把用户不需要回答的问题先问一遍。两个选项的说明里写清了
 * 「要不要登录」，避免选完才发现自己被要求填账号。
 *
 * 选择结果落盘后不再出现；老版本升级上来的用户持久化里没有这个字段，
 * 由 `migratePersistedState` 补成 `remote`，不会被要求重新选择。
 * 之后随时可以在「设置 → 模型来源」切换，切换不会丢掉已有的登录态。
 */
export function ModelSourceSetupPage() {
  const setModelSource = useAppStore((state) => state.setModelSource);

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__logo">
          <img className="login__logo-mark" src="/logo.png" alt="" />
          {APP_NAME}
        </div>
        <h1 className="login__title">选择模型来源</h1>
        <p className="login__sub">
          模型列表可以由管理端按账号下发，也可以读本机缓存目录下的配置文件。这一步只问一次，之后能在「设置」里切换。
        </p>

        <div className="source-choice-group">
          <button
            type="button"
            className="source-choice"
            onClick={() => setModelSource("remote")}
          >
            <span className="source-choice__icon">
              <Icon name="globe" size={16} />
            </span>
            <span className="source-choice__main">
              <span className="source-choice__title">远程管理端</span>
              <span className="source-choice__desc">
                连接 octopuses-server：先配置管理端地址，再登录账号，模型列表由服务端下发。客户端更新也走这台服务器。
              </span>
            </span>
          </button>

          <button type="button" className="source-choice" onClick={() => setModelSource("local")}>
            <span className="source-choice__icon">
              <Icon name="folder" size={16} />
            </span>
            <span className="source-choice__main">
              <span className="source-choice__title">
                本地模型
                <span className="source-choice__badge">无需登录</span>
              </span>
              <span className="source-choice__desc">
                不连管理端。模型写在缓存目录下的 models.json 里，接入地址与密钥由你自己填；只需再配置一个缓存目录就能进入。
              </span>
            </span>
          </button>
        </div>

        <p className="muted" style={{ fontSize: "var(--fs-xs)", margin: 0 }}>
          选错了不要紧：「设置 → 模型来源」随时可切换，已有的登录态不会因为切换而丢失。
        </p>
      </div>
    </div>
  );
}
