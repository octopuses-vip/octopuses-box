import { useEffect, useState } from "react";

import { confirmDelete, confirmOverwrite } from "../app/confirmations";
import { copyText } from "../app/desktop/system";
import { testSshConnection } from "../app/desktop/ssh";
import { useAppStore } from "../app/state";
import type { SshAuthKind, SshHost } from "../app/types";
import { useConfirm } from "../components/ConfirmProvider";
import { Icon } from "../components/Icon";
import { SSH_GUARD_PROMPT_LIMIT } from "../tools/ssh";

/**
 * 主机表单的初始值（开发者 Jan）。
 *
 * 端口留空而不写死 22：后端对 0 会回落默认 SSH 端口，前端不必重复维护这个常量。
 */
const EMPTY_FORM = {
  id: "",
  name: "",
  host: "",
  port: "",
  username: "",
  auth: "password" as SshAuthKind,
  keyPath: "",
  secret: "",
  enabled: true,
  guardPrompt: "",
};

type HostForm = typeof EMPTY_FORM;

/** 密码输入留空表示不修改已保存的凭据，用界面文案说明这条约定 */
const SECRET_HINT_SET = "留空表示不修改已保存的密码；填写则覆盖";
const SECRET_HINT_NEW = "保存到系统凭据管理器，不会写入配置文件";

/** 「已复制」反馈的停留时长（毫秒）：与消息操作栏、侧栏会话列表行的反馈节奏保持一致 */
const COPIED_HINT_MS = 1600;

/**
 * 指纹的紧凑展示形式（开发者 Jan）。
 *
 * 完整指纹是 `SHA256:` + 43 字符 base64，无空格、不会自动折行，直接铺在窄卡片里会冲出边界。
 * 这里只保留首尾各若干字符，完整值通过 `title` 悬停查看、由「复制完整指纹」按钮取出，
 * 既不再溢出，也避免一长串乱码压过卡片里的其他信息。
 */
function abbreviateFingerprint(fingerprint: string): string {
  const colon = fingerprint.indexOf(":");
  const prefix = colon >= 0 ? fingerprint.slice(0, colon + 1) : "";
  const body = colon >= 0 ? fingerprint.slice(colon + 1) : fingerprint;
  if (body.length <= 16) return fingerprint;
  return `${prefix}${body.slice(0, 8)}…${body.slice(-6)}`;
}

/**
 * 远程主机（SSH）管理页（开发者 Jan）。
 *
 * 配置落盘在缓存目录 `ssh/hosts.json`，密码与私钥口令一律进系统凭据管理器；
 * 页面上只出现连接信息，任何时刻都不回显已保存的口令。
 * 启用的主机会把 4 个远程工具（执行命令 / 读文件 / 写文件 / 列目录）挂给模型，
 * 且每次调用都走人工审批。
 */
export function SshPage() {
  const cachePath = useAppStore((state) => state.cachePath);
  const hosts = useAppStore((state) => state.sshHosts);
  const status = useAppStore((state) => state.sshStatus);
  const error = useAppStore((state) => state.sshError);
  const mutationStatus = useAppStore((state) => state.sshMutationStatus);
  const mutationError = useAppStore((state) => state.sshMutationError);
  const loadHosts = useAppStore((state) => state.loadSshHosts);
  const toggleHost = useAppStore((state) => state.toggleSshHost);
  const saveHost = useAppStore((state) => state.saveSshHost);
  const deleteHost = useAppStore((state) => state.deleteSshHost);
  const confirm = useConfirm();
  const [form, setForm] = useState<HostForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  /** 各主机「测试连接」的即时结果，按主机 id 记录 */
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  /** 刚复制完指纹的主机 id：用于把复制按钮临时换成对勾 */
  const [copiedFingerprint, setCopiedFingerprint] = useState<string | null>(null);

  const enabledCount = hosts.filter((host) => host.enabled).length;
  const loading = status === "loading";
  const mutating = mutationStatus === "loading";
  /** 必填项齐了才允许保存：与 submit 里的前置校验同一口径（开发者 Jan） */
  const canSubmit = Boolean(
    form.id.trim()
      && form.name.trim()
      && form.host.trim()
      && form.username.trim()
      && (form.auth !== "key" || form.keyPath.trim()),
  );

  // 每次进入本页都重新读一遍配置，避免别处改动后界面滞后
  useEffect(() => {
    void loadHosts();
  }, [loadHosts]);

/** 函数级说明（开发者 Jan）：执行 openCreate 的单一职责，并返回可供调用方继续处理的结果。 */
  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setOverwrite(false);
    setFormOpen(true);
  };

