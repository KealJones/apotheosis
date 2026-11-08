import { describe, it, expect, vi, afterEach } from 'vitest';
import { chat, isAvailable, getOllamaUrl, getOllamaModel } from '../../src/llm/ollama.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ollama client', () => {
  describe('getOllamaUrl / getOllamaModel', () => {
    it('defaults when env vars unset', () => {
      vi.stubEnv('APOTHEOSIS_OLLAMA_URL', '');
      vi.stubEnv('APOTHEOSIS_OLLAMA_MODEL', '');
      delete process.env.APOTHEOSIS_OLLAMA_URL;
      delete process.env.APOTHEOSIS_OLLAMA_MODEL;
      expect(getOllamaUrl()).toBe('http://localhost:11434');
      expect(getOllamaModel()).toBe('gemma4:e4b');
    });

    it('respects env var overrides', () => {
      vi.stubEnv('APOTHEOSIS_OLLAMA_URL', 'http://example:1234');
      vi.stubEnv('APOTHEOSIS_OLLAMA_MODEL', 'llama3');
      expect(getOllamaUrl()).toBe('http://example:1234');
      expect(getOllamaModel()).toBe('llama3');
    });
  });

  describe('chat', () => {
    it('posts to /api/chat and returns the message content', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: { role: 'assistant', content: 'hello there' } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await chat([{ role: 'user', content: 'hi' }], { baseUrl: 'http://x:1' });

      expect(result).toBe('hello there');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://x:1/api/chat');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('includes format when requested', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: { content: '{}' } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await chat([{ role: 'user', content: 'hi' }], { baseUrl: 'http://x:1', format: 'json' });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.format).toBe('json');
      expect(body).not.toHaveProperty('think');
      expect(body).not.toHaveProperty('options');
    });

    it('passes think and sampling options through when given', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: { content: '{}' } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await chat([{ role: 'user', content: 'hi' }], {
        baseUrl: 'http://x:1',
        think: false,
        options: { temperature: 0, num_predict: 400 },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.think).toBe(false);
      expect(body.options).toEqual({ temperature: 0, num_predict: 400 });
    });

    it('passes num_ctx and think when requested, and omits them otherwise', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: '{}' } }) });
      vi.stubGlobal('fetch', fetchMock);

      await chat([{ role: 'user', content: 'hi' }], { baseUrl: 'http://x:1', numCtx: 16384, think: false, temperature: 0 });
      await chat([{ role: 'user', content: 'hi' }], { baseUrl: 'http://x:1' });

      const withOpts = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(withOpts.options).toEqual({ num_ctx: 16384, temperature: 0 });
      expect(withOpts.think).toBe(false);
      const plain = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(plain).not.toHaveProperty('options');
      expect(plain).not.toHaveProperty('think');
    });

    it('throws a clear error on non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'boom',
      }));

      await expect(chat([{ role: 'user', content: 'hi' }], { baseUrl: 'http://x:1' })).rejects.toThrow(/500/);
    });

    it('throws a clear error when fetch itself fails (connection refused)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      await expect(chat([{ role: 'user', content: 'hi' }], { baseUrl: 'http://x:1' })).rejects.toThrow(/Failed to reach Ollama/);
    });

    it('throws when response has no message content', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }));

      await expect(chat([{ role: 'user', content: 'hi' }], { baseUrl: 'http://x:1' })).rejects.toThrow(/message content/);
    });
  });

  describe('isAvailable', () => {
    it('returns true when /api/tags responds ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      await expect(isAvailable({ baseUrl: 'http://x:1' })).resolves.toBe(true);
    });

    it('returns false when /api/tags responds non-ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
      await expect(isAvailable({ baseUrl: 'http://x:1' })).resolves.toBe(false);
    });

    it('returns false (never throws) when fetch rejects', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      await expect(isAvailable({ baseUrl: 'http://x:1' })).resolves.toBe(false);
    });
  });
});
