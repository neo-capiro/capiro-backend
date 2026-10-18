/** Version-one application source witness reader. Mirrored in Core's receiving
 * adapter, fixture-tested for equality; deliberately no new shared/Meri contract. */
export interface ObjectiveSourceTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
export interface LocalObjectiveSources {
  government_profile_support: Record<string, unknown>[];
  government_targets: Record<string, any>[];
  represented_facilities: Record<string, any>[];
  target_recommendations: Record<string, any>[];
  member_notes: Record<string, any>[];
  state_directory: Record<string, any>[];
  mailbox_authority: Record<string, any>[];
}
/** SHARE blocks INSERT/UPDATE/DELETE relation locks, including source-set
 * phantoms. Fixed relation order; fail closed after 1s rather than wait on a
 * long writer. Never call around context compilation, external reads or models. */
export async function lockObjectiveSources(tx: ObjectiveSourceTx): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
  await tx.$executeRaw`LOCK TABLE client_facilities, client_target_recommendations, client_targets,
    directory_contact_notes, engagement_connections, state_legislator IN SHARE MODE`;
}
export async function readObjectiveSources(
  tx: ObjectiveSourceTx,
  tenantId: string,
  clientId: string,
  contactIds: string[],
  clerkUserId: string,
): Promise<LocalObjectiveSources> {
  const rows = await tx.$queryRaw<Array<{ sources: LocalObjectiveSources }>>`
    SELECT jsonb_build_object(
      'mailbox_authority', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'provider',i.provider,
        'owner',i.created_by_user_id,'status',to_jsonb(i)->'status') ORDER BY i.id)
        FROM engagement_connections i JOIN users u ON u.id=i.created_by_user_id
        WHERE i.tenant_id=${tenantId}::uuid AND u.clerk_user_id=${clerkUserId}
          AND i.provider IN ('microsoft_365','google_workspace','imap_caldav')),'[]'::jsonb),
      'government_profile_support', (SELECT jsonb_agg(p.value) FROM (
        SELECT jsonb_object_agg(k, COALESCE(to_jsonb(c)->k, c.intake_data_jsonb->CASE k
          WHEN 'funding_priorities' THEN 'fundingPriorities' WHEN 'sb_classification' THEN 'sbClassification'
          WHEN 'sam_status' THEN 'samStatus' WHEN 'sam_expiration_date' THEN 'samExpirationDate'
          WHEN 'lda_registrant_name' THEN 'ldaRegistrantName' ELSE k END)) AS value FROM clients c,
          unnest(ARRAY['id','description','product_description','sector_tag','sectors','funding_priorities',
            'submission_tracks','issue_codes','uei','cage_code','naics_codes','psc_codes','applicant_types',
            'set_aside_certifications','sb_classification','sam_status','sam_expiration_date','lda_registrant_name','ein']) k
        WHERE c.tenant_id=${tenantId}::uuid AND c.id=${clientId}::uuid GROUP BY c.id) p),
      'government_targets', COALESCE((SELECT jsonb_agg((SELECT jsonb_object_agg(k,to_jsonb(t)->k)
        FROM unnest(ARRAY['id','client_id','member_id','member_name','source_directory','party','state','chamber','committee','staff_kind','tier','source','added_at']) k) ORDER BY t.id)
        FROM client_targets t WHERE t.tenant_id=${tenantId}::uuid AND t.client_id=${clientId}::uuid),'[]'::jsonb),
      'represented_facilities', COALESCE((SELECT jsonb_agg((SELECT jsonb_object_agg(k,to_jsonb(f)->k)
        FROM unnest(ARRAY['id','name','address_line','city','state','zip','employee_count','congressional_district','congressional_district_congress',
          'state_house_district','state_senate_district','district_source','geocoded_at','geocode_status','updated_at']) k) ORDER BY f.id)
        FROM client_facilities f WHERE f.tenant_id=${tenantId}::uuid AND f.client_id=${clientId}::uuid),'[]'::jsonb),
      'target_recommendations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'computed_at',r.computed_at,
        'recommendations_jsonb',r.recommendations_jsonb) ORDER BY r.id)
        FROM client_target_recommendations r WHERE r.tenant_id=${tenantId}::uuid AND r.client_id=${clientId}::uuid),'[]'::jsonb),
      'member_notes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',n.id,'directory_contact_id',n.directory_contact_id,
        'body',n.body,'updated_at',n.updated_at,'scope','tenant_shared') ORDER BY n.id)
        FROM directory_contact_notes n WHERE n.tenant_id=${tenantId}::uuid AND n.directory_contact_id=ANY(${contactIds}::text[])),'[]'::jsonb),
      'state_directory', COALESCE((SELECT jsonb_agg((SELECT jsonb_object_agg(k,to_jsonb(s)->k)
        FROM unnest(ARRAY['id','name','state','chamber','district','party','email','url','source_evidence','committees','active','synced_at']) k) ORDER BY s.id) FROM state_legislator s
        WHERE s.id IN (SELECT member_id FROM client_targets WHERE tenant_id=${tenantId}::uuid
          AND client_id=${clientId}::uuid AND source_directory='state')),'[]'::jsonb)
    ) AS sources`;
  if (!rows[0]?.sources) throw new Error('Objective source snapshot unavailable');
  return rows[0].sources;
}