/** 函数级说明（开发者 Jan）：执行 openEdit 的单一职责，并返回可供调用方继续处理的结果。 */
  const openEdit = (host: SshHost) => {
    setEditingId(host.id);
    setForm({
      id: host.id,
      name: host.name,
      host: host.host,
      port: String(host.port),
      username: host.username,
      auth: host.auth,
      keyPath: host.keyPath ?? "",
      // 已保存的口令不回显：留空表示沿用原凭据
      secret: "",
      enabled: host.enabled,
      guardPrompt: host.guardPrompt ?? "",
    });
    setOverwrite(false);
    setFormOpen(true);
  };

/** 函数级说明（开发者 Jan）：执行 submit 的单一职责，并返回可供调用方继续处理的结果。 */
  const submit = async () => {
    if (!canSubmit) return;
    const id = form.id.trim();
    const idChanged = editingId !== null && editingId !== id;
    let allowOverwrite = overwrite;
    if ((editingId === null || idChanged) && !allowOverwrite) {
      const conflict = hosts.some((host) => host.id === id);
      if (conflict && !(await confirmOverwrite(confirm, "目标主机"))) return;
      if (conflict) {
        setOverwrite(true);
        allowOverwrite = true;
      }
    }
    const parsedPort = Number.parseInt(form.port.trim(), 10);
    try {
      await saveHost({
        id,
        name: form.name.trim(),
        host: form.host.trim(),
        // 非法或空端口交给后端回落默认值，前端不自行猜测
        port: Number.isFinite(parsedPort) ? parsedPort : 0,
        username: form.username.trim(),
        auth: form.auth,
        keyPath: form.auth === "key" ? form.keyPath.trim() : null,
        secret: form.secret.length > 0 ? form.secret : null,
        clearSecret: false,
        enabled: form.enabled,
        // 执行限制：清空即撤销这台机器的红线，因此必须显式传 null 而不是空串
        guardPrompt: form.guardPrompt.trim().length > 0 ? form.guardPrompt.trim() : null,
        // 编辑既有主机本身就是对该条记录的显式确认（id 在编辑态不可改），
        // 必须带上 overwrite，否则后端会以「主机已存在」拒绝保存
        overwrite: allowOverwrite || editingId !== null,
      });
      setFormOpen(false);
      setForm(EMPTY_FORM);
    } catch {
      // 失败原因由页面状态展示
    }
  };

/** 函数级说明（开发者 Jan）：执行 remove 的单一职责，并返回可供调用方继续处理的结果。 */
  const remove = async (host: SshHost) => {
    if (!(await confirmDelete(confirm, "远程主机", host.name))) return;
    try {
      await deleteHost(host.id);
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[host.id];
        return next;
      });
    } catch {
      // 失败原因由页面状态展示
    }
  };

