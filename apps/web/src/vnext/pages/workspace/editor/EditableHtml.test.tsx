import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { EditableHtml } from './EditableHtml.js';

afterEach(cleanup);

const props = { section: 'Analysis', placeholder: 'Write analysis', readOnly: false };

test('parent updates preserve the text node and caret while typing several characters', () => {
  function Document() {
    const [value, setValue] = useState('<p>Evidence</p>');
    return <EditableHtml {...props} value={value} onChange={setValue} />;
  }
  render(<Document />);
  const editor = screen.getByRole('textbox', { name: 'Analysis body' });
  editor.focus();
  const text = editor.querySelector('p')!.firstChild as Text;
  const selection = window.getSelection()!;
  for (const character of ' reviewed') {
    text.appendData(character);
    selection.collapse(text, text.length);
    fireEvent.input(editor);
    expect(editor.querySelector('p')!.firstChild).toBe(text);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(text.length);
  }
  expect(editor.textContent).toBe('Evidence reviewed');
});

test('unfocused external revisions refresh the document and focused input survives a parent refresh', () => {
  const onChange = vi.fn();
  const view = render(<EditableHtml {...props} value="<p>First</p>" onChange={onChange} />);
  const editor = screen.getByRole('textbox');
  view.rerender(<EditableHtml {...props} value="<p>Second</p>" onChange={onChange} />);
  expect(editor.innerHTML).toBe('<p>Second</p>');
  editor.focus();
  editor.innerHTML = '<p>Local edit</p>';
  fireEvent.input(editor);
  view.rerender(<EditableHtml {...props} value="<p>External refresh</p>" onChange={onChange} />);
  expect(editor.textContent).toBe('Local edit');
  fireEvent.blur(editor);
  expect(onChange).toHaveBeenLastCalledWith('<p>Local edit</p>');
});

test('blur sanitizes pasted markup and read-only documents never submit an edit', () => {
  const onChange = vi.fn();
  const view = render(<EditableHtml {...props} value="<p>Safe</p>" onChange={onChange} />);
  const editor = screen.getByRole('textbox');
  editor.innerHTML = '<p onclick="alert(1)">Reviewed</p>';
  fireEvent.blur(editor);
  expect(onChange).toHaveBeenLastCalledWith('<p>Reviewed</p>');
  onChange.mockClear();
  view.rerender(<EditableHtml {...props} readOnly value="<p>Approved</p>" onChange={onChange} />);
  expect(editor.getAttribute('contenteditable')).toBe('false');
  fireEvent.input(editor);
  fireEvent.blur(editor);
  expect(onChange).not.toHaveBeenCalled();
});
