import type { DocumentTypeValue } from './frontmatter.js';

export interface ContextImportSource {
  attachmentId: string;
  fileName: string;
  contentHash: string;
}

export interface ContextImportSection {
  ref: string;
  label: string;
  text: string;
}

export interface ContextImportDocument {
  documentType: DocumentTypeValue;
  title: string;
  sections: Array<{
    heading: string;
    content: string;
    evidence: Array<{ sourceRef: string; quote: string }>;
  }>;
}

export interface ContextImportConflict {
  documentIndex: number;
  sectionIndex: number;
  existingFactId: string;
  material: boolean;
}

export interface ContextImportAnalysis {
  documents: ContextImportDocument[];
  conflicts?: ContextImportConflict[];
  warnings?: string[];
  model?: string;
}

export interface ContextImportComparison {
  conflicts: Array<{ incomingFactId: string; otherFactId: string; material: boolean }>;
  warnings?: string[];
}
