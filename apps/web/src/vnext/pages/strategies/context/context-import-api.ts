import type { AxiosInstance } from 'axios';
import { uploadOutreachAttachment } from '../../engagement/engagement-api.js';

export const CONTEXT_IMPORT_MAX_FILES = 10;
export const CONTEXT_IMPORT_MAX_BYTES = 25 * 1024 * 1024;

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  // Preserve these originals, but the resolver explains how to convert them.
  ppt: 'application/vnd.ms-powerpoint', xls: 'application/vnd.ms-excel',
};

export function contextFileProblem(file: File): string | null {
  if (file.size === 0) return 'This file is empty. Choose a copy that contains your document.';
  if (file.size > CONTEXT_IMPORT_MAX_BYTES) return 'This file is larger than 25 MB. Split it or export a smaller copy, then try again.';
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!FILE_TYPES[extension]) return 'We cannot read this format yet. Export it as PDF, Word, PowerPoint, Excel, text, or a PNG/JPG image, then upload that copy.';
  return null;
}

export function contextFileWithMimeType(file: File): File {
  if (file.type && file.type !== 'application/octet-stream') return file;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const type = FILE_TYPES[extension];
  return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
}

export interface ContextImportSource {
  attachmentId: string;
  fileName: string;
  contentHash: string;
}

export interface ResolvedContextImport {
  source: ContextImportSource;
  chunks: Array<{ token: string; index: number }>;
  warnings: string[];
}

export interface ImportedContextDocument {
  id: string;
  documentType: string;
  title: string;
  sections: Array<{
    heading: string;
    content: string;
    evidence: Array<{ sourceRef: string; quote: string }>;
  }>;
}

export interface AnalyzedContextImport {
  token: string | null;
  source: ContextImportSource;
  documents: ImportedContextDocument[];
  warnings: string[];
}

export interface SavedContextImport {
  documents: Array<{ id: string; title: string; templateKey: string }>;
  warnings: string[];
}

export function contextSourceLabel(sourceRef: string): string {
  const part = /#part(\d+)$/i.exec(sourceRef);
  const label = sourceRef.replace(/#part\d+$/i, '')
    .replace(/^page:(\d+)$/i, 'Page $1')
    .replace(/^slide:(\d+)$/i, 'Slide $1')
    .replace(/^sheet:(\d+):rows:(\d+)-(\d+)$/i, 'Sheet $1, rows $2–$3')
    .replace(/^sheet:(\d+)$/i, 'Sheet $1')
    .replace(/^section:(\d+)$/i, 'Section $1')
    .replace(/^paragraph:(\d+)$/i, 'Paragraph $1')
    .replace(/^text:(\d+)-(\d+)$/i, 'Text, characters $1–$2');
  return part ? `${label}, part ${part[1]}` : label;
}

export async function uploadContextSource(api: AxiosInstance, file: File, clientId: string) {
  const problem = contextFileProblem(file);
  if (problem) throw new Error(problem);
  return uploadOutreachAttachment(api, contextFileWithMimeType(file), clientId);
}

export async function resolveContextImport(
  api: AxiosInstance,
  input: { attachmentId: string; clientId: string; strategyId?: string },
): Promise<ResolvedContextImport> {
  return (await api.post<ResolvedContextImport>('/strategy-api/context/imports/resolve', input, { timeout: 180_000 })).data;
}

export async function analyzeContextImport(api: AxiosInstance, token: string): Promise<AnalyzedContextImport> {
  return (await api.post<AnalyzedContextImport>('/strategy-api/context/imports/analyze', { token }, { timeout: 180_000 })).data;
}

export async function saveContextImport(
  api: AxiosInstance,
  token: string,
  selectedDocumentIds: string[],
): Promise<SavedContextImport> {
  return (await api.post<SavedContextImport>('/strategy-api/context/imports/save', { token, selectedDocumentIds }, { timeout: 180_000 })).data;
}

export function contextImportError(error: unknown): string {
  const failure = error as { response?: { status?: number; data?: { message?: string | string[] } }; message?: string };
  if (failure?.response?.status === 403) return 'You do not have permission to add context here. Choose a strategy you can edit, or ask an administrator to add context for the whole client.';
  if (failure?.response?.status === 413) return 'This file is too large to process. Split it or export a smaller copy, then try again.';
  const message = failure?.response?.data?.message;
  if (Array.isArray(message)) return message.join(' ');
  if (typeof message === 'string' && message.trim()) return message;
  if (failure?.message) return failure.message;
  return 'We could not finish this file. Your completed work is still here. Try again.';
}

export function contextImportNeedsRefresh(error: unknown): boolean {
  const failure = error as { response?: { status?: number; data?: { code?: string } } };
  return failure?.response?.data?.code === 'CONTEXT_IMPORT_EXPIRED'
    || failure?.response?.data?.code === 'CONTEXT_IMPORT_SOURCE_CHANGED';
}
