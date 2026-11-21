import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { ApiError } from './http.mjs';
import { createApiService } from './server.mjs';

/** Reuse the selected desktop cache's local model configuration on each request. */
async function localModels(cacheDirectory, signal) {
  try {
    const models = JSON.parse(await readFile(join(cacheDirectory, 'models.json'), { encoding: 'utf8', signal }));
    if (!Array.isArray(models)) throw new Error('Invalid model list');
    return models.filter((model) => typeof model?.code === 'string' && model.code.trim()).map((model) => ({
      ...model, code: model.code.trim(),
      baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl.trim() : '',
    }));
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') return [];
    throw new ApiError(503, 'local_models_unavailable', '无法读取桌面端本地模型配置，请在客户端设置中检查 models.json。');
  }
}

/** Accept one private configuration message. Closing the parent pipe stops the service even after a crash. */
async function run() {
  const pipe = createInterface({ input: process.stdin, terminal: false });
  let parentClosed = false;
  const disconnected = once(pipe, 'close').then(() => { parentClosed = true; });
  const line = await Promise.race([once(pipe, 'line').then(([value]) => value), disconnected.then(() => null)]);
  if (line === null) return;
  const { cacheDirectory, dataDirectory, managementUrl, managementSessionToken, local } = JSON.parse(line);
  if (typeof cacheDirectory !== 'string' || !isAbsolute(cacheDirectory) ||
      typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory)) throw new Error('桌面端缓存路径无效。');
  const service = await createApiService({
    directory: dataDirectory,
    cacheDirectory, managementUrl, managementSessionToken,
    modelCatalog: local ? (signal) => localModels(cacheDirectory, signal) : undefined,
    host: '127.0.0.1', port: 0,
  });
  try {
    if (!parentClosed) process.stdout.write(JSON.stringify({ port: service.address.port, token: service.token }) + '\n');
    await disconnected;
  } finally {
    await service.close();
    pipe.close();
  }
}

try { await run(); }
catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
  process.stdin.destroy();
  process.exitCode = 1;
}
