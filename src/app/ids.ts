/** 进程内自增序号（开发者 Jan）：与时间戳拼合后保证同一毫秒内多次生成也不重复 */
let counter = 0;

/** 生成稳定的前端唯一 id（开发者 Jan）；仅用于界面渲染的 key 与事件定位，不参与后端主键 */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}-${Date.now().toString(36)}`;
}
