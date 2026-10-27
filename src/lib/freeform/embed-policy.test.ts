import { describe, expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  embedDecision,
  embedHost,
  isEmbeddableLink,
  normalizeAllowedHosts,
  withoutGeneratedHtml
} from './embed-policy';

const PRIVATE = { shared: false, allowedHosts: [] };
const SHARED = { shared: true, allowedHosts: [] };

describe('embedHost', () => {
  it('drops www., a trailing dot and case', () => {
    expect(embedHost('https://WWW.Example.com./page')).toBe('example.com');
  });

  it('keeps other subdomains', () => {
    expect(embedHost('https://docs.example.com/')).toBe('docs.example.com');
  });

  it('only reads absolute http(s) links', () => {
    expect(embedHost('http://example.com')).toBe('example.com');
    expect(embedHost('javascript:alert(1)')).toBeNull();
    expect(embedHost('/relative')).toBeNull();
    expect(embedHost('not a url')).toBeNull();
  });
});

describe('isEmbeddableLink', () => {
  it('accepts http and https so the placeholder can explain the rest', () => {
    expect(isEmbeddableLink('https://example.com')).toBe(true);
    expect(isEmbeddableLink('http://example.com')).toBe(true);
    expect(isEmbeddableLink('data:text/html,hi')).toBe(false);
  });
});

describe('embedDecision', () => {
  it('loads any https page in a private drawing', () => {
    expect(embedDecision('https://grafana.example.com/d/1', PRIVATE)).toBe(
      'load'
    );
  });

  it('blocks unknown hosts in a shared drawing', () => {
    expect(embedDecision('https://evil.example/login', SHARED)).toBe('blocked');
  });

  it("loads Excalidraw's default hosts in a shared drawing", () => {
    for (const link of [
      'https://www.youtube.com/watch?v=abc',
      'https://youtu.be/abc',
      'https://player.vimeo.com/video/1',
      'https://www.figma.com/file/abc',
      'https://stackblitz.com/edit/x',
      'https://doc.simplepdf.eu/x'
    ]) {
      expect(embedDecision(link, SHARED), link).toBe('load');
    }
  });

  it('matches default hosts the way Excalidraw does', () => {
    // youtube.com has no wildcard entry, so its other subdomains don't count.
    expect(embedDecision('https://m.youtube.com/watch?v=abc', SHARED)).toBe(
      'blocked'
    );
    // The *.simplepdf.eu wildcard needs a subdomain.
    expect(embedDecision('https://simplepdf.eu/x', SHARED)).toBe('blocked');
  });

  it('loads hosts the user allowed in a shared drawing', () => {
    const policy = { shared: true, allowedHosts: ['grafana.example.com'] };
    expect(embedDecision('https://grafana.example.com/d/1', policy)).toBe(
      'load'
    );
    expect(embedDecision('https://www.grafana.example.com/', policy)).toBe(
      'load'
    );
    expect(embedDecision('https://example.com/', policy)).toBe('blocked');
  });

  it('marks script-widget sites unsupported everywhere', () => {
    for (const link of [
      'https://x.com/user/status/1',
      'https://twitter.com/user/status/1',
      'https://www.reddit.com/r/a/comments/b/c',
      'https://gist.github.com/user/abc'
    ]) {
      expect(embedDecision(link, PRIVATE), link).toBe('unsupported');
      expect(embedDecision(link, SHARED), link).toBe('unsupported');
    }
  });

  it('refuses links that are not https', () => {
    expect(embedDecision('http://192.168.1.10:3000', PRIVATE)).toBe(
      'not-https'
    );
    expect(embedDecision('/relative', PRIVATE)).toBe('not-https');
  });
});

describe('normalizeAllowedHosts', () => {
  it('keeps unique lowercase strings', () => {
    expect(
      normalizeAllowedHosts([' Example.com ', 'example.com', 3, '', 'b.test'])
    ).toEqual(['example.com', 'b.test']);
  });

  it('treats anything but an array as empty', () => {
    expect(normalizeAllowedHosts(undefined)).toEqual([]);
    expect(normalizeAllowedHosts('example.com')).toEqual([]);
  });
});

describe('withoutGeneratedHtml', () => {
  it('drops the HTML of iframe elements and keeps everything else', () => {
    const rect = { id: 'r', type: 'rectangle' } as ExcalidrawElement;
    const iframe = {
      id: 'i',
      type: 'iframe',
      version: 4,
      customData: {
        generationData: {
          status: 'done',
          html: '<iframe src="https://evil.example"></iframe>'
        },
        note: 'kept'
      }
    } as unknown as ExcalidrawElement;

    const [outRect, outIframe] = withoutGeneratedHtml([rect, iframe]);

    expect(outRect).toBe(rect);
    expect(outIframe).toMatchObject({ id: 'i', version: 4 });
    expect(outIframe.customData).toEqual({ note: 'kept' });
    // The stored element is untouched.
    expect(iframe.customData?.generationData).toBeDefined();
  });
});
