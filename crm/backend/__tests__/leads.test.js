'use strict';

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: mockQuery, on: jest.fn() }));
jest.mock('../utils/webinarConfigCache', () => ({ get: jest.fn(() => null), set: jest.fn(), invalidate: jest.fn() }));
jest.mock('../utils/sseClients', () => ({ addClient: jest.fn(), removeClient: jest.fn(), broadcast: jest.fn() }));
jest.mock('../utils/adminConfig', () => ({
  readConfig:  jest.fn(() => ({})),
  writeConfig: jest.fn(),
  getPassword: jest.fn(() => 'pw'),
}));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));

const request = require('supertest');
const app     = require('../app');

const VALID_LEAD = {
  full_name:         'John Doe',
  whatsapp_number:   '9876543210',
  email:             'john@example.com',
  sugar_level:       '250+',
  diabetes_duration: 'long',
  language_pref:     'english',
};

const CONFIG_ROW = {
  kill_switch: false,
  tuesday_whatsapp_link: 'https://chat.whatsapp.com/tuesday',
  friday_whatsapp_link:  'https://chat.whatsapp.com/friday',
};

// ─── POST /api/leads ──────────────────────────────────────────────────────────
describe('POST /api/leads', () => {
  test('201 – valid submission → returns lead_id and lead_score', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONFIG_ROW] })   // config fetch
      .mockResolvedValueOnce({ rows: [{ id: 99 }] });  // INSERT

    const res = await request(app).post('/api/leads').send(VALID_LEAD);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.lead_id).toBe(99);
    expect(res.body.lead_score).toBe(5);          // 250+ + long = 5
    expect(typeof res.body.whatsapp_link).toBe('string');
  });

  test('lead_score = 2 for pre-diabetes', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONFIG_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });

    const res = await request(app).post('/api/leads').send({
      ...VALID_LEAD,
      sugar_level: '150-250',
      diabetes_duration: 'pre',
    });

    expect(res.status).toBe(201);
    expect(res.body.lead_score).toBe(2);
  });

  test('lead_score = 3 for 250+ + new', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONFIG_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });

    const res = await request(app).post('/api/leads').send({
      ...VALID_LEAD,
      diabetes_duration: 'new',
    });

    expect(res.status).toBe(201);
    expect(res.body.lead_score).toBe(3);
  });

  test('whatsapp_link is one of the two configured links', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONFIG_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 3 }] });

    const res = await request(app).post('/api/leads').send(VALID_LEAD);

    expect([CONFIG_ROW.tuesday_whatsapp_link, CONFIG_ROW.friday_whatsapp_link])
      .toContain(res.body.whatsapp_link);
  });

  // ── Validation failures ─────────────────────────────────────────────────────
  test('422 – invalid email', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.body.fields).toContain('email');
  });

  test('422 – invalid phone (non-10-digit)', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, whatsapp_number: '12345' });
    expect(res.status).toBe(422);
    expect(res.body.fields).toContain('whatsapp_number');
  });

  test('422 – full_name with numbers is rejected', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, full_name: 'John123' });
    expect(res.status).toBe(422);
    expect(res.body.fields).toContain('full_name');
  });

  test('422 – full_name too short (1 char)', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, full_name: 'J' });
    expect(res.status).toBe(422);
  });

  test('422 – invalid sugar_level value', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, sugar_level: '100' });
    expect(res.status).toBe(422);
    expect(res.body.fields).toContain('sugar_level');
  });

  test('422 – invalid diabetes_duration value', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, diabetes_duration: 'unknown' });
    expect(res.status).toBe(422);
    expect(res.body.fields).toContain('diabetes_duration');
  });

  test('422 – invalid language_pref value', async () => {
    const res = await request(app).post('/api/leads').send({ ...VALID_LEAD, language_pref: 'french' });
    expect(res.status).toBe(422);
    expect(res.body.fields).toContain('language_pref');
  });

  test('422 – multiple fields invalid at once', async () => {
    const res = await request(app).post('/api/leads').send({
      full_name: 'J',
      whatsapp_number: 'abc',
      email: 'bad',
      sugar_level: 'bad',
      diabetes_duration: 'bad',
      language_pref: 'bad',
    });
    expect(res.status).toBe(422);
    expect(res.body.fields.length).toBeGreaterThan(1);
  });

  // ── Kill switch ─────────────────────────────────────────────────────────────
  test('409 – kill_switch = true blocks registration', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...CONFIG_ROW, kill_switch: true }] });

    const res = await request(app).post('/api/leads').send(VALID_LEAD);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('registrations_paused');
  });

  // ── DB failure handling ─────────────────────────────────────────────────────
  test('201 – config fetch failure falls back to defaults (no kill_switch)', async () => {
    mockQuery
      .mockRejectedValueOnce(new Error('config table missing')) // config fetch fails
      .mockResolvedValueOnce({ rows: [{ id: 10 }] });           // INSERT succeeds

    const res = await request(app).post('/api/leads').send(VALID_LEAD);

    expect(res.status).toBe(201);
  });

  test('500 – INSERT failure returns 500', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONFIG_ROW] })
      .mockRejectedValueOnce(new Error('unique constraint violation'));

    const res = await request(app).post('/api/leads').send(VALID_LEAD);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
  });

  // ── UTM params are optional ──────────────────────────────────────────────────
  test('201 – UTM params are accepted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONFIG_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 20 }] });

    const res = await request(app).post('/api/leads').send({
      ...VALID_LEAD,
      utm_source:   'facebook',
      utm_campaign: 'diabetes_awareness',
      utm_content:  'video_ad',
      fbclid:       'abc123',
    });

    expect(res.status).toBe(201);
    expect(res.body.lead_id).toBe(20);
  });
});

// ─── PATCH /api/leads/:id/wa-click ───────────────────────────────────────────
describe('PATCH /api/leads/:id/wa-click', () => {
  test('200 – valid id updates wa_clicked', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app).patch('/api/leads/42/wa-click');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('wa_clicked = true'),
      ['42']
    );
  });

  test('200 – non-existent id still returns success (no 404 guard)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app).patch('/api/leads/9999/wa-click');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('500 – DB error returns failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    const res = await request(app).patch('/api/leads/1/wa-click');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
