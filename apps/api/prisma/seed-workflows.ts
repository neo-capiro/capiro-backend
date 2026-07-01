import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── Shared contact sections ──────────────────────────────────────────────────

const requesterContactSection = {
  title: 'Your Contact Information',
  helpText: 'Pre-populated from your organization settings. Update in Settings if needed.',
  fields: [
    { key: 'requester_name', label: 'Name', type: 'text', required: true, source: 'tenant_settings' },
    { key: 'requester_phone', label: 'Phone', type: 'text', required: true, source: 'tenant_settings' },
    { key: 'requester_email', label: 'Email', type: 'text', required: true, source: 'tenant_settings' },
    { key: 'requester_mailing_street1', label: 'Mailing Address - Street 1', type: 'text', source: 'tenant_settings' },
    { key: 'requester_mailing_street2', label: 'Mailing Address - Street 2', type: 'text', source: 'tenant_settings' },
    { key: 'requester_mailing_city', label: 'City', type: 'text', source: 'tenant_settings' },
    { key: 'requester_mailing_state_zip', label: 'State/Zip', type: 'text', source: 'tenant_settings' },
    { key: 'requester_permanent_street1', label: 'Permanent Address - Street 1', type: 'text', source: 'tenant_settings' },
    { key: 'requester_permanent_street2', label: 'Permanent Address - Street 2', type: 'text', source: 'tenant_settings' },
    { key: 'requester_permanent_city', label: 'City', type: 'text', source: 'tenant_settings' },
    { key: 'requester_permanent_state_zip', label: 'State/Zip', type: 'text', source: 'tenant_settings' },
  ],
};

const orgContactBaseFields = [
  { key: 'org_name', label: 'Name of the Organization/Entity', type: 'text', maxLength: 100, required: true, source: 'client' },
  { key: 'org_head_name', label: 'Name of Head of the Organization/Entity', type: 'text', maxLength: 100, required: true },
  { key: 'org_head_title', label: 'Title of Head of the Organization/Entity', type: 'text', maxLength: 100, required: true },
  { key: 'org_address1', label: 'Address Line 1', type: 'text', maxLength: 100, source: 'client' },
  { key: 'org_address2', label: 'Address Line 2', type: 'text', maxLength: 100, source: 'client' },
  { key: 'org_city', label: 'City', type: 'text', maxLength: 100, source: 'client' },
  {
    key: 'org_state',
    label: 'State/Territories/Armed Forces',
    type: 'select',
    options: ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR', 'VI', 'GU', 'AS', 'MP', 'AA', 'AE', 'AP'],
    source: 'client',
  },
  { key: 'org_zip', label: 'ZIP Code', type: 'text', helpText: '##### or #####-####', source: 'client' },
  { key: 'org_phone', label: 'Phone Number', type: 'text', helpText: '###-###-####', source: 'client' },
  { key: 'poc_name', label: 'Primary POC - Name', type: 'text', maxLength: 100, required: true, source: 'client' },
  { key: 'poc_title', label: 'Primary POC - Title', type: 'text', maxLength: 100 },
  { key: 'poc_phone', label: 'Primary POC - Phone', type: 'text', helpText: '###-###-####', source: 'client' },
  { key: 'poc_email', label: 'Primary POC - Email', type: 'text', helpText: 'i.e. your-email@mail.com', source: 'client' },
];

const orgContactDefense = {
  title: 'Organization/Entity Contact Information',
  helpText: 'Select a client to pre-populate.',
  fields: [
    ...orgContactBaseFields,
    { key: 'dod_contact', label: 'Department of Defense Contact for Request', type: 'text', maxLength: 100 },
  ],
};

const orgContactGeneral = {
  title: 'Organization/Entity Contact Information',
  helpText: 'Select a client to pre-populate.',
  fields: [
    ...orgContactBaseFields,
    { key: 'agency_contact', label: 'Agency Contact for Request', type: 'text', maxLength: 100 },
  ],
};

const sharedDefense = { requesterContact: requesterContactSection, orgContact: orgContactDefense };
const sharedGeneral = { requesterContact: requesterContactSection, orgContact: orgContactGeneral };

// ── Reusable field sets ──────────────────────────────────────────────────────

