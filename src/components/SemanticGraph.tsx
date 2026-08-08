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

/**
 * Fallback frame, used only before the element has been measured.
 *
 * The viewBox is otherwise set to the container's real pixel size. A fixed
 * landscape viewBox letterboxes into a portrait phone: preserveAspectRatio
 * scales 1000x640 down to fit a ~350x550 box, which is 35% — so even a
 * perfectly fitted layout rendered a third of the size with dead bands above
 * and below it. Matching the viewBox to the element makes one user unit one
 * CSS pixel, which also makes the pointer maths trivial.
 */
const FALLBACK_WIDTH = 1000;
const FALLBACK_HEIGHT = 640;

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

  // Keep fitting the view to the layout until the reader takes control. The
  // simulation settles into whatever area the forces dictate, which for nine
  // nodes is a small knot in the middle of a canvas sized for two hundred —
  // so a fixed viewBox renders a handful of items as a speck, worst of all on
  // a phone where the whole thing is already scaled down to fit the screen.
  const autoFit = useRef(true);
  const fitRef = useRef<(() => void) | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: FALLBACK_WIDTH, h: FALLBACK_HEIGHT });
  const [size, setSize] = useState({ w: FALLBACK_WIDTH, h: FALLBACK_HEIGHT });

  const applyView = useCallback(() => {
    const { x, y, scale } = view.current;
    viewRef.current?.setAttribute("transform", `translate(${x},${y}) scale(${scale})`);
  }, []);

  /** Any deliberate pan, zoom or drag means "stop moving the camera on me". */
  const takeControl = useCallback(() => {
    autoFit.current = false;
  }, []);

  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const w = Math.max(1, Math.round(el.clientWidth));
      const h = Math.max(1, Math.round(el.clientHeight));
      sizeRef.current = { w, h };
      // Only re-render for a change worth re-rendering for: on a phone the
      // viewport height twitches by a pixel or two as the URL bar moves.
      setSize((prev) =>
        Math.abs(prev.w - w) > 2 || Math.abs(prev.h - h) > 2 ? { w, h } : prev
      );
      if (autoFit.current) fitRef.current?.();
    });
    observer.observe(el);
    return () => observer.disconnect();
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
      // Centred on the origin rather than on the viewport: fit() frames the
      // result, so where the simulation happens to settle is irrelevant.
      .force("center", forceCenter(0, 0));

    /**
     * Frames the layout: scale so the nodes fill the viewport, then centre.
     *
     * Capped at 2.2x because fitting three nodes exactly would blow them up to
     * absurd size — past that point the graph should sit smaller in a roomy
     * canvas rather than fill it.
     */
    const fit = () => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of sim) {
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        minX = Math.min(minX, x - n.r);
        minY = Math.min(minY, y - n.r);
        maxX = Math.max(maxX, x + n.r);
        maxY = Math.max(maxY, y + n.r);
      }
      if (!Number.isFinite(minX)) return;

      // Room for the labels, which are drawn above each node and are wider
      // than the circle they belong to.
      const { w, h } = sizeRef.current;
      // Labels are drawn above each node and are wider than its circle.
      const pad = 56;
      const bw = Math.max(1, maxX - minX + pad * 2);
      const bh = Math.max(1, maxY - minY + pad * 2);
      // Floor is deliberately low: on a narrow phone a large library needs to
      // zoom out past 0.2 to fit at all, and clipping nodes off-screen is
      // worse than drawing them small — they can always be zoomed into.
      const scale = Math.min(2.2, Math.max(0.08, Math.min(w / bw, h / bh)));

      view.current.scale = scale;
      view.current.x = w / 2 - ((minX + maxX) / 2) * scale;
      view.current.y = h / 2 - ((minY + maxY) / 2) * scale;
      applyView();
    };
    fitRef.current = fit;

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
      if (autoFit.current) fit();
    });

    // A fresh layout re-frames itself; only an explicit gesture opts out.
    autoFit.current = true;

    simRef.current = simulation;
    return () => {
      simulation.stop();
      simRef.current = null;
      fitRef.current = null;
    };
  }, [visible, applyView]);

  // ── Pan and zoom ──────────────────────────────────────────────────
  const dragging = useRef<{ id: string | null; px: number; py: number } | null>(null);
  // A phone has no hover, so a first tap has to be able to mean "show me what
  // this is" rather than "open it". Recorded on pointerdown because the click
  // event does not carry the pointer type.
  const tapContext = useRef({ touch: false, wasActive: false });

  /**
   * Every pointer currently down, so two of them can be recognised as a pinch.
   *
   * The SVG sets `touch-action: none`, which switches off the browser's own
   * pan and zoom on this element. That is necessary — otherwise dragging a
   * node would scroll the page — but it means pinch has to be implemented
   * here. It was not, so on a phone there was no way to zoom at all.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  const MIN_SCALE = 0.15;
  const MAX_SCALE = 5;

  /** Screen coordinates relative to the SVG. viewBox matches the element's
   *  pixel size, so these are already user units — no matrix maths needed. */
  const localPoint = (e: { clientX: number; clientY: number }, el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Zooms about a fixed point, so the thing under the fingers stays put. */
  const zoomAbout = useCallback(
    (factor: number, cx: number, cy: number) => {
      const from = view.current.scale;
      const to = Math.min(MAX_SCALE, Math.max(MIN_SCALE, from * factor));
      if (to === from) return;
      view.current.x = cx - (cx - view.current.x) * (to / from);
      view.current.y = cy - (cy - view.current.y) * (to / from);
      view.current.scale = to;
      applyView();
    },
    [applyView]
  );

  const onPointerDownBackground = (e: React.PointerEvent) => {
    const svg = e.currentTarget as SVGSVGElement;
    const p = localPoint(e, svg);
    pointers.current.set(e.pointerId, p);
    svg.setPointerCapture(e.pointerId);

    if (pointers.current.size === 2) {
      // A second finger converts whatever was happening into a pinch.
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      dragging.current = null;
      return;
    }
    // The node's own handler runs first (the event starts at the node and
    // bubbles), so a drag already in progress must not be overwritten here.
    if (pointers.current.size === 1 && dragging.current === null) {
      dragging.current = { id: null, px: e.clientX, py: e.clientY };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const svg = e.currentTarget as SVGSVGElement;
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, localPoint(e, svg));
    }

    // ── Two fingers: pinch to zoom, and pan by the midpoint ──
    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const prev = pinch.current;
      pinch.current = { dist, cx, cy };
      if (!prev || prev.dist === 0) return;

      takeControl();
      // Move with the midpoint first, then scale about where it now is.
      view.current.x += cx - prev.cx;
      view.current.y += cy - prev.cy;
      zoomAbout(dist / prev.dist, cx, cy);
      return;
    }

    const d = dragging.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    d.px = e.clientX;
    d.py = e.clientY;

    if (d.id === null) {
      // Only count it as taking control once the pointer has actually moved —
      // a plain tap on the background should not freeze the camera.
      takeControl();
      view.current.x += dx;
      view.current.y += dy;
      applyView();
      return;
    }
    const node = simRef.current?.nodes().find((n) => n.id === d.id);
    if (!node) return;
    takeControl();
    node.fx = (node.fx ?? node.x ?? 0) + dx / view.current.scale;
    node.fy = (node.fy ?? node.y ?? 0) + dy / view.current.scale;
    simRef.current?.alphaTarget(0.15).restart();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (dragging.current?.id) simRef.current?.alphaTarget(0);
    dragging.current = null;
  };

  const resetView = () => {
    autoFit.current = true;
    fitRef.current?.();
  };

  /** Button zoom, about the middle of the frame. Touch needs a route to zoom
   *  that does not depend on getting a two-finger gesture right. */
  const nudgeZoom = (factor: number) => {
    takeControl();
    zoomAbout(factor, sizeRef.current.w / 2, sizeRef.current.h / 2);
  };

  const onWheel = (e: React.WheelEvent) => {
    takeControl();
    const p = localPoint(e, e.currentTarget as SVGSVGElement);
    zoomAbout(e.deltaY < 0 ? 1.12 : 0.89, p.x, p.y);
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
  // Few enough nodes that every label fits without becoming a wall of text.
  const labelAll = visible.nodes.length <= 25;

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
        ref={frameRef}
        className="relative mt-3 h-[68vh] max-h-[720px] min-h-[380px] overflow-hidden rounded-lg border sm:h-[640px]"
        style={{ borderColor: "var(--border)", background: "var(--bg-subtle)" }}
      >
        <svg
          viewBox={`0 0 ${size.w} ${size.h}`}
          className="block h-full w-full touch-none"
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
                      tapContext.current = {
                        touch: e.pointerType === "touch",
                        wasActive: active === n.id,
                      };
                      dragging.current = { id: n.id, px: e.clientX, py: e.clientY };
                      (e.currentTarget.ownerSVGElement as SVGSVGElement)?.setPointerCapture(
                        e.pointerId
                      );
                    }}
                    onClick={() => {
                      const { touch, wasActive } = tapContext.current;
                      if (touch && !wasActive) {
                        setActive(n.id);
                        return;
                      }
                      router.push(`/read/${n.id}`);
                    }}
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
                    {(labelAll || active === n.id || n.starred) && (
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

        <div className="absolute right-2 top-2 flex flex-col gap-1">
          {[
            { label: "+", title: "Zoom in", factor: 1.3 },
            { label: "−", title: "Zoom out", factor: 0.77 },
          ].map((b) => (
            <button
              key={b.title}
              type="button"
              title={b.title}
              aria-label={b.title}
              onClick={() => nudgeZoom(b.factor)}
              className="size-8 rounded-md border text-[15px] leading-none backdrop-blur transition-colors hover:bg-[var(--bg-subtle)]"
              style={{
                borderColor: "var(--border)",
                color: "var(--text)",
                background: "color-mix(in srgb, var(--bg) 80%, transparent)",
              }}
            >
              {b.label}
            </button>
          ))}
          <button
            type="button"
            title="Fit to view"
            aria-label="Fit to view"
            onClick={resetView}
            className="size-8 rounded-md border text-[11px] leading-none backdrop-blur transition-colors hover:bg-[var(--bg-subtle)]"
            style={{
              borderColor: "var(--border)",
              color: "var(--text)",
              background: "color-mix(in srgb, var(--bg) 80%, transparent)",
            }}
          >
            Fit
          </button>
        </div>

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

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          <span className="hidden sm:inline">
            Drag to pan, scroll to zoom, drag a page to pin it, double-click to release. Click to read.
          </span>
          <span className="sm:hidden">
            Tap a page to see it, tap again to read. Drag to pan, pinch to zoom.
          </span>
        </p>
      </div>

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
