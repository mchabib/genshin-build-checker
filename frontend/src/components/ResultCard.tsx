import type { CheckResponse, CheckStatus } from "../types";

const STATUS_STYLE: Record<CheckStatus, string> = {
  pass: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  warn: "text-amber-400 border-amber-500/40 bg-amber-500/10",
  fail: "text-rose-400 border-rose-500/40 bg-rose-500/10",
  skip: "text-zinc-500 border-line bg-white/5",
};

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: "OK",
  warn: "Warning",
  fail: "Kurang",
  skip: "N/A",
};

const GRADE_COLOR: Record<string, string> = {
  S: "bg-fuchsia-500",
  A: "bg-emerald-500",
  B: "bg-sky-500",
  C: "bg-amber-500",
  D: "bg-rose-500",
};

export function ResultCard({ data }: { data: CheckResponse }) {
  const { result, benchmark, character } = data;
  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center gap-4">
        <div
          className={`grid h-14 w-14 place-items-center rounded-lg text-2xl font-bold text-white ${
            GRADE_COLOR[result.grade] ?? "bg-zinc-600"
          }`}
        >
          {result.grade}
        </div>
        <div>
          <div className="text-lg font-semibold">
            {character.name}{" "}
            <span
              className={result.passed ? "text-emerald-400" : "text-rose-400"}
            >
              {result.passed ? "· Lolos benchmark" : "· Belum lolos"}
            </span>
          </div>
          <div className="text-sm text-zinc-400">
            {benchmark.label} · {benchmark.role} · sumber: {benchmark.source} · skor{" "}
            {result.score}/100
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {result.checks.map((c) => (
          <div
            key={c.key}
            className={`rounded-lg border px-3 py-2 text-sm ${STATUS_STYLE[c.status]}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{c.label}</span>
              <span className="text-xs uppercase tracking-wide">
                {STATUS_LABEL[c.status]}
                {c.actual != null && ` · ${c.actual}`}
                {` · target ${c.target}`}
              </span>
            </div>
            <p className="mt-1 text-zinc-300">{c.message}</p>
          </div>
        ))}
      </div>

      {result.recommendations.length > 0 && (
        <div className="mt-4 rounded-lg border border-line bg-white/5 p-3">
          <div className="mb-1 text-sm font-semibold text-zinc-200">Rekomendasi</div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
            {result.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-xs text-zinc-600">
        Benchmark masih placeholder — verifikasi ke KQM / Genshin Optimizer sebelum
        dijadikan patokan.
      </p>
    </div>
  );
}
