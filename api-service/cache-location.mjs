import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const cacheKey = 'OCTOPUSES_API_CACHE_DIR';

/** Read the cache location exported by the desktop client without opening its WebView storage. */
async function desktopCacheDirectory(home) {
  const file = join(home, '.octopuses', 'cache-location.json');
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('无法读取桌面端保存的缓存位置。', { cause: error });
  }
  const path = value?.cachePath;
  if (path === null) return null;
  if (typeof path === 'string' && isAbsolute(path) && !path.includes('\0')) return path;
  throw new Error('桌面端保存的缓存位置无效。');
}

/** Preserve an explicitly supplied value, including an empty setting that disables cache discovery. */
function explicitDirectory(value) {
  return value.trim() ? resolve(value) : null;
}

/** Encode a path without letting spaces, comment markers or Windows separators alter its value. */
function encodeEnvLine(path) {
  for (const quote of ["'", '"', '`']) {
    if (path.includes(quote)) continue;
    const line = `${cacheKey}=${quote}${path}${quote}\n`;
    if (parseEnv(line)[cacheKey] === path) return line;
  }
  throw new Error('缓存目录路径无法写入 .env。');
}

/** Append only the missing setting, leaving credentials, comments and other lines intact. */
async function saveDiscoveredDirectory(envFile, path) {
  const line = encodeEnvLine(path);
  const file = await open(envFile, 'a+', 0o600);
  try {
    const previous = await file.readFile('utf8');
    const configured = parseEnv(previous)[cacheKey];
    if (configured !== undefined) return explicitDirectory(configured);
    await file.writeFile((previous && !previous.endsWith('\n') ? '\n' : '') + line, 'utf8');
    return path;
  } finally {
    await file.close();
  }
}

/** Use startup environment first and persist an existing desktop directory only when no override was set. */
export async function configureCacheDirectory(configured, { home = homedir(), envFile = '.env' } = {}) {
  if (configured !== undefined) return explicitDirectory(configured);
  const path = await desktopCacheDirectory(home);
  if (!path) return path;
  try {
    if ((await stat(path)).isDirectory()) return await saveDiscoveredDirectory(envFile, path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return path;
}
