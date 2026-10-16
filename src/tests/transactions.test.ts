import { describe, expect, it, vi } from 'vitest';
import type { FireflyClient } from '../client.js';
import {
  bulkUpdateTransactions,
  createSplitTransaction,
  createTransaction,
  deleteTransaction,
  fetchTransaction,
  fetchTransactions,
  registerTransactionTools,
  searchTransactions,
  splitTransaction,
  updateTransaction,
} from '../tools/transactions.js';
import { createMockServer } from './_helpers.js';

const mockClient = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as FireflyClient;

const listFixture = {
  data: [
    {
      id: '101',
      type: 'transactions',
      attributes: { description: 'Groceries', amount: '-45.00', date: '2026-01-15' },
      links: { self: 'https://firefly.example.com/api/v1/transactions/101' },
    },
  ],
  meta: { pagination: { current_page: 1, total_pages: 3, total: 120 } },
};

const singleFixture = {
  data: {
    id: '123',
    type: 'transactions',
    attributes: { description: 'Salary', amount: '3000.00', date: '2026-01-01' },
    links: { self: 'https://firefly.example.com/api/v1/transactions/123' },
  },
};

describe('fetchTransactions', () => {
  it('calls /transactions with all provided filters except accountId', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchTransactions(mockClient, {
      type: 'withdrawal',
      start: '2026-01-01',
      end: '2026-01-31',
      page: 1,
      limit: 50,
    });
    expect(mockClient.get).toHaveBeenCalledWith('/transactions', {
      type: 'withdrawal',
      start: '2026-01-01',
      end: '2026-01-31',
      page: 1,
      limit: 50,
    });
  });

  it('omits undefined filters', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await fetchTransactions(mockClient, { page: 1, limit: 20 });
    expect(mockClient.get).toHaveBeenCalledWith('/transactions', { page: 1, limit: 20 });
  });

  it('returns flat items with pagination', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    const result = await fetchTransactions(mockClient, { page: 1, limit: 50 });
    expect(result.data[0]).toEqual({ description: 'Groceries', amount: '-45.00', date: '2026-01-15', id: '101' });
    expect(result.pagination).toEqual({ page: 1, totalPages: 3, total: 120 });
  });

  // Regression test for #101: /transactions has no account_id filter and silently ignores it,
  // so passing accountId must delegate to /accounts/{id}/transactions instead — the endpoint that
  // actually filters. Two different accountId values against the same window must not collide.
  describe('accountId filtering (#101)', () => {
    it('delegates to /accounts/:id/transactions instead of querying /transactions', async () => {
      mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
      await fetchTransactions(mockClient, {
        accountId: '5',
        type: 'withdrawal',
        start: '2026-01-01',
        end: '2026-01-31',
        page: 1,
        limit: 50,
      });
      expect(mockClient.get).toHaveBeenCalledWith('/accounts/5/transactions', {
        type: 'withdrawal',
        start: '2026-01-01',
        end: '2026-01-31',
        page: 1,
        limit: 50,
      });
    });

    it('produces different requests for different accountId values on the same window', async () => {
      mockClient.get = vi.fn().mockResolvedValue(listFixture);
      await fetchTransactions(mockClient, { accountId: '1', start: '2026-09-01', end: '2026-09-30' });
      await fetchTransactions(mockClient, { accountId: '633', start: '2026-09-01', end: '2026-09-30' });
      const calls = (mockClient.get as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe('/accounts/1/transactions');
      expect(calls[1][0]).toBe('/accounts/633/transactions');
      expect(calls[0][0]).not.toBe(calls[1][0]);
    });

    it('strips a completion-style label suffix from accountId before using it as a path segment', async () => {
      mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
      await fetchTransactions(mockClient, { accountId: '5 (Checking)' });
      expect(mockClient.get).toHaveBeenCalledWith('/accounts/5/transactions', {});
    });
  });
});

