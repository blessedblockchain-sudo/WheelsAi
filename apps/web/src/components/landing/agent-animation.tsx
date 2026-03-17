"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// Phase: 0 = idle/waiting, 1 = build, 2 = deploy, 3 = monetize
type Phase = 0 | 1 | 2 | 3;

const PHASE_LABELS = ["", "Build", "Deploy", "Monetize"] as const;

// Build phase nodes
const buildNodes = [
  { id: "input", label: "IN", x: 80, y: 120, color: "#3b82f6" },
  { id: "llm", label: "LLM", x: 250, y: 120, color: "#3b82f6", large: true },
  { id: "tools", label: "TL", x: 420, y: 60, color: "#00d4ff" },
  { id: "kb", label: "KB", x: 420, y: 180, color: "#00d4ff" },
  { id: "output", label: "OUT", x: 560, y: 120, color: "#a855f7" },
];

const buildEdges = [
  { from: "input", to: "llm" },
  { from: "llm", to: "tools" },
  { from: "llm", to: "kb" },
  { from: "llm", to: "output" },
];

// Deploy phase channels
const channels = [
  { label: "DC", color: "#7c3aed", angle: 0 },
  { label: "TG", color: "#0ea5e9", angle: 60 },
  { label: "SL", color: "#22c55e", angle: 120 },
  { label: "X", color: "#ffffff", angle: 180 },
  { label: "WB", color: "#00d4ff", angle: 240 },
  { label: "API", color: "#f97316", angle: 300 },
];

function getNodePos(id: string) {
  const n = buildNodes.find((n) => n.id === id);
  return n ? { x: n.x, y: n.y } : { x: 0, y: 0 };
}

