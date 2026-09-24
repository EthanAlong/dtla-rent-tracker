// Probe a candidate building's website to see whether it can be tracked
// without a browser, and with which adapter.
//
//   node scraper/probe.js https://example-apts.com [more urls…]
//   npm run probe -- https://example-apts.com
//
// For each URL it fetches the page plus the usual floorplan/availability
// paths (and any same-site link whose text mentions floor plans /
// availability), then reports:
//   · sightmap.com/embed/<id>  → add a config entry with adapter "sightmap"
//   · .js-plan-row + data-rent-min → Onni Craft site, adapter "onni-craft"
//   · how many "$1,234" figures are server-rendered (0 = needs JS or blocked)
//   · a 403 / Cloudflare challenge → needs a browser, probably not worth it
//   · any text that reads like a concession banner, with a CSS path you can
//     drop straight into config.concession.selector
//
// It never writes anything. Run it from CI (.github/workflows/probe.yml) if
// your own network can't reach the sites.
import * as cheerio from "cheerio";
import { fetchText, squish } from "./lib/util.js";
import { parse as parseSightmap } from "./adapters/sightmap.js";
import { parse as parseOnni } from "./adapters/onni-craft.js";

const COMMON_PATHS = ["", "/floorplans", "/floor-plans", "/floorplans/", "/floor-plan/", "/availability", "/availability/", "/plans/", "/sightmap/", "/apartments/", "/residences/"];
const LINK_HINT = /floor\s*plan|availability|available|sightmap|residences|apartments|pricing/i;
const OFFER_HINT = /(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:month|week)s?\s*(?:of\s*)?free|free\s*rent|look\s*(?:and|&)\s*lease|move[-\s]?in\s*special/i;

async function probe(base) {
  const origin = new URL(base).origin;
  const seen = new Set();
  const queue = COMMON_PATHS.map((p) => (p === "" ? base : origin + p));
  const report = { base, sightmap: new Set(), onni: false, prices: 0, pages: [], offers: [], blocked: [] };

  while (queue.length && seen.size < 14) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let html;
    try {
      html = await fetchText(url, { retries: 1, timeoutMs: 20000 });
    } catch (err) {
      const status = /HTTP (\d+)/.exec(err.message)?.[1];
      if (status && status !== "404") report.blocked.push(`${url} → HTTP ${status}`);
      continue;
    }
    const $ = cheerio.load(html);
    const title = squish($("title").first().text()).slice(0, 60);
    const prices = (html.match(/\$\s?\d{1,2},\d{3}(?!\d)/g) || []).length;
    const ids = [...html.matchAll(/sightmap\.com\/embed\/([a-z0-9]+)/gi)].map((m) => m[1]);
    ids.forEach((id) => report.sightmap.add(id));
    const onni = $(".js-plan-row[data-rent-min]").length;
    if (onni) report.onni = true;
    report.prices = Math.max(report.prices, prices);
    const cf = /cf-browser-verification|challenge-platform|Just a moment/i.test(html);
    report.pages.push(`${url.replace(origin, "") || "/"}  ${title ? `"${title}"` : ""}  prices=${prices}${ids.length ? " sightmap=" + ids.join(",") : ""}${onni ? ` onni-rows=${onni}` : ""}${cf ? " CLOUDFLARE-CHALLENGE" : ""}`);

    // Concession banner candidates: shortest element whose own text reads
    // like an offer. Print a CSS path so it can go straight into config.
    $("script, style, noscript").remove();
    $("body *").each((_, el) => {
      const own = squish($(el).contents().filter((__, n) => n.type === "text").text());
      if (own.length > 8 && own.length < 300 && OFFER_HINT.test(own)) {
        const path = cssPath($, el);
        if (!report.offers.some((o) => o.text === own)) report.offers.push({ page: url, path, text: own });
      }
    });

    // One level of link following, same origin only.
    if (seen.size <= 2) {
      $("a[href]").each((_, a) => {
        const href = $(a).attr("href");
        const text = squish($(a).text());
        if (!LINK_HINT.test(text) && !LINK_HINT.test(href)) return;
        try {
          const u = new URL(href, url);
          if (u.origin === origin && !seen.has(u.href) && queue.length < 20) queue.push(u.href.split("#")[0]);
        } catch {}
      });
    }
  }

  // If a SightMap embed turned up, count its units the same way the adapter will.
  const units = [];
  for (const id of report.sightmap) {
    try {
      const html = await fetchText(`https://sightmap.com/embed/${id}`, { retries: 1 });
      const rows = parseSightmap(html, { id: "probe" });
      units.push(`${id}: ${rows.length} units, $${Math.min(...rows.map((r) => r.rent_min)).toLocaleString()}–$${Math.max(...rows.map((r) => r.rent_min)).toLocaleString()}`);
    } catch (err) {
      units.push(`${id}: embed fetch failed — ${err.message}`);
    }
  }
  if (report.onni) {
    for (const p of ["/availability", "/availability/"]) {
      try {
        const rows = parseOnni(await fetchText(origin + p, { retries: 1 }), { id: "probe" });
        if (rows.length) { units.push(`onni-craft ${p}: ${rows.length} units`); break; }
      } catch {}
    }
  }
  return { ...report, units };
}

function cssPath($, el) {
  const parts = [];
  let cur = el;
  for (let depth = 0; cur && depth < 4 && cur.type === "tag" && cur.name !== "body"; depth++) {
    const cls = ($(cur).attr("class") || "").split(/\s+/).filter((c) => c && !/^(js-)?(active|is-|has-)/.test(c) && c.length < 40).slice(0, 2);
    const id = $(cur).attr("id");
    parts.unshift(id ? `#${id}` : cur.name + (cls.length ? "." + cls.join(".") : ""));
    if (id) break;
    cur = cur.parent;
  }
  return parts.join(" ");
}

async function main() {
  const urls = process.argv.slice(2).filter(Boolean);
  if (!urls.length) {
    console.error("usage: node scraper/probe.js <url> [url…]");
    process.exit(1);
  }
  for (const u of urls) {
    console.log(`\n═══ ${u}`);
    try {
      const r = await probe(u);
      r.pages.forEach((p) => console.log("  " + p));
      r.blocked.forEach((b) => console.log("  ✗ " + b));
      if (r.sightmap.size) console.log(`  ✓ SightMap embed id(s): ${[...r.sightmap].join(", ")}  → adapter "sightmap"`);
      else if (r.onni) console.log('  ✓ Onni Craft availability page  → adapter "onni-craft"');
      else if (r.prices) console.log(`  ~ ${r.prices} server-rendered prices but no known platform — needs a small custom adapter`);
      else console.log("  ✗ no server-rendered prices found — needs JS/browser or is blocked");
      r.units.forEach((x) => console.log("  · " + x));
      r.offers.slice(0, 6).forEach((o) => console.log(`  ⓘ offer text on ${o.page.replace(new URL(u).origin, "") || "/"}\n      selector: ${o.path}\n      text: ${o.text.slice(0, 160)}`));
    } catch (err) {
      console.log("  ✗ " + err.message);
    }
  }
}

main();
