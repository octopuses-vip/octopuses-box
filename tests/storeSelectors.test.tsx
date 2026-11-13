import assert from "node:assert/strict";
import test from "node:test";
import { selectModelConnectionByCode } from "../src/app/storeSelectors";

/** 构造带一个授权模型的 store 状态切片。 */
function stateWith(models: unknown[]) {
  return { remoteModels: models, imageInputEnabled: false } as never;
}

test("按 code 选中模型时返回完整连接信息而非崩溃", () => {
  const connection = selectModelConnectionByCode(
    stateWith([{ code: "m1", name: "测试模型", baseUrl: "https://example.com/v1", apiKey: "sk-test" }]),
    "m1",
  );
  assert.ok(connection);
  assert.equal(connection.modelId, "m1");
  assert.equal(connection.url, "https://example.com/v1");
  assert.equal(connection.key, "sk-test");
});

test("空选择码与未知 code 均返回 null，不进入派生逻辑", () => {
  const state = stateWith([{ code: "m1", name: "测试模型", baseUrl: "https://example.com/v1", apiKey: "sk-test" }]);
  assert.equal(selectModelConnectionByCode(state, ""), null);
  assert.equal(selectModelConnectionByCode(state, "missing"), null);
  assert.equal(selectModelConnectionByCode(stateWith([]), "m1"), null);
});
