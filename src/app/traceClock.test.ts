import { describe, expect, it } from 'vitest';
import { formatTimeOfDay } from './traceClock';

describe('formatTimeOfDay', () => {
  it('formats local hours, minutes, seconds and milliseconds, zero-padded', () => {
    const d = new Date();
    d.setHours(9, 5, 3, 7);
    expect(formatTimeOfDay(d.getTime())).toBe('09:05:03.007');
  });

  it('pads a full two-digit hour, minute and second, and three-digit milliseconds', () => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    expect(formatTimeOfDay(d.getTime())).toBe('23:59:59.999');
  });

  it('matches the HH:MM:SS.mmm shape exactly', () => {
    expect(formatTimeOfDay(Date.now())).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});
