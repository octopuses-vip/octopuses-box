import type { ChatTool } from "../model/client";
export const SELECT_WORKSPACE_TOOL: ChatTool = { type: "function", function: { name: "select_workspace", description: "在用户为项目授权的目录间切换后续文件、搜索和命令工具的根目录。只接受系统说明列出的完整目录路径。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } };
