import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from '../tools/bridge.mjs';

describe('UCI bridge Origin verification', () => {
  it('allows production Vercel origin and localhost/127.0.0.1 origins', () => {
    expect(isAllowedOrigin('https://tichess.vercel.app')).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4173')).toBe(true);
    expect(isAllowedOrigin('https://localhost:3000')).toBe(true);
  });

  it('rejects arbitrary websites and missing origins', () => {
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('https://tichess.vercel.app.evil.com')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedOrigin('')).toBe(false);
    expect(isAllowedOrigin(undefined)).toBe(false);
  });

  it('supports explicit extra origins via ALLOWED_ORIGINS', () => {
    expect(isAllowedOrigin('https://custom.domain.dev', ['https://custom.domain.dev'])).toBe(true);
  });
});
