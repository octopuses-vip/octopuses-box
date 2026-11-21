import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from '../companion/storage.mjs';
import { readCachedProfiles } from './cache-profiles.mjs';
import { requiredText } from './providers.mjs';

/** Apply the same limits to imported desktop profiles and hand-written API configuration. */
function profile(entry) {
  return {
    id: requiredText(entry?.id, 'Agent id', 80),
    name: requiredText(entry.name, 'Agent name'),
    model: entry.model == null || entry.model === '' ? null : requiredText(entry.model, 'Agent model'),
    instructions: entry.instructions === '' ? '' : requiredText(entry.instructions, 'Agent instructions', 24_000),
  };
}

/** Normalize a config once so lookups and exposed IDs always agree. */
function agentCatalog(entries) {
  if (!Array.isArray(entries)) throw new Error('Agent 配置必须是 JSON 数组。');
  const catalog = new Map();
  for (const entry of entries) {
    const agent = profile(entry);
    if (catalog.has(agent.id)) throw new Error(`Agent ID 重复：${agent.id}`);
    catalog.set(agent.id, agent);
  }
  return catalog;
}

/** A manual config takes precedence. Keep the generated snapshot in the service data directory. */
export async function loadAgentCatalog({ entries, configFile, cacheDirectory, directory }) {
  if (entries !== undefined) return { catalog: agentCatalog(entries) };
  if (configFile) return { catalog: agentCatalog(JSON.parse(await readFile(configFile, 'utf8'))) };

  const file = join(directory, 'agents.generated.json');
  if (cacheDirectory === null) {
    await rm(file, { force: true });
    return { catalog: new Map() };
  }
  const profiles = await readCachedProfiles(cacheDirectory, {
    directory: 'agents', fileName: 'AGENT.md', keys: ['name', 'model'],
    normalize: (id, parsed) => profile({
      id, name: parsed.name?.trim() || id, model: parsed.model?.trim(), instructions: parsed.instructions,
    }),
  });
  if (profiles === null) {
    // The service can be restarted on a machine where the desktop directory is not available.
    try {
      const catalog = agentCatalog(JSON.parse(await readFile(file, 'utf8')));
      return { catalog, generated: { file, count: catalog.size, restored: true } };
    } catch (error) {
      if (error.code === 'ENOENT') return { catalog: new Map() };
      throw error;
    }
  }
  const catalog = agentCatalog(profiles);
  if (catalog.size === 0) {
    await rm(file, { force: true });
    return { catalog };
  }
  await atomicJSON(file, [...catalog.values()]);
  return { catalog, generated: { file, count: catalog.size } };
}
