/**
 * MODULE 3 — Auth Tests: Admin middleware + forgot-password
 * Tests every token state and auth bypass attempt.
 */

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../utils/adminConfig', () => ({
  getPassword:  jest.fn(() => 'secret123'),
  readConfig:   jest.fn(() => ({ password: 'secret123', reset_token: null, reset_expires: null })),
  writeConfig:  jest.fn(),
}));
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test' }),
  })),
}));

const request = require('supertest');
const app     = require('../app');
const pool    = require('../db');

// Setup pool mock for admin routes that need DB
beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [{ next_webinar_at: null, backup_webinar_at: null, tuesday_whatsapp_link: '', friday_whatsapp_link: '', kill_switch: false, pending_whatsapp_link: '', whatsapp_link_swap_at: null, pending_whatsapp_link_2: '', whatsapp_link_swap_at_2: null }], rowCount: 1 });
});

describe('Admin Auth Middleware', () => {
  test('no Authorization header returns 401', async () => {
    const res = await request(app).get('/api/admin/leads');
    expect(res.status).toBe(401);
  });

  test('empty Bearer token returns 401', async () => {
    const res = await request(app).get('/api/admin/leads').set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
  });

  test('wrong password returns 401', async () => {
    const res = await request(app).get('/api/admin/leads').set('Authorization', 'Bearer wrongpassword');
    expect(res.status).toBe(401);
  });

  test('correct password returns 200', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get('/api/admin/leads').set('Authorization', 'Bearer secret123');
    expect(res.status).toBe(200);
  });

  test('SQL injection attempt in token returns 401', async () => {
    const res = await request(app).get('/api/admin/leads').set('Authorization', "Bearer ' OR '1'='1");
    expect(res.status).toBe(401);
  });

  test('token with trailing whitespace is trimmed and accepted', async () => {
    // Whitespace is trimmed before comparison — 'secret123 ' === 'secret123' after trim
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app).get('/api/admin/leads').set('Authorization', 'Bearer secret123 ');
    expect(res.status).toBe(200);
  });

  test('Basic auth (not Bearer) returns 401', async () => {
    const res = await request(app).get('/api/admin/leads').set('Authorization', 'Basic secret123');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/forgot-password', () => {
  test('returns 200 and success:true', async () => {
    const res = await request(app).post('/api/auth/forgot-password');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('is publicly accessible (no auth required)', async () => {
    const res = await request(app).post('/api/auth/forgot-password');
    expect(res.status).not.toBe(401);
  });
});

describe('POST /api/auth/reset-password', () => {
  test('missing token returns 422', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ new_password: 'newpass123' });
    expect(res.status).toBe(422);
  });

  test('short password (< 6 chars) returns 422', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'abc', new_password: '123' });
    expect(res.status).toBe(422);
  });

  test('invalid token returns 400', async () => {
    const { readConfig } = require('../utils/adminConfig');
    readConfig.mockReturnValue({ reset_token: 'real-token', reset_expires: new Date(Date.now() + 60000).toISOString() });
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'wrong-token', new_password: 'newpass123' });
    expect(res.status).toBe(400);
  });

  test('expired token returns 400', async () => {
    const { readConfig } = require('../utils/adminConfig');
    readConfig.mockReturnValue({ reset_token: 'real-token', reset_expires: new Date(Date.now() - 60000).toISOString() });
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'real-token', new_password: 'newpass123' });
    expect(res.status).toBe(400);
  });
});
