import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

describe('App', () => {
  it('uses pressed-button semantics for the analysis mode switch', () => {
    render(<App />);

    const publicButton = screen.getByRole('button', { name: /search - gse analysis/i });
    const privateButton = screen.getByRole('button', { name: /private analysis/i });

    expect(publicButton).toHaveAttribute('aria-pressed', 'true');
    expect(privateButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(privateButton);

    expect(publicButton).toHaveAttribute('aria-pressed', 'false');
    expect(privateButton).toHaveAttribute('aria-pressed', 'true');
  });
});
