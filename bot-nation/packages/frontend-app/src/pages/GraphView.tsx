import { useEffect, useRef, useState } from "react";
import { graph } from "../api/client";

interface GraphNode {
  id: string;
  kind: "agent" | "team" | "task" | "tool";
  label: string;
  status?: string;
  domain?: string;
  toolKind?: string;
  // layout position (mutable)
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

interface GraphData {
  nodes: Omit<GraphNode, "x" | "y" | "vx" | "vy">[];
  edges: GraphEdge[];
}

const NODE_COLOR: Record<string, string> = {
  agent: "#5b8af0",
  team:  "#a070f0",
  task:  "#f0c040",
  tool:  "#3ddc97",
};

const NODE_RADIUS = 18;

function runLayout(nodes: GraphNode[], edges: GraphEdge[], iterations = 120) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const k = Math.sqrt((800 * 600) / Math.max(nodes.length, 1)) * 0.8;

  for (let i = 0; i < iterations; i++) {
    // repulsion
    for (let a = 0; a < nodes.length; a++) {
      const na = nodes[a]!;
      for (let b = a + 1; b < nodes.length; b++) {
        const nb = nodes[b]!;
        const dx = na.x - nb.x;
        const dy = na.y - nb.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (k * k) / dist;
        na.vx += (dx / dist) * force * 0.05;
        na.vy += (dy / dist) * force * 0.05;
        nb.vx -= (dx / dist) * force * 0.05;
        nb.vy -= (dy / dist) * force * 0.05;
      }
    }
    // attraction
    for (const e of edges) {
      const src = nodeMap.get(e.source);
      const tgt = nodeMap.get(e.target);
      if (!src || !tgt) continue;
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const force = (dist * dist) / k * 0.02;
      src.vx += (dx / dist) * force;
      src.vy += (dy / dist) * force;
      tgt.vx -= (dx / dist) * force;
      tgt.vy -= (dy / dist) * force;
    }
    // apply + dampen
    for (const n of nodes) {
      n.x += Math.max(-10, Math.min(10, n.vx));
      n.y += Math.max(-10, Math.min(10, n.vy));
      n.vx *= 0.85;
      n.vy *= 0.85;
      // keep in bounds
      n.x = Math.max(NODE_RADIUS + 10, Math.min(790 - NODE_RADIUS, n.x));
      n.y = Math.max(NODE_RADIUS + 10, Math.min(590 - NODE_RADIUS, n.y));
    }
  }
}

export function GraphView() {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    (graph.get() as Promise<GraphData>)
      .then((data) => {
        const positioned: GraphNode[] = data.nodes.map((n, i) => ({
          ...n,
          x: 100 + (i % 8) * 90 + Math.random() * 20,
          y: 80 + Math.floor(i / 8) * 100 + Math.random() * 20,
          vx: 0,
          vy: 0,
        }));
        runLayout(positioned, data.edges);
        setNodes(positioned);
        setEdges(data.edges);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  if (loading) return <div className="loading">building graph…</div>;

  return (
    <div>
      <div className="page-title">Workspace Graph</div>
      <div className="page-subtitle">Entity relationships — agents, teams, tasks, tools</div>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 16 }}>
        {/* Legend */}
        <div className="card" style={{ minWidth: 140, alignSelf: "flex-start" }}>
          <div className="card-title">Legend</div>
          {Object.entries(NODE_COLOR).map(([kind, color]) => (
            <div key={kind} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: color, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{kind}</span>
            </div>
          ))}
          {selected && (
            <>
              <div style={{ borderTop: "1px solid var(--border)", margin: "10px 0" }} />
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Selected</div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>{selected.label}</div>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{selected.kind}</div>
              {selected.status && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>status: {selected.status}</div>}
              {selected.domain && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>domain: {selected.domain}</div>}
              <div className="mono" style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, wordBreak: "break-all" }}>{selected.id}</div>
            </>
          )}
        </div>

        {/* SVG graph */}
        <div className="card" style={{ flex: 1, padding: 0, overflow: "hidden" }}>
          {nodes.length === 0 ? (
            <div className="empty" style={{ padding: 32 }}>No entities yet. Create agents, teams, and tasks to populate the graph.</div>
          ) : (
            <svg
              ref={svgRef}
              viewBox="0 0 800 600"
              style={{ width: "100%", height: 480, display: "block", background: "var(--bg-base)" }}
            >
              {/* Edges */}
              {edges.map((e, i) => {
                const src = nodeMap.get(e.source);
                const tgt = nodeMap.get(e.target);
                if (!src || !tgt) return null;
                return (
                  <line key={i}
                    x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                    stroke="var(--border-bright)" strokeWidth={1} opacity={0.5}
                  />
                );
              })}
              {/* Edge labels */}
              {edges.map((e, i) => {
                const src = nodeMap.get(e.source);
                const tgt = nodeMap.get(e.target);
                if (!src || !tgt) return null;
                return (
                  <text key={`lbl-${i}`}
                    x={(src.x + tgt.x) / 2} y={(src.y + tgt.y) / 2}
                    textAnchor="middle" fontSize={8} fill="var(--text-muted)" opacity={0.7}>
                    {e.relation}
                  </text>
                );
              })}
              {/* Nodes */}
              {nodes.map((n) => (
                <g key={n.id} style={{ cursor: "pointer" }} onClick={() => setSelected(n === selected ? null : n)}>
                  <circle
                    cx={n.x} cy={n.y} r={NODE_RADIUS}
                    fill={NODE_COLOR[n.kind] ?? "#666"}
                    opacity={selected && selected.id !== n.id ? 0.5 : 1}
                    stroke={selected?.id === n.id ? "#fff" : "transparent"}
                    strokeWidth={2}
                  />
                  <text x={n.x} y={n.y + NODE_RADIUS + 12}
                    textAnchor="middle" fontSize={10} fill="var(--text-secondary)">
                    {n.label.length > 14 ? n.label.slice(0, 13) + "…" : n.label}
                  </text>
                </g>
              ))}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
