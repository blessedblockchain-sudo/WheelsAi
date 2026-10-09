/**
 * The picture beside the headline: an agent answering on top, the GPU that
 * runs its model underneath, and the request and the answer moving between
 * them. Drawn as one SVG in the page's own colours, so it is sharp at any
 * size and needs no image file.
 */

const FAN_BLADES = 7;
const CHIP_CELLS = 4;

const MOTION = `
.hv-token { animation: hv-token 4.2s ease-in-out infinite; }
.hv-cell { animation: hv-cell 2.4s ease-in-out infinite; }
.hv-spin { transform-box: fill-box; transform-origin: center; animation: hv-spin 3.2s linear infinite; }
.hv-down { animation: hv-down 1.8s linear infinite; }
.hv-up { animation: hv-up 1.8s linear infinite; }
@keyframes hv-token { 0%, 8% { opacity: 0; } 20%, 86% { opacity: 1; } 100% { opacity: 0; } }
@keyframes hv-cell { 0%, 100% { opacity: 0.18; } 50% { opacity: 1; } }
@keyframes hv-spin { to { transform: rotate(360deg); } }
@keyframes hv-down { 0% { transform: translateY(0); opacity: 0; } 15%, 85% { opacity: 1; } 100% { transform: translateY(84px); opacity: 0; } }
@keyframes hv-up { 0% { transform: translateY(0); opacity: 0; } 15%, 85% { opacity: 1; } 100% { transform: translateY(-84px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .hv-token, .hv-cell, .hv-spin, .hv-down, .hv-up { animation: none; }
  .hv-down, .hv-up { opacity: 0; }
}
`;

/** The words of the answer, as bars that appear one after another. */
const ANSWER_BARS = [
  { x: 92, y: 118, width: 62 },
  { x: 160, y: 118, width: 40 },
  { x: 206, y: 118, width: 74 },
  { x: 92, y: 132, width: 88 },
  { x: 186, y: 132, width: 52 },
];

function Fan({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g transform={`translate(${cx} ${cy})`}>
      <circle
        r="60"
        className="fill-navy-950 stroke-navy-600"
        strokeWidth="1.5"
      />
      <g className="hv-spin">
        {/* Keeps the spinning group's box square, so it turns about its centre. */}
        <circle r="54" fill="transparent" />
        {Array.from({ length: FAN_BLADES }, (_, i) => (
          <path
            key={i}
            d="M0 -10 C 16 -20, 24 -40, 8 -52 C -6 -42, -10 -24, 0 -10 Z"
            transform={`rotate(${(i * 360) / FAN_BLADES})`}
            className="fill-navy-800 stroke-navy-600"
            strokeWidth="1"
          />
        ))}
      </g>
      <circle
        r="11"
        className="fill-navy-900 stroke-navy-400"
        strokeWidth="1.5"
      />
    </g>
  );
}

export function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-md lg:max-w-none">
      <div className="absolute left-1/2 top-[62%] h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-navy-400/20 blur-[90px] pointer-events-none" />
      <svg
        viewBox="0 0 480 500"
        role="img"
        aria-label="An agent answers a question. Its model runs on a GPU on the Nosana network, and the answer streams back."
        className="relative w-full h-auto"
      >
        <style>{MOTION}</style>

        {/* The agent, answering */}
        <rect
          x="60"
          y="10"
          width="360"
          height="150"
          rx="14"
          className="fill-navy-900 stroke-navy-600"
          strokeWidth="1.5"
        />
        <circle cx="90" cy="40" r="10" className="fill-navy-400" />
        <text x="108" y="45" className="fill-white text-[14px] font-semibold">
          Support agent
        </text>
        <rect
          x="352"
          y="29"
          width="50"
          height="22"
          rx="11"
          className="fill-navy-400/15 stroke-navy-400/50"
          strokeWidth="1"
        />
        <text
          x="377"
          y="44"
          textAnchor="middle"
          className="fill-navy-200 text-[11px] font-medium"
        >
          Live
        </text>
        <rect
          x="236"
          y="62"
          width="166"
          height="30"
          rx="10"
          className="fill-navy-400/25"
        />
        <text
          x="319"
          y="81"
          textAnchor="middle"
          className="fill-white text-[12px]"
        >
          Where is my order?
        </text>
        <rect
          x="78"
          y="104"
          width="222"
          height="44"
          rx="10"
          className="fill-navy-800"
        />
        {ANSWER_BARS.map((bar, i) => (
          <rect
            key={`${bar.x}-${bar.y}`}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height="6"
            rx="3"
            className="hv-token fill-navy-200"
            style={{ animationDelay: `${i * 0.3}s` }}
          />
        ))}

        {/* The request going down, the answer coming back */}
        <path
          d="M200 162 V248"
          className="stroke-navy-600"
          strokeWidth="1.5"
          strokeDasharray="4 5"
          fill="none"
        />
        <path
          d="M280 162 V248"
          className="stroke-navy-600"
          strokeWidth="1.5"
          strokeDasharray="4 5"
          fill="none"
        />
        {[0, 0.6, 1.2].map((delay) => (
          <circle
            key={`d${delay}`}
            cx="200"
            cy="163"
            r="3.5"
            className="hv-down fill-white"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
        {[0.3, 0.9, 1.5].map((delay) => (
          <circle
            key={`u${delay}`}
            cx="280"
            cy="247"
            r="3.5"
            className="hv-up fill-navy-400"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
        <text
          x="188"
          y="209"
          textAnchor="end"
          className="fill-navy-200/60 text-[11px]"
        >
          request
        </text>
        <text x="292" y="209" className="fill-navy-200/60 text-[11px]">
          answer
        </text>

        {/* The GPU */}
        <rect
          x="24"
          y="250"
          width="432"
          height="200"
          rx="16"
          className="fill-navy-900 stroke-navy-600"
          strokeWidth="1.5"
        />
        <Fan cx={104} cy={350} />
        <Fan cx={376} cy={350} />
        <path
          d="M164 350 H190 M290 350 H316 M240 280 V300 M240 400 V420"
          className="stroke-navy-600"
          strokeWidth="1.5"
          fill="none"
        />
        <rect
          x="190"
          y="300"
          width="100"
          height="100"
          rx="8"
          className="fill-navy-950 stroke-navy-400"
          strokeWidth="1.5"
        />
        {Array.from({ length: CHIP_CELLS * CHIP_CELLS }, (_, i) => {
          const row = Math.floor(i / CHIP_CELLS);
          const col = i % CHIP_CELLS;
          return (
            <rect
              key={i}
              x={202 + col * 20}
              y={312 + row * 20}
              width="16"
              height="16"
              rx="3"
              className="hv-cell fill-navy-400"
              style={{ animationDelay: `${(row + col) * 0.18}s` }}
            />
          );
        })}
        {Array.from({ length: 22 }, (_, i) => (
          <rect
            key={i}
            x={153 + i * 8}
            y="450"
            width="5"
            height="12"
            rx="1"
            className="fill-navy-600"
          />
        ))}

        <text
          x="240"
          y="490"
          textAnchor="middle"
          className="fill-navy-200/70 text-[12px]"
        >
          A GPU on the Nosana network, billed per second
        </text>
      </svg>
    </div>
  );
}