const standardProgrammaticFields = [
  { key: 'title_of_request', label: 'Title of Request', type: 'text', maxLength: 100, required: true },
  { key: 'account_name', label: 'Appropriations Account Name', type: 'text', maxLength: 100, required: true },
  { key: 'program', label: 'Program Name', type: 'text', maxLength: 100, required: true },
  { key: 'pe_budget_line', label: 'Program Element / Budget Line', type: 'text', maxLength: 100, required: true, helpText: 'Please provide the most specific information you can.' },
  { key: 'requested_amount', label: 'FY27 Requested Funding Amount', type: 'integer', required: true, helpText: 'Specific dollar amount. No decimals or symbols.' },
  { key: 'pbr_amount', label: "President's FY27 Budget Request Amount", type: 'integer', required: true, helpText: "If PBR not yet released, enter 35." },
  { key: 'prior_year_enacted', label: 'FY26 Enacted Amount', type: 'integer', required: true, helpText: 'No decimals or symbols.' },
  { key: 'justification', label: 'Justification', type: 'textarea', required: true },
  { key: 'proposed_language', label: 'Proposed Report or Bill Language', type: 'textarea', required: false, helpText: 'If applicable, provide proposed report or bill language to accompany the request.' },
  { key: 'proposed_language_type', label: 'Language Type', type: 'select', required: false, options: ['Report', 'Bill'], helpText: 'Indicate if the provided language is for a report or bill.' },
  { key: 'num_requests', label: 'How many requests is your organization submitting?', type: 'integer', required: true },
  { key: 'priority_rank', label: 'Priority Rank of This Request', type: 'integer', required: true, helpText: 'If only one request, enter 1.' },
  { key: 'state_connection', label: "Does this request have a connection to the Member's state/district?", type: 'boolean', required: true },
  { key: 'state_connection_detail', label: 'Describe the state/district connection', type: 'textarea', required: false, conditional: { field: 'state_connection', value: true } },
  { key: 'submitted_other_offices', label: 'Have you submitted this request to other offices?', type: 'boolean', required: true },
  { key: 'other_offices_detail', label: 'Which other offices?', type: 'textarea', required: false, conditional: { field: 'submitted_other_offices', value: true } },
];

const standardCpfFields = [
  { key: 'project_name', label: 'Project Name', type: 'text', maxLength: 100, required: true },
  { key: 'project_description', label: 'Project Description', type: 'textarea', required: true },
  { key: 'recipient_entity_name', label: 'Recipient Entity Name', type: 'text', maxLength: 100, required: true },
  { key: 'recipient_type', label: 'Recipient Type', type: 'select', required: true, options: ['Non-Profit Organization', 'State/Local Government', 'Educational Institution', 'Other'] },
  { key: 'project_location', label: 'Project Location (Address)', type: 'text', maxLength: 200, required: true },
  { key: 'requested_amount', label: 'CPF Requested Amount', type: 'integer', required: true, helpText: 'Specific dollar amount. No decimals or symbols.' },
  { key: 'account', label: 'Appropriations Account', type: 'text', maxLength: 100, required: true },
  { key: 'federal_nexus', label: 'Federal Nexus Statement', type: 'textarea', required: true, helpText: 'Describe how the project connects to federal programs and policies.' },
  { key: 'community_support', label: 'Community Support Description', type: 'textarea', required: true, helpText: 'Describe community support for this project.' },
  { key: 'member_financial_disclosure', label: 'I certify the Member has no financial interest in this project', type: 'boolean', required: true },
];

const hacSubcommittees = [
  'Agriculture, Rural Development, FDA',
  'Commerce, Justice, Science',
  'Defense',
  'Energy and Water Development',
  'Financial Services and General Government',
  'Homeland Security',
  'Interior, Environment',
  'Labor, HHS, Education',
  'Legislative Branch',
  'Military Construction, Veterans Affairs',
  'National Security, State Department',
  'Transportation, HUD',
];

// ── Template definitions ─────────────────────────────────────────────────────

