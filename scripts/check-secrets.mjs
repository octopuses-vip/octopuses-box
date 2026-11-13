/** 只报告文件、行号和规则，不输出匹配到的秘密。可用 --history 扫描所有本地 refs 可达的 blob。 */
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoIndex = process.argv.indexOf("--repo");
if (repoIndex >= 0 && !process.argv[repoIndex + 1]) throw new Error("--repo 需要仓库路径");
const cwd = repoIndex >= 0 ? resolve(process.argv[repoIndex + 1]) : fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd, maxBuffer: 128 * 1024 * 1024 });
const rules = [
  ["private-key", new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")],
  ["model-api-key", new RegExp("\\bsk-" + "[A-Za-z0-9_-]{24,}")],
  ["github-token", new RegExp("\\bgh[pousr]_" + "[A-Za-z0-9]{25,}")],
  ["aws-access-key", new RegExp("\\bAKIA" + "[A-Z0-9]{16}")],
];
let findings = 0;
function scan(bytes, label) {
  if (bytes.includes(0)) return;
  bytes.toString("utf8").split("\n").forEach((line, index) => {
    for (const [name, pattern] of rules) if (pattern.test(line)) {
      console.error(`${label}:${index + 1}: ${name} (redacted)`);
      findings++;
    }
  });
}
if (process.argv.includes("--history")) {
  const objects = git("rev-list", "--objects", "--all").toString().split("\n").filter(Boolean);
  const types = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    cwd, input: objects.map(row => row.split(" ")[0]).join("\n") + "\n", maxBuffer: 128 * 1024 * 1024,
  }).toString().split("\n");
  for (const row of types) {
    const [oid, type] = row.split(" ");
    if (type === "blob") scan(git("cat-file", "blob", oid), `blob:${oid}`);
  }
} else {
  const tracked = git("ls-files", "-z").toString().split("\0").filter(Boolean);
  const added = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean);
  for (const path of new Set([...tracked, ...added])) {
    try {
      const full = resolve(cwd, path);
      if (lstatSync(full).isFile()) scan(readFileSync(full), path);
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
console.log(findings ? `发现 ${findings} 个疑似秘密；请人工复核。` : "未发现已知格式秘密；仍需独立审计通用密码与历史构建产物。");
process.exitCode = findings ? 1 : 0;
