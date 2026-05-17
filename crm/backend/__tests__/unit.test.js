'use strict';

// Mocks needed because requiring routes/leads pulls in these modules
jest.mock('../db', () => ({ query: jest.fn(), on: jest.fn() }));
jest.mock('../utils/webinarConfigCache', () => ({ get: jest.fn(), set: jest.fn(), invalidate: jest.fn() }));
jest.mock('../utils/sseClients', () => ({ addClient: jest.fn(), removeClient: jest.fn(), broadcast: jest.fn() }));
jest.mock('../utils/adminConfig', () => ({
  readConfig:   jest.fn(() => ({ password: 'pw', reset_token: null, reset_expires: null })),
  writeConfig:  jest.fn(),
  getPassword:  jest.fn(() => 'pw'),
}));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));

const { _computeLeadScore: computeLeadScore, _getISTDayOfWeek: getISTDayOfWeek } = require('../routes/leads');

// ─── computeLeadScore ─────────────────────────────────────────────────────────
describe('computeLeadScore()', () => {
  test('pre + 150-250 → 2', () => expect(computeLeadScore('150-250', 'pre')).toBe(2));
  test('pre + 250+   → 2', () => expect(computeLeadScore('250+',    'pre')).toBe(2));
  test('150-250 + new  → 2', () => expect(computeLeadScore('150-250', 'new')).toBe(2));
  test('150-250 + mid  → 3', () => expect(computeLeadScore('150-250', 'mid')).toBe(3));
  test('150-250 + long → 4', () => expect(computeLeadScore('150-250', 'long')).toBe(4));
  test('250+ + new  → 3', () => expect(computeLeadScore('250+', 'new')).toBe(3));
  test('250+ + mid  → 4', () => expect(computeLeadScore('250+', 'mid')).toBe(4));
  test('250+ + long → 5 (capped at max)', () => expect(computeLeadScore('250+', 'long')).toBe(5));
  test('score never exceeds 5', () => expect(computeLeadScore('250+', 'long')).toBeLessThanOrEqual(5));
});

// ─── getISTDayOfWeek ──────────────────────────────────────────────────────────
describe('getISTDayOfWeek()', () => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  test('returns a valid 3-letter IST day abbreviation', () => {
    expect(DAYS).toContain(getISTDayOfWeek());
  });
});
