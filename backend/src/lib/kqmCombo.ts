import type { HitDef } from "../services/damage.types";

/**
 * Parser notasi quickhand KQM → counts hit id.
 *   N3      = na1, na2, na3            C = ca1          hP / P / JP = plunge_high (+ plunge1)
 *   lP      = plunge_low (+ plunge1)   E / tE / hE / pE = semua hit skill ×1   Q = semua hit burst ×1
 *   D, J    = cancel (diabaikan)       k[...] = ulang k kali      "+", ">", "(", ")" = pemisah
 * Contoh: "2[N4C] N2C", "E 6[N3E]", "N1CJP", "Q + E + N3D N3D N3CD", "12[JhP] 2[JlP] 2[E]Q"
 */

export interface ComboParse {
  counts: Record<string, number>;
  /** token yang dikenal, urut */
  tokens: string[];
  /** token + pengulangan, urut (buat durasi): "3[N3 E]" → [{N3,3},{E,3}] */
  timeline: { token: string; n: number }[];
  unknown: string[];
  hasSkill: boolean;
  hasBurst: boolean;
  /** jumlah hit na/ca/plunge (buat heuristik "combo kecil butuh pengulangan") */
  attackHits: number;
}

const TOKEN_RE = /^(N\d+|hP|lP|JP|tE|hE|pE|[CEQPJD])/;

/** Pecah "N3CD" → ["N3","C","D"]; "12[JhP]" ditangani di parseKqmCombo. */
function splitAtomic(word: string): { tokens: string[]; unknown: string[] } {
  const tokens: string[] = [];
  const unknown: string[] = [];
  let s = word;
  while (s.length) {
    const m = s.match(TOKEN_RE);
    if (!m) {
      unknown.push(s);
      break;
    }
    tokens.push(m[1]);
    s = s.slice(m[1].length);
  }
  return { tokens, unknown };
}

/** Bentuk notasi yang valid buat 1 "kata" (dipakai buat nyari baris combo di teks guide). */
export const COMBO_WORD_RE = /^\(?(?:\d+\[[A-Za-z\d]+\]|[thp]?[NCEQPJD][A-Za-z\d]*)\)?[,]?$/;

export function looksLikeCombo(text: string): boolean {
  const words = text.trim().split(/\s+/).filter((w) => w !== "+" && w !== ">");
  return words.length > 0 && words.every((w) => COMBO_WORD_RE.test(w)) && /[NEQP]/.test(text);
}

/**
 * Arti satu aksi buat karakter tertentu (dari modul `actions`), mis. Yae `{ "E": { "skill3": 5 } }`
 * = tiap cast E menghasilkan 5 tembakan turret lv3. Kalau nggak ada, default: E/Q = semua hit
 * skill/burst 1×, C = ca1, N# = na1..na#.
 */
export type ActionMap = Record<string, Record<string, number>>;

/**
 * Batas aksi berurutan (resource kit), mis. Sandrone: Fagio mentok 100 Decoding Power setelah ~2 CA →
 * CA ke-3 berturut-turut cuma Power Overdrive (beam lemah) sampai di-reset E.
 *   { "C": { "max": 2, "resetBy": ["E"], "overflow": { "ca1": 1, "na4": 2 } } }
 * Grup `k[C E]` dihitung per iterasi, jadi "3[C E]" = C E C E C E (nggak pernah kena limit),
 * sedangkan "E 3[C]" = C C C → C ke-3 pakai `overflow`.
 */
export type ActionLimits = Record<string, { max: number; resetBy?: string[]; overflow?: Record<string, number> }>;

