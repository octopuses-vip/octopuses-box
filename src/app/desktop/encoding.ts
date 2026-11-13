/** 桌面适配层：encoding。运行环境差异在此处理，界面只调用公开函数。 */

/** base64 文本解成字节，供 Blob 预览使用 */
export function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** base64 文本对应的原始字节数（用于浏览器演示环境统计产物大小） */
export function base64ByteLength(encoded: string): number {
  const trimmed = encoded.replace(/=+$/, "").length;
  return Math.floor((trimmed * 3) / 4);
}
