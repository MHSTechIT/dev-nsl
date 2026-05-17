'use strict';

jest.mock('../db', () => ({ query: jest.fn(), on: jest.fn() }));
jest.mock('../utils/webinarConfigCache', () => ({ get: jest.fn(), set: jest.fn(), invalidate: jest.fn() }));
jest.mock('../utils/sseClients', () => ({ addClient: jest.fn(), removeClient: jest.fn(), broadcast: jest.fn() }));

const mockReadConfig  = jest.fn();
const mockWriteConfig = jest.fn();
const mockGetPassword = jest.fn(() => 'testpassword');

jest.mock('../utils/adminConfig', () => ({
  readConfig:  mockReadConfig,
  writeConfig: mockWriteConfig,
  getPassword: mockGetPassword,
}));

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const request = require('supertest');
const app     = require('../app');

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => {
    mockWriteConfig.mockReset();
    mockSendMail.mockReset();
  });

  test('200 – writes token to file and sends email', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'ok' });

    const res = await request(app).post('/api/auth/forgot-password').send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    const written = mockWriteConfig.mock.calls[0][0];
    expect(written).toHaveProperty('reset_token');
    expect(written).toHaveProperty('reset_expires');
    expect(typeof written.reset_token).toBe('string');
    expect(written.reset_token).toHaveLength(64); // 32 bytes hex
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test('500 – returns error when sendMail throws', async () => {
    mockSendMail.mockRejectedValue(new Error('SMTP down'));

    const res = await request(app).post('/api/auth/forgot-password').send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/reset email/i);
  });

  test('reset URL in email contains the generated token', async () => {
    let capturedHtml = '';
    mockSendMail.mockImplementation(async (opts) => {
      capturedHtml = opts.html;
      return { messageId: 'ok' };
    });

    await request(app).post('/api/auth/forgot-password').send({});

    const token = mockWriteConfig.mock.calls[0][0].reset_token;
    expect(capturedHtml).toContain(token);
  });
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
describe('POST /api/auth/reset-password', () => {
  const VALID_TOKEN   = 'a'.repeat(64);
  const FUTURE_EXPIRY = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const PAST_EXPIRY   = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  beforeEach(() => {
    mockReadConfig.mockReset();
    mockWriteConfig.mockReset();
  });

  test('200 – valid token + new password succeeds', async () => {
    mockReadConfig.mockReturnValue({ reset_token: VALID_TOKEN, reset_expires: FUTURE_EXPIRY });
    mockWriteConfig.mockImplementation(() => {});

    const res = await request(app).post('/api/auth/reset-password').send({
      token: VALID_TOKEN,
      new_password: 'newStrongPass',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    const written = mockWriteConfig.mock.calls[0][0];
    expect(written.password).toBe('newStrongPass');
    expect(written.reset_token).toBeNull();
    expect(written.reset_expires).toBeNull();
  });

  test('422 – password shorter than 6 chars is rejected', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({
      token: VALID_TOKEN,
      new_password: 'abc',
    });
    expect(res.status).toBe(422);
  });

  test('422 – missing token field is rejected', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({
      new_password: 'validpassword',
    });
    expect(res.status).toBe(422);
  });

  test('400 – wrong token is rejected', async () => {
    mockReadConfig.mockReturnValue({ reset_token: 'correct_token', reset_expires: FUTURE_EXPIRY });

    const res = await request(app).post('/api/auth/reset-password').send({
      token: 'wrong_token',
      new_password: 'validpassword',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('400 – expired token is rejected', async () => {
    mockReadConfig.mockReturnValue({ reset_token: VALID_TOKEN, reset_expires: PAST_EXPIRY });

    const res = await request(app).post('/api/auth/reset-password').send({
      token: VALID_TOKEN,
      new_password: 'validpassword',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('400 – null token in file is rejected', async () => {
    mockReadConfig.mockReturnValue({ reset_token: null, reset_expires: FUTURE_EXPIRY });

    const res = await request(app).post('/api/auth/reset-password').send({
      token: VALID_TOKEN,
      new_password: 'validpassword',
    });

    expect(res.status).toBe(400);
  });

  test('500 – writeConfig failure returns 500', async () => {
    mockReadConfig.mockReturnValue({ reset_token: VALID_TOKEN, reset_expires: FUTURE_EXPIRY });
    mockWriteConfig.mockImplementation(() => { throw new Error('disk full'); });

    const res = await request(app).post('/api/auth/reset-password').send({
      token: VALID_TOKEN,
      new_password: 'validpassword',
    });

    expect(res.status).toBe(500);
  });
});
