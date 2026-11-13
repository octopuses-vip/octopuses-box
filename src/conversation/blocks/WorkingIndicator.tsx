import { useEffect, useRef, useState } from "react";

interface WorkingIndicatorProps {
  startedAt: number;
}

/**
 * 「工作中 (12s • Esc 中断)」指示器（开发者 Jan）。
 *
 * 自己按 250ms 轮询计时（不是每秒），让秒数跳变看起来更跟手；`startedAt` 变化时重建定时器，
 * 卸载时清掉，避免离开会话后定时器继续跑。
 */
export function WorkingIndicator({ startedAt }: WorkingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    timerRef.current = window.setInterval(tick, 250);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [startedAt]);

  return (
    <div className="assistant__row">
      <div className="assistant__gutter">
        <span className="spinner" />
      </div>
      <div className="assistant__content working">
        <span className="working__time">工作中 ({elapsed}s</span>
        <span className="working__hint">• Esc 中断</span>
        <span className="working__time">)</span>
      </div>
    </div>
  );
}
