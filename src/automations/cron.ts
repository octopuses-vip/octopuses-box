/**
 * 自动化任务的计划推导：类 cron 表达式的解析、下次触发时间计算，以及
 * 「注册成系统后台定时项」所需的调度规格推导。
 *
 * 全部放在前端 TS（零依赖、纯函数），Rust 侧只负责「`now >= nextRunAt`」判定与 plist 落盘，
 * 双方共享同一套语义，不需要引入 Rust 的 cron crate。
 */

import type { Automation } from "../app/types";

const MINUTE_MS = 60_000;
/** 往后搜索的分钟数上限（366 天）：超过即认为该表达式在当前日历年内不会触发 */
const SEARCH_LIMIT_MINUTES = 366 * 24 * 60;

/** 解析后的 5 个字段（周日的 7 已归一为 0） */
export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
}

/** 系统后台定时项的日历式触发规格（对应 plist 的 `StartCalendarInterval`） */
export interface AgentCalendar {
  minute?: number;
  hour?: number;
  weekday?: number;
  day?: number;
}

/** 系统后台定时项的调度规格：间隔与日历二选一 */
export interface AgentSchedule {
  intervalSeconds?: number;
  calendar?: AgentCalendar;
}

/**
 * 解析单个字段；支持 `*`、`*\/N`、`a`、`a-b`、`a,b,c` 及其组合。
 * 任一子项非法即整体返回 null，避免「看似解析成功但语义错了」。
 */
function parseField(expression: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const raw of expression.split(",")) {
    const piece = raw.trim();
    if (piece.length === 0) return null;

    const stepMatch = /^(.*)\/(\d+)$/.exec(piece);
    const rangeText = stepMatch ? stepMatch[1] : piece;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;

    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = min;
      end = max;
    } else {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(rangeText);
      if (rangeMatch) {
        start = Number(rangeMatch[1]);
        end = Number(rangeMatch[2]);
      } else if (/^\d+$/.test(rangeText)) {
        start = Number(rangeText);
        end = start;
      } else {
        return null;
      }
      if (start < min || end > max || start > end) return null;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

/** 解析 5 段 cron 表达式（分 时 日 月 周）；段数不对或任一段非法返回 null */
export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const days = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const rawWeekdays = parseField(parts[4], 0, 7);
  if (!minutes || !hours || !days || !months || !rawWeekdays) return null;

  const weekdays = new Set<number>();
  for (const value of rawWeekdays) weekdays.add(value === 7 ? 0 : value);
  return { minutes, hours, days, months, weekdays };
}

/**
 * 计算下一次触发时间（毫秒）。
 *
 * 从「下一分钟整点」开始逐分钟向后找，命中即返回；找不到（表达式无法在一年的日历内命中）
 * 返回 null。日是「并且」语义（日与周同时限定时需同时满足），足以覆盖预设的日 / 周任务。
 */
export function nextRunAt(expression: string, from: number): number | null {
  const fields = parseCron(expression);
  if (!fields) return null;

  const start = Math.floor(from / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let offset = 0; offset < SEARCH_LIMIT_MINUTES; offset += 1) {
    const candidate = start + offset * MINUTE_MS;
    const date = new Date(candidate);
    if (!fields.minutes.has(date.getMinutes())) continue;
    if (!fields.hours.has(date.getHours())) continue;
    if (!fields.months.has(date.getMonth() + 1)) continue;
    if (!fields.days.has(date.getDate())) continue;
    if (!fields.weekdays.has(date.getDay())) continue;
    return candidate;
  }
  return null;
}

/** 按任务自身配置推导下一次触发时间：优先 cron，其次固定间隔，都没有则不排程 */
export function nextRunAtForTask(
  task: Pick<Automation, "cron" | "intervalMinutes">,
  from: number,
): number | null {
  const cron = task.cron?.trim() ?? "";
  if (cron.length > 0) return nextRunAt(cron, from);
  if (task.intervalMinutes > 0) return from + task.intervalMinutes * MINUTE_MS;
  return null;
}

/** `*\/N * * * *` 型 → 步进分钟数；其余返回 null */
function minuteStep(expression: string): number | null {
  const match = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(expression.trim());
  if (!match) return null;
  const step = Number(match[1]);
  return Number.isInteger(step) && step > 0 ? step : null;
}

/** `M H * * *` / `M H * * W` → 日历规格；其余返回 null（无法用 StartCalendarInterval 表达） */
function fixedCalendar(expression: string): AgentCalendar | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  if (parts[2] !== "*" || parts[3] !== "*") return null;

  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (minute > 59 || hour > 23) return null;
  if (parts[4] === "*") return { minute, hour };
  if (/^\d$/.test(parts[4])) {
    const weekday = Number(parts[4]);
    return { minute, hour, weekday: weekday === 7 ? 0 : weekday };
  }
  return null;
}

/**
 * 把任务推导成系统后台定时项的调度规格。
 *
 * 只有在 plist 里能精确表达的才返回：固定间隔与 `*\/N` 型退化为 `StartInterval`（精度到分钟），
 * 「每天 / 每周定点」退化为 `StartCalendarInterval`；其余复杂表达式返回 null——这类任务只在
 * 应用运行时由进程内调度器触发，不会被系统唤起。
 */
export function agentSchedule(task: Pick<Automation, "cron" | "intervalMinutes">): AgentSchedule | null {
  const cron = task.cron?.trim() ?? "";
  if (cron.length > 0) {
    const step = minuteStep(cron);
    if (step !== null) return { intervalSeconds: step * 60 };
    const calendar = fixedCalendar(cron);
    if (calendar) return { calendar };
    return null;
  }
  if (task.intervalMinutes > 0) return { intervalSeconds: task.intervalMinutes * 60 };
  return null;
}

/** 本机时区标识：任务新建时记录一份，便于跨设备阅读（调度仍按本机时区计算） */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  } catch {
    return "Local";
  }
}

/** 把任务的计划描述成一句可读文案 */
export function describeSchedule(task: Pick<Automation, "cron" | "intervalMinutes">): string {
  const cron = task.cron?.trim() ?? "";
  if (cron.length > 0) return `cron：${cron}`;
  if (task.intervalMinutes <= 0) return "仅手动触发";
  if (task.intervalMinutes % 1440 === 0) return `每 ${task.intervalMinutes / 1440} 天`;
  if (task.intervalMinutes % 60 === 0) return `每 ${task.intervalMinutes / 60} 小时`;
  return `每 ${task.intervalMinutes} 分钟`;
}
