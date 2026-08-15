// JSON schemas for structured model outputs. Each schema is a JSON Schema
// object used as the `input_schema` for the OpenAI Responses API function-call
// forcing mechanism (or the Anthropic tool_use equivalent).
//
// These are plain JSON Schema objects (no zod) so they can be passed directly
// to the provider without conversion and so unit tests can validate shapes
// without importing the provider SDK.

/** Recommend a document setup (type, blueprint, theme, questions). */
export const recommendDocumentSetupSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['documentType', 'recommendedBlueprints', 'recommendedTheme', 'questions', 'rationale'],
  properties: {
    documentType: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'label', 'product'],
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        product: { type: 'string' },
      },
    },
    recommendedBlueprints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['blueprintId', 'name', 'slug'],
        properties: {
          blueprintId: { type: 'string' },
          name: { type: 'string' },
          slug: { type: 'string' },
        },
      },
    },
    recommendedTheme: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'required'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          helpText: { type: 'string' },
          required: { type: 'boolean' },
          answerSource: {
            type: 'string',
            enum: ['user', 'client_profile', 'context', 'meri_recommendation'],
          },
        },
      },
    },
    rationale: { type: 'string' },
  },
} as const;

/** Generate follow-up questions grouped into one turn. */
export const generateFollowUpQuestionsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          helpText: { type: 'string' },
          field: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Synthesize a working brief with assumption provenance. */
export const synthesizeBriefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'audience', 'assumptions', 'provenance'],
  properties: {
    objective: { type: 'string' },
    audience: { type: 'string' },
    desiredAction: { type: 'string' },
    subject: { type: 'string' },
    centralArgument: { type: 'string' },
    evidenceInstructions: { type: 'string' },
    tone: { type: 'string' },
    targetPages: { type: 'number' },
    deadline: { type: 'string' },
    assumptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
    provenance: {
      type: 'object',
      additionalProperties: {
        type: 'string',
        enum: ['user', 'retrieved', 'suggested', 'assumed'],
      },
    },
  },
} as const;

/** Recommend context items to include/exclude. */
export const recommendContextSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['includedItemIds', 'excludedItems'],
  properties: {
    includedItemIds: { type: 'array', items: { type: 'string' } },
    excludedItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['itemId', 'reason'],
        properties: {
          itemId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Analyze context for conflicts and coverage. */
export const analyzeContextSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['conflicts', 'coverage'],
  properties: {
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'itemIds', 'type', 'description', 'recommendedResolution'],
        properties: {
          id: { type: 'string' },
          itemIds: { type: 'array', items: { type: 'string' } },
          type: {
            type: 'string',
            enum: ['numeric', 'date', 'status', 'authority', 'freshness', 'semantic'],
          },
          description: { type: 'string' },
          recommendedResolution: { type: 'string' },
        },
      },
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      required: ['plannedClaims', 'supportedClaims', 'missingClaims'],
      properties: {
        plannedClaims: { type: 'number' },
        supportedClaims: { type: 'number' },
        missingClaims: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['claimId', 'description', 'recommendedSourceTypes'],
            properties: {
              claimId: { type: 'string' },
              description: { type: 'string' },
              recommendedSourceTypes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
} as const;

/** Generate an outline from a pinned blueprint. */
export const generateOutlineSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'purpose', 'instructions', 'required', 'locked', 'targetWords', 'evidenceItemIds'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          purpose: { type: 'string' },
          instructions: { type: 'string' },
          required: { type: 'boolean' },
          locked: { type: 'boolean' },
          targetWords: {
            type: 'object',
            additionalProperties: false,
            required: ['min', 'max'],
            properties: { min: { type: 'number' }, max: { type: 'number' } },
          },
          evidenceItemIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/** Plan the document (evidence + narrative plan for max mode). */
export const planDocumentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['evidencePlan', 'narrativePlan'],
  properties: {
    evidencePlan: {
      type: 'object',
      additionalProperties: false,
      required: ['sectionEvidence'],
      properties: {
        sectionEvidence: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sectionId', 'evidenceItemIds'],
            properties: {
              sectionId: { type: 'string' },
              evidenceItemIds: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    narrativePlan: {
      type: 'object',
      additionalProperties: false,
      required: ['themes', 'flow'],
      properties: {
        themes: { type: 'array', items: { type: 'string' } },
        flow: { type: 'string' },
      },
    },
  },
} as const;

/** Draft a single section. */
export const draftSectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['content'],
  properties: {
    content: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'sourceId'],
        properties: {
          claim: { type: 'string' },
          sourceId: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Revise a selected-text artifact. */
export const reviseArtifactSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['content'],
  properties: {
    content: { type: 'string' },
    rationale: { type: 'string' },
  },
} as const;

/** Run an editorial pass over the complete document. */
export const editorialPassSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sectionEdits'],
  properties: {
    sectionEdits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sectionId', 'content'],
        properties: {
          sectionId: { type: 'string' },
          content: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Type for the reasoning level (maps to MeriV3 reasoning effort). */
export type ReasoningLevel = 'standard' | 'high' | 'max';
