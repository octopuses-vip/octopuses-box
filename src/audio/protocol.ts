import type { ChatTool } from "../model/client";

export const TRANSCRIBE_AUDIO_NAME = "transcribe_audio";
export const TRANSCRIBE_AUDIO_TOOL: ChatTool = {
  type: "function",
  function: {
    name: TRANSCRIBE_AUDIO_NAME,
    description: "提取本地音视频中的语音并转写为文字。传绝对路径或项目相对路径；原生读取文件并自动分段，无原文件大小、时长门槛。需配置语音识别模型，上传前经审批。失败重试会复用已完成段落。完整文字保存为产物，offset 可分页读取既有转写结果。",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "本地音视频文件路径" },
      offset: { type: "integer", minimum: 0, description: "文字起始字符位置，默认 0；分页不重复识别" },
    }, required: ["path"], additionalProperties: false },
  },
};

