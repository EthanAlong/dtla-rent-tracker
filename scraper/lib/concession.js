// Concessions ("2 months free", "$2,500 look & lease") live in a banner on each
// building's own marketing site, not in the unit feeds — so they're fetched
// from a separate URL + CSS selector per property (see config.concession).
//
// Everything derived here is a convenience on top of `raw_text`, which is
// always stored verbatim. These are advertised MAXIMA ("up to…", "on select
// homes…"), not a discount every unit actually gets — the dashboard labels any
// number computed from them as an upper bound, and you should read raw_text
// before quoting anything in a negotiation.
import * as cheerio from "cheerio";
import { fetchText, squish, toISODate } from "./util.js";

const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const WEEKS_PER_MONTH = 4.345;

function num(token) {
  if (!token) return null;
  const w = WORD_NUM[token.toLowerCase()];
  if (w) return w;
  const n = parseFloat(token.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseConcession(raw) {
  const t = squish(raw);
  if (!t) return null;
  const N = "(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";

  const months = new RegExp(`${N}\\s*month[s]?\\s*(?:of\\s*)?free`, "i").exec(t)
    || new RegExp(`${N}\\s*month[s]?\\s*free`, "i").exec(t);
  const weeks = new RegExp(`${N}\\s*week[s]?\\s*free`, "i").exec(t);

  let monthsFree = months ? num(months[1]) : null;
  if (monthsFree == null && weeks) {
    const w = num(weeks[1]);
    monthsFree = w == null ? null : Math.round((w / WEEKS_PER_MONTH) * 100) / 100;
  }

  // "on Skyhomes" / "on Select Apartment Homes" — who the offer actually
  // applies to. A scope that names a floorplan category can be matched against
  // plan_cat; "select homes" can't, and stays a warning string.
  const scope = /\bon\s+(select\s+[a-z ]*homes|skyhomes|townhomes|select\s+apartments?)/i.exec(t);
  const lookLease = /\$([\d,]+)\s*(?:look\s*(?:and|&)\s*lease|look\s*&?\s*lease)/i.exec(t)
    || /look\s*(?:and|&)\s*lease[^$]{0,20}\$([\d,]+)/i.exec(t);
  const moveIn = /move[-\s]?in\s*by\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(t);
  const term = /(\d+)\s*(?:-\s*(\d+))?\+?\s*month\s*lease/i.exec(t)
    || /(\d+)\s*(?:-\s*(\d+))?\+?[-\s]month\s*lease\s*term/i.exec(t);

  return {
    raw_text: t,
    months_free: monthsFree,
    up_to: /\bup\s*to\b/i.test(t),
    scope: scope ? squish(scope[1]).toLowerCase() : "",
    look_lease_usd: lookLease ? num(lookLease[1]) : null,
    move_in_by: moveIn ? toISODate(normalizeYear(moveIn[1])) : "",
    min_lease_months: term ? num(term[1]) : null,
  };
}

// "8/31/26" -> "8/31/2026" so toISODate can take it.
function normalizeYear(d) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(d);
  if (!m) return d;
  const y = m[3].length === 2 ? "20" + m[3] : m[3];
  return `${m[1]}/${m[2]}/${y}`;
}

// Any wording that means "there is an offer on this page". Used only to tell a
// stale selector apart from a genuinely ended promotion — see scrapeConcession.
const OFFER_HINT =
  /(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:month|week)s?\s*(?:of\s*)?free|free\s*rent|look\s*(?:and|&)\s*lease|move[-\s]?in\s*special|concession/i;

/**
 * Fetch a property's banner and parse it.
 *
 * Returns `{status}` one of:
 *   active — the selector matched; the offer is in the other fields
 *   ended  — the selector matched nothing AND the page mentions no offer at
 *            all, so the promotion really is over
 *   check  — the selector matched nothing but the page still talks about free
 *            rent. That means the site moved its banner and our selector is
 *            stale. Without this distinction a redesign is indistinguishable
 *            from an offer ending, and we'd silently log a fake "offer ended".
 */
export async function scrapeConcession(property) {
  const cfg = property.concession;
  if (!cfg?.url || !cfg?.selector) return null;
  const html = await fetchText(cfg.url);
  const $ = cheerio.load(html);

  const raw = squish($(cfg.selector).first().text());
  if (raw) return Object.assign({ status: "active", source_url: cfg.url }, parseConcession(raw));

  // Strip scripts before the fallback scan — these sites ship i18n blobs
  // containing strings like "special_offer", which would fake a hit forever.
  $("script, style, noscript").remove();
  const pageText = squish($("body").text());
  const empty = {
    raw_text: "", months_free: null, up_to: false, scope: "",
    look_lease_usd: null, move_in_by: "", min_lease_months: null,
  };
  return Object.assign(
    { status: OFFER_HINT.test(pageText) ? "check" : "ended", source_url: cfg.url },
    empty,
  );
}
