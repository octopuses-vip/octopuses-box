/** 桌面适配层：ssh。运行环境差异在此处理，界面只调用公开函数。 */
import {
  type SshHost,
  type SshSecretStatus,
  type SshHostInput,
  type SshTestResult,
  type SshExecResult,
  type SshDirEntry,
  type SshFileContent,
} from "../types";
import { isDesktopRuntime } from "./runtime";

/* ============================ 远程主机（SSH） ============================ */

/**
 * SSH 远程运维：主机配置落盘在缓存目录的 `ssh/hosts.json`，密码/私钥口令存系统凭据管理器。
 *
 * 建连、执行与 SFTP 都由 Rust 侧完成，因此全部能力仅在桌面端可用；
 * 浏览器演示环境退化为「无主机、调用失败」，不伪造成功结果。
 */
export function requireDesktopSsh(): void {
  if (!isDesktopRuntime()) throw new Error("远程主机管理仅在桌面端可用，请在桌面端运行。");
}

/** 列出全部远程主机（已脱敏，不含任何凭据） */
export async function listSshHosts(cachePath: string | null): Promise<SshHost[]> {
  if (!cachePath || !isDesktopRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshHost[]>("ssh_list_hosts", { cacheDir: cachePath });
}

/** 查询本机凭据管理器可用性与某主机的凭据状态 */
export async function sshHostSecretStatus(hostId: string): Promise<SshSecretStatus> {
  if (!isDesktopRuntime()) return { available: false, hasSecret: false };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshSecretStatus>("ssh_host_secret_status", { hostId });
}

/** 新增或更新一条远程主机；同 id 覆盖需 input.overwrite 为 true */
export async function saveSshHost(cachePath: string | null, input: SshHostInput): Promise<SshHost[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法保存远程主机。");
  requireDesktopSsh();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshHost[]>("ssh_save_host", { cacheDir: cachePath, input });
}

/** 删除一条远程主机（同时清除其系统凭据） */
export async function deleteSshHost(cachePath: string | null, id: string): Promise<SshHost[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法删除远程主机。");
  requireDesktopSsh();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshHost[]>("ssh_delete_host", { cacheDir: cachePath, input: { id } });
}

/** 测试连接：建连 + 认证，成功后回填首次信任的主机密钥指纹 */
export async function testSshConnection(
  cachePath: string | null,
  hostId: string,
): Promise<SshTestResult> {
  if (!cachePath) return { ok: false, message: "尚未配置缓存目录，无法测试连接。", fingerprint: null };
  if (!isDesktopRuntime()) {
    return { ok: false, message: "远程连接仅在桌面端可用，请在桌面端运行。", fingerprint: null };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshTestResult>("ssh_test_connection", { cacheDir: cachePath, hostId });
}

/** 在远端执行命令；失败原因作为可读文本抛出，由调用方转为工具结果 */
export async function sshExec(
  cachePath: string | null,
  hostId: string,
  command: string,
  timeoutSecs: number,
): Promise<SshExecResult> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法执行远程命令。");
  requireDesktopSsh();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshExecResult>("ssh_exec", { cacheDir: cachePath, hostId, command, timeoutSecs });
}

/** 列出远端目录 */
export async function sshListDir(
  cachePath: string | null,
  hostId: string,
  path: string,
): Promise<SshDirEntry[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法列出远端目录。");
  requireDesktopSsh();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshDirEntry[]>("ssh_list_dir", { cacheDir: cachePath, hostId, path });
}

/** 读取远端文件内容 */
export async function sshReadFile(
  cachePath: string | null,
  hostId: string,
  path: string,
): Promise<SshFileContent> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法读取远端文件。");
  requireDesktopSsh();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshFileContent>("ssh_read_file", { cacheDir: cachePath, hostId, path });
}

/** 写入远端文件；返回可读的成功说明 */
export async function sshWriteFile(
  cachePath: string | null,
  hostId: string,
  path: string,
  content: string,
): Promise<string> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法写入远端文件。");
  requireDesktopSsh();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("ssh_write_file", { cacheDir: cachePath, hostId, path, content });
}
