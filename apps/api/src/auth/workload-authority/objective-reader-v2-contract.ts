/** GENERATED contract data from Meri b2f0a5d71e1c1b6a6cf79b1e9a496ad663ef641a.
 * reader.schema.json SHA256 d461baaaf2300aa7ffd363bc4b58295d22c437360c126884e96433e10ac16ec1.
 * Canonical owner: packages/contracts/objective-reader-2. No authority or runtime discovery. */
export const readerPurposes = {
  "active-source": {
    "operation": "objective.source.read",
    "phase": "active-source-read",
    "path": "/v2/internal/objective-generation/accepted-source/read",
    "subject": "capiro-objective-active-source-reader:v2",
    "audience": "meri:objective-active-source-reader:v2"
  },
  "historical-source": {
    "operation": "objective.source.read",
    "phase": "historical-source-read",
    "path": "/v2/internal/objective-generation/historical-source/read",
    "subject": "capiro-objective-historical-source-reader:v2",
    "audience": "meri:objective-historical-source-reader:v2"
  },
  "retained-result": {
    "operation": "objective.retained-result.read",
    "phase": "retained-result-read",
    "path": "/v2/internal/objective-generation/retained-result/read",
    "subject": "capiro-objective-retained-result-reader:v2",
    "audience": "meri:objective-retained-result-reader:v2"
  }
} as const;
export const readerTokenType = "capiro-objective-reader-v2+jwt" as const;
export const readerLimits = {
  "requestBytes": 4096,
  "tokenBytes": 8192,
  "maxTokenSeconds": 60,
  "maxRequestMs": 3000,
  "maxResponseBytes": 4194304
} as const;
export const readerStrategyTypes = ["appropriations","authorization","regulatory","coalition","procurement","earmark","amendment"] as const;
export const readerSchema: unknown = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://capiro.ai/contracts/objective-reader/2",
  "$defs": {
    "Binding": {
      "type": "object",
      "properties": {
        "tenantId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "actorId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "conversationId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "runId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "attemptId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "workerId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "writerFence": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "tenantId",
        "actorId",
        "conversationId",
        "runId",
        "attemptId",
        "workerId",
        "writerFence"
      ],
      "additionalProperties": false
    },
    "Canonical": {
      "type": "object",
      "properties": {
        "canonicalPlanId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "tenantId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "clientId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "objectiveId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "canonicalStrategyId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "canonicalProjectId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "bindingVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "epoch": {
          "const": 1
        },
        "requestedIntentId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "requestedObjectiveRevisionId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "requestedObjectiveVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "snapshotHash": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "canonicalPlanId",
        "tenantId",
        "clientId",
        "objectiveId",
        "canonicalStrategyId",
        "canonicalProjectId",
        "bindingVersion",
        "epoch",
        "requestedIntentId",
        "requestedObjectiveRevisionId",
        "requestedObjectiveVersion",
        "snapshotHash"
      ],
      "additionalProperties": false
    },
    "Admission": {
      "type": "object",
      "properties": {
        "schemaVersion": {
          "const": 1
        },
        "namespace": {
          "const": "capiro.objective-strategy.admission:v1"
        },
        "canonical": {
          "type": "object",
          "properties": {
            "canonicalPlanId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "tenantId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "clientId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "objectiveId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "canonicalStrategyId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "canonicalProjectId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "bindingVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 2147483647
            },
            "epoch": {
              "const": 1
            },
            "requestedIntentId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "requestedObjectiveRevisionId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "requestedObjectiveVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 2147483647
            },
            "snapshotHash": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            }
          },
          "required": [
            "canonicalPlanId",
            "tenantId",
            "clientId",
            "objectiveId",
            "canonicalStrategyId",
            "canonicalProjectId",
            "bindingVersion",
            "epoch",
            "requestedIntentId",
            "requestedObjectiveRevisionId",
            "requestedObjectiveVersion",
            "snapshotHash"
          ],
          "additionalProperties": false
        },
        "actorUserId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "clerkUserId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "consentId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "controlVersion": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2147483647
        },
        "generationJobId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "generationRequestId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "admittedAtMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "effectExpiresAtMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expectedStrategyVersionId": {
          "type": "null"
        }
      },
      "required": [
        "schemaVersion",
        "namespace",
        "canonical",
        "actorUserId",
        "clerkUserId",
        "consentId",
        "controlVersion",
        "generationJobId",
        "generationRequestId",
        "admittedAtMs",
        "effectExpiresAtMs",
        "expectedStrategyVersionId"
      ],
      "additionalProperties": false
    },
    "Issuance": {
      "type": "object",
      "properties": {
        "issuanceKey": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "binding": {
          "type": "object",
          "properties": {
            "tenantId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "actorId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "conversationId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "runId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "attemptId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "workerId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "writerFence": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "tenantId",
            "actorId",
            "conversationId",
            "runId",
            "attemptId",
            "workerId",
            "writerFence"
          ],
          "additionalProperties": false
        },
        "requestSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "expiresAtMs": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "grantId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "capabilitySha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "factsSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "issuanceKey",
        "binding",
        "requestSha256",
        "expiresAtMs",
        "grantId",
        "capabilitySha256",
        "factsSha256"
      ],
      "additionalProperties": false
    },
    "Selector": {
      "type": "object",
      "properties": {
        "generationJobId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "sourceAdmissionSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "generationJobId",
        "sourceAdmissionSha256"
      ],
      "additionalProperties": false
    },
    "Request": {
      "type": "object",
      "properties": {
        "schemaVersion": {
          "const": 2
        },
        "purpose": {
          "enum": [
            "active-source",
            "historical-source",
            "retained-result"
          ]
        },
        "generationJobId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "sourceAdmissionSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        }
      },
      "required": [
        "schemaVersion",
        "purpose",
        "generationJobId",
        "sourceAdmissionSha256"
      ],
      "additionalProperties": false
    },
    "Header": {
      "type": "object",
      "properties": {
        "alg": {
          "const": "EdDSA"
        },
        "typ": {
          "const": "capiro-objective-reader-v2+jwt"
        },
        "kid": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._-]{1,64}$"
        }
      },
      "required": [
        "alg",
        "typ",
        "kid"
      ],
      "additionalProperties": false
    },
    "Scope": {
      "type": "object",
      "properties": {
        "purpose": {
          "enum": [
            "active-source",
            "historical-source",
            "retained-result"
          ]
        },
        "operation": {
          "enum": [
            "objective.source.read",
            "objective.retained-result.read"
          ]
        },
        "phase": {
          "enum": [
            "active-source-read",
            "historical-source-read",
            "retained-result-read"
          ]
        },
        "method": {
          "const": "POST"
        },
        "path": {
          "enum": [
            "/v2/internal/objective-generation/accepted-source/read",
            "/v2/internal/objective-generation/historical-source/read",
            "/v2/internal/objective-generation/retained-result/read"
          ]
        },
        "query": {
          "const": ""
        },
        "bodySha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "sourceAdmissionSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "generationJobId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        }
      },
      "required": [
        "purpose",
        "operation",
        "phase",
        "method",
        "path",
        "query",
        "bodySha256",
        "sourceAdmissionSha256",
        "generationJobId"
      ],
      "additionalProperties": false,
      "oneOf": [
        {
          "properties": {
            "purpose": {
              "const": "active-source"
            },
            "operation": {
              "const": "objective.source.read"
            },
            "phase": {
              "const": "active-source-read"
            },
            "path": {
              "const": "/v2/internal/objective-generation/accepted-source/read"
            }
          }
        },
        {
          "properties": {
            "purpose": {
              "const": "historical-source"
            },
            "operation": {
              "const": "objective.source.read"
            },
            "phase": {
              "const": "historical-source-read"
            },
            "path": {
              "const": "/v2/internal/objective-generation/historical-source/read"
            }
          }
        },
        {
          "properties": {
            "purpose": {
              "const": "retained-result"
            },
            "operation": {
              "const": "objective.retained-result.read"
            },
            "phase": {
              "const": "retained-result-read"
            },
            "path": {
              "const": "/v2/internal/objective-generation/retained-result/read"
            }
          }
        }
      ]
    },
    "Claims": {
      "type": "object",
      "properties": {
        "iss": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "sub": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "aud": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "iat": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "nbf": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "exp": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "jti": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "objective": {
          "type": "object",
          "properties": {
            "purpose": {
              "enum": [
                "active-source",
                "historical-source",
                "retained-result"
              ]
            },
            "operation": {
              "enum": [
                "objective.source.read",
                "objective.retained-result.read"
              ]
            },
            "phase": {
              "enum": [
                "active-source-read",
                "historical-source-read",
                "retained-result-read"
              ]
            },
            "method": {
              "const": "POST"
            },
            "path": {
              "enum": [
                "/v2/internal/objective-generation/accepted-source/read",
                "/v2/internal/objective-generation/historical-source/read",
                "/v2/internal/objective-generation/retained-result/read"
              ]
            },
            "query": {
              "const": ""
            },
            "bodySha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "sourceAdmissionSha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "generationJobId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            }
          },
          "required": [
            "purpose",
            "operation",
            "phase",
            "method",
            "path",
            "query",
            "bodySha256",
            "sourceAdmissionSha256",
            "generationJobId"
          ],
          "additionalProperties": false,
          "oneOf": [
            {
              "properties": {
                "purpose": {
                  "const": "active-source"
                },
                "operation": {
                  "const": "objective.source.read"
                },
                "phase": {
                  "const": "active-source-read"
                },
                "path": {
                  "const": "/v2/internal/objective-generation/accepted-source/read"
                }
              }
            },
            {
              "properties": {
                "purpose": {
                  "const": "historical-source"
                },
                "operation": {
                  "const": "objective.source.read"
                },
                "phase": {
                  "const": "historical-source-read"
                },
                "path": {
                  "const": "/v2/internal/objective-generation/historical-source/read"
                }
              }
            },
            {
              "properties": {
                "purpose": {
                  "const": "retained-result"
                },
                "operation": {
                  "const": "objective.retained-result.read"
                },
                "phase": {
                  "const": "retained-result-read"
                },
                "path": {
                  "const": "/v2/internal/objective-generation/retained-result/read"
                }
              }
            }
          ]
        }
      },
      "required": [
        "iss",
        "sub",
        "aud",
        "iat",
        "nbf",
        "exp",
        "jti",
        "objective"
      ],
      "additionalProperties": false
    },
    "Observation": {
      "type": "object",
      "properties": {
        "schemaVersion": {
          "const": 2
        },
        "purpose": {
          "enum": [
            "active-source",
            "historical-source"
          ]
        },
        "generationJobId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "sourceAdmission": {
          "type": "object",
          "properties": {
            "schemaVersion": {
              "const": 1
            },
            "namespace": {
              "const": "capiro.objective-strategy.admission:v1"
            },
            "canonical": {
              "type": "object",
              "properties": {
                "canonicalPlanId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "tenantId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "clientId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "objectiveId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "canonicalStrategyId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "canonicalProjectId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "bindingVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
                },
                "epoch": {
                  "const": 1
                },
                "requestedIntentId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "requestedObjectiveRevisionId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "requestedObjectiveVersion": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2147483647
                },
                "snapshotHash": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{64}$"
                }
              },
              "required": [
                "canonicalPlanId",
                "tenantId",
                "clientId",
                "objectiveId",
                "canonicalStrategyId",
                "canonicalProjectId",
                "bindingVersion",
                "epoch",
                "requestedIntentId",
                "requestedObjectiveRevisionId",
                "requestedObjectiveVersion",
                "snapshotHash"
              ],
              "additionalProperties": false
            },
            "actorUserId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "clerkUserId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "consentId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "controlVersion": {
              "type": "integer",
              "minimum": 1,
              "maximum": 2147483647
            },
            "generationJobId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "generationRequestId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "admittedAtMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "effectExpiresAtMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "expectedStrategyVersionId": {
              "type": "null"
            }
          },
          "required": [
            "schemaVersion",
            "namespace",
            "canonical",
            "actorUserId",
            "clerkUserId",
            "consentId",
            "controlVersion",
            "generationJobId",
            "generationRequestId",
            "admittedAtMs",
            "effectExpiresAtMs",
            "expectedStrategyVersionId"
          ],
          "additionalProperties": false
        },
        "sourceAdmissionSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "binding": {
          "type": "object",
          "properties": {
            "tenantId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "actorId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "conversationId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "runId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "attemptId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "workerId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "writerFence": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "tenantId",
            "actorId",
            "conversationId",
            "runId",
            "attemptId",
            "workerId",
            "writerFence"
          ],
          "additionalProperties": false
        },
        "sourceRequestSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "issuance": {
          "type": "object",
          "properties": {
            "issuanceKey": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "binding": {
              "type": "object",
              "properties": {
                "tenantId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "actorId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "conversationId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "runId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "attemptId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "workerId": {
                  "type": "string",
                  "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "writerFence": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tenantId",
                "actorId",
                "conversationId",
                "runId",
                "attemptId",
                "workerId",
                "writerFence"
              ],
              "additionalProperties": false
            },
            "requestSha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "expiresAtMs": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            },
            "grantId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "capabilitySha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            },
            "factsSha256": {
              "type": "string",
              "pattern": "^[0-9a-f]{64}$"
            }
          },
          "required": [
            "issuanceKey",
            "binding",
            "requestSha256",
            "expiresAtMs",
            "grantId",
            "capabilitySha256",
            "factsSha256"
          ],
          "additionalProperties": false
        },
        "typedRequestSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "executionContextSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "acceptedRequestId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "acceptedPromptSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "queuedType": {
          "enum": [
            "appropriations",
            "authorization",
            "regulatory",
            "coalition",
            "procurement",
            "earmark",
            "amendment"
          ]
        },
        "runState": {
          "enum": [
            "queued",
            "starting",
            "running",
            "completed",
            "failed",
            "cancelled"
          ]
        },
        "checkedAtMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expiresAtMs": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "schemaVersion",
        "purpose",
        "generationJobId",
        "sourceAdmission",
        "sourceAdmissionSha256",
        "binding",
        "sourceRequestSha256",
        "issuance",
        "typedRequestSha256",
        "executionContextSha256",
        "acceptedRequestId",
        "acceptedPromptSha256",
        "queuedType",
        "runState",
        "checkedAtMs",
        "expiresAtMs"
      ],
      "additionalProperties": false
    },
    "Retained": {
      "type": "object",
      "properties": {
        "schemaVersion": {
          "const": 1
        },
        "generationJobId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "binding": {
          "type": "object",
          "properties": {
            "tenantId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "actorId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "conversationId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "runId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "attemptId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "workerId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
            },
            "writerFence": {
              "type": "integer",
              "minimum": 1,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "tenantId",
            "actorId",
            "conversationId",
            "runId",
            "attemptId",
            "workerId",
            "writerFence"
          ],
          "additionalProperties": false
        },
        "sourceAdmissionSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "sourceRequestSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "typedRequestSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "completionId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "checkpointId": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "checkpointSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "resultRef": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        },
        "resultSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "file": {
          "type": "object",
          "properties": {
            "path": {
              "const": "meri-objective-strategy-draft.result.json"
            },
            "object": {
              "type": "object",
              "properties": {
                "objectId": {
                  "type": "string",
                  "format": "uuid"
                },
                "versionId": {
                  "type": "string",
                  "minLength": 1
                },
                "sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "bytes": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "scopes": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "tenantId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128
                      },
                      "kind": {
                        "type": "string",
                        "enum": [
                          "tenant",
                          "client",
                          "mailbox",
                          "memory",
                          "document",
                          "private-user",
                          "public"
                        ]
                      },
                      "resourceId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 256
                      },
                      "policyRevision": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128
                      }
                    },
                    "required": [
                      "tenantId",
                      "kind",
                      "resourceId",
                      "policyRevision"
                    ],
                    "additionalProperties": false
                  },
                  "minItems": 1,
                  "uniqueItems": true
                }
              },
              "required": [
                "objectId",
                "versionId",
                "sha256",
                "bytes",
                "scopes"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "path",
            "object"
          ],
          "additionalProperties": false
        },
        "rawFileSha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "execution": {
          "type": "object",
          "properties": {
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "pattern": "\\S"
            },
            "model": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "pattern": "\\S"
            },
            "receiptRef": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
            },
            "receiptSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "bindingSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "provider",
            "model",
            "receiptRef",
            "receiptSha256",
            "bindingSha256"
          ],
          "additionalProperties": false
        },
        "result": {
          "type": "object",
          "properties": {
            "candidateVersion": {
              "const": "strategy-candidate/20261015.2"
            },
            "operation": {
              "enum": [
                "strategy.draft",
                "strategy.edit",
                "strategy.step-document"
              ]
            },
            "requestId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
            },
            "jobId": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
            },
            "requestSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "inputSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "sourceSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "contextSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "basisSha256": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "binding": {
              "type": "object",
              "properties": {
                "tenantId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "actorId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "conversationId": {
                  "type": "string",
                  "format": "uuid"
                },
                "runId": {
                  "type": "string",
                  "format": "uuid"
                },
                "attemptId": {
                  "type": "string",
                  "format": "uuid"
                },
                "workerId": {
                  "type": "string",
                  "format": "uuid"
                },
                "writerFence": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tenantId",
                "actorId",
                "conversationId",
                "runId",
                "attemptId",
                "workerId",
                "writerFence"
              ],
              "additionalProperties": false
            },
            "execution": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "provider": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "\\S"
                    },
                    "model": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128,
                      "pattern": "\\S"
                    },
                    "receiptRef": {
                      "type": "string",
                      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
                    },
                    "receiptSha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "bindingSha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "provider",
                    "model",
                    "receiptRef",
                    "receiptSha256",
                    "bindingSha256"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            },
            "resultRef": {
              "type": "string",
              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
            },
            "completedAtMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "state": {
              "enum": [
                "succeeded",
                "needs-information",
                "refused",
                "failed",
                "cancelled"
              ]
            },
            "payload": {
              "anyOf": [
                {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "type": {
                          "enum": [
                            "appropriations",
                            "authorization",
                            "regulatory",
                            "coalition",
                            "procurement",
                            "earmark",
                            "amendment"
                          ]
                        },
                        "rationale": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 4000,
                          "pattern": "\\S"
                        },
                        "summary": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 16000,
                          "pattern": "\\S"
                        },
                        "nodes": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "sourceNodeKey": {
                                "type": "string",
                                "pattern": "^[a-z][a-z0-9_-]{0,63}$"
                              },
                              "kind": {
                                "enum": [
                                  "action",
                                  "decision",
                                  "gate",
                                  "milestone",
                                  "risk"
                                ]
                              },
                              "subject": {
                                "enum": [
                                  "deliverable",
                                  "submission",
                                  "member",
                                  "committee",
                                  "ask",
                                  "agency",
                                  "outcome",
                                  "optics"
                                ]
                              },
                              "title": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 300,
                                "pattern": "\\S"
                              },
                              "note": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 8000,
                                    "pattern": "\\S"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "status": {
                                "enum": [
                                  "draft",
                                  "in_progress",
                                  "internal_review",
                                  "active",
                                  "suggested",
                                  "completed"
                                ]
                              },
                              "ownerRef": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 128,
                                    "pattern": "\\S"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "startsOn": {
                                "type": "string",
                                "format": "date"
                              },
                              "endsOn": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "format": "date"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "openEnded": {
                                "type": "boolean"
                              },
                              "sources": {
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "section": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128,
                                      "pattern": "\\S"
                                    },
                                    "ref": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 256,
                                      "pattern": "\\S"
                                    }
                                  },
                                  "required": [
                                    "section",
                                    "ref"
                                  ],
                                  "additionalProperties": false
                                },
                                "minItems": 0,
                                "maxItems": 64
                              },
                              "dependsOn": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "pattern": "^[a-z][a-z0-9_-]{0,63}$"
                                },
                                "minItems": 0,
                                "maxItems": 60,
                                "uniqueItems": true
                              }
                            },
                            "required": [
                              "sourceNodeKey",
                              "kind",
                              "subject",
                              "title",
                              "note",
                              "status",
                              "ownerRef",
                              "startsOn",
                              "endsOn",
                              "openEnded",
                              "sources",
                              "dependsOn"
                            ],
                            "additionalProperties": false
                          },
                          "minItems": 1,
                          "maxItems": 60
                        },
                        "coverage": {
                          "type": "object",
                          "properties": {
                            "complete": {
                              "type": "boolean"
                            },
                            "omitted": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256,
                                "pattern": "\\S"
                              },
                              "minItems": 0,
                              "maxItems": 60
                            },
                            "assumptions": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 1000,
                                "pattern": "\\S"
                              },
                              "minItems": 0,
                              "maxItems": 60
                            },
                            "sources": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "section": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 128,
                                    "pattern": "\\S"
                                  },
                                  "ref": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256,
                                    "pattern": "\\S"
                                  }
                                },
                                "required": [
                                  "section",
                                  "ref"
                                ],
                                "additionalProperties": false
                              },
                              "minItems": 0,
                              "maxItems": 256
                            },
                            "pendingSources": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "section": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 128,
                                    "pattern": "\\S"
                                  },
                                  "ref": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256,
                                    "pattern": "\\S"
                                  }
                                },
                                "required": [
                                  "section",
                                  "ref"
                                ],
                                "additionalProperties": false
                              },
                              "minItems": 0,
                              "maxItems": 256
                            }
                          },
                          "required": [
                            "complete",
                            "omitted",
                            "assumptions",
                            "sources",
                            "pendingSources"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "type",
                        "rationale",
                        "summary",
                        "nodes",
                        "coverage"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "reply": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 16000,
                          "pattern": "\\S"
                        },
                        "summary": {
                          "anyOf": [
                            {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 16000,
                              "pattern": "\\S"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "edits": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "op": {
                                "enum": [
                                  "add",
                                  "update",
                                  "remove",
                                  "retime"
                                ]
                              },
                              "nodeId": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "sourceNodeKey": {
                                "anyOf": [
                                  {
                                    "type": "string",
                                    "pattern": "^[a-z][a-z0-9_-]{0,63}$"
                                  },
                                  {
                                    "type": "null"
                                  }
                                ]
                              },
                              "changes": {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "enum": [
                                      "action",
                                      "decision",
                                      "gate",
                                      "milestone",
                                      "risk"
                                    ]
                                  },
                                  "subject": {
                                    "enum": [
                                      "deliverable",
                                      "submission",
                                      "member",
                                      "committee",
                                      "ask",
                                      "agency",
                                      "outcome",
                                      "optics"
                                    ]
                                  },
                                  "title": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 300,
                                    "pattern": "\\S"
                                  },
                                  "note": {
                                    "anyOf": [
                                      {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 8000,
                                        "pattern": "\\S"
                                      },
                                      {
                                        "type": "null"
                                      }
                                    ]
                                  },
                                  "status": {
                                    "enum": [
                                      "draft",
                                      "in_progress",
                                      "internal_review",
                                      "active",
                                      "suggested",
                                      "completed"
                                    ]
                                  },
                                  "ownerRef": {
                                    "anyOf": [
                                      {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128,
                                        "pattern": "\\S"
                                      },
                                      {
                                        "type": "null"
                                      }
                                    ]
                                  },
                                  "startsOn": {
                                    "type": "string",
                                    "format": "date"
                                  },
                                  "endsOn": {
                                    "anyOf": [
                                      {
                                        "type": "string",
                                        "format": "date"
                                      },
                                      {
                                        "type": "null"
                                      }
                                    ]
                                  },
                                  "openEnded": {
                                    "type": "boolean"
                                  },
                                  "sources": {
                                    "type": "array",
                                    "items": {
                                      "type": "object",
                                      "properties": {
                                        "section": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 128,
                                          "pattern": "\\S"
                                        },
                                        "ref": {
                                          "type": "string",
                                          "minLength": 1,
                                          "maxLength": 256,
                                          "pattern": "\\S"
                                        }
                                      },
                                      "required": [
                                        "section",
                                        "ref"
                                      ],
                                      "additionalProperties": false
                                    },
                                    "minItems": 0,
                                    "maxItems": 64
                                  },
                                  "dependsOn": {
                                    "type": "array",
                                    "items": {
                                      "oneOf": [
                                        {
                                          "type": "object",
                                          "properties": {
                                            "kind": {
                                              "const": "existing"
                                            },
                                            "nodeId": {
                                              "type": "string",
                                              "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
                                            }
                                          },
                                          "required": [
                                            "kind",
                                            "nodeId"
                                          ],
                                          "additionalProperties": false
                                        },
                                        {
                                          "type": "object",
                                          "properties": {
                                            "kind": {
                                              "const": "new"
                                            },
                                            "sourceNodeKey": {
                                              "type": "string",
                                              "pattern": "^[a-z][a-z0-9_-]{0,63}$"
                                            }
                                          },
                                          "required": [
                                            "kind",
                                            "sourceNodeKey"
                                          ],
                                          "additionalProperties": false
                                        }
                                      ]
                                    },
                                    "minItems": 0,
                                    "maxItems": 60,
                                    "uniqueItems": true
                                  }
                                },
                                "required": [],
                                "additionalProperties": false
                              }
                            },
                            "required": [
                              "op",
                              "nodeId",
                              "sourceNodeKey",
                              "changes"
                            ],
                            "additionalProperties": false
                          },
                          "minItems": 0,
                          "maxItems": 60
                        },
                        "coverage": {
                          "type": "object",
                          "properties": {
                            "complete": {
                              "type": "boolean"
                            },
                            "omitted": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256,
                                "pattern": "\\S"
                              },
                              "minItems": 0,
                              "maxItems": 60
                            },
                            "assumptions": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 1000,
                                "pattern": "\\S"
                              },
                              "minItems": 0,
                              "maxItems": 60
                            },
                            "sources": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "section": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 128,
                                    "pattern": "\\S"
                                  },
                                  "ref": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256,
                                    "pattern": "\\S"
                                  }
                                },
                                "required": [
                                  "section",
                                  "ref"
                                ],
                                "additionalProperties": false
                              },
                              "minItems": 0,
                              "maxItems": 256
                            },
                            "pendingSources": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "section": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 128,
                                    "pattern": "\\S"
                                  },
                                  "ref": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256,
                                    "pattern": "\\S"
                                  }
                                },
                                "required": [
                                  "section",
                                  "ref"
                                ],
                                "additionalProperties": false
                              },
                              "minItems": 0,
                              "maxItems": 256
                            }
                          },
                          "required": [
                            "complete",
                            "omitted",
                            "assumptions",
                            "sources",
                            "pendingSources"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "reply",
                        "summary",
                        "edits",
                        "coverage"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "title": {
                          "anyOf": [
                            {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 300,
                              "pattern": "\\S"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "summary": {
                          "anyOf": [
                            {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 16000,
                              "pattern": "\\S"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "sections": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "heading": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 300,
                                "pattern": "\\S"
                              },
                              "html": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 100000,
                                "pattern": "\\S"
                              },
                              "sources": {
                                "type": "array",
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "section": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128,
                                      "pattern": "\\S"
                                    },
                                    "ref": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 256,
                                      "pattern": "\\S"
                                    }
                                  },
                                  "required": [
                                    "section",
                                    "ref"
                                  ],
                                  "additionalProperties": false
                                },
                                "minItems": 0,
                                "maxItems": 64
                              }
                            },
                            "required": [
                              "heading",
                              "html",
                              "sources"
                            ],
                            "additionalProperties": false
                          },
                          "minItems": 1,
                          "maxItems": 60
                        },
                        "coverage": {
                          "type": "object",
                          "properties": {
                            "complete": {
                              "type": "boolean"
                            },
                            "omitted": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 256,
                                "pattern": "\\S"
                              },
                              "minItems": 0,
                              "maxItems": 60
                            },
                            "assumptions": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 1000,
                                "pattern": "\\S"
                              },
                              "minItems": 0,
                              "maxItems": 60
                            },
                            "sources": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "section": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 128,
                                    "pattern": "\\S"
                                  },
                                  "ref": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256,
                                    "pattern": "\\S"
                                  }
                                },
                                "required": [
                                  "section",
                                  "ref"
                                ],
                                "additionalProperties": false
                              },
                              "minItems": 0,
                              "maxItems": 256
                            },
                            "pendingSources": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "section": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 128,
                                    "pattern": "\\S"
                                  },
                                  "ref": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 256,
                                    "pattern": "\\S"
                                  }
                                },
                                "required": [
                                  "section",
                                  "ref"
                                ],
                                "additionalProperties": false
                              },
                              "minItems": 0,
                              "maxItems": 256
                            }
                          },
                          "required": [
                            "complete",
                            "omitted",
                            "assumptions",
                            "sources",
                            "pendingSources"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "title",
                        "summary",
                        "sections",
                        "coverage"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "payloadSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "issues": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "pattern": "\\S"
                  },
                  "message": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1000,
                    "pattern": "\\S"
                  }
                },
                "required": [
                  "code",
                  "message"
                ],
                "additionalProperties": false
              },
              "minItems": 0,
              "maxItems": 60
            },
            "resultSha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "candidateVersion",
            "operation",
            "requestId",
            "jobId",
            "requestSha256",
            "inputSha256",
            "sourceSha256",
            "contextSha256",
            "basisSha256",
            "binding",
            "execution",
            "resultRef",
            "completedAtMs",
            "state",
            "payload",
            "payloadSha256",
            "issues",
            "resultSha256"
          ],
          "additionalProperties": false
        },
        "checkedAtMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "expiresAtMs": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "schemaVersion",
        "generationJobId",
        "binding",
        "sourceAdmissionSha256",
        "sourceRequestSha256",
        "typedRequestSha256",
        "completionId",
        "checkpointId",
        "checkpointSha256",
        "resultRef",
        "resultSha256",
        "file",
        "rawFileSha256",
        "execution",
        "result",
        "checkedAtMs",
        "expiresAtMs"
      ],
      "additionalProperties": false
    }
  }
};
