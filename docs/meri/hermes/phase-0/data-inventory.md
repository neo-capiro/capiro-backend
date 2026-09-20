# Meri/Hermes Phase 0 — Data Inventory

Generated 2026-09-19T11:29:14.433Z from commit hint `19a1834ac` by `scripts/meri-hermes/generate-data-inventory.mjs`.

> **Heuristic output — owner review required.** Scope, sensitivity, kind and read-path values come from field-name regexes, one/two-hop FK inheritance and case-insensitive whole-word string containment against the Meri tool registry, `meri-tools.service.ts`, `retrieval/adapters/*.ts` (specs excluded) and `global-dataset-registry.ts`. Nothing here is a policy decision; field-level policy annotation is **Phase 2A** work. This document contains schema metadata only — no data values.

## Totals per schema

| Schema owner | Path | Models | Enums | Views |
| --- | --- | --- | --- | --- |
| api | `apps/api/prisma/schema.prisma` | 372 | 13 | 0 |
| api-strategy | `apps/api-strategy/prisma/schema.prisma` | 19 | 17 | 0 |
| api/non-rdte-projection | `apps/api/prisma/non-rdte-projection/schema.prisma` | 12 | 0 | 0 |
| api/outreach-v3-phase2 | `apps/api/prisma/outreach-v3-phase2/schema.prisma` | 4 | 0 | 0 |
| api/outreach-v3-phase3 | `apps/api/prisma/outreach-v3-phase3/schema.prisma` | 2 | 0 | 0 |
| api/outreach-v3-templates | `apps/api/prisma/outreach-v3-templates/schema.prisma` | 5 | 0 | 0 |
| api/phase6-projection | `apps/api/prisma/phase6-projection/schema.prisma` | 3 | 0 | 0 |
| api/rdte-projection | `apps/api/prisma/rdte-projection/schema.prisma` | 3 | 0 | 0 |
| defense-api | `apps/defense-api/prisma/schema.prisma` | 40 | 0 | 0 |
| intel-api | `apps/intel-api/prisma/schema.prisma` | 50 | 5 | 0 |
| onboard-api | `apps/onboard-api/prisma/schema.prisma` | 14 | 11 | 0 |
| workspace | `apps/workspace/prisma/schema.prisma` | 25 | 12 | 0 |

Total: **549 models**, 58 enums, 0 views across 12 schemas.

## Classification counts

| Scope | Models |
| --- | --- |
| tenant | 277 |
| global_reference | 266 |
| user | 2 |
| unknown | 2 |
| client | 1 |
| inherited | 1 |

| Sensitivity | Models |
| --- | --- |
| business | 480 |
| pii_contact | 43 |
| credential | 26 |

| Kind | Models |
| --- | --- |
| canonical | 436 |
| outbox_or_system | 59 |
| projection_duplicate | 54 |

| Existing read path | Models |
| --- | --- |
| none | 451 |
| meri_tool | 67 |
| retrieval_adapter | 48 |
| analytics_registry | 25 |

Read-path caveat: `meri_tool` = model/table name appears in a `MERI_CAPABILITY_REGISTRY` description, or `tx.<model>` / `prisma.<model>` / table name appears in `meri-tools.service.ts`; `retrieval_adapter` = accessor, model or table name appears in a non-spec adapter file; `analytics_registry` = model or table name appears in `global-dataset-registry.ts`. Short names (e.g. `Client`, `Meeting`) over-match; the `sensitivity: credential` regex also matches LLM `*tokens*` counters. Review the per-model evidence in the JSON.

## Coverage gap — canonical business models with no existing read path (340)

Every `kind: canonical` model whose sensitivity is not `credential` and that no Meri tool, retrieval adapter or analytics dataset reads today, largest first.

