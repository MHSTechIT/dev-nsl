'use strict';

const mockQuery     = jest.fn();
jest.mock('../db', () => ({ query: mockQuery, on: jest.fn() }));

const mockCacheGet      = jest.fn(() => null);
const mockCacheSet      = jest.fn();
const mockCacheInvalidate = jest.fn();
jest.mock('../utils/webinarConfigCache', () => ({
  get: mockCacheGet,
  set: mockCacheSet,
  invalidate: mockCacheInvalidate,
}));

jest.mock('../utils/sseClients', () => ({ addClient: jest.fn(), removeClient: jest.fn(), broadcast: jest.fn() }));

const mockGetPassword = jest.fn(() => 'correctpassword');
const mockWriteConfig = jest.fn();
jest.mock('../utils/adminConfig', () => ({
  readConfig:  jest.fn(() => ({ password: 'correctpassword', reset_token: null, reset_expires: null })),
  writeConfig: mockWriteConfig,
  getPassword: mockGetPassword,
}));

jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));

const request = require('supertest');
const app     = require('../app');

const AUTH = { Authorization: 'Bearer correctpassword' };

// ─── Auth middleware ───────────────────────────────────────────────────────────
describe('adminAuth middleware', () => {
  test('401 – no Authorization header', async () => {
    const res = await request(app).get('/api/admin/leads');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  test('401 – wrong Bearer token', async () => {
    const res = await request(app)
      .get('/api/admin/leads')
      .set('Authorization', 'Bearer wrongpassword');
    expect(res.status).toBe(401);
  });

  test('401 – malformed header (no Bearer prefix)', async () => {
    const res = await request(app)
      .get('/api/admin/leads')
      .set('Authorization', 'correctpassword');
    expect(res.status).toBe(401);
  });

  test('401 – empty Bearer value', async () => {
    const res = await request(app)
      .get('/api/admin/leads')
      .set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
  });

  test('passes through with correct token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/admin/leads').set(AUTH);
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/admin/leads ─────────────────────────────────────────────────────
describe('GET /api/admin/leads', () => {
  test('200 – returns leads array and total', async () => {
    const fakeLead = { id: 1, full_name: 'Jane', email: 'jane@test.com', lead_score: 4 };
    mockQuery.mockResolvedValueOnce({ rows: [fakeLead] });

    const res = await request(app).get('/api/admin/leads').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].full_name).toBe('Jane');
    expect(res.body.total).toBe(1);
  });

  test('200 – empty table returns empty array', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/admin/leads').set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.leads).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('500 – DB error returns 500', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    const res = await request(app).get('/api/admin/leads').set(AUTH);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/fetch leads/i);
  });
});

// ─── PUT /api/admin/webinar-config ────────────────────────────────────────────
describe('PUT /api/admin/webinar-config', () => {
  const freshConfig = {
    next_webinar_at: '2026-05-01T10:00:00.000Z',
    backup_webinar_at: '2026-05-08T10:00:00.000Z',
    tuesday_whatsapp_link: 'https://wa.me/1',
    friday_whatsapp_link: 'https://wa.me/2',
    kill_switch: false,
    pending_whatsapp_link: '',
    whatsapp_link_swap_at: null,
  };

  test('200 – updates config and returns success', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ rowCount: 1 }] })  // UPDATE
      .mockResolvedValueOnce({ rows: [freshConfig] });       // SELECT fresh

    const res = await request(app)
      .put('/api/admin/webinar-config')
      .set(AUTH)
      .send({ kill_switch: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockCacheInvalidate).toHaveBeenCalled();
    expect(mockCacheSet).toHaveBeenCalled();
  });

  test('400 – no valid fields in body', async () => {
    const res = await request(app)
      .put('/api/admin/webinar-config')
      .set(AUTH)
      .send({ unknown_field: 'value' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fields/i);
  });

  test('422 – invalid ISO8601 date is rejected', async () => {
    const res = await request(app)
      .put('/api/admin/webinar-config')
      .set(AUTH)
      .send({ next_webinar_at: 'not-a-date' });

    expect(res.status).toBe(422);
  });

  test('500 – DB error returns 500', async () => {
    mockQuery.mockRejectedValueOnce(new Error('lock timeout'));

    const res = await request(app)
      .put('/api/admin/webinar-config')
      .set(AUTH)
      .send({ kill_switch: false });

    expect(res.status).toBe(500);
  });
});

// ─── PATCH /api/admin/change-password ────────────────────────────────────────
describe('PATCH /api/admin/change-password', () => {
  beforeEach(() => {
    mockGetPassword.mockReturnValue('correctpassword');
    mockWriteConfig.mockReset();
  });

  test('200 – correct current password updates to new password', async () => {
    mockWriteConfig.mockImplementation(() => {});

    const res = await request(app)
      .patch('/api/admin/change-password')
      .set(AUTH)
      .send({ current_password: 'correctpassword', new_password: 'newpassword123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockWriteConfig).toHaveBeenCalledWith({ password: 'newpassword123' });
  });

  test('401 – wrong current password is rejected', async () => {
    const res = await request(app)
      .patch('/api/admin/change-password')
      .set(AUTH)
      .send({ current_password: 'wrongpassword', new_password: 'newpassword123' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect/i);
  });

  test('422 – new password shorter than 6 chars', async () => {
    const res = await request(app)
      .patch('/api/admin/change-password')
      .set(AUTH)
      .send({ current_password: 'correctpassword', new_password: 'abc' });

    expect(res.status).toBe(422);
  });

  test('422 – missing current_password field', async () => {
    const res = await request(app)
      .patch('/api/admin/change-password')
      .set(AUTH)
      .send({ new_password: 'validpassword' });

    expect(res.status).toBe(422);
  });

  test('500 – writeConfig failure returns 500', async () => {
    mockWriteConfig.mockImplementation(() => { throw new Error('disk full'); });

    const res = await request(app)
      .patch('/api/admin/change-password')
      .set(AUTH)
      .send({ current_password: 'correctpassword', new_password: 'newpassword123' });

    expect(res.status).toBe(500);
  });
});