/** 函数级说明（开发者 Jan）：执行 runTest 的单一职责，并返回可供调用方继续处理的结果。 */
  const runTest = async (host: SshHost) => {
    setTestingId(host.id);
    const result = await testSshConnection(cachePath, host.id);
    setTestResults((prev) => ({ ...prev, [host.id]: { ok: result.ok, message: result.message } }));
    setTestingId(null);
    // 首次信任会回填指纹，成功或失败都可能改动了配置，因此重读一次列表
    void loadHosts();
  };

  /**
   * 复制某台主机的完整指纹（开发者 Jan）。
   *
   * 卡片里只展示首尾摘要，完整值由这里写入剪贴板；写成功才把按钮换成对勾，
   * 失败保持原样（与消息操作栏、侧栏会话列表行的复制反馈口径一致）。
   */
  const copyFingerprint = async (host: SshHost) => {
    if (!host.hostKeyFingerprint) return;
    if (!(await copyText(host.hostKeyFingerprint))) return;
    setCopiedFingerprint(host.id);
    window.setTimeout(
      () => setCopiedFingerprint((current) => (current === host.id ? null : current)),
      COPIED_HINT_MS,
    );
  };

  return (
    <div className="page">
      <div className="page__inner">
        <p className="page__desc">
          主机配置保存在缓存目录下的 ssh/hosts.json（当前：
          {cachePath ? `${cachePath}/ssh` : "尚未配置缓存目录"}）。密码与私钥口令交由系统凭据管理器保管，
          不写入配置文件。启用的主机会把「执行命令 / 读文件 / 写文件 / 列目录」四个工具挂给模型，
          每次远程操作都会弹出人工审批。
        </p>

        <div className="page__section">
          <div className="page__section-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>
              已配置 {hosts.length} · 已启用 {enabledCount}
            </span>
            <span className="spacer" />
            <button type="button" className="btn btn--primary btn--sm" disabled={mutating || !cachePath} onClick={openCreate}>
              新建
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={loading}
              onClick={() => void loadHosts()}
            >
              {loading ? "刷新中…" : "重新读取"}
            </button>
          </div>

          {!cachePath ? <div className="card"><div className="card__desc">请先配置缓存目录后再管理远程主机。</div></div> : null}
          {mutationError ? <div className="card"><div className="card__desc">操作失败：{mutationError}</div></div> : null}
          {error ? <div className="card"><div className="card__desc">读取配置失败：{error}</div></div> : null}

          {formOpen ? (
            <div className="card form-card" style={{ marginBottom: 16 }}>
              <div className="card__head">
                <Icon name="terminal" size={14} />
                <span className="card__title">{editingId ? "编辑远程主机" : "新建远程主机"}</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  title="关闭"
                  disabled={mutating}
                  onClick={() => setFormOpen(false)}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>

              {/* 基本信息：id 是唯一键，同时作为系统凭据管理器里的账号 */}
              <div className="form__section">
                <div className="form__section-title">基本信息</div>
                <div className="form__grid">
                  <label className="form__row">
                    <span className="form__label">
                      id<span className="form__required">*</span>
                    </span>
                    <input
                      className="form__input mono"
                      value={form.id}
                      disabled={Boolean(editingId)}
                      placeholder="如 prod-web-01"
                      onChange={(event) => setForm({ ...form, id: event.target.value })}
                    />
                    <span className="form__hint">字母、数字、下划线或短横线；保存后不可修改</span>
                  </label>
                  <label className="form__row">
                    <span className="form__label">
                      名称<span className="form__required">*</span>
                    </span>
                    <input
                      className="form__input"
                      value={form.name}
                      placeholder="展示用名称"
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                    <span className="form__hint">列表与工具说明里显示的名字</span>
                  </label>
                </div>
              </div>

              {/* 连接信息：主机、端口与登录用户 */}
              <div className="form__section">
                <div className="form__section-title">连接信息</div>
                <div className="form__grid">
                  <label className="form__row">
                    <span className="form__label">
                      主机<span className="form__required">*</span>
                    </span>
                    <input
                      className="form__input mono"
                      value={form.host}
                      placeholder="IP 或域名，如 10.0.0.8"
                      onChange={(event) => setForm({ ...form, host: event.target.value })}
                    />
                    <span className="form__hint">远端 Linux 服务器的地址</span>
                  </label>
                  <label className="form__row">
                    <span className="form__label">端口</span>
                    <input
                      className="form__input mono"
                      value={form.port}
                      placeholder="留空使用默认端口 22"
                      onChange={(event) => setForm({ ...form, port: event.target.value })}
                    />
                    <span className="form__hint">留空或填 0 时由后端按默认端口连接</span>
                  </label>
                  <label className="form__row">
                    <span className="form__label">
                      登录用户<span className="form__required">*</span>
                    </span>
                    <input
                      className="form__input mono"
                      value={form.username}
                      placeholder="如 root"
                      onChange={(event) => setForm({ ...form, username: event.target.value })}
                    />
                    <span className="form__hint">远端账号，命令与文件操作都以它执行</span>
                  </label>
                </div>
              </div>

              {/* 认证：密钥文件或密码，二者选一 */}
              <div className="form__section">
                <div className="form__section-title">认证方式</div>
                <label className="form__row">
                  <span className="form__label">方式</span>
                  <select
                    className="form__input"
                    value={form.auth}
                    onChange={(event) => setForm({ ...form, auth: event.target.value as SshAuthKind })}
                  >
                    <option value="password">密码</option>
                    <option value="key">私钥文件</option>
                  </select>
                  <span className="form__hint">密钥文件仅在本机使用，不会上传到远端</span>
                </label>
                {form.auth === "key" ? (
                  <label className="form__row">
                    <span className="form__label">
                      私钥文件路径<span className="form__required">*</span>
                    </span>
                    <input
                      className="form__input mono"
                      value={form.keyPath}
                      placeholder="如 C:\\Users\\me\\.ssh\\id_ed25519"
                      onChange={(event) => setForm({ ...form, keyPath: event.target.value })}
                    />
                    <span className="form__hint">本机私钥文件的完整路径；若私钥有口令，请在下方填写</span>
                  </label>
                ) : null}
                <label className="form__row">
                  <span className="form__label">
                    {form.auth === "key" ? "私钥口令" : "密码"}
                  </span>
                  <input
                    className="form__input"
                    type="password"
                    value={form.secret}
                    autoComplete="new-password"
                    placeholder={editingId ? "留空表示不修改" : ""}
                    onChange={(event) => setForm({ ...form, secret: event.target.value })}
                  />
                  <span className="form__hint">
                    {editingId ? SECRET_HINT_SET : SECRET_HINT_NEW}
                  </span>
                </label>
              </div>

              {/*
                执行限制（开发者 Jan）：这台机器的红线，模型每次对它发起远程调用时
                随调用结果回灌进上下文。生产机与测试机的红线不同，所以按主机各存一条
              */}
              <div className="form__section">
                <div className="form__section-title">执行限制</div>
                <label className="form__row">
                  <span className="form__label">禁止执行的命令与操作</span>
                  <textarea
                    className="form__textarea"
                    rows={5}
                    value={form.guardPrompt}
                    placeholder={
                      "如：禁止 rm -rf 与任何删除类操作；禁止 systemctl stop / reboot；" +
                      "禁止修改 /etc 下配置；改配置前必须先备份"
                    }
                    onChange={(event) => setForm({ ...form, guardPrompt: event.target.value })}
                  />
                  <span className="form__hint">
                    {`模型每次对这台主机发起调用时，这段限制会随执行结果一并回灌进上下文（上限 ${SSH_GUARD_PROMPT_LIMIT} 字，当前 ${form.guardPrompt.trim().length} 字）。`}
                    它是提示层约束，最终兜底仍是人工审批与内置的危险命令拒绝清单；留空表示不限制。
                  </span>
                </label>
              </div>

              {/* 状态：启用即把工具挂给模型 */}
              <div className="form__section">
                <div className="form__section-title">状态</div>
                <div className="form__toggle-row">
                  <div>
                    <div className="form__label">启用该主机</div>
                    <div className="form__hint">启用后模型可对这台机器执行命令与读写文件，每次调用仍需人工审批</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={form.enabled}
                    aria-label="启用该主机"
                    className={form.enabled ? "switch switch--on" : "switch"}
                    onClick={() => setForm({ ...form, enabled: !form.enabled })}
                  >
                    <span className="switch__knob" />
                  </button>
                </div>
              </div>

              <div className="form__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={mutating}
                  onClick={() => setFormOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={mutating || !canSubmit}
                  onClick={() => void submit()}
                >
                  {mutating ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          ) : null}

          {hosts.length === 0 ? (
            <div className="card">
              <div className="card__desc">
                {loading ? "正在读取远程主机配置…" : "还没有配置远程主机。新建一条并填写连接信息即可。"}
              </div>
            </div>
          ) : (
            <div className="card-grid">
              {hosts.map((host) => {
                const test = testResults[host.id];
                return (
                  <div className="card ssh-card" key={host.id}>
                    <div className="card__head">
                      <Icon name="terminal" size={14} />
                      <span className="card__title">{host.name}</span>
                      <span className="spacer" />
                      <span className={host.enabled ? "badge badge--ok" : "badge"}>
                        {host.enabled ? "已启用" : "已停用"}
                      </span>
                    </div>

                    {/* 连接地址是这张卡片的主信息，独占一行、字号大一级 */}
                    <div className="ssh-card__endpoint mono">
                      {`${host.username}@${host.host}:${host.port}`}
                    </div>

                    {/* 原先三行同权重的灰字压成一行标签，层级更清楚 */}
                    <div className="ssh-card__meta">
                      <span className="badge">{host.auth === "key" ? "私钥认证" : "密码认证"}</span>
                      <span className="badge">{host.hasSecret ? "已保存凭据" : "未保存凭据"}</span>
                      <span className={host.hostKeyFingerprint ? "badge badge--ok" : "badge"}>
                        {host.hostKeyFingerprint ? "已建立信任" : "未建立信任"}
                      </span>
                      {/* 不打开编辑也能看出哪台机器有红线：完整内容悬停查看 */}
                      <span
                        className={host.guardPrompt ? "badge badge--warn" : "badge"}
                        title={host.guardPrompt ?? undefined}
                      >
                        {host.guardPrompt ? "已设执行限制" : "无执行限制"}
                      </span>
                    </div>

                    {/*
                      指纹单独成块（开发者 Jan）：完整值无空格、不会自动折行，铺在窄卡片里必然
                      冲出边界，因此块内只显示首尾摘要，悬停看全文、按钮复制完整值。
                    */}
                    {host.hostKeyFingerprint ? (
                      <div className="ssh-card__fingerprint">
                        <span className="ssh-card__fingerprint-label">指纹</span>
                        <code className="ssh-card__fingerprint-value" title={host.hostKeyFingerprint}>
                          {abbreviateFingerprint(host.hostKeyFingerprint)}
                        </code>
                        <button
                          type="button"
                          className="icon-btn icon-btn--sm"
                          aria-label="复制完整指纹"
                          title={copiedFingerprint === host.id ? "已复制完整指纹" : "复制完整指纹"}
                          onClick={() => void copyFingerprint(host)}
                        >
                          <Icon name={copiedFingerprint === host.id ? "check" : "copy"} size={13} />
                        </button>
                      </div>
                    ) : (
                      <div className="ssh-card__note">尚未建立信任：首次连接成功时记录主机密钥指纹</div>
                    )}

                    {/* 凭据缺失是需要用户处理的，单独提示，不混在标签里 */}
                    {!host.hasSecret ? (
                      <div className="ssh-card__note">
                        {host.auth === "key"
                          ? "使用本机私钥文件（若私钥有口令，需在编辑里填写）"
                          : "尚未保存密码，连接会失败，请编辑后填写"}
                      </div>
                    ) : null}

                    {test ? (
                      <div className={test.ok ? "ssh-card__note" : "ssh-card__note ssh-card__note--fail"}>
                        {`${test.ok ? "连接成功" : "连接失败"}：${test.message}`}
                      </div>
                    ) : null}

                    <div className="ssh-card__actions">
                      <button
                        type="button"
                        className={host.enabled ? "btn btn--ghost btn--sm" : "btn btn--primary btn--sm"}
                        disabled={mutating}
                        onClick={() => void toggleHost(host.id)}
                      >
                        {host.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={testingId === host.id || !cachePath}
                        onClick={() => void runTest(host)}
                      >
                        {testingId === host.id ? "测试中…" : "测试连接"}
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => openEdit(host)}>
                        编辑
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" disabled={mutating} onClick={() => void remove(host)}>
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
