"use client";

// One to three font pairings, each shown as a big "Aa" in the display face with a line of body text
// in the body face under it, so two pairs that share a headline font still look different.
// Any Google font loads by name; other names fall back to a system face.
import { useEffect, useState } from "react";
import { WRITES_TO, type AnswerOf, type PropsOf } from "../../../core/catalog.ts";
import { googleFont, googleFontsHref } from "../../../core/fonts.ts";
import { Question, Shell, Skeleton, type CommonProps } from "../primitives.tsx";

type Props = PropsOf<"FontPairCard"> & CommonProps<AnswerOf<"FontPairCard">> & { value?: string };

function useGoogleFonts(families: string[]) {
  const key = [...new Set(families.filter((f) => googleFont(f)))].sort().join("|");
  useEffect(() => {
    if (!key) return;
    const href = googleFontsHref(key.split("|"));
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }, [key]);
}

export function FontPairCard({ title, titleMuted, options, value, status, errorText, onAnswer }: Props) {
  const [picked, setPicked] = useState(value);
  useGoogleFonts(options.flatMap((o) => [o.display, o.body]));
  return (
    <Shell name="FontPairCard" writesTo={WRITES_TO.FontPairCard} status={status} errorText={errorText} skeleton={<Skeleton block={120} lines={1} />}>
      <Question title={title} muted={titleMuted} />
      <div className="c-fonts" role="radiogroup" aria-label={title} data-count={options.length}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={picked === o.id}
            className="c-font"
            disabled={!onAnswer}
            onClick={() => {
              setPicked(o.id);
              onAnswer?.({ optionId: o.id });
            }}
          >
            <span className="c-font-aa" style={{ fontFamily: `"${o.display}", Georgia, serif` }}>
              Aa
            </span>
            <span className="c-font-sample" style={{ fontFamily: `"${o.display}", Georgia, serif` }}>
              {o.sample ?? "Headline"}
            </span>
            <span className="c-font-body" style={{ fontFamily: `"${o.body}", system-ui, sans-serif` }}>
              Body text reads like this in {o.body}.
            </span>
            <span className="c-mono-dim">
              {o.display} + {o.body}
            </span>
            {o.note && <span className="c-mono-dim">{o.note}</span>}
          </button>
        ))}
      </div>
    </Shell>
  );
}
