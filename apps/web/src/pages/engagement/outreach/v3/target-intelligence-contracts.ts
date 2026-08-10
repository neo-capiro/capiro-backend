import type {
  CapabilityResult,
  OutreachV3ResolvedTargetRef,
} from './contracts.js';

export interface OutreachV3TargetProfileFact {
  code: string;
  label: string;
  value: string | string[] | null;
  status: 'verified' | 'historical' | 'user_supplied' | 'needs_confirmation';
  usableForPersonalization: boolean;
}

export interface OutreachV3TargetProfileSection {
  status: 'available' | 'limited' | 'not_loaded' | 'not_available' | 'restricted';
  reason: string | null;
  values: string[];
}

export interface OutreachV3TargetProfileWarning {
  code:
    | 'ROLE_HISTORICAL'
    | 'ROLE_UNKNOWN'
    | 'EMAIL_MISSING'
    | 'EMAIL_INVALID'
    | 'PROFILE_LIMITED'
    | string;
  message: string;
}

export interface OutreachV3TargetProfileData {
  target: OutreachV3ResolvedTargetRef;
  identity: {
    displayName: string;
    targetType: string;
    clientId: string | null;
  };
  role: {
    title: string | null;
    organization: string | null;
    status: 'current' | 'historical' | 'unknown';
  };
  contact: {
    email: string | null;
    phone: string | null;
    emailStatus: 'available' | 'missing' | 'invalid';
  };
  jurisdiction: OutreachV3ResolvedTargetRef['jurisdiction'];
  relationshipMetadata: {
    lastContactAt: string | null;
    notesAvailable: boolean;
    ownerLabel: string | null;
    openAsks: OutreachV3TargetProfileSection;
    commitments: OutreachV3TargetProfileSection;
  };
  positioning: {
    knownInterests: OutreachV3TargetProfileSection;
    knownObjections: OutreachV3TargetProfileSection;
    preferredApproach: OutreachV3TargetProfileSection;
    publicPositions: OutreachV3TargetProfileSection;
  };
  governmentNexus: {
    districtState: OutreachV3TargetProfileSection;
    relevantBills: OutreachV3TargetProfileSection;
    relevantProgramElements: OutreachV3TargetProfileSection;
    fundingInterests: OutreachV3TargetProfileSection;
  };
  personalizationFacts: OutreachV3TargetProfileFact[];
  personalizationPolicy: {
    approvedFactCodes: string[];
    prohibitedCategories: string[];
  };
  dataQuality: {
    sourceSystem: string;
    sourceVersion: string | null;
    lastVerifiedAt: string | null;
    staleFields: string[];
    disputedFields: string[];
    conflictingFields: string[];
  };
  warnings: OutreachV3TargetProfileWarning[];
  restrictedCategories: string[];
}

export interface OutreachV3TargetProfileResponse
  extends CapabilityResult<OutreachV3TargetProfileData> {
  selectionSnapshot: {
    status: 'unselected' | 'current' | 'changed' | 'unavailable';
    selectedSnapshotHash: string | null;
    currentSnapshotHash: string | null;
    changedFields: string[];
  };
}

export interface OutreachV3RelationshipInteraction {
  type: 'meeting' | 'email';
  occurredAt: string;
  label: string;
  responseStatus: string | null;
}

export interface OutreachV3RelationshipData {
  targetKey: string;
  clientId: string;
  status: 'strong' | 'active' | 'known' | 'none';
  interactionCount: number;
  meetingCount: number;
  emailCount: number;
  lastInteractionAt: string | null;
  recentInteractions: OutreachV3RelationshipInteraction[];
  openCommitments: Array<{
    id: string;
    title: string;
    dueDate: string | null;
    status: string;
  }>;
  limitations: string[];
}

export type OutreachV3RelationshipResponse = CapabilityResult<OutreachV3RelationshipData>;
