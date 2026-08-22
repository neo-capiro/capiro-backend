import { describe, expect, it } from '@jest/globals';
import {
  QUALITY_TELEMETRY_EVENT_TYPES,
  QUALITY_TELEMETRY_SURFACES,
  assertKnownContextLayer,
  assertNoConfidentialContent,
  computeQualityTelemetryIdempotencyKey,
  qualityTelemetryEnabled,
} from './contract';

describe('QualityTelemetryEvent contract (Phase 27E)', () => {
  describe('qualityTelemetryEnabled', () => {
    it('is dark by default — undefined, empty, and any value other than "enabled" stay off', () => {
      expect(qualityTelemetryEnabled(undefined)).toBe(false);
      expect(qualityTelemetryEnabled('')).toBe(false);
      expect(qualityTelemetryEnabled('true')).toBe(false);
      expect(qualityTelemetryEnabled('disabled')).toBe(false);
    });

    it('arms only on the exact literal "enabled", case/whitespace insensitive', () => {
      expect(qualityTelemetryEnabled('enabled')).toBe(true);
      expect(qualityTelemetryEnabled('ENABLED')).toBe(true);
      expect(qualityTelemetryEnabled('  enabled  ')).toBe(true);
    });
  });

  describe('assertKnownContextLayer', () => {
    it('accepts each of the five frozen layers', () => {
      for (const layer of ['firm-identity', 'firm-playbook', 'user-voice', 'client-steering', 'client-people'] as const) {
        expect(() => assertKnownContextLayer(layer)).not.toThrow();
      }
    });

    it('rejects a sixth/unknown layer', () => {
      expect(() => assertKnownContextLayer('external-research' as never)).toThrow(
        /not one of the five frozen context layers/,
      );
    });
  });

  describe('assertNoConfidentialContent', () => {
    it('accepts short, metadata-shaped provenance/editMetrics/contextLayerCounts', () => {
      expect(() =>
        assertNoConfidentialContent({
          provenance: { reasonCode: 'auto_generated', sampledFrom: 'outreach.draft_version.generate' },
          editMetrics: { percentChanged: 12.5, versionsCount: 3 },
          contextLayerCounts: { firmIdentity: 2, clientSteering: 1 },
        }),
      ).not.toThrow();
    });

    it('rejects a string value longer than the safe-metadata length cap', () => {
      expect(() =>
        assertNoConfidentialContent({ provenance: { reasonCode: 'x'.repeat(201) } }),
      ).toThrow(/carries a string of 201 chars/);
    });

    it.each(['body', 'text', 'content', 'transcript', 'prompt', 'response', 'message', 'summary', 'note', 'excerpt', 'draft', 'subject'])(
      'rejects the banned key "%s" even with a short value',
      (key) => {
        expect(() => assertNoConfidentialContent({ provenance: { [key]: 'short' } })).toThrow(/banned field name/);
      },
    );

    it('rejects a banned key nested inside an array', () => {
      expect(() =>
        assertNoConfidentialContent({ provenance: { items: [{ body: 'short' }] } }),
      ).toThrow(/banned field name/);
    });
  });

  describe('computeQualityTelemetryIdempotencyKey', () => {
    it('is deterministic and stable across calls for the same logical event', () => {
      const input = {
        surface: 'outreach' as const,
        artifactType: 'outreach_draft_version' as const,
        artifactId: 'draft-1',
        eventType: 'approved' as const,
        artifactVersionSeq: 2,
      };
      expect(computeQualityTelemetryIdempotencyKey(input)).toBe(computeQualityTelemetryIdempotencyKey({ ...input }));
    });

    it('differs when the artifact version changes — a new lifecycle step is a new row, not a dedupe collision', () => {
      const base = {
        surface: 'outreach' as const,
        artifactType: 'outreach_draft_version' as const,
        artifactId: 'draft-1',
        eventType: 'generated' as const,
      };
      expect(computeQualityTelemetryIdempotencyKey({ ...base, artifactVersionSeq: 1 })).not.toBe(
        computeQualityTelemetryIdempotencyKey({ ...base, artifactVersionSeq: 2 }),
      );
    });

    it('handles missing artifact fields (e.g. Meri feedback with no versioned artifact) without colliding across event types', () => {
      const base = { surface: 'meri' as const, artifactType: null, artifactId: null, artifactVersionSeq: null };
      expect(computeQualityTelemetryIdempotencyKey({ ...base, eventType: 'feedback_positive' })).not.toBe(
        computeQualityTelemetryIdempotencyKey({ ...base, eventType: 'feedback_negative' }),
      );
    });
  });

  it('QUALITY_TELEMETRY_SURFACES and QUALITY_TELEMETRY_EVENT_TYPES stay non-empty closed lists', () => {
    expect(QUALITY_TELEMETRY_SURFACES.length).toBeGreaterThan(0);
    expect(QUALITY_TELEMETRY_EVENT_TYPES).toContain('unknown');
  });
});
