// Package the build machine's matching Node runtime so the installed host has no Node prerequisite.
import { copyFile, chmod, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Packaging the companion requires Node.js 22 or newer');
const output = path.join(root, 'src-tauri/runtime'); await mkdir(output, { recursive: true });
const executable = path.join(output, process.platform === 'win32' ? 'node.exe' : 'node');
const candidates = [process.env.OCTOPUSES_NODE_LICENSE, path.join(path.dirname(process.execPath), 'LICENSE'), path.join(path.dirname(process.execPath), '../LICENSE')].filter(Boolean);
let license;
for (const candidate of candidates) { try { await access(candidate); license = candidate; break; } catch {} }
if (!license) throw new Error('Node LICENSE was not found; set OCTOPUSES_NODE_LICENSE to the matching distribution LICENSE');
await copyFile(process.execPath, executable); await copyFile(license, path.join(output, 'NODE-LICENSE.txt'));
if (process.platform !== 'win32') await chmod(executable, 0o755);
console.log(`Prepared Node ${process.versions.node} (${process.platform}/${process.arch}) and its license for the desktop bundle.`);
