import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FireflyClient } from '../client.js';
import {
  bodyTouchesReconciled,
  guardWrite,
  lockBypass,
  ReconciledLockError,
  reconciledHit,
  unlockKeyMatches,
} from '../reconciled-lock.js';
import { setReconciled } from '../tools/transactions.js';

const KEY = 'test-unlock-key-0123456789abcdef';

function group(id: number, reconciled: boolean, extra: Record<string, unknown> = {}) {
  return {
    id: String(id),
    attributes: {
      group_title: null,
      transactions: [
        {
          transaction_journal_id: String(id * 10),
          date: '2023-01-05T00:00:00-05:00',
          description: `Entry ${id}`,
          amount: '12.34',
          reconciled,
          notes: reconciled ? 'Bank: X\nReconciled: Paperless 3353, Chase checking Jan 2023' : 'Bank: X',
          tags: reconciled ? ['Source: Statement', 'Reconciled'] : ['Source: Statement'],
          ...extra,
        },
      ],
    },
  };
}

// A fake GET over a small fixed world: group 1 is reconciled (journal 10), group 2 is not (journal 20).
function world() {
  const calls: string[] = [];
  const get = vi.fn(async (path: string, params?: Record<string, unknown>) => {
    calls.push(path + (params ? JSON.stringify(params) : ''));
    if (path === '/transactions/1' || path === '/transaction-journals/10') return { data: group(1, true) };
    if (path === '/transactions/2' || path === '/transaction-journals/20') return { data: group(2, false) };
    if (path === '/attachments/7')
      return {
        data: {
          attributes: {
            attachable_type: 'TransactionJournal',
            attachable_id: 10,
          },
        },
      };
    if (path === '/attachments/8')
      return {
        data: {
          attributes: {
            attachable_type: 'TransactionJournal',
            attachable_id: 20,
          },
        },
      };
    if (path === '/tags/Food') return { data: { attributes: { tag: 'Food' } } };
    if (path === '/transaction-links/5') return { data: { attributes: { inward_id: 20, outward_id: 10 } } };
    if (
      path === '/rules/3/test' ||
      path === '/tags/Food/transactions' ||
      path === '/categories/4/transactions' ||
      path === '/accounts/2/transactions'
    ) {
      return {
        data: [group(2, false), group(1, true)],
        meta: { pagination: { total_pages: 1 } },
      };
    }
    if (path === '/rules/4/test' || path === '/tags/Clean/transactions' || path === '/accounts/9/transactions') {
      return {
        data: [group(2, false)],
        meta: { pagination: { total_pages: 1 } },
      };
    }
    const err = Object.assign(new Error('not found'), { status: 404 });
    throw err;
  });
  return { get, calls };
}

const none = new URLSearchParams();

