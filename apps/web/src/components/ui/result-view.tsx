"use client";

import { Fragment, useMemo, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { parseRichText, type RichBlock, type RichInline } from "@/lib/rich-text";
import { cn } from "@/lib/utils";

export interface ResultViewProps {
  /** A model's answer, as it came. JSON is shown pretty-printed. */
  text: string;
  className?: string;
  /** Show a Copy button that copies `text` as it came. */
  copy?: boolean;
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-lg font-semibold",
  2: "text-base font-semibold",
  3: "text-sm font-semibold",
  4: "text-sm font-semibold",
  5: "text-sm font-medium",
  6: "text-sm font-medium text-muted-foreground",
};

const CODE_BLOCK_CLASS =
  "overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/60 p-3 font-mono text-xs leading-relaxed";

function renderInline(nodes: RichInline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "code":
        return (
          <code key={index} className="rounded border border-border bg-background/60 px-1 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case "bold":
        return (
          <strong key={index} className="font-semibold">
            {renderInline(node.children)}
          </strong>
        );
      case "em":
        return (
          <em key={index} className="italic">
            {renderInline(node.children)}
          </em>
        );
      case "link":
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="break-words text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {node.text}
          </a>
        );
    }
  });
}

function renderBlock(block: RichBlock, index: number): ReactNode {
  switch (block.type) {
    case "heading":
      // Drawn as styled text with a heading role, so a result never
      // reshuffles the heading outline of the page it sits on.
      return (
        <p key={index} role="heading" aria-level={Math.min(block.level + 2, 6)} className={HEADING_CLASS[block.level]}>
          {renderInline(block.children)}
        </p>
      );
    case "paragraph":
      return (
        <p key={index} className="whitespace-pre-wrap break-words">
          {renderInline(block.children)}
        </p>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className="whitespace-pre-wrap break-words">
          {renderInline(item)}
        </li>
      ));
      return block.ordered ? (
        <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5">
          {items}
        </ol>
      ) : (
        <ul key={index} className="list-disc space-y-1 pl-5">
          {items}
        </ul>
      );
    }
    case "code":
      return (
        <pre key={index} className={CODE_BLOCK_CLASS}>
          <code>{block.text}</code>
        </pre>
      );
  }
}

/**
 * Copies a result as it came. For the row a result's heading or date sits
 * in, so the button takes no line of its own.
 */
export function CopyTextButton({ text, className }: { text: string; className?: string }) {
  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }
  return (
    <Button type="button" variant="ghost" size="sm" onClick={copyText} className={cn("h-7 shrink-0 px-2", className)}>
      <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
      Copy
    </Button>
  );
}

/**
 * The one way a result is shown: headings, lists, bold, emphasis, code and
 * links drawn as React elements from `parseRichText`. No HTML from the text
 * is ever put on the page; anything that is not a known construct shows as
 * plain text.
 *
 * `copy` puts a Copy button at the top right, beside the first lines, so it
 * adds no height. A caller with a heading above the result puts
 * `CopyTextButton` in that row instead.
 */
export function ResultView({ text, className, copy = false }: ResultViewProps) {
  const blocks = useMemo(() => parseRichText(text), [text]);

  return (
    <div className={cn("flow-root min-w-0 text-sm leading-relaxed", className)}>
      {copy && <CopyTextButton text={text} className="float-right -mr-1 -mt-1 ml-2" />}
      <div className="space-y-3">{blocks.map(renderBlock)}</div>
    </div>
  );
}