describe('fetchTransaction', () => {
  it('calls /transactions/:id', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(singleFixture);
    await fetchTransaction(mockClient, '123');
    expect(mockClient.get).toHaveBeenCalledWith('/transactions/123');
  });

  it('returns flat item', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(singleFixture);
    const result = await fetchTransaction(mockClient, '123');
    expect(result).toEqual({ description: 'Salary', amount: '3000.00', date: '2026-01-01', id: '123' });
  });
});

const writeSingleFixture = {
  data: {
    id: '5',
    type: 'transactions',
    attributes: { description: 'Groceries', amount: '42.50', type: 'withdrawal' },
    links: {},
  },
};

describe('createTransaction', () => {
  it('posts to /transactions with wrapped body', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    await createTransaction(mockClient, {
      type: 'withdrawal',
      date: '2024-01-15T09:30:00Z',
      amount: '42.50',
      description: 'Groceries',
      source_id: '1',
    });
    expect(mockClient.post).toHaveBeenCalledWith('/transactions', {
      apply_rules: false,
      fire_webhooks: true,
      transactions: [
        expect.objectContaining({
          type: 'withdrawal',
          date: '2024-01-15T09:30:00Z',
          amount: '42.50',
          description: 'Groceries',
          source_id: '1',
        }),
      ],
    });
  });

  it('returns unwrapped single', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    const result = await createTransaction(mockClient, {
      type: 'withdrawal',
      date: '2024-01-15',
      amount: '42.50',
      description: 'Groceries',
    });
    expect(result).toEqual({ description: 'Groceries', amount: '42.50', type: 'withdrawal', id: '5' });
  });
});

// Household fork: a group as Firefly returns it, with one journal per line.
function groupFixture(journals: Array<Record<string, unknown>>, groupTitle: string | null = null) {
  return {
    data: { id: '5', type: 'transactions', attributes: { group_title: groupTitle, transactions: journals }, links: {} },
  };
}

const oneLine = groupFixture([
  {
    transaction_journal_id: '51',
    type: 'withdrawal',
    date: '2024-03-31T00:00:00-04:00',
    amount: '42.500000000000',
    description: 'AMAZON MKTPL',
    source_id: '1',
    destination_id: '9',
  },
]);

const threeLines = groupFixture(
  [
    {
      transaction_journal_id: '61',
      type: 'withdrawal',
      date: '2024-03-31',
      amount: '3.99',
      description: 'Batteries',
      source_id: '1',
      destination_id: '9',
    },
    {
      transaction_journal_id: '62',
      type: 'withdrawal',
      date: '2024-03-31',
      amount: '4.99',
      description: 'Mascara',
      source_id: '1',
      destination_id: '9',
    },
    {
      transaction_journal_id: '63',
      type: 'withdrawal',
      date: '2024-03-31',
      amount: '0.54',
      description: 'Tax',
      source_id: '1',
      destination_id: '9',
    },
  ],
  'Amazon order',
);

