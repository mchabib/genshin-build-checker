import { useMemo, useState, type FormEvent } from "react";
import { api, ApiRequestError } from "../api";
import type { Character, CheckResponse, EnkaResult, ShowcaseCharacter } from "../types";

export function UidPanel({
  characters,
  onResult,
}: {
  characters: Character[];
  onResult: (r: CheckResponse) => void;
}) {
  const [uid, setUid] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<EnkaResult | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [benchmarkId, setBenchmarkId] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);

  const selected: ShowcaseCharacter | undefined = data?.characters.find(
    (c) => c.enkaAvatarId === selectedId,
  );
  const dbChar = useMemo(
    () => characters.find((c) => c.key === selected?.key),
    [characters, selected],
  );

  async function fetchProfile(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setData(null);
    setSelectedId(null);
    try {
      const res = await api.fetchEnka(uid.trim());
      setData(res);
      const firstSupported = res.characters.find((c) => c.supported);
      if (firstSupported) setSelectedId(firstSupported.enkaAvatarId);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(
          err.message +
            (err.retryAfterSeconds ? ` (tunggu ${err.retryAfterSeconds}s)` : ""),
        );
      } else {
        setError("Gagal menghubungi server.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function runCheck() {
    if (!selected || !selected.key) return;
    setChecking(true);
    try {
      const res = await api.check({
        source: "enka",
        characterKey: selected.key,
        benchmarkId: benchmarkId ?? dbChar?.benchmarks.find((b) => b.isDefault)?.id,
        stats: selected.stats,
        substatCritValue: selected.substatCritValue,
        substatTotals: selected.substatTotals,
        uid: data?.meta.uid,
      });
      onResult(res);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Gagal cek build.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={fetchProfile} className="flex gap-2">
        <input
          value={uid}
          onChange={(e) => setUid(e.target.value)}
          placeholder="UID Genshin (9-10 digit)"
          inputMode="numeric"
          className="flex-1 rounded-lg border border-line bg-ink px-3 py-2 outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          disabled={loading || uid.trim().length < 9}
          className="rounded-lg bg-sky-600 px-4 py-2 font-medium disabled:opacity-40"
        >
          {loading ? "Fetching…" : "Fetch"}
        </button>
      </form>

      <p className="text-xs text-zinc-500">
        Pin karakter yang mau dicek di <b>Character Showcase</b> in-game (max 8), dan
        aktifkan <b>Show Character Details</b> di privasi. Data adalah snapshot terakhir
        profile di-refresh, ada cooldown ±60 detik per UID.
      </p>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      {data && (
        <div className="space-y-3">
          <div className="text-sm text-zinc-400">
            {data.player.nickname ?? "?"} · AR {data.player.level ?? "?"} ·{" "}
            {data.meta.cached ? "dari cache" : "fresh"} · {data.meta.checkableCount}/
            {data.meta.totalCount} punya benchmark
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {data.characters.map((c) => (
              <button
                key={c.enkaAvatarId}
                onClick={() => c.supported && setSelectedId(c.enkaAvatarId)}
                disabled={!c.supported}
                className={`rounded-lg border px-3 py-2 text-left text-sm ${
                  selectedId === c.enkaAvatarId
                    ? "border-sky-500 bg-sky-500/10"
                    : "border-line bg-panel"
                } ${!c.supported ? "opacity-40" : ""}`}
              >
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-zinc-500">
                  {!c.supported
                    ? "nama tak dikenal"
                    : c.checkable
                      ? `Lv ${c.level ?? "?"} · ada benchmark`
                      : `Lv ${c.level ?? "?"} · belum ada benchmark`}
                </div>
              </button>
            ))}
          </div>

          {selected && (
            <div className="rounded-lg border border-line bg-panel p-4">
              <StatRow s={selected} />
              {selected.sets.length > 0 && (
                <div className="mt-2 text-xs text-zinc-400">
                  Set:{" "}
                  {selected.sets
                    .map((s) => `${s.count}pc ${s.name}`)
                    .join(" · ")}
                </div>
              )}

              {selected.checkable && dbChar ? (
                <>
                  <label className="mt-3 block text-sm text-zinc-400">Benchmark</label>
                  <select
                    value={
                      benchmarkId ?? dbChar.benchmarks.find((b) => b.isDefault)?.id ?? ""
                    }
                    onChange={(e) => setBenchmarkId(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2"
                  >
                    {dbChar.benchmarks.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label} ({b.role}) — {b.source}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={runCheck}
                    disabled={checking}
                    className="mt-3 w-full rounded-lg bg-emerald-600 py-2 font-medium disabled:opacity-40"
                  >
                    {checking ? "Mengecek…" : "Cek build"}
                  </button>
                </>
              ) : (
                <p className="mt-3 text-sm text-amber-400">
                  Benchmark buat {selected.name} belum ada. Stat-nya udah kebaca — pakai
                  tab Input Manual, atau tambahin benchmark-nya di{" "}
                  <code>backend/src/data/benchmarks.ts</code>.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatRow({ s }: { s: ShowcaseCharacter }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
      <Stat label="CRIT Rate" v={`${s.stats.critRate}%`} />
      <Stat label="CRIT DMG" v={`${s.stats.critDmg}%`} />
      <Stat label="ER" v={`${s.stats.energyRecharge}%`} />
      <Stat label="EM" v={String(s.stats.elementalMastery)} />
      <Stat label="CV substat" v={String(s.substatCritValue)} />
    </div>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="font-medium">{v}</div>
    </div>
  );
}
