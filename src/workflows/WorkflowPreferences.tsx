import { Icon, type IconName } from "../components/Icon";
import { useWorkflowUI, type WorkflowTab } from "./store";

const ENTRIES: { tab: WorkflowTab; icon: IconName; title: string; description: string }[] = [
  { tab: "memories", icon: "book", title: "记忆", description: "个人偏好、项目经验与会话使用设置" },
  { tab: "browser", icon: "globe", title: "浏览器", description: "页面预览与已有登录标签页" },
];
/** Keep workflow configuration discoverable from the regular settings navigation. */
export function WorkflowPreferences() {
  return <div className="page__section workflow-preferences">{ENTRIES.map((entry) => <button className="workflow-preferences__entry" key={entry.tab} onClick={() => useWorkflowUI.getState().open(entry.tab)}><Icon name={entry.icon} size={19} /><span><strong>{entry.title}</strong><small>{entry.description}</small></span><Icon name="chevron-right" size={14} /></button>)}</div>;
}
