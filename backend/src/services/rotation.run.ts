import { loadCharacterStore } from "./characterStore";
import { loadGuideStore } from "./guideStore";
import { loadGameDataStore } from "./gameDataStore";
import { loadBuffStore } from "./buffStore";
import { fetchEnkaProfile, isValidUid } from "./enka.service";
import { EnkaError } from "./enka.types";
import { mapShowcase, type ShowcaseCharacter } from "./enka.mapper";
import { findInShowcase, notationTiming, runDamage, type DamageOptions, type DamageReport } from "./damage.run";
import { COMBO_WORD_RE, parseKqmCombo } from "../lib/kqmCombo";

/**
 * Rotasi TIM dari notasi KQM yang ditulis user:
 *   "Yae 3[E] > Odette 2[E] > Qiqi E Q > Sandrone 3[C E] Q"
 * Tiap segmen = <nama karakter> <aksi...>. Tiap karakter dihitung pakai modulnya sendiri dengan
 * tim = karakter lain di urutan; buff support yang butuh E/Q cuma aktif kalau aksinya muncul.
 * Durasi tim = jumlah durasi segmen (tabel `_durations.json` + `durations` modul) → DPS tim, dan
 * jadi jendela uptime buff tim (Bennett Q 12s / rotasi 21s), bukan durasi segmen masing-masing.
 */

export interface RotationSegment {
  raw: string;
  name: string;
  key: string | null;
  notation: string;
}

export interface TeamRotationCharacter {
  key: string;
  name: string;
  notation: string;
  actions: ("skill" | "burst")[];
  report: Omit<DamageReport, "context">;
  subtotal: number;
  /** detik, null kalau ada token yang nggak ada di tabel durasi */
  duration: number | null;
}

export interface TeamRotationResult {
  uid: string;
  notation: string;
  segments: RotationSegment[];
  characters: TeamRotationCharacter[];
  total: number;
  /** jumlah durasi semua segmen (detik); null kalau ada segmen yang nggak bisa dihitung */
  duration: number | null;
  dps: number | null;
  /** reaksi Lunar-Charged level tim (tick tiap ~2s selama rotasi), sudah masuk `total` */
  lunar: { perTick: number; ticks: number; total: number; contributors: { name: string; dmg: number; weight: number }[] } | null;
  warnings: string[];
}

/** Lunar-Charged tick ~2s (thundercloud 6s, di-refresh terus selama aura Hydro+Electro) — guide KQM Lunar */
export const LUNAR_TICK_SECONDS = 2;

export class RotationError extends Error {
  constructor(
    public code: "bad_notation" | "no_characters",
    message: string,
  ) {
    super(message);
    this.name = "RotationError";
  }
}

/** Pecah kata tapi grup "3[C E]" tetap satu token. */
export function tokenizeWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "[") depth++;
    if (ch === "]") depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const isComboWord = (w: string) => w === "+" || COMBO_WORD_RE.test(w.replace(/\s+/g, ""));

/** Pecah "A x y > B z" → segmen; nama = kata-kata awal yang bukan notasi. */
export function splitSegments(notation: string): { name: string; notation: string; raw: string }[] {
  return notation
    .split(/\s*>\s*|\s*\|\s*|\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const words = tokenizeWords(raw);
      const nameWords: string[] = [];
      let i = 0;
      // kata pertama selalu nama; lanjut selama belum ketemu kata notasi (max 3 kata)
      for (; i < words.length; i++) {
        if (i > 0 && isComboWord(words[i])) break;
        if (i >= 3) break;
        nameWords.push(words[i]);
      }
      return { raw, name: nameWords.join(" "), notation: words.slice(i).join(" ") };
    });
}

function actionsOf(notation: string): ("skill" | "burst")[] {
  const toks = parseKqmCombo(notation, []).tokens.map((t) => t.replace(/^\d+×/, ""));
  const out = new Set<"skill" | "burst">();
  for (const t of toks) {
    if (/^[thp]?E$/.test(t) || /E/.test(t)) out.add("skill");
    if (t === "Q") out.add("burst");
  }
  return [...out];
}