describe('updateTransaction (household fork)', () => {
  it('names the only line by its id and runs no rules', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(oneLine);
    mockClient.put = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    await updateTransaction(mockClient, '5', {
      date: '2024-01-15T11:30:00+02:00',
      description: 'Updated',
    });
    expect(mockClient.put).toHaveBeenCalledWith('/transactions/5', {
      apply_rules: false,
      fire_webhooks: true,
      transactions: [{ transaction_journal_id: '51', date: '2024-01-15T11:30:00+02:00', description: 'Updated' }],
    });
  });

  it('returns unwrapped single', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(oneLine);
    mockClient.put = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    const result = await updateTransaction(mockClient, '5', { description: 'Groceries' });
    expect(result).toEqual({ description: 'Groceries', amount: '42.50', type: 'withdrawal', id: '5' });
  });

  it('sends every other line of a split back by id, so Firefly keeps them', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(threeLines);
    mockClient.put = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    await updateTransaction(mockClient, '5', { transaction_journal_id: '62', category_name: 'Personal Care: Makeup' });
    expect(mockClient.put).toHaveBeenCalledWith('/transactions/5', {
      apply_rules: false,
      fire_webhooks: true,
      group_title: 'Amazon order',
      transactions: [
        { transaction_journal_id: '62', category_name: 'Personal Care: Makeup' },
        { transaction_journal_id: '61' },
        { transaction_journal_id: '63' },
      ],
    });
  });

  it('refuses a split entry without a named line', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(threeLines);
    mockClient.put = vi.fn();
    await expect(updateTransaction(mockClient, '5', { description: 'x' })).rejects.toThrow(/has 3 lines/);
    expect(mockClient.put).not.toHaveBeenCalled();
  });

  it('refuses a line that is not part of the entry', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(threeLines);
    mockClient.put = vi.fn();
    await expect(updateTransaction(mockClient, '5', { transaction_journal_id: '99', notes: 'x' })).rejects.toThrow(
      /not part of transaction 5/,
    );
    expect(mockClient.put).not.toHaveBeenCalled();
  });

  it('refuses a new amount but accepts the current one', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(oneLine);
    mockClient.put = vi.fn();
    await expect(updateTransaction(mockClient, '5', { amount: '50.00' })).rejects.toThrow(/Amounts come from the bank/);
    expect(mockClient.put).not.toHaveBeenCalled();

    mockClient.get = vi.fn().mockResolvedValueOnce(oneLine);
    mockClient.put = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    await updateTransaction(mockClient, '5', { amount: '42.50', notes: 'same amount' });
    expect(mockClient.put).toHaveBeenCalledOnce();
  });
});

describe('splitTransaction (household fork)', () => {
  it('divides a one-line charge into item lines, keeping the existing line for the first', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(oneLine);
    mockClient.put = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    await splitTransaction(mockClient, '5', {
      group_title: 'Batteries and mascara',
      lines: [
        { amount: '30.00', description: 'Batteries', category_name: 'Home: Home Supplies: Misc' },
        { amount: '12.50', description: 'Mascara', category_name: 'Personal Care: Makeup', tags: ['For Melissa'] },
      ],
    });
    expect(mockClient.put).toHaveBeenCalledWith('/transactions/5', {
      apply_rules: false,
      fire_webhooks: true,
      group_title: 'Batteries and mascara',
      transactions: [
        {
          transaction_journal_id: '51',
          type: 'withdrawal',
          date: '2024-03-31T00:00:00-04:00',
          amount: '30.00',
          description: 'Batteries',
          source_id: '1',
          destination_id: '9',
          category_name: 'Home: Home Supplies: Misc',
        },
        {
          type: 'withdrawal',
          date: '2024-03-31T00:00:00-04:00',
          amount: '12.50',
          description: 'Mascara',
          source_id: '1',
          destination_id: '9',
          category_name: 'Personal Care: Makeup',
          tags: ['For Melissa'],
        },
      ],
    });
  });

  it('refuses lines that do not add up to the charge', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(oneLine);
    mockClient.put = vi.fn();
    await expect(
      splitTransaction(mockClient, '5', {
        lines: [
          { amount: '30.00', description: 'a' },
          { amount: '12.00', description: 'b' },
        ],
      }),
    ).rejects.toThrow(/add up to 42.00, but the charge is 42.50/);
    expect(mockClient.put).not.toHaveBeenCalled();
  });

  it('reuses existing lines in order and removes a leftover line that holds no attachment', async () => {
    mockClient.get = vi
      .fn()
      .mockResolvedValueOnce(threeLines)
      .mockResolvedValueOnce({ data: [], meta: { pagination: {} } });
    mockClient.put = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    await splitTransaction(mockClient, '5', {
      lines: [
        { amount: '5.29', description: 'Mascara with tax' },
        { amount: '4.23', description: 'Batteries with tax' },
      ],
    });
    expect(mockClient.get).toHaveBeenLastCalledWith('/transactions/5/attachments');
    const body = (mockClient.put as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      transactions: Array<Record<string, unknown>>;
    };
    expect(body.transactions.map((line) => line.transaction_journal_id)).toEqual(['61', '62']);
    expect(body.transactions.map((line) => line.amount)).toEqual(['5.29', '4.23']);
  });

  it('refuses to remove a line that holds an attachment', async () => {
    mockClient.get = vi
      .fn()
      .mockResolvedValueOnce(threeLines)
      .mockResolvedValueOnce({ data: [{ id: '7', type: 'attachments', attributes: { attachable_id: '63' } }] });
    mockClient.put = vi.fn();
    await expect(
      splitTransaction(mockClient, '5', {
        lines: [
          { amount: '4.53', description: 'a' },
          { amount: '4.99', description: 'b' },
        ],
      }),
    ).rejects.toThrow(/hold attachment/);
    expect(mockClient.put).not.toHaveBeenCalled();
  });
});

