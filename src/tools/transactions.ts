import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FireflyClient } from '../client.js';
import {
  type JsonApiListResponse,
  type JsonApiSingleResponse,
  type UnwrappedList,
  type UnwrappedSingle,
  unwrapList,
  unwrapSingle,
} from '../transform.js';
import type { QueryParams } from '../types.js';
import { DELETE_ANNOTATIONS, READ_ANNOTATIONS, UPDATE_ANNOTATIONS, WRITE_ANNOTATIONS } from './_annotations.js';
import { CATEGORY_NAME_HINT, dateOrDateTimeSchema, dateSchema, defineTool, parseId } from './_helpers.js';
import { fetchAccountTransactions } from './accounts.js';

// A transaction response carries two ids: the top-level group `id`, which update_transaction and
// delete_transaction expect, and a `transaction_journal_id` inside each item of `transactions[]`.
// They are usually adjacent numbers, so the wrong one addresses a real but unrelated transaction
// rather than erroring — nothing at write time can tell the two apart, which is why these fields
// warn instead of validating.
const GROUP_ID_HINT =
  'update_transaction and delete_transaction take the top-level `id` (the transaction group), not the `transaction_journal_id` inside `transactions[]`.';

const groupIdField = (verb: string): string =>
  `Transaction group ID — the top-level \`id\` from get_transaction, not the \`transaction_journal_id\` inside \`transactions[]\`. That is usually an adjacent number, so the wrong one silently ${verb} a different transaction.`;

// Household fork: agent writes never ask Firefly to run its rules, so a rule cannot rewrite the category,
// description or tags an agent has just set.
const APPLY_RULES = false;

type Journal = Record<string, unknown> & { transaction_journal_id: string | number; amount: string };

// Household fork: amounts compared in cents, since Firefly returns them with up to 12 decimals.
function cents(amount: unknown): number {
  return Math.round(Number(amount) * 100);
}

/**
 * Household fork: every entry in these books keeps a "Source: " tag saying where it came from (the bank import, a
 * statement, Quicken). A tag list sent without one would drop it, as an earlier split script did on five lines, so
 * the line's own Source tags are kept unless the list names a Source tag of its own.
 */
export const SOURCE_TAG_PREFIX = 'Source: ';

function tagList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function keepSourceTags(sent: string[], current: unknown): string[] {
  if (sent.some((tag) => tag.startsWith(SOURCE_TAG_PREFIX))) return sent;
  const kept = tagList(current).filter((tag) => tag.startsWith(SOURCE_TAG_PREFIX) && !sent.includes(tag));
  return [...sent, ...kept];
}

async function fetchJournals(
  client: FireflyClient,
  id: string,
): Promise<{ groupTitle: string | null; journals: Journal[] }> {
  const response = await client.get<JsonApiSingleResponse>(`/transactions/${id}`);
  const attributes = (response?.data?.attributes ?? {}) as Record<string, unknown>;
  const journals = Array.isArray(attributes.transactions) ? (attributes.transactions as Journal[]) : [];
  if (journals.length === 0) {
    throw new Error(`Transaction ${id} has no lines. Check the group id with get_transaction.`);
  }
  return { groupTitle: (attributes.group_title as string | null) ?? null, journals };
}

export async function fetchTransactions(
  client: FireflyClient,
  params: {
    type?: string;
    accountId?: string;
    start?: string;
    end?: string;
    page?: number;
    limit?: number;
  },
): Promise<UnwrappedList> {
  // Firefly III's /transactions endpoint has no account_id filter and silently ignores it, so
  // accountId must be routed to /accounts/{id}/transactions instead — see issue #101.
  if (params.accountId) {
    return fetchAccountTransactions(client, parseId(params.accountId), {
      start: params.start,
      end: params.end,
      type: params.type,
      page: params.page,
      limit: params.limit,
    });
  }
  const query: QueryParams = { page: params.page, limit: params.limit };
  if (params.type) query.type = params.type;
  if (params.start) query.start = params.start;
  if (params.end) query.end = params.end;
  const response = await client.get<JsonApiListResponse>('/transactions', query);
  return unwrapList(response);
}

