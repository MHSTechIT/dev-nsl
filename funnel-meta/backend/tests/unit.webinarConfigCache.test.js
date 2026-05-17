/**
 * MODULE 1 — Unit Tests: webinarConfigCache
 * Tests the 5-minute in-memory cache in complete isolation.
 */

// Reset module between tests so cached state doesn't leak
beforeEach(() => jest.resetModules());

function getCache() {
  return require('../utils/webinarConfigCache');
}

describe('webinarConfigCache', () => {
  test('get() returns null when empty', () => {
    const cache = getCache();
    expect(cache.get()).toBeNull();
  });

  test('set() then get() returns the stored data', () => {
    const cache = getCache();
    const data = { tuesday_whatsapp_link: 'https://chat.whatsapp.com/abc', kill_switch: false };
    cache.set(data);
    expect(cache.get()).toEqual(data);
  });

  test('invalidate() clears the cache', () => {
    const cache = getCache();
    cache.set({ tuesday_whatsapp_link: 'https://chat.whatsapp.com/abc' });
    cache.invalidate();
    expect(cache.get()).toBeNull();
  });

  test('get() returns null after TTL expires', () => {
    jest.useFakeTimers();
    const cache = getCache();
    cache.set({ tuesday_whatsapp_link: 'https://chat.whatsapp.com/abc' });
    // Advance 6 minutes past the 5-min TTL
    jest.advanceTimersByTime(6 * 60 * 1000);
    expect(cache.get()).toBeNull();
    jest.useRealTimers();
  });

  test('get() returns data before TTL expires', () => {
    jest.useFakeTimers();
    const cache = getCache();
    cache.set({ kill_switch: true });
    jest.advanceTimersByTime(4 * 60 * 1000); // 4 min — still valid
    expect(cache.get()).toEqual({ kill_switch: true });
    jest.useRealTimers();
  });

  test('set() with null does not crash', () => {
    const cache = getCache();
    expect(() => cache.set(null)).not.toThrow();
  });

  test('set() overwrites previous value', () => {
    const cache = getCache();
    cache.set({ tuesday_whatsapp_link: 'https://old.com' });
    cache.set({ tuesday_whatsapp_link: 'https://new.com' });
    expect(cache.get().tuesday_whatsapp_link).toBe('https://new.com');
  });
});
