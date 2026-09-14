import type { HitDef, HitKind, Scaling, ScalingStat, TalentSlot } from "../services/damage.types";

/**
 * Parse `attributes` talent genshin-db jadi daftar hit yang bisa dihitung.
 * Bentuk label: "<nama>|<rumus>", rumus berisi token `{paramN:FMT}`:
 *   "1-Hit DMG|{param1:F1P}"                                → 1 hit, ATK
 *   "5-Hit DMG|{param5:F1P}+{param6:F1P}"                   → 2 bagian dijumlah
 *   "Rush Attack DMG|{p1:F1P} ATK+{p2:F1P} Elemental Mastery" → ATK + EM
 *   "2-Mirror ... DMG|({p6:F1P} ATK+{p7:F1P} Elemental Mastery)×2" → hitCount 2
 *   "Low/High Plunge DMG|{p11:P}/{p12:P}"                   → 2 hit alternatif
 *   "Exquisite Throw DMG|{p2:F2P} Max HP ×3"                → HP, hitCount 3
 * FMT yang diakhiri "P" = persen dari stat (pecahan di parameters). Format lain (F1, I) = angka
 * mentah (durasi, cost) → bukan hit.
 */

export interface TalentAttributes {
  labels: string[];
  parameters: Record<string, number[]>;
}

export interface ParseWarning {
  label: string;
  reason: string;
}

const TOKEN_RE = /\{(param\d+):([A-Za-z0-9]+)\}/g;

/** label yang mengandung DMG tapi bukan hit */
const EXCLUDE_RE =
  /Stamina|Cost|Duration|\bCD\b|Cooldown|Energy|Absorption|Shield|Heal|Regen|Interval|Bonus|Increase|Per Stack|Gained|Restor|Ratio|Chance|Speed|Range|\bTime\b|Trigger|Reduction|Conversion|Limit|Max\b(?! HP)/i;

function isDamageLabel(name: string): boolean {
  if (EXCLUDE_RE.test(name)) return false;
  // "… DoT" (Odette Coda at Dawn's Tolling DoT) = damage per tick tanpa kata DMG
  return /DMG/i.test(name) || /\bDoT\b/.test(name) || /^Charged Attack/i.test(name) || /^Plunge/i.test(name);
}

function statFromTrailing(text: string): ScalingStat | null {
  const t = text.trim();
  // "each", "per Paw", "per Hit" = noise, tetap ATK
  if (t === "" || /^ATK$/i.test(t) || /^(each|per \w+)$/i.test(t)) return "atk";
  if (/Max HP/i.test(t)) return "hp";
  if (/^DEF$/i.test(t) || /\bDEF\b/i.test(t)) return "def";
  if (/Elemental Mastery|\bEM\b/i.test(t)) return "em";
  return null; // "Normal Attack DMG", "Current HP", dst — nggak didukung
}

/** "({a} ATK+{b} EM)×2" → { body: "{a} ATK+{b} EM", hitCount: 2 } */
function splitHitCount(formula: string): { body: string; hitCount: number } {
  const m = formula.match(/[×x*]\s*(\d+)\s*$/);
  if (!m) return { body: formula.trim(), hitCount: 1 };
  let body = formula.slice(0, m.index).trim();
  if (body.startsWith("(") && body.endsWith(")")) body = body.slice(1, -1);
  return { body, hitCount: Number(m[1]) };
}

/** Satu alternatif rumus → scalings. null kalau ada bagian yang nggak bisa diparse. */
function parseParts(
  body: string,
  params: Record<string, number[]>,
): { scalings: Scaling[]; reason?: string } {
  const scalings: Scaling[] = [];
  for (const part of body.split("+")) {
    TOKEN_RE.lastIndex = 0;
    const m = TOKEN_RE.exec(part);
    if (!m) return { scalings: [], reason: `bagian tanpa token: "${part}"` };
    const [, param, fmt] = m;
    if (!fmt.endsWith("P")) return { scalings: [], reason: `format ${fmt} bukan persen` };
    const values = params[param];
    if (!values?.length) return { scalings: [], reason: `${param} nggak ada di parameters` };
    const trailing = part.slice(m.index + m[0].length);
    const stat = statFromTrailing(trailing);
    if (!stat) return { scalings: [], reason: `scaling nggak dikenal: "${trailing.trim()}"` };
    scalings.push({ stat, values });
  }
  return { scalings };
}

/** "Low/High Plunge DMG" + 2 alternatif → ["Low Plunge DMG", "High Plunge DMG"] */
function alternativeLabels(name: string, n: number): string[] {
  const parts = name.split("/");
  if (parts.length === n) {
    const last = parts[parts.length - 1].trim();
    const rest = last.split(" ").slice(1).join(" ");
    return parts.map((p, i) => (i === parts.length - 1 ? last : `${p.trim()} ${rest}`.trim()));
  }
  return Array.from({ length: n }, (_, i) => `${name} (${i + 1})`);
}

