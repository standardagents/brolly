import type { ReactNode } from "react";

/**
 * Dependency-free syntax highlighter for the fixed code and prompt snippets
 * Brolly renders (install guide, agent prompt). It only needs to look right
 * for content this repository authors, so the grammars are deliberately
 * small: comments, strings, keywords, numbers, and callables.
 */
export type CodeLang = "shell" | "ts" | "md";

type Rule = { cls: string; re: RegExp };

const RULES: Record<"shell" | "ts", Rule[]> = {
  shell: [
    { cls: "tok-c", re: /(?:#(?!\{)|\/\/).*$/ },
    { cls: "tok-s", re: /'[^']*'|"[^"]*"/ },
    { cls: "tok-k", re: /(?<=^|[\s|])(?:pnpm|npx|wrangler|printf|brolly|git|node)(?=\s|$)/ },
    { cls: "tok-n", re: /--[\w-]+|\b[A-Z][A-Z0-9_]{2,}\b|\b\d[\d_.]*\b/ },
  ],
  ts: [
    { cls: "tok-c", re: /\/\/.*$/ },
    { cls: "tok-s", re: /'[^']*'|"[^"]*"|`[^`]*`/ },
    { cls: "tok-k", re: /\b(?:const|let|return|new|constructor|super|import|export|from|function|async|await|catch|throw|class|extends)\b/ },
    { cls: "tok-f", re: /\b[\w$]+(?=\()/ },
    { cls: "tok-n", re: /\b[A-Z][A-Z0-9_]{2,}\b|\b\d[\d_.]*\b/ },
  ],
};

const MD_HEADING = /^[A-Z][^:]{0,60}:$/;
const MD_MARKER = /^(?:\d+\.|-)(?=\s)/;
const MD_INLINE: Rule[] = [
  { cls: "tok-s", re: /`[^`]*`|@[\w/-]+\/[\w-]+/ },
  { cls: "tok-f", re: /\b[\w$]+(?=\()/ },
  { cls: "tok-n", re: /\b[A-Z][A-Z0-9_]{2,}\b/ },
];

function tokenizeInline(line: string, rules: Rule[]): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = line;
  let key = 0;
  while (rest) {
    let best: { index: number; text: string; cls: string } | null = null;
    for (const rule of rules) {
      const match = rule.re.exec(rest);
      if (match?.[0] && (best === null || match.index < best.index)) best = { index: match.index, text: match[0], cls: rule.cls };
    }
    if (!best) { out.push(rest); break; }
    if (best.index > 0) out.push(rest.slice(0, best.index));
    out.push(<span key={key++} className={best.cls}>{best.text}</span>);
    rest = rest.slice(best.index + best.text.length);
  }
  return out;
}

function tokenizeLine(line: string, lang: CodeLang): ReactNode[] {
  if (lang !== "md") return tokenizeInline(line, RULES[lang]);
  if (MD_HEADING.test(line)) return [<span key="h" className="tok-h">{line}</span>];
  const marker = MD_MARKER.exec(line)?.[0];
  const rest = marker ? line.slice(marker.length) : line;
  const nodes = tokenizeInline(rest, MD_INLINE);
  return marker ? [<span key="m" className="tok-k">{marker}</span>, ...nodes] : nodes;
}

export function Highlight({ code, lang }: { code: string; lang: CodeLang }) {
  return <>{code.split("\n").map((line, index) => (
    <span key={index}>{index > 0 ? "\n" : ""}{tokenizeLine(line, lang)}</span>
  ))}</>;
}
