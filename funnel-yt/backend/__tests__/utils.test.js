'use strict';

// This file tests the real utility modules — NO top-level mocks for them.
// We only mock `fs` for adminConfig (filesystem isolation).

// ─── webinarConfigCache ───────────────────────────────────────────────────────
describe('webinarConfigCache', () => {
  let cache;

  beforeEach(() => {
    jest.resetModules();
    cache = require('../utils/webinarConfigCache');
    cache.invalidate(); // start clean
  });

  test('get() returns null when nothing cached', () => {
    expect(cache.get()).toBeNull();
  });

  test('set() then get() returns stored value', () => {
    const data = { kill_switch: false, seats_reserved: 1813 };
    cache.set(data);
    expect(cache.get()).toEqual(data);
  });

  test('invalidate() clears the cache', () => {
    cache.set({ foo: 'bar' });
    cache.invalidate();
    expect(cache.get()).toBeNull();
  });

  test('get() returns null after TTL expires (fake timers)', () => {
    jest.useFakeTimers();
    cache.set({ foo: 'bar' });
    jest.advanceTimersByTime(6 * 60 * 1000); // advance past 5-min TTL
    expect(cache.get()).toBeNull();
    jest.useRealTimers();
  });

  test('get() still returns value within TTL', () => {
    jest.useFakeTimers();
    cache.set({ foo: 'bar' });
    jest.advanceTimersByTime(4 * 60 * 1000); // 4 min — still fresh
    expect(cache.get()).toEqual({ foo: 'bar' });
    jest.useRealTimers();
  });
});

// ─── sseClients ───────────────────────────────────────────────────────────────
describe('sseClients', () => {
  let sseClients;

  beforeEach(() => {
    jest.resetModules();
    sseClients = require('../utils/sseClients');
  });

  test('broadcast() reaches an added client', () => {
    const fakeRes = { write: jest.fn() };
    sseClients.addClient(fakeRes);
    sseClients.broadcast({ test: 1 });
    expect(fakeRes.write).toHaveBeenCalledTimes(1);
    sseClients.removeClient(fakeRes);
  });

  test('broadcast() does not reach a removed client', () => {
    const fakeRes = { write: jest.fn() };
    sseClients.addClient(fakeRes);
    sseClients.removeClient(fakeRes);
    sseClients.broadcast({ test: 2 });
    expect(fakeRes.write).not.toHaveBeenCalled();
  });

  test('broadcast() writes valid SSE data: line', () => {
    const fakeRes = { write: jest.fn() };
    sseClients.addClient(fakeRes);
    sseClients.broadcast({ kill_switch: true });
    const payload = fakeRes.write.mock.calls[0][0];
    expect(payload).toMatch(/^data: /);
    const parsed = JSON.parse(payload.replace('data: ', '').trim());
    expect(parsed.kill_switch).toBe(true);
    sseClients.removeClient(fakeRes);
  });

  test('broadcast() silently drops a dead client that throws on write', () => {
    const deadRes = { write: jest.fn(() => { throw new Error('socket closed'); }) };
    sseClients.addClient(deadRes);
    expect(() => sseClients.broadcast({ x: 1 })).not.toThrow();
    // Client should have been auto-removed — second broadcast must not call write again
    sseClients.broadcast({ x: 2 });
    expect(deadRes.write).toHaveBeenCalledTimes(1);
  });
});

// ─── adminConfig ──────────────────────────────────────────────────────────────
describe('adminConfig', () => {
  let fs, adminConfig;

  beforeEach(() => {
    jest.resetModules();
    jest.mock('fs');
    fs = require('fs');
    adminConfig = require('../utils/adminConfig');
  });

  afterEach(() => jest.resetModules());

  test('readConfig() returns DEFAULTS when file does not exist', () => {
    fs.existsSync.mockReturnValue(false);
    expect(adminConfig.readConfig()).toEqual({ password: null, reset_token: null, reset_expires: null });
  });

  test('readConfig() merges file data over DEFAULTS', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({ password: 'secret', reset_token: 'abc' }));
    const cfg = adminConfig.readConfig();
    expect(cfg.password).toBe('secret');
    expect(cfg.reset_token).toBe('abc');
    expect(cfg.reset_expires).toBeNull();
  });

  test('readConfig() returns DEFAULTS when JSON is corrupt', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('NOT_JSON{{{');
    expect(adminConfig.readConfig()).toEqual({ password: null, reset_token: null, reset_expires: null });
  });

  test('writeConfig() merges and writes data to disk', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({ password: 'old', reset_token: null, reset_expires: null }));
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});

    adminConfig.writeConfig({ password: 'new' });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.password).toBe('new');
    expect(written.reset_token).toBeNull();
  });

  test('writeConfig() throws when fs.writeFileSync fails', () => {
    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => adminConfig.writeConfig({ password: 'x' })).toThrow('disk full');
  });

  test('getPassword() returns file password over env var', () => {
    process.env.ADMIN_PASSWORD = 'from_env';
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({ password: 'from_file', reset_token: null, reset_expires: null }));
    expect(adminConfig.getPassword()).toBe('from_file');
    delete process.env.ADMIN_PASSWORD;
  });

  test('getPassword() falls back to env var when file has null password', () => {
    process.env.ADMIN_PASSWORD = 'from_env';
    fs.existsSync.mockReturnValue(false);
    expect(adminConfig.getPassword()).toBe('from_env');
    delete process.env.ADMIN_PASSWORD;
  });

  test('getPassword() returns empty string when no file and no env var', () => {
    delete process.env.ADMIN_PASSWORD;
    fs.existsSync.mockReturnValue(false);
    expect(adminConfig.getPassword()).toBe('');
  });
});
