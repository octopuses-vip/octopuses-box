import type { MessageAttachment } from "../app/types";
import type { AttachmentResult } from "./attachments";
import type { AudioFile } from "../audio/files";

export interface AttachmentBatch {
  files: AudioFile[];
  failed: string[];
}

interface DraftSnapshot {
  attachments: MessageAttachment[];
  pending: number;
  notice: string | null;
}

/** 附件读取与发送之间的交接点；同步记录未完成的批次，发送前等待全部读取结束。 */
export class AttachmentDraft {
  private snapshot: DraftSnapshot = { attachments: [], pending: 0, notice: null };
  private listeners = new Set<() => void>();
  private jobs = new Set<Promise<void>>();

  getSnapshot = (): DraftSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<DraftSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  add(batch: Promise<AttachmentBatch>, read: (file: AudioFile) => Promise<AttachmentResult>): void {
    const job = this.readBatch(batch, read).finally(() => {
      this.jobs.delete(job);
      this.update({ pending: this.jobs.size });
    });
    this.jobs.add(job);
    this.update({ pending: this.jobs.size });
  }

  private async readBatch(batch: Promise<AttachmentBatch>, read: (file: AudioFile) => Promise<AttachmentResult>): Promise<void> {
    const added: MessageAttachment[] = [];
    const rejected: string[] = [];
    try {
      const { files, failed } = await batch;
      for (const file of files) {
        try {
          const result = await read(file);
          if (result.ok) added.push(result.attachment);
          else rejected.push(result.reason);
        } catch (error) {
          rejected.push(`${file.name} 读取失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failed.length > 0) rejected.push(`${failed.join("、")} 读取失败，未添加（不支持文件夹）`);
    } catch (error) {
      rejected.push(`附件读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    this.update({
      attachments: [...this.snapshot.attachments, ...added],
      notice: rejected.length > 0 ? rejected.join("；") : null,
    });
  }

  async ready(): Promise<void> {
    // 等待期间可能又拖入一个批次，不能只等待进入函数时的那一份快照。
    while (this.jobs.size > 0) await Promise.all([...this.jobs]);
  }

  remove(id: string): void {
    this.update({ attachments: this.snapshot.attachments.filter((item) => item.id !== id) });
  }

  sent(attachments: MessageAttachment[]): void {
    const sentIds = new Set(attachments.map((item) => item.id));
    this.update({
      attachments: this.snapshot.attachments.filter((item) => !sentIds.has(item.id)),
      notice: null,
    });
  }

  restore(attachments: MessageAttachment[]): void {
    const existing = new Set(this.snapshot.attachments.map((item) => item.id));
    this.update({ attachments: [...this.snapshot.attachments, ...attachments.filter((item) => !existing.has(item.id))], notice: "排队请求已取消，内容已恢复到本会话草稿。" });
  }
}
