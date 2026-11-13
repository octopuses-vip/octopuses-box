/** 桌面适配层：connectionTypes。运行环境差异在此处理，界面只调用公开函数。 */

/**
 * 当前连接：由「选中的模型条目」派生出来的对话连接信息。
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
  /** 该模型是否支持图片输入；由条目里的 `supportsImages` 或用户手动开关决定（见 `resolveSupportsImages`） */
  supportsImages: boolean;
  /** 视觉模型 id；条目里未声明时为空串 */
  visionModelId: string;
}
