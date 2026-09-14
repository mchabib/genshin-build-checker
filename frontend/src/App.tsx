import { useEffect, useState } from "react";
import { api } from "./api";
import type { Character, CheckResponse } from "./types";
import { UidPanel } from "./components/UidPanel";
import { ManualPanel } from "./components/ManualPanel";
import { ResultCard } from "./components/ResultCard";

type Tab = "uid" | "manual";

export default function App() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("uid");
  const [result, setResult] = useState<CheckResponse | null>(null);

  useEffect(() => {
    api
      .listCharacters()
      .then(setCharacters)
      .catch(() => setLoadErr("Gagal load daftar karakter — backend nyala?"));
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Genshin Build Checker</h1>
        <p className="text-sm text-zinc-400">
          Fase 1 — cek substat artifact vs benchmark komunitas.
        </p>
      </header>

      {loadErr && (
        <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {loadErr}
        </div>
      )}

      <div className="mb-4 flex gap-2">
        {(["uid", "manual"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              tab === t ? "bg-zinc-700" : "bg-panel text-zinc-400"
            }`}
          >
            {t === "uid" ? "Via UID (Enka)" : "Input Manual"}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-line bg-panel/50 p-5">
        {tab === "uid" ? (
          <UidPanel characters={characters} onResult={setResult} />
        ) : (
          <ManualPanel characters={characters} onResult={setResult} />
        )}
      </div>

      {result && (
        <div className="mt-6">
          <ResultCard data={result} />
        </div>
      )}

      <footer className="mt-10 text-xs text-zinc-600">
        Data karakter via Enka.Network. Benchmark placeholder — bukan patokan resmi.
      </footer>
    </div>
  );
}
