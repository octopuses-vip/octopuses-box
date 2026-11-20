import type { ChatTool } from "../model/client";

export const TRANSCRIBE_AUDIO_NAME = "transcribe_audio";
export const TRANSCRIBE_AUDIO_TOOL: ChatTool = {
  type: "function",
  function: {
    name: TRANSCRIBE_AUDIO_NAME,
    description: "用户要求转写、整理或总结录音内容时，提取音视频中的语音。仅附加音视频不代表要求转写。对会话原文件附件传 attachmentId，对其他本地文件传绝对或项目相对路径 path，二者选一。需配置语音识别模型，上传前经审批。原生读取并自动分段，无原文件大小、时长门槛；失败重试会复用已完成段落。完整文字另存为产物，不替换原附件，offset 可分页读取。",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "本地音视频文件路径" },
      attachmentId: { type: "string", description: "当前会话中音视频原文件附件的 ID，与 path 二选一" },
      offset: { type: "integer", minimum: 0, description: "文字起始字符位置，默认 0；分页不重复识别" },
    }, oneOf: [{ required: ["path"] }, { required: ["attachmentId"] }], additionalProperties: false },
  },
};

