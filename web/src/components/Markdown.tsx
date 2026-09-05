import { useEffect, useState, type ReactNode } from "react";
import { tokenize, type ShjLanguage } from "@speed-highlight/core";
import { Lexer } from "../../../vendor/marked/src/marked";
// Marked is used only as a CommonMark/GFM lexer. React renders tokens;
// HTML tokens never become DOM, and URLs are protocol-filtered.
export function safeLink(href: string): string | undefined {
  try { const url = new URL(href, "https://local.invalid"); return ["https:", "http:", "mailto:"].includes(url.protocol) ? href : undefined; } catch { return undefined; }
}
function Code({ text, language }: { text: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const [parts, setParts] = useState<{ text: string; kind?: string }[]>([]);
  useEffect(() => {
    let active = true;
    const parts: { text: string; kind?: string }[] = [];
    const lang = ({ javascript: "js", typescript: "ts", python: "py", shell: "bash" } as Record<string, string>)[language ?? ""] ?? language ?? "plain";
    void tokenize(text, lang as ShjLanguage, (text, kind) => parts.push({ text, kind })).then(() => { if (active) setParts(parts); }).catch(() => { if (active) setParts([{ text }]); });
    return () => { active = false; };
  }, [text, language]);
  return <div className="code-block"><div className="code-header"><span>{language || "Code"}</span><button onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "Copied" : "Copy"}</button></div><pre><code>{parts.length ? parts.map((p, i) => <span key={i} className={"syntax-" + p.kind}>{p.text}</span>) : text}</code></pre></div>;
}
function renderTokens(tokens: any[] = []): ReactNode {
  return tokens.map((t, i) => {
    const inner = () => t.tokens ? renderTokens(t.tokens) : t.text;
    switch (t.type) {
      case "space": return null;
      case "paragraph": return <p key={i}>{inner()}</p>;
      case "heading": return <h3 key={i}>{inner()}</h3>;
      case "text": case "escape": return <span key={i}>{inner()}</span>;
      case "strong": return <strong key={i}>{inner()}</strong>;
      case "em": return <em key={i}>{inner()}</em>;
      case "del": return <del key={i}>{inner()}</del>;
      case "codespan": return <code key={i}>{t.text}</code>;
      case "code": return <Code key={i} text={t.text} language={t.lang} />;
      case "blockquote": return <blockquote key={i}>{renderTokens(t.tokens)}</blockquote>;
      case "list": {
        const list = t.items.map((item: any, j: number) => <li key={j}>{item.task && <input type="checkbox" disabled checked={item.checked} />}{renderTokens(item.tokens)}</li>);
        return t.ordered ? <ol key={i} start={t.start}>{list}</ol> : <ul key={i}>{list}</ul>;
      }
      case "link": return <a key={i} href={safeLink(t.href)} target="_blank" rel="noopener noreferrer">{inner()}</a>;
      case "image": return <a key={i} href={safeLink(t.href)} target="_blank" rel="noopener noreferrer">{t.text || "Image"}</a>;
      case "hr": return <hr key={i} />;
      case "br": return <br key={i} />;
      case "table": return <div className="table-scroll" key={i}><table><thead><tr>{t.header.map((c: any, j: number) => <th key={j}>{renderTokens(c.tokens)}</th>)}</tr></thead><tbody>{t.rows.map((row: any[], j: number) => <tr key={j}>{row.map((c, k) => <td key={k}>{renderTokens(c.tokens)}</td>)}</tr>)}</tbody></table></div>;
      case "html": return <span key={i}>{t.raw}</span>;
      default: return <span key={i}>{t.raw ?? ""}</span>;
    }
  });
}
export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{renderTokens(Lexer.lex(text, { gfm: true }))}</div>;
}
