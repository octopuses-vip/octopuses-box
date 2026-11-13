import type { InferenceSession } from "onnxruntime-web";
import type { Tokenizer } from "@huggingface/tokenizers";
import { cvAssetUrl } from "../cv/registry";
let loaded: Promise<{ session: InferenceSession; tokenizer: Tokenizer }> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** 函数级说明（开发者 Jan）：执行 load 的单一职责，并返回可供调用方继续处理的结果。 */
async function load() {
  if (!loaded) loaded = (async () => {
    const [{ invoke }, ort, { Tokenizer }] = await Promise.all([
      import("@tauri-apps/api/core"), import("onnxruntime-web"), import("@huggingface/tokenizers"),
    ]);
    const [model, tokenizerJson, configJson] = await Promise.all([
      invoke<ArrayBuffer>("knowledge_model_asset", { name: "onnx/model_quantized.onnx" }),
      invoke<ArrayBuffer>("knowledge_model_asset", { name: "tokenizer.json" }),
      invoke<ArrayBuffer>("knowledge_model_asset", { name: "tokenizer_config.json" }),
    ]);
    const assetUrl = (name: string) => new URL(cvAssetUrl(name), window.location.href).href;
    ort.env.wasm.wasmPaths = {
      // 使用 .js 别名，避开部分桌面 WebView 对 .mjs 的 HTML MIME 回退。
      mjs: assetUrl("ort-wasm-simd-threaded.js"),
      wasm: assetUrl("ort-wasm-simd-threaded.wasm"),
    };
    ort.env.wasm.numThreads = 1;
    // macOS WKWebView 的代理 worker 没有浏览器 window，全局 proxy 会导致 WASM 后端初始化失败。
    // 知识库索引本身已通过 queue 串行执行，主线程推理不会引入并发竞争。
    ort.env.wasm.proxy = false;
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"] });
    const tokenizer = new Tokenizer(JSON.parse(new TextDecoder().decode(tokenizerJson)), JSON.parse(new TextDecoder().decode(configJson)));
    return { session, tokenizer };
  })().catch((error) => { loaded = null; throw error; });
  return loaded;
}

/** 一次只推理一个片段；与查询共用队列，避免并发 session.run。 */
export function embedText(text: string, query = false): Promise<number[]> {
  const result = queue.then(async () => {
    const { session, tokenizer } = await load();
    return inferEmbedding(session, tokenizer, text, query);
  });
  queue = result.catch(() => {});
  return result;
}

/** 与资源加载分离，可用真实模型离线验收同一套分词、CLS pooling 与归一化流程。 */
export async function inferEmbedding(session: InferenceSession, tokenizer: Tokenizer, text: string, query = false): Promise<number[]> {
    const ort = await import("onnxruntime-web");
    const encoded = tokenizer.encode(query ? `为这个句子生成表示以用于检索相关文章：${text}` : text, { return_token_type_ids: true });
    if (encoded.ids.length > 512) throw new Error("文本超过向量模型的 512 token 上限，请缩短后重试");
    const values: Record<string, number[]> = { input_ids: encoded.ids, attention_mask: encoded.attention_mask, token_type_ids: encoded.token_type_ids };
    const inputs: Record<string, import("onnxruntime-web").Tensor> = {};
    for (const name of session.inputNames) {
      if (!values[name]) throw new Error(`不支持的模型输入：${name}`);
      inputs[name] = new ort.Tensor("int64", BigInt64Array.from(values[name], BigInt), [1, encoded.ids.length]);
    }
    const outputs = await session.run(inputs);
    const output = outputs.last_hidden_state ?? outputs[session.outputNames[0]];
    if (output.dims.at(-1) !== 512 || !(output.data instanceof Float32Array)) throw new Error("模型输出格式不匹配");
    const cls = Array.from(output.data.subarray(0, 512));
    const norm = Math.sqrt(cls.reduce((sum, v) => sum + v * v, 0));
    if (!norm || !Number.isFinite(norm)) throw new Error("模型生成了无效向量");
    return cls.map((v) => v / norm);
}

/** 函数级说明（开发者 Jan）：执行 releaseEmbedding 的单一职责，并返回可供调用方继续处理的结果。 */
export async function releaseEmbedding() {
  const previous = loaded;
  loaded = null;
  await queue;
  if (previous) { try { await (await previous).session.release(); } catch { /* 失败的加载无需释放 */ } }
}
