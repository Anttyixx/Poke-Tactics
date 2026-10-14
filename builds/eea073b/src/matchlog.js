// What happened by chance in a fight, in plain words, for the match log.
//
// Nothing in a fight is truly random: every chance outcome (crits, which side
// acts first on a tick, Alcremie's flavour, Minior's hop target) comes from the
// fight's seed, which comes from the match seed and the round number. The log's
// seed and moves are enough to replay every fight exactly; this summary just
// spells out the chance outcomes so a person reading the log can see them.

const FLAVOR = { heal: 'healing', haste: 'attack speed', guard: 'shield' };

export function fightSummary(combat, catalog, names) {
  const { result, round, seed } = combat;
  const who = new Map();
  for (const u of result.initial) who.set(u.id, u);
  const label = (id) => {
    const u = who.get(id);
    return u ? `${catalog[u.unitId]?.name ?? u.unitId} (${names[u.side] ?? `player ${u.side + 1}`})` : `unit ${id}`;
  };
  const time = (t) => `${(t / 10).toFixed(1)}s`;
  const chance = [];
  const crits = [0, 0];
  for (const e of result.events) {
    if (e.type === 'summon') who.set(e.unit.id, e.unit);
    else if (e.type === 'treat') chance.push(`${time(e.t)} ${label(e.id)} rolled ${FLAVOR[e.flavor] ?? e.flavor} -> ${label(e.target)}`); else if (e.type === 'blink' && e.hop) chance.push(`${time(e.t)} ${label(e.id)} hopped to (${e.x}, ${e.y})`);
    else if (e.type === 'damage' && e.crit) {
      const u = who.get(e.src);
      if (u) crits[u.side]++;
    }
  }
  return {
    round, seed, winner: result.winner === null ? 'draw' : names[result.winner] ?? result.winner,
    seconds: +(result.ticks / 10).toFixed(1),
    crits: Object.fromEntries(names.map((n, i) => [n, crits[i]])),
    chance,
  };
}
