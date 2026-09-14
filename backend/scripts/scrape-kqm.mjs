/**
 * Scrape KQM quick guides -> backend/scrape-data/Character/<slug>.json  (1 file per karakter)
 *                          + backend/scrape-data/_index.json
 *
 *   node scripts/scrape-kqm.mjs [--limit N] [slug ...]
 *
 * File JSON ini yang jadi "database" statis — nggak ada Postgres.
 * `raw`   = teks tiap section KQM apa adanya (buat AI layer & fallback).
 * `parsed` = hasil parse terstruktur best-effort (buat scorer deterministik).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UA = "Mozilla/5.0 (compatible; GenshinBuildChecker/0.1; personal project)";
const HOME = "https://keqingmains.com/";
const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../scrape-data",
);
const OUT_DIR = path.join(DATA_DIR, "Character");

// section yang diambil: key -> regex judul heading
const SECTION_MATCHERS = {
  overview: /^Character Overview$|^Playstyles?$|^Overview$/i,
  talents: /Talent Priority|Level and Talent|^Talents?$/i,
  constellations: /^Constellations?$/i,
  erRequirements: /^ER Requirements?$|Energy Recharge Requirement/i,
  artifactStats: /^Artifact Stats$|^Main Stats/i,
  artifactSets: /^Artifact Sets?$/i,
  weapons: /^Weapons?$/i,
  teams: /^Teams?$/i,
};

const NAME_ALIAS = {
  Raiden: "Raiden Shogun",
  Kazuha: "Kaedehara Kazuha",
  Ayaka: "Kamisato Ayaka",
  Ayato: "Kamisato Ayato",
  Itto: "Arataki Itto",
  Kokomi: "Sangonomiya Kokomi",
  Yae: "Yae Miko",
  Sara: "Kujou Sara",
  Heizou: "Shikanoin Heizou",
  Shinobu: "Kuki Shinobu",
  Childe: "Tartaglia",
  Yunjin: "Yun Jin",
  Mizuki: "Yumemizuki Mizuki",
  "Dendro Traveler": "Traveler",
  "Hydro Traveler": "Traveler",
  "Pyro Traveler": "Traveler",
  "Anemo Traveler": "Traveler",
  "Electro Traveler": "Traveler",
  "Geo Traveler": "Traveler",
  "Cryo Traveler": "Traveler",
};

// ---------- fetch + html ----------
async function getHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return (await r.text())
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "");
}

function decode(s) {
  return s
    .replace(/&#8217;|&#039;|&rsquo;|&#8216;|&lsquo;/g, "'")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&#8230;|&hellip;/g, "...")
    .replace(/&#215;|&times;/g, "x")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"');
}

function headings(html) {
  return [...html.matchAll(/<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => ({
    index: m.index,
    end: m.index + m[0].length,
    level: Number(m[1][1]),
    text: decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
  }));
}

const MAX_SECTION_CHARS = 8000;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Should You Pull?" -> "shouldYouPull"; "HP Management" -> "hpManagement" */
function camelKey(text) {
  const words = text
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (!words.length) return null;
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
}

function sliceByHeading(html, hs, re) {
  const start = hs.find((h) => re.test(h.text));
  if (!start) return null;
  const next = hs.find((h) => h.index > start.index && h.level <= start.level);
  return { heading: start.text, html: html.slice(start.end, next ? next.index : start.index + 18000) };
}

