export interface AuthorStyleProfile {
  sentenceLength: 'short' | 'medium' | 'long';
  greetingPattern: string | null;
  closingPattern: string | null;
  toneTags: string[];
  /** Ordered sections the author habitually uses. */
  structureSequence: string[];
  preferredTransitions: string[];
  phrasesToAvoid: string[];
  formattingPreferences: string[];
  /** How this profile was built — surfaced in the packet's provenance. */
  derivedFrom: Array<'voice_memory' | 'sent_examples'>;
  /** sha256 over the inputs, so an unchanged author/client reuses the profile. */
  sourceHash: string;
  version: 'style-profile-v1';
}
