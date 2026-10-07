import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlannerFormQuestion } from '@capiro/strategy-verifier';
import {
  PlannerFormQuestions,
  plannerFormSubmissionBody,
  plannerFormSubmissionError,
  type PlannerFormFiles,
} from './planner-form-questions.js';
const fields: PlannerFormQuestion[] = [
  {
    id: 'kind',
    label: 'Teams',
    description: 'Choose all that apply',
    type: 'multi_select',
    required: true,
    options: ['Design', 'Engineering'],
  },
  {
    id: 'details',
    label: 'Engineering details',
    type: 'paragraph',
    options: [],
    required: true,
    showWhen: { questionId: 'kind', values: ['Engineering'] },
  },
  {
    id: 'file',
    label: 'Reference files',
    type: 'attachment',
    multiple: true,
    required: true,
    options: [],
    showWhen: { questionId: 'kind', values: ['Engineering'] },
  },
];
afterEach(cleanup);
describe('Planner shared form questions', () => {
  it('shows multiple-choice branches, retains selected values, and clears hidden file drafts', () => {
    function Show() {
      const [answers, setAnswers] = useState<Record<string, unknown>>({});
      const [files, setFiles] = useState<PlannerFormFiles>({});
      return (
        <>
          <PlannerFormQuestions
            fields={fields}
            answers={answers}
            setAnswers={setAnswers}
            files={files}
            setFiles={setFiles}
          />
          <output data-testid="files">{Object.keys(files).join(',')}</output>
        </>
      );
    }
    render(<Show />);
    expect(screen.queryByLabelText('Engineering details *')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Engineering' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Design' }));
    expect(screen.getByRole('checkbox', { name: 'Engineering' })).toBeChecked();
    const file = new File(['Synthetic'], 'synthetic.txt');
    fireEvent.change(screen.getByLabelText('Reference files *'), { target: { files: [file] } });
    expect(screen.getByTestId('files')).toHaveTextContent('file');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Engineering' }));
    expect(screen.queryByLabelText('Reference files *')).not.toBeInTheDocument();
    expect(screen.getByTestId('files')).toBeEmptyDOMElement();
  });
  it('sends only visible answers and real files in multipart form data', () => {
    const file = new File(['Synthetic'], 'synthetic.txt');
    const body = plannerFormSubmissionBody(
      fields,
      { kind: ['Engineering'], details: 'Review these', file: ['forged'] },
      { file: [file] },
    ) as FormData;
    expect(JSON.parse(String(body.get('answers')))).toEqual({
      kind: ['Engineering'],
      details: 'Review these',
    });
    expect((body.get('file') as File).name).toBe('synthetic.txt');
    expect(
      plannerFormSubmissionBody(fields, { kind: ['Design'], details: 'Hidden' }, { file: [file] }),
    ).toEqual({ kind: ['Design'] });
    expect(
      plannerFormSubmissionError(fields, { kind: ['Engineering'], details: 'Details' }, {}),
    ).toBe('Reference files is required.');
    expect(plannerFormSubmissionError(fields, { kind: ['Design'] }, {})).toBeNull();
    expect(
      plannerFormSubmissionError(
        fields,
        { kind: ['Engineering'], details: 'Details' },
        { file: Array(11).fill(file) },
      ),
    ).toContain('ten files');
  });
});
