// Scrape every enabled property in config/properties.json and append one CSV
// row per available unit to data/prices.csv.
//
//   node scraper/track.js            scrape all enabled properties
//   node scraper/track.js 825-south-hill   scrape just one (by id)
//   DUMP=1 node scraper/track.js     also save raw HTML to scraper/dumps/
//
// Exit codes: 0 all good · 1 unexpected crash · 2 one or more properties
// returned zero rows (page structure probably changed).
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { csvEscape, sleep } from "./lib/util.js";
import { scrapeConcession } from "./lib/concession.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
// Canonical CSV lives under docs/ so GitHub Pages can fetch it with a plain
// relative path — no raw.githubusercontent URL, works for a private repo too.
const CSV_PATH = resolve(ROOT, "docs", "data", "prices.csv");
// Concessions change rarely, so this one is a CHANGE LOG, not a snapshot per
// scrape: a row is written only when a building's banner text differs from the
// last one recorded (including when an offer disappears). The dashboard reads
// "the offer in force at time T" as the latest row at or before T.
const CONC_PATH = resolve(ROOT, "docs", "data", "concessions.csv");
const DUMP_DIR = resolve(__dirname, "dumps");

const COLUMNS = [
  "timestamp", "property_id", "property_name", "unit", "floor", "floorplan",
  "plan_cat", "bed_label", "beds", "baths", "sqft", "rent_min", "rent_max",
  "rent_all_in", "status", "available_date", "unit_id", "fp_id",
];

const CONC_COLUMNS = [
  "timestamp", "property_id", "property_name", "raw_text", "months_free",
  "up_to", "scope", "look_lease_usd", "move_in_by", "min_lease_months", "source_url",
];

async function main() {
  const only = process.argv[2];
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "config", "properties.json"), "utf8"));
  const targets = cfg.properties.filter(
    (p) => p.enabled !== false && (!only || p.id === only),
  );
  if (targets.length === 0) {
    console.error(only ? `No enabled property with id "${only}".` : "No enabled properties.");
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const allRows = [];
  const failures = [];
  const concessions = { existing: readConcessions(), appended: [] };

  for (const [i, property] of targets.entries()) {
    if (i > 0) await sleep(2000); // be a polite guest between buildings
    try {
      const { scrape } = await import(`./adapters/${property.adapter}.js`);
      const { rows, html } = await scrape(property);

      if (process.env.DUMP && html) {
        mkdirSync(DUMP_DIR, { recursive: true });
        writeFileSync(
          resolve(DUMP_DIR, `${property.id}_${timestamp.replace(/[:.]/g, "-")}.html`),
          html, "utf8",
        );
      }

      if (rows.length === 0) {
        failures.push(`${property.id}: 0 units parsed (page structure changed?)`);
      }
      rows.forEach((r) => allRows.push({ timestamp, ...r }));
      let concNote = "";
      try {
        const c = await scrapeConcession(property);
        const changed = recordConcession(property, c, timestamp, concessions);
        if (c) concNote = `  · ${c.months_free ? c.months_free + "mo free" : "offer"}${changed ? " (NEW)" : ""}`;
        else if (changed) concNote = "  · offer ended";
      } catch (err) {
        // A missing banner must never cost us the price data.
        console.error(`  ${property.id.padEnd(20)} concession lookup failed — ${err.message}`);
      }
      console.log(`  ${property.id.padEnd(20)} ${String(rows.length).padStart(3)} units${concNote}`);
    } catch (err) {
      failures.push(`${property.id}: ${err.message}`);
      console.error(`  ${property.id.padEnd(20)} FAILED — ${err.message}`);
    }
  }

  if (allRows.length) {
    mkdirSync(dirname(CSV_PATH), { recursive: true });
    if (!existsSync(CSV_PATH)) writeFileSync(CSV_PATH, COLUMNS.join(",") + "\n", "utf8");
    const lines = allRows.map((r) => COLUMNS.map((c) => csvEscape(r[c])).join(","));
    appendFileSync(CSV_PATH, lines.join("\n") + "\n", "utf8");
    console.log(`\n✓ ${allRows.length} rows appended at ${timestamp}`);
    summarize(allRows);
  }

  if (concessions.appended.length) {
    if (!existsSync(CONC_PATH)) writeFileSync(CONC_PATH, CONC_COLUMNS.join(",") + "\n", "utf8");
    appendFileSync(
      CONC_PATH,
      concessions.appended.map((r) => CONC_COLUMNS.map((c) => csvEscape(r[c])).join(",")).join("\n") + "\n",
      "utf8",
    );
    console.log(`✓ ${concessions.appended.length} concession change(s) logged`);
  }

  if (failures.length) {
    console.error("\nProblems:\n  " + failures.join("\n  "));
    process.exit(2);
  }
}

/** Last recorded raw_text per property, so we only log actual changes. */
function readConcessions() {
  if (!existsSync(CONC_PATH)) return new Map();
  const lines = readFileSync(CONC_PATH, "utf8").trim().split(/\r?\n/).slice(1);
  const last = new Map();
  for (const line of lines) {
    // property_id is field 2 and never contains a comma; raw_text may, so read
    // it back through a minimal quoted-CSV split.
    const cells = splitCsvLine(line);
    last.set(cells[1], cells[3] || "");
  }
  return last;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function recordConcession(property, c, timestamp, state) {
  const previous = state.existing.get(property.id);
  const now = c ? c.raw_text : "";
  if (previous === now) return false;              // nothing changed
  if (previous === undefined && !c) return false;  // never had an offer
  state.existing.set(property.id, now);
  state.appended.push(Object.assign(
    { timestamp, property_id: property.id, property_name: property.name },
    c || { raw_text: "", months_free: null, up_to: "", scope: "", look_lease_usd: null,
           move_in_by: "", min_lease_months: null, source_url: property.concession?.url || "" },
  ));
  return true;
}

function summarize(rows) {
  const byProp = new Map();
  for (const r of rows) {
    if (!byProp.has(r.property_id)) byProp.set(r.property_id, []);
    byProp.get(r.property_id).push(r);
  }
  for (const [id, rs] of byProp) {
    const rents = rs.map((r) => r.rent_min).filter(Boolean).sort((a, b) => a - b);
    const psf = rs.filter((r) => r.rent_min && r.sqft).map((r) => r.rent_min / r.sqft);
    const avgPsf = psf.length ? psf.reduce((a, b) => a + b, 0) / psf.length : 0;
    console.log(
      `  ${id}: ${rs.length} units · $${rents[0]?.toLocaleString()}–$${rents.at(-1)?.toLocaleString()}` +
      ` · avg $${avgPsf.toFixed(2)}/sqft`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