const templates = [
  // ── Authorization ──────────────────────────────────────────────────────────
  {
    slug: 'ndaa-authorization-request',
    name: 'NDAA Authorization Request',
    description:
      'A written request to a Member of Congress asking them to submit a program authorization increase to HASC or SASC for inclusion in the NDAA markup. Also called a program plus-up. Almost always submitted alongside an Appropriations Request.',
    category: 'authorization',
    sortOrder: 1,
    requiredSections: {
      requestTypes: ['funding', 'policy'],
      sections: {
        funding: {
          section1: {
            title: 'Funding Request',
            fields: [
              { key: 'title_of_request', label: 'Title of Request', type: 'text', maxLength: 100, required: true },
              { key: 'appropriations_account', label: 'Appropriations Account', type: 'text', maxLength: 100, required: true },
              { key: 'subcommittee', label: 'Subcommittee', type: 'select', required: true, options: ['Airland', 'Cybersecurity', 'Emerging Threats and Capabilities', 'Personnel', 'Readiness and Management Support', 'Seapower', 'Strategic Forces'] },
              { key: 'program', label: 'Program', type: 'text', maxLength: 100, required: true },
              { key: 'program_element', label: 'Program Element (PE)', type: 'text', maxLength: 100, required: true, helpText: 'Please provide the most specific information you can.' },
              { key: 'line_number', label: 'Line Number', type: 'text', maxLength: 100, required: true },
              { key: 'requested_funding_amount', label: 'Your FY2026 Requested Funding Amount', type: 'integer', required: true, helpText: 'Please provide a specific dollar amount. No decimals or symbols.' },
              { key: 'president_budget_amount', label: "President's FY2026 Budget Requested Funding Amount", type: 'integer', required: true, helpText: "If the President's Budget is not yet released, please type 35. An email will be sent later allowing you to update." },
              { key: 'enacted_funding_amount', label: 'FY2025 Enacted Appropriations Bill Funding Amount', type: 'integer', required: true, helpText: 'No decimals or symbols.' },
              { key: 'justification', label: 'Brief explanation justifying the request', type: 'textarea', required: true },
              { key: 'num_funding_requests', label: 'How many funding requests is your organization submitting?', type: 'integer', required: true },
              { key: 'priority_rank', label: 'Priority Rank of Proposal', type: 'integer', required: true, helpText: 'If only one proposal is being submitted, please enter 1.' },
              { key: 'connection_to_massachusetts', label: 'Does this request have a connection to Massachusetts?', type: 'boolean', required: true },
              { key: 'massachusetts_connection_detail', label: 'What is the connection to Massachusetts?', type: 'textarea', required: false, conditional: { field: 'connection_to_massachusetts', value: true } },
              { key: 'submitted_other_offices', label: 'Have you submitted this request to other offices?', type: 'boolean', required: true },
              { key: 'other_offices_detail', label: 'If yes, please list which other offices.', type: 'textarea', required: false, conditional: { field: 'submitted_other_offices', value: true } },
            ],
          },
        },
        policy: {
          section1: {
            title: 'Bill/Report Language Request',
            fields: [
              { key: 'title_of_request', label: 'Title of Request', type: 'text', maxLength: 100, required: true },
              { key: 'language_purpose', label: 'What is the purpose of the language request?', type: 'select', required: true, options: ['Bill Language', 'Report Language', 'Bill and Report Language'] },
              { key: 'subcommittee', label: 'Subcommittee', type: 'select', required: true, options: ['Airland', 'Cybersecurity', 'Emerging Threats and Capabilities', 'Personnel', 'Readiness and Management Support', 'Seapower', 'Strategic Forces'] },
              { key: 'program', label: 'Program', type: 'text', maxLength: 100, required: true },
              { key: 'program_element', label: 'Program Element (PE)', type: 'text', maxLength: 100, required: true },
              { key: 'line_number', label: 'Line Number', type: 'text', maxLength: 100, required: true },
              { key: 'proposed_bill_language', label: 'Proposed Bill Language', type: 'textarea', required: false },
              { key: 'proposed_report_language', label: 'Proposed Report Language', type: 'textarea', required: false, helpText: 'For examples of report language, please see FY25 NDAA Senate Report 118-188.' },
              { key: 'justification', label: 'Brief explanation justifying the request', type: 'textarea', required: true },
              { key: 'num_language_requests', label: 'How many language requests is your organization submitting?', type: 'integer', required: true },
              { key: 'priority_rank', label: 'Priority Rank of Proposal', type: 'integer', required: true, helpText: 'If only one proposal is being submitted, please enter 1.' },
              { key: 'connection_to_massachusetts', label: 'Does this request have a connection to Massachusetts?', type: 'boolean', required: true },
              { key: 'massachusetts_connection_detail', label: 'What is the connection to Massachusetts?', type: 'textarea', required: false, conditional: { field: 'connection_to_massachusetts', value: true } },
              { key: 'submitted_other_offices', label: 'Have you submitted this request to other offices?', type: 'boolean', required: true },
              { key: 'other_offices_detail', label: 'If yes, please list which other offices.', type: 'textarea', required: false, conditional: { field: 'submitted_other_offices', value: true } },
            ],
          },
        },
        shared: sharedDefense,
      },
    },
    contextInfo: {
      overview:
        "An NDAA Authorization Request is a formal written request submitted to a Member of Congress asking them to sponsor a program authorization increase in the National Defense Authorization Act. The request asks the member to include a specific dollar amount above the President's Budget Request (PBR) for a given defense program in their markup of the NDAA, either through the House Armed Services Committee (HASC) or Senate Armed Services Committee (SASC).",
      timing:
        "The submission window typically opens in January after the release of the President's Budget Request (first Monday in February). House deadlines are typically late February to mid-March; Senate deadlines are typically in March. Some offices accept requests as early as the third week of January. Timing varies significantly by office, always confirm with the specific member's staff.",
      submission:
        "Requests are submitted to the member's personal office, specifically to the defense Legislative Assistant (LA) or military LA. Do NOT submit directly to HASC or SASC staff. Common submission methods include office portals, email PDF, and in-person delivery. Most offices require a 1-2 page white paper format, though specific format requirements vary by office.",
      why: "The NDAA is the primary legislative vehicle for establishing new defense program authority and increasing authorized funding ceilings above the President's Budget Request. Authorization alone does not provide funding, it sets the ceiling. A successful NDAA authorization request is often a prerequisite for a subsequent appropriations request.",
      companion: 'Almost always submitted alongside Template 2.1 (Appropriations Request)',
    },
  },

  // ── Appropriations ─────────────────────────────────────────────────────────
  {
    slug: 'hac-defense-programmatic',
    name: 'HAC Defense Programmatic Request',
    description:
      'Programmatic funding request to the House Appropriations Defense Subcommittee. Companion to NDAA authorization requests. Covers DoD, Army, Navy, Air Force, Space Force.',
    category: 'appropriations',
    sortOrder: 11,
    requiredSections: {
      requestTypes: ['programmatic'],
      sections: {
        funding: {
          section1: {
            title: 'Defense Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        shared: sharedDefense,
      },
    },
    contextInfo: {
      overview:
        'A programmatic appropriations request to the House Appropriations Defense Subcommittee asks the Member to advocate for increased funding for a DoD program in the annual defense appropriations bill. Defense does NOT accept CPF/earmark requests, all requests must be programmatic.',
      timing: 'Programmatic deadline: approximately March 20. Confirm exact date with the Member\'s appropriations LA.',
      submission: "Submit to the member's personal office (appropriations LA or defense LA), not directly to the Defense Subcommittee. Typically submitted via member portal or email PDF.",
      contact_email: 'DE.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-agriculture-programmatic',
    name: 'HAC Agriculture Programmatic/CPF Request',
    description:
      'Programmatic or Community Project Funding request to the Agriculture, Rural Development, FDA Subcommittee. Covers USDA, FDA, farm programs, rural development.',
    category: 'appropriations',
    sortOrder: 12,
    requiredSections: {
      requestTypes: ['programmatic', 'cpf'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        policy: {
          section1: {
            title: 'Community Project Funding (CPF) Request',
            fields: standardCpfFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        'Requests to the Agriculture, Rural Development, FDA Subcommittee cover USDA programs, FDA, farm programs, rural development, and food safety initiatives. CPF (earmark) requests are accepted for eligible projects including rural water/sewer, food banks, agricultural research, and rural broadband.',
      timing: 'Programmatic deadline: approximately March 13. CPF deadline: approximately March 19. CPF public posting: approximately April 3.',
      submission: "Submit to the member's personal office (appropriations LA). Use the \"Funding Request\" tab for programmatic requests and \"Policy / Bill Language\" tab for CPF requests.",
      contact_email: 'AG.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-cjs-programmatic',
    name: 'HAC Commerce, Justice, Science Request',
    description:
      'Request to the Commerce, Justice, Science Subcommittee. Covers DOJ, NASA, NSF, NOAA, NIST, Census Bureau.',
    category: 'appropriations',
    sortOrder: 13,
    requiredSections: {
      requestTypes: ['programmatic', 'cpf'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        policy: {
          section1: {
            title: 'Community Project Funding (CPF) Request',
            fields: standardCpfFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        'Requests to the CJS Subcommittee cover DOJ grant programs (COPS, Byrne JAG, VAWA), NASA missions and centers, NSF directorates, NOAA, NIST laboratories, and the Census Bureau. CPF requests are accepted for law enforcement technology, drug courts, violence prevention, STEM facilities, and weather monitoring equipment.',
      timing: 'Programmatic deadline: approximately March 13. CPF deadline: approximately March 19. CPF public posting: approximately March 27.',
      submission: "Submit to the member's personal office (appropriations LA). Use the \"Funding Request\" tab for programmatic requests and \"Policy / Bill Language\" tab for CPF requests.",
      contact_email: 'CJS.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-energy-water-programmatic',
    name: 'HAC Energy & Water Request',
    description:
      'Request to the Energy and Water Development Subcommittee. Covers DOE, Army Corps of Engineers, NRC, Bureau of Reclamation.',
    category: 'appropriations',
    sortOrder: 14,
    requiredSections: {
      requestTypes: ['programmatic', 'cpf'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        policy: {
          section1: {
            title: 'Community Project Funding (CPF) Request',
            fields: standardCpfFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "Requests to the Energy and Water Subcommittee cover DOE program offices (NNSA, ARPA-E, EERE, Office of Science), Army Corps of Engineers civil works projects, Bureau of Reclamation, and the Nuclear Regulatory Commission. CPF requests are accepted for Army Corps flood control/navigation projects, water infrastructure, energy efficiency, and hydropower modernization.",
      timing: 'Programmatic deadline: approximately March 20. CPF deadline: approximately March 20. CPF public posting: approximately April 17.',
      submission: "Submit to the member's personal office (appropriations LA). Use the \"Funding Request\" tab for programmatic requests and \"Policy / Bill Language\" tab for CPF requests.",
      contact_email: 'EW.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-fsgg-programmatic',
    name: 'HAC Financial Services Request',
    description:
      'Programmatic request to the Financial Services and General Government Subcommittee. Covers Treasury, IRS, SBA, GSA, Judiciary. No CPF.',
    category: 'appropriations',
    sortOrder: 15,
    requiredSections: {
      requestTypes: ['programmatic'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        'Requests to the Financial Services and General Government Subcommittee cover Treasury, IRS, SBA (7(a) loans, SBIR/STTR, SBDCs), GSA building projects, SEC, FTC, the Judiciary, and the Executive Office of the President. This subcommittee does NOT accept CPF/earmark requests.',
      timing: 'Programmatic deadline: approximately March 13.',
      submission: "Submit to the member's personal office (appropriations LA). No CPF requests accepted for this subcommittee.",
      contact_email: 'FS.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-homeland-programmatic',
    name: 'HAC Homeland Security Request',
    description:
      'Request to the Homeland Security Subcommittee. Covers DHS, CBP, ICE, TSA, FEMA, Coast Guard, CISA.',
    category: 'appropriations',
    sortOrder: 16,
    requiredSections: {
      requestTypes: ['programmatic', 'cpf'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        policy: {
          section1: {
            title: 'Community Project Funding (CPF) Request',
            fields: standardCpfFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        'Requests to the Homeland Security Subcommittee cover DHS components (CBP, ICE, TSA, USCIS, FEMA), Coast Guard, Secret Service, and CISA. CPF requests are accepted for emergency communications equipment, fire station construction, port security, flood mitigation, and local government cybersecurity infrastructure.',
      timing: 'Programmatic deadline: approximately March 20. CPF deadline: approximately March 20. CPF public posting: approximately April 17.',
      submission: "Submit to the member's personal office (appropriations LA). Use the \"Funding Request\" tab for programmatic requests and \"Policy / Bill Language\" tab for CPF requests.",
      contact_email: 'HS.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-interior-programmatic',
    name: 'HAC Interior & Environment Request',
    description:
      'Request to the Interior, Environment Subcommittee. Covers DOI, EPA, Forest Service, Smithsonian, Indian Health Service.',
    category: 'appropriations',
    sortOrder: 17,
    requiredSections: {
      requestTypes: ['programmatic', 'cpf'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        policy: {
          section1: {
            title: 'Community Project Funding (CPF) Request',
            fields: standardCpfFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "Requests to the Interior, Environment Subcommittee cover DOI bureaus (NPS, BLM, FWS, BIA, USGS), EPA, Forest Service, Smithsonian Institution, and Indian Health Service. CPF requests are accepted for land conservation, water quality improvement, tribal infrastructure, National Park improvements, Superfund cleanup, and wildfire prevention.",
      timing: 'Programmatic deadline: approximately March 20. CPF deadline: approximately March 20. CPF public posting: approximately April 17.',
      submission: "Submit to the member's personal office (appropriations LA). Use the \"Funding Request\" tab for programmatic requests and \"Policy / Bill Language\" tab for CPF requests.",
      contact_email: 'IN.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-labor-hhs-programmatic',
    name: 'HAC Labor, HHS, Education Request',
    description:
      'Request to the Labor, HHS, Education Subcommittee. Covers DOL, HHS, NIH, CDC, Department of Education.',
    category: 'appropriations',
    sortOrder: 18,
    requiredSections: {
      requestTypes: ['programmatic', 'cpf'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        policy: {
          section1: {
            title: 'Community Project Funding (CPF) Request',
            fields: standardCpfFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "Requests to the Labor, HHS, Education Subcommittee cover DOL workforce programs (WIOA, Job Corps), HHS (NIH, CDC, HRSA, SAMHSA, ACF, CMS), and the Department of Education formula and competitive grant programs. CPF requests are accepted for community health centers, mental health and substance abuse facilities, workforce training, early childhood education, and biomedical research equipment.",
      timing: 'Programmatic deadline: approximately March 27. CPF deadline: approximately March 27. CPF public posting: approximately April 17.',
      submission: "Submit to the member's personal office (appropriations LA). Use the \"Funding Request\" tab for programmatic requests and \"Policy / Bill Language\" tab for CPF requests.",
      contact_email: 'LH.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-legbranch-programmatic',
    name: 'HAC Legislative Branch Request',
    description:
      'Programmatic request to the Legislative Branch Subcommittee. Covers Congress, CBO, GAO, GPO, Library of Congress. No CPF.',
    category: 'appropriations',
    sortOrder: 19,
    requiredSections: {
      requestTypes: ['programmatic'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "Requests to the Legislative Branch Subcommittee cover Congress, CBO, GAO, GPO, Library of Congress, Capitol Police, and the Architect of the Capitol. This subcommittee handles internal congressional operations. Lobbyist clients rarely have requests here, typically only relevant for library/archive programs or congressional research services. No CPF requests accepted.",
      timing: 'Programmatic deadline: approximately March 13.',
      submission: "Submit to the member's personal office (appropriations LA). No CPF requests accepted for this subcommittee.",
      contact_email: 'LB.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-milcon-va-programmatic',
    name: 'HAC MilCon/VA Request',
    description:
      'Request to the Military Construction, Veterans Affairs Subcommittee. Covers military construction, VA healthcare/benefits.',
    category: 'appropriations',
    sortOrder: 20,
    requiredSections: {
      requestTypes: ['programmatic', 'cpf'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        policy: {
          section1: {
            title: 'Community Project Funding (CPF) Request',
            fields: standardCpfFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "Requests to the MilCon/VA Subcommittee cover military construction projects, VA healthcare/benefits/cemeteries, Arlington National Cemetery, and the Armed Forces Retirement Home. Defense handles military operations and procurement; MilCon handles facilities and VA. A defense contractor may need requests to BOTH subcommittees. CPF requests are accepted for veterans service facilities, veteran housing, VA clinic improvements, and military family support centers.",
      timing: 'Programmatic deadline: approximately March 13. CPF deadline: approximately March 13. CPF public posting: approximately March 27.',
      submission: "Submit to the member's personal office (appropriations LA). Use the \"Funding Request\" tab for programmatic requests and \"Policy / Bill Language\" tab for CPF requests.",
      contact_email: 'MC.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-natsec-state-programmatic',
    name: 'HAC National Security/State Request',
    description:
      'Programmatic request to the National Security, State Department Subcommittee. Covers State Dept, USAID, foreign operations. No CPF.',
    category: 'appropriations',
    sortOrder: 21,
    requiredSections: {
      requestTypes: ['programmatic'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "Requests to the National Security, State Department Subcommittee cover the State Department, USAID, Peace Corps, Millennium Challenge Corporation, and international organizations (UN, World Bank, IMF contributions). Foreign assistance accounts include ESF, FMF, INCLE, and NADR. No CPF requests accepted.",
      timing: 'Programmatic deadline: approximately March 13.',
      submission: "Submit to the member's personal office (appropriations LA). No CPF requests accepted for this subcommittee.",
      contact_email: 'NSRP.MemberRequests@mail.house.gov',
    },
  },
  {
    slug: 'hac-thud-programmatic',
    name: 'HAC Transportation/HUD Request',
    description:
      'Request to the Transportation, HUD Subcommittee. Covers DOT, FAA, FTA, FRA, HUD. CPF available for airport, highway, rail, transit, port, and HUD projects.',
    category: 'appropriations',
    sortOrder: 22,
    requiredSections: {
      requestTypes: ['programmatic', 'cpf'],
      sections: {
        funding: {
          section1: {
            title: 'Programmatic Request',
            fields: standardProgrammaticFields,
          },
        },
        policy: {
          section1: {
            title: 'Community Project Funding (CPF) Request',
            fields: [
              ...standardCpfFields,
              {
                key: 'cpf_program',
                label: 'CPF Program',
                type: 'select',
                required: true,
                options: [
                  'Airport Improvement Program',
                  'Highway Infrastructure Projects',
                  'CRISI (Rail)',
                  'Transit Infrastructure Grants',
                  'Port Infrastructure Development',
                  'HUD Economic Development Initiatives',
                ],
                helpText: 'Select the THUD program account under which this CPF request falls.',
              },
            ],
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "Requests to the Transportation, HUD Subcommittee cover DOT agencies (FAA, FHWA, FTA, FRA, MARAD), HUD, and the NTSB. CPF requests are available for six specific program accounts: Airport Improvement Program, Highway Infrastructure Projects, CRISI (Rail), Transit Infrastructure Grants, Port Infrastructure Development, and HUD Economic Development Initiatives.",
      timing: 'Programmatic deadline: approximately March 27. CPF deadline: approximately March 27. CPF public posting: approximately April 17.',
      submission: "Submit to the member's personal office (appropriations LA). Use the \"Funding Request\" tab for programmatic requests and \"Policy / Bill Language\" tab for CPF requests. For CPF, you must select the applicable program account.",
      contact_email: 'TH.MemberRequests@mail.house.gov',
    },
  },

  // ── Language ───────────────────────────────────────────────────────────────
  {
    slug: 'hac-language-request',
    name: 'HAC Bill/Report Language Request',
    description:
      'Request to include specific bill or report language in an appropriations bill. Does not direct funding to a particular entity but encourages, urges, or directs agency action.',
    category: 'language',
    sortOrder: 31,
    requiredSections: {
      requestTypes: ['bill_language', 'report_language', 'both'],
      sections: {
        funding: {
          section1: {
            title: 'Bill/Report Language Request',
            fields: [
              { key: 'title_of_request', label: 'Title of Request', type: 'text', maxLength: 100, required: true },
              { key: 'language_purpose', label: 'Purpose of Language Request', type: 'select', required: true, options: ['Bill Language', 'Report Language', 'Both'] },
              { key: 'subcommittee', label: 'Subcommittee', type: 'select', required: true, options: hacSubcommittees },
              { key: 'program', label: 'Program', type: 'text', maxLength: 100, required: true },
              { key: 'proposed_bill_language', label: 'Proposed Bill Language', type: 'textarea', required: false, helpText: 'Provide exact statutory text if applicable.' },
              { key: 'proposed_report_language', label: 'Proposed Report Language', type: 'textarea', required: false, helpText: 'Report language directs or urges agency action without having the force of law.' },
              { key: 'justification', label: 'Justification', type: 'textarea', required: true },
              { key: 'num_requests', label: 'How many language requests is your organization submitting?', type: 'integer', required: true },
              { key: 'priority_rank', label: 'Priority Rank of This Request', type: 'integer', required: true, helpText: 'If only one request, enter 1.' },
              { key: 'state_connection', label: "Does this request have a connection to the Member's state/district?", type: 'boolean', required: true },
              { key: 'state_connection_detail', label: 'Describe the state/district connection', type: 'textarea', required: false, conditional: { field: 'state_connection', value: true } },
              { key: 'submitted_other_offices', label: 'Have you submitted this request to other offices?', type: 'boolean', required: true },
              { key: 'other_offices_detail', label: 'Which other offices?', type: 'textarea', required: false, conditional: { field: 'submitted_other_offices', value: true } },
            ],
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "A language request asks a Member of Congress to include specific bill or report language in an appropriations measure. Unlike earmarks, language requests do not direct funding to a named recipient, they instruct, encourage, or urge an agency to take a specific action, prioritize a program, or provide reporting on a topic.",
      timing: 'Deadlines vary by subcommittee, generally mid-March through late March. Confirm with the Member\'s appropriations LA.',
      submission: "Submit to the member's personal office (appropriations LA). Language requests are less formal than programmatic requests but require clear proposed text.",
      contact_email: 'Submit to the relevant subcommittee office via member portal or email.',
    },
  },

  // ── Supporting Documents ───────────────────────────────────────────────────
  {
    slug: 'program-white-paper',
    name: 'Program White Paper / One-Pager',
    description:
      '1-2 page white paper accompanying any programmatic or authorization request. Required by most congressional offices.',
    category: 'supporting',
    sortOrder: 41,
    requiredSections: {
      requestTypes: ['white_paper'],
      sections: {
        funding: {
          section1: {
            title: 'Program White Paper',
            fields: [
              { key: 'program_name', label: 'Program Name', type: 'text', maxLength: 100, required: true },
              { key: 'managing_agency', label: 'Managing Agency', type: 'text', maxLength: 100, required: true },
              { key: 'problem_statement', label: 'Problem Statement', type: 'textarea', required: true, helpText: 'What capability gap or unmet need does this program address?' },
              { key: 'solution_description', label: 'Solution Description', type: 'textarea', required: true, helpText: 'What does the program do, and how does it address the problem?' },
              { key: 'current_status', label: 'Current Status and Milestones', type: 'textarea', required: true, helpText: 'What has been accomplished to date? Key milestones achieved.' },
              { key: 'fy_minus2_enacted', label: 'FY25 Enacted Amount', type: 'integer', required: false, helpText: 'Dollar amount, no symbols.' },
              { key: 'fy_minus1_enacted', label: 'FY26 Enacted Amount', type: 'integer', required: false, helpText: 'Dollar amount, no symbols.' },
              { key: 'fy_current_pbr', label: "FY27 President's Budget Request", type: 'integer', required: false, helpText: 'Dollar amount, no symbols.' },
              { key: 'fy_requested', label: 'FY27 Requested Amount', type: 'integer', required: true, helpText: 'Dollar amount, no symbols.' },
              { key: 'economic_impact', label: 'Economic / Workforce Impact', type: 'textarea', required: false, helpText: 'Describe job creation, states/districts supported, small business participation (% of contract value).' },
              { key: 'key_performance_metrics', label: 'Key Performance Metrics', type: 'textarea', required: false, helpText: 'Measurable outcomes that demonstrate program effectiveness.' },
            ],
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "A program white paper (or one-pager) is a 1-2 page document submitted alongside authorization and appropriations requests. Most congressional offices require this format and will not act on a request without supporting documentation.",
      timing: 'Submit with the primary request. No separate deadline, must accompany the main submission.',
      submission: 'Delivered as a PDF attachment alongside the primary appropriations or authorization request.',
      contact_email: 'N/A, submitted with primary request to member office.',
    },
  },
  {
    slug: 'meeting-request-letter',
    name: 'Meeting Request Letter',
    description:
      'Formal letter requesting a meeting with a Member of Congress or staffer to discuss a program or submission.',
    category: 'supporting',
    sortOrder: 42,
    requiredSections: {
      requestTypes: ['meeting_request'],
      sections: {
        funding: {
          section1: {
            title: 'Meeting Request Details',
            fields: [
              { key: 'recipient_member_name', label: 'Recipient, Member Name', type: 'text', maxLength: 100, required: true, helpText: 'e.g. The Honorable Jane Smith' },
              { key: 'recipient_title', label: 'Recipient, Title', type: 'text', maxLength: 100, required: true, helpText: 'e.g. United States Senator, U.S. Representative' },
              { key: 'purpose_of_meeting', label: 'Purpose of Meeting', type: 'textarea', required: true, helpText: '1-2 sentences describing what you would like to discuss.' },
              { key: 'specific_request_reference', label: 'Request Reference', type: 'text', maxLength: 200, required: false, helpText: 'Reference the specific submission this meeting relates to (e.g., "FY27 Defense Appropriations request for Program X").' },
              { key: 'preferred_dates', label: 'Preferred Dates / Availability', type: 'text', maxLength: 200, required: false, helpText: 'e.g., "Week of March 10" or specific dates.' },
              { key: 'attendee_list', label: 'Attendee List', type: 'textarea', required: false, helpText: 'List names and titles of attendees from your side.' },
            ],
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "A meeting request letter is a formal letter to a Member of Congress or their staff requesting an in-person or virtual meeting. Meetings are essential for building relationships and advocating for client programs. Most offices prefer meetings during congressional recesses when Members are in-district.",
      timing: 'Submit 2-4 weeks before desired meeting window. Request meetings before submission deadlines when possible.',
      submission: "Send via email to the Member's scheduler (for Member meetings) or directly to the relevant LA (for staff meetings).",
      contact_email: 'N/A, sent directly to Member scheduler or LA.',
    },
  },
  {
    slug: 'leave-behind-talking-points',
    name: 'Leave-Behind / Talking Points',
    description:
      'Document left with congressional staff after a meeting. Summarizes the ask and key supporting arguments.',
    category: 'supporting',
    sortOrder: 43,
    requiredSections: {
      requestTypes: ['talking_points'],
      sections: {
        funding: {
          section1: {
            title: 'Talking Points / Leave-Behind',
            fields: [
              { key: 'the_ask', label: 'The Ask', type: 'textarea', required: true, helpText: 'One sentence: exactly what you want the Member or staffer to do.' },
              { key: 'key_point_1', label: 'Key Supporting Point 1', type: 'textarea', required: true },
              { key: 'key_point_2', label: 'Key Supporting Point 2', type: 'textarea', required: true },
              { key: 'key_point_3', label: 'Key Supporting Point 3', type: 'textarea', required: false },
              { key: 'key_point_4', label: 'Key Supporting Point 4', type: 'textarea', required: false },
              { key: 'key_point_5', label: 'Key Supporting Point 5', type: 'textarea', required: false },
              { key: 'district_impact', label: 'District / State Impact', type: 'textarea', required: false, helpText: 'Jobs, economic activity, facilities, or other district-relevant impact.' },
              { key: 'funding_comparison_note', label: 'Funding Context Note', type: 'textarea', required: false, helpText: 'e.g., "This request is $5M above PBR, prior year saw a similar increase enacted."' },
            ],
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "A leave-behind is a single-page document handed to congressional staff at the conclusion of an in-person meeting. It reinforces the ask and gives staff something tangible to reference when briefing their boss or advocating internally.",
      timing: 'Prepare before each scheduled meeting. Leave with staff at the end of the meeting.',
      submission: 'Delivered physically (printed) or via email immediately after the meeting.',
      contact_email: 'N/A, delivered in-person or by email after meeting.',
    },
  },
  {
    slug: 'follow-up-letter',
    name: 'Follow-Up / Thank You Letter',
    description:
      'Post-meeting follow-up letter thanking staff and reiterating the ask.',
    category: 'supporting',
    sortOrder: 44,
    requiredSections: {
      requestTypes: ['follow_up'],
      sections: {
        funding: {
          section1: {
            title: 'Follow-Up Letter Details',
            fields: [
              { key: 'meeting_date', label: 'Meeting Date', type: 'text', required: true, helpText: 'Date of the meeting you are following up on.' },
              { key: 'attendees', label: 'Meeting Attendees', type: 'textarea', required: true, helpText: 'List all attendees (both sides) for reference.' },
              { key: 'discussion_summary', label: 'Summary of Discussion', type: 'textarea', required: true, helpText: 'Brief recap of what was discussed in the meeting.' },
              { key: 'restatement_of_ask', label: 'Restatement of the Ask', type: 'textarea', required: true, helpText: 'Clearly restate what you are requesting the Member or staff to do.' },
              { key: 'additional_info_promised', label: 'Additional Information Promised', type: 'textarea', required: false, helpText: 'Any documents, data, or follow-up information you committed to provide.' },
              { key: 'deadline_reminders', label: 'Deadline Reminders', type: 'textarea', required: false, helpText: 'Remind of any upcoming submission deadlines relevant to the request.' },
            ],
          },
        },
        shared: sharedGeneral,
      },
    },
    contextInfo: {
      overview:
        "A follow-up letter is sent within 24-48 hours of an in-person or virtual meeting with congressional staff. It thanks the staff for their time, summarizes the conversation, reiterates the ask, and delivers any promised materials. Follow-up letters create a paper trail and keep the client's request top-of-mind.",
      timing: 'Send within 24-48 hours of the meeting.',
      submission: 'Sent via email to the staff member(s) who attended the meeting.',
      contact_email: 'N/A, sent directly to meeting attendees.',
    },
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // The legacy `workflow_template` table was dropped in migration
  // 20260627130000_drop_legacy_workflow_strategy_chat, so `prisma.workflowTemplate`
  // no longer exists. This seed is now a no-op kept only so the entrypoint's
  // `migrate` mode (which unconditionally runs it after `migrate deploy`) exits 0
  // instead of crashing on the removed model. The `templates` catalog above is
  // retained for reference/history. Safe to delete this script + its entrypoint
  // invocation once the workflow-template feature removal is fully reconciled.
  void templates;
  console.log('Workflow-template seed skipped (legacy table removed).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
