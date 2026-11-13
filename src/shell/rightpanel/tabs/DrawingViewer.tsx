/**
 * 3D 图纸查看器（开发者 Jan）。
 *
 * 用 OpenCascade 的 WASM（`occt-import-js`）把 STEP / IGES 解析成三角网格，再用 `three`
 * 手绘一遍。三条约束决定了这里的写法：
 *   1. 解析器与渲染器都很大，一律动态 import，不进主包，打开界面本身不受影响；
 *   2. WASM 地址由打包器给出（`?url`），离线也能用，不依赖网络；
 *   3. 图纸的坐标原点与尺寸完全不可预期，相机必须按整体包围盒自适应。
 * DWG 没有可用的前端解析方案，注册表把它标成不可解析，这里只呈现引导文案。
 */

import { useEffect, useRef, useState } from "react";

import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import type { OcctMesh, OcctModule } from "occt-import-js";
import type { BufferGeometry, Material } from "three";

import { Icon } from "../../../components/Icon";
import { registerDrawingCapture, type DrawingCaptureResult } from "../../../model/drawingCapture";
import { blobToBase64 } from "../../../model/toolImage";
import { readDrawingBytes, type DrawingEntry } from "../../../model/drawingSources";

type ThreeNS = typeof import("three");
type OrbitControlsCtor =
  typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;

/** 透视相机的视场角（度） */
const FIELD_OF_VIEW = 45;
/** 包围球半径的下限：退化成一点（或空模型）时也要给出可用的机位 */
const MIN_RADIUS = 0.001;
/** 取景余量：把包围球完整框进视锥后再留一点边，避免模型贴着画面边缘 */
const FRAMING_MARGIN = 1.25;
/** 相机相对轨道中心的初始方向（等轴测视角），使用前会归一化 */
const CAMERA_DIRECTION = { x: 0.75, y: 0.6, z: 1 };
/** 图纸未指定颜色时的缺省材质色：中性灰，明暗关系仍可辨认 */
const DEFAULT_COLOR = 0x9aa4b2;

/** 查看器的加载状态：`idle` 表示该格式本就不解析，只展示引导 */
type ViewerStatus = "loading" | "ready" | "error" | "idle";

/**
 * 根据解析出的网格搭建 three 场景（开发者 Jan）。
 *
 * 返回清理函数：卸载、切换图纸时要把几何体、材质、渲染器与事件监听一并释放，
 * 否则反复切换会持续占用显存。
 */
function createViewer(
  host: HTMLElement,
  THREE: ThreeNS,
  OrbitControls: OrbitControlsCtor,
  meshes: OcctMesh[],
): () => void {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  // 高分屏最多按 2 倍渲染：再高对图纸预览没有肉眼可见收益，只徒增开销
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight, false);
  renderer.domElement.className = "drawing-viewer__canvas";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    FIELD_OF_VIEW,
    host.clientWidth / Math.max(host.clientHeight, 1),
    0.01,
    100000,
  );

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const group = new THREE.Group();

  meshes.forEach((mesh, index) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3),
    );
    if (mesh.attributes.normal) {
      geometry.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3),
      );
    } else {
      // 没有法线就算一遍，否则标准材质会呈现成一片死黑
      geometry.computeVertexNormals();
    }
    if (mesh.index) {
      // 顶点数可能超过 65535，索引一律按 32 位处理
      geometry.setIndex(new THREE.Uint32BufferAttribute(mesh.index.array, 1));
    }
    const material = new THREE.MeshStandardMaterial({
      color: mesh.color
        ? new THREE.Color(mesh.color[0], mesh.color[1], mesh.color[2])
        : new THREE.Color(DEFAULT_COLOR),
      metalness: 0.15,
      roughness: 0.7,
    });
    geometries.push(geometry);
    materials.push(material);
    const object = new THREE.Mesh(geometry, material);
    object.name = mesh.name || `mesh-${index}`;
    group.add(object);
  });

  scene.add(group);

  // 主光 + 补光 + 环境光：单一光源会让背光面全黑，看不出结构
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(1, 1.6, 1.2);
  const fillLight = new THREE.DirectionalLight(0xffffff, 1);
  fillLight.position.set(-1.4, -0.8, -1);
  scene.add(keyLight, fillLight, new THREE.AmbientLight(0xffffff, 0.55));

  // 按整体包围盒定位相机与轨道中心
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, MIN_RADIUS);
  const distance = (radius / Math.sin((FIELD_OF_VIEW * Math.PI) / 360)) * FRAMING_MARGIN;
  const direction = new THREE.Vector3(
    CAMERA_DIRECTION.x,
    CAMERA_DIRECTION.y,
    CAMERA_DIRECTION.z,
  ).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(center);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  let frame = 0;
  /** 等待抓帧的请求；每帧渲染完统一结清，避免持久保留绘制缓冲区带来的性能代价 */
  const captureRequests: Array<(result: DrawingCaptureResult | null) => void> = [];
