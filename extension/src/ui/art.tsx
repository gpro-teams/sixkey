// Sixkey's graphic language: a vault dial. Six segments of time around a keyhole. The brand mark, the countdown on
// every code, and the large illustrations are all drawn from the same few lines of geometry below.

const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
const pt = (cx: number, cy: number, r: number, deg: number) =>
  [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))] as const;
const f2 = (n: number) => Math.round(n * 100) / 100;

/** Clockwise arc from a0 to a1 degrees, 0 at twelve o'clock. */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = pt(cx, cy, r, a0);
  const [x1, y1] = pt(cx, cy, r, a1);
  return `M${f2(x0)} ${f2(y0)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f2(x1)} ${f2(y1)}`;
}

/** Keyhole centred on (cx, cy); s is the radius of its round head. */
function keyhole(cx: number, cy: number, s: number): string {
  const top = cy - s * 1.55;
  return `M${f2(cx)} ${f2(top)}a${s} ${s} 0 0 1 ${f2(s * 0.62)} ${f2(s * 1.79)}L${f2(cx + s * 0.66)} ${f2(cy + s * 1.55)}h${f2(-s * 1.32)}L${f2(cx - s * 0.62)} ${f2(top + s * 1.79)}A${s} ${s} 0 0 1 ${f2(cx)} ${f2(top)}Z`;
}

/** The brand mark: five sixths of a dial already turned, the current second, and a keyhole. */
export function Mark({ size = 28 }: { size?: number }) {
  const [dx, dy] = pt(16, 16, 10, 330);
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect class="mk-tile" width="32" height="32" rx="8.5" />
      <path class="mk-ring" d={arc(16, 16, 10, 0, 300)} fill="none" stroke-width="3.4" stroke-linecap="round" />
      <circle class="mk-dot" cx={f2(dx)} cy={f2(dy)} r="1.75" />
      <path class="mk-key" d={keyhole(16, 16.4, 2.6)} />
    </svg>
  );
}

const SEG_GAP = 9;
const SEGS = Array.from({ length: 6 }, (_, i) => [i * 60 + SEG_GAP / 2, (i + 1) * 60 - SEG_GAP / 2] as const);
const SEG_PATHS = SEGS.map(([a0, a1]) => arc(14, 14, 11.5, a0, a1));

/**
 * How full each of the ring's six segments is, 0 to 1, with `rem` of `period` seconds left. Time drains clockwise:
 * a segment empties while the hand passes over it, and nothing changes while the hand crosses a gap.
 */
export function ringFill(rem: number, period: number): number[] {
  const gone = (1 - Math.max(0, Math.min(period, rem)) / period) * 360;
  return SEGS.map(([a0, a1]) => Math.max(0, Math.min(1, (a1 - Math.max(a0, gone)) / (a1 - a0))));
}

/**
 * Countdown dial for one code: six segments, the last of which is the red zone (the final sixth of the period).
 * Time drains clockwise, so what is left is always the end of the dial.
 *
 * Drawn statically from `rem` and redrawn once a second by the caller's clock; nothing in it animates (PHASE0X-PLAN
 * B1, O3). A continuously animated ring was measured at 25-80 ms of main-thread time per second for a popup of 100
 * accounts, against about 1-5 ms for a redraw once a second, and CSS animations inside `content-visibility: auto` rows
 * only start when a row first scrolls into view, so a delay computed at render time would put those rings out of step.
 * The same drawing is what reduced motion asks for, so there is no second path to keep in step with this one.
 */
export function Ring({ rem, period }: { rem: number; period: number }) {
  const fill = ringFill(rem, period);
  return (
    <svg class="ring" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      {SEG_PATHS.map((d, i) => (
        <g key={i}>
          <path class={i === 5 ? "trk red" : "trk"} d={d} />
          <path class="fil" d={d} pathLength={1} stroke-dasharray="1 1" stroke-dashoffset={f2(fill[i]! - 1)} />
        </g>
      ))}
      <text class="sec" x="14" y="14" dy=".36em" text-anchor="middle">
        {Math.ceil(rem)}
      </text>
    </svg>
  );
}

/** The large vault dial used on the welcome, lock and lost screens. Pure decoration. */
export function VaultDial({ size = 128, class: cls = "" }: { size?: number; class?: string }) {
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const major = i % 10 === 0;
    const [x0, y0] = pt(100, 100, 92, i * 6);
    const [x1, y1] = pt(100, 100, major ? 83 : i % 2 === 0 ? 87.5 : 89, i * 6);
    return <line key={i} class={major ? "tk maj" : "tk"} x1={f2(x0)} y1={f2(y0)} x2={f2(x1)} y2={f2(y1)} />;
  });
  const nums = Array.from({ length: 6 }, (_, i) => {
    const [x, y] = pt(100, 100, 73, i * 60);
    return (
      <text key={i} class="num" x={f2(x)} y={f2(y)} dy=".35em" text-anchor="middle">
        {i * 5}
      </text>
    );
  });
  return (
    <svg class={`dial ${cls}`} width={size} height={size} viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <circle class="face" cx="100" cy="100" r="97" />
      <g class="bezel">
        {ticks}
        {nums}
      </g>
      <circle class="face2" cx="100" cy="100" r="61" />
      <g class="wheel">
        {SEGS.map(([a0, a1], i) => (
          <path key={i} class={i === 0 ? "seg hot" : "seg"} d={arc(100, 100, 52, a0 + 1, a1 - 1)} />
        ))}
      </g>
      <circle class="knob" cx="100" cy="100" r="40" />
      <path class="hole" d={keyhole(100, 101, 8.5)} />
      <path class="idx" d="M100 2l5.5 0-5.5 10-5.5-10Z" />
    </svg>
  );
}

/** Empty list: a ghost of the row your first account will become. */
export function EmptyArt() {
  return (
    <svg class="empty-art" width="196" height="112" viewBox="0 0 196 112" aria-hidden="true" focusable="false">
      <rect class="ghost back" x="22" y="10" width="152" height="40" rx="11" />
      <rect class="ghost" x="8" y="34" width="180" height="48" rx="12" />
      <rect class="g-av" x="20" y="46" width="24" height="24" rx="7" />
      <rect class="g-ln" x="52" y="50" width="52" height="6" rx="3" />
      <rect class="g-ln soft" x="52" y="61" width="34" height="5" rx="2.5" />
      <text class="g-code" x="116" y="58" dy=".35em">
        ••• •••
      </text>
      <path class="g-ring" d={arc(170, 58, 7, 0, 300)} />
      <circle class="g-plus-bg" cx="164" cy="88" r="13" />
      <path class="g-plus" d="M164 82v12M158 88h12" />
    </svg>
  );
}

const HUES = [28, 62, 98, 150, 192, 232, 268, 318];

/** Monogram tile for an account. The colour comes from the name, so the same service always looks the same. */
export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  const s = name.trim() || "?";
  let h = 0;
  for (const ch of s.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const glyph = [...s][0]!.toUpperCase();
  return (
    <span class="av" aria-hidden="true" style={`--h:${HUES[h % HUES.length]};--s:${size}px`}>
      {glyph}
    </span>
  );
}
