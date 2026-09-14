import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiRequestError } from "../api";
import type { Character, CheckResponse } from "../types";

interface Form {
  critRate: string;
  critDmg: string;
  energyRecharge: string;
  elementalMastery: string;
  atkPercent: string;
  hpPercent: string;
  subCritRate: string;
  subCritDmg: string;
}

const EMPTY: Form = {
  critRate: "5",
  critDmg: "50",
  energyRecharge: "100",
  elementalMastery: "0",
  atkPercent: "",
  hpPercent: "",
  subCritRate: "",
  subCritDmg: "",
};

export function ManualPanel({
  characters,
  onResult,
}: {
  characters: Character[];
  onResult: (r: CheckResponse) => void;
}) {
  const [characterKey, setCharacterKey] = useState("");
  const [benchmarkId, setBenchmarkId] = useState<number | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withBenchmark = useMemo(
    () => characters.filter((c) => c.benchmarks.length > 0),
    [characters],
  );
  const character = useMemo(
    () => withBenchmark.find((c) => c.key === characterKey),
    [withBenchmark, characterKey],
  );

  useEffect(() => {
    if (character) {
      setBenchmarkId(character.benchmarks.find((b) => b.isDefault)?.id ?? character.benchmarks[0]?.id ?? null);
    }
  }, [character]);

  function set<K extends keyof Form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!character) return;
    setBusy(true);
    setError(null);
    try {
      const subCr = num(form.subCritRate);
      const subCd = num(form.subCritDmg);
      const res = await api.check({
        source: "manual",
        characterKey: character.key,
        benchmarkId: benchmarkId ?? undefined,
        stats: {
          critRate: Number(form.critRate) || 0,
          critDmg: Number(form.critDmg) || 0,
          energyRecharge: Number(form.energyRecharge) || 100,
          elementalMastery: Number(form.elementalMastery) || 0,
          atkPercent: num(form.atkPercent),
          hpPercent: num(form.hpPercent),
        },
        substatCritValue:
          subCr != null || subCd != null ? (subCr ?? 0) * 2 + (subCd ?? 0) : undefined,
      });
      onResult(res);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Gagal cek build.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-sm text-zinc-400">Karakter</label>
        <select
          value={characterKey}
          onChange={(e) => setCharacterKey(e.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2"
        >
          <option value="">— pilih —</option>
          {withBenchmark.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {character && (
        <div>
          <label className="block text-sm text-zinc-400">Benchmark</label>
          <select
            value={benchmarkId ?? ""}
            onChange={(e) => setBenchmarkId(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2"
          >
            {character.benchmarks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} ({b.role}) — {b.source}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="CRIT Rate total %" v={form.critRate} onChange={(v) => set("critRate", v)} />
        <Field label="CRIT DMG total %" v={form.critDmg} onChange={(v) => set("critDmg", v)} />
        <Field label="Energy Recharge %" v={form.energyRecharge} onChange={(v) => set("energyRecharge", v)} />
        <Field label="Elemental Mastery" v={form.elementalMastery} onChange={(v) => set("elementalMastery", v)} />
        <Field label="ATK% total (opsional)" v={form.atkPercent} onChange={(v) => set("atkPercent", v)} />
        <Field label="HP% total (opsional)" v={form.hpPercent} onChange={(v) => set("hpPercent", v)} />
        <Field label="Substat CR % (opsional)" v={form.subCritRate} onChange={(v) => set("subCritRate", v)} />
        <Field label="Substat CD % (opsional)" v={form.subCritDmg} onChange={(v) => set("subCritDmg", v)} />
      </div>

      <p className="text-xs text-zinc-500">
        Isi angka <b>total</b> (sudah termasuk base: CR 5, CD 50, ER 100). Substat CR/CD
        dipakai buat hitung CRIT Value kualitas artifact.
      </p>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || !character}
        className="w-full rounded-lg bg-emerald-600 py-2 font-medium disabled:opacity-40"
      >
        {busy ? "Mengecek…" : "Cek build"}
      </button>
    </form>
  );
}

function Field({
  label,
  v,
  onChange,
}: {
  label: string;
  v: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="text-xs text-zinc-500">{label}</span>
      <input
        value={v}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2 outline-none focus:border-zinc-500"
      />
    </label>
  );
}
