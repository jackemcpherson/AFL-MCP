import { fetchMatches } from "fitzroy";

async function probe(year: number) {
  console.log(`\n=== ${year} (afl-api) ===`);
  const r = await fetchMatches({ source: "afl-api", season: year, competition: "AFLM" });
  if (!r.success) {
    console.log(`  FAILED: ${r.error.message}`);
    return;
  }
  const early = r.data
    .filter((m) => {
      const d = new Date(m.date);
      return d.getUTCMonth() <= 2;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  for (const m of early) {
    const dateStr = new Date(m.date).toISOString().slice(0, 10);
    console.log(
      `  ${dateStr} round=${m.roundCode ?? `(rn=${m.roundNumber})`} rn=${m.roundNumber} type=${m.roundType} ${m.homeTeam} v ${m.awayTeam}`,
    );
  }
  // Round-number distribution
  const counts = new Map<number, number>();
  for (const m of r.data) {
    counts.set(m.roundNumber, (counts.get(m.roundNumber) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => a[0] - b[0]);
  console.log("  round_number counts:", sorted.map(([rn, n]) => `${rn}=${n}`).join(" "));
}

async function main() {
  for (const y of [2024, 2025, 2026]) await probe(y);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
