import { humanizeBillId } from '@capiro/shared';
import type {
  SourceFundingPosition,
  SourceBillPeImpact,
  SourceBillProvision,
  SourceParentPackage,
  SourceRelatedVehicle,
} from '../sourcedata/source-data.repository.js';
import type {
  FundingPositionView,
  ProgramElementImpact,
  FundingProvision,
  FundingVehicleContext,
  RelatedVehicle,
} from './bill-dossier.types.js';
import { num, toIso } from './bill-dossier-presentation.js';
import { amountTreatmentFor, versionedValueSource } from './bill-dossier-funding-format.js';
import { STAGE_ORDER } from './bill-dossier-funding.constants.js';
export function toFundingPositionView(
  p: SourceFundingPosition,
): FundingPositionView & { id: string } {
  return {
    id: p.id,
    vehicleId: p.vehicleId,
    fiscalYear: p.fiscalYear,
    scope: p.scope as FundingPositionView['scope'],
    stage: p.stage as FundingPositionView['stage'],
    vehicleClass: p.vehicleClass as FundingPositionView['vehicleClass'],
    vehicleTrack: (p.vehicleTrack as FundingPositionView['vehicleTrack']) ?? null,
    vehicleStatus: p.vehicleStatus,
    amountTreatment: amountTreatmentFor(p.vehicleTrack ?? p.vehicleClass),
    amountMillions: Number(p.amountMillions),
    effectiveDate: toIso(p.effectiveDate),
    source: p.vehicleLabel ?? p.packageName,
    sourceUrl: p.sourceUrl,
    sourcePage: p.sourcePage,
    sourceDocumentTitle: p.sourceDocumentTitle,
    sourceDocumentKey: p.sourceDocumentKey,
    sourceDocumentVersion: p.sourceDocumentSha256,
    sourceDocumentCurrent: p.sourceDocumentCurrent,
    verification: p.verificationStatus as FundingPositionView['verification'],
    primary: false,
    note: p.note,
  };
}
export function toPeImpactView(p: SourceBillPeImpact): ProgramElementImpact {
  const vehicleTrack = (p.vehicleTrack as ProgramElementImpact['vehicleTrack']) ?? null;
  const stageRank = STAGE_ORDER[p.vehicleStage ?? ''] ?? -1;
  const request = num(p.requestMillions);
  const house = stageRank >= (STAGE_ORDER.house ?? 2) ? num(p.houseMillions) : null;
  const senate = stageRank >= (STAGE_ORDER.senate ?? 3) ? num(p.senateMillions) : null;
  const conference = stageRank >= (STAGE_ORDER.conference ?? 4) ? num(p.conferenceMillions) : null;
  // Enacted is the appropriations/public-law rung. Never let a malformed or
  // legacy row append it to an authorization ladder.
  const enacted =
    vehicleTrack === 'appropriation' && stageRank >= (STAGE_ORDER.enacted ?? 5)
      ? num(p.enactedMillions)
      : null;
  // Same fiscal year by construction (the query pins the PE year to the package FY).
  const latest = enacted ?? conference ?? senate ?? house;
  const delta = request != null && latest != null ? latest - request : null;
  const isAuthorization = vehicleTrack === 'authorization';
  return {
    pe: p.peCode,
    name: p.title,
    fiscalYear: p.fiscalYear,
    vehicleTrack,
    houseLabel: isAuthorization
      ? 'House authorization (HASC)'
      : vehicleTrack === 'appropriation'
        ? 'House appropriation (HAC-D)'
        : 'House amount (track not verified)',
    senateLabel: isAuthorization
      ? 'Senate authorization (SASC)'
      : vehicleTrack === 'appropriation'
        ? 'Senate appropriation (SAC-D)'
        : 'Senate amount (track not verified)',
    conferenceLabel: isAuthorization
      ? 'NDAA conference authorization'
      : vehicleTrack === 'appropriation'
        ? 'Appropriations conference'
        : 'Conference amount (track not verified)',
    requestMillions: request,
    houseMillions: house,
    senateMillions: senate,
    conferenceMillions: conference,
    enactedMillions: enacted,
    deltaVsRequestMillions: delta,
    pct:
      delta != null && request != null && request !== 0
        ? Number(((delta / request) * 100).toFixed(2))
        : null,
    // A verbatim PE-code link is explicit; everything fuzzier is inferred and the UI
    // must label it as such (§5 edge cases 23-24).
    basis: p.matchBasis === 'explicit_pe_code' ? 'explicit' : 'inferred',
    source: peImpactSource(p, request, house, senate, conference, enacted),
  };
}
function peImpactSource(
  p: SourceBillPeImpact,
  request: number | null,
  house: number | null,
  senate: number | null,
  conference: number | null,
  enacted: number | null,
): string {
  return [
    p.fiscalYear ? `FY${p.fiscalYear}` : null,
    p.vehicleTrack ? `${p.vehicleTrack} track` : 'track not verified',
    p.matchBasis,
    p.reviewStatus,
    `confidence ${p.confidence}`,
    versionedValueSource(
      'request',
      request,
      p.requestSourceDocumentKey,
      p.requestSourceDocumentSha256,
    ),
    versionedValueSource('house', house, p.houseSourceDocumentKey, p.houseSourceDocumentSha256),
    versionedValueSource('senate', senate, p.senateSourceDocumentKey, p.senateSourceDocumentSha256),
    versionedValueSource(
      'conference',
      conference,
      p.conferenceSourceDocumentKey,
      p.conferenceSourceDocumentSha256,
    ),
    versionedValueSource(
      'enacted',
      enacted,
      p.enactedSourceDocumentKey,
      p.enactedSourceDocumentSha256,
    ),
  ]
    .filter(Boolean)
    .join(' · ');
}
export function toFundingProvisionView(p: SourceBillProvision): FundingProvision {
  return {
    sec: p.peCode ? `PE ${p.peCode}` : null,
    title: p.heading,
    summary: p.text,
    // Report language is quoted verbatim from an official document.
    origin: 'official',
    source: [p.committee, `FY${p.fy}`, p.pageStart != null ? `p.${p.pageStart}` : null]
      .filter(Boolean)
      .join(' · '),
    actionType: p.actionType,
    reviewStatus: p.reviewStatus,
    billLinkStatus: p.billLinkStatus,
    reconciliationRequired:
      p.reviewStatus === 'accepted' &&
      p.billLinkStatus === 'accepted' &&
      ['adds', 'cuts', 'transfers'].includes(p.actionType ?? ''),
  };
}

