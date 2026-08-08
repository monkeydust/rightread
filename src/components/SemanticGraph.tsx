"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import { KINDS } from "@/lib/classify/kinds";
import { GraphLegend } from "@/components/GraphLegend";

export type GraphNode = {
  id: string;
  title: string;
  siteName: string | null;
  url: string;
  kind: string;
  status: string;
  starred: boolean;
  wordCount: number | null;
  savedAt: string;
  linked: boolean;
};

export type GraphEdge = {
  source: string;
  target: string;
  score: number;
  percentile: number;
  strength: "strong" | "moderate" | "weak";
  mutual: boolean;
  duplicate: boolean;
};

export type GraphPayload = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    moderateAt: number;
    strongAt: number;
    unlinked: number;
    truncated: number;
    pairsScored: number;
    tookMs: number;
  };
};

/** d3 mutates the objects it simulates, so it gets its own copies. */
type SimNode = SimulationNodeDatum & { id: string; r: number };
type SimEdge = { source: SimNode | string; target: SimNode | string; score: number };

const WIDTH = 1000;
const HEIGHT = 640;

export function kindColour(kind: string): string {
  return (KINDS as readonly string[]).includes(kind)
    ? `var(--kind-${kind})`
    : "var(--kind-other)";
}

/**
 * Radius from word count, on a square root so a 20,000-word piece reads as
 * weightier than a 500-word one without being forty times the area.
 */
function radiusFor(wordCount: number | null): number {
  const w = wordCount ?? 0;
  return Math.max(5, Math.min(18, 5 + Math.sqrt(w) / 9));
}

const STRENGTH_STYLE = {
  strong: { width: 2.2, opacity: 0.75 },
  moderate: { width: 1.3, opacity: 0.4 },
  weak: { width: 0.7, opacity: 0.18 },
} as const;

