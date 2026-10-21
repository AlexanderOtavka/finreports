import { highlightParts } from "../search.js";

/** `text` with the parts that match a search term marked. */
export function Hl({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  return (
    <>
      {highlightParts(text, terms).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : p.text))}
    </>
  );
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="6.75" cy="6.75" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10.3 10.3 14.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
