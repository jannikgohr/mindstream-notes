import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from '$lib/api';
import { getCollectionShareState } from '$lib/api/sharing';
import {
  findShareScopeCollectionId,
  resolveShareScopeUsers
} from './share-users';

vi.mock('$lib/api/sharing', () => ({
  getCollectionShareState: vi.fn()
}));

const shareState = vi.mocked(getCollectionShareState);

function collection(
  id: string,
  parent_collection_id: string | null = null,
  extra: Partial<Collection> = {}
): Collection {
  return {
    id,
    parent_collection_id,
    name: id,
    position: 0,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    ...extra
  } as Collection;
}

beforeEach(() => {
  shareState.mockReset();
});

describe('findShareScopeCollectionId', () => {
  it('returns the nearest shared ancestor', () => {
    const collections = {
      root: collection('root', null, { shared_by_me: true }),
      child: collection('child', 'root'),
      grandchild: collection('grandchild', 'child')
    };

    expect(findShareScopeCollectionId('grandchild', collections)).toBe('root');
  });

  it('treats shared-with-me collections as a scope', () => {
    const collections = {
      root: collection('root'),
      child: collection('child', 'root', { shared_role: 'read_write' })
    };

    expect(findShareScopeCollectionId('child', collections)).toBe('child');
  });

  it('returns null for missing, unshared, or cyclic ancestors', () => {
    expect(findShareScopeCollectionId('missing', {})).toBeNull();

    const unshared = {
      a: collection('a', null),
      b: collection('b', 'a')
    };
    expect(findShareScopeCollectionId('b', unshared)).toBeNull();

    const cyclic = {
      a: collection('a', 'b'),
      b: collection('b', 'a')
    };
    expect(findShareScopeCollectionId('a', cyclic)).toBeNull();
  });
});

describe('resolveShareScopeUsers', () => {
  it('returns self only outside a shared scope', async () => {
    await expect(resolveShareScopeUsers(null, {}, 'me')).resolves.toEqual([
      { username: 'me', accessLevel: null, isSelf: true }
    ]);
  });

  it('returns an empty list outside a shared scope when signed out', async () => {
    await expect(resolveShareScopeUsers(null, {}, null)).resolves.toEqual([]);
  });

  it('resolves self, owner, and members with case-insensitive dedupe', async () => {
    const collections = {
      shared: collection('shared', null, { shared_by_me: true })
    };
    shareState.mockResolvedValue({
      collection_id: 'shared',
      share_id: 'share-1',
      shared_role: null,
      shared_owner: 'Owner',
      shared_by_me: true,
      members: [
        { username: 'ME', access_level: 'read_write' },
        { username: 'viewer', access_level: 'read_only' },
        { username: ' ', access_level: 'read_write' },
        { username: 'owner', access_level: 'read_write' }
      ],
      outgoing_invitations: []
    });

    await expect(
      resolveShareScopeUsers('shared', collections, 'me')
    ).resolves.toEqual([
      { username: 'me', accessLevel: null, isSelf: true },
      { username: 'Owner', accessLevel: null, isSelf: false },
      { username: 'viewer', accessLevel: 'read_only', isSelf: false }
    ]);
  });

  it('falls back to self when share state loading fails', async () => {
    const collections = {
      shared: collection('shared', null, { shared_by_me: true })
    };
    shareState.mockRejectedValue(new Error('offline'));

    await expect(
      resolveShareScopeUsers('shared', collections, 'me')
    ).resolves.toEqual([{ username: 'me', accessLevel: null, isSelf: true }]);
  });
});