export async function fetchTransaction(client: FireflyClient, id: string): Promise<UnwrappedSingle> {
  const response = await client.get<JsonApiSingleResponse>(`/transactions/${id}`);
  return unwrapSingle(response);
}

/**
 * Household fork: every create asks Firefly to refuse an exact duplicate (`error_if_duplicate_hash`). A create can
 * time out after Firefly has saved it, and an agent that retries would otherwise enter the same money twice.
 */
const DUPLICATE_GUARD = { error_if_duplicate_hash: true } as const;

/**
 * Household fork: a transfer between two of the family's accounts often reaches the receiving account a day or more
 * before or after it leaves the paying one, so each account matches its own statement only with both dates. Firefly
 * keeps the second as `book_date`; create and update pass it through.
 */
export const BOOK_DATE_HINT =
  "For a transfer: the day the money reached the receiving account, from that account's statement, when it differs from date (the day it left the paying account).";

export async function createTransaction(
  client: FireflyClient,
  params: {
    type: 'withdrawal' | 'deposit' | 'transfer';
    date: string;
    book_date?: string;
    amount: string;
    description: string;
    source_id?: string;
    destination_id?: string;
    category_name?: string;
    budget_id?: string;
    currency_code?: string;
    notes?: string;
    tags?: string[];
  },
): Promise<UnwrappedSingle> {
  const split: Record<string, unknown> = {
    type: params.type,
    date: params.date,
    amount: params.amount,
    description: params.description,
  };
  if (params.book_date !== undefined) split.book_date = params.book_date;
  if (params.source_id !== undefined) split.source_id = params.source_id;
  if (params.destination_id !== undefined) split.destination_id = params.destination_id;
  if (params.category_name !== undefined) split.category_name = params.category_name;
  if (params.budget_id !== undefined) split.budget_id = params.budget_id;
  if (params.currency_code !== undefined) split.currency_code = params.currency_code;
  if (params.notes !== undefined) split.notes = params.notes;
  if (params.tags !== undefined) split.tags = params.tags;
  const response = await client.post<JsonApiSingleResponse>('/transactions', {
    apply_rules: APPLY_RULES,
    fire_webhooks: true,
    ...DUPLICATE_GUARD,
    transactions: [split],
  });
  return unwrapSingle(response);
}

/**
 * Household fork: Firefly deletes every line of an entry that a PUT leaves out, and upstream sent a single line with
 * no `transaction_journal_id`, so editing a split entry deleted its other lines. This version reads the entry first,
 * edits one named line (required when there are several), and sends every other line back by its id, unchanged.
 * A tag list without a Source tag keeps the line's Source tags (`keepSourceTags`).
 */