function tablesIn(seg) {
  return [...seg.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) =>
    [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) =>
      [...r[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((c) =>
        decode(c[0].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
      ),
    ),
  );
}

function plain(seg) {
  return decode(
    seg
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|tr|h[1-6]|table)>/gi, "\n")
      .replace(/<br[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// ---------- stat token ----------
const STAT_CANON = [
  [/\b(crit\s*rate|cr)\b/i, "CRIT Rate"],
  [/\b(crit\s*dmg|cd)\b/i, "CRIT DMG"],
  [/\bcrit\b/i, "CRIT"],
  [/\b(energy\s*recharge|er%?|recharge)\b/i, "ER"],
  [/\b(elemental\s*mastery|em)\b/i, "EM"],
  [/\bhp%|\bhp\s*%|percent\s*hp/i, "HP%"],
  [/\batk%|\batk\s*%/i, "ATK%"],
  [/\bdef%|\bdef\s*%/i, "DEF%"],
  [/\bflat\s*hp\b/i, "Flat HP"],
  [/\bflat\s*atk\b/i, "Flat ATK"],
  [/\bflat\s*def\b/i, "Flat DEF"],
  [/(pyro|hydro|dendro|electro|anemo|cryo|geo|elemental)\s*dmg/i, "Elemental DMG"],
  [/physical\s*dmg/i, "Physical DMG"],
  [/healing\s*bonus/i, "Healing Bonus"],
];
function canonStat(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  for (const [re, name] of STAT_CANON) if (re.test(s)) return name;
  return null;
}
function parseStatList(cell) {
  return [
    ...new Set(
      (cell || "")
        .split(/\s*(?:>|>>|≥|=|,|\bor\b|\/|\|)\s*/i)
        .map(canonStat)
        .filter(Boolean),
    ),
  ];
}
function parsePriority(line) {
  return (line || "")
    .replace(/^[^:]*:/, "")
    .split(/\s*(?:>>|>|≥|=|,|\band\b)\s*|\s*\d+\.\s*/i)
    .map(canonStat)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}
const PRIORITY_LINE_RE = /((?:stat|substat)s?[^:\n]*(?:prior[^:\n]*)?:\s*[^\n]+)/gi;

// ---------- ER ----------
function looksLikeEr(r) {
  return r && r.min >= 60;
}
function parseRange(text) {
  const t = (text || "").replace(/[,~]/g, "").replace(/\s/g, "");
  const plus = /(\d+)%?\+/.exec(t);
  if (plus) return { min: +plus[1], max: null };
  const range = /(\d+)%?[-–](\d+)%?/.exec(t);
  if (range) return { min: +range[1], max: +range[2] };
  const one = /(\d+)%/.exec(t);
  if (one) return { min: +one[1], max: +one[1] };
  return null;
}
function parseErTables(tables) {
  let out = [];
  for (const rows of tables) {
    if (!rows.length) continue;
    const header = rows[0];
    const headerIsRange = header.some((c) => looksLikeEr(parseRange(c)));
    if (rows.every((r) => r.length === 2) && !headerIsRange) {
      for (const [label, val] of rows) {
        const r = parseRange(val);
        if (looksLikeEr(r)) out.push({ label, ...r });
      }
    } else if (rows.length === 2 && header.length === rows[1].length && header.length > 2) {
      header.forEach((h, i) => {
        const r = parseRange(rows[1][i]);
        if (looksLikeEr(r) && h) out.push({ label: h, ...r });
      });
    } else if (rows.length > 2 && header.length > 2) {
      const cols = header.slice(1);
      for (const row of rows.slice(1)) {
        row.slice(1).forEach((v, i) => {
          const r = parseRange(v);
          if (looksLikeEr(r)) {
            const col = cols[i] && !looksLikeEr(parseRange(cols[i])) ? ` — ${cols[i]}` : "";
            out.push({ label: `${row[0]}${col}`.trim(), ...r });
          }
        });
      }
    } else {
      for (const row of rows)
        for (const cell of row) {
          const r = parseRange(cell);
          if (looksLikeEr(r)) out.push({ label: row[0] || "general", ...r });
        }
    }
  }
  const seen = new Set();
  out = out.filter((e) => {
    const k = `${e.label}|${e.min}|${e.max}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // tabel matrix rumit sering keparse jadi label sampah ("1", "2", duplikat).
  // Lebih baik kosong -> scorer fallback ke teks mentah, daripada ngasih rentang ngaco.
  return looksDegenerate(out) ? [] : out;
}

function looksDegenerate(entries) {
  if (entries.length > 12) return true;
  if (entries.some((e) => /^\d+$/.test(e.label.trim()) || /^general$/i.test(e.label.trim())))
    return true;
  const labels = entries.map((e) => e.label.trim().toLowerCase());
  const uniq = new Set(labels).size;
  return entries.length >= 4 && uniq / entries.length < 0.6;
}

// ---------- builds ----------
function parseBuilds(seg) {
  const builds = [];
  const tables = tablesIn(seg).filter(
    (t) => t[0] && /sands/i.test(t[0][0] || "") && /circlet/i.test(t[0].join(" ")),
  );
  const priLines = [...plain(seg).matchAll(PRIORITY_LINE_RE)].map((m) => m[1]);
  tables.forEach((t, i) => {
    const vals = t[1] || [];
    builds.push({
      name: null,
      sands: parseStatList(vals[0]),
      goblet: parseStatList(vals[1]),
      circlet: parseStatList(vals[2]),
      substatPriority: priLines[i] ? parsePriority(priLines[i]) : [],
    });
  });
  const names = [...seg.matchAll(/<(?:h[3-5]|strong|b)[^>]*>([^<]{3,44})<\/(?:h[3-5]|strong|b)>/gi)]
    .map((m) => decode(m[1]).trim())
    .filter((n) => !/sands|goblet|circlet|artifact|stat|substat/i.test(n));
  if (builds.length > 1 && names.length >= builds.length)
    builds.forEach((b, i) => (b.name = names[i] ?? null));
  return builds;
}

// ---------- sets ----------
function parseSets(seg) {
  const out = [];
  const tables = tablesIn(seg);
  const rows = tables.find((t) => t.some((r) => r.length >= 2 && /\d\s*-?\s*pc|4pc|2pc/i.test(r[0])));
  const push = (cell, note) => {
    for (const part of (cell || "").split(/\s*(?:,|\/)\s*/)) {
      const m = /(\d)\s*-?\s*(?:pc|piece)?\s*(.+)/i.exec(part.trim());
      if (!m) continue;
      const name = m[2].replace(/\([^)]*\)/g, "").trim();
      if (name && name.length > 2) out.push({ pieces: +m[1], name, note: note || null });
    }
  };
  if (rows) {
    for (const r of rows) if (/\d\s*-?\s*pc/i.test(r[0])) push(r[0], r[1]);
  } else {
    for (const m of plain(seg).matchAll(/^-?\s*(\d\s*-?pc\b[^\n]+)/gim)) push(m[1], null);
  }
  return out;
}

// ---------- weapons (ranked) ----------
function parseWeapons(seg) {
  const tables = tablesIn(seg);
  const rows = tables.find((t) => t.length >= 2 && t[0].length >= 2);
  if (rows) {
    return rows
      .map((r) => (r[0] || "").replace(/\(.*?\)/g, "").trim())
      .filter((n) => n.length > 2 && !/weapon|note/i.test(n));
  }
  // fallback: nama bold berurutan
  return [...seg.matchAll(/<(?:strong|b|h[3-5])[^>]*>([^<]{3,50})<\/(?:strong|b|h[3-5])>/gi)]
    .map((m) => decode(m[1]).trim())
    .filter((n) => !/weapon|note|recommended|niche|signature/i.test(n))
    .slice(0, 12);
}

// ---------- constellations ----------
function parseConstellations(seg) {
  const text = plain(seg).replace(/\n/g, " ");
  const out = {};
  const re = /Constellation ([1-6])\s*\|\s*([^]*?)(?=Constellation [1-6]\s*\||Click here|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2].replace(/Constellation Description/i, " ").replace(/\s+/g, " ").trim();
    if (body) out[m[1]] = body.slice(0, 600);
  }
  return out;
}

// ---------- talent priority ----------
function parseTalentPriority(seg) {
  const lines = plain(seg).split("\n").map((l) => l.trim());
  // baris pendek yang isinya nama talent + operator perbandingan
  const cand = lines.find(
    (l) =>
      l.length < 90 &&
      /(normal attack|\bna\b|skill|burst|charged)/i.test(l) &&
      /(≥|>|=|<)/.test(l) &&
      /(normal attack|\bna\b|skill|burst|charged|lvl|level)/i.test(l.replace(/^[^≥>=<]+/, "")),
  );
  return cand ?? null;
}

// ---------- per-guide ----------
async function scrapeGuide(url, slug) {
  const html = await getHtml(url);
  const hs = headings(html);
  const title =
    /og:title" content="([^"]+?)(?:\s*Quick Guide)?"/i.exec(html)?.[1]?.trim() || slug;
  const kqmName = title.replace(/\s*Quick Guide.*/i, "").trim();
  const canonName = NAME_ALIAS[kqmName] ?? kqmName;
  const guideUpdated = /article:modified_time" content="([^"]+)"/i.exec(html)?.[1] ?? null;

  const sections = {};
  const rawSections = {};

  // 1) section kanonik dulu — judulnya beda-beda antar karakter, jadi di-map via regex
  //    ke key tetap supaya konsumen (check/cli/assess) nggak pecah.
  const claimed = new Set();
  for (const [key, re] of Object.entries(SECTION_MATCHERS)) {
    const start = hs.find((h) => re.test(h.text) && !claimed.has(h.index));
    if (!start) continue;
    claimed.add(start.index);
    const s = sliceByHeading(html, hs, new RegExp(`^${escapeRe(start.text)}$`, "i"));
    if (!s) continue;
    rawSections[key] = plain(s.html).slice(0, MAX_SECTION_CHARS);
    sections[key] = { heading: s.heading, html: s.html };
  }

  // 2) sisanya: SEMUA heading h1/h2 lain ikut ditangkap generik (Combos, Should You Pull,
  //    Abilities, dst) — teks lengkap ini yang dipakai layer AI.
  const SKIP_HEADING = /^(infographic|credits|table of contents)$/i;
  for (const h of hs) {
    if (h.level > 2 || claimed.has(h.index)) continue;
    if (SKIP_HEADING.test(h.text)) continue;
    if (/quick guide$/i.test(h.text)) continue; // judul halaman
    const next = hs.find((x) => x.index > h.index && x.level <= h.level);
    const end = next ? next.index : h.index + 18000;
    // heading pembungkus (mis. h1 "Artifacts" yang isinya ER/Stats/Sets) -> skip,
    // isinya udah ke-capture per-section di atas.
    if ([...claimed].some((i) => i > h.index && i < end)) continue;

    const key = camelKey(h.text);
    if (!key || key in rawSections) continue;
    const text = plain(html.slice(h.end, end)).slice(0, MAX_SECTION_CHARS);
    if (text.length < 40) continue; // skip heading kosong / cuma nav
    rawSections[key] = text;
  }

  const erSeg = sections.erRequirements?.html ?? "";
  const statsSeg = sections.artifactStats?.html ?? "";
  const setsSeg = sections.artifactSets?.html ?? "";
  const wpnSeg = sections.weapons?.html ?? "";
  const conSeg = sections.constellations?.html ?? "";
  const talentSeg = sections.talents?.html ?? "";

  return {
    slug,
    kqmName,
    canonName,
    sourceUrl: url,
    guideUpdated,
    scrapedAt: new Date().toISOString(),
    raw: rawSections,
    parsed: {
      erRequirements: erSeg ? parseErTables(tablesIn(erSeg)) : [],
      builds: statsSeg ? parseBuilds(statsSeg) : [],
      sets: setsSeg ? parseSets(setsSeg) : [],
      weaponsRanked: wpnSeg ? parseWeapons(wpnSeg) : [],
      constellations: conSeg ? parseConstellations(conSeg) : {},
      talentPriority: talentSeg ? parseTalentPriority(talentSeg) : null,
    },
  };
}

// ---------- main ----------
async function listSlugs() {
  const html = await getHtml(HOME);
  return [
    ...new Set(
      [
        ...html.matchAll(/href="https:\/\/keqingmains\.com\/q\/([a-z0-9-]+)-quickguide\/?"/gi),
      ].map((m) => m[1]),
    ),
  ].sort();
}

async function main() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  const li = args.indexOf("--limit");
  if (li >= 0) limit = Number(args[li + 1]);
  const explicit = args.filter((a) => !a.startsWith("--") && a !== String(limit));
  const slugs = (explicit.length ? explicit : await listSlugs()).slice(0, limit);

  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(`scraping ${slugs.length} guides -> ${OUT_DIR}`);
  const index = [];

  for (const slug of slugs) {
    const url = `https://keqingmains.com/q/${slug}-quickguide/`;
    try {
      const g = await scrapeGuide(url, slug);
      await fs.writeFile(
        path.join(OUT_DIR, `${slug}.json`),
        JSON.stringify(g, null, 2),
        "utf8",
      );
      index.push({
        slug,
        canonName: g.canonName,
        sourceUrl: url,
        guideUpdated: g.guideUpdated,
      });
      const p = g.parsed;
      console.log(
        `  ok  ${slug.padEnd(20)} ${g.canonName.padEnd(18)} b:${p.builds.length} er:${p.erRequirements.length} sets:${p.sets.length} wpn:${p.weaponsRanked.length} con:${Object.keys(p.constellations).length}`,
      );
    } catch (err) {
      console.warn(`  ERR ${slug}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  await fs.writeFile(
    path.join(DATA_DIR, "_index.json"),
    JSON.stringify(index, null, 2),
    "utf8",
  );
  console.log(`\nwrote ${index.length} files -> ${OUT_DIR} (+ _index.json)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
