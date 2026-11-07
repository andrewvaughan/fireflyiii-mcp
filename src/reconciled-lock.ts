import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import type { QueryParams } from './types.js';

/**
 * Household fork (2026-11-07): entries reconciled against a bank statement are locked on every field.
 *
 * Andrew: "I'd like to lock down everything reconciled (all fields) unless an explicit OK is given not just the
 * amounts." Firefly 6.7.9's own check (GroupValidation::preventUpdateReconciled) only stops amount and account changes,
 * and only when the request itself says `reconciled: true`; dates, notes, tags, deletes and any request leaving the
 * flag out go through. So every write this server sends is checked here first: a write that would touch a transaction
 * group holding a reconciled split is refused, whichever tool sends it. The only way through is `set_reconciled`,
 * which needs the unlock key the review worker holds (RECONCILE_UNLOCK_KEY, never given to an agent) and runs its one
 * write inside `lockBypass`.
 */
export const lockBypass = new AsyncLocalStorage<boolean>();

export const RECONCILED_TAG = 'Reconciled';
export const STAMP_PREFIX = 'Reconciled:';
export const UNLOCK_KEY_ENV = 'RECONCILE_UNLOCK_KEY';
// A trigger or a delete of a tag, category, budget or bill is checked against every entry it touches; past this many
// pages of 200 the write is refused rather than half-checked.
const MAX_PAGES = 100;

export class ReconciledLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciledLockError';
  }
}

export function unlockKeyMatches(given: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const want = env[UNLOCK_KEY_ENV] ?? '';
  if (want.length < 16 || typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the body sets Firefly's reconciled flag anywhere (to either value). */
export function bodyTouchesReconciled(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(bodyTouchesReconciled);
  if (body && typeof body === 'object') {
    return Object.entries(body as Record<string, unknown>).some(
      ([key, value]) => key === 'reconciled' || bodyTouchesReconciled(value),
    );
  }
  return false;
}

type Getter = <T = unknown>(path: string, params?: QueryParams) => Promise<T>;

type Split = Record<string, unknown>;
type Group = {
  id?: string | number;
  attributes?: { group_title?: string | null; transactions?: Split[] };
};

export type LockedHit = {
  id: string;
  date: string;
  description: string;
  stamp: string | null;
};

/** The first reconciled split of a group (as Firefly returns it), or null. */
export function reconciledHit(group: Group | undefined): LockedHit | null {
  const splits = group?.attributes?.transactions ?? [];
  const hit = splits.find((split) => split.reconciled === true);
  if (!hit) return null;
  const stamp =
    String(hit.notes ?? '')
      .split('\n')
      .find((line) => line.startsWith(STAMP_PREFIX)) ?? null;
  return {
    id: String(group?.id ?? ''),
    date: String(hit.date ?? '').slice(0, 10),
    description: String(group?.attributes?.group_title || hit.description || ''),
    stamp,
  };
}

function refuse(what: string, hit: LockedHit): never {
  throw new ReconciledLockError(
    `Refused: ${what} would change transaction #${hit.id} (${hit.date}, "${hit.description}"), which is reconciled against its bank statement${hit.stamp ? ` (${hit.stamp})` : ''}. Reconciled entries are locked on every field and cannot be deleted; a change needs Andrew's explicit ok on an unlock card, which only the review worker applies.`,
  );
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { status?: number }).status === 404);
}

async function checkGroup(get: Getter, id: string, what: string): Promise<void> {
  let response: { data?: Group };
  try {
    response = await get<{ data?: Group }>(`/transactions/${id}`);
  } catch (err) {
    if (isNotFound(err)) return; // nothing there to protect; the write itself will fail
    throw err;
  }
  const hit = reconciledHit(response.data);
  if (hit) refuse(what, hit);
}

