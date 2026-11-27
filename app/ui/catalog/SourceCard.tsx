"use client";

// One fact with its receipts. Confirm it, or edit it in place. A conflict shows both sides.
import { useState } from "react";
import type { AnswerOf, PropsOf } from "../../../core/catalog.ts";
import { Shell, Skeleton, Sources, type CommonProps } from "../primitives.tsx";

type Props = PropsOf<"SourceCard"> & CommonProps<AnswerOf<"SourceCard">> & { confirmLabel?: string };

export function SourceCard({ chunk, label, fact, sources, conflict, confirmLabel, status, errorText, onAnswer }: Props) {
  // The fact sits in an editable box from the start: change the words and press Enter (or Save),
  // or leave them and confirm. One control, no separate "edit" step (Scott, Nov 27).
  const [draft, setDraft] = useState(fact);
  const changed = draft.trim() !== fact.trim();
  const send = () => {
    if (!onAnswer) return;
    if (!changed) onAnswer({ action: "confirm" });
    else if (draft.trim()) onAnswer({ action: "edit", value: draft.trim() });
  };
  return (
    <Shell name="SourceCard" writesTo={chunk} status={status} errorText={errorText} skeleton={<Skeleton block={40} lines={3} />}>
      <span className="c-mono-dim">{label}</span>
      {onAnswer ? (
        <div className="c-edit">
          <textarea
            value={draft}
            maxLength={160}
            rows={2}
            aria-label={`${label}. Edit the words if they're wrong, then press Enter.`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <span className="c-mono-dim">{changed ? `${draft.length}/160 · Enter saves` : "Tap the words to change them"}</span>
        </div>
      ) : (
        <p className="c-fact">{fact}</p>
      )}
      {conflict && (
        <div className="c-conflict">
          <span className="c-flag">Conflict</span>
          <span>{conflict.text}</span>
          <Sources sources={conflict.sources} />
        </div>
      )}
      <Sources sources={sources} />
      {onAnswer && (
        <div className="c-row">
          <button type="button" className="c-btn" disabled={changed && !draft.trim()} onClick={send}>
            {changed ? "Save" : (confirmLabel ?? "That's right")}
          </button>
          {changed && (
            <button type="button" className="c-btn ghost" onClick={() => setDraft(fact)}>
              Undo my edit
            </button>
          )}
        </div>
      )}
    </Shell>
  );
}