export async function updateTransaction(
  client: FireflyClient,
  id: string,
  params: {
    transaction_journal_id?: string;
    type?: 'withdrawal' | 'deposit' | 'transfer';
    date?: string;
    book_date?: string;
    amount?: string;
    description?: string;
    source_id?: string;
    destination_id?: string;
    category_name?: string;
    budget_id?: string;
    currency_code?: string;
    notes?: string;
    tags?: string[];
  },
): Promise<UnwrappedSingle> {
  const { groupTitle, journals } = await fetchJournals(client, id);
  const lineIds = journals.map((journal) => String(journal.transaction_journal_id));
  let lineId = params.transaction_journal_id;
  if (lineId === undefined) {
    if (journals.length > 1) {
      throw new Error(
        `Transaction ${id} has ${journals.length} lines (${lineIds.join(', ')}). Pass transaction_journal_id for the line to change; the other lines are kept. To change how the charge is divided, use split_transaction.`,
      );
    }
    lineId = lineIds[0];
  } else if (!lineIds.includes(String(lineId))) {
    throw new Error(`Line ${lineId} is not part of transaction ${id}; its lines are ${lineIds.join(', ')}.`);
  }
  const target = journals[lineIds.indexOf(String(lineId))];
  const split: Record<string, unknown> = { transaction_journal_id: String(lineId) };
  if (params.type !== undefined) split.type = params.type;
  if (params.date !== undefined) split.date = params.date;
  if (params.book_date !== undefined) split.book_date = params.book_date;
  if (params.amount !== undefined) split.amount = params.amount;
  if (params.description !== undefined) split.description = params.description;
  if (params.source_id !== undefined) split.source_id = params.source_id;
  if (params.destination_id !== undefined) split.destination_id = params.destination_id;
  if (params.category_name !== undefined) split.category_name = params.category_name;
  if (params.budget_id !== undefined) split.budget_id = params.budget_id;
  if (params.currency_code !== undefined) split.currency_code = params.currency_code;
  if (params.notes !== undefined) split.notes = params.notes;
  if (params.tags !== undefined) split.tags = keepSourceTags(params.tags, target.tags);
  const others = lineIds
    .filter((other) => other !== String(lineId))
    .map((other) => ({ transaction_journal_id: other }));
  const body: Record<string, unknown> = {
    apply_rules: APPLY_RULES,
    fire_webhooks: true,
    transactions: [split, ...others],
  };
  // Firefly requires a group title on an entry with more than one line.
  if (journals.length > 1) body.group_title = groupTitle ?? String(journals[0].description ?? '');
  const response = await client.put<JsonApiSingleResponse>(`/transactions/${id}`, body);
  return unwrapSingle(response);
}

/**
 * Household fork: divides an existing charge into item lines (a receipt with items in different categories) without
 * creating a transaction. The lines must add up to the charge to the cent. Existing lines are reused, a line of the
 * same amount first and then in order, so their ids, external ids and attachments stay; a line left over is removed,
 * which is refused when it has an attachment. Accounts, type and date come from the existing lines. A new line takes
 * the tags and book date of the line it was split from (the entry's first line), so the Source tag and the bank's
 * posting day carry over; a line given its own tags keeps the Source tags all the same (`keepSourceTags`).
 */
export async function splitTransaction(
  client: FireflyClient,
  id: string,
  params: {
    group_title?: string;
    lines: Array<{
      amount: string;
      description: string;
      category_name?: string;
      budget_id?: string;
      tags?: string[];
      notes?: string;
    }>;
  },
): Promise<UnwrappedSingle> {
  const { groupTitle, journals } = await fetchJournals(client, id);
  const charge = journals.reduce((sum, journal) => sum + cents(journal.amount), 0);
  const total = params.lines.reduce((sum, line) => sum + cents(line.amount), 0);
  if (total !== charge) {
    throw new Error(
      `The lines add up to ${(total / 100).toFixed(2)}, but the charge is ${(charge / 100).toFixed(2)}. They must match to the cent.`,
    );
  }
  const free = [...journals];
  const claimed = new Map<number, Journal>();
  params.lines.forEach((line, index) => {
    const same = free.find((journal) => cents(journal.amount) === cents(line.amount));
    if (same) {
      claimed.set(index, same);
      free.splice(free.indexOf(same), 1);
    }
  });
  params.lines.forEach((_line, index) => {
    if (!claimed.has(index) && free.length > 0) claimed.set(index, free.shift() as Journal);
  });
  if (free.length > 0) {
    const dropped = new Set(free.map((journal) => String(journal.transaction_journal_id)));
    const attachments = await client.get<JsonApiListResponse>(`/transactions/${id}/attachments`);
    const held = (attachments?.data ?? []).filter((attachment) =>
      dropped.has(String((attachment.attributes as Record<string, unknown>)?.attachable_id)),
    );
    if (held.length > 0) {
      throw new Error(
        `Splitting into ${params.lines.length} lines would remove line(s) ${[...dropped].join(', ')}, which hold attachment(s). Use at least ${journals.length} lines, or ask a person.`,
      );
    }
  }
  const first = journals[0];
  const legs = params.lines.map((line, index) => {
    const base = claimed.get(index) ?? first;
    const leg: Record<string, unknown> = {
      type: base.type ?? first.type,
      date: base.date ?? first.date,
      amount: (cents(line.amount) / 100).toFixed(2),
      description: line.description,
      source_id: base.source_id ?? first.source_id,
      destination_id: base.destination_id ?? first.destination_id,
    };
    if (claimed.has(index)) {
      leg.transaction_journal_id = String((claimed.get(index) as Journal).transaction_journal_id);
    } else if (base.book_date) {
      leg.book_date = base.book_date;
    }
    if (line.category_name !== undefined) leg.category_name = line.category_name;
    if (line.budget_id !== undefined) leg.budget_id = line.budget_id;
    if (line.tags !== undefined) leg.tags = keepSourceTags(line.tags, base.tags);
    else if (!claimed.has(index)) leg.tags = tagList(base.tags);
    if (line.notes !== undefined) leg.notes = line.notes;
    return leg;
  });
  const body: Record<string, unknown> = { apply_rules: APPLY_RULES, fire_webhooks: true, transactions: legs };
  if (legs.length > 1) {
    body.group_title = params.group_title ?? groupTitle ?? String(first.description ?? '');
  }
  const response = await client.put<JsonApiSingleResponse>(`/transactions/${id}`, body);
  return unwrapSingle(response);
}

