import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUpdate, onUpdate, resetUpdateStore, setUpdate } from '../webview/engine/updateStore.ts';
import type { UpdateInfo } from '../src/shared/protocol.ts';

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({ status: 'upToDate', current: '0.5.0', auto: true, ...over });

test('updateStore: empty until the first setUpdate, then keeps the latest', () => {
  resetUpdateStore();
  assert.equal(getUpdate(), undefined);
  const a = info();
  const b = info({ status: 'available', latest: '0.6.0' });
  setUpdate(a);
  assert.equal(getUpdate(), a);
  setUpdate(b);
  assert.equal(getUpdate(), b);
});

test('updateStore: listeners hear later updates in order, not the stored one, and unsubscribe works', () => {
  resetUpdateStore();
  setUpdate(info());
  const seen: string[] = [];
  const offA = onUpdate((u) => seen.push(`a:${u.status}`));
  onUpdate((u) => seen.push(`b:${u.status}`));
  assert.deepEqual(seen, []);
  setUpdate(info({ status: 'checking' }));
  offA();
  setUpdate(info({ status: 'upToDate' }));
  assert.deepEqual(seen, ['a:checking', 'b:checking', 'b:upToDate']);
});

test('updateStore: a throwing listener does not stop the others or the store', () => {
  resetUpdateStore();
  const seen: string[] = [];
  onUpdate(() => { throw new Error('boom'); });
  onUpdate((u) => seen.push(u.status));
  setUpdate(info({ status: 'error' }));
  assert.deepEqual(seen, ['error']);
  assert.equal(getUpdate()?.status, 'error');
});
