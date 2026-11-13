import type { DiffFile } from "../../app/types";
import { DiffView } from "../../components/DiffView";
import { Icon } from "../../components/Icon";

interface DiffCardProps {
  files: DiffFile[];
}

/**
 * 差异汇总卡片（开发者 Jan）：标题栏给出「改了 N 个文件 +增 -删」，下方复用 [`DiffView`] 逐文件展示。
 *
 * 增删行数由各文件累加而来，只用于概览；具体改动仍以 DiffView 的逐行内容为准。
 */
export function DiffCard({ files }: DiffCardProps) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div className="diff-card">
      <div className="diff-card__head">
        <Icon name="diff" size={14} />
        <span>已修改 {files.length} 个文件</span>
        <span className="stat-add">+{additions}</span>
        <span className="stat-del">-{deletions}</span>
      </div>
      <DiffView files={files} />
    </div>
  );
}