/**
 * Household fork: the bank import (external ids starting `ff3-`) looks back 7 days each night and re-creates any
 * entry it cannot find, so a delete of an entry it brought in during the last 8 days is refused. A delete reads the
 * entry first and returns what it removed, so the agent can report the lines, amounts and external ids it deleted.
 */
export const IMPORT_WINDOW_DAYS = 8;

export async function deleteTransaction(
  client: FireflyClient,
  id: string,
  now: Date = new Date(),
): Promise<{ deleted: true; id: string; title: string | null; lines: Array<Record<string, unknown>> }> {
  const { groupTitle, journals } = await fetchJournals(client, id);
  const recent = journals.filter((journal) => {
    const external = String(journal.external_id ?? '');
    const date = new Date(String(journal.date ?? ''));
    const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
    return external.startsWith('ff3-') && !Number.isNaN(ageDays) && ageDays < IMPORT_WINDOW_DAYS;
  });
  if (recent.length > 0) {
    const dates = recent.map((journal) => String(journal.date).slice(0, 10)).join(', ');
    throw new Error(
      `Transaction ${id} came from the bank import within the last ${IMPORT_WINDOW_DAYS} days (${dates}). The nightly import looks back 7 days and would re-create it; delete it once it is ${IMPORT_WINDOW_DAYS} days old.`,
    );
  }
  await client.delete(`/transactions/${id}`);
  const lines = journals.map((journal) => ({
    transaction_journal_id: String(journal.transaction_journal_id),
    date: String(journal.date ?? '').slice(0, 10),
    amount: Number(journal.amount).toFixed(2),
    description: journal.description,
    source_name: journal.source_name,
    destination_name: journal.destination_name,
    category_name: journal.category_name ?? null,
    external_id: journal.external_id ?? null,
  }));
  return { deleted: true, id, title: groupTitle, lines };
}

export async function searchTransactions(
  client: FireflyClient,
  params: { query: string; page?: number; limit?: number },
): Promise<UnwrappedList> {
  const query: QueryParams = { query: params.query, page: params.page, limit: params.limit };
  const response = await client.get<JsonApiListResponse>('/search/transactions', query);
  return unwrapList(response);
}

/**
 * Household fork: Firefly's bulk endpoint (`/data/bulk/transactions`) only moves every entry from one account to
 * another, and refused upstream's search query outright, so this tool never changed anything. It now finds the lines
 * with Firefly's search and edits each entry through the same path as `update_transaction`, sending every other line
 * back by id. Tags are added and removed rather than replaced, so no line loses a tag nobody named. A line that would
 * not change is skipped, so a run cut short by `max_entries` resumes where it stopped when called again with the
 * same query. `dry_run` lists what would change and writes nothing.
 */
export const BULK_DEFAULT_MAX_ENTRIES = 25;

