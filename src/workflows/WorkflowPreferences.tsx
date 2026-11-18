import { Icon, type IconName } from "../components/Icon";
import { useWorkflowUI, type WorkflowTab } from "./store";

const ENTRIES: { tab: WorkflowTab; icon: IconName; title: string; description: string }[] = [
  { tab: "memories", icon: "book", title: "记忆", description: "个人偏好、项目经验与会话使用设置" },
  { tab: "plugins", icon: "puzzle", title: "插件与账号连接", description: "安装技能包，为远程 MCP 服务连接账号" },
  { tab: "connections", icon: "clock", title: "后台任务与设备", description: "独立任务、本地主机、手机与远程连接" },
  { tab: "browser", icon: "globe", title: "浏览器", description: "页面预览与已有登录标签页" },
];
/** Keep workflow configuration discoverable from the regular settings navigation. */
export function WorkflowPreferences() {
  return <div className="page__section workflow-preferences">{ENTRIES.map((entry) => <button className="workflow-preferences__entry" key={entry.tab} onClick={() => useWorkflowUI.getState().open(entry.tab)}><Icon name={entry.icon} size={19} /><span><strong>{entry.title}</strong><small>{entry.description}</small></span><Icon name="chevron-right" size={14} /></button>)}</div>;
}
