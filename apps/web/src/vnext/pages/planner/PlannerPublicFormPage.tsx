import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import type { PlannerPublicForm } from '@capiro/strategy-verifier';
import { config } from '../../../env.js';
import { plannerError } from './planner-api.js';
import './planner.css';

export function PlannerPublicFormPage() {
  const { token } = useParams();
  const path = `${config.apiBaseUrl.replace(/\/$/, '')}/strategy-api/planner/public/forms/${encodeURIComponent(token ?? '')}`;
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  const form = useQuery({
    queryKey: ['planner-public-form', token],
    queryFn: async () => (await axios.get<PlannerPublicForm>(path, { timeout: 30_000 })).data,
    retry: false,
  });
  const submit = useMutation({
    mutationFn: async () => axios.post(path, answers, { timeout: 30_000 }),
  });
  useEffect(() => {
    setAnswers({});
    submit.reset();
  }, [token, submit.reset]);
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
            <p>Your response has been sent to the team.</p>
          </>
        ) : (
          form.data && (
            <form
              key={token}
              onSubmit={(e) => {
                e.preventDefault();
                submit.mutate();
              }}
            >
              <h1>{form.data.name}</h1>
              <p>{form.data.description}</p>
              {form.data.fields.map((f) => (
                <label className="planner-field" key={f.id}>
                  <span>
                    {f.label}
                    {f.required ? ' *' : ''}
                  </span>
                  {f.type === 'paragraph' ? (
                    <textarea
                      rows={5}
                      required={f.required}
                      maxLength={50_000}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setAnswers((old) => ({ ...old, [f.id]: value }));
                      }}
                    />
                  ) : f.type === 'select' ? (
                    <select
                      required={f.required}
                      defaultValue=""
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setAnswers((old) => ({ ...old, [f.id]: value }));
                      }}
                    >
                      <option value="">Choose…</option>
                      {f.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      required={f.required}
                      type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                      maxLength={f.taskField === 'name' ? 500 : 50_000}
                      min={f.type === 'number' ? 0 : undefined}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        const answer =
                          f.type === 'number' ? (value === '' ? null : Number(value)) : value;
                        setAnswers((old) => ({ ...old, [f.id]: answer }));
                      }}
                    />
                  )}
                </label>
              ))}
              {submit.error && (
                <p role="alert" className="planner-error">
                  {plannerError(submit.error)}
                </p>
              )}
              <button className="planner-primary" disabled={submit.isPending}>
                {submit.isPending ? 'Sending…' : 'Submit request'}
              </button>
            </form>
          )
        )}
      </div>
    </main>
  );
}