export function parseKqmCombo(notation: string, hits: HitDef[], actions: ActionMap = {}, limits: ActionLimits = {}): ComboParse {
  const counts: Record<string, number> = {};
  const tokens: string[] = [];
  const timeline: { token: string; n: number }[] = [];
  const unknown: string[] = [];
  // "react:<reaksi>" = proc reaksi (transformative / Lunar-Charged) — bukan hit talent, selalu boleh
  const has = (id: string) => id.startsWith("react:") || hits.some((h) => h.id === id);
  const add = (id: string, n: number) => {
    if (has(id)) counts[id] = (counts[id] ?? 0) + n;
  };
  const kindIds = (kind: string) => hits.filter((h) => h.kind === kind).map((h) => h.id);
  let hasSkill = false;
  let hasBurst = false;
  let attackHits = 0;
  const consecutive: Record<string, number> = {};

  const applyAction = (name: string, mult: number): boolean => {
    const map = actions[name];
    if (!map) return false;
    for (const [id, n] of Object.entries(map)) add(id, n * mult);
    return true;
  };

  /** satu eksekusi token (mult = 1 per iterasi grup) → counts; limit berurutan dicek di sini */
  const applyOnce = (tok: string) => {
    const base = tok.replace(/^[thp](?=[EP]$)/, "");
    for (const [name, lim] of Object.entries(limits))
      if ((lim.resetBy ?? []).some((r) => r === tok || r === base)) consecutive[name] = 0;
    const lim = limits[tok] ?? limits[base];
    if (lim) {
      const key = limits[tok] ? tok : base;
      consecutive[key] = (consecutive[key] ?? 0) + 1;
      if (consecutive[key] > lim.max) {
        for (const [id, n] of Object.entries(lim.overflow ?? {})) add(id, n);
        return;
      }
    }
    applyCounts(tok, 1);
  };

  const apply = (tok: string, mult: number) => {
    tokens.push(mult > 1 ? `${mult}×${tok}` : tok);
    timeline.push({ token: tok, n: mult });
    for (let i = 0; i < mult; i++) applyOnce(tok);
  };

  const applyCounts = (tok: string, mult: number) => {
    const n = tok.match(/^N(\d+)$/);
    if (n) {
      if (applyAction(tok, mult)) return;
      for (let i = 1; i <= Number(n[1]); i++) add(`na${i}`, mult);
      attackHits += Number(n[1]) * mult;
      return;
    }
    if (tok === "E" || tok === "tE" || tok === "hE" || tok === "pE") hasSkill = true;
    if (tok === "Q") hasBurst = true;
    if (applyAction(tok, mult) || (tok !== "E" && applyAction(tok.replace(/^[thp]/, ""), mult))) return;
    switch (tok) {
      case "C":
        add("ca1", mult);
        attackHits += mult;
        return;
      case "hP":
      case "P":
      case "JP":
        add("plunge_high", mult);
        add("plunge1", mult);
        attackHits += mult;
        return;
      case "lP":
        add("plunge_low", mult);
        add("plunge1", mult);
        attackHits += mult;
        return;
      case "E":
      case "tE":
      case "hE":
      case "pE":
        for (const id of kindIds("skill")) add(id, mult);
        return;
      case "Q":
        for (const id of kindIds("burst")) add(id, mult);
        return;
      default:
        return; // D, J
    }
  };

  const cleaned = notation.replace(/[+>(),]/g, " ").trim();
  // k[...] grup (1 level)
  const re = /(\d+)\s*\[([^\]]+)\]|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    if (m[1] != null) {
      const k = Number(m[1]);
      const group: string[] = [];
      for (const w of m[2].trim().split(/\s+/)) {
        const r = splitAtomic(w);
        unknown.push(...r.unknown);
        group.push(...r.tokens);
      }
      for (const t of group) {
        tokens.push(k > 1 ? `${k}×${t}` : t);
        timeline.push({ token: t, n: k });
      }
      // urutan eksekusi asli: (C E)(C E)(C E) — penting buat limit aksi berurutan
      for (let i = 0; i < k; i++) for (const t of group) applyOnce(t);
    } else {
      const r = splitAtomic(m[3]);
      unknown.push(...r.unknown);
      for (const t of r.tokens) apply(t, 1);
    }
  }
  return { counts, tokens, timeline, unknown, hasSkill, hasBurst, attackHits };
}

/** token notasi → detik. Dari `_durations.json` (per tipe senjata) + override `durations` modul. */
export type DurationTable = Record<string, number>;

export interface ComboDuration {
  total: number;
  rows: { token: string; n: number; each: number; subtotal: number }[];
  /** token yang nggak ada di tabel (dihitung 0) */
  unknown: string[];
}

/**
 * Durasi rotasi dari timeline notasi. Lookup: token persis ("hP", "N3") → tanpa prefix t/h/p ("tE"→"E") →
 * "N#" = N1 + (#-1) × (N2 − N1) kalau cuma sebagian N# ada di tabel.
 */