function kindFor(slot: TalentSlot, name: string): HitKind {
  if (slot !== "normal") return slot;
  if (/Charged/i.test(name)) return "ca";
  if (/Plunge/i.test(name)) return "plunge";
  return "na";
}

/** Bagi rumus per alternatif "/" tapi jangan pecah "/" yang ada di dalam kurung. */
function splitAlternatives(formula: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of formula) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "/" && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseTalentHits(
  slot: TalentSlot,
  attrs: TalentAttributes,
): { hits: HitDef[]; warnings: ParseWarning[] } {
  const hits: HitDef[] = [];
  const warnings: ParseWarning[] = [];
  const counters: Record<HitKind, number> = { na: 0, ca: 0, plunge: 0, skill: 0, burst: 0 };

  for (const label of attrs.labels ?? []) {
    const bar = label.indexOf("|");
    if (bar < 0) continue;
    const name = label.slice(0, bar).trim();
    const formula = label.slice(bar + 1).trim();
    if (!isDamageLabel(name)) continue;

    const kind = kindFor(slot, name);
    const alts = splitAlternatives(formula);
    const altLabels = alts.length > 1 ? alternativeLabels(name, alts.length) : [name];
    const isLowHigh = /Low\/High Plunge/i.test(name) && alts.length === 2;

    // id dasar: "N-Hit" pakai N-nya, sisanya counter per kind
    const hitNo = name.match(/^(\d+)-Hit/);
    let baseId: string;
    if (kind === "na" && hitNo) {
      baseId = `na${hitNo[1]}`;
      counters.na = Math.max(counters.na, Number(hitNo[1]));
    } else {
      counters[kind]++;
      baseId = `${kind}${counters[kind]}`;
    }

    alts.forEach((alt, i) => {
      const { body, hitCount } = splitHitCount(alt);
      const { scalings, reason } = parseParts(body, attrs.parameters ?? {});
      if (reason) {
        warnings.push({ label, reason });
        return;
      }
      const lowHighId = `${slot === "normal" ? "" : `${kind}_`}plunge_${i === 0 ? "low" : "high"}`;
      const id = isLowHigh
        ? lowHighId
        : alts.length > 1
          ? `${baseId}${String.fromCharCode(97 + i)}`
          : baseId;
      const stellar = /Stellar-Conduct/i.test(altLabels[i]) ? "conduct" : /Stellar Swirl/i.test(altLabels[i]) ? "swirl" : undefined;
      const lunar = /Lunar-Charged/i.test(altLabels[i]) ? "charged" : undefined;
      hits.push({ id, label: altLabels[i], kind, slot, scalings, hitCount, ...(stellar ? { stellar } : {}), ...(lunar ? { lunar } : {}) });
    });
  }

  return { hits, warnings };
}

export interface TalentMeta {
  /** detik; undefined kalau labelnya nggak ada */
  duration?: number;
  cd?: number;
}

/**
 * Durasi & cooldown dari label non-hit: "Duration|{param5:F1}s", "CD|{param6:F1}s",
 * "CD|{p7:F1}/{p8:F1}/{p9:F1}s" (ambil alternatif pertama), atau teks polos "Duration|12s".
 * Cuma label yang PERSIS "Duration"/"CD"/"Cooldown" — "Shield Duration" dll sengaja nggak
 * (artinya beda-beda per kit, isi manual di modul kalau perlu).
 */
export function parseTalentMeta(attrs: TalentAttributes | undefined, level: number): TalentMeta {
  const out: TalentMeta = {};
  if (!attrs) return out;
  const valueOf = (formula: string): number | undefined => {
    const first = formula.split("/")[0];
    TOKEN_RE.lastIndex = 0;
    const m = TOKEN_RE.exec(first);
    if (m) {
      const values = attrs.parameters?.[m[1]];
      return values?.length ? multiplierAt(values, level) : undefined;
    }
    const n = Number.parseFloat(first.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  };
  for (const label of attrs.labels ?? []) {
    const bar = label.indexOf("|");
    if (bar < 0) continue;
    const name = label.slice(0, bar).trim();
    const formula = label.slice(bar + 1).trim();
    if (/^Duration$/i.test(name) && out.duration == null) out.duration = valueOf(formula);
    else if (/^(CD|Cooldown)$/i.test(name) && out.cd == null) out.cd = valueOf(formula);
  }
  return out;
}

/** Index level talent ke array multiplier (level 1-15, clamp ke panjang array). */
export function multiplierAt(values: number[], level: number): number {
  const idx = Math.min(Math.max(level, 1), values.length) - 1;
  return values[idx] ?? 0;
}
