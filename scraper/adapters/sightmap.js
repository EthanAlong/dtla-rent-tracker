// Adapter: buildings whose leasing site embeds an Engrain SightMap
// (Brookfield's Atelier / Eighth & Grand / Beaudry, Circa LA, and many others).
//
// The embed page at https://sightmap.com/embed/<id> ships a schema.org
// JSON-LD blob with EVERY available unit — richer than what the host site
// renders. Since 2026-11-05 each unit carries its own offer:
//
//   containsPlace[] -> {name:"APT 0614", numberOfBedrooms, numberOfBathroomsTotal, floorSize,
//                       offers: {availabilityStarts, price (all-in),
//                                priceSpecification.priceComponent[] -> {name:"Rent", price: 2100}, fees...}}
//
// Before that, units and offers were two parallel arrays (about.containsPlace[]
// + offers.offers[]) joined on unit name. unitOffers() accepts both.
//
// `price` is all-in (base rent + renter's insurance + utility admin fees + pet
// rent). We store the "Rent" component as rent_min/rent_max so it's
// apples-to-apples with sites that advertise base rent, and keep the all-in
// number separately in rent_all_in.
//
// To add a building: find `sightmap.com/embed/<id>` in its floorplans page
// source, then add a config entry with sightmap_id.
import { fetchText, toInt } from "../lib/util.js";
import { deriveFloor } from "../lib/floor.js";

export async function scrape(property) {
  const id = property.sightmap_id;
  if (!id) throw new Error(`${property.id}: config is missing sightmap_id`);
  const url = `https://sightmap.com/embed/${id}`;
  const html = await fetchText(url);
  return { rows: parse(html, property), html };
}

export function parse(html, property = {}) {
  const m = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error(`${property.id}: no JSON-LD on the SightMap embed`);

  const doc = JSON.parse(m[1]);
  const pairs = unitOffers(doc);
  if (!pairs.length && (doc?.containsPlace ?? doc?.about?.containsPlace ?? []).length) {
    // Units are listed but none carried an offer we recognise: the JSON-LD
    // moved again. Fail loudly rather than report "0 units available".
    throw new Error(`${property.id}: SightMap JSON-LD lists units but no offers (format changed?)`);
  }

  return pairs.map(([spec, o]) => {
    const components = Object.fromEntries(
      (o.priceSpecification?.priceComponent ?? []).map((c) => [c.name, c.price]),
    );
    // Base rent is what a listing advertises; fall back to all-in if the
    // property doesn't break the components out.
    const baseRent = Math.round(components["Rent"] ?? o.price ?? 0) || null;
    // "APT 0614" (Brookfield), "HOME 0505" (THEA), "UNIT 300" (Apex & Alina)
    const unit = String(o.name || "").replace(/^(?:APT|UNIT|HOME|RESIDENCE)\.?\s*/i, "").trim();
    const beds = spec.numberOfBedrooms;

    return {
      property_id: property.id || "",
      property_name: property.name || "",
      unit,
      floor: deriveFloor(unit, property.floors),
      floorplan: "", // SightMap's JSON-LD doesn't carry plan codes
      plan_cat: beds === 0 ? "studio" : beds != null ? `${beds}-bed` : "",
      bed_label: beds === 0 ? "Studio" : beds != null ? `${beds} Bed` : "",
      beds: beds ?? null,
      baths: spec.numberOfBathroomsTotal ?? null,
      sqft: toInt(spec.floorSize?.value),
      rent_min: baseRent,
      rent_max: baseRent, // single advertised price, not a lease-term range
      rent_all_in: o.price != null ? Math.round(o.price) : null,
      status: o.availabilityStarts ? "available_on" : "available",
      available_date: o.availabilityStarts || "",
      unit_id: "",
      fp_id: "",
    };
  }).filter((r) => r.rent_min);
}

// SightMap has shipped two JSON-LD shapes; return [spec, offer] pairs for either.
//
//   v1 (until 2026-11-04): a wrapper with two parallel arrays joined on unit name
//        about.containsPlace[] + offers.offers[]
//   v2 (from 2026-11-05): an ApartmentComplex whose units each carry their offer
//        containsPlace[] -> {@type:["Apartment","Product"], name, ..., offers:{price, priceSpecification}}
function unitOffers(doc) {
  if (Array.isArray(doc?.offers?.offers)) {
    const specs = new Map((doc?.about?.containsPlace ?? []).map((u) => [u.name, u]));
    return doc.offers.offers.map((o) => [specs.get(o.name) || {}, o]);
  }
  const places = doc?.containsPlace ?? doc?.about?.containsPlace ?? [];
  return places.flatMap((u) => {
    const list = Array.isArray(u.offers) ? u.offers : u.offers ? [u.offers] : [];
    // Offer carries no name in v2; the unit label lives on the place.
    return list.map((o) => [u, { ...o, name: o.name ?? u.name }]);
  });
}