async function checkJournal(get: Getter, journalId: unknown, what: string): Promise<void> {
  if (journalId === undefined || journalId === null || journalId === '') return;
  let response: { data?: Group };
  try {
    response = await get<{ data?: Group }>(`/transaction-journals/${journalId}`);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  const hit = reconciledHit(response.data);
  if (hit) refuse(what, hit);
}

async function checkAttachment(get: Getter, id: string, what: string): Promise<void> {
  let response: {
    data?: {
      attributes?: {
        attachable_type?: string;
        attachable_id?: string | number;
      };
    };
  };
  try {
    response = await get(`/attachments/${id}`);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  const attrs = response.data?.attributes;
  if (attrs?.attachable_type === 'TransactionJournal') await checkJournal(get, attrs.attachable_id, what);
}

async function checkLink(get: Getter, id: string, what: string): Promise<void> {
  let response: {
    data?: {
      attributes?: {
        inward_id?: string | number;
        outward_id?: string | number;
      };
    };
  };
  try {
    response = await get(`/transaction-links/${id}`);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  await checkJournal(get, response.data?.attributes?.inward_id, what);
  await checkJournal(get, response.data?.attributes?.outward_id, what);
}

/** Pages through a list of transaction groups and refuses at the first reconciled one. */
async function checkList(get: Getter, path: string, params: QueryParams, what: string): Promise<void> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await get<{
      data?: Group[];
      meta?: { pagination?: { total_pages?: number } };
    }>(path, {
      ...params,
      page,
      limit: 200,
    });
    for (const group of response.data ?? []) {
      const hit = reconciledHit(group);
      if (hit) refuse(what, hit);
    }
    const pages = Number(response.meta?.pagination?.total_pages ?? 1);
    if (page >= pages) return;
  }
  throw new ReconciledLockError(
    `Refused: ${what} touches more than ${MAX_PAGES * 200} entries, too many to check for reconciled ones; narrow it (a date range) and try again.`,
  );
}

function queryOf(search: URLSearchParams): QueryParams {
  const out: QueryParams = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    out[key] = key.endsWith('[]') ? values : values[0];
  }
  return out;
}

/**
 * Checks one write before it is sent. `path` is relative to /api/v1 (e.g. "/transactions/12"); `search` is the
 * request's query string. Throws ReconciledLockError to refuse.
 */
export async function guardWrite(
  get: Getter,
  method: string,
  path: string,
  search: URLSearchParams,
  body: unknown,
): Promise<void> {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return;
  if (lockBypass.getStore() === true) return;

  if (bodyTouchesReconciled(body)) {
    throw new ReconciledLockError(
      "Refused: only set_reconciled may change Firefly's reconciled flag, with the review worker's unlock key and Andrew's ok on a card.",
    );
  }
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  const [root, id, sub] = parts;
  const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  switch (root) {
    case 'transactions':
      if (id && (verb === 'PUT' || verb === 'DELETE' || verb === 'PATCH')) {
        await checkGroup(get, id, verb === 'DELETE' ? 'this delete' : 'this edit');
      }
      return;
    case 'transaction-journals':
      if (id) await checkJournal(get, id, verb === 'DELETE' ? 'this delete' : 'this edit');
      return;
    case 'attachments':
      if (!id && verb === 'POST') {
        if (payload.attachable_type === 'TransactionJournal') {
          await checkJournal(get, payload.attachable_id, 'attaching a file');
        }
      } else if (id) {
        await checkAttachment(get, id, sub === 'upload' ? 'uploading this attachment' : 'changing this attachment');
        if (payload.attachable_type === 'TransactionJournal') {
          await checkJournal(get, payload.attachable_id, 'moving this attachment');
        }
      }
      return;
    case 'transaction-links':
      if (id) await checkLink(get, id, 'changing this link');
      await checkJournal(get, payload.inward_id, 'linking');
      await checkJournal(get, payload.outward_id, 'linking');
      return;
    case 'rules':
    case 'rule-groups':
      if (id && sub === 'trigger') {
        await checkList(get, `/${root}/${id}/test`, queryOf(search), 'running this rule');
      }
      return;
    case 'tags':
      if (id && verb === 'DELETE') {
        await checkList(get, `/tags/${id}/transactions`, {}, 'deleting this tag');
      } else if (id && verb === 'PUT' && payload.tag !== undefined) {
        // A tag's name is part of every entry carrying it; only a real rename is checked (the path may be its id).
        const current = await get<{ data?: { attributes?: { tag?: string } } }>(`/tags/${id}`).catch(() => undefined);
        if (current?.data?.attributes?.tag !== payload.tag) {
          await checkList(get, `/tags/${id}/transactions`, {}, 'renaming this tag');
        }
      }
      return;
    case 'categories':
    case 'budgets':
    case 'bills':
      if (id && !sub && verb === 'DELETE') {
        await checkList(
          get,
          `/${root}/${id}/transactions`,
          {},
          `deleting this ${root.replace(/ies$/, 'y').replace(/s$/, '')}`,
        );
      }
      return;
    case 'accounts':
      if (
        id &&
        verb === 'PUT' &&
        (payload.opening_balance !== undefined || payload.opening_balance_date !== undefined)
      ) {
        // The opening balance anchors every later statement's checksum, so it is locked once anything on the account is
        // reconciled (it is itself reconciled to the statement it came from).
        await checkList(get, `/accounts/${id}/transactions`, {}, "changing this account's opening balance");
      }
      return;
    case 'data':
      // Firefly's bulk move and its destroy/purge endpoints rewrite or remove entries wholesale.
      throw new ReconciledLockError(
        `Refused: /${parts.join('/')} can rewrite or remove reconciled entries wholesale; it is not available through this server.`,
      );
    default:
      return;
  }
}
