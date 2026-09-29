import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionGate,
  DraftJournal,
  requestBudget,
  isAbort,
} from '../dist/editor-session.js';

test('旧会话的结果和关闭不会拥有新会话令牌，旧信号已取消', () => {
  const gate = new SessionGate(),
    first = gate.begin(),
    next = gate.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(gate.current(first), false);
  assert.equal(gate.current(next), true);
  gate.cancel();
  assert.equal(gate.current(next), false);
});
test('行预算传播外部取消，可释放定时器', () => {
  const controller = new AbortController(),
    budget = requestBudget(controller.signal, 1000);
  assert.ok(budget.remaining() <= 1000);
  controller.abort();
  assert.equal(budget.signal.aborted, true);
  budget.dispose();
  assert.equal(isAbort(budget.signal.reason), true);
});
test('草稿串行保存以新版本为基准，快速后续输入不被旧写覆盖', async () => {
  const calls = [];
  let release;
  const firstDone = new Promise((resolve) => (release = resolve));
  const journal = new DraftJournal(
    async (data) => {
      calls.push(structuredClone(data));
      if (calls.length === 1) await firstDone;
      return { ...data, revision: data.revision + 1 };
    },
    { id: 'draft', revision: 0 },
  );
  journal.schedule({ kind: 'single', value: 'first' }, 1000);
  const first = journal.flush();
  await Promise.resolve();
  await Promise.resolve();
  journal.schedule({ kind: 'single', value: 'latest' }, 1000);
  const latest = journal.flush();
  release();
  await Promise.all([first, latest]);
  assert.deepEqual(
    calls.map((x) => [x.value, x.revision]),
    [
      ['first', 0],
      ['latest', 1],
    ],
  );
  assert.equal(journal.meta.revision, 2);
  journal.finish();
});
test('草稿保存失败仍保留待保存内容，重试不会伪增版本', async () => {
  let count = 0;
  const journal = new DraftJournal(
    async (data) => {
      if (!count++) throw new Error('暂不可用');
      return { ...data, revision: data.revision + 1 };
    },
    { id: 'draft', revision: 3 },
  );
  journal.schedule({ kind: 'batch', raw: '保留原文' }, 1000);
  await assert.rejects(journal.flush(), /暂不可用/);
  assert.equal(journal.meta.revision, 3);
  await journal.flush();
  assert.equal(journal.meta.revision, 4);
  journal.finish();
});
test('提交完成后不再写回已删除的草稿', async () => {
  let count = 0;
  const journal = new DraftJournal(async (data) => {
    count++;
    return { ...data, revision: 1 };
  });
  journal.schedule({ raw: 'text' }, 1000);
  await journal.flush();
  journal.finish();
  journal.schedule({ raw: 'late input' }, 1);
  await journal.flush();
  assert.equal(count, 1);
});

test('较早写入失败时不能把旧内容排到已排队的新输入之后', async () => {
  const calls = [];
  let rejectFirst;
  const waiting = new Promise((_resolve, reject) => (rejectFirst = reject));
  const journal = new DraftJournal(
    async (draft) => {
      calls.push(draft.raw);
      if (calls.length === 1) await waiting;
      return { ...draft, revision: draft.revision + 1 };
    },
    { id: 'draft', revision: 0 },
  );
  journal.schedule({ raw: '旧内容' }, 1000);
  const first = journal.flush();
  first.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  journal.schedule({ raw: '最新内容' }, 1000);
  const second = journal.flush();
  rejectFirst(new Error('暂时失败'));
  await second;
  await journal.flush();
  assert.deepEqual(calls, ['旧内容', '最新内容']);
  assert.equal(journal.meta.revision, 1);
  journal.finish();
});