describe('reconciled lock (household fork)', () => {
  it('finds the reconciled split and its stamp', () => {
    expect(reconciledHit(group(1, true))).toEqual({
      id: '1',
      date: '2023-01-05',
      description: 'Entry 1',
      stamp: 'Reconciled: Paperless 3353, Chase checking Jan 2023',
    });
    expect(reconciledHit(group(2, false))).toBeNull();
  });

  it('spots the reconciled flag anywhere in a body', () => {
    expect(bodyTouchesReconciled({ transactions: [{ reconciled: false }] })).toBe(true);
    expect(bodyTouchesReconciled({ transactions: [{ notes: 'reconciled' }] })).toBe(false);
  });

  it('checks the unlock key in constant time and refuses a short or missing key', () => {
    expect(unlockKeyMatches(KEY, { RECONCILE_UNLOCK_KEY: KEY })).toBe(true);
    expect(unlockKeyMatches('wrong', { RECONCILE_UNLOCK_KEY: KEY })).toBe(false);
    expect(unlockKeyMatches(KEY, {})).toBe(false);
    expect(unlockKeyMatches('short', { RECONCILE_UNLOCK_KEY: 'short' })).toBe(false);
    expect(unlockKeyMatches(undefined, { RECONCILE_UNLOCK_KEY: KEY })).toBe(false);
  });

  it.each([
    ['PUT', '/transactions/1', { transactions: [{ transaction_journal_id: '10', notes: 'x' }] }],
    ['PUT', '/transactions/1', { transactions: [{ transaction_journal_id: '10', date: '2023-01-06' }] }],
    ['PUT', '/transactions/1', { transactions: [{ transaction_journal_id: '10', tags: [] }] }],
    ['DELETE', '/transactions/1', undefined],
    ['DELETE', '/transaction-journals/10', undefined],
    [
      'POST',
      '/attachments',
      {
        attachable_type: 'TransactionJournal',
        attachable_id: '10',
        filename: 'a.pdf',
      },
    ],
    ['POST', '/attachments/7/upload', undefined],
    ['PUT', '/attachments/7', { title: 'renamed' }],
    ['DELETE', '/attachments/7', undefined],
    ['PUT', '/attachments/8', { attachable_type: 'TransactionJournal', attachable_id: '10' }],
    ['POST', '/transaction-links', { link_type_id: '1', inward_id: '20', outward_id: '10' }],
    ['DELETE', '/transaction-links/5', undefined],
    ['POST', '/rules/3/trigger', undefined],
    ['DELETE', '/tags/Food', undefined],
    ['PUT', '/tags/Food', { tag: 'Groceries' }],
    ['DELETE', '/categories/4', undefined],
    ['PUT', '/accounts/2', { opening_balance: '100.00' }],
    ['POST', '/data/bulk/transactions', { query: '{}' }],
  ])('refuses %s %s when it would touch a reconciled entry', async (method, path, body) => {
    const { get } = world();
    await expect(guardWrite(get as never, method, path, none, body)).rejects.toThrow(ReconciledLockError);
  });

  it.each([
    ['PUT', '/transactions/2', { transactions: [{ transaction_journal_id: '20', notes: 'x' }] }],
    ['DELETE', '/transactions/2', undefined],
    ['POST', '/transactions', { transactions: [{ type: 'withdrawal', amount: '1.00' }] }],
    [
      'POST',
      '/attachments',
      {
        attachable_type: 'TransactionJournal',
        attachable_id: '20',
        filename: 'a.pdf',
      },
    ],
    ['POST', '/attachments/8/upload', undefined],
    ['POST', '/rules/4/trigger', undefined],
    ['PUT', '/tags/Food', { tag: 'Food', description: 'only the description' }],
    ['DELETE', '/tags/Clean', undefined],
    ['PUT', '/accounts/2', { name: 'Chase Checking (5650)' }],
    ['PUT', '/accounts/9', { opening_balance: '5.00' }],
    ['PUT', '/transactions/404', { transactions: [] }],
    ['POST', '/categories', { name: 'New' }],
  ])('lets %s %s through when nothing reconciled is touched', async (method, path, body) => {
    const { get } = world();
    await expect(guardWrite(get as never, method, path, none, body)).resolves.toBeUndefined();
  });

  it('refuses any request that sets or clears the flag, even on an entry that is not reconciled', async () => {
    const { get } = world();
    await expect(
      guardWrite(get as never, 'PUT', '/transactions/2', none, {
        transactions: [{ reconciled: true }],
      }),
    ).rejects.toThrow(/only set_reconciled/);
    await expect(
      guardWrite(get as never, 'PUT', '/transactions/1', none, {
        transactions: [{ reconciled: false }],
      }),
    ).rejects.toThrow(/only set_reconciled/);
  });

  it('passes the trigger window on to the rule test it checks', async () => {
    const { get, calls } = world();
    await guardWrite(
      get as never,
      'POST',
      '/rules/4/trigger',
      new URLSearchParams('start=2023-01-01&end=2023-01-31&accounts[]=2'),
      undefined,
    );
    expect(calls[0]).toContain('"start":"2023-01-01"');
    expect(calls[0]).toContain('"accounts[]":["2"]');
  });

  it('names the entry and its statement in the refusal', async () => {
    const { get } = world();
    await expect(guardWrite(get as never, 'DELETE', '/transactions/1', none, undefined)).rejects.toThrow(
      /#1 \(2023-01-05, "Entry 1"\).*Reconciled: Paperless 3353.*unlock card/,
    );
  });

  it('lets everything through inside the bypass set_reconciled uses', async () => {
    const { get } = world();
    await lockBypass.run(true, async () => {
      await expect(
        guardWrite(get as never, 'PUT', '/transactions/1', none, {
          transactions: [{ reconciled: false }],
        }),
      ).resolves.toBeUndefined();
    });
  });

  it('ignores reads', async () => {
    const { get } = world();
    await expect(guardWrite(get as never, 'GET', '/transactions/1', none, undefined)).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('FireflyClient with the reconciled lock', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('reads the entry first and never sends a write to a reconciled one', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok({ data: group(1, true) }));
    const client = new FireflyClient('https://ff.example', 'tok');
    await expect(
      client.put('/transactions/1', {
        transactions: [{ transaction_journal_id: '10', notes: 'x' }],
      }),
    ).rejects.toThrow(ReconciledLockError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('GET');
  });

  it('refuses an upload into a reconciled entry', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        ok({
          data: {
            attributes: {
              attachable_type: 'TransactionJournal',
              attachable_id: 10,
            },
          },
        }),
      )
      .mockResolvedValueOnce(ok({ data: group(1, true) }));
    const client = new FireflyClient('https://ff.example', 'tok');
    await expect(client.postBinary('/attachments/7/upload', new Uint8Array([1]))).rejects.toThrow(ReconciledLockError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('set_reconciled refuses without the key and sends nothing', async () => {
    vi.stubEnv('RECONCILE_UNLOCK_KEY', KEY);
    const client = new FireflyClient('https://ff.example', 'tok');
    await expect(
      setReconciled(client, '2', {
        reconciled: true,
        unlock_key: 'nope',
        reason: 'card',
        stamp: 'Reconciled: x',
      }),
    ).rejects.toThrow(/unlock key/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('set_reconciled locks with the key: flag, tag and stamp in one write past the lock', async () => {
    vi.stubEnv('RECONCILE_UNLOCK_KEY', KEY);
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ data: group(2, false) }))
      .mockResolvedValueOnce(ok({ data: group(2, true) }));
    const client = new FireflyClient('https://ff.example', 'tok');
    await setReconciled(client, '2', {
      reconciled: true,
      unlock_key: KEY,
      reason: 'reconcile card, Andrew ok 2026-11-07',
      stamp: 'Reconciled: Paperless 3353',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, init] = vi.mocked(fetch).mock.calls[1];
    expect(init?.method).toBe('PUT');
    const sent = JSON.parse(String(init?.body));
    expect(sent.transactions[0]).toEqual({
      transaction_journal_id: '20',
      reconciled: true,
      notes: 'Bank: X\nReconciled: Paperless 3353',
      tags: ['Source: Statement', 'Reconciled'],
    });
    expect(sent.apply_rules).toBe(false);
  });

  it('set_reconciled unlocks: flag off, tag off, stamp kept as "Was reconciled" and the reason dated', async () => {
    vi.stubEnv('RECONCILE_UNLOCK_KEY', KEY);
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ data: group(1, true) }))
      .mockResolvedValueOnce(ok({ data: group(1, false) }));
    const client = new FireflyClient('https://ff.example', 'tok');
    await setReconciled(
      client,
      '1',
      {
        reconciled: false,
        unlock_key: KEY,
        reason: 'Andrew 2026-11-08: "ok to fix the date"',
      },
      new Date('2026-11-08T15:00:00Z'),
    );
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(sent.transactions[0]).toEqual({
      transaction_journal_id: '10',
      reconciled: false,
      notes:
        'Bank: X\nWas reconciled: Paperless 3353, Chase checking Jan 2023\nUnlocked 2026-11-08: Andrew 2026-11-08: "ok to fix the date"',
      tags: ['Source: Statement'],
    });
  });

  it('set_reconciled needs a stamp to lock', async () => {
    vi.stubEnv('RECONCILE_UNLOCK_KEY', KEY);
    const client = new FireflyClient('https://ff.example', 'tok');
    await expect(
      setReconciled(client, '2', {
        reconciled: true,
        unlock_key: KEY,
        reason: 'r',
      }),
    ).rejects.toThrow(/stamp/);
  });
});
