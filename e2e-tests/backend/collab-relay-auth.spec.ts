import { expect, test } from '@playwright/test';
import { connectPeer, makeRoom, signChallenge, wait } from './collab-room';

/**
 * The relay's access control, against the real stack.
 *
 * yjs-relay is a deliberately dumb broadcast hub — it holds no secret and
 * knows nothing about Etebase identities. Its one control is the join
 * challenge: the room id *is* the public half of a keypair derived from the
 * room secret, so answering a nonce proves you can derive that secret. See
 * backend/yjs-relay/collab-server.mjs.
 *
 * These are the assertions unit tests can't make, because they need the real
 * uWebSockets server: that an unauthenticated socket is never subscribed, and
 * that a bad answer is dropped rather than tolerated.
 */

const ENABLED = !!process.env.MINDSTREAM_E2E_BACKEND;
const BASE = (
  process.env.MINDSTREAM_E2E_BACKEND_URL ?? 'http://localhost:8080'
).replace(/\/$/, '');

test.describe('yjs-relay join challenge', () => {
  test.skip(
    !ENABLED,
    'Set MINDSTREAM_E2E_BACKEND=1 and bring up backend/ to run relay auth checks.'
  );

  test('two members that answer the challenge exchange frames', async () => {
    const { room, privateKey } = await makeRoom();
    const a = connectPeer(BASE, room, (nonce) =>
      signChallenge(room, privateKey, nonce)
    );
    const b = connectPeer(BASE, room, (nonce) =>
      signChallenge(room, privateKey, nonce)
    );
    await Promise.all([a.settled, b.settled]);
    await wait(300);

    expect(a.challenge?.length).toBe(32);
    expect(b.challenge?.length).toBe(32);
    // Per-connection nonces, or a captured answer would be replayable.
    expect(a.challenge?.equals(b.challenge!)).toBe(false);

    a.ws.send(Buffer.from([0x01, 9, 9, 9]));
    await wait(400);

    expect(b.data.length).toBe(1);
    // publish() skips the sender.
    expect(a.data.length).toBe(0);

    a.close();
    b.close();
  });

  test('a signature from the wrong key is rejected', async () => {
    const { room } = await makeRoom();
    const impostor = await makeRoom();

    const peer = connectPeer(BASE, room, (nonce) =>
      signChallenge(room, impostor.privateKey, nonce)
    );
    await peer.settled;
    await wait(500);

    expect(peer.closed?.code).toBe(1008);
    expect(peer.closed?.reason).toBe('auth failed');
  });

  test('a socket that never answers receives no frames and is dropped', async () => {
    const { room, privateKey } = await makeRoom();
    const member = connectPeer(BASE, room, (nonce) =>
      signChallenge(room, privateKey, nonce)
    );
    await member.settled;
    await wait(200);

    // Answers nothing, so it must never be subscribed to the room.
    const lurker = connectPeer(BASE, room, () => null);
    await lurker.settled;
    await wait(200);

    for (let i = 0; i < 5; i++) member.ws.send(Buffer.from([0x01, i]));
    await wait(600);

    // The whole point: ciphertext must not reach an unauthenticated peer.
    expect(lurker.data.length).toBe(0);
    expect(lurker.challenge?.length).toBe(32);

    member.close();
    lurker.close();
  });

  test('a replayed answer does not open a second socket', async () => {
    const { room, privateKey } = await makeRoom();

    // Capture a valid answer from a real join...
    let captured: Buffer | null = null;
    const first = connectPeer(BASE, room, async (nonce) => {
      captured = await signChallenge(room, privateKey, nonce);
      return captured;
    });
    await first.settled;
    await wait(300);
    expect(captured).not.toBeNull();

    // ...and replay it against a fresh connection, which gets a fresh nonce.
    const replay = connectPeer(BASE, room, () => captured);
    await replay.settled;
    await wait(500);

    expect(replay.closed?.code).toBe(1008);
    expect(replay.closed?.reason).toBe('auth failed');

    first.close();
    replay.close();
  });

  test('a room id that is not a P-256 public key is refused at upgrade', async () => {
    const peer = connectPeer(BASE, 'health-probe', (nonce) => nonce);
    await peer.settled;
    await wait(300);

    // Rejected before a socket is allocated, so no challenge is ever issued.
    expect(peer.challenge).toBeNull();
    expect(peer.ws.readyState).not.toBe(1);
  });
});
