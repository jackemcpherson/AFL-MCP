import samples from "./stat-field-capabilities.json";

/**
 * Return source-backed support for an exact competition-season sample.
 * Support demonstrates that the source can supply a field, not that every row
 * must contain it. An all-null sample cannot establish source absence.
 * @param competition - Separate competition discriminator.
 * @param seasonKey - Canonical season selector, preserving AFLW season six/seven.
 */
export function statFieldCapabilities(competition: string, seasonKey: string) {
  const sample = samples.samples.find(
    (row) => row.competition === competition && row.seasonKey === seasonKey,
  );
  const notApplicable = competition === "AFLM" ? [] : ["brownlow_votes"];
  const allFields = [
    ...(samples.samples[0]?.supportedFields ?? []),
    ...(samples.samples[0]?.unverifiedFields ?? []),
  ];
  return {
    source: "afl-api",
    scope: "exact-season sample; no extrapolation to other eras",
    supported: (sample?.supportedFields ?? []).filter((field) => !notApplicable.includes(field)),
    unverified: (sample?.unverifiedFields ?? allFields).filter(
      (field) => !notApplicable.includes(field),
    ),
    notApplicable,
    evidence: sample
      ? { url: sample.url, sha256: sample.sha256, capturedAt: sample.capturedAt }
      : null,
    diagnostic: sample
      ? "Field support does not guarantee row completeness"
      : "No verified capability sample for this era",
  };
}