describe('deleteTransaction', () => {
  it('calls delete on /transactions/:id', async () => {
    mockClient.delete = vi.fn().mockResolvedValueOnce(undefined);
    await deleteTransaction(mockClient, '5');
    expect(mockClient.delete).toHaveBeenCalledWith('/transactions/5');
  });

  it('returns deleted confirmation', async () => {
    mockClient.delete = vi.fn().mockResolvedValueOnce(undefined);
    const result = await deleteTransaction(mockClient, '5');
    expect(result).toEqual({ deleted: true, id: '5' });
  });
});

describe('searchTransactions', () => {
  it('calls /search/transactions with query and pagination', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    await searchTransactions(mockClient, { query: 'groceries', page: 1, limit: 20 });
    expect(mockClient.get).toHaveBeenCalledWith('/search/transactions', {
      query: 'groceries',
      page: 1,
      limit: 20,
    });
  });

  it('returns flat items with pagination', async () => {
    mockClient.get = vi.fn().mockResolvedValueOnce(listFixture);
    const result = await searchTransactions(mockClient, { query: 'groceries' });
    expect(result.data[0]).toEqual({ description: 'Groceries', amount: '-45.00', date: '2026-01-15', id: '101' });
    expect(result.pagination).toEqual({ page: 1, totalPages: 3, total: 120 });
  });
});

describe('createSplitTransaction', () => {
  it('posts to /transactions with shared fields copied into each split', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    await createSplitTransaction(mockClient, {
      type: 'withdrawal',
      date: '2026-05-01T18:45:00-04:00',
      source_id: '1',
      splits: [
        { amount: '30.00', description: 'Groceries', category_name: 'Food' },
        { amount: '12.50', description: 'Cleaning supplies', category_name: 'Household' },
      ],
    });
    expect(mockClient.post).toHaveBeenCalledWith('/transactions', {
      apply_rules: false,
      fire_webhooks: true,
      transactions: [
        {
          type: 'withdrawal',
          date: '2026-05-01T18:45:00-04:00',
          source_id: '1',
          amount: '30.00',
          description: 'Groceries',
          category_name: 'Food',
        },
        {
          type: 'withdrawal',
          date: '2026-05-01T18:45:00-04:00',
          source_id: '1',
          amount: '12.50',
          description: 'Cleaning supplies',
          category_name: 'Household',
        },
      ],
    });
  });

  it('includes group_title when provided', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    await createSplitTransaction(mockClient, {
      type: 'withdrawal',
      date: '2026-05-01',
      group_title: 'Supermarket run',
      splits: [
        { amount: '30.00', description: 'Groceries' },
        { amount: '12.50', description: 'Cleaning supplies' },
      ],
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      '/transactions',
      expect.objectContaining({
        group_title: 'Supermarket run',
      }),
    );
  });

  it('returns unwrapped single', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    const result = await createSplitTransaction(mockClient, {
      type: 'withdrawal',
      date: '2026-05-01',
      splits: [
        { amount: '30.00', description: 'Groceries' },
        { amount: '12.50', description: 'Cleaning supplies' },
      ],
    });
    // amount comes from the mock fixture, not a computed sum
    expect(result).toEqual({ description: 'Groceries', amount: '42.50', type: 'withdrawal', id: '5' });
  });

  it('omits undefined shared optional fields from each split', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(writeSingleFixture);
    await createSplitTransaction(mockClient, {
      type: 'withdrawal',
      date: '2026-05-01',
      splits: [
        { amount: '30.00', description: 'Groceries' },
        { amount: '12.50', description: 'Cleaning supplies' },
      ],
    });
    const body = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(body.transactions[0]).not.toHaveProperty('source_id');
    expect(body.transactions[0]).not.toHaveProperty('destination_id');
    expect(body.transactions[0]).not.toHaveProperty('currency_code');
  });
});