type BulkParams = {
  query: string;
  category_name?: string;
  budget_id?: string;
  add_tags?: string[];
  remove_tags?: string[];
  notes?: string;
  dry_run?: boolean;
  max_entries?: number;
};

export async function bulkUpdateTransactions(client: FireflyClient, params: BulkParams): Promise<unknown> {
  if (
    params.category_name === undefined &&
    params.budget_id === undefined &&
    params.notes === undefined &&
    !params.add_tags?.length &&
    !params.remove_tags?.length
  ) {
    throw new Error('Nothing to change: give category_name, budget_id, notes, add_tags or remove_tags.');
  }
  const add = params.add_tags ?? [];
  const remove = new Set(params.remove_tags ?? []);
  const matched = new Map<string, Set<string>>();
  for (let page = 1; ; page++) {
    const response = await client.get<JsonApiListResponse>('/search/transactions', {
      query: params.query,
      page,
      limit: 100,
    });
    for (const group of response?.data ?? []) {
      const lines = ((group.attributes as Record<string, unknown>)?.transactions ?? []) as Journal[];
      const ids = matched.get(String(group.id)) ?? new Set<string>();
      for (const line of lines) ids.add(String(line.transaction_journal_id));
      matched.set(String(group.id), ids);
    }
    const meta = response?.meta as { pagination?: { total_pages?: number } } | undefined;
    const pages = Number(meta?.pagination?.total_pages ?? 1);
    if (page >= pages) break;
  }
  const max = params.max_entries ?? BULK_DEFAULT_MAX_ENTRIES;
  const changes: Array<Record<string, unknown>> = [];
  let entries = 0;
  let remaining = 0;
  for (const [groupId, lineIds] of matched) {
    const { groupTitle, journals } = await fetchJournals(client, groupId);
    const legs: Array<Record<string, unknown>> = [];
    const changed: Array<Record<string, unknown>> = [];
    for (const journal of journals) {
      const id = String(journal.transaction_journal_id);
      const leg: Record<string, unknown> = { transaction_journal_id: id };
      if (lineIds.has(id)) {
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        const set = (field: string, current: unknown, next: unknown) => {
          if (next === undefined || JSON.stringify(current ?? null) === JSON.stringify(next)) return;
          before[field] = current ?? null;
          after[field] = next;
          leg[field] = next;
        };
        set('category_name', journal.category_name, params.category_name);
        set('budget_id', journal.budget_id == null ? null : String(journal.budget_id), params.budget_id);
        set('notes', journal.notes, params.notes);
        const tags = tagList(journal.tags);
        const nextTags = [...tags.filter((tag) => !remove.has(tag)), ...add.filter((tag) => !tags.includes(tag))];
        if (JSON.stringify(nextTags) !== JSON.stringify(tags)) set('tags', tags, nextTags);
        if (Object.keys(after).length > 0) {
          changed.push({
            id: groupId,
            transaction_journal_id: id,
            date: String(journal.date ?? '').slice(0, 10),
            amount: Number(journal.amount).toFixed(2),
            description: journal.description,
            before,
            after,
          });
        }
      }
      legs.push(leg);
    }
    if (changed.length === 0) continue;
    if (entries >= max) {
      remaining++;
      continue;
    }
    entries++;
    if (!params.dry_run) {
      const body: Record<string, unknown> = { apply_rules: APPLY_RULES, fire_webhooks: true, transactions: legs };
      if (journals.length > 1) body.group_title = groupTitle ?? String(journals[0].description ?? '');
      await client.put<JsonApiSingleResponse>(`/transactions/${groupId}`, body);
    }
    changes.push(...changed);
  }
  return {
    dry_run: Boolean(params.dry_run),
    matched_entries: matched.size,
    changed_entries: entries,
    remaining_entries: remaining,
    lines: changes,
  };
}

