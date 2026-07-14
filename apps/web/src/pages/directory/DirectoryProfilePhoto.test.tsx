import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { DirectoryProfilePhoto, personInitials } from './DirectoryProfilePhoto.js';

function setupAntdBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

beforeAll(setupAntdBrowserMocks);

describe('personInitials', () => {
  test('handles two-word, single-word, and empty names', () => {
    expect(personInitials('Mike Rogers')).toBe('MR');
    expect(personInitials('Grace Brewster Hopper')).toBe('GH');
    expect(personInitials('Cher')).toBe('CH');
    expect(personInitials('')).toBe('?');
    expect(personInitials('   ')).toBe('?');
  });
});

describe('DirectoryProfilePhoto', () => {
  test('falls back to initials when no url is provided', () => {
    render(<DirectoryProfilePhoto url={null} name="Grace Hopper" />);
    expect(screen.getByText('GH')).toBeInTheDocument();
  });

  test('renders without crashing when a url is provided', () => {
    const { container } = render(<DirectoryProfilePhoto url="https://x.invalid/p.jpg" name="Mike Rogers" />);
    expect(container.querySelector('.ant-avatar')).toBeTruthy();
  });
});