| Model | Schema | Scope | Sensitivity | Fields |
| --- | --- | --- | --- | --- |
| CaliforniaGrantOpportunity | api | global_reference | pii_contact | 51 |
| GsaRealProperty | api | global_reference | pii_contact | 47 |
| SourceDocument | api | global_reference | business | 46 |
| ClientFundingOpportunity | api | tenant | pii_contact | 44 |
| FederalAssistanceAward | api | global_reference | business | 44 |
| EngagementAttachment | api | tenant | business | 43 |
| MeriActionProposal | api | tenant | business | 43 |
| DefenseBudgetCanonicalDelta | api | global_reference | business | 35 |
| DefenseBudgetCanonicalRow | api | global_reference | business | 35 |
| DefenseBudgetSourceObservation | api | global_reference | business | 35 |
| TangoProcurementForecast | api | unknown | pii_contact | 35 |
| BudgetScopedFactReviewV1 | api | global_reference | business | 34 |
| KnowledgeAssertion | api | tenant | business | 33 |
| EvaluationRecord | api | tenant | business | 32 |
| SavedOpportunitySearch | api | tenant | business | 32 |
| OutreachDraftVersion | api | tenant | business | 30 |
| ProgramElementProjectMilestoneSchedulePeriod | api/rdte-projection | global_reference | business | 30 |
| CompliancePolicyDecision | api | tenant | business | 29 |
| KnowledgeEvent | api | tenant | business | 29 |
| OutreachDelivery | api | tenant | business | 28 |
| TangoBudgetAccount | api | global_reference | business | 28 |
| CompliancePolicyPack | api | tenant | business | 27 |
| LegistormTrip | api | global_reference | business | 27 |
| QualityTelemetryEvent | api | tenant | business | 27 |
| SpChangeSet | api-strategy | tenant | business | 27 |
| WsDraft | workspace | tenant | business | 27 |
| AiRun | api | tenant | business | 26 |
| BudgetExtractionCandidateV1 | api | global_reference | business | 26 |
| DefenseBudgetManualOverride | api | global_reference | business | 26 |
| DistrictNexusChange | api | global_reference | business | 25 |
| FederalFundingAllocation | api | global_reference | business | 25 |
| MeetingPrep | api | tenant | pii_contact | 25 |
| AcquisitionPersonnel | api | global_reference | pii_contact | 24 |
| BudgetVerificationRunV1 | api | global_reference | business | 24 |
| DefenseBudgetExpectedSource | api | global_reference | business | 24 |
| EngagementReportTargetOffice | api | tenant | business | 24 |
| IntelAlert | intel-api | tenant | business | 24 |
| ProgramElementYearSourceValue | api | global_reference | business | 24 |
| AssuranceEvalRun | api | tenant | business | 23 |
| ClientGrantNexus | api | tenant | business | 23 |
| FederalFundingProvision | api | global_reference | business | 23 |
| ProgramElementMilestoneSchedulePeriod | api | global_reference | business | 23 |
| ProgramElementPerformer | api | global_reference | business | 23 |
| TangoDibbsAward | api | global_reference | pii_contact | 23 |
| TangoDibbsSolicitation | api | global_reference | business | 23 |
| CanonicalEntity | api | tenant | business | 22 |
| DefenseBudgetManualOverride | defense-api | global_reference | business | 22 |
| LegiWatchReportSubscription | intel-api | tenant | business | 22 |
| OutreachSendIntent | api | tenant | business | 22 |
| SpAgentRun | api-strategy | tenant | business | 22 |
| WsGenerationRun | workspace | tenant | business | 22 |
| DefenseBudgetPromotionRun | api | global_reference | business | 21 |
| FundingPosition | api | global_reference | business | 21 |
| LegiWatchNotificationEvent | api | tenant | pii_contact | 21 |
| PersonRole | api | global_reference | business | 21 |
| ProcurementBudgetLineYear | api/non-rdte-projection | global_reference | business | 21 |
| ProcurementDetailFact | api/non-rdte-projection | global_reference | business | 21 |
| ProcurementDistributionLine | api/non-rdte-projection | global_reference | business | 21 |
| ProgramElementProjectMilestone | api/rdte-projection | global_reference | business | 21 |
| AssuranceFeedbackCandidate | api | tenant | business | 20 |
| ClientActivity | api | tenant | business | 20 |
| CommitteeSource | api | global_reference | business | 20 |
| DefenseBudgetPromotionAuthorization | api | global_reference | business | 20 |
| DefenseBudgetPromotionPlan | api | global_reference | business | 20 |
| DefenseBudgetWatcherRun | api | global_reference | business | 20 |
| IntelParityRun | intel-api | tenant | business | 20 |
| LegiWatchFolderBill | intel-api | tenant | business | 20 |
| MilconDetailFact | api/non-rdte-projection | global_reference | business | 20 |
| MilconProjectYear | api/non-rdte-projection | global_reference | business | 20 |
| OmDetailFact | api/non-rdte-projection | global_reference | business | 20 |
| OmSagYear | api/non-rdte-projection | global_reference | business | 20 |
| WsHillDayDocument | workspace | tenant | business | 20 |
| ClientIntelMapping | api | tenant | business | 19 |
| EntityResolution | api | tenant | business | 19 |
| LegislativeDistrict | api | global_reference | business | 19 |
| NonRdteBudgetLineSourceObservation | api/non-rdte-projection | global_reference | business | 19 |
| OutreachReasoningTurn | api/outreach-v3-phase3 | tenant | business | 19 |
| ProgramElementDataIssue | api | tenant | business | 19 |
| ReviewRequest | api | tenant | business | 19 |
| BudgetPackageVehicle | api | global_reference | business | 18 |
| CommitteeSiteUpdate | api | global_reference | business | 18 |
| EngagementCampaign | api | tenant | business | 18 |
| FederalAgency | api | global_reference | business | 18 |
| FederalContractor | api | global_reference | business | 18 |
| FederalFundingMeasure | api | global_reference | business | 18 |
| IntelAlertPreference | intel-api | tenant | pii_contact | 18 |
| NonRdteBudgetLineRelationship | api/non-rdte-projection | global_reference | business | 18 |
| OnboardConsent | onboard-api | inherited | pii_contact | 18 |
| ProgramElementYear | api | global_reference | business | 18 |
| TangoSbirTopic | api | global_reference | business | 18 |
| AlertPreference | api | tenant | pii_contact | 17 |
| BudgetVerificationCheckV1 | api | global_reference | business | 17 |
| CommunityFundingRequestSource | api | global_reference | business | 17 |
| DefenseBudgetCycle | api | global_reference | business | 17 |
| DefenseBudgetDiscoveryCrawl | api | global_reference | business | 17 |
| DefenseBudgetPromotionActivation | api | global_reference | pii_contact | 17 |
| DefenseBudgetWatcherAdapter | api | global_reference | business | 17 |
| DefenseProviderInvocation | api | tenant | business | 17 |
| HearingStreamCandidate | api | global_reference | business | 17 |
| ProgramElementDelta | api | global_reference | business | 17 |
| TangoSbirSolicitation | api | global_reference | business | 17 |
| AssuranceEvalFixture | api | tenant | business | 16 |
| BudgetInterimFundingPeriod | api | global_reference | business | 16 |
| ClioAttachment | api | tenant | business | 16 |
| ClioProactiveAlert | api | tenant | business | 16 |
| DefenseBudgetLifecycleSignal | api | global_reference | business | 16 |
| DefenseBudgetScheduleTick | api | global_reference | business | 16 |
| FecPacContribution | api | global_reference | business | 16 |
| HearingAutoRecordRule | api | tenant | pii_contact | 16 |
| HearingSourceObservation | api | global_reference | business | 16 |
| MemoryAccessGrant | api | tenant | business | 16 |
| MilconProject | api/non-rdte-projection | global_reference | business | 16 |
| OpportunityRequirement | api | global_reference | business | 16 |
| PeProgramMatch | api | global_reference | business | 16 |
| ProgramElementPerformer | defense-api | global_reference | business | 16 |
| ProgramOffice | api | global_reference | business | 16 |
| ClientSubmissionHistory | api | tenant | business | 15 |
| ClioMessage | api | tenant | business | 15 |
| ComplianceCheck | api | tenant | business | 15 |
| CompliancePolicyPackEvent | api | tenant | business | 15 |
| DefenseBudgetDiscoveryCandidate | api | global_reference | business | 15 |
| EntityIdentifier | api | tenant | business | 15 |
| FecContribution | api | global_reference | business | 15 |
| GsaRealPropertySourceRun | api | global_reference | business | 15 |
| HearingRecording | intel-api | tenant | business | 15 |
| IntelSmsVerification | intel-api | tenant | pii_contact | 15 |
| LdaContribution | api | global_reference | business | 15 |
| LegiWatchRecordRule | intel-api | tenant | business | 15 |
| OmSag | api/non-rdte-projection | global_reference | business | 15 |
| OutreachAiTemplate | api | tenant | business | 15 |
| OutreachDraftArtifact | api | tenant | business | 15 |
| OutreachEvent | api/outreach-v3-phase2 | tenant | business | 15 |
| ProcurementBudgetLine | api/non-rdte-projection | global_reference | business | 15 |
| ProcurementLine | api | global_reference | business | 15 |
| ProgramElementDataIssue | defense-api | tenant | business | 15 |
| ProgramElementProjectBudgetPosition | api | global_reference | business | 15 |
| ProgramOfficeProgramLink | api | global_reference | business | 15 |
| RegulatoryComment | api | global_reference | business | 15 |
| SpAgentMission | api-strategy | tenant | business | 15 |
| TangoEventAlert | api | tenant | business | 15 |
| TangoOpportunityParity | api | global_reference | business | 15 |
| WsComment | workspace | tenant | business | 15 |
| WsTemplate | workspace | tenant | business | 15 |
| AlertGenerationRecord | api | tenant | business | 14 |
| AssuranceEvalResult | api | tenant | business | 14 |
| BudgetCandidateCorrectionV1 | api | global_reference | business | 14 |
| BudgetVerificationDiscrepancyV1 | api | global_reference | business | 14 |
| ClioMemory | api | tenant | business | 14 |
| CommunityFundingDiscoveryCrawl | api | global_reference | business | 14 |
| CommunityFundingIngestRun | api | global_reference | business | 14 |
| DefenseBudgetPromotionEligibility | api | global_reference | business | 14 |
| DefenseBudgetPromotionItem | api | global_reference | business | 14 |
| EntityAlias | api | tenant | business | 14 |
| HearingPublication | intel-api | tenant | business | 14 |
| KnowledgeEvidence | api | tenant | business | 14 |
| LobbyIntel | api | global_reference | business | 14 |
| OutreachCommandProposal | api/outreach-v3-phase2 | tenant | business | 14 |
| PeProgramMatch | defense-api | global_reference | business | 14 |
| RegulatoryDocket | api | global_reference | business | 14 |
| SpStrategyChatMessage | api-strategy | tenant | business | 14 |
| TangoResourceLink | api | global_reference | business | 14 |
| Watchlist | intel-api | tenant | business | 14 |
| WsHillDayExport | workspace | tenant | business | 14 |
| BudgetAction | api | global_reference | business | 13 |
| BudgetReviewDecisionV1 | api | global_reference | business | 13 |
| ClientProfileEnrichmentCandidate | api | tenant | business | 13 |
| ClioFirmSkill | api | tenant | business | 13 |
| CommitteeReportProvision | api | global_reference | business | 13 |
| CommunityFundingDiscoveryCandidate | api | global_reference | business | 13 |
| EngagementCampaignRecipient | api | tenant | pii_contact | 13 |
| EntityIdentityGovernanceEvent | api | tenant | business | 13 |
| IntelligenceChange | api | global_reference | business | 13 |
| LdaRegistrant | api | global_reference | pii_contact | 13 |
| LegiWatchReportRun | intel-api | tenant | business | 13 |
| OpportunityDocumentText | api | global_reference | business | 13 |
| OutreachAudienceMember | api | tenant | pii_contact | 13 |
| OutreachV3TemplateApplication | api/outreach-v3-templates | tenant | business | 13 |
| ProgramElementSource | defense-api | global_reference | business | 13 |
| SpReferenceOverride | api-strategy | tenant | business | 13 |
| StateBillCalendarEvent | api | global_reference | business | 13 |
| WsAgentProposal | workspace | tenant | business | 13 |
| WsHillDayMeeting | workspace | tenant | business | 13 |
| CanonicalEntityMerge | api | tenant | business | 12 |
| ClientAssociationOverride | api | tenant | business | 12 |
| ClientNotetakerPreference | api | tenant | business | 12 |
| CongressBillCosponsor | api | global_reference | business | 12 |
| DefenseBudgetRollbackRecord | api | global_reference | business | 12 |
| DemoRequest | api | global_reference | pii_contact | 12 |
| HearingMediaPermission | intel-api | tenant | business | 12 |
| IntelFeedback | intel-api | tenant | business | 12 |
| LegislativeCalendarCoverage | api | global_reference | business | 12 |
| LegiWatchDelivery | intel-api | tenant | business | 12 |
| LegiWatchReport | intel-api | tenant | business | 12 |
| OnboardPurchaser | onboard-api | tenant | pii_contact | 12 |
| OutcomeEvent | api | tenant | business | 12 |
| OutreachAudience | api | tenant | business | 12 |
| OutreachTemplate | api | tenant | business | 12 |
| OutreachV3TemplateVersion | api/outreach-v3-templates | tenant | business | 12 |
| ProgramElementYear | defense-api | global_reference | business | 12 |
| ProvisionPeLink | api | global_reference | business | 12 |
| PublicHearingCaptureAttempt | api | global_reference | business | 12 |
| SpNodeArtifact | api-strategy | tenant | business | 12 |
| WatchlistMatch | intel-api | tenant | business | 12 |
| WsApprovalRequest | workspace | tenant | business | 12 |
| WsBlueprintVersion | workspace | tenant | business | 12 |
| WsCollaborator | workspace | tenant | pii_contact | 12 |
| WsIntake | workspace | tenant | business | 12 |
| WsThemeVersion | workspace | tenant | business | 12 |
| XTrackedAccount | api | global_reference | business | 12 |
| AdminBroadcast | api | tenant | business | 11 |
| BudgetAction | defense-api | global_reference | business | 11 |
| CommitteeReportProvision | defense-api | global_reference | business | 11 |
| CommitteeSourceException | api | global_reference | business | 11 |
| EngagementReportTargetOverride | api | tenant | business | 11 |
| FundingOpportunityStageTransition | api | tenant | business | 11 |
| HearingSmsConsent | intel-api | tenant | pii_contact | 11 |
| IntelActionItem | intel-api | tenant | business | 11 |
| LegiWatchImportItem | intel-api | tenant | business | 11 |
| LegiWatchImportRun | intel-api | tenant | business | 11 |
| LegiWatchPromotion | intel-api | tenant | business | 11 |
| LegiWatchReportContact | intel-api | tenant | pii_contact | 11 |
| LegiWatchSourceMapping | intel-api | tenant | business | 11 |
| LegiWatchStagedConfiguration | intel-api | tenant | business | 11 |
| MeriWorkspace | api | tenant | business | 11 |
| OpportunityBookmark | api | tenant | business | 11 |
| ProgramAlias | api | global_reference | business | 11 |
| ProgramElementMilestone | api | global_reference | business | 11 |
| ProgramElementProcurementLine | api | global_reference | business | 11 |
| SpFirmPhase | api-strategy | tenant | business | 11 |
| SpReferenceEntry | api-strategy | global_reference | business | 11 |
| SpVersion | api-strategy | tenant | business | 11 |
| UserIdentityConflict | api | global_reference | pii_contact | 11 |
| WsBlueprint | workspace | tenant | business | 11 |
| AcquisitionPersonnelMergeCandidate | api | global_reference | business | 10 |
| AcquisitionPersonnelSource | api | global_reference | business | 10 |
| BillMatch | intel-api | tenant | business | 10 |
| BudgetVerificationProofV1 | api | global_reference | business | 10 |
| CapabilityBudgetLineMatch | api | global_reference | business | 10 |
| ClientBrief | api | tenant | business | 10 |
| ClientTeamMember | api | tenant | business | 10 |
| DefenseBudgetSideEffectDrainPause | api | global_reference | business | 10 |
| HearingRecordingPart | intel-api | tenant | business | 10 |
| IntelligenceInsight | api | tenant | business | 10 |
| KnowledgeEpisodeAssertion | api | tenant | business | 10 |
| LearningSignalCandidateOutcome | api | tenant | business | 10 |
| MeriVnextPreference | api | tenant | business | 10 |
| OutreachStateVersion | api/outreach-v3-phase2 | tenant | business | 10 |
| Phase6CycleCertification | api/phase6-projection | global_reference | business | 10 |
| ProgramAlias | defense-api | global_reference | business | 10 |
| ProgramElementProject | defense-api | global_reference | business | 10 |
| SmsVerification | api | tenant | pii_contact | 10 |
| StateSyncCursor | api | global_reference | business | 10 |
| TangoApiUsage | api | global_reference | business | 10 |
| WatchlistTerm | intel-api | tenant | business | 10 |
| WatchlistTopic | intel-api | tenant | business | 10 |
| WsAgentMessage | workspace | tenant | business | 10 |
| WsDocument | workspace | tenant | business | 10 |
| WsEditLock | workspace | tenant | business | 10 |
| AdminBroadcastRecipient | api | tenant | business | 9 |
| AlertState | api | tenant | business | 9 |
| BudgetPackage | api | global_reference | business | 9 |
| ClientMemoryAccess | api | tenant | business | 9 |
| ConferenceProbability | api | global_reference | business | 9 |
| DefenseBudgetReviewResolution | api | tenant | business | 9 |
| FecPacSyncState | api | global_reference | business | 9 |
| KnowledgeEpisodeEvent | api | tenant | business | 9 |
| LdaLobbyist | api | global_reference | business | 9 |
| LegislativeCalendarTransition | api | global_reference | business | 9 |
| LegiWatchDigestRun | api | tenant | business | 9 |
| LegiWatchRecordMatch | intel-api | tenant | business | 9 |
| LegiWatchReportList | intel-api | tenant | business | 9 |
| LobbyIssueRef | api | global_reference | business | 9 |
| MemberVote | api | global_reference | business | 9 |
| MeriActionApproval | api | tenant | business | 9 |
| MeriPendingAction | api | tenant | business | 9 |
| MeriSavedPrompt | api | tenant | business | 9 |
| OnboardLegalDoc | onboard-api | global_reference | business | 9 |
| OnboardSetupTask | onboard-api | tenant | business | 9 |
| OpportunityRequirementReview | api | tenant | business | 9 |
| ProgramElementBudgetPosition | defense-api | global_reference | business | 9 |
| ProgramElementDelta | defense-api | global_reference | business | 9 |
| ProgramElementMilestone | defense-api | global_reference | business | 9 |
| ProgramElementProcurementLine | defense-api | global_reference | business | 9 |
| QualityTelemetryMemoryItemUse | api | tenant | business | 9 |
| StateBillVersion | api | global_reference | business | 9 |
| WsBrandAsset | workspace | tenant | business | 9 |
| WsDocVersion | workspace | tenant | business | 9 |
| WsGuestComment | workspace | tenant | business | 9 |
| WsTheme | workspace | tenant | business | 9 |
| XFeedSubscription | api | tenant | business | 9 |
| ClientWatchlist | api | tenant | business | 8 |
| ConferenceProbability | defense-api | global_reference | business | 8 |
| DirectoryContactFavorite | api | tenant | business | 8 |
| IntelWatchlistRevision | intel-api | tenant | business | 8 |
| KnowledgeEpisodeEntity | api | tenant | business | 8 |
| LegiWatchDigestSchedule | api | tenant | pii_contact | 8 |
| LegiWatchFolderRevision | intel-api | tenant | business | 8 |
| MemberPressItem | api | global_reference | business | 8 |
| PeAlertEmailPref | api | tenant | business | 8 |
| ProgramElementAcquisitionProgram | api | global_reference | business | 8 |
| ProgramElementWatch | api | tenant | business | 8 |
| ProvisionPeLink | defense-api | global_reference | business | 8 |
| BillBudgetLineLink | defense-api | global_reference | business | 7 |
| BlsDataPoint | api | global_reference | business | 7 |
| BudgetLineRelationship | defense-api | global_reference | business | 7 |
| CapabilityBudgetLineMatch | defense-api | global_reference | business | 7 |
| ClerkEvent | api | global_reference | business | 7 |
| FederalIndustry | api | global_reference | business | 7 |
| LegislativeObservationRevision | api | global_reference | business | 7 |
| LobbyTrendingTopic | api | global_reference | business | 7 |
| ProgramElementProjectBudgetPosition | defense-api | global_reference | business | 7 |
| SamOpportunityMatch | defense-api | global_reference | business | 7 |
| SourceDocument | defense-api | global_reference | business | 7 |
| SpAgentPermissionPolicy | api-strategy | tenant | business | 7 |
| SpWatchDismissal | api-strategy | tenant | business | 7 |
| StripeEvent | onboard-api | global_reference | business | 7 |
| TenantUsageMeter | api | tenant | business | 7 |
| TrackerFeedback | api | tenant | business | 7 |
| WsContextItem | workspace | tenant | business | 7 |
| BudgetPackageVehicle | defense-api | global_reference | business | 6 |
| CommitteeMembershipWatch | api | global_reference | business | 6 |
| CongressBillCommittee | api | global_reference | business | 6 |
| DefenseBudgetCycleManifestRegistry | api | global_reference | business | 6 |
| DefenseBudgetDiscoveryHostBudget | api | global_reference | business | 6 |
| LdaIssueCode | api | global_reference | business | 6 |
| LegiWatchCommitteeEmailPreference | api | tenant | pii_contact | 6 |
| OnboardBillingEvent | onboard-api | tenant | business | 6 |
| PeAlertEmailPref | defense-api | tenant | business | 6 |
| TenantUsageMeter | onboard-api | tenant | business | 6 |
| AcquisitionPersonnelQuarantine | api | global_reference | business | 5 |
| CommitteeHearingBill | api | global_reference | business | 5 |
| LegiWatchRuleBillBaseline | intel-api | tenant | business | 5 |
| ProgramElementQuarantine | api | global_reference | business | 5 |
| ProgramElementWatch | defense-api | tenant | business | 5 |
| BudgetPackage | defense-api | global_reference | business | 4 |
| CongressBillCommittee | defense-api | global_reference | business | 4 |
| CongressBillSubject | api | global_reference | business | 4 |
| LdaGovernmentEntity | api | global_reference | business | 4 |
| ProgramOfficeProgramLink | defense-api | global_reference | business | 4 |
| PersonRole | defense-api | global_reference | business | 3 |

