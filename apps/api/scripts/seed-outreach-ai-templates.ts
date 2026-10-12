/**
 * Seed 8 system-level outreach AI prompt templates.
 * These templates are tenant-agnostic (tenantId = 'SYSTEM', userId = null)
 * and available to all tenants as the baseline prompt library.
 *
 * Run: tsx scripts/seed-outreach-ai-templates.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '.env') });

import { PrismaClient } from '@prisma/client';

const POST_MEETING_MEMO_GUIDANCE = `Generate an internal post-meeting memo in Markdown. This is not a normal campaign email. Use context.metadata.campaignCurrentDateTimeDisplay as the Date / Time value. Use only the supplied client, recipient, meeting, debrief, email thread, and congressional directory context. If a requested fact is not present, omit that section. Do not leave bracket placeholders, variable tokens, or made-up details. Organize the memo in this order: Date/Time, Meeting Participants (with House/Senate subsections when applicable), Summary - Key Takeaways, Policy and Strategic Implications, House Staff Feedback, Senate Staff Feedback, Key Themes Identified, Risks / Concerns Raised, Opportunities Identified, Follow-Up Items and Next Steps, Strategic Assessment, Internal Notes. Only include sections supported by the source context.`;

const SYSTEM_TEMPLATES = [
  {
    name: 'Thank You',
    category: 'general',
    tone: 'friendly',
    description: 'Warm thank-you note acknowledging a specific recent action or support.',
    prompt:
      'Write a brief, warm thank-you email acknowledging a specific recent action or support from the recipient. Name what you are thanking them for using the meeting or engagement context. No new asks. Close with an offer to stay in touch. Under 150 words.',
    samplePreview:
      'Dear [Name], Thank you for your time and support regarding [specific topic]. Your engagement on this matter means a great deal...',
  },
  {
    name: 'Follow-Up',
    category: 'follow_up',
    tone: 'professional',
    description: 'Polite follow-up referencing a prior meeting or conversation.',
    prompt:
      'Write a polite follow-up email referencing a specific prior meeting or conversation. Restate one clear ask or next step. Propose a concrete next action with a suggested timeline. Reference any open commitments from the prior engagement. Under 200 words.',
    samplePreview:
      'Dear [Name], Thank you again for our meeting on [date]. As discussed, I wanted to follow up on [specific topic]...',
  },
  {
    name: 'Memo / Position Paper',
    category: 'policy',
    tone: 'formal',
    description: 'Concise position memo with background, ask, and supporting points.',
    prompt:
      'Write a concise position memo. Structure: one-line summary at top, then Background (2-3 sentences), The Ask (1 sentence, specific), Supporting Points (3-4 bullets with evidence), and District/State Impact (if available). Under 400 words. Formal but accessible tone.',
    samplePreview:
      'SUMMARY: [Client] requests congressional support for [program/initiative].\n\nBACKGROUND: [Client] has operated in [sector] for [X years]...',
  },
  {
    name: 'Post-Meeting Memo',
    category: 'meeting',
    tone: 'formal',
    description:
      'Internal post-meeting memo built from client, meeting, debrief, and directory context.',
    prompt: POST_MEETING_MEMO_GUIDANCE,
    samplePreview:
      '## Date / Time\n[Meeting date and time]\n\n# Meeting Participants\n### House\n[Participant names, titles, committees]...',
  },
  {
    name: 'Introduction',
    category: 'general',
    tone: 'professional',
    description: 'Introductory outreach email connecting a client to a congressional office.',
    prompt:
      "Write an introductory outreach email on behalf of a client to a congressional office. Briefly introduce who the client is and why they matter to the recipient's portfolio. Connect the client's work to the recipient's committee jurisdiction or district interests. End with a low-friction first ask, a 15-minute introductory call or brief meeting. Under 200 words.",
    samplePreview:
      'Dear [Name], I am writing on behalf of [Client], a [description] that [value proposition]...',
  },
  {
    name: 'Meeting Request',
    category: 'meeting',
    tone: 'concise',
    description: 'Short, focused request for a meeting with scheduling options.',
    prompt:
      'Write a concise meeting request email. State the purpose of the meeting in one sentence. Suggest 2-3 scheduling windows. List who would attend from the client side. Include a one-sentence agenda. Under 150 words.',
    samplePreview:
      'Dear [Name], I would like to request a brief meeting to discuss [topic]. We are available [time options]...',
  },
  {
    name: 'Status Update',
    category: 'general',
    tone: 'professional',
    description: 'Brief progress update covering activity since last contact.',
    prompt:
      'Write a brief progress update email. List 2-4 short bullets covering: activity since last contact, current program status, and next planned milestone. Only include a new ask if directly tied to the update. Under 200 words.',
    samplePreview:
      'Dear [Name], I wanted to provide a brief update on [program/initiative]:\n\n• [Activity update]\n• [Current status]...',
  },
  {
    name: 'Policy Alert',
    category: 'policy',
    tone: 'professional',
    description: 'Timely alert about a relevant policy development or bill movement.',
    prompt:
      "Write a policy alert email informing the recipient of a relevant development. Open with the news (bill movement, funding change, regulatory action). Explain the impact on the recipient's jurisdiction or the client's program. Suggest a follow-up conversation if appropriate. Under 250 words.",
    samplePreview:
      'Dear [Name], I wanted to bring to your attention an important development: [news/event]...',
  },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/seed-outreach-ai-templates.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    console.log('Seeding system outreach AI prompt templates...');

    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

    for (const template of SYSTEM_TEMPLATES) {
      const existing = await prisma.outreachAiTemplate.findFirst({
        where: {
          tenantId: SYSTEM_TENANT_ID,
          userId: null,
          name: template.name,
        },
      });

      if (existing) {
        await prisma.outreachAiTemplate.update({
          where: { id: existing.id },
          data: {
            category: template.category,
            tone: template.tone,
            description: template.description,
            prompt: template.prompt,
            samplePreview: template.samplePreview,
          },
        });
        console.log(`  Updated: ${template.name}`);
      } else {
        await prisma.outreachAiTemplate.create({
          data: {
            tenantId: SYSTEM_TENANT_ID,
            userId: null,
            name: template.name,
            category: template.category,
            tone: template.tone,
            description: template.description,
            prompt: template.prompt,
            samplePreview: template.samplePreview,
          },
        });
        console.log(`  Created: ${template.name}`);
      }
    }

    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