export function SemanticGraph({ initial }: { initial: GraphPayload | null }) {
  const router = useRouter();

  const [k, setK] = useState(4);
  const [includeArchived, setIncludeArchived] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which query the data in hand belongs to. Holding the key alongside the
  // payload makes "is this stale?" a derived question rather than something to
  // clear imperatively — the same shape Library.tsx uses for search results,
  // and for the same reason: calling setState in an effect body to flag
  // loading triggers a cascading render.
  const requested = `${includeArchived ? "all" : "unread"}:${k}`;
  const [state, setState] = useState<{ key: string; payload: GraphPayload } | null>(
    initial ? { key: requested, payload: initial } : null
  );

  // Keep showing the previous graph while the next one loads — it dims rather
  // than disappearing, so changing k does not blank the screen.
  const data = state?.payload ?? null;
  const loading = state === null || state.key !== requested;

  const load = useCallback(async (key: string, signal?: AbortSignal) => {
    const [status, kk] = key.split(":");
    const res = await fetch(`/api/graph?status=${status}&k=${kk}`, {
      cache: "no-store",
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as GraphPayload;
  }, []);

  // ── Fetch ─────────────────────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController();
    load(requested, controller.signal)
      .then((payload) => {
        setState({ key: requested, payload });
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed");
      });
    return () => controller.abort();
  }, [requested, load]);

  // Background work (a new capture being embedded) changes the graph. The same
  // stream the library listens to; a rebuild is cheap and cached server-side.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/events");
    source.addEventListener("items-changed", () => {
      load(requested)
        .then((payload) => setState({ key: requested, payload }))
        .catch(() => {});
    });
    return () => source.close();
  }, [requested, load]);

  const visible = useMemo(() => {
    if (!data) return { nodes: [], edges: [] as GraphEdge[] };
    const nodes = data.nodes.filter((n) => !hidden.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    return {
      nodes,
      edges: data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    };
  }, [data, hidden]);

  // ── Neighbourhood, for the hover highlight ────────────────────────
  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of visible.edges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [visible.edges]);

  const isLit = useCallback(
    (id: string) => !active || id === active || Boolean(neighbours.get(active)?.has(id)),
    [active, neighbours]
  );

  // ── Simulation ────────────────────────────────────────────────────
  // React owns which elements exist; d3 owns where they are. Positions are
  // written straight to SVG attributes through these refs, never through
  // state — a setState per node per tick would make React the bottleneck and
  // the settle would visibly stutter.
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<string, SVGLineElement>());
  const viewRef = useRef<SVGGElement | null>(null);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);
  const view = useRef({ x: 0, y: 0, scale: 1 });

  const applyView = useCallback(() => {
    const { x, y, scale } = view.current;
    viewRef.current?.setAttribute("transform", `translate(${x},${y}) scale(${scale})`);
  }, []);

  useEffect(() => {
    if (visible.nodes.length === 0) return;

    const sim: SimNode[] = visible.nodes.map((n) => ({
      id: n.id,
      r: radiusFor(n.wordCount),
    }));
    const byId = new Map(sim.map((n) => [n.id, n]));
    const links: SimEdge[] = visible.edges.map((e) => ({
      source: byId.get(e.source)!,
      target: byId.get(e.target)!,
      score: e.score,
    }));

    const simulation = forceSimulation<SimNode>(sim)
      .force("charge", forceManyBody<SimNode>().strength(-260))
      .force(
        "link",
        forceLink<SimNode, SimEdge>(links)
          .id((d) => d.id)
          // A stronger link pulls harder and settles shorter, so distance on
          // screen reads as semantic distance rather than as layout accident.
          .distance((l) => 40 + (1 - l.score) * 190)
          .strength((l) => 0.05 + l.score * 0.5)
      )
      .force("collide", forceCollide<SimNode>((d) => d.r + 4))
      .force("center", forceCenter(WIDTH / 2, HEIGHT / 2));

    simulation.on("tick", () => {
      for (const n of sim) {
        const el = nodeEls.current.get(n.id);
        if (el) el.setAttribute("transform", `translate(${n.x ?? 0},${n.y ?? 0})`);
      }
      for (const e of visible.edges) {
        const el = edgeEls.current.get(`${e.source}|${e.target}`);
        if (!el) continue;
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) continue;
        el.setAttribute("x1", String(a.x ?? 0));
        el.setAttribute("y1", String(a.y ?? 0));
        el.setAttribute("x2", String(b.x ?? 0));
        el.setAttribute("y2", String(b.y ?? 0));
      }
    });

    simRef.current = simulation;
    return () => {
      simulation.stop();
      simRef.current = null;
    };
  }, [visible]);

  // ── Pan and zoom ──────────────────────────────────────────────────
  const dragging = useRef<{ id: string | null; px: number; py: number } | null>(null);

  const onPointerDownBackground = (e: React.PointerEvent) => {
    dragging.current = { id: null, px: e.clientX, py: e.clientY };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    d.px = e.clientX;
    d.py = e.clientY;

    if (d.id === null) {
      view.current.x += dx;
      view.current.y += dy;
      applyView();
      return;
    }
    const node = simRef.current?.nodes().find((n) => n.id === d.id);
    if (!node) return;
    node.fx = (node.fx ?? node.x ?? 0) + dx / view.current.scale;
    node.fy = (node.fy ?? node.y ?? 0) + dy / view.current.scale;
    simRef.current?.alphaTarget(0.15).restart();
  };

  const onPointerUp = () => {
    if (dragging.current?.id) simRef.current?.alphaTarget(0);
    dragging.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    const next = Math.min(3, Math.max(0.3, view.current.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
    view.current.scale = next;
    applyView();
  };

  // ── States that are not a graph ───────────────────────────────────
  if (error) {
    return (
      <p className="px-4 py-16 text-center text-sm" style={{ color: "var(--text-muted)" }}>
        Could not build the graph — {error}.
      </p>
    );
  }

  if (!data && loading) {
    return (
      <p className="px-4 py-16 text-center text-sm" style={{ color: "var(--text-muted)" }}>
        Working out how everything relates…
      </p>
    );
  }

  const linkedCount = data?.nodes.filter((n) => n.linked).length ?? 0;
  if (data && linkedCount < 2) {
    return (
      <div className="px-4 py-16 text-center">
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          {linkedCount === 0
            ? "Nothing is indexed for meaning yet."
            : "Only one page is indexed so far — there is nothing to connect it to."}
        </p>
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Save a few more pages and they will start to link up.
        </p>
      </div>
    );
  }

  const nodeById = new Map((data?.nodes ?? []).map((n) => [n.id, n]));
  const activeNode = active ? nodeById.get(active) : null;

  return (
    <div className="px-3 pb-16 sm:px-4">
      <GraphLegend
        k={k}
        onK={setK}
        hidden={hidden}
        onToggleKind={(kind) =>
          setHidden((prev) => {
            const next = new Set(prev);
            if (next.has(kind)) next.delete(kind);
            else next.add(kind);
            return next;
          })
        }
        includeArchived={includeArchived}
        onIncludeArchived={setIncludeArchived}
        stats={data?.stats ?? null}
        nodeCount={visible.nodes.length}
        edgeCount={visible.edges.length}
        loading={loading}
      />

      <div
        className="relative mt-3 overflow-hidden rounded-lg border"
        style={{ borderColor: "var(--border)", background: "var(--bg-subtle)" }}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block h-[520px] w-full touch-none sm:h-[640px]"
          role="img"
          aria-label={`Semantic graph: ${visible.nodes.length} saved pages, ${visible.edges.length} connections. A text version follows below.`}
          onPointerDown={onPointerDownBackground}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <g ref={viewRef}>
            <g>
              {visible.edges.map((e) => {
                const style = STRENGTH_STYLE[e.strength];
                const dim = active && !(e.source === active || e.target === active);
                return (
                  <line
                    key={`${e.source}|${e.target}`}
                    ref={(el) => {
                      if (el) edgeEls.current.set(`${e.source}|${e.target}`, el);
                      else edgeEls.current.delete(`${e.source}|${e.target}`);
                    }}
                    stroke={e.duplicate ? "var(--accent)" : "var(--text-muted)"}
                    strokeWidth={style.width}
                    strokeDasharray={e.duplicate ? "4 3" : undefined}
                    strokeOpacity={dim ? style.opacity * 0.12 : style.opacity}
                    style={{ transition: "stroke-opacity 140ms" }}
                    aria-hidden
                  />
                );
              })}
            </g>

            <g>
              {visible.nodes.map((n) => {
                const r = radiusFor(n.wordCount);
                const dim = active !== null && !isLit(n.id);
                return (
                  <g
                    key={n.id}
                    ref={(el) => {
                      if (el) nodeEls.current.set(n.id, el);
                      else nodeEls.current.delete(n.id);
                    }}
                    style={{
                      cursor: "pointer",
                      opacity: dim ? 0.18 : 1,
                      transition: "opacity 140ms",
                    }}
                    onPointerEnter={() => setActive(n.id)}
                    onPointerLeave={() => setActive(null)}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      dragging.current = { id: n.id, px: e.clientX, py: e.clientY };
                      (e.currentTarget.ownerSVGElement as SVGSVGElement)?.setPointerCapture(
                        e.pointerId
                      );
                    }}
                    onClick={() => router.push(`/read/${n.id}`)}
                    onDoubleClick={() => {
                      const node = simRef.current?.nodes().find((s) => s.id === n.id);
                      if (node) {
                        node.fx = null;
                        node.fy = null;
                        simRef.current?.alpha(0.3).restart();
                      }
                    }}
                  >
                    <circle
                      r={r}
                      fill={n.linked ? kindColour(n.kind) : "transparent"}
                      stroke={
                        n.starred
                          ? "var(--accent)"
                          : n.linked
                            ? "transparent"
                            : "var(--text-muted)"
                      }
                      strokeWidth={n.starred ? 2.5 : 1.5}
                      strokeDasharray={n.linked ? undefined : "3 2"}
                      fillOpacity={n.status === "archived" ? 0.4 : 0.92}
                    />
                    {(active === n.id || n.starred) && (
                      <text
                        y={-r - 6}
                        textAnchor="middle"
                        style={{
                          fontSize: 11,
                          fill: "var(--text)",
                          paintOrder: "stroke",
                          stroke: "var(--bg-subtle)",
                          strokeWidth: 3,
                          pointerEvents: "none",
                        }}
                      >
                        {n.title.length > 42 ? `${n.title.slice(0, 42)}…` : n.title}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </g>
        </svg>

        {activeNode && (
          <div
            className="pointer-events-none absolute bottom-2 left-2 right-2 rounded-md border px-3 py-2 text-[12px] sm:right-auto sm:max-w-md"
            style={{
              borderColor: "var(--border)",
              background: "color-mix(in srgb, var(--bg) 94%, transparent)",
              color: "var(--text-muted)",
            }}
          >
            <div className="font-medium" style={{ color: "var(--text)" }}>
              {activeNode.title}
            </div>
            <div className="mt-0.5">
              {activeNode.kind} · {activeNode.siteName ?? new URL(activeNode.url).hostname}
              {activeNode.wordCount ? ` · ${activeNode.wordCount.toLocaleString()} words` : ""}
              {activeNode.status === "archived" ? " · archived" : ""}
            </div>
          </div>
        )}
      </div>

      <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
        Drag to pan, scroll to zoom, drag a page to pin it, double-click to release. Click to read.
      </p>

      <TextFallback data={data} />
    </div>
  );
}

/**
 * The same information without the picture.
 *
 * A force graph is unusable with a screen reader and merely hard to read on a
 * small phone, so the relationships are also stated in text. It is not a
 * consolation prize — for "what is this actually near?" the list is often the
 * faster answer.
 */
function TextFallback({ data }: { data: GraphPayload | null }) {
  if (!data) return null;

  const byNode = new Map<string, Array<{ id: string; score: number; strength: string }>>();
  for (const e of data.edges) {
    if (!byNode.has(e.source)) byNode.set(e.source, []);
    if (!byNode.has(e.target)) byNode.set(e.target, []);
    byNode.get(e.source)!.push({ id: e.target, score: e.score, strength: e.strength });
    byNode.get(e.target)!.push({ id: e.source, score: e.score, strength: e.strength });
  }
  const titles = new Map(data.nodes.map((n) => [n.id, n.title]));

  return (
    <details className="mt-6">
      <summary
        className="cursor-pointer text-[13px] font-medium"
        style={{ color: "var(--text)" }}
      >
        Connections as a list
      </summary>
      <ul className="mt-3 space-y-3">
        {data.nodes.map((n) => {
          const links = (byNode.get(n.id) ?? []).sort((a, b) => b.score - a.score);
          return (
            <li key={n.id}>
              <a
                href={`/read/${n.id}`}
                className="text-[14px] font-medium hover:underline"
                style={{ color: "var(--text)" }}
              >
                {n.title}
              </a>
              {links.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {n.linked ? "No connections above the floor." : "Not indexed for meaning."}
                </p>
              ) : (
                <ul className="mt-0.5 space-y-0.5">
                  {links.map((l) => (
                    <li
                      key={l.id}
                      className="text-[12px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {l.strength} · {Math.round(l.score * 100)}% — {titles.get(l.id)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
