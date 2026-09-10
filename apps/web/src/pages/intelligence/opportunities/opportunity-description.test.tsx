import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { opportunityDescriptionText } from './opportunity-description.js';

describe('opportunity source descriptions', () => {
  it('decodes CHEERS HTML and entities while preserving paragraphs and lists', () => {
    expect(
      opportunityDescriptionText(
        '<p>CHEERS <strong>S&amp;T</strong> research</p><p>Topics:</p><ul><li>Air &amp; space</li><li>R&amp;D</li></ul>',
      ),
    ).toBe('CHEERS S&T research\n\nTopics:\n\n• Air & space\n\n• R&D');
  });

  it('preserves plain text, line breaks, numeric entities and comparisons', () => {
    expect(opportunityDescriptionText('Budget < 5 million\nR&#38;D &nbsp; &#x2014; phase 2')).toBe(
      'Budget < 5 million\nR&D   — phase 2',
    );
    expect(opportunityDescriptionText('<p>A<br>B</p><p>C</p>')).toBe('A\nB\n\nC');
  });

  it('discards active content and never turns decoded markup into live elements', () => {
    const input =
      '<script>bad()</script><style>body{display:none}</style><iframe src="https://example.org">hidden</iframe>' +
      '<p onclick="bad()">Safe <a href="javascript:bad()">label</a><img src="x" onerror="bad()"></p>' +
      '&lt;img src=x onerror=bad()&gt;';
    const text = opportunityDescriptionText(input);
    const { container } = render(<p>{text}</p>);
    expect(container.textContent).toBe('Safe label\n<img src=x onerror=bad()>');
    expect(
      container.querySelector('script, style, iframe, img, a, [onclick], [onerror]'),
    ).toBeNull();
  });
});
