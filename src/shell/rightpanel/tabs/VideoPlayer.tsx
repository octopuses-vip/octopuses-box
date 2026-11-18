import { useState } from "react";

/** Stream the local file using the WebView's player; export stays available if the codec is missing. */
export function VideoPlayer({ url, name }: { url: string; name: string }) {
  const [failedUrl, setFailedUrl] = useState("");
  return <div className="media-preview__stage">
    <video controls playsInline preload="metadata" aria-label={name} src={url}
      className="media-preview__image" onError={() => setFailedUrl(url)} />
    {failedUrl === url && <span role="alert">当前系统无法播放此视频，可用文件旁的导出按钮另存后播放。</span>}
  </div>;
}
