'use strict';

const mockQuery = jest.fn();
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
jest.mock('../utils/adminConfig', () => ({
  readConfig:  jest.fn(() => ({})),
  writeConfig: jest.fn(),
  getPassword: jest.fn(() => 'pw'),
}));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));

const request = require('supertest');
const app     = require('../app');

const DB_CONFIG = {
  next_webinar_at:       '2026-05-01T10:00:00.000Z',
  backup_webinar_at:     '2026-05-08T10:00:00.000Z',
  tuesday_whatsapp_link: 'https://wa.me/tuesday',
  friday_whatsapp_link:  'https://wa.me/friday',
  kill_switch:           false,
  pending_whatsapp_link: '',
  whatsapp_link_swap_at: null,
};

// ─── GET /api/webinar-config ──────────────────────────────────────────────────
describe('GET /api/webinar-config', () => {
  test('200 – returns cached data when cache is warm (no DB call)', async () => {
    const cached = { ...DB_CONFIG, seats_reserved: 1900 };
    mockCacheGet.mockReturnValueOnce(cached);

    const res = await request(app).get('/api/webinar-config');

    expect(res.status).toBe(200);
    expect(res.body.seats_reserved).toBe(1900);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('200 – queries DB and sets cache when cache is cold', async () => {
    mockCacheGet.mockReturnValue(null);
    mockQuery
      .mockResolvedValueOnce({ rows: [DB_CONFIG] })           // webinar_config SELECT
      .mockResolvedValueOnce({ rows: [{ count: '87' }] });    // leads COUNT

    const res = await request(app).get('/api/webinar-config');

    expect(res.status).toBe(200);
    expect(res.body.kill_switch).toBe(false);
    expect(res.body.seats_reserved).toBe(1813 + 87);
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
  });

  test('200 – returns DEFAULT_CONFIG + 1813 seats when DB has no rows', async () => {
    mockCacheGet.mockReturnValue(null);
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                    // no config row
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/api/webinar-config');

    expect(res.status).toBe(200);
    expect(res.body.seats_reserved).toBe(1813);
    expect(res.body.kill_switch).toBe(false);
  });

  test('200 – falls back to DEFAULT_CONFIG when DB throws', async () => {
    mockCacheGet.mockReturnValue(null);
    mockQuery.mockRejectedValue(new Error('DB unreachable'));

    const res = await request(app).get('/api/webinar-config');

    expect(res.status).toBe(200);
    expect(res.body.seats_reserved).toBe(1813);
    expect(res.body.kill_switch).toBe(false);
  });

  test('Cache-Control header is no-store on a DB hit', async () => {
    mockCacheGet.mockReturnValue(null);
    mockQuery
      .mockResolvedValueOnce({ rows: [DB_CONFIG] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/api/webinar-config');

    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('Cache-Control header is no-store on a cache hit', async () => {
    mockCacheGet.mockReturnValueOnce({ ...DB_CONFIG, seats_reserved: 1850 });

    const res = await request(app).get('/api/webinar-config');

    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('seats_reserved = 1813 + real lead count', async () => {
    mockCacheGet.mockReturnValue(null);
    mockQuery
      .mockResolvedValueOnce({ rows: [DB_CONFIG] })
      .mockResolvedValueOnce({ rows: [{ count: '200' }] });

    const res = await request(app).get('/api/webinar-config');

    expect(res.body.seats_reserved).toBe(2013);
  });
});

// ─── GET /api/webinar-config/events (SSE) ────────────────────────────────────
describe('GET /api/webinar-config/events (SSE)', () => {
  const http = require('http');
  const { addClient, removeClient } = require('../utils/sseClients');

  test('responds with correct SSE headers', (done) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.get(`http://localhost:${port}/api/webinar-config/events`, (res) => {
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.headers['connection']).toBe('keep-alive');
        req.destroy();
        server.close(done);
      });
      req.on('error', done);
    });
  });

  test('calls addClient on connect and removeClient on close', (done) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.get(`http://localhost:${port}/api/webinar-config/events`, () => {
        expect(addClient).toHaveBeenCalled();
        req.destroy();
        setTimeout(() => {
          expect(removeClient).toHaveBeenCalled();
          server.close(done);
        }, 50);
      });
      req.on('error', done);
    });
  });
});

// ─── GET /api/health ──────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  test('200 – returns { ok: true }', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