export function comboDuration(timeline: { token: string; n: number }[], table: DurationTable): ComboDuration {
  const rows: ComboDuration["rows"] = [];
  const unknown: string[] = [];
  let total = 0;
  const lookup = (tok: string): number | undefined => {
    if (table[tok] != null) return table[tok];
    const stripped = tok.replace(/^[thp](?=[EP]$)/, "");
    if (stripped !== tok && table[stripped] != null) return table[stripped];
    const n = tok.match(/^N(\d+)$/);
    if (n && table.N1 != null) {
      const step = table.N2 != null ? table.N2 - table.N1 : table.N1;
      return table.N1 + (Number(n[1]) - 1) * step;
    }
    return undefined;
  };
  for (const { token, n } of timeline) {
    const each = lookup(token);
    if (each == null) {
      if (!unknown.includes(token)) unknown.push(token);
      continue;
    }
    const subtotal = each * n;
    total += subtotal;
    rows.push({ token, n, each, subtotal });
  }
  return { total: Math.round(total * 100) / 100, rows, unknown };
}

export interface KqmComboPick {
  notation: string;
  repeat: number;
  section: string;
  counts: Record<string, number>;
  note: string;
}

/**
 * Cari notasi combo di section guide KQM (key mengandung "combo"/"rotation"), pilih yang paling
 * lengkap (ada E/Q + serangan). Kalau combo cuma string serangan pendek, coba cari angka
 * pengulangan di prosa ("9 N1C", "N1C x8", "reach 9 N1C combos").
 */
export function pickKqmCombo(raw: Record<string, string>, hits: HitDef[], actions: ActionMap = {}, limits: ActionLimits = {}): KqmComboPick | null {
  const sections = Object.entries(raw).filter(([k]) => /combo|rotation/i.test(k));
  if (!sections.length) return null;

  interface Cand {
    p: ComboParse;
    notation: string;
    section: string;
    repeat: number;
    repeatNote: string;
    score: number;
    single: boolean;
  }
  const cands: Cand[] = [];
  for (const [key, text] of sections) {
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      // ambil prefix kata yang berbentuk notasi
      const words = line.split(/\s+/);
      const prefix: string[] = [];
      for (const w of words) {
        if (w === "+" || w === ">") continue;
        if (!COMBO_WORD_RE.test(w)) break;
        prefix.push(w.replace(/,$/, ""));
      }
      if (!prefix.length) continue;
      const notation = prefix.join(" ");
      if (!/[NEQP]/.test(notation)) continue;
      const p = parseKqmCombo(notation, hits, actions, limits);
      if (p.unknown.length || !Object.keys(p.counts).length) continue;

      // pengulangan dari prosa, cuma kalau combo-nya string serangan tanpa E/Q
      let repeat = 1;
      let repeatNote = "";
      if (!p.hasSkill && !p.hasBurst) {
        const esc = notation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m =
          text.match(new RegExp(`(\\d+)\\s*(?:x|×)?\\s*${esc}\\b`)) ??
          text.match(new RegExp(`${esc}\\s*(?:x|×)\\s*(\\d+)`)) ??
          text.match(new RegExp(`(?:reach|up to|around)\\s+(\\d+)\\s+${esc}`, "i"));
        if (m) {
          repeat = Math.min(20, Math.max(1, Number(m[1])));
          repeatNote = `, diulang ${repeat}× (dari prosa)`;
        } else repeatNote = ", pengulangan nggak ketemu di teks → 1× (set --rotation / modul)";
      }
      const total = Object.values(p.counts).reduce((a, b) => a + b, 0) * repeat;
      const score = total + (p.hasSkill ? 2 : 0) + (p.hasBurst ? 2 : 0) + p.tokens.length;
      cands.push({ p, notation, section: key, repeat, repeatNote, score, single: p.tokens.length <= 1 });
    }
  }
  if (!cands.length) return null;
  // judul sub-section kayak "Q" / "E" cuma dipakai kalau nggak ada kandidat yang lebih lengkap
  const pool = cands.some((c) => !c.single) ? cands.filter((c) => !c.single) : cands;
  const best = pool.reduce((a, b) => (b.score > a.score ? b : a));

  const counts: Record<string, number> = {};
  for (const [id, n] of Object.entries(best.p.counts)) counts[id] = n * best.repeat;
  return {
    notation: best.notation,
    repeat: best.repeat,
    section: best.section,
    counts,
    note: `notasi KQM "${best.notation}" (section ${best.section})${best.repeatNote}`,
  };
}