## Inherited-scope models (1)

No `tenantId`; scope is inherited through the FK path shown (one hop, or two where needed).

| Model | Schema | Inheritance path |
| --- | --- | --- |
| OnboardConsent | onboard-api | OnboardConsent.session -> OnboardSession (tenant: field tenantId) |

## Unknown-scope models — unclassified gaps (2)

These need an owner decision before they can be exposed.

| Model | Schema | Kind | Why unknown |
| --- | --- | --- | --- |
| TangoProcurementForecast | api | canonical | non-standard scope-like field organizationId; needs owner review |
| XPostCache | api | outbox_or_system | non-standard scope-like field accountId; needs owner review |

## Credential / secret models — exclude from generic reads (26)

| Model | Schema | Kind | Matching fields |
| --- | --- | --- | --- |
| Tenant | api | canonical | engagementConnectionTokens |
| IntegrationConnection | api | canonical | token |
| IntegrationConnectionToken | api | canonical | accessTokenCiphertext, accessTokenIv, accessTokenAuthTag, refreshTokenCiphertext, refreshTokenIv, refreshTokenAuthTag |
| MeetingNote | api | canonical | bodyCiphertext |
| MeetingPrepJob | api | outbox_or_system | leaseToken |
| MeetingDebrief | api | canonical | bodyCiphertext |
| ClioConversation | api | canonical | summaryTokens |
| ClioMcpServer | api | canonical | authTokenCiphertext, authTokenIv, authTokenAuthTag |
| ClioMcpOAuthCredential | api | projection_duplicate | clientSecretCiphertext, clientSecretIv, clientSecretAuthTag, accessTokenCiphertext, accessTokenIv, accessTokenAuthTag, refreshTokenCiphertext, refreshTokenIv, refreshTokenAuthTag, tokenType, tokenExpiresAt, codeVerifierCiphertext, stateNonce |
| AiUsageEvent | api | canonical | inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens |
| ContextPacket | api | canonical | totalTokenBudget, usedTokens |
| TenantAiCredential | api | canonical | keyCiphertext |
| PublicHearingCapture | api | canonical | fencingToken |
| BudgetReextractionOperationV1 | api | canonical | leaseToken |
| LegiWatchReportOccurrence | intel-api | canonical | leaseToken |
| LegiWatchDeliveryRecipient | intel-api | canonical | leaseToken |
| IntelNotificationLog | intel-api | outbox_or_system | leaseToken |
| IntelAlertDigestQueue | intel-api | outbox_or_system | leaseToken |
| HearingRecordingEpoch | intel-api | canonical | captureToken, assemblyToken |
| TranscriptSegment | intel-api | canonical | textCiphertext, analysisToken |
| KeyQuote | intel-api | canonical | textCiphertext |
| LiveActionItem | intel-api | canonical | textCiphertext |
| EntityMention | intel-api | canonical | textCiphertext |
| LiveSummaryCard | intel-api | canonical | titleCiphertext, bodyCiphertext |
| OnboardItInvite | onboard-api | canonical | tokenHash |
| WsShareLink | workspace | canonical | tokenHash |

