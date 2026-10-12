# Frozen local dispatch map

Source: `6a4b48e6286a270ab18c033eb4ccaf6f72f42c70`, `apps/api/src/meri/meri-tools.service.ts`. 134 literal cases; exact arguments and bodies are in dispatch-map.json.

| Tool | Case line | Terminal delegation (verbatim expression) | Side effect |
| --- | ---: | --- | --- |
| manage_research_portfolio | 2585 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| get_research_portfolio | 2586 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | readOnly |
| get_research_portfolio_analytics | 2587 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | readOnly |
| get_research_portfolio_changes | 2588 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | readOnly |
| create_research_portfolio_snapshot | 2589 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| request_research_portfolio_output | 2590 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| save_research_portfolio_output_to_client | 2591 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| watch_research_portfolio | 2592 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| update_research_portfolio_change_state | 2593 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| get_research_portfolio_bookmarks | 2594 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | readOnly |
| create_research_portfolio_bookmark | 2595 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| get_research_portfolio_fit | 2596 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | readOnly |
| get_research_portfolio_reviews | 2597 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | readOnly |
| add_research_portfolio_review_note | 2598 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| get_research_portfolio_rules | 2599 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | readOnly |
| get_research_portfolio_imports | 2600 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | readOnly |
| get_research_portfolio_operations | 2601 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | readOnly |
| prepare_research_portfolio_brief | 2602 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| prepare_research_portfolio_meeting | 2603 | `return executeMeriResearchPortfolioToolAtCurrentUse({ prisma: this.prisma, scopeService: this.researchPortfolioScope, ctx, name, input, execute: () => this.requireResearchPortfolioTools().execute(ctx, name, input), });` | write / side effect |
| search_legiwatch_news | 2612 | `return this.legiwatchTool(ctx, name, input);` | readOnly |
| get_florida_budget_project | 2613 | `return this.legiwatchTool(ctx, name, input);` | readOnly |
| compare_florida_budget_amounts | 2614 | `return this.legiwatchTool(ctx, name, input);` | readOnly |
| prepare_legiwatch_briefing | 2615 | `return this.legiwatchTool(ctx, name, input);` | write / side effect |
| get_legiwatch_review | 2616 | `return this.legiwatchTool(ctx, name, input);` | readOnly |
| search_legislative_research | 2617 | `return this.legiwatchTool(ctx, name, input);` | readOnly |
| get_legal_reference | 2618 | `return this.legiwatchTool(ctx, name, input);` | readOnly |
| compare_legislative_versions | 2619 | `return this.legiwatchTool(ctx, name, input);` | readOnly |
| save_legislative_research | 2620 | `return this.legiwatchTool(ctx, name, input);` | write / side effect |
| preview_legiwatch_relevance | 2621 | `return this.legiwatchTool(ctx, name, input);` | readOnly |
| save_legiwatch_relevance | 2622 | `return this.legiwatchTool(ctx, name, input);` | write / side effect |
| apply_legiwatch_suggestion | 2623 | `return this.legiwatchTool(ctx, name, input);` | write / side effect |
| get_research_evidence | 2625 | `return getResearchEvidence(ctx, input, this.prisma);` | readOnly |
| read_chat_attachments | 2627 | `return this.readChatAttachments(ctx, input);` | readOnly |
| read_monday_client_boards | 2629 | `return this.readMondayClientBoards(ctx, input);` | readOnly |
| search_capiro_data | 2631 | `return searchCapiroData(ctx, input, this.contextPlane);` | readOnly |
| get_client_context | 2633 | `return this.getClientContext(ctx, input);` | readOnly |
| search_research_sources | 2635 | `return this.searchResearchSources(ctx, input);` | readOnly |
| search_client_knowledge | 2637 | `return this.searchClientKnowledge(ctx, input);` | readOnly |
| run_analysis | 2639 | `return this.runAnalysis(ctx, input);` | readOnly |
| query_intelligence | 2641 | `return this.queryIntelligence(input);` | readOnly |
| query_knowledge_graph | 2643 | `return this.queryKnowledgeGraph(ctx, input);` | readOnly |
| find_path_to | 2645 | `return this.findPathTo(ctx, input);` | readOnly |
| search_memory | 2647 | `return this.searchMemory(ctx, input);` | readOnly |
| list_memory_proposals | 2649 | `return readOwnPendingMemoryProposals(ctx, input, this.governedMemoryCandidates);` | readOnly |
| search_congress_bills | 2651 | `return this.searchCongressBills(input);` | readOnly |
| get_bill_status | 2653 | `return this.getBillStatus(input);` | readOnly |
| read_bill_text | 2655 | `return this.readBillText(input);` | readOnly |
| get_certification_status | 2657 | `return this.getCertificationStatus(input);` | readOnly |
| search_floor_votes | 2659 | `return this.searchFloorVotes(input);` | readOnly |
| search_cbo_cost_estimates | 2661 | `return this.searchCboCostEstimates(input);` | readOnly |
| resolve_entity | 2663 | `return this.resolveEntity(input);` | readOnly |
| search_lda_filings | 2665 | `return this.searchLdaFilings(input);` | readOnly |
| list_global_datasets | 2667 | `return this.listGlobalDatasets();` | readOnly |
| query_global_data | 2669 | `return this.queryGlobalData(ctx, input);` | readOnly |
| search_sec_filings | 2671 | `return this.searchSecFilings(input);` | readOnly |
| search_fara_registrations | 2673 | `return this.searchFaraRegistrations(input);` | readOnly |
| search_federal_grants | 2675 | `return this.searchFederalGrants(ctx, input);` | readOnly |
| search_federal_awards | 2677 | `return this.searchFederalAwards(ctx, input);` | readOnly |
| search_gao_reports | 2679 | `return this.searchGaoReports(input);` | readOnly |
| search_state_bills | 2681 | `return this.searchStateBills(input);` | readOnly |
| get_state_bill_status | 2683 | `return this.getStateBillStatus(input);` | readOnly |
| search_state_floor_votes | 2685 | `return this.searchStateFloorVotes(input);` | readOnly |
| get_state_legislator | 2687 | `return this.getStateLegislator(input);` | readOnly |
| get_committee_roster | 2689 | `return this.getCommitteeRoster(input);` | readOnly |
| get_representation | 2691 | `return this.getRepresentation(ctx, input);` | readOnly |
| list_members | 2693 | `return this.listMembers(input);` | readOnly |
| get_state_rule_status | 2695 | `return this.getStateRuleStatus(input);` | readOnly |
| search_intel_articles | 2697 | `return this.searchIntelArticles(input);` | readOnly |
| search_committee_hearings | 2699 | `return this.searchCommitteeHearings(ctx, input);` | readOnly |
| search_crs_reports | 2701 | `return this.searchCrsReports(input);` | readOnly |
| query_economic_data | 2703 | `return this.queryEconomicData(input);` | readOnly |
| get_district_nexus_context | 2705 | `return ( this.districtTools?.getContext(ctx, input) ?? { available: false, reason: 'feature_disabled', } );` | readOnly |
| get_district_nexus_changes | 2712 | `return ( this.districtTools?.getChanges(ctx, input) ?? { available: false, reason: 'feature_disabled', } );` | readOnly |
| search_public_web | 2719 | `return this.searchPublicWeb(input);` | readOnly |
| scrape_web_page | 2721 | `return this.scrapeWebPage(input);` | readOnly |
| create_meeting_brief | 2723 | `return this.createMeetingBrief(ctx, input);` | write / side effect |
| draft_policy_memo | 2725 | `return this.draftPolicyMemo(ctx, input);` | write / side effect |
| save_note | 2727 | `return this.saveNote(ctx, input);` | write / side effect |
| save_chat_attachments | 2729 | `return this.saveChatAttachments(ctx, input);` | write / side effect |
| send_email | 2731 | `return this.sendEmail(ctx, input, execution?.actionProposalId);` | write / side effect |
| list_emails | 2733 | `return this.listEmails(ctx, input);` | readOnly |
| search_emails | 2735 | `return this.searchEmails(ctx, input);` | readOnly |
| get_email_thread | 2737 | `return this.getEmailThread(ctx, input);` | readOnly |
| list_upcoming_meetings | 2739 | `return this.listUpcomingMeetings(ctx, input);` | readOnly |
| reply_email | 2741 | `return this.replyEmail(ctx, input);` | write / side effect |
| save_memory | 2743 | `return this.saveMemory(ctx, input);` | write / side effect |
| confirm_memory | 2745 | `return this.confirmMemoryTool(input);` | write / side effect |
| correct_memory | 2747 | `return this.correctMemoryTool(input);` | write / side effect |
| forget_memory | 2749 | `return this.forgetMemoryTool(input);` | write / side effect |
| search_program_elements | 2751 | `return this.searchProgramElements(ctx, input);` | readOnly |
| get_program_element | 2753 | `return this.getProgramElementDetail(ctx, input);` | readOnly |
| get_pe_budget_timeline | 2755 | `return this.getPeBudgetTimeline(input, ctx);` | readOnly |
| get_pe_buyer_workspace | 2757 | `return this.getPeBuyerWorkspace(input);` | readOnly |
| get_pe_contractors | 2759 | `return this.getPeContractors(input);` | readOnly |
| get_pe_bills | 2761 | `return this.getPeBills(input);` | readOnly |
| get_pe_report_language | 2763 | `return this.getPeReportLanguage(input);` | readOnly |
| search_acquisition_personnel | 2765 | `return this.searchAcquisitionPersonnel(ctx, input);` | readOnly |
| get_acquisition_person | 2767 | `return this.getAcquisitionPerson(ctx, input);` | readOnly |
| find_contacts | 2769 | `return this.findContacts(ctx, input);` | readOnly |
| create_word | 2771 | `return this.createDocument(ctx, input, input.format === 'txt' ? 'txt' : input.format === 'pdf' ? 'pdf' : 'docx', execution?.actionProposalId);` | write / side effect |
| create_excel | 2776 | `return this.createDocument(ctx, input, 'xlsx');` | write / side effect |
| create_powerpoint | 2778 | `return this.createDocument(ctx, input, 'pptx');` | write / side effect |
| schedule_task | 2780 | `return this.scheduleTask(ctx, input, execution?.actionProposalId);` | write / side effect |
| list_scheduled_tasks | 2782 | `return this.listScheduledTasks(ctx);` | readOnly |
| cancel_scheduled_task | 2784 | `return this.cancelScheduledTask(ctx, input);` | write / side effect |
| update_scheduled_task | 2786 | `return this.updateScheduledTask(ctx, input);` | write / side effect |
| query_tasks | 2788 | `return this.queryTasks(ctx, input);` | readOnly |
| query_action_items | 2790 | `return this.queryActionItems(ctx, input);` | readOnly |
| search_tracked_bills | 2792 | `return this.searchTrackedBills(ctx, input);` | readOnly |
| query_regulatory_dockets | 2794 | `return this.queryRegulatoryDockets(input);` | readOnly |
| search_sam_opportunities | 2796 | `return this.searchSamOpportunities(ctx, input);` | readOnly |
| query_debriefs | 2798 | `return this.queryDebriefs(ctx, input);` | readOnly |
| read_client_meetings | 2800 | `return this.readClientMeetings(ctx, input);` | readOnly |
| read_client_documents | 2802 | `return this.readClientDocuments(ctx, input);` | readOnly |
| query_outreach | 2804 | `return this.queryOutreach(ctx, input);` | readOnly |
| lookup_client_registry | 2806 | `return this.lookupClientRegistry(ctx, input);` | readOnly |
| create_client | 2808 | `return this.createClient(ctx, input);` | write / side effect |
| create_task | 2810 | `return this.createEngagementTask(ctx, input);` | write / side effect |
| update_task | 2812 | `return this.updateEngagementTask(ctx, input);` | write / side effect |
| update_client_profile | 2814 | `return this.updateClientProfile(ctx, input);` | write / side effect |
| search_funding_opportunities | 2821 | `return this.opportunityTools.searchFundingOpportunities(toolActor(ctx), { clientId: String(input.clientId ?? ''), source: input.source as string \| undefined, query: input.query as string \| undefined, page: input.page as number \| undefined, pageSize: input.pageSize as number \| undefined, activeState: input.activeState as string \| undefined, });` | readOnly |
| get_funding_opportunity_requirements | 2830 | `return this.opportunityTools.getFundingOpportunityRequirements(toolActor(ctx), { clientId: String(input.clientId ?? ''), source: String(input.source ?? ''), sourceRecordId: String(input.sourceRecordId ?? ''), offset: input.offset as number \| undefined, limit: input.limit as number \| undefined, });` | readOnly |
| get_funding_opportunity | 2838 | `return this.opportunityTools.getFundingOpportunity(toolActor(ctx), { clientId: String(input.clientId ?? ''), source: String(input.source ?? ''), sourceRecordId: String(input.sourceRecordId ?? ''), summaryOffset: input.summaryOffset as number \| undefined, summaryLimit: input.summaryLimit as number \| undefined, });` | readOnly |
| explain_opportunity_match | 2846 | `return this.opportunityTools.explainOpportunityMatch(toolActor(ctx), { clientId: String(input.clientId ?? ''), source: String(input.source ?? ''), sourceRecordId: String(input.sourceRecordId ?? ''), });` | readOnly |
| get_opportunity_client_context | 2852 | `return this.opportunityTools.getOpportunityClientContext(toolActor(ctx), { clientId: String(input.clientId ?? ''), });` | readOnly |
| get_opportunity_government_landscape | 2856 | `return this.opportunityTools.getOpportunityGovernmentLandscape(toolActor(ctx), { clientId: String(input.clientId ?? ''), source: String(input.source ?? ''), sourceRecordId: String(input.sourceRecordId ?? ''), });` | readOnly |
| compare_funding_opportunities | 2862 | `return this.opportunityTools.compareFundingOpportunities(toolActor(ctx), { clientId: String(input.clientId ?? ''), opportunities: Array.isArray(input.opportunities) ? (input.opportunities as Array<Record<string, unknown>>).map((o) => ({ source: String(o?.source ?? ''), sourceRecordId: String(o?.sourceRecordId ?? ''), })) : [], });` | readOnly |
| build_opportunity_action_plan | 2872 | `return this.opportunityTools.buildOpportunityActionPlan(toolActor(ctx), { clientId: String(input.clientId ?? ''), source: String(input.source ?? ''), sourceRecordId: String(input.sourceRecordId ?? ''), });` | readOnly |
| get_business_development_context | 2884 | `return this.requireBizDevTools().getContext(ctx, input);` | readOnly |
| get_business_development_evidence | 2886 | `return this.requireBizDevTools().getEvidence(ctx, input);` | readOnly |
| get_business_development_recent_changes | 2888 | `return this.requireBizDevTools().getRecentChanges(ctx, input);` | readOnly |
| get_business_development_brief | 2890 | `return this.requireBizDevTools().getBrief(ctx, input);` | readOnly |
| resolve_business_development_source | 2892 | `return this.requireBizDevTools().resolveSource(ctx, input);` | readOnly |
| save_business_development_brief | 2894 | `return this.requireBizDevTools().saveBrief(ctx, input);` | write / side effect |
