// Adapter: Onni Group's in-house Craft CMS leasing sites (825 South Hill and
// siblings). The /availability page is fully server-rendered — no JS needed.
//
// Shape we read (one panel per floorplan, N rows per panel):
//   <div class="...__panel js-plan-group" data-cat="1-bed">
//     <h2>plan <span>K</span></h2>  <p class="text-lower">1 Bed</p>
//     <div class="...__row js-plan-row" data-unit="3012" data-cat="1-bed"
//          data-rent-min="3499" data-rent-max="4457">
//       <li><span>#3012</span></li>          <- unit label
//       <li><span>$3,499 - $4,457</span></li><- rent range (across lease terms)
//       <li><span>670 sqft</span></li>
//       <li><span><strong>Available</strong></span></li>  or  <span>10/12/2026</span>
//       <li><a href="...securecafe...UnitID=29417188&FloorPlanID=2413027"></a></li>
//
// rent_min/rent_max come from the data-* attrs, not the text — same lesson as
// the UDR project: attributes survive UI copy changes, rendered text doesn't.
import * as cheerio from "cheerio";
import { fetchText, toInt, toISODate, squish } from "../lib/util.js";
import { deriveFloor } from "../lib/floor.js";

// data-cat -> bedroom count. Townhomes/Skyhomes are marketing buckets that mix
// sizes, so we leave beds null and let sqft do the comparing.
const BEDS_BY_CAT = {
  studio: 0,
  "1-bed": 1,
  "1-bed-den": 1,
  "jr-2-bed": 2,
  "2-bed": 2,
  "2-bed-den": 2,
  "3-bed": 3,
};

export async function scrape(property) {
  const html = await fetchText(property.url);
  const rows = parse(html, property);
  return { rows, html };
}

export function parse(html, property = {}) {
  const $ = cheerio.load(html);
  const rows = [];

  $(".js-plan-group").each((_, panel) => {
    const $panel = $(panel);
    // "plan <span>K</span>" -> "K"
    const floorplan = squish($panel.find("h2 span").first().text());
    const bedLabel = squish($panel.find("p.text-lower").first().text());

    $panel.find(".js-plan-row").each((__, row) => {
      const $row = $(row);
      const cells = $row.find("li").toArray().map((li) => squish($(li).text()));
      const cat = $row.attr("data-cat") || "";
      const href = $row.find("a[href]").attr("href") || "";

      // Cell 3 is either the literal word "Available" or a move-in date.
      const statusCell = cells[3] || "";
      const availableDate = toISODate(statusCell);
      const unit = squish(cells[0] || $row.attr("data-unit") || "").replace(/^#/, "");

      rows.push({
        property_id: property.id || "",
        property_name: property.name || "",
        unit,
        floor: deriveFloor(unit, property.floors),
        floorplan,
        plan_cat: cat,
        bed_label: bedLabel,
        beds: BEDS_BY_CAT[cat] ?? null,
        baths: null, // not exposed on the availability page
        sqft: toInt(cells[2]),
        rent_min: toInt($row.attr("data-rent-min")),
        rent_max: toInt($row.attr("data-rent-max")),
        rent_all_in: null, // Onni advertises base rent only; fees aren't exposed
        status: availableDate ? "available_on" : (statusCell || "unknown").toLowerCase(),
        available_date: availableDate,
        unit_id: (href.match(/[?&]UnitID=(\d+)/i) || [])[1] || "",
        fp_id: (href.match(/[?&]FloorPlanID=(\d+)/i) || [])[1] || "",
      });
    });
  });

  // A row with no rent is a listing artifact (waitlist placeholder), not a
  // real price point — drop it so it can't skew the charts.
  return rows.filter((r) => r.rent_min || r.rent_max);
}