## Decryption required — service-mediated reads only (11)

| Model | Schema | Encrypted fields |
| --- | --- | --- |
| IntegrationConnectionToken | api | accessTokenCiphertext, accessTokenIv, refreshTokenCiphertext, refreshTokenIv |
| MeetingNote | api | bodyCiphertext, iv |
| MeetingDebrief | api | bodyCiphertext, iv |
| ClioMcpServer | api | authTokenCiphertext, authTokenIv |
| ClioMcpOAuthCredential | api | clientSecretCiphertext, clientSecretIv, accessTokenCiphertext, accessTokenIv, refreshTokenCiphertext, refreshTokenIv, codeVerifierCiphertext, codeVerifierIv, stateNonce |
| TenantAiCredential | api | keyCiphertext, keyIv |
| TranscriptSegment | intel-api | textCiphertext, iv |
| KeyQuote | intel-api | textCiphertext, iv |
| LiveActionItem | intel-api | textCiphertext, iv |
| EntityMention | intel-api | textCiphertext, iv |
| LiveSummaryCard | intel-api | titleCiphertext, titleIv, bodyCiphertext, bodyIv |

## Projection / duplicate signals (57)

| Model | Schema | Kind | Canonical candidate | Signal |
| --- | --- | --- | --- | --- |
| StripeEvent | api | projection_duplicate | — | doc comment mentions "mirrors" |
| ClioScheduledTask | api | projection_duplicate | ClioMemory | doc comment mentions "mirrors" |
| ClioMcpOAuthCredential | api | projection_duplicate | ClioMcpServer | doc comment mentions "mirrors" |
| ClientTarget | api | projection_duplicate | ClientFacility | doc comment mentions "mirrors" |
| ClientTargetRecommendation | api | projection_duplicate | ActionRecommendation | doc comment mentions "mirrors" |
| ClientCapabilityFitRecommendation | api | projection_duplicate | — | doc comment mentions "projection" |
| ActionRecommendation | api | projection_duplicate | ClientFacility | doc comment mentions "mirrors" |
| EntityCrosswalk | api | projection_duplicate | — | doc comment mentions "NON-canonical" |
| ProgramElementSource | api | projection_duplicate | AcquisitionPersonnelSource | doc comment mentions "Mirrors" |
| ProgramElementProject | api | projection_duplicate | ProgramElementSource | doc comment mentions "Mirrors" |
| ProcurementLineYear | api | projection_duplicate | ProgramElementYearSourceValue | doc comment mentions "duplicate" |
| ProcurementLineSource | api | projection_duplicate | ProgramElementSource | doc comment mentions "Mirrors" |
| ProgramElementBudgetPosition | api | projection_duplicate | ProgramElementSource | doc comment mentions "projection" |
| ProgramElementIngestRun | api | projection_duplicate | — | doc comment mentions "mirrors" |
| CommunityFundingRequest | api | projection_duplicate | CommunityFundingRequestSource | doc comment mentions "projection" |
| ProgramElementPersonCandidate | api | projection_duplicate | AcquisitionPersonnelMergeCandidate | doc comment mentions "Mirrors" |
| StateBillPublishedRecord | api | projection_duplicate | CongressBillAction | doc comment mentions "mirrors" |
| StateBillSponsor | api | projection_duplicate | CongressBillCosponsor | doc comment mentions "mirrors" |
| StateRollCallVote | api | projection_duplicate | RollCallVote | doc comment mentions "mirrors" |
| StateMemberVote | api | projection_duplicate | MemberVote | doc comment mentions "mirrors" |
| StateBillLink | api | projection_duplicate | BillRuleLink | doc comment mentions "mirrors" |
| StateRule | api | projection_duplicate | FederalRegisterDocument | doc comment mentions "mirrors" |
| PublicHearingTranscriptSegment | api | projection_duplicate | TranscriptSegment | doc comment mentions "duplicated" |
| LegiWatchCommitteeFollow | api | projection_duplicate | — | doc comment mentions "duplicated" |
| LegiWatchSavedItem | api | projection_duplicate | — | doc comment mentions "copy of" |
| TenantHearingRelevance | api | projection_duplicate | PublicHearingInsight | doc comment mentions "Derived from" |
| ClientRelevantVehicle | api | projection_duplicate | — | doc comment mentions "MATERIALIZED" |
| TangoBudgetVendorFlow | api | projection_duplicate | — | doc comment mentions "copy of" |
| TangoProcurementProtest | api | projection_duplicate | — | doc comment mentions "derived from" |
| TangoEntityExclusion | api | projection_duplicate | — | doc comment mentions "copy of" |
| TangoOpportunityNotice | api | projection_duplicate | — | doc comment mentions "DERIVED from" |
| OpportunityAttachment | api | projection_duplicate | — | doc comment mentions "copy of" |
| SamOpportunityMatch | api | projection_duplicate | PeProgramMatch | doc comment mentions "Mirrors" |
| MemoryItem | api | projection_duplicate | — | doc comment mentions "Projected" |
| MemoryEdge | api | projection_duplicate | — | doc comment mentions "derived from" |
| MemoryCandidate | api | projection_duplicate | — | doc comment mentions "projection" |
| MemoryIngestRun | api | projection_duplicate | — | doc comment mentions "projected" |
| LearningSignal | api | projection_duplicate | Evidence | doc comment mentions "duplicated" |
| Evidence | api | projection_duplicate | Claim | doc comment mentions "denormalized" |
| BudgetLineRelationship | api | projection_duplicate | PeProgramMatch | doc comment mentions "mirrors" |
| BillBudgetLineLink | api | projection_duplicate | ProvisionPeLink | doc comment mentions "Mirrors" |
| AssuranceEvalDomainGate | api | projection_duplicate | AssuranceEvalResult | doc comment mentions "derived from" |
| KnowledgeEpisode | api | projection_duplicate | KnowledgeAssertion | doc comment mentions "materialized" |
| DefenseBudgetSourceBundleMember | api | projection_duplicate | DefenseBudgetExpectedSource | doc comment mentions "derived from" |
| SpContextFact | api-strategy | projection_duplicate | SpNode | doc comment mentions "denormalized" |
| OutreachSession | api/outreach-v3-phase2 | outbox_or_system | OutreachRecord | name/table matches /Session/ |
| OutreachReasoningConversation | api/outreach-v3-phase3 | projection_duplicate | — | doc comment mentions "projection" |
| OutreachV3Template | api/outreach-v3-templates | projection_duplicate | — | doc comment mentions "Projection" |
| Phase6CycleCertificationProjection | api/phase6-projection | outbox_or_system | Phase6CycleCertification | name/table matches /Projection/ |
| ProgramElementProjectBudgetPosition | api/rdte-projection | projection_duplicate | — | doc comment mentions "projection" |
| DefenseBudgetActiveSnapshot | defense-api | outbox_or_system | Program | name/table matches /Snapshot/ |
| FederalAward | defense-api | projection_duplicate | — | doc comment mentions "projection" |
| LegiWatchFolder | intel-api | projection_duplicate | — | doc comment mentions "mirrored" |
| IntelWsTicket | intel-api | projection_duplicate | IntelSmsVerification | doc comment mentions "Mirrors" |
| IntelAlertWorkState | intel-api | projection_duplicate | — | doc comment mentions "duplicate" |
| Client | onboard-api | projection_duplicate | — | doc comment mentions "mirrored" |
| WsNotification | workspace | projection_duplicate | — | doc comment mentions "denormalized" |

## Parser: constructs not parsed (0)

None — every block in every schema was parsed as a model, view, enum, generator or datasource.

## How to regenerate

```
node scripts/meri-hermes/generate-data-inventory.mjs
```

Add `--write-baseline` to refresh `data-inventory.baseline.json`, or `--check` (writes nothing, exits non-zero) to fail when any model has `unknown` scope or when a canonical business model with no read path is new relative to the baseline — the prototype migration coverage check.

