"use client";

import { useState } from "react";

/**
 * Save button for one recommendation. The row stays visible with a "Saved"
 * state rather than vanishing — a list that reshuffles under your finger
 * right after you tap it reads as a glitch, not a confirmation.
 */
export function SaveRecommendation({ candidateId }: { candidateId: string }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">(
    "idle"
  );

  async function save() {
    setState("saving");
    try {
      const res = await fetch(`/api/candidates/${candidateId}/save`, {
        method: "POST",
      });
      setState(res.ok ? "saved" : "failed");
    } catch {
      setState("failed");
    }
  }

  if (state === "saved") {
    return (
      <span
        className="shrink-0 px-2 py-1 text-[12px] font-medium"
        style={{ color: "color-mix(in srgb, var(--paper-text) 60%, transparent)" }}
      >
        Saved ✓
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void save()}
      disabled={state === "saving"}
      className="shrink-0 rounded-md border px-2 py-1 text-[12px] font-medium disabled:opacity-40"
      style={{
        borderColor: "color-mix(in srgb, var(--paper-text) 20%, transparent)",
        color: "var(--paper-text)",
      }}
    >
      {state === "saving" ? "…" : state === "failed" ? "Retry" : "Save"}
    </button>
  );
}
