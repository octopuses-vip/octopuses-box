//! 应用进程内自动化调度器。
//!
//! 调度独立于 React 页面生命周期：应用开着时由本模块的定时器判断「到点」并广播事件；应用完全
//! 退出后由 [launch_agent](crate::launch_agent) 注册的系统定时项重新唤起本应用执行指定任务。
//!
//! 到点判定用前端下发的 `next_run_at`（类 cron / 固定间隔都在前端算，Rust 侧零依赖），
//! 触发后清空该字段：新计划由前端算好后随任务快照重新下发，期间不会重复触发。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const TICK_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTask {
    id: String,
    enabled: bool,
    /// 下次计划触发时间（毫秒）；为 `None` 表示暂无计划，不参与调度
    #[serde(default)]
    next_run_at: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationDueEvent {
    automation_id: String,
    due_at: u64,
}

/// 由系统定时项唤起时广播的事件：告诉前端该执行哪个任务
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationWakeEvent {
    pub automation_id: String,
}

#[derive(Default)]
struct SchedulerData {
    tasks: HashMap<String, AutomationTask>,
    in_flight: HashSet<String>,
    /// 启动时从命令行取到的待执行任务 id；前端可能晚于事件注册，故同时留一份供主动取回
    wake: Option<String>,
}

#[derive(Default)]
pub struct AutomationSchedulerState {
    data: Mutex<SchedulerData>,
}

/// 判断任务此刻是否到点（开发者 Jan）。
///
/// 三个条件缺一不可：任务处于启用状态、有计划时间、且计划时间已到。
/// 计划时间由前端算好后下发（含 cron 与固定间隔两种情况），后端只做「到没到」的比较，
/// 因此这里不解析 cron——调度规则只有一处实现，不会出现前后端算法不一致。
fn is_due(task: &AutomationTask, now: u64) -> bool {
    if !task.enabled {
        return false;
    }
    let Some(next_run_at) = task.next_run_at else {
        return false;
    };
    now >= next_run_at
}

impl AutomationSchedulerState {
    /// 取出全部到点任务并标记为「执行中」（开发者 Jan）。
    ///
    /// 取出即清空该任务的计划时间，并记进 in_flight：这样在前端把下一轮时间算好、
    /// 重新下发之前，同一个任务不会被反复触发。执行结束后前端必须调 automation_release
    /// 把它从 in_flight 摘掉，否则该任务再也不会到点。
    /// 锁损坏时返回空列表而不是报错——调度是后台循环，偶发失败下一轮还会重试。
    fn take_due(&self, now: u64) -> Vec<AutomationDueEvent> {
        let Ok(mut data) = self.data.lock() else {
            return Vec::new();
        };
        let due_ids = data
            .tasks
            .values()
            .filter(|task| is_due(task, now) && !data.in_flight.contains(&task.id))
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        for id in &due_ids {
            if let Some(task) = data.tasks.get_mut(id) {
                // 触发后清空计划时间：前端会把下一轮时间算好再下发，期间不会重复触发
                task.next_run_at = None;
            }
            data.in_flight.insert(id.clone());
        }
        due_ids
            .into_iter()
            .map(|automation_id| AutomationDueEvent {
                automation_id,
                due_at: now,
            })
            .collect()
    }

    /// 记下启动参数指定的待执行任务（开发者 Jan）：供被系统定时项唤起的进程使用
    fn set_wake(&self, task_id: String) {
        if let Ok(mut data) = self.data.lock() {
            data.wake = Some(task_id);
        }
    }

    /// 取回并清空待执行任务（开发者 Jan）：只取一次，避免同一唤醒被处理两遍
    fn take_wake(&self) -> Option<String> {
        let Ok(mut data) = self.data.lock() else {
            return None;
        };
        data.wake.take()
    }
}

/// 记下启动参数指定的待执行任务（由 `lib.rs` 的 `setup` 调用）
pub fn mark_wake(app: &AppHandle, task_id: String) {
    if let Some(state) = app.try_state::<AutomationSchedulerState>() {
        state.set_wake(task_id);
    }
}

/// 同步任务清单（开发者 Jan）：前端把启用中的任务连同各自算好的下次触发时间一起下发。
///
/// 整体替换而不是增量合并：任务的增删改都由前端统一裁决，后端只保留最新一份视图，
/// 避免两处各自维护状态后出现「已删除的任务仍在被触发」。
/// in_flight 只保留仍在清单里的 id，顺带清掉已删除任务的残留标记。
#[tauri::command]
pub fn automation_sync_tasks(
    state: State<'_, AutomationSchedulerState>,
    tasks: Vec<AutomationTask>,
) -> Result<(), String> {
    let mut data = state
        .data
        .lock()
        .map_err(|_| "自动化调度状态已损坏".to_string())?;
    let active_ids = tasks
        .iter()
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();
    data.tasks = tasks
        .into_iter()
        .map(|task| (task.id.clone(), task))
        .collect();
    data.in_flight.retain(|id| active_ids.contains(id));
    Ok(())
}

