// Export the fused model as a Brick Schema graph (Turtle), plus a plain JSON
// model. Building -> Floor -> Room, Panelboard -> Circuit -> Room,
// Equipment located in rooms, meters, cameras. Each node carries where its
// facts came from and how sure we are (hukum:source, hukum:confidence).

const PREFIXES = `@prefix brick: <https://brickschema.org/schema/Brick#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix unit: <http://qudt.org/vocab/unit/> .
@prefix hukum: <https://hukum.energy/schema#> .
@prefix : <https://hukum.energy/nhce#> .

hukum:Circuit rdfs:subClassOf brick:Electrical_Equipment ;
    rdfs:comment "One breaker on a distribution board; HUKUM switches rooms through these." .
hukum:confidence rdfs:comment "0-1 confidence after fusing every source." .
hukum:source rdfs:comment "Sources that support this node." .
`;

const KIND_CLASS = {
  pump: 'brick:Pump', chiller: 'brick:Chiller', ahu: 'brick:AHU', battery: 'brick:Battery',
  'ev-charger': 'brick:Electric_Vehicle_Charging_Station', inverter: 'brick:Inverter', motor: 'brick:Motor', transformer: 'brick:Transformer',
};

const iri = (s) => ':' + String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const lit = (s) => JSON.stringify(String(s));
const num = (n) => `"${n}"^^xsd:double`;

export function buildModel(scan) {
  const res = scan.fused.resolved;
  const by = new Map();
  for (const r of res) {
    if (!by.has(r.subject)) by.set(r.subject, {});
    by.get(r.subject)[r.predicate] = r;
  }
  const get = (s, p) => by.get(s)?.[p];
  const rooms = [...by.entries()].filter(([, f]) => f.exists?.value === true && f.on_floor).map(([id, f]) => ({
    id, floor: f.on_floor.value, name: f.name?.value || null, area: f.area_m2?.value ?? null, seats: f.seats?.value ?? null,
    lights: f.light_fittings?.value ?? null, peak: f.peak_occupancy?.value ?? null,
    confidence: f.exists.confidence, sources: [...new Set(Object.values(f).flatMap((x) => x.sources))],
    status: f.exists.status,
  }));
  const roomIds = new Set(rooms.map((r) => r.id));
  const circuits = [...by.entries()].filter(([, f]) => f.feeds).map(([id, f]) => ({ id, panel: id.split('/')[0], breaker: id.split('/')[1], room: f.feeds.value, confidence: f.feeds.confidence, status: f.feeds.status, sources: f.feeds.sources }));
  const equipment = [...by.entries()].filter(([, f]) => f.rated_kw || f.kind?.sources.includes('nameplate')).map(([id, f]) => ({
    id, kind: f.kind?.value, ratedKW: f.rated_kw?.value ?? null, runningKW: f.running_kw?.value ?? null, capacityKWh: f.capacity_kwh?.value ?? null,
    model: f.model?.value, make: f.make?.value, room: f.located_in?.value, confidence: f.rated_kw?.confidence ?? 0.8,
  }));
  const cameras = [...by.entries()].filter(([, f]) => f.observes).map(([id, f]) => ({ id, room: f.observes.value, confidence: f.observes.confidence }));
  const floors = [...new Set(rooms.map((r) => r.floor))].sort();
  return {
    site: { name: get('SITE', 'name')?.value || scan.site.name, lat: scan.site.lat, lon: scan.site.lon },
    building: {
      id: 'MB', name: get('MB', 'name')?.value || 'Main Block', floors: get('MB', 'floors')?.value ?? floors.length,
      footprintM2: get('MB', 'footprint_area_m2')?.value, heightM: get('MB', 'height_m')?.value,
      roofKWp: get('MB', 'roof_kwp')?.value, yearlySolarKWh: get('MB', 'yearly_kwh')?.value,
    },
    floors, rooms, circuits: circuits.filter((c) => roomIds.has(c.room)), equipment, cameras,
    transforms: scan.T,
    openQuestions: scan.fused.review.filter((r) => !r.decided).map((r) => ({ key: r.key, title: r.title })),
  };
}

