import { Injectable, Logger } from '@nestjs/common';
import {
  answersToSections,
  interviewerSystemPrompt,
  type InterviewAnswer,
} from './memory-interview.helpers.js';
import { fileDefForType } from './memory-catalog.js';
import type { MemorySection } from './memory.types.js';

/**
 * Drafts memory sections from interview answers.
 *
 * Design choice: this service DEGRADES GRACEFULLY. The pure mapping
 * (answersToSections) always produces valid sections from the raw answers. If
 * an Anthropic key is configured, each answer is additionally polished into
 * tighter section prose using the interviewer system prompt (Capiro AI rules:
 * outcomes-led, NO invented stats). If the LLM call fails or is unconfigured,
 * we fall back to the verbatim answer — the user still gets a usable draft and
 * can edit it before saving. This keeps the feature working in every
 * environment and avoids a hard dependency on ChatService internals.
 */
@Injectable()
export class MemoryInterviewService {
  private readonly logger = new Logger(MemoryInterviewService.name);
  private readonly anthropicKey = process.env.ANTHROPIC_API_KEY;
  private readonly model = process.env.CHAT_SONNET_MODEL || 'claude-3-5-sonnet-20241022';

  async draftSections(type: string, answers: InterviewAnswer[]): Promise<MemorySection[]> {
    const baseline = answersToSections(type, answers);
    if (!this.anthropicKey || baseline.length === 0) {
      return baseline; // verbatim fallback — always usable
    }

    const def = fileDefForType(type);
    const system = interviewerSystemPrompt(def?.label ?? type);

    const polished: MemorySection[] = [];
    for (const section of baseline) {
      try {
        const body = await this.polish(system, section.heading, section.body);
        polished.push({ ...section, body: body || section.body });
      } catch (err) {
        this.logger.warn(
          `polish failed for section ${section.key}: ${err instanceof Error ? err.message : err}`,
        );
        polished.push(section); // fall back to verbatim for this section
      }
    }
    return polished;
  }

  private async polish(system: string, heading: string, rawAnswer: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': this.anthropicKey as string,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 600,
          system,
          messages: [
            {
              role: 'user',
              content:
                `Draft the "${heading}" section from the user's answer below. ` +
                `Return ONLY the section text (a tight paragraph or a few bullets), no heading, no preamble. ` +
                `Do not invent any facts, names, numbers, or dates beyond what the user wrote.\n\n` +
                `User's answer:\n${rawAnswer}`,
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
      const json = (await res.json()) as { content?: Array<{ text?: string }> };
      const text = (json.content ?? [])
        .map((c) => c.text ?? '')
        .join('')
        .trim();
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}