export async function createSplitTransaction(
  client: FireflyClient,
  params: {
    type: 'withdrawal' | 'deposit' | 'transfer';
    date: string;
    source_id?: string;
    destination_id?: string;
    currency_code?: string;
    group_title?: string;
    splits: Array<{
      amount: string;
      description: string;
      category_name?: string;
      budget_id?: string;
      tags?: string[];
      notes?: string;
    }>;
  },
): Promise<UnwrappedSingle> {
  const transactions = params.splits.map((split) => {
    const item: Record<string, unknown> = {
      type: params.type,
      date: params.date,
      amount: split.amount,
      description: split.description,
    };
    if (params.source_id !== undefined) item.source_id = params.source_id;
    if (params.destination_id !== undefined) item.destination_id = params.destination_id;
    if (params.currency_code !== undefined) item.currency_code = params.currency_code;
    if (split.category_name !== undefined) item.category_name = split.category_name;
    if (split.budget_id !== undefined) item.budget_id = split.budget_id;
    if (split.tags !== undefined) item.tags = split.tags;
    if (split.notes !== undefined) item.notes = split.notes;
    return item;
  });
  const body: Record<string, unknown> = {
    apply_rules: APPLY_RULES,
    fire_webhooks: true,
    ...DUPLICATE_GUARD,
    transactions,
  };
  if (params.group_title !== undefined) body.group_title = params.group_title;
  const response = await client.post<JsonApiSingleResponse>('/transactions', body);
  return unwrapSingle(response);
}

