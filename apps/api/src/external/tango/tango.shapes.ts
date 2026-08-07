/**
 * Audited response shapes.
 *
 * ── What a "shape" is ────────────────────────────────────────────────────────
 *
 * Tango takes a `shape` parameter — a field selector — and returns only the named
 * fields. Nested models use `parent(child,child)`. The SDK ships `ShapeConfig`
 * presets, but this file does not use them: a preset is defined by the provider
 * and can widen underneath us, which is exactly what an audited boundary must not
 * allow.
 *
 * ── Why they are pinned here, one per call family ────────────────────────────
 *
 * THREE reasons, in order of how much they cost when ignored:
 *
 *   1. DATA MINIMISATION. Capiro should not hold provider fields it has no use
 *      for. Every field arriving here is a field somebody has to reason about
 *      when answering "what do we store about this entity".
 *   2. THE UNKNOWN-FIELD RULE. A field that was never requested cannot silently
 *      appear in a normalized domain object. The mapper drops anything not in the
 *      shape, so a provider adding a field next month does not become a Capiro
 *      fact by accident.
 *   3. COST AND LATENCY. A comprehensive entity record is large, and the request
 *      ceiling in P18 is measured in rows, not bytes.
 *
 * ── Every field name here is REAL ────────────────────────────────────────────
 *
 * Taken from the SDK's own `explicitSchemas` — `ENTITY_SCHEMA`, `FORECAST_SCHEMA`,
 * `OPPORTUNITY_SCHEMA`, `NOTICE_SCHEMA`, `VEHICLE_SCHEMA`, `IDV_SCHEMA`. The SDK
 * validates the shape string against those schemas CLIENT-SIDE and throws before
 * issuing the request, so a mistyped or invented field fails loudly at the first
 * call rather than silently returning nothing. `tango.client.spec.ts` drives the
 * real SDK, so that validation runs in CI: a field that stops existing in a future
 * SDK version turns a suite red instead of turning a column null.
 *
 * ── Changing one ─────────────────────────────────────────────────────────────
 *
 * Adding a field is a deliberate act with a reason attached, like a migration.
 * Every shape has a matching `*_FIELDS` list that the mapper allow-lists against,
 * and a test asserts the two agree.
 */

/** Turn a field list into the provider's comma-separated selector. */
function shapeOf(fields: readonly string[]): string {
  return fields.join(',');
}

/**
 * Entity (an organisation, keyed by UEI). Source: `ENTITY_SCHEMA`.
 *
 * Deliberately EXCLUDES `federal_obligations`: Capiro computes award history from
 * its own USAspending rail, and holding a second, differently-derived total
 * invites somebody to compare them and treat the difference as a finding.
 *
 * Also excludes `exclusion_status_flag` and `exclusion_url` — P45 owns exclusion
 * risk, with its own review semantics, and a raw flag riding along on the entity
 * record would get read as a determination before that phase exists.
 *
 * DELIBERATELY EXCLUDES `entity_structure`/`state_of_incorporation` — and NOT
 * this SDK's `entity_structure_desc`/`state_of_incorporation_code` either
 * (P19 finding, decision-log D-35). Live-account testing found a genuine SDK-
 * vs-server incompatibility, not a naming typo:
 *
 *   - The `..._code`/`..._desc` names (this SDK's bundled `explicitSchemas.js`
 *     reference) are REJECTED by the live server itself: "Invalid shape...
 *     unknown_field", with the server's own `available_fields` payload
 *     listing bare `entity_structure`/`state_of_incorporation` instead.
 *   - Those bare names, in turn, are REJECTED CLIENT-SIDE: `getEntity` calls
 *     `materializeOne` on every successful response (not just `listEntities`),
 *     and the SDK's bundled `ModelFactory`/`SchemaRegistry` still only knows
 *     the old `..._code`/`..._desc` pair — `ShapeValidationError: Field
 *     "entity_structure" does not exist on model "Entity"`.
 *
 * Neither naming convention round-trips end-to-end (request → typed result)
 * through @makegov/tango-node@1.1.0 — this is the SDK's bundled schema
 * genuinely lagging the live API's current one, not something a field rename
 * on Capiro's side can fix. `TangoEntity.entityStructure`/
 * `.stateOfIncorporation` stay in the domain type (a future SDK release may
 * resolve this) but `mapEntity` returns them as an explicit, commented `null`
 * rather than requesting a field guaranteed to break one side or the other.
 * Escalate to MakeGov before re-adding either name.
 */
export const ENTITY_FIELDS = [
  'uei',
  'cage_code',
  'legal_business_name',
  'dba_name',
  'business_types',
  'sba_business_types',
  'naics_codes',
  'psc_codes',
  'primary_naics',
  'registration_status',
  'sam_expiration_date',
  'physical_address',
  'last_update_date',
] as const;
export const ENTITY_SHAPE = shapeOf(ENTITY_FIELDS);

/**
 * Opportunity. Source: `OPPORTUNITY_SCHEMA`.
 *
 * P27 crosswalks these against the first-party `sam_opportunity` rail, so this is
 * the identifiers it joins on plus the lifecycle fields it compares.
 *
 * NOTE what the provider does NOT have here: there is no `notice_type` and no
 * `posted_date` on an opportunity — the notice TYPE lives on individual notices,
 * and the closest thing to a posting date is `first_notice_date`. Recording that
 * here rather than inventing a mapping is the point of an audited shape.
 */
export const OPPORTUNITY_FIELDS = [
  'opportunity_id',
  'solicitation_number',
  'title',
  'first_notice_date',
  'last_notice_date',
  'response_deadline',
  'active',
  'set_aside',
  'naics_code',
  'psc_code',
  'sam_url',
  'office(agency,code,name)',
] as const;
export const OPPORTUNITY_SHAPE = shapeOf(OPPORTUNITY_FIELDS);

