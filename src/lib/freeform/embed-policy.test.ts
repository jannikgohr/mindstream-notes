import { describe, expect, it } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  embedDecision,
  embedHost,
  isEmbeddableLink,
  normalizeAllowedHosts,
  withoutGeneratedHtml,
  youtubeEmbed
} from './embed-policy';

const PRIVATE = { shared: false, allowedHosts: [], sendsReferer: true };
const SHARED = { shared: true, allowedHosts: [], sendsReferer: true };

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
    const policy = { ...SHARED, allowedHosts: ['grafana.example.com'] };
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

describe('youtubeEmbed', () => {
  it('finds the video in the links Excalidraw plays', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=42',
      'https://youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ'
    ]) {
      expect(youtubeEmbed(link), link).toEqual({ videoId: 'dQw4w9WgXcQ' });
    }
  });

  it('has no single video for a playlist', () => {
    expect(
      youtubeEmbed('https://www.youtube.com/playlist?list=PL123abc')
    ).toEqual({ videoId: null });
  });

  it('ignores YouTube pages Excalidraw does not play', () => {
    expect(youtubeEmbed('https://m.youtube.com/watch?v=abc')).toBeNull();
    expect(youtubeEmbed('https://example.com/watch?v=abc')).toBeNull();
  });
});

describe('YouTube without a Referer', () => {
  const link = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  it('shows the card when the app page sends no Referer', () => {
    expect(embedDecision(link, { ...PRIVATE, sendsReferer: false })).toBe(
      'youtube-card'
    );
    expect(embedDecision(link, { ...SHARED, sendsReferer: false })).toBe(
      'youtube-card'
    );
  });

  it('keeps the player where the page sends one', () => {
    expect(embedDecision(link, PRIVATE)).toBe('load');
  });

  it('leaves other sites to load', () => {
    expect(
      embedDecision('https://vimeo.com/76979871', {
        ...PRIVATE,
        sendsReferer: false
      })
    ).toBe('load');
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
