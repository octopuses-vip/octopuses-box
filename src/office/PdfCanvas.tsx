import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import "./pdf-canvas.css";
/** Render a resizable PDF canvas and a scoped, aligned selectable text layer. */
export function PdfCanvas({ bytes, page, onPages, onSelection }: { bytes: Uint8Array; page: number; onPages: (count: number) => void; onSelection?: (text: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null); const text = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null); const [availableWidth, setAvailableWidth] = useState(0);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null); const [error, setError] = useState("");
  useEffect(() => {
    const parent = holder.current?.parentElement; if (!parent) return;
    const style = getComputedStyle(parent);
    setAvailableWidth(parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(parent); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setError(""); let disposed = false; let destroy: (() => void) | undefined;
    void (async () => { const lib = await import("pdfjs-dist/legacy/build/pdf.mjs"); const { default: worker } = await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url"); lib.GlobalWorkerOptions.workerSrc = worker; const task = lib.getDocument({ data: bytes.slice(), useSystemFonts: true }); destroy = () => { void task.destroy(); }; const document = await task.promise; if (disposed) { void task.destroy(); return; } setPdf(document); onPages(document.numPages); })().catch((e) => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; setPdf(null); destroy?.(); };
  }, [bytes, onPages]);
  useEffect(() => {
    if (!pdf || !canvas.current || !text.current) return; let cancelled = false; let cancel: (() => void) | undefined;
    void (async () => {
      const p = await pdf.getPage(page); if (cancelled || !canvas.current || !text.current) return;
      const width = availableWidth || canvas.current.parentElement?.clientWidth || 640; const viewport = p.getViewport({ scale: Math.min(760, width) / p.getViewport({ scale: 1 }).width });
      const c = canvas.current; const context = c.getContext("2d"); if (!context) throw new Error("Canvas 不可用");
      c.width = viewport.width * 2; c.height = viewport.height * 2; c.style.width = `${viewport.width}px`; c.style.height = `${viewport.height}px`;
      const lib = await import("pdfjs-dist/legacy/build/pdf.mjs"); if (cancelled) return;
      const container = text.current!; container.replaceChildren();
      if (c.parentElement) c.parentElement.style.width = `${viewport.width}px`;
      container.style.setProperty("--total-scale-factor", String(viewport.scale)); container.style.setProperty("--scale-round-x", "1px"); container.style.setProperty("--scale-round-y", "1px"); container.style.setProperty("--scale-factor", String(viewport.scale)); container.style.width = `${viewport.width}px`; container.style.height = `${viewport.height}px`;
      const drawing = p.render({ canvas: c, canvasContext: context, viewport, transform: [2, 0, 0, 2, 0, 0] });
      let layer: { cancel: () => void } | undefined;
      cancel = () => { drawing.cancel(); layer?.cancel(); };
      await Promise.all([drawing.promise, (async () => {
        const source = await p.getTextContent(); if (cancelled) return;
        const rendered = new lib.TextLayer({ textContentSource: source, container, viewport }); layer = rendered;
        await rendered.render();
      })()]);
    })().catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; cancel?.(); };
  }, [pdf, page, availableWidth]);
  return <>{error && <p role="alert">{error}</p>}<div ref={holder} className="office-pdf" onMouseUp={(e) => { const selection = window.getSelection(); if (selection?.anchorNode && e.currentTarget.contains(selection.anchorNode)) onSelection?.(selection.toString()); }} onKeyUp={(e) => { const selection = window.getSelection(); if (selection?.anchorNode && e.currentTarget.contains(selection.anchorNode)) onSelection?.(selection.toString()); }} style={{ position: "relative", background: "var(--bg-preview)", overflow: "auto", minHeight: 120 }}><canvas ref={canvas} /><div className="textLayer" ref={text} /></div></>;
}
