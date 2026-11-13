/**
 * `occt-import-js` 的类型声明（开发者 Jan）。
 *
 * 上游包只发布编译好的 JS 与 WASM，不带类型，因此在这里按实际使用到的接口补一份最小声明：
 * 只需覆盖「加载工厂 + 两个读取入口 + 网格结构」，不必照抄整个 OpenCascade 接口。
 * 网格结构以官方 README 与 `examples/three_viewer.html` 的用法为准。
 */

declare module "occt-import-js" {
  /** 一组顶点属性；`position` 必有，`normal` 视模型而定 */
  export interface OcctMeshAttributes {
    /** 顶点坐标，按 xyz 依次排列 */
    position: { array: number[] };
    /** 顶点法线；部分模型（尤其是 IGES）不带，需要前端自行计算 */
    normal?: { array: number[] };
  }

  /** 一个可渲染的网格（对应图纸里的一个面组） */
  export interface OcctMesh {
    /** 网格名，可用于排查是图纸里的哪个部件 */
    name: string;
    /** 该网格的颜色，分量为 0-1 的 RGB；未指定时由前端取缺省色 */
    color?: [number, number, number];
    attributes: OcctMeshAttributes;
    /** 三角面索引；缺省时按顶点顺序连续成面 */
    index?: { array: number[] };
  }

  /** 一次解析的结果 */
  export interface OcctResult {
    success: boolean;
    meshes: OcctMesh[];
  }

  /** 加载后可用的模块实例 */
  export interface OcctModule {
    /** 解析 STEP；第二个参数为可选参数表，这里不使用 */
    ReadStepFile(buffer: Uint8Array, params: unknown): OcctResult;
    /** 解析 IGES；参数同上 */
    ReadIgesFile(buffer: Uint8Array, params: unknown): OcctResult;
  }

  export interface OcctInitOptions {
    /** 由打包器给出的 WASM 地址，避免运行时去网络上找（离线可用） */
    locateFile?: (path: string) => string;
  }

  /** 工厂：调用后返回一个 Promise，解析出模块实例 */
  export default function createOcct(options?: OcctInitOptions): Promise<OcctModule>;
}