/// 释放某个任务的「执行中」标记（开发者 Jan）。
///
/// 一次运行结束后必须调用，否则该任务会一直留在 in_flight 里、再也不会到点触发；
/// 前端在成功、失败与中断路径上都要调，不能只在成功时调。
#[tauri::command]
pub fn automation_release(
    state: State<'_, AutomationSchedulerState>,
    automation_id: String,
) -> Result<(), String> {
    let mut data = state
        .data
        .lock()
        .map_err(|_| "自动化调度状态已损坏".to_string())?;
    data.in_flight.remove(&automation_id);
    Ok(())
}

/// 取回启动参数指定的待执行任务（只取一次）。
///
/// 事件广播发生在 `setup` 阶段，前端可能还没注册监听；前端挂载后再主动调一次这里兜底。
#[tauri::command]
pub fn automation_take_wake(state: State<'_, AutomationSchedulerState>) -> Option<String> {
    let wake = state.take_wake();
    // 署名：拿到任务 id 前端就会走「跑完即退出」的分支，因此这里取到什么必须留痕——
    // 正常情况下应恒为 None，一旦有值，客户端自己消失就有了明确出处
    crate::trace::write(&format!("前端取回待执行任务 wake={wake:?}"));
    wake
}

/// 被系统定时项唤起并执行完成后退出应用，避免留下多余窗口
#[tauri::command]
pub fn automation_exit(app: AppHandle) {
    // 署名退出：非定时项唤起的场景里本命令不该被调用，日志里出现它即说明前端误判了「被唤起」
    crate::trace::write("前端请求退出：automation_exit（定时项唤起链路）");
    app.exit(0);
}

/// 启动后台调度循环（开发者 Jan）：定时唤醒检查有无到点任务。
///
/// 用「固定间隔轮询 + 比较计划时间」而不是为每个任务各起一个定时器：
/// 任务清单随时可能被前端改动，轮询模型下只需替换一份清单即可，
/// 不必处理大量定时器的增删与泄漏。轮询间隔取 TICK_INTERVAL，
/// 到点精度即以此为上限，对分钟级的自动化任务足够。
pub fn start(app: AppHandle) {
    thread::spawn(move || loop {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let events = app.state::<AutomationSchedulerState>().take_due(now);
        for event in events {
            let _ = app.emit("automation-due", event);
        }
        thread::sleep(TICK_INTERVAL);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(next_run_at: Option<u64>) -> AutomationTask {
        AutomationTask {
            id: "daily".to_string(),
            enabled: true,
            next_run_at,
        }
    }

    #[test]
    fn due_requires_enabled_and_planned_time() {
        assert!(is_due(&task(Some(1_000)), 1_000));
        assert!(is_due(&task(Some(1_000)), 61_000));
        assert!(!is_due(&task(Some(61_000)), 60_999));
        assert!(!is_due(&task(None), 100_000));
        let mut disabled = task(Some(1_000));
        disabled.enabled = false;
        assert!(!is_due(&disabled, 100_000));
    }

    #[test]
    fn scheduler_deduplicates_until_released() {
        let state = AutomationSchedulerState::default();
        state
            .data
            .lock()
            .expect("写入调度状态失败")
            .tasks
            .insert("daily".to_string(), task(Some(1_000)));
        assert_eq!(state.take_due(61_000).len(), 1);
        assert!(state.take_due(62_000).is_empty());
        state
            .data
            .lock()
            .expect("释放调度状态失败")
            .in_flight
            .remove("daily");
        // 计划时间已被清空：释放后也不会立刻再次到期，直到前端下发新的 nextRunAt
        assert!(state.take_due(63_000).is_empty());
        state
            .data
            .lock()
            .expect("下发新计划失败")
            .tasks
            .insert("daily".to_string(), task(Some(121_000)));
        assert!(state.take_due(121_000).len() == 1);
    }

    #[test]
    fn wake_id_is_taken_once() {
        let state = AutomationSchedulerState::default();
        assert!(state.take_wake().is_none());
        state.set_wake("auto-1".to_string());
        assert_eq!(state.take_wake().as_deref(), Some("auto-1"));
        assert!(state.take_wake().is_none());
    }
}