/** 函数级说明（开发者 Jan）：执行 renderFrame 的单一职责，并返回可供调用方继续处理的结果。 */
  const renderFrame = () => {
    // 开着阻尼时每帧都要推进控制器的缓动，因此用持续渲染而不是按需渲染
    controls.update();
    renderer.render(scene, camera);
    if (captureRequests.length > 0) {
      // 关键：必须在同一个任务内立刻取帧。此时绘制缓冲区还没被合成器清空，
      // 因此不开 `preserveDrawingBuffer` 也能拿到完整画面，不必为偶尔的截图长期买单。
      const canvas = renderer.domElement;
      const requests = captureRequests.splice(0, captureRequests.length);
      canvas.toBlob((blob) => {
        if (!blob) {
          requests.forEach((resolve) => resolve(null));
          return;
        }
        blobToBase64(blob)
          .then((base64) =>
            requests.forEach((resolve) =>
              resolve({ base64, width: canvas.width, height: canvas.height }),
            ),
          )
          .catch(() => requests.forEach((resolve) => resolve(null)));
      }, "image/png");
    }
    frame = requestAnimationFrame(renderFrame);
  };
  renderFrame();

  // 注册抓帧实现，让工具层与右栏按钮都能取到「用户当前看到的这一帧」
  const unregisterCapture = registerDrawingCapture(
    () =>
      new Promise<DrawingCaptureResult | null>((resolve) => {
        captureRequests.push(resolve);
      }),
  );

  // 右栏可拖动、可最大化，画布必须跟着容器尺寸走
  const resizeObserver = new ResizeObserver(() => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  });
  resizeObserver.observe(host);

  return () => {
    unregisterCapture();
    // 待结清的抓帧请求必须给出结果，否则调用方会永远挂在 pending 上
    captureRequests.splice(0).forEach((resolve) => resolve(null));
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    controls.dispose();
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    renderer.dispose();
    renderer.domElement.remove();
  };
}

/** 按注册表声明的解析方式，把字节交给对应的读取入口 */
function parseDrawing(occt: OcctModule, entry: DrawingEntry, bytes: Uint8Array) {
  return entry.format.parser === "iges"
    ? occt.ReadIgesFile(bytes, null)
    : occt.ReadStepFile(bytes, null);
}

/**
 * 三维图纸查看器（开发者 Jan）：本地解析 STEP / IGES 等图纸并用 three 渲染，支持旋转与缩放。
 *
 * 解析与渲染都在前端完成，不依赖外部服务；失败时给出可读原因而非空白画布。
 */
export function DrawingViewer({ entry }: { entry: DrawingEntry }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    // 本客户端无法解析的格式（DWG）：只给引导，不进解析流程
    if (entry.format.parser === null) {
      setStatus("idle");
      setMessage(null);
      return;
    }
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let teardown: (() => void) | null = null;
    setStatus("loading");
    setMessage(null);

/** 函数级说明（开发者 Jan）：执行 load 的单一职责，并返回可供调用方继续处理的结果。 */
    const load = async () => {
      try {
        const bytes = await readDrawingBytes(entry);
        const [{ default: createOcct }, THREE, { OrbitControls }] = await Promise.all([
          import("occt-import-js"),
          import("three"),
          import("three/examples/jsm/controls/OrbitControls.js"),
        ]);
        const occt = await createOcct({ locateFile: () => occtWasmUrl });
        const result = parseDrawing(occt, entry, bytes);
        // 解析期间用户可能已经切走，此时不能再往已卸载的容器里塞画布
        if (disposed) return;
        if (!result.success || result.meshes.length === 0) {
          throw new Error("未能从该图纸中解析出可显示的几何体");
        }
        teardown = createViewer(host, THREE, OrbitControls, result.meshes);
        setStatus("ready");
      } catch (error) {
        if (disposed) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    };

    void load();
    return () => {
      disposed = true;
      teardown?.();
    };
  }, [entry]);

  return (
    <div className="drawing-viewer">
      <div className="drawing-viewer__host" ref={hostRef} />
      {status === "loading" ? (
        <div className="drawing-viewer__overlay">
          <Icon name="spinner" size={14} />
          正在解析图纸…
        </div>
      ) : null}
      {status === "error" ? (
        <div className="drawing-viewer__overlay drawing-viewer__overlay--error">
          <Icon name="alert" size={14} />
          {message ?? "图纸解析失败"}
        </div>
      ) : null}
      {status === "idle" ? (
        <div className="drawing-viewer__overlay drawing-viewer__overlay--hint">
          <Icon name="info" size={14} />
          {entry.format.hint}
        </div>
      ) : null}
    </div>
  );
}
