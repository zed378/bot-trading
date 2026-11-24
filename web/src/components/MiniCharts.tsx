// Tiny sparkline for desk monitors.
export function Sparkline({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${36 - ((v - min) / (max - min || 1)) * 30}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={up ? 'var(--long)' : 'var(--short)'} strokeWidth="3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
