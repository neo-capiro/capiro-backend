import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { IdentityMark, identityInitials } from './index.js';

describe('Identity/Mark', () => {
  test('derives initials from the first and last meaningful word', () => {
    expect(identityInitials('Grace Hopper')).toBe('GH');
    // An honorific must not become an initial.
    expect(identityInitials('Rep. Elaine Morgan')).toBe('EM');
    expect(identityInitials('Sen. James A. Whitaker')).toBe('JW');
    expect(identityInitials('Prince')).toBe('P');
    expect(identityInitials('   ')).toBe('—');
  });

  test('people get circular geometry and org units do not', () => {
    const { container } = render(
      <div className="capiro-vnext-root">
        <IdentityMark kind="person" name="Grace Hopper" />
        <IdentityMark kind="committee" name="House Armed Services" />
        <IdentityMark kind="office" name="Office of Rep. Morgan" />
        <IdentityMark kind="program" name="PE 0604256F" />
      </div>,
    );
    expect(container.querySelector('.capiro-identity-mark--person')).toBeTruthy();
    expect(container.querySelector('.capiro-identity-mark--committee')).toBeTruthy();
    expect(container.querySelector('.capiro-identity-mark--office')).toBeTruthy();
    expect(container.querySelector('.capiro-identity-mark--program')).toBeTruthy();
  });

  test('falls back to initials when the image fails to load', () => {
    const { container } = render(
      <div className="capiro-vnext-root">
        <IdentityMark kind="person" name="Grace Hopper" imageUrl="https://example.invalid/x.png" />
      </div>,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    fireEvent.error(img);
    expect(screen.getByText('GH')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  test('an absent metadata line renders as unknown, not as an empty slot', () => {
    render(
      <div className="capiro-vnext-root">
        <IdentityMark kind="person" name="Grace Hopper" metadata={null} metadataVisible />
      </div>,
    );
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  test('the mark carries the accessible name only when it stands alone', () => {
    const { container: alone } = render(
      <div className="capiro-vnext-root">
        <IdentityMark kind="person" name="Grace Hopper" />
      </div>,
    );
    expect(alone.querySelector('[aria-label="Grace Hopper"]')).toBeTruthy();

    const { container: withCopy } = render(
      <div className="capiro-vnext-root">
        <IdentityMark kind="person" name="Grace Hopper" metadata="Legislative Director" metadataVisible />
      </div>,
    );
    // The visible name is the label; the mark must not repeat it to a reader.
    expect(withCopy.querySelector('[aria-label="Grace Hopper"]')).toBeNull();
    expect(withCopy.querySelector('.capiro-identity-mark[aria-hidden="true"]')).toBeTruthy();
  });
});
