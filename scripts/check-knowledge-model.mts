/** 真实离线模型验收：tsx scripts/check-knowledge-model.mts <模型资源目录>，不下载或修改用户设置。 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { Tokenizer } from "@huggingface/tokenizers";
import { inferEmbedding } from "../src/knowledge/embedding";

const root = process.argv[2];
if (!root) throw new Error("请提供已下载并校验的模型资源目录");
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = fileURLToPath(new URL("../node_modules/onnxruntime-web/dist/", import.meta.url));
const tokenizer = new Tokenizer(
  JSON.parse(await readFile(`${root}/tokenizer.json`, "utf8")),
  JSON.parse(await readFile(`${root}/tokenizer_config.json`, "utf8")),
);
const start = performance.now();
const session = await ort.InferenceSession.create(new Uint8Array(await readFile(`${root}/onnx/model_quantized.onnx`)), { executionProviders: ["wasm"] });
try {
  const query = await inferEmbedding(session, tokenizer, "退钱需要几天", true);
  const relevant = await inferEmbedding(session, tokenizer, "客户提交申请后，工作人员在三个工作日内确认退款。");
  const unrelated = await inferEmbedding(session, tokenizer, "前端界面使用浅色主题，按钮位于输入框右侧。");
  const score = (vector: number[]) => vector.reduce((sum, value, index) => sum + value * query[index], 0);
  assert.equal(query.length, 512);
  assert.ok(query.every(Number.isFinite));
  assert.ok(score(relevant) > score(unrelated));
  assert.ok(score(relevant) >= .4);
  console.log(JSON.stringify({ dimensions: query.length, relevant: score(relevant), unrelated: score(unrelated), elapsedMs: Math.round(performance.now() - start) }));
} finally { await session.release(); }