export function registerTransactionTools(server: McpServer, client: FireflyClient): void {
  defineTool(
    server,
    'get_transactions',
    {
      title: 'Get Transactions',
      description:
        'Get transactions from Firefly III. Filter by type (withdrawal/deposit/transfer/reconciliation), account ID, or date range. Dates must be YYYY-MM-DD. Use get_transaction to fetch a single transaction by ID.',
      inputSchema: {
        type: z
          .enum(['withdrawal', 'deposit', 'transfer', 'reconciliation'])
          .optional()
          .describe('Transaction type filter'),
        accountId: z
          .string()
          .optional()
          .describe(
            'Filter by account ID — use get_accounts to find valid IDs. Internally delegates to the same endpoint as get_account_transactions.',
          ),
        start: dateSchema.optional().describe('Start date (YYYY-MM-DD)'),
        end: dateSchema.optional().describe('End date (YYYY-MM-DD)'),
        page: z.number().int().positive().optional().default(1).describe('Page number'),
        limit: z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ type, accountId, start, end, page, limit }) =>
      fetchTransactions(client, {
        type: type,
        accountId: accountId,
        start: start,
        end: end,
        page: page,
        limit: limit,
      }),
  );

  defineTool(
    server,
    'get_transaction',
    {
      title: 'Get Transaction',
      description: `Get a single Firefly III transaction by its numeric ID, including all splits. Use get_transactions to find valid transaction IDs. ${GROUP_ID_HINT}`,
      inputSchema: {
        id: z.string().describe('Transaction ID'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ id }) => fetchTransaction(client, id),
  );

  defineTool(
    server,
    'create_transaction',
    {
      title: 'Create Transaction',
      description: `Create a new transaction in Firefly III. Use get_accounts to find source and destination account IDs. ${GROUP_ID_HINT}`,
      inputSchema: {
        type: z.enum(['withdrawal', 'deposit', 'transfer']).describe('Transaction type'),
        date: dateOrDateTimeSchema.describe('Transaction date (YYYY-MM-DD or RFC 3339 date-time with timezone)'),
        book_date: dateOrDateTimeSchema.optional().describe(BOOK_DATE_HINT),
        amount: z.string().describe('Amount as a positive number string, e.g. "42.50"'),
        description: z.string().describe('Short description of the transaction'),
        source_id: z.string().optional().describe('Source account ID (required for withdrawals and transfers)'),
        destination_id: z.string().optional().describe('Destination account ID (required for deposits and transfers)'),
        category_name: z.string().optional().describe(`Category name to assign. ${CATEGORY_NAME_HINT}`),
        budget_id: z.string().optional().describe('Budget ID — use get_budgets to find valid IDs'),
        currency_code: z.string().optional().describe('Currency code (e.g. EUR, USD). Defaults to account currency.'),
        notes: z.string().optional().describe('Additional notes'),
        tags: z.array(z.string()).optional().describe('Tags to attach'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (params) => createTransaction(client, params),
  );

  defineTool(
    server,
    'update_transaction',
    {
      title: 'Update Transaction',
      description:
        'Update one line of an existing transaction in Firefly III. Only fields provided will be changed, and every other line of the entry is kept. An entry with several lines (a split) needs transaction_journal_id to name the line; get_transaction lists them. The amount can be changed; to divide a charge across lines, use split_transaction. Tags replace the line\'s tag list, so send every tag it should keep, except that its "Source: " tag is kept unless you send a Source tag of your own. Firefly rules are not run. Use get_transaction to confirm the ID before updating.',
      inputSchema: {
        id: z.string().describe(groupIdField('updates')),
        transaction_journal_id: z
          .string()
          .optional()
          .describe(
            'The line to change, from `transactions[].transaction_journal_id` in get_transaction. Required when the entry has more than one line.',
          ),
        type: z.enum(['withdrawal', 'deposit', 'transfer']).optional().describe('Transaction type'),
        date: dateOrDateTimeSchema
          .optional()
          .describe('Transaction date (YYYY-MM-DD or RFC 3339 date-time with timezone)'),
        book_date: dateOrDateTimeSchema.optional().describe(BOOK_DATE_HINT),
        amount: z.string().optional().describe('New amount for this line as a positive number string, e.g. "42.50"'),
        description: z.string().optional().describe('Short description'),
        source_id: z.string().optional().describe('Source account ID'),
        destination_id: z.string().optional().describe('Destination account ID'),
        category_name: z.string().optional().describe(`Category name. ${CATEGORY_NAME_HINT}`),
        budget_id: z.string().optional().describe('Budget ID'),
        currency_code: z.string().optional().describe('Currency code (e.g. EUR, USD)'),
        notes: z.string().optional().describe('Additional notes'),
        tags: z.array(z.string()).optional().describe('Tags (replaces existing tags)'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ id, ...params }) => updateTransaction(client, id, params),
  );

  defineTool(
    server,
    'split_transaction',
    {
      title: 'Split Transaction',
      description:
        "Divide an existing transaction into item lines, such as a receipt with items in different categories, without creating a new transaction. The lines must add up to the entry's total to the cent (change the total first with update_transaction's amount if it should differ). Existing lines are reused (one of the same amount first, then in order), so their ids, tags and attachments stay; a new line takes the tags and book date of the entry's first line; a line given its own tags keeps its \"Source: \" tag unless you send one. A leftover line is removed, which is refused when it holds an attachment. Accounts, type and date are kept; change a line's accounts afterwards with update_transaction. Firefly rules are not run. Use get_transaction first.",
      inputSchema: {
        id: z.string().describe(groupIdField('splits')),
        group_title: z
          .string()
          .optional()
          .describe("Title for the whole entry when it has more than one line; defaults to the entry's current title"),
        lines: z
          .array(
            z.object({
              amount: z.string().describe('Amount as a positive number string, e.g. "12.97"'),
              description: z.string().describe('What this line bought'),
              category_name: z.string().optional().describe(`Category name. ${CATEGORY_NAME_HINT}`),
              budget_id: z.string().optional().describe('Budget ID'),
              tags: z
                .array(z.string())
                .optional()
                .describe(
                  "Tags for this line (replaces its tags; its Source tag is kept). Omit to keep the line's tags, or for a new line the first line's",
                ),
              notes: z.string().optional().describe('Notes for this line (replaces its notes)'),
            }),
          )
          .min(1)
          .describe('The lines the charge is divided into; they must add up to the charge'),
      },
      annotations: UPDATE_ANNOTATIONS,
    },
    ({ id, ...params }) => splitTransaction(client, id, params),
  );

  defineTool(
    server,
    'delete_transaction',
    {
      title: 'Delete Transaction',
      description:
        'Delete a whole entry (every line of it) from Firefly III, and return the lines, amounts, dates and external ids it removed. Refused for an entry the bank import brought in during the last 8 days, because the nightly import looks back 7 days and would re-create it. Use get_transaction to confirm the entry before deleting.',
      inputSchema: {
        id: z.string().describe(groupIdField('deletes')),
      },
      annotations: DELETE_ANNOTATIONS,
    },
    ({ id }) => deleteTransaction(client, id),
  );

  defineTool(
    server,
    'search_transactions',
    {
      title: 'Search Transactions',
      description:
        'Search for transactions in Firefly III by keyword. Searches across descriptions, notes, and other fields.',
      inputSchema: {
        query: z.string().describe('Search query'),
        page: z.number().int().positive().optional().default(1).describe('Page number'),
        limit: z.number().int().positive().max(100).optional().default(50).describe('Results per page (max 100)'),
      },
      annotations: READ_ANNOTATIONS,
    },
    ({ query, page, limit }) =>
      searchTransactions(client, {
        query: query,
        page: page,
        limit: limit,
      }),
  );

  defineTool(
    server,
    'create_split_transaction',
    {
      title: 'Create Split Transaction',
      description:
        'Create a split transaction in Firefly III — one receipt divided across multiple categories, budgets, or descriptions. All splits share the same type, date, and accounts. Use get_accounts to find source and destination account IDs.',
      inputSchema: {
        type: z.enum(['withdrawal', 'deposit', 'transfer']).describe('Transaction type (shared across all splits)'),
        date: dateOrDateTimeSchema.describe(
          'Transaction date (YYYY-MM-DD or RFC 3339 date-time with timezone, shared across all splits)',
        ),
        source_id: z.string().optional().describe('Source account ID (required for withdrawals and transfers)'),
        destination_id: z.string().optional().describe('Destination account ID (required for deposits and transfers)'),
        currency_code: z.string().optional().describe('Currency code (e.g. EUR, USD). Defaults to account currency.'),
        group_title: z.string().optional().describe('Optional label for the transaction group'),
        splits: z
          .array(
            z.object({
              amount: z.string().describe('Amount as a positive number string, e.g. "42.50"'),
              description: z.string().describe('Description for this split'),
              category_name: z.string().optional().describe(`Category name. ${CATEGORY_NAME_HINT}`),
              budget_id: z.string().optional().describe('Budget ID — use get_budgets to find valid IDs'),
              tags: z.array(z.string()).optional().describe('Tags'),
              notes: z.string().optional().describe('Notes'),
            }),
          )
          .min(2)
          .describe('At least 2 splits required'),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (params) => createSplitTransaction(client, params),
  );

  defineTool(
    server,
    'bulk_update_transactions',
    {
      title: 'Bulk Update Transactions',
      description:
        "Change many transactions at once: every line Firefly's search finds for the query (same syntax as search_transactions) gets the fields given, and every other line of each entry is kept. Tags are added and removed, never replaced. Run with dry_run first to list exactly what would change. Each entry takes 1 to 30 seconds to save (older ones longer), so one call changes at most max_entries entries (default 25) and reports remaining_entries; call again with the same query to continue, since lines already changed are skipped. Firefly rules are not run.",
      inputSchema: {
        query: z.string().describe('Search query to select transactions (same syntax as search_transactions)'),
        category_name: z
          .string()
          .optional()
          .describe(`Set category for all matched transactions. ${CATEGORY_NAME_HINT}`),
        budget_id: z.string().optional().describe('Set budget for all matched transactions'),
        add_tags: z.array(z.string()).optional().describe('Tags to add to every matched line'),
        remove_tags: z.array(z.string()).optional().describe('Tags to remove from every matched line'),
        notes: z.string().optional().describe('Replace the notes on all matched lines'),
        dry_run: z
          .boolean()
          .optional()
          .default(false)
          .describe('List the lines that would change, with before and after, and write nothing'),
        max_entries: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Most entries to change in this call (default ${BULK_DEFAULT_MAX_ENTRIES})`),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    (params) => bulkUpdateTransactions(client, params),
  );
}
