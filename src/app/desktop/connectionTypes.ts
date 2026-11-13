/** 桌面适配层：connectionTypes。运行环境差异在此处理，界面只调用公开函数。 */

/* ============================ 客户端登录与授权模型 ============================ */

/**
 * 当前连接：由「选中的授权模型」派生出来的对话连接信息。
 *
 * 它是 chat / 评审 / 图像链路唯一消费的连接结构，因此这里保留为聚合形态，
 * 而不是让各处各自去 `RemoteModel` 里取字段。
 */
export interface ModelConnection {
  /** 模型服务基础地址 */
  url: string;
  /** 访问密钥 */
  key: string;
  /** 模型 id（取模型的 code） */
  modelId: string;
  /** 该模型是否支持图片输入；由后台 `supports_images` 或用户手动开关决定（见 `resolveSupportsImages`） */
  supportsImages: boolean;
  /** 视觉模型 id；后台未下发时为空串 */
  visionModelId: string;
}

/** 登录接口下发的用户信息 */
export interface ServerUser {
  id: number;
  username: string;
  /** 昵称，可能为空字符串 */
  nickname: string;
  /** 1 = 启用，0 = 禁用 */
  status: number;
}

/** 登录结果：令牌 + 用户信息 */
export interface LoginResult {
  token: string;
  user: ServerUser;
}

/**
 * 命令抛出的错误归一化结果。
 *
 * Rust 侧的 `ApiError` 带 `code`，前端据此区分 401（令牌失效，静默回登录页）与
 * 403（账号被禁用，需要给出明确提示）；`code` 为 `NETWORK_ERROR_CODE` 表示压根没连上服务端。
 */
export interface ApiErrorInfo {
  code: number;
  message: string;
}