export function toFundingVehicleContext(
  parent: SourceParentPackage | null,
  positions: SourceFundingPosition[],
): FundingVehicleContext | null {
  if (parent) {
    return {
      id: parent.vehicleId,
      label: parent.vehicleLabel,
      track: parent.vehicleTrack as FundingVehicleContext['track'],
      stage: parent.vehicleStage as FundingVehicleContext['stage'],
      status: parent.vehicleStatus,
      chamber: parent.vehicleChamber,
      fiscalYear: parent.fiscalYear,
      amountTreatment: amountTreatmentFor(parent.vehicleTrack),
      sourceDocumentTitle: parent.sourceDocumentTitle,
      sourceDocumentKey: parent.sourceDocumentKey,
      sourceDocumentVersion: parent.sourceDocumentSha256,
      sourceDocumentUrl: parent.sourceDocumentUrl,
      sourceDocumentCurrent: parent.sourceDocumentCurrent,
    };
  }
  const position = positions[0];
  if (!position || !position.vehicleId || !position.vehicleTrack || !position.vehicleLabel) {
    return null;
  }
  return {
    id: position.vehicleId,
    label: position.vehicleLabel,
    track: position.vehicleTrack as FundingVehicleContext['track'],
    stage: position.stage as FundingVehicleContext['stage'],
    status: position.vehicleStatus ?? 'unknown',
    chamber: null,
    fiscalYear: position.fiscalYear,
    amountTreatment: amountTreatmentFor(position.vehicleTrack),
    sourceDocumentTitle: position.sourceDocumentTitle,
    sourceDocumentKey: position.sourceDocumentKey,
    sourceDocumentVersion: position.sourceDocumentSha256,
    sourceDocumentUrl: position.sourceUrl,
    sourceDocumentCurrent: position.sourceDocumentCurrent,
  };
}

export function hasFundingTableValues(impact: ProgramElementImpact): boolean {
  return [
    impact.requestMillions,
    impact.houseMillions,
    impact.senateMillions,
    impact.conferenceMillions,
    impact.enactedMillions,
  ].some((value) => value != null);
}

export function toRelatedVehicleView(v: SourceRelatedVehicle): RelatedVehicle {
  return {
    billId: v.billId ?? v.vehicleId,
    num: v.billId ? humanizeBillId(v.billId) : (v.publicLaw ?? v.reportNumber ?? v.label),
    title: v.label,
    role: `${v.track} · ${v.stage}`,
  };
}