/** Notice — one entry in an opportunity's history. Source: `NOTICE_SCHEMA`. */
export const NOTICE_FIELDS = [
  'notice_id',
  'solicitation_number',
  'title',
  'posted_date',
  'response_deadline',
  'active',
  'set_aside',
  'naics_code',
  'psc_code',
  'attachment_count',
  'sam_url',
  'last_updated',
] as const;
export const NOTICE_SHAPE = shapeOf(NOTICE_FIELDS);

/**
 * Agency procurement forecast. Source: `FORECAST_SCHEMA`.
 *
 * The provider's forecast model is THINNER than the plan assumed, and that is a
 * fact worth pinning rather than papering over. There is no anticipated
 * SOLICITATION date, no PSC, no estimated value and no organization id — only
 * `agency` as free text, an `anticipated_award_date`, and an `estimated_period`
 * string. P24 stores what exists and leaves the rest null; it does not derive a
 * solicitation date from an award date.
 */
export const FORECAST_FIELDS = [
  'id',
  'external_id',
  'title',
  'description',
  'agency',
  'anticipated_award_date',
  'estimated_period',
  'fiscal_year',
  'naics_code',
  'set_aside',
  'contract_vehicle',
  'place_of_performance',
  'primary_contact',
  'status',
  'is_active',
  'source_system',
] as const;
export const FORECAST_SHAPE = shapeOf(FORECAST_FIELDS);

/**
 * Contract vehicle. Source: `VEHICLE_SCHEMA`.
 *
 * There is no plain `name`; a vehicle is identified by `program_acronym` and
 * described by `solicitation_title`. Both are requested because either can be the
 * one a human recognises.
 */
export const VEHICLE_FIELDS = [
  'uuid',
  'program_acronym',
  'solicitation_title',
  'solicitation_identifier',
  'vehicle_type',
  'agency_id',
  'organization_id',
  'naics_code',
  'psc_code',
  'set_aside',
  'who_can_use',
  'award_date',
  'last_date_to_order',
  'idv_count',
  'awardee_count',
  'order_count',
  'total_obligated',
] as const;
export const VEHICLE_SHAPE = shapeOf(VEHICLE_FIELDS);

/**
 * One awardee on a vehicle — an IDV. Source: `IDV_SCHEMA`.
 *
 * `recipient(uei,display_name,legal_business_name)` is the whole point: a
 * vehicle awardee without a UEI can never be evidence of direct access,
 * because matching on a display name is exactly the fuzzy identity P02
 * removed from the award-history rail.
 *
 * DELIBERATELY EXCLUDES a parent/owner UEI (P22 finding, decision-log D-41):
 * the live server's `recipient` expansion on THIS endpoint has exactly five
 * fields — `cage`, `cage_code`, `display_name`, `legal_business_name`,
 * `uei` — confirmed by reading its own `available_fields` error payload.
 * There is no `parent_uei` here, under any name. Parent/owner UEIs DO exist
 * elsewhere in this SDK's data model — `getEntity`'s `immediate_owner`/
 * `highest_owner` expansions (P14's own `tango.shapes.ts` deliberately does
 * not request either) — but reaching them for every awardee found on a
 * vehicle would mean one EXTRA getEntity call per unique awardee UEI, a
 * materially different and more expensive design than "list this vehicle's
 * awardees". P22 does not attempt that; see its own sync script for how the
 * resulting gap is handled (the 'parent' relationship stays a real, tested
 * code path — SDK support may arrive later — but is not currently
 * reachable with live data).
 */
export const VEHICLE_AWARDEE_FIELDS = [
  'uuid',
  'key',
  'piid',
  'title',
  'award_date',
  'order_count',
  'idv_obligations',
  'idv_contracts_value',
  'recipient(uei,display_name,legal_business_name)',
] as const;
export const VEHICLE_AWARDEE_SHAPE = shapeOf(VEHICLE_AWARDEE_FIELDS);

/**
 * Every shape this adapter will ever send, by call family.
 *
 * Exported as one map so a test can assert the set — a new call that invents its
 * own inline shape string bypasses every reason this file exists.
 */
export const TANGO_SHAPES = Object.freeze({
  entity: ENTITY_SHAPE,
  opportunity: OPPORTUNITY_SHAPE,
  notice: NOTICE_SHAPE,
  forecast: FORECAST_SHAPE,
  vehicle: VEHICLE_SHAPE,
  vehicleAwardee: VEHICLE_AWARDEE_SHAPE,
});

export const TANGO_SHAPE_FIELDS = Object.freeze({
  entity: ENTITY_FIELDS,
  opportunity: OPPORTUNITY_FIELDS,
  notice: NOTICE_FIELDS,
  forecast: FORECAST_FIELDS,
  vehicle: VEHICLE_FIELDS,
  vehicleAwardee: VEHICLE_AWARDEE_FIELDS,
});

export type TangoShapeName = keyof typeof TANGO_SHAPES;

/**
 * The TOP-LEVEL key a shape entry selects.
 *
 * `office(agency,code,name)` selects the key `office`. The mapper allow-lists on
 * these, not on the raw selector text, or every nested selection would be dropped
 * as an unrequested field.
 */
export function topLevelKey(field: string): string {
  const paren = field.indexOf('(');
  return paren === -1 ? field : field.slice(0, paren);
}

export function allowedKeys(shapeName: TangoShapeName): string[] {
  return (TANGO_SHAPE_FIELDS[shapeName] as readonly string[]).map(topLevelKey);
}
