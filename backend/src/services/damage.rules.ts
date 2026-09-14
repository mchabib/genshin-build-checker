import type { StoredGuide } from "./guideStore";
import type { CharacterModule } from "./buffStore";
import type { HitDef, HitKind, ReactionKey } from "./damage.types";
import type { DamageCharacter } from "./damage.service";
import { parseKqmCombo, pickKqmCombo } from "../lib/kqmCombo";

/**
 * Lapisan keputusan TANPA LLM. Mengisi slot yang di jalur LLM diisi model:
 *   tim (dari modul karakter / guide KQM), reaksi (dari elemen tim), rotasi (preset modul).
 * Semua deterministik dan bisa dijelaskan (`reason`).
 */

const KINDS: HitKind[] = ["na", "ca", "plunge", "skill", "burst"];

// ---------- tim ----------
/** Parse baris "Hu Tao — Xingqiu — Yelan — Zhongli" dari section KQM (exampleTeams/teams). */
export function parseKqmTeams(
  guide: StoredGuide | null,
  resolveKey: (name: string) => string | null,
  selfKey: string,
): string[][] {
  if (!guide) return [];
  const text = [guide.raw.exampleTeams, guide.raw.teams, guide.raw.teambuilding, guide.raw.notableTeammates]
    .filter(Boolean)
    .join("\n");
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.includes("—") && !line.includes(" – ")) continue;
    const parts = line.split(/\s*[—–]\s*/).map((p) => p.replace(/\(.*?\)/g, "").trim());
    if (parts.length < 3 || parts.length > 5 || parts.some((p) => p.length > 24 || !p)) continue;
    const keys: string[] = [];
    let unresolved = 0;
    for (const p of parts) {
      const k = resolveKey(p);
      if (!k) {
        unresolved++;
        continue;
      }
      if (k !== selfKey && !keys.includes(k)) keys.push(k);
    }
    // wajib mengandung karakter sendiri (atau semua ke-resolve) dan ≥2 teammate
    if (unresolved > 1 || keys.length < 2) continue;
    const sig = keys.join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(keys.slice(0, 3));
  }
  return out;
}

export interface TeamPick {
  keys: string[];
  source: "module" | "kqm" | "none";
  reason: string;
}

/** Pilih tim: preset modul dulu, lalu KQM; skor = jumlah member yang ada di roster showcase. */
export function pickTeam(
  module: CharacterModule | null,
  guide: StoredGuide | null,
  resolveKey: (name: string) => string | null,
  selfKey: string,
  rosterKeys: string[],
): TeamPick {
  const candidates: { keys: string[]; source: "module" | "kqm" }[] = [];
  for (const t of module?.teams ?? []) {
    const keys = t.map(resolveKey).filter((k): k is string => !!k && k !== selfKey);
    if (keys.length >= 2) candidates.push({ keys: keys.slice(0, 3), source: "module" });
  }
  for (const keys of parseKqmTeams(guide, resolveKey, selfKey)) candidates.push({ keys, source: "kqm" });
  if (!candidates.length) return { keys: [], source: "none", reason: "nggak ada preset tim di modul/KQM — hitung solo (pakai --team)" };

  const roster = new Set(rosterKeys);
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const score = c.keys.filter((k) => roster.has(k)).length + (c.source === "module" ? 0.5 : 0);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  const inRoster = best.keys.filter((k) => roster.has(k)).length;
  return {
    keys: best.keys,
    source: best.source,
    reason: `${best.source === "module" ? "preset modul" : "guide KQM"}, ${inRoster}/${best.keys.length} ada di showcase`,
  };
}

// ---------- reaksi ----------
export interface ReactionPick {
  reactions: Partial<Record<HitKind, ReactionKey | null>>;
  reason: string;
}

/**
 * Reaksi per jenis hit dari elemen karakter + elemen tim. Override dari modul (`reactions.with`)
 * menang; kalau nggak ada, rule generik (amplifying/additive yang wajar).
 */
