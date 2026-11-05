import { BadRequestException } from '@nestjs/common';
import {
  asRecord,
  asString,
  asStringArray,
  fillFindingHash,
} from './client-profile-fill.helpers.js';

const SECTIONS = ['company', 'registration', 'leadership', 'lobbying', 'federal_footprint', 'news'];
const FIELDS = ['name', 'website', 'description', 'uei', 'cageCode', 'naicsCodes', 'pscCodes'];
export function prospectDocumentSchema(): Record<string, unknown> {
  const nullable = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['facts'],
    properties: {
      facts: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'section',
            'field',
            'text',
            'values',
            'name',
            'title',
            'email',
            'phone',
            'publishedAt',
            'url',
            'quote',
          ],
          properties: {
            section: { type: 'string', enum: SECTIONS },
            field: { anyOf: [{ type: 'string', enum: FIELDS }, { type: 'null' }] },
            text: nullable,
            values: { type: 'array', items: { type: 'string' }, maxItems: 40 },
            name: nullable,
            title: nullable,
            email: nullable,
            phone: nullable,
            publishedAt: nullable,
            url: nullable,
            quote: { type: 'string', minLength: 1, maxLength: 4000 },
          },
        },
      },
    },
  };
}

/** Each proposed fact retains a verbatim source quote; no section is filled from model memory. */
export function normalizeProspectDocumentFacts(data: unknown, sourceText: string) {
  const rows = asRecord(data).facts;
  if (!Array.isArray(rows) || rows.length > 40)
    throw new BadRequestException('Invalid document facts');
  return rows.map((raw) => {
    const row = asRecord(raw),
      section = asString(row.section),
      quote = asString(row.quote);
    if (
      !section ||
      !SECTIONS.includes(section) ||
      !quote ||
      quote.length > 4000 ||
      !sourceText.includes(quote)
    )
      throw new BadRequestException('Document fact has no supporting source quote');
    let kind: 'person' | 'profile_field' = 'profile_field',
      key: string,
      value: unknown;
    if (section === 'company' || section === 'registration') {
      const field = asString(row.field);
      if (
        !field ||
        !(
          section === 'company'
            ? ['name', 'website', 'description']
            : ['uei', 'cageCode', 'naicsCodes', 'pscCodes']
        ).includes(field)
      )
        throw new BadRequestException('Unsupported document field');
      value = field.endsWith('Codes') ? asStringArray(row.values) : asString(row.text);
      if (value === null || (Array.isArray(value) && !value.length))
        throw new BadRequestException('Empty document field');
      if (typeof value === 'string' && value.length > (field === 'website' ? 2048 : 600))
        throw new BadRequestException('Document field is too long');
      if (field === 'uei' || field === 'cageCode') {
        value = String(value).trim().toUpperCase();
        if (!(field === 'uei' ? /^[A-Z0-9]{12}$/ : /^[A-Z0-9]{5}$/).test(value as string))
          throw new BadRequestException('Invalid sourced registration identifier');
      }
      key = field;
    } else if (section === 'leadership') {
      const name = asString(row.name);
      if (!name || name.length > 200)
        throw new BadRequestException('Document contact needs a name');
      kind = 'person';
      value = {
        name,
        title: asString(row.title),
        email: asString(row.email),
        phone: asString(row.phone),
        role: 'client_contact',
      };
      key = `person:${name.toLowerCase()}`;
    } else {
      const summary = asString(row.text);
      if (!summary || summary.length > 3000)
        throw new BadRequestException('Document reference needs a bounded summary');
      const url = asString(row.url),
        date = asString(row.publishedAt);
      value = {
        title: asString(row.title) ?? summary.slice(0, 180),
        summary,
        url: url && sourceText.includes(url) && /^https?:\/\//.test(url) ? url : null,
        publishedAt:
          date && /^\d{4}-\d{2}-\d{2}$/.test(date) && sourceText.includes(date) ? date : null,
      };
      key = `${section === 'lobbying' ? 'lda_document' : section}.${fillFindingHash({ kind, source: 'client_document', targetKey: section, proposedValue: value })}`;
    }
    return { kind, targetKey: key, proposedValue: value, quote };
  });
}
