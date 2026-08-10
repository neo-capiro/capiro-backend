import { useState, type FormEvent } from 'react';

export interface GlobalSearchProps {
  placeholder?: string;
  shortcut?: string;
  onSubmit?: (query: string) => void;
}

export function GlobalSearch({
  placeholder = 'Search clients, issues, programs, people…',
  shortcut = '⌘K',
  onSubmit,
}: GlobalSearchProps) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = value.trim();
    if (query) onSubmit?.(query);
  };
  return (
    <form className="capiro-global-search" role="search" onSubmit={submit}>
      <label className="capiro-global-search__label" htmlFor="capiro-vnext-global-search">
        Global search
      </label>
      <div className="capiro-global-search__control">
        <span className="capiro-global-search__glyph" aria-hidden="true">⌕</span>
        <input
          id="capiro-vnext-global-search"
          className="capiro-global-search__input"
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
        />
        <span className="capiro-global-search__shortcut" aria-hidden="true">{shortcut}</span>
      </div>
    </form>
  );
}