export function toTurtle(model) {
  const L = [PREFIXES];
  const meta = (o) => `    hukum:confidence ${num(o.confidence?.toFixed ? +o.confidence.toFixed(2) : o.confidence)}${o.sources ? ` ;\n    hukum:source ${o.sources.map(lit).join(', ')}` : ''}`;
  L.push(`:NHCE a brick:Site ;\n    rdfs:label ${lit(model.site.name)} ;\n    brick:hasPart ${iri(model.building.id)} .\n`);
  const b = model.building;
  const bl = [`${iri(b.id)} a brick:Building`, `    rdfs:label ${lit(b.name)}`];
  if (b.footprintM2) bl.push(`    brick:area [ brick:value ${num(b.footprintM2)} ; brick:hasUnit unit:M2 ]`);
  if (b.roofKWp) bl.push(`    hukum:rooftopSolarPotentialKWp ${num(b.roofKWp)}`);
  if (b.yearlySolarKWh) bl.push(`    hukum:yearlySolarKWh ${num(b.yearlySolarKWh)}`);
  bl.push(`    brick:hasPart ${model.floors.map(iri).join(', ')}`);
  bl.push(`    brick:isMeteredBy :MB-METER`);
  L.push(bl.join(' ;\n') + ' .\n');
  L.push(`:MB-METER a brick:Building_Electrical_Meter ;\n    rdfs:label "Main Block energy meter" ;\n    brick:hasPoint :MB-METER-kW .\n:MB-METER-kW a brick:Active_Power_Sensor .\n`);
  for (const f of model.floors) {
    const rs = model.rooms.filter((r) => r.floor === f);
    L.push(`${iri(f)} a brick:Floor ;\n    rdfs:label ${lit(f)} ;\n    brick:hasPart ${rs.map((r) => iri(r.id)).join(', ')} .\n`);
  }
  for (const r of model.rooms) {
    const p = [`${iri(r.id)} a brick:Room`];
    if (r.name) p.push(`    rdfs:label ${lit(r.name)}`);
    if (r.area != null) p.push(`    brick:area [ brick:value ${num(r.area)} ; brick:hasUnit unit:M2 ]`);
    if (r.seats != null) p.push(`    hukum:seats ${r.seats}`);
    if (r.peak != null) p.push(`    hukum:peakOccupancy ${r.peak}`);
    p.push(meta(r));
    L.push(p.join(' ;\n') + ' .\n');
  }
  const panels = [...new Set(model.circuits.map((c) => c.panel))];
  for (const pn of panels) {
    const cs = model.circuits.filter((c) => c.panel === pn);
    L.push(`${iri(pn)} a brick:Panelboard ;\n    brick:feeds ${cs.map((c) => iri(c.id)).join(', ')} .\n`);
    for (const c of cs) L.push(`${iri(c.id)} a hukum:Circuit ;\n    rdfs:label ${lit(`${pn} ${c.breaker}`)} ;\n    brick:feeds ${iri(c.room)} ;\n${meta(c)} .\n`);
  }
  for (const e of model.equipment) {
    const p = [`${iri(e.id)} a ${KIND_CLASS[e.kind] || 'brick:Equipment'}`];
    if (e.make || e.model) p.push(`    rdfs:label ${lit([e.make, e.model].filter(Boolean).join(' '))}`);
    if (e.room) p.push(`    brick:hasLocation ${iri(e.room)}`);
    if (e.ratedKW != null) p.push(`    hukum:ratedKW ${num(e.ratedKW)}`);
    if (e.runningKW != null) p.push(`    hukum:measuredKW ${num(e.runningKW)}`);
    if (e.capacityKWh != null) p.push(`    hukum:capacityKWh ${num(e.capacityKWh)}`);
    p.push(`    brick:isMeteredBy :MB-METER`);
    p.push(meta(e));
    L.push(p.join(' ;\n') + ' .\n');
  }
  for (const c of model.cameras) L.push(`${iri(c.id)} a brick:Video_Surveillance_Equipment ;\n    brick:hasLocation ${iri(c.room)} ;\n${meta(c)} .\n`);
  return L.join('\n');
}
