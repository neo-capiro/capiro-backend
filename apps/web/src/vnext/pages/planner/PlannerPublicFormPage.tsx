import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import type { PlannerPublicForm } from '@capiro/strategy-verifier';
import { config } from '../../../env.js';
import { plannerError } from './planner-api.js';
import {
  PlannerFormQuestions,
  plannerFormSubmissionBody,
  plannerFormSubmissionError,
  type PlannerFormFiles,
} from './planner-form-questions.js';
import './planner.css';

export function PlannerPublicFormPage() {
  const { token } = useParams();
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  // A different capability always receives a new draft and mutation lifecycle.
  return <PublicFormIntake key={token} token={token ?? ''} />;
}

function PublicFormIntake({ token }: { token: string }) {
  const path = `${config.apiBaseUrl.replace(/\/$/, '')}/strategy-api/planner/public/forms/${encodeURIComponent(token)}`;
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState<PlannerFormFiles>({});
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(0);
  const sending = useRef(false);
  const form = useQuery({
    queryKey: ['planner-public-form', token],
    queryFn: async () => (await axios.get<PlannerPublicForm>(path, { timeout: 30_000 })).data,
    retry: false,
  });
  const submit = useMutation({
    mutationFn: async (body: Record<string, unknown> | FormData) =>
      axios.post(path, body, { timeout: 30_000 }),
  });
  return (
    <main className="planner-root planner-public-form">
      <div className="planner-public-card">
        <p className="planner-eyebrow">Capiro Planner</p>
        {form.isPending ? (
          <p role="status">Loading form…</p>
        ) : form.isError ? (
          <p role="alert">This form is unavailable or has been closed.</p>
        ) : submit.isSuccess ? (
          <>
            <h1>Request received</h1>
            <p className="planner-form-message">
              {form.data.confirmationMessage || 'Your response has been sent to the team.'}
            </p>
            {form.data.allowAnotherSubmission && (
              <button
                className="planner-primary"
                onClick={() => {
                  setAnswers({});
                  setFiles({});
                  setError(null);
                  setDraft((old) => old + 1);
                  submit.reset();
                }}
              >
                Submit another response
              </button>
            )}
          </>
        ) : (
          <form
            key={draft}
            onSubmit={async (event) => {
              event.preventDefault();
              if (sending.current) return;
              const problem = plannerFormSubmissionError(form.data.fields, answers, files);
              setError(problem);
              if (problem) return;
              sending.current = true;
              try {
                await submit.mutateAsync(
                  plannerFormSubmissionBody(form.data.fields, answers, files),
                );
              } catch {
              } finally {
                sending.current = false;
              }
            }}
          >
            <h1>{form.data.name}</h1>
            <p className="planner-form-message">{form.data.description}</p>
            <PlannerFormQuestions
              fields={form.data.fields}
              answers={answers}
              setAnswers={setAnswers}
              files={files}
              setFiles={setFiles}
            />
            {(error || submit.error) && (
              <p role="alert" className="planner-error">
                {error || plannerError(submit.error)}
              </p>
            )}
            <button className="planner-primary" disabled={submit.isPending}>
              {submit.isPending ? 'Sending…' : 'Submit request'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
