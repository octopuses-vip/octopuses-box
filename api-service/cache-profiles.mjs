import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Desktop-written values are JSON strings. Hand-written files can also use plain or single-quoted values. */
function readScalar(value) {
  if (value.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(value)?.[1];
    if (!quoted) throw new Error('配置字段的双引号格式无效');
    return JSON.parse(quoted);
  }
  if (value.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value)?.[1];
    if (quoted === undefined) throw new Error('配置字段的单引号格式无效');
    return quoted.replace(/''/g, "'");
  }
  return value.replace(/(?:^|\s)#.*$/, '').trim();
}

/** Parse known top-level string fields and keep the document body separate from metadata. */
function parseProfile(text, keys) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  if (lines[first]?.trimEnd() !== '---') return { instructions: lines.join('\n').trim() };
  const end = lines.findIndex((line, index) => index > first && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) throw new Error('文件缺少 frontmatter 结束行');
  const fields = {};
  for (let i = first + 1; i < end; i++) {
    const match = /^([a-zA-Z]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!match || !keys.includes(match[1]) || Object.hasOwn(fields, match[1])) continue;
    const [, key, raw] = match;
    const block = /^([>|])([1-9])?[+-]?(?:\s+#.*)?$/.exec(raw.trim());
    if (!block) {
      fields[key] = readScalar(raw.trim());
      continue;
    }
    const content = [];
    while (i + 1 < end && (!lines[i + 1].trim() || lines[i + 1].startsWith(' '))) {
      content.push(lines[++i]);
    }
    const indent = Number(block[2] ?? /^ */.exec(content.find((line) => line.trim()) ?? '')[0].length);
    const trimmed = content.map((line) => line.slice(indent));
    fields[key] = (block[1] === '>' ? trimmed.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : trimmed.join('\n')).trim();
  }
  return { ...fields, instructions: lines.slice(end + 1).join('\n').trim() };
}

/** Read installed desktop profiles, distinguishing a missing folder from one that has been emptied. */
export async function readCachedProfiles(cacheDirectory, { directory, fileName, keys, normalize }) {
  if (!cacheDirectory) return null;
  const root = join(cacheDirectory, directory);
  let folders;
  try { folders = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const profiles = [];
  for (const folder of folders.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!folder.isDirectory() || folder.name.startsWith('.') || folder.name !== folder.name.trim()) continue;
    const file = join(root, folder.name, fileName);
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile()) continue;
      if (metadata.size > 1024 * 1024) throw new Error('配置文件超过 1 MiB');
      const parsed = parseProfile(await readFile(file, 'utf8'), keys);
      const record = normalize(folder.name, parsed);
      if (record) profiles.push(record);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`跳过无法加载的 ${fileName} ${JSON.stringify(folder.name)}`);
    }
  }
  return profiles;
}
