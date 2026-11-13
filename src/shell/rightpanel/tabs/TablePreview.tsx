import { useAppStore } from "../../../app/state";
import { Icon } from "../../../components/Icon";

/** 表格最多渲染的数据行数，超出部分只提示不渲染，避免大文件把界面卡死 */
const MAX_ROWS = 500;

/**
 * 解析 CSV 文本为二维数组。
 *
 * 按 RFC 4180 处理双引号：引号内的逗号与换行都属于字段内容，`""` 表示一个字面双引号；
 * 行尾的 `\r\n` 与 `\n` 都算换行。全空行会被丢掉，避免结尾换行多出一行空行。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

/** 表格预览：把 CSV 产物渲染成表格，首行视为表头 */
export function TablePreview() {
  const activeArtifact = useAppStore((state) => state.activeArtifact);

  if (!activeArtifact) {
    return <div className="panel-empty">点击上方文件查看内容</div>;
  }

  const rows = parseCsv(activeArtifact.content);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const visible = body.slice(0, MAX_ROWS);

  return (
    <div className="file-preview file-preview--fill">
      <div className="file-preview__head">
        <Icon name="file" size={13} />
        <span>{activeArtifact.name}</span>
        <span className="spacer" />
        <span className="badge">{body.length} 行</span>
      </div>
      <div className="table-preview">
        <table className="table-preview__table">
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((cells, rowIndex) => (
              <tr key={rowIndex}>
                {header.map((_, cellIndex) => (
                  <td key={cellIndex}>{cells[cellIndex] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {body.length > visible.length ? (
        <div className="panel-empty">
          仅展示前 {MAX_ROWS} 行，完整内容请查看 {activeArtifact.name}
        </div>
      ) : null}
    </div>
  );
}