export function AgentAnimation() {
  const [phase, setPhase] = useState<Phase>(0);
  const [revenue, setRevenue] = useState(0);
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revenueRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (revenueRef.current) clearInterval(revenueRef.current);
  }, []);

  const startLoop = useCallback(() => {
    clearTimers();
    setPhase(1);
    setRevenue(0);

    // Phase 1 -> 2 at 2.5s
    timerRef.current = setTimeout(() => {
      setPhase(2);

      // Phase 2 -> 3 at 5s
      timerRef.current = setTimeout(() => {
        setPhase(3);

        // Revenue counter animation
        let rev = 0;
        revenueRef.current = setInterval(() => {
          rev += 47;
          if (rev >= 1247) {
            rev = 1247;
            if (revenueRef.current) clearInterval(revenueRef.current);
          }
          setRevenue(rev);
        }, 50);

        // Hold 2s, then fade and restart
        timerRef.current = setTimeout(() => {
          setPhase(0);
          timerRef.current = setTimeout(() => {
            startLoop();
          }, 1000);
        }, 2000);
      }, 2500);
    }, 2500);
  }, [clearTimers]);

  // IntersectionObserver trigger
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !visible) {
          setVisible(true);
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // Start animation loop when visible
  useEffect(() => {
    if (visible) startLoop();
    return clearTimers;
  }, [visible, startLoop, clearTimers]);

  const cx = 320;
  const cy = 120;
  const channelRadius = 100;

  return (
    <section className="relative bg-navy-950 py-24 overflow-hidden">
      <div className="absolute inset-0 grid-bg-navy" />
      <div className="relative mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-bold text-white">
            See Your Agent{" "}
            <span className="gradient-text-navy">Come to Life</span>
          </h2>
          <p className="mt-4 text-lg text-navy-200/60 max-w-2xl mx-auto">
            From visual builder to multi-channel deployment to marketplace revenue.
          </p>
        </div>

        <div
          ref={containerRef}
          className="relative mx-auto"
          style={{ maxWidth: 640 }}
        >
          <svg
            viewBox="0 0 640 240"
            className="w-full h-auto"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Phase 1: Build */}
            {phase === 1 && (
              <g className="transition-opacity duration-500">
                {/* Edges */}
                {buildEdges.map((edge, i) => {
                  const from = getNodePos(edge.from);
                  const to = getNodePos(edge.to);
                  const length = Math.sqrt(
                    (to.x - from.x) ** 2 + (to.y - from.y) ** 2
                  );
                  return (
                    <line
                      key={`edge-${i}`}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="#3b82f6"
                      strokeWidth="2"
                      strokeDasharray={length}
                      strokeDashoffset={length}
                      opacity="0.5"
                      style={{
                        ["--line-length" as string]: length,
                        animation: `draw-line 0.6s ease-out ${0.8 + i * 0.2}s forwards`,
                      }}
                    />
                  );
                })}

                {/* Nodes */}
                {buildNodes.map((node, i) => {
                  const r = node.large ? 30 : 22;
                  return (
                    <g
                      key={node.id}
                      style={{
                        animation: `scale-in 0.4s ease-out ${i * 0.15}s both`,
                        transformOrigin: `${node.x}px ${node.y}px`,
                      }}
                    >
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={r}
                        fill="#0f172a"
                        stroke={node.color}
                        strokeWidth="2"
                      />
                      {node.id === "llm" && (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={r + 4}
                          fill="none"
                          stroke="#3b82f6"
                          strokeWidth="1"
                          opacity="0.4"
                          style={{
                            animation:
                              "glow-pulse-blue 2s ease-in-out 1.5s infinite",
                          }}
                        />
                      )}
                      <text
                        x={node.x}
                        y={node.y + 4}
                        textAnchor="middle"
                        fill={node.color}
                        fontSize="10"
                        fontWeight="bold"
                        fontFamily="monospace"
                      >
                        {node.label}
                      </text>
                    </g>
                  );
                })}
              </g>
            )}

            {/* Phase 2: Deploy */}
            {phase === 2 && (
              <g className="transition-opacity duration-500">
                {/* Central agent node */}
                <g
                  style={{
                    animation: "scale-in 0.4s ease-out both",
                    transformOrigin: `${cx}px ${cy}px`,
                  }}
                >
                  <circle
                    cx={cx}
                    cy={cy}
                    r={28}
                    fill="#0f172a"
                    stroke="#3b82f6"
                    strokeWidth="2.5"
                  />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={32}
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth="1"
                    opacity="0.4"
                    style={{
                      animation:
                        "glow-pulse-blue 2s ease-in-out infinite",
                    }}
                  />
                  <text
                    x={cx}
                    y={cy + 4}
                    textAnchor="middle"
                    fill="#3b82f6"
                    fontSize="10"
                    fontWeight="bold"
                    fontFamily="monospace"
                  >
                    BOT
                  </text>
                </g>

                {/* Channel icons + lines */}
                {channels.map((ch, i) => {
                  const angle = (ch.angle * Math.PI) / 180;
                  const tx = cx + Math.cos(angle) * channelRadius;
                  const ty = cy + Math.sin(angle) * channelRadius;
                  const lineLength = channelRadius - 28 - 16;

                  return (
                    <g key={ch.label}>
                      {/* Radial line */}
                      <line
                        x1={cx + Math.cos(angle) * 30}
                        y1={cy + Math.sin(angle) * 30}
                        x2={tx - Math.cos(angle) * 16}
                        y2={ty - Math.sin(angle) * 16}
                        stroke={ch.color}
                        strokeWidth="1.5"
                        strokeDasharray={lineLength}
                        strokeDashoffset={lineLength}
                        opacity="0.5"
                        style={{
                          ["--line-length" as string]: lineLength,
                          animation: `draw-line 0.5s ease-out ${0.3 + i * 0.12}s forwards`,
                        }}
                      />

                      {/* Traveling dot */}
                      <circle
                        cx={cx + Math.cos(angle) * 34}
                        cy={cy + Math.sin(angle) * 34}
                        r="2.5"
                        fill={ch.color}
                        opacity="0"
                        style={{
                          ["--travel-dist" as string]: `${Math.cos(angle) * (channelRadius - 50)}px`,
                          animation: `travel-dot 1.5s linear ${1 + i * 0.2}s infinite`,
                          transformOrigin: `${cx + Math.cos(angle) * 34}px ${cy + Math.sin(angle) * 34}px`,
                        }}
                      />

                      {/* Channel circle */}
                      <g
                        style={{
                          animation: `scale-in 0.35s ease-out ${0.5 + i * 0.1}s both`,
                          transformOrigin: `${tx}px ${ty}px`,
                        }}
                      >
                        <circle
                          cx={tx}
                          cy={ty}
                          r="16"
                          fill="#0f172a"
                          stroke={ch.color}
                          strokeWidth="1.5"
                        />
                        <text
                          x={tx}
                          y={ty + 3.5}
                          textAnchor="middle"
                          fill={ch.color}
                          fontSize="8"
                          fontWeight="bold"
                          fontFamily="monospace"
                        >
                          {ch.label}
                        </text>
                      </g>
                    </g>
                  );
                })}
              </g>
            )}

            {/* Phase 3: Monetize */}
            {phase === 3 && (
              <g className="transition-opacity duration-500">
                {/* Agent node (smaller, shifted up) */}
                <g
                  style={{
                    animation: "scale-in 0.3s ease-out both",
                    transformOrigin: `${cx}px 80px`,
                  }}
                >
                  <circle
                    cx={cx}
                    cy={80}
                    r={22}
                    fill="#0f172a"
                    stroke="#a855f7"
                    strokeWidth="2"
                  />
                  <text
                    x={cx}
                    y={84}
                    textAnchor="middle"
                    fill="#a855f7"
                    fontSize="10"
                    fontWeight="bold"
                    fontFamily="monospace"
                  >
                    BOT
                  </text>
                </g>

                {/* Marketplace card */}
                <g
                  style={{
                    animation: "scale-in 0.4s ease-out 0.3s both",
                    transformOrigin: `${cx}px 160px`,
                  }}
                >
                  <rect
                    x={cx - 80}
                    y={120}
                    width={160}
                    height={80}
                    rx="8"
                    fill="#0f172a"
                    stroke="#a855f7"
                    strokeWidth="1.5"
                  />
                  {/* Agent name */}
                  <text
                    x={cx - 60}
                    y={142}
                    fill="white"
                    fontSize="11"
                    fontWeight="bold"
                  >
                    my-support-bot
                  </text>
                  {/* Free badge */}
                  <rect
                    x={cx + 30}
                    y={132}
                    width={36}
                    height={16}
                    rx="4"
                    fill="#22c55e"
                    opacity="0.2"
                  />
                  <text
                    x={cx + 48}
                    y={143}
                    textAnchor="middle"
                    fill="#22c55e"
                    fontSize="8"
                    fontWeight="bold"
                  >
                    FREE
                  </text>
                  {/* Stars */}
                  <text
                    x={cx - 60}
                    y={160}
                    fill="#eab308"
                    fontSize="9"
                  >
                    ★★★★★ 4.8
                  </text>
                  {/* Revenue */}
                  <text
                    x={cx - 60}
                    y={185}
                    fill="#22c55e"
                    fontSize="16"
                    fontWeight="bold"
                  >
                    ${revenue.toLocaleString()}
                  </text>
                  <text
                    x={cx + 20}
                    y={185}
                    fill="#64748b"
                    fontSize="9"
                  >
                    earned
                  </text>
                </g>

                {/* SOL coin particles */}
                {[0, 1, 2].map((i) => (
                  <circle
                    key={`coin-${i}`}
                    cx={cx - 20 + i * 20}
                    cy={115}
                    r="4"
                    fill="#a855f7"
                    opacity="0"
                    style={{
                      animation: `float-up-fade 1.5s ease-out ${0.5 + i * 0.4}s infinite`,
                    }}
                  />
                ))}
              </g>
            )}

            {/* Empty state when phase is 0 */}
            {phase === 0 && visible && (
              <g className="transition-opacity duration-300 opacity-30">
                <text
                  x={cx}
                  y={cy + 4}
                  textAnchor="middle"
                  fill="#64748b"
                  fontSize="12"
                  fontFamily="monospace"
                >
                  ...
                </text>
              </g>
            )}
          </svg>
        </div>

        {/* Phase indicator dots */}
        <div className="flex items-center justify-center gap-6 mt-8">
          {([1, 2, 3] as const).map((p) => (
            <div key={p} className="flex items-center gap-2">
              <div
                className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${
                  phase === p
                    ? "bg-navy-400"
                    : "bg-navy-700"
                }`}
              />
              <span
                className={`text-sm font-medium transition-colors duration-300 ${
                  phase === p
                    ? "text-white"
                    : "text-navy-400"
                }`}
              >
                {PHASE_LABELS[p]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