describe('bulkUpdateTransactions', () => {
  it('sends query as a JSON-encoded URL query param per the OpenAPI spec', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(undefined);
    await bulkUpdateTransactions(mockClient, { query: 'description:coffee', category_name: 'Food', budget_id: '3' });
    expect(mockClient.post).toHaveBeenCalledWith('/data/bulk/transactions', undefined, {
      query: JSON.stringify({ where: 'description:coffee', update: { category_name: 'Food', budget_id: '3' } }),
    });
  });

  it('omits undefined update fields from the JSON query', async () => {
    mockClient.post = vi.fn().mockResolvedValueOnce(undefined);
    await bulkUpdateTransactions(mockClient, { query: 'description:groceries' });
    const call = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown,
      Record<string, string>,
    ];
    const sentQuery = JSON.parse(call[2].query) as { where: string; update: Record<string, unknown> };
    expect(sentQuery.where).toBe('description:groceries');
    expect(Object.keys(sentQuery.update)).toHaveLength(0);
  });
});

describe('handler smoke — transactions', () => {
  it('get_transactions handler returns text content on success', async () => {
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockResolvedValueOnce(listFixture) } as unknown as FireflyClient;
    registerTransactionTools(server, client);
    const result = await handlers.get('get_transactions')!({});
    expect(result).toMatchObject({ content: [{ type: 'text', text: expect.any(String) }] });
  });

  it('get_transactions handler returns isError on failure', async () => {
    const { server, handlers } = createMockServer();
    const client = { get: vi.fn().mockRejectedValueOnce(new Error('Network error')) } as unknown as FireflyClient;
    registerTransactionTools(server, client);
    const result = await handlers.get('get_transactions')!({});
    expect(result).toMatchObject({ isError: true });
  });

  // Regression test for a real mistake: transaction responses carry two different ids — the
  // top-level group `id` (what update/delete expect) and a `transaction_journal_id` nested inside
  // each item of `transactions[]` (usually an adjacent number). Passing the journal id to
  // update_transaction/delete_transaction silently edits or deletes a different transaction. These
  // assertions make sure the warning stays present if the tool descriptions are ever reworded.
  it('warns against transaction_journal_id in id-accepting tool descriptions', () => {
    const { server, toolConfigs } = createMockServer();
    registerTransactionTools(server, {} as unknown as FireflyClient);
    for (const name of ['get_transaction', 'create_transaction', 'update_transaction', 'delete_transaction']) {
      const config = toolConfigs.get(name);
      const text =
        name === 'update_transaction' || name === 'delete_transaction'
          ? config.inputSchema.id.description
          : config.description;
      expect(text, `${name} should warn about transaction_journal_id`).toContain('transaction_journal_id');
    }
  });
});

describe('category_name guidance', () => {
  it('warns on every category_name field that Firefly stores the string verbatim', () => {
    const { server, toolConfigs } = createMockServer();
    registerTransactionTools(server, {} as FireflyClient);
    for (const tool of ['create_transaction', 'update_transaction', 'bulk_update_transactions']) {
      expect(toolConfigs.get(tool).inputSchema.category_name.description).toContain('&amp;');
    }
    const splitShape = toolConfigs.get('create_split_transaction').inputSchema.splits.element.shape;
    expect(splitShape.category_name.description).toContain('&amp;');
  });
});
