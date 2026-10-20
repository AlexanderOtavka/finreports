import { useEffect, type RefObject } from "react";

/**
 * What every bottom sheet does: close on Escape, take the focus and the page's scrolling, and
 * swipe down to close: from the header or footer, or from the body (`.sheet-body`) once it is
 * scrolled to the top. A short, slow drag springs back. `sheet` is the sheet; its parent is
 * the backdrop.
 */
export function useSheet(sheet: RefObject<HTMLDivElement | null>, onClose: () => void): void {
  // Close on Escape; keep focus inside the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    sheet.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [sheet, onClose]);

  // Swipe down to close.
  useEffect(() => {
    const node = sheet.current;
    const backdrop = node?.parentElement;
    if (!node || !backdrop) return;
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    let dy = 0;
    let last = { y: 0, t: 0, v: 0 };
    const settle = (close: boolean) => {
      node.style.transition = backdrop.style.transition = "transform 0.2s ease-out, background-color 0.2s ease-out";
      node.style.transform = close ? "translateY(100%)" : "";
      backdrop.style.backgroundColor = close ? "transparent" : "";
      if (close) setTimeout(onClose, 200);
    };
    const onStart = (e: TouchEvent) => {
      const list = (e.target as Element).closest(".sheet-body");
      const touch = e.touches.length === 1 ? e.touches[0] : undefined;
      start = touch && !(list && list.scrollTop > 0) ? { x: touch.clientX, y: touch.clientY } : null;
      dragging = false;
      dy = 0;
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const y = touch.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dx) < 8 && Math.abs(y) < 8) return;
        // Up or sideways: a scroll, not a swipe.
        if (y <= Math.abs(dx)) {
          start = null;
          return;
        }
        dragging = true;
        node.style.transition = backdrop.style.transition = "none";
        last = { y, t: e.timeStamp, v: 0 };
      }
      e.preventDefault();
      dy = Math.max(0, y);
      if (e.timeStamp > last.t) last = { y, t: e.timeStamp, v: (y - last.y) / (e.timeStamp - last.t) };
      node.style.transform = `translateY(${dy}px)`;
      backdrop.style.backgroundColor = `rgb(0 0 0 / ${50 * Math.max(0, 1 - dy / node.offsetHeight)}%)`;
    };
    const onEnd = (e: TouchEvent) => {
      if (dragging) settle(e.type === "touchend" && (dy > node.offsetHeight / 3 || (dy > 40 && last.v > 0.5)));
      start = null;
      dragging = false;
    };
    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: false });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", onEnd);
    return () => {
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", onEnd);
    };
  }, [sheet, onClose]);
}
