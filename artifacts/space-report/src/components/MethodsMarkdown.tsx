import type { ReactNode } from "react";

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  return null;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)]+)/g;

function renderInline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(INLINE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const tokenKey = `${key}-${index++}`;
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={tokenKey} className="text-foreground">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(<code key={tokenKey} className="text-accent">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : null;
      if (link && href) {
        nodes.push(
          <a key={tokenKey} href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-primary">
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else {
      const href = safeHref(token);
      if (href) {
        nodes.push(
          <a key={tokenKey} href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-primary break-all">
            {token}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

/**
 * Small renderer for /launches/METHODS.md: headings, lists, bold, code,
 * links, and the pipe table of CSV columns. Anything else stays a paragraph.
 */
export function MethodsMarkdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  const pushParagraph = (text: string) => {
    const body = text.trim();
    if (!body) return;
    blocks.push(
      <p key={`p-${index++}`} className="leading-relaxed">
        {renderInline(body, `p-${index}`)}
      </p>,
    );
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? "";
      const className = level === 1
        ? "text-sm font-bold text-primary uppercase tracking-widest"
        : "text-xs font-bold text-accent uppercase tracking-widest";
      const Tag = level === 1 ? "h3" : "h4";
      blocks.push(
        <Tag key={`h-${index++}`} className={className}>
          {renderInline(text, `h-${index}`)}
        </Tag>,
      );
      continue;
    }

    if (trimmed.startsWith("|") && isTableSeparator(lines[i + 1] ?? "")) {
      const header = splitTableRow(trimmed);
      i += 1;
      const rows: string[][] = [];
      while (i + 1 < lines.length && (lines[i + 1] ?? "").trim().startsWith("|")) {
        i += 1;
        rows.push(splitTableRow(lines[i] ?? ""));
      }
      blocks.push(
        <div key={`t-${index++}`} className="overflow-x-auto border border-border">
          <table className="w-full text-left text-[11px]">
            <thead className="bg-muted/40">
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={cellIndex} className="px-2 py-1 uppercase tracking-wider text-muted-foreground font-bold">
                    {renderInline(cell, `th-${index}-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-border/60">
                  {header.map((_, cellIndex) => (
                    <td key={cellIndex} className="px-2 py-1 align-top">
                      {renderInline(row[cellIndex] ?? "", `td-${index}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^(-|\*|\d+\.)\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^(-|\*|\d+\.)\s+/.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(/^(-|\*|\d+\.)\s+/, ""));
        i += 1;
      }
      i -= 1;
      blocks.push(
        <ul key={`ul-${index++}`} className="list-disc pl-5 space-y-1">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `li-${index}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const paragraph: string[] = [trimmed];
    while (i + 1 < lines.length) {
      const next = (lines[i + 1] ?? "").trim();
      if (!next || next.startsWith("#") || next.startsWith("|") || /^(-|\*|\d+\.)\s+/.test(next)) break;
      i += 1;
      paragraph.push(next);
    }
    pushParagraph(paragraph.join(" "));
  }

  return (
    <div data-testid="methods-markdown" className="space-y-3 font-mono text-xs text-foreground/90 normal-case tracking-normal">
      {blocks}
    </div>
  );
}
