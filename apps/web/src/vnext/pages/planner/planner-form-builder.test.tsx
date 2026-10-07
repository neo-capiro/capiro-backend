import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PLANNER_DEFAULT_PROJECT,
  type PlannerFormData,
  type PlannerFormField,
} from '@capiro/strategy-verifier';
import { PlannerFormBuilder, plannerDuplicateFormData } from './planner-form-builder.js';
const field = (id: string, patch: Partial<PlannerFormField> = {}): PlannerFormField => ({
  id,
  label: id,
  type: 'text',
  taskField: null,
  options: [],
  required: false,
  ...patch,
});
const config = (fields: PlannerFormField[]): PlannerFormData => ({
  description: '',
  enabled: true,
  titleFieldId: null,
  fields,
  defaults: { assigneeId: null, status: 'todo', priority: 'none', estimateMinutes: 0 },
  copyAnswersToDescription: true,
  audience: 'organization',
});
const project = {
  ...PLANNER_DEFAULT_PROJECT,
  fields: [
    {
      id: 'type-field',
      name: 'Request type',
      type: 'multi_select' as const,
      options: ['Design', 'Engineering'],
    },
  ],
  sections: [{ id: 'intake', name: 'Intake' }],
};
function Show({ initial }: { initial: PlannerFormData }) {
  const [form, setForm] = useState(initial);
  return (
    <>
      <PlannerFormBuilder
        form={form}
        edit={(patch) => setForm((old) => ({ ...old, ...patch }))}
        project={project}
        people={[]}
      />
      <output data-testid="config">{JSON.stringify(form)}</output>
    </>
  );
}
const current = () => JSON.parse(screen.getByTestId('config').textContent!) as PlannerFormData;
afterEach(cleanup);
describe('Planner form builder workflows', () => {
  it('keeps a legacy name question as the chosen title when its type or mapping changes', () => {
    const legacy = config([field('Request', { required: true, taskField: 'name' })]);
    delete legacy.titleFieldId;
    render(<Show initial={legacy} />);
    fireEvent.change(screen.getByLabelText('Question type'), { target: { value: 'select' } });
    expect(current()).toMatchObject({
      titleFieldId: 'Request',
      fields: [{ id: 'Request', type: 'select', taskField: null }],
    });
  });
  it('maps a question to a current custom field and allows descriptions, multi-choice options and branch conditions', () => {
    render(<Show initial={config([field('Request'), field('Details')])} />);
    const first = within(screen.getByRole('group', { name: 'Question 1' }));
    fireEvent.change(first.getByLabelText('Save answer to'), {
      target: { value: 'custom:type-field' },
    });
    fireEvent.change(first.getByLabelText('Question description'), {
      target: { value: 'Choose every relevant team.' },
    });
    const second = within(screen.getByRole('group', { name: 'Question 2' }));
    fireEvent.change(second.getByLabelText('Show this question'), { target: { value: 'Request' } });
    expect(current().fields[0]).toMatchObject({
      type: 'multi_select',
      taskField: 'custom',
      customFieldId: 'type-field',
      options: ['Design', 'Engineering'],
      description: 'Choose every relevant team.',
    });
    expect(current().fields[1]?.showWhen).toEqual({ questionId: 'Request', values: ['Design'] });
  });
  it('preserves parent ordering and requires branch reconnection before removing a parent', () => {
    render(
      <Show
        initial={config([
          field('Parent', { type: 'select', options: ['Yes'] }),
          field('Child', { showWhen: { questionId: 'Parent', values: ['Yes'] } }),
          field('Independent'),
        ])}
      />,
    );
    expect(screen.getByRole('button', { name: 'Remove question 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move question 2 up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move question 3 up' }));
    expect(current().fields.map((question) => question.id)).toEqual([
      'Parent',
      'Independent',
      'Child',
    ]);
    const child = within(screen.getByRole('group', { name: 'Question 3 · Branch level 1' }));
    fireEvent.change(child.getByLabelText('Show this question'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove question 1' }));
    expect(current().fields.map((question) => question.id)).toEqual(['Independent', 'Child']);
  });
  it('previews branches without marking required preview inputs as required or submitting answers', () => {
    render(
      <Show
        initial={config([
          field('Kind', { type: 'select', options: ['Design', 'Engineering'], required: true }),
          field('Engineering details', {
            required: true,
            showWhen: { questionId: 'Kind', values: ['Engineering'] },
          }),
        ])}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview form' }));
    const preview = within(screen.getByRole('region', { name: 'Form preview' }));
    expect(preview.queryByLabelText('Engineering details *')).not.toBeInTheDocument();
    fireEvent.change(preview.getByLabelText('Kind *'), { target: { value: 'Engineering' } });
    expect(preview.getByLabelText('Engineering details *')).not.toBeRequired();
    fireEvent.input(preview.getByLabelText('Engineering details *'), {
      target: { value: 'Preview only' },
    });
    expect(JSON.stringify(current())).not.toContain('Preview only');
  });
  it('copies a form with fresh question identities and reconnects title and branch references', () => {
    const original = {
      ...config([
        field('Parent', { type: 'select', options: ['Yes'] }),
        field('Child', { showWhen: { questionId: 'Parent', values: ['Yes'] } }),
      ]),
      titleFieldId: 'Child',
      sectionId: 'intake',
    };
    const copied = plannerDuplicateFormData(original);
    expect(copied.fields.map((question) => question.id)).not.toEqual(['Parent', 'Child']);
    expect(copied.fields[1]?.showWhen?.questionId).toBe(copied.fields[0]?.id);
    expect(copied.titleFieldId).toBe(copied.fields[1]?.id);
    expect(copied.sectionId).toBe('intake');
    copied.fields[0]!.options.push('Other');
    expect(original.fields[0]?.options).toEqual(['Yes']);
  });
  it('allows a form-name title and retains an explicit section reset in the API patch', () => {
    render(
      <Show
        initial={{
          ...config([field('Request')]),
          titleFieldId: 'Request',
          sectionId: 'old-section',
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Task section'), { target: { value: '__first' } });
    expect(current()).toMatchObject({ titleFieldId: null, sectionId: 'intake' });
  });
});
