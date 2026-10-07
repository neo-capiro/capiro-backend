import { fail } from './planner.validation.js';

export const PLANNER_ATTACHMENT_LIMIT = 25 * 1024 * 1024;
export function plannerAttachmentName(name: unknown): string {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 255 ||
    /[\x00-\x1f\x7f/\\]/.test(name)
  )
    fail('Invalid attachment filename');
  return name;
}
export type PlannerUpload = { buffer: Buffer; originalname: string; size: number };
export type PlannerFormUpload = PlannerUpload & { fieldname: string };
