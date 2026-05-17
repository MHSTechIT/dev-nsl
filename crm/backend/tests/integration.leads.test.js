/**
 * MODULE 2 — Integration Tests: POST /api/leads
 * Tests the full request → validation → DB write cycle.
 * Uses a mocked DB pool so no real DB is needed.
 */

jest.mock('../db', () => ({
  query: jest.fn(),
}));

const request = require('supertest');
const app     = require('../app');
const pool    = require('../db');

const VALID_LEAD = {
  full_name:         'Ravi Kumar',
  whatsapp_number:   '9876543210',
  email:             'ravi@example.com',
  sugar_level:       '250+',
  diabetes_duration: 'long',
  language_pref:     'tamil',
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: config fetch returns normal config, lead insert returns row
  pool.query
    .mockResolvedValueOnce({ rows: [{ kill_switch: false, tuesday_whatsapp_link: 'https://chat.whatsapp.com/test', friday_whatsapp_link: 'https://chat.whatsapp.com/test' }] })
    .mockResolvedValueOnce({ rows: [{ id: 1, ...VALID_LEAD, wa_clicked: false, lead_score: 5 }] });
});

describe('POST /api/leads', () => {
  test('valid lead returns 201 with whatsapp_link', async () => {
    const res = await request(app).post('/api/leads').send(VALID_LEAD);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('whatsapp_link');
  });

  test('missing full_name returns 422', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, full_name: '' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('validation_failed');
  });

  test('invalid whatsapp number (9 digits) returns 422', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, whatsapp_number: '987654321' });
    expect(res.status).toBe(422);
  });

  test('invalid email returns 422', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, email: 'not-an-email' });
    expect(res.status).toBe(422);
  });

  test('invalid sugar_level returns 422', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, sugar_level: '100' });
    expect(res.status).toBe(422);
  });

  test('invalid language_pref returns 422', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, language_pref: 'hindi' });
    expect(res.status).toBe(422);
  });

  test('kill_switch active returns 409', async () => {
    pool.query.mockReset();
    pool.query.mockResolvedValueOnce({ rows: [{ kill_switch: true, tuesday_whatsapp_link: '', friday_whatsapp_link: '' }] });
    const res = await request(app).post('/api/leads').send(VALID_LEAD);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('registrations_paused');
  });

  test('name with numbers returns 422', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, full_name: 'Ravi123' });
    expect(res.status).toBe(422);
  });
});