export async function runTeamRotation(
  rawUid: string,
  notation: string,
  opts: Pick<DamageOptions, "enemyLevel" | "enemyResPct" | "noAssume" | "catalogIds" | "reaction" | "stellarHits" | "duration"> = {},
): Promise<TeamRotationResult> {
  const uid = rawUid.trim();
  if (!isValidUid(uid)) throw new EnkaError("INVALID_UID", `UID tidak valid: "${uid}"`, 400);
  await Promise.all([loadCharacterStore(), loadGuideStore(), loadGameDataStore(), loadBuffStore()]);
  const profile = await fetchEnkaProfile(uid);
  const showcase = mapShowcase(profile.data);

  const warnings: string[] = [];
  const parts = splitSegments(notation);
  if (!parts.length) throw new RotationError("bad_notation", "notasi rotasi kosong");

  const segments: RotationSegment[] = [];
  for (const p of parts) {
    let sc: ShowcaseCharacter | null = null;
    // coba nama 1..3 kata (mis. "Yae Miko"), sisanya jadi notasi
    const words = tokenizeWords(p.raw);
    let used = 0;
    for (let n = Math.min(3, words.length); n >= 1; n--) {
      const cand = findInShowcase(showcase, words.slice(0, n).join(" "));
      if (cand?.key) {
        sc = cand;
        used = n;
        break;
      }
    }
    const seg: RotationSegment = {
      raw: p.raw,
      name: sc?.name ?? p.name,
      key: sc?.key ?? null,
      notation: sc ? words.slice(used).join(" ") : p.notation,
    };
    if (!sc) warnings.push(`segmen "${p.raw}": karakter nggak ketemu di showcase — di-skip`);
    else if (!seg.notation) warnings.push(`segmen "${p.raw}": nggak ada aksi`);
    segments.push(seg);
  }

  // gabung notasi per karakter (bisa muncul >1 kali) + aksi yang dipakai
  const byKey = new Map<string, { name: string; notations: string[] }>();
  for (const s of segments) {
    if (!s.key || !s.notation) continue;
    const cur = byKey.get(s.key) ?? { name: s.name, notations: [] };
    cur.notations.push(s.notation);
    byKey.set(s.key, cur);
  }
  if (!byKey.size) throw new RotationError("no_characters", "nggak ada karakter yang bisa dihitung dari notasi ini");

  const keys = [...byKey.keys()];
  const teamActions: Record<string, ("skill" | "burst")[]> = {};
  for (const [k, v] of byKey) teamActions[k] = actionsOf(v.notations.join(" "));

  // pass 1: durasi tiap karakter → durasi tim (jendela uptime buff tim)
  const durations = new Map<string, number | null>();
  let duration: number | null = 0;
  for (const [k, v] of byKey) {
    const sc = showcase.find((c) => c.key === k)!;
    const t = notationTiming(sc, v.notations.join(" "));
    const d = t?.duration ?? null;
    durations.set(k, d);
    if (t?.unknown.length) warnings.push(`${v.name}: durasi token nggak dikenal: ${t.unknown.join(", ")}`);
    if (d == null) duration = null;
    else if (duration != null) duration = Math.round((duration + d) * 100) / 100;
  }
  // --duration: durasi rotasi tim dipaksa (komposisi summon/off-field: cast cuma 5s tapi rotasinya 20s)
  if (opts.duration && opts.duration > 0) {
    if (duration != null && opts.duration < duration) warnings.push(`--duration ${opts.duration}s lebih pendek dari jumlah durasi aksi (${duration}s)`);
    duration = opts.duration;
  }

  // pass 2: damage tiap karakter, buff tim pakai jendela durasi tim
  const characters: TeamRotationCharacter[] = [];
  let total = 0;
  for (const [k, v] of byKey) {
    const others = keys.filter((x) => x !== k).slice(0, 3);
    const joined = v.notations.join(" ");
    const { duration: _d, ...perChar } = opts;
    const report = await runDamage(uid, k, {
      ...perChar,
      team: others,
      rotation: { label: "rotasi tim", kqm: joined },
      teamActions,
      buffWindow: duration ?? undefined,
      llm: false,
    });
    const { context: _ctx, ...pub } = report;
    const subtotal = report.rotation?.total ?? 0;
    total += subtotal;
    characters.push({ key: k, name: v.name, notation: joined, actions: teamActions[k], report: pub, subtotal, duration: durations.get(k) ?? null });
    for (const w of report.warnings) if (!/belum punya modul|durasi: token/.test(w)) warnings.push(`${v.name}: ${w}`);
  }

  // Lunar-Charged: 1 proc tiap aplikasi Hydro/Electro ke aura lawan (in-game 33 proc/20s: Birgitta 10, Ripple 9, salon
  // Furina 12, Yelan 2) — jumlahnya dari `actions` modul tiap karakter ("react:lunarCharged"), dikreditkan ke pemicu
  // seperti DPS meter. Fallback kalau nggak ada modul yang nyebut: durasi / 2s (tick thundercloud).
  let lunar: TeamRotationResult["lunar"] = null;
  const lcRow = characters.map((c) => c.report.buffed.transformative.find((t) => t.reaction === "lunarCharged")).find(Boolean);
  if (lcRow) {
    const fromActions = characters.reduce((a, c) => a + (c.report.rotation?.counts["react:lunarCharged"] ?? 0), 0);
    let ticks = fromActions;
    let lcTotal = 0;
    if (!fromActions) {
      ticks = duration ? Math.max(1, Math.round(duration / LUNAR_TICK_SECONDS)) : 0;
      if (!duration) warnings.push("Lunar-Charged: durasi rotasi nggak diketahui → proc reaksi nggak dihitung");
      lcTotal = Math.round(lcRow.dmg * ticks);
      total += lcTotal;
      warnings.push(`Lunar-Charged: jumlah proc diperkirakan dari durasi (${ticks}) — isi "react:lunarCharged" di actions modul biar per pemicu`);
    } else lcTotal = Math.round(lcRow.dmg * ticks); // sudah masuk subtotal PEMICU-nya (sesuai atribusi DPS meter in-game, dicek 2 run)
    lunar = { perTick: Math.round(lcRow.dmg), ticks, total: lcTotal, contributors: (lcRow.contributors ?? []).map((c) => ({ name: c.name, dmg: Math.round(c.dmg), weight: c.weight })) };
  }

  return { uid, notation, segments, characters, total, duration, dps: duration ? Math.round(total / duration) : null, lunar, warnings };
}