export function inferReactions(
  module: CharacterModule | null,
  char: DamageCharacter,
  teamElements: string[],
): ReactionPick {
  const has = (e: string) => teamElements.includes(e);
  const mapping = module?.reactions?.with;
  if (mapping) {
    for (const [el, r] of Object.entries(mapping)) {
      if (has(el)) return { reactions: r, reason: `modul: ada ${el} di tim` };
    }
  }
  const out: Partial<Record<HitKind, ReactionKey | null>> = {};
  const set = (r: ReactionKey, kinds: HitKind[], reason: string): ReactionPick => {
    for (const k of kinds) {
      // NA/CA/plunge cuma kalau elemennya bukan physical
      if ((k === "na" || k === "ca" || k === "plunge") && char.naElements[k] === "physical") continue;
      out[k] = r;
    }
    return { reactions: out, reason };
  };
  const el = char.element;
  // NA sengaja nggak dikasih amplifying (ICD bikin nggak tiap hit vape); ca/skill/burst iya
  if (el === "pyro" && has("hydro")) return set("vaporize", ["ca", "skill", "burst"], "pyro + hydro di tim → vaporize");
  if (el === "pyro" && has("cryo")) return set("melt", ["ca", "skill", "burst"], "pyro + cryo di tim → melt");
  if (el === "hydro" && has("pyro")) return set("vaporize", ["ca", "skill", "burst"], "hydro + pyro di tim → vaporize");
  if (el === "cryo" && has("pyro")) return set("melt", ["skill", "burst"], "cryo + pyro di tim → melt (E/Q)");
  if (el === "electro" && has("dendro")) return set("aggravate", KINDS, "electro + dendro di tim → aggravate");
  if (el === "dendro" && has("electro")) return set("spread", KINDS, "dendro + electro di tim → spread");
  return { reactions: {}, reason: `nggak ada pasangan reaksi amplifying/additive buat ${el} di tim ini` };
}

// ---------- rotasi ----------
export interface RotationPick {
  label: string;
  counts: Record<string, number>;
  note?: string;
  source: "module" | "kqm" | "generic";
  /** notasi yang dipakai (buat hitung durasi) + pengulangan */
  kqm?: string;
  repeat?: number;
  /** durasi eksplisit dari preset modul (detik) */
  duration?: number;
}

/** Urutan: preset modul (counts / notasi kqm) → notasi combo dari guide KQM → generik 1× tiap hit. */
export function pickRotation(module: CharacterModule | null, hits: HitDef[], guide: StoredGuide | null): RotationPick {
  const preset = module?.rotations?.[0];
  if (preset) {
    if (preset.counts && Object.keys(preset.counts).length)
      return { label: preset.label, counts: preset.counts, note: preset.note, source: "module", duration: preset.duration };
    if (preset.kqm) {
      const p = parseKqmCombo(preset.kqm, hits, module?.actions ?? {}, module?.limits ?? {});
      const note = [preset.note, p.unknown.length ? `token nggak dikenal: ${p.unknown.join(", ")}` : null].filter(Boolean).join("; ");
      if (Object.keys(p.counts).length)
        return { label: `${preset.label} (${preset.kqm})`, counts: p.counts, note: note || undefined, source: "module", kqm: preset.kqm, duration: preset.duration };
    }
  }
  if (guide) {
    const k = pickKqmCombo(guide.raw, hits, module?.actions ?? {}, module?.limits ?? {});
    if (k) return { label: `KQM: ${k.notation}${k.repeat > 1 ? ` ×${k.repeat}` : ""}`, counts: k.counts, note: k.note, source: "kqm", kqm: k.notation, repeat: k.repeat };
  }
  const counts: Record<string, number> = {};
  for (const h of hits) if (h.id !== "plunge1" && h.id !== "plunge_low") counts[h.id] = 1;
  return { label: "generic: 1× tiap hit", counts, note: "belum ada preset rotasi di modul / notasi combo di guide KQM", source: "generic" };
}

/** Elemen unik tim (lowercase), termasuk karakter sendiri. */
export function teamElements(selfElement: string, memberElements: (string | null)[]): string[] {
  const out = new Set<string>([selfElement.toLowerCase()]);
  for (const e of memberElements) if (e) out.add(e.toLowerCase());
  return [...out];
}
