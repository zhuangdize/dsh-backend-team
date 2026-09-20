/**
 * T-06 — 垂直切片 S-1（创建与字段校验，AC-001 / AC-002）验收用例。
 *
 * 运行命令（test-plan.md 固定）：`node --test test/customer-model.test.mjs`
 *
 * 装载方式说明（重要）：本命令必须在 Node 内置测试器的受限沙箱内直接执行——
 * 不允许写文件、不允许派生子进程、node_modules 不可读，因此这里不使用任何
 * 打包器，改用 Node 24 内置的 TypeScript 类型擦除：
 *   - 无相对 `.js` 说明符的源文件（domain / persistence / api）用 file: URL 直接 import；
 *   - 客户应用/路由模块以 `.js` 说明符引用同包模块，在 tasks.md 声明的「宿主
 *     Node 24 直跑（type stripping）」口径下原生装载会抛 ERR_MODULE_NOT_FOUND。
 *     测试器无权修改业务代码，故下方 `loadTsModule` 递归做「相对 `.js` 说明符
 *     改写 + 类型擦除」，不改动任何逻辑；默认未配置用例的应用仍保留一个
 *     明确的缺口特征用例，同时验证显式模块装配后的真实 loopback 链路。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const SOURCE = {
  domain: new URL('../src/customers/domain/customer.ts', import.meta.url),
  repository: new URL('../src/customers/persistence/memory-customer-repository.ts', import.meta.url),
  application: new URL('../src/customers/application/create-customer.ts', import.meta.url),
  phoneKey: new URL('../src/customers/domain/phone-key.ts', import.meta.url),
  searchApplication: new URL('../src/customers/application/search-customers.ts', import.meta.url),
  searchApi: new URL('../src/customers/api/search-customers.ts', import.meta.url),
  redaction: new URL('../src/customers/support/redaction.ts', import.meta.url),
  changelog: new URL('../src/customers/domain/changelog.ts', import.meta.url),
  getCustomer: new URL('../src/customers/application/get-customer.ts', import.meta.url),
  customerDetailApi: new URL('../src/customers/api/customer-detail.ts', import.meta.url),
  updateCustomer: new URL('../src/customers/application/update-customer.ts', import.meta.url),
  updateCustomerApi: new URL('../src/customers/api/update-customer.ts', import.meta.url),
  listChanges: new URL('../src/customers/application/list-changes.ts', import.meta.url),
  customerChangesApi: new URL('../src/customers/api/customer-changes.ts', import.meta.url),
  app: new URL('../src/customers/api/app.ts', import.meta.url),
  createApi: new URL('../src/customers/api/create-customer.ts', import.meta.url),
  module: new URL('../src/customers/api/module.ts', import.meta.url),
};

/** 递归改写相对说明符并擦除类型，避免多层 .js → .ts 依赖在 Node 24 下断链。 */
async function loadTsModule(url, cache = new Map()) {
  const key = url.href;
  const cached = cache.get(key);
  if (cached !== undefined) return import(cached);
  const source = await readFile(url, 'utf8');
  const specifierPattern = /(['"])(\.\.?\/[^'"]*?)\.js\1/g;
  const replacements = new Map();
  for (const match of source.matchAll(specifierPattern)) {
    const spec = match[2];
    if (!replacements.has(spec)) {
      const target = new URL(spec + '.ts', new URL('.', url));
      replacements.set(
        spec,
        target.pathname.endsWith('/src/customers/api/app.ts')
          ? target.href
          : await loadTsModuleSource(target, cache),
      );
    }
  }
  const rewritten = source.replace(
    specifierPattern,
    (_match, quote, spec) => quote + replacements.get(spec) + quote,
  );
  const javascript = stripTypeScriptTypes(rewritten, { mode: 'strip' });
  const dataHref =
    'data:text/javascript;base64,' + Buffer.from(javascript, 'utf8').toString('base64');
  cache.set(key, dataHref);
  return import(dataHref);
}

async function loadTsModuleSource(url, cache) {
  const key = url.href;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const source = await readFile(url, 'utf8');
  const specifierPattern = /(['"])(\.\.?\/[^'"]*?)\.js\1/g;
  const replacements = new Map();
  for (const match of source.matchAll(specifierPattern)) {
    const spec = match[2];
    if (!replacements.has(spec)) {
      const target = new URL(spec + '.ts', new URL('.', url));
      replacements.set(
        spec,
        target.pathname.endsWith('/src/customers/api/app.ts')
          ? target.href
          : await loadTsModuleSource(target, cache),
      );
    }
  }
  const rewritten = source.replace(
    specifierPattern,
    (_match, quote, spec) => quote + replacements.get(spec) + quote,
  );
  const javascript = stripTypeScriptTypes(rewritten, { mode: 'strip' });
  const dataHref =
    'data:text/javascript;base64,' + Buffer.from(javascript, 'utf8').toString('base64');
  cache.set(key, dataHref);
  return dataHref;
}

const domain = await import(SOURCE.domain.href);
const repositoryModule = await import(SOURCE.repository.href);
const phoneKeyModule = await import(SOURCE.phoneKey.href);
const application = await loadTsModule(SOURCE.application);
const searchApplication = await loadTsModule(SOURCE.searchApplication);
const searchApi = await loadTsModule(SOURCE.searchApi);
const redaction = await import(SOURCE.redaction.href);
const changelog = await loadTsModule(SOURCE.changelog);
const getCustomerModule = await loadTsModule(SOURCE.getCustomer);
const customerDetailApi = await loadTsModule(SOURCE.customerDetailApi);
const updateCustomerModule = await loadTsModule(SOURCE.updateCustomer);
const updateCustomerApi = await loadTsModule(SOURCE.updateCustomerApi);
const listChangesModule = await loadTsModule(SOURCE.listChanges);
const customerChangesApi = await loadTsModule(SOURCE.customerChangesApi);
const appModule = await import(SOURCE.app.href);
const createApiModule = await import(SOURCE.createApi.href);
const customerModule = await loadTsModule(SOURCE.module);

const { Customer, CUSTOMER_ID_PATTERN, PHONE_PATTERN, EMAIL_PATTERN } = domain;
const {
  MemoryCustomerRepository,
  CustomerSchemaError,
  DuplicateCustomerIdError,
  ImmutableCustomerColumnError,
  PhoneTakenError,
} = repositoryModule;
const { createCustomer, CreateCustomerValidationError } = application;
const { normalizePhoneKey } = phoneKeyModule;
const { searchCustomers } = searchApplication;
const { mountSearchCustomersRoute } = searchApi;
const { redactPhone, redactEmail } = redaction;
const { createChangeLogEntry, ChangeLogValidationError } = changelog;
const { getCustomer, CustomerNotFoundError } = getCustomerModule;
const { mountCustomerDetailRoute } = customerDetailApi;
const {
  updateCustomer,
  CustomerVersionConflictError,
  UpdateCustomerValidationError,
} = updateCustomerModule;
const { mountUpdateCustomerRoute } = updateCustomerApi;
const { listChanges } = listChangesModule;
const { mountCustomerChangesRoute } = customerChangesApi;
const { createCustomersApp, startLoopbackServer, HttpApiError, ERROR_CODES } = appModule;
const { handleCreateCustomer, createCustomerNodeHandler } = createApiModule;
const { createConfiguredCustomersApp } = customerModule;

const FIXED_NOW = new Date('2026-09-14T00:00:00.000Z');
const ISO_FIXED = FIXED_NOW.toISOString();
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const FIELD_ERROR_CODES = new Set(['REQUIRED', 'TOO_LONG', 'INVALID_FORMAT', 'DUPLICATED', 'IMMUTABLE']);

function fixedDeps(id = 'CST-TEST000001') {
  return { newCustomerId: () => id, clock: { now: () => FIXED_NOW } };
}

const ACTOR = { userId: 'user-001' };

function validDraft(overrides = {}) {
  return { name: '上海示例客户', phone: '138-0000-5678', ...overrides };
}

function codes(errors) {
  return errors.map((entry) => `${entry.field}:${entry.code}`);
}

function repoRow(overrides = {}) {
  return {
    customer_id: 'CST-REPO0000001',
    name: '仓储客户',
    contact_person: null,
    phone: '138-0000-5678',
    phone_key: '13800005678',
    email: null,
    company: null,
    note: null,
    version: 1,
    created_by: 'user-001',
    updated_by: 'user-001',
    created_at: ISO_FIXED,
    updated_at: ISO_FIXED,
    ...overrides,
  };
}

function parseResponse(status, headers, text) {
  const looksJson =
    String(headers['content-type'] ?? '').includes('application/json') && text.trim() !== '';
  return { status, headers, text, body: looksJson ? JSON.parse(text) : null };
}

async function send(endpoint, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        method,
        path,
        headers:
          body === undefined ? { ...headers } : { 'content-type': 'application/json', ...headers },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve(parseResponse(res.statusCode, res.headers, Buffer.concat(chunks).toString('utf8'))),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const postJson = (endpoint, path, body, headers) => send(endpoint, 'POST', path, body, headers);

function assertErrorEnvelope(payload, { expectFieldErrors }) {
  assert.equal(typeof payload.code, 'string');
  assert.equal(typeof payload.message, 'string');
  assert.equal(typeof payload.requestId, 'string');
  if (expectFieldErrors) {
    assert.ok(Array.isArray(payload.fieldErrors) && payload.fieldErrors.length >= 1);
    for (const entry of payload.fieldErrors) {
      assert.deepEqual(Object.keys(entry).sort(), ['code', 'field', 'message']);
      assert.equal(typeof entry.field, 'string');
      assert.equal(FIELD_ERROR_CODES.has(entry.code), true, `unknown code ${entry.code}`);
      assert.equal(typeof entry.message, 'string');
    }
  } else {
    assert.equal('fieldErrors' in payload, false, 'fieldErrors 为空时必须省略（minItems: 1）');
  }
}

// ---------------------------------------------------------------------------
// T-01 — Customer 聚合
// ---------------------------------------------------------------------------

test('T-01/AC-001: 仅提交 name+phone 即可创建，编号服务端生成、version=1、值被规范化', () => {
  const result = Customer.create(
    { name: '  上海示例客户  ', phone: '  138-0000-5678  ', contactPerson: '  李明  ' },
    ACTOR,
    fixedDeps(),
  );
  assert.equal(result.ok, true);
  const snapshot = result.customer.snapshot();
  assert.equal(snapshot.name, '上海示例客户');
  assert.equal(snapshot.contactPerson, '李明');
  assert.equal(snapshot.phone, '138-0000-5678');
  assert.equal(snapshot.email, null);
  assert.equal(snapshot.company, null);
  assert.equal(snapshot.note, null);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.customerId, 'CST-TEST000001');
  assert.equal(CUSTOMER_ID_PATTERN.test(snapshot.customerId), true);
  assert.equal(snapshot.createdBy, 'user-001');
  assert.equal(snapshot.updatedBy, 'user-001');
  assert.equal(snapshot.createdAt.toISOString(), ISO_FIXED);
  assert.equal(snapshot.updatedAt.toISOString(), ISO_FIXED);
});

test('T-01/AC-001: 可选字段 contactPerson/company/note 缺省不报错，email 为可选基本格式', () => {
  const omitted = Customer.create(validDraft(), ACTOR, fixedDeps());
  assert.equal(omitted.ok, true);
  assert.equal(omitted.customer.contactPerson, null);
  assert.equal(omitted.customer.company, null);
  assert.equal(omitted.customer.note, null);
  assert.equal(omitted.customer.email, null);

  const filled = Customer.create(
    validDraft({ contactPerson: '李明', email: 'li@example.com', company: '示例公司', note: '首次录入' }),
    ACTOR,
    fixedDeps(),
  );
  assert.equal(filled.ok, true);
  assert.equal(filled.customer.email, 'li@example.com');
  assert.equal(filled.customer.company, '示例公司');
  assert.equal(filled.customer.note, '首次录入');

  for (const phone of ['13800005678', '+86 138 0000 5678', '(021) 8888 7777', '123456']) {
    assert.equal(PHONE_PATTERN.test(phone), true, phone);
    assert.equal(Customer.create(validDraft({ phone }), ACTOR, fixedDeps()).ok, true, phone);
  }
  for (const email of ['a@b.co', 'zhang.san+tag@example.com.cn']) {
    assert.equal(EMAIL_PATTERN.test(email), true, email);
    assert.equal(Customer.create(validDraft({ email }), ACTOR, fixedDeps()).ok, true, email);
  }
  assert.equal(Customer.create(validDraft({ name: 'a'.repeat(100) }), ACTOR, fixedDeps()).ok, true);
});

test('T-01/AC-001: 客户端传入的 customerId/createdAt/createdBy/version 在创建时被忽略', () => {
  const result = Customer.create(
    {
      name: '上海示例客户',
      phone: '138-0000-5678',
      customerId: 'CST-CLIENT999999',
      createdAt: '2000-01-01T00:00:00.000Z',
      version: 99,
      createdBy: 'attacker',
    },
    ACTOR,
    fixedDeps(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.customer.customerId, 'CST-TEST000001');
  assert.equal(result.customer.version, 1);
  assert.equal(result.customer.createdBy, 'user-001');
  assert.equal(result.customer.createdAt.toISOString(), ISO_FIXED);
  assert.deepEqual(result.ignoredClientFields, ['customerId', 'createdAt', 'createdBy', 'version']);
});

test('T-01: 未注入编号生成器时仍按契约形状生成编号', () => {
  const result = Customer.create(validDraft(), ACTOR, {
    random: () => 0.5,
    clock: { now: () => FIXED_NOW },
  });
  assert.equal(result.ok, true);
  assert.equal(CUSTOMER_ID_PATTERN.test(result.customer.customerId), true);
  assert.match(result.customer.customerId, /^CST-/);
});

test('T-01/AC-002/T-06: 契约中每个非法输入分支逐项产出 REQUIRED / TOO_LONG / INVALID_FORMAT', () => {
  const cases = [
    [{ name: '', phone: '13800005678' }, ['name:REQUIRED']],
    [{ name: '    ', phone: '13800005678' }, ['name:REQUIRED']],
    [{ phone: '13800005678' }, ['name:REQUIRED']],
    [{ name: 'a'.repeat(101), phone: '13800005678' }, ['name:TOO_LONG']],
    [{ name: '客户' }, ['phone:REQUIRED']],
    [{ name: '客户', phone: '138abcd5678' }, ['phone:INVALID_FORMAT']],
    [{ name: '客户', phone: '12345' }, ['phone:INVALID_FORMAT']],
    [{ name: '客户', phone: '1'.repeat(21) }, ['phone:INVALID_FORMAT']],
    [{ name: '客户', phone: '138/0000' }, ['phone:INVALID_FORMAT']],
    [{ name: '客户', phone: '13800005678', email: 'no-at-sign' }, ['email:INVALID_FORMAT']],
    [{ name: '客户', phone: '13800005678', email: 'a@b' }, ['email:INVALID_FORMAT']],
    [{ name: '客户', phone: '13800005678', email: 'a b@example.com' }, ['email:INVALID_FORMAT']],
    [{ name: '客户', phone: '13800005678', email: `${'a'.repeat(90)}@example.com` }, ['email:TOO_LONG']],
    [{ name: '客户', phone: '13800005678', contactPerson: 'x'.repeat(51) }, ['contactPerson:TOO_LONG']],
    [{ name: '客户', phone: '13800005678', company: 'x'.repeat(101) }, ['company:TOO_LONG']],
    [{ name: '客户', phone: '13800005678', note: 'x'.repeat(1001) }, ['note:TOO_LONG']],
    [{ name: 42, phone: '13800005678' }, ['name:INVALID_FORMAT']],
  ];
  for (const [input, expected] of cases) {
    const result = Customer.create(input, ACTOR, fixedDeps());
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.deepEqual(codes(result.errors), expected, JSON.stringify(input));
    for (const entry of result.errors) {
      assert.equal(typeof entry.message, 'string');
      assert.ok(entry.message.length > 0, '每项错误均带可读提示');
    }
  }
});

test('T-01/AC-002/T-06: 多字段同时非法时逐项列出全部错误字段', () => {
  const result = Customer.create(
    { name: '   ', phone: 'bad/phone', email: 'not-an-email', note: 'x'.repeat(1001) },
    ACTOR,
    fixedDeps(),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.errors), [
    'name:REQUIRED',
    'phone:INVALID_FORMAT',
    'email:INVALID_FORMAT',
    'note:TOO_LONG',
  ]);
});

test('T-01/AC-001: 创建后身份字段不可变，局部修改以 IMMUTABLE 错误项拒绝', () => {
  const created = Customer.create(validDraft(), ACTOR, fixedDeps());
  assert.equal(created.ok, true);
  const aggregate = created.customer;

  const patchResult = aggregate.attemptUpdate({
    customerId: 'CST-OTHER000001',
    version: 2,
    createdAt: ISO_FIXED,
    createdBy: 'user-002',
    name: '',
  });
  assert.equal(patchResult.ok, false);
  assert.deepEqual(codes(patchResult.errors), [
    'customerId:IMMUTABLE',
    'createdAt:IMMUTABLE',
    'createdBy:IMMUTABLE',
    'version:IMMUTABLE',
    'name:REQUIRED',
  ]);
  assert.equal(aggregate.customerId, 'CST-TEST000001');
  assert.equal(aggregate.version, 1);
  assert.equal(aggregate.name, '上海示例客户');

  const next = aggregate.withAppliedUpdate(
    { name: '新名称' },
    { userId: 'user-002' },
    { now: () => new Date('2026-09-15T00:00:00.000Z') },
  );
  assert.equal(next.version, 2);
  assert.equal(next.name, '新名称');
  assert.equal(next.customerId, aggregate.customerId);
  assert.equal(next.createdAt.toISOString(), ISO_FIXED);
  assert.equal(next.createdBy, 'user-001');
});

// ---------------------------------------------------------------------------
// T-02 — 内存假仓储
// ---------------------------------------------------------------------------

test('T-02/AC-001: insert 落一行完整记录，findById 可回读，count 计数正确', async () => {
  const repository = new MemoryCustomerRepository();
  const inserted = await repository.insert(repoRow());
  assert.deepEqual(inserted, repoRow());
  assert.equal(await repository.count(), 1);
  assert.deepEqual(await repository.findById('CST-REPO0000001'), repoRow());
  assert.equal(await repository.findById('CST-MISSING000001'), null);

  inserted.name = '外部改写';
  assert.equal((await repository.findById('CST-REPO0000001')).name, '仓储客户');
});

test('T-02/AC-001: created_at/updated_at 由同一 INSERT 赋值且创建后不可变', async () => {
  const repository = new MemoryCustomerRepository();
  await repository.insert(repoRow());

  await assert.rejects(
    () =>
      repository.insert(repoRow({ customer_id: 'CST-REPO0000002', created_at: '2020-01-01T00:00:00.000Z' })),
    (error) => {
      assert.ok(error instanceof CustomerSchemaError);
      assert.equal(error.column, 'updated_at');
      return true;
    },
  );
  await assert.rejects(
    () => repository.insert(repoRow({ customer_id: 'CST-REPO0000003', created_at: '2026-09-14 00:00:00' })),
    CustomerSchemaError,
  );
  assert.equal(await repository.count(), 1);

  const updated = await repository.updateVersioned({
    customerId: 'CST-REPO0000001',
    expectedVersion: 1,
    patch: { name: '仅改名' },
    updatedBy: 'user-002',
    updatedAt: '2026-09-15T00:00:00.000Z',
  });
  assert.equal(updated.applied, true);
  const withoutUpdateStamp = (row) => {
    const rest = { ...row };
    delete rest.name;
    delete rest.version;
    delete rest.updated_by;
    delete rest.updated_at;
    return rest;
  };
  assert.deepEqual(withoutUpdateStamp(updated.record), withoutUpdateStamp(repoRow()));
  assert.equal(updated.record.name, '仅改名');
  assert.equal(updated.record.version, 2);
  assert.equal(updated.record.updated_by, 'user-002');
  assert.equal(updated.record.created_at, ISO_FIXED);
  assert.equal(updated.record.created_by, 'user-001');
  assert.equal(await repository.count(), 1);
});

test('T-02: 表级守卫 — PK 唯一、version 默认 1、未知列/缺列、phone_key 生成列语义', async () => {
  const repository = new MemoryCustomerRepository();
  await repository.insert(repoRow());

  await assert.rejects(() => repository.insert(repoRow()), DuplicateCustomerIdError);
  await assert.rejects(
    () => repository.insert(repoRow({ customer_id: 'CST-REPO0000004', version: 2 })),
    CustomerSchemaError,
  );
  await assert.rejects(
    () => repository.insert(repoRow({ customer_id: 'CST-REPO0000005', unknown_col: 'x' })),
    CustomerSchemaError,
  );
  await assert.rejects(
    () => repository.insert({ ...repoRow({ customer_id: 'CST-REPO0000006' }), phone_key: undefined }),
    CustomerSchemaError,
  );
  await assert.rejects(
    () => repository.insert(repoRow({ customer_id: 'cst-lower000001' })),
    CustomerSchemaError,
  );
  assert.equal(await repository.count(), 1, '任何 INSERT 失败都不得产生半记录');

  const derived = new MemoryCustomerRepository({
    phoneKeyFor: (phone) => phone.replace(/[\s().-]/g, ''),
  });
  const stored = await derived.insert({
    customer_id: 'CST-REPO0000007',
    name: '生成列客户',
    phone: '138-0000-5678',
    created_by: 'user-001',
    updated_by: 'user-001',
    created_at: ISO_FIXED,
    updated_at: ISO_FIXED,
  });
  assert.equal(stored.phone_key, '13800005678');
  await assert.rejects(
    () => derived.insert({ ...repoRow({ customer_id: 'CST-REPO0000008' }), phone_key: '9999999999' }),
    (error) => {
      assert.ok(error instanceof CustomerSchemaError);
      assert.equal(error.column, 'phone_key');
      return true;
    },
  );
  assert.equal(await derived.count(), 1);
});

test('T-02: updateVersioned 与 data-model 版本条件更新一致（0 行区分不存在/版本冲突）', async () => {
  const repository = new MemoryCustomerRepository();
  await repository.insert(repoRow());

  const missing = await repository.updateVersioned({
    customerId: 'CST-ABSENT000001',
    expectedVersion: 1,
    patch: { name: 'x' },
    updatedBy: 'user-002',
    updatedAt: '2026-09-15T00:00:00.000Z',
  });
  assert.deepEqual(missing, { applied: false, rowCount: 0, rowExists: false });

  const first = await repository.updateVersioned({
    customerId: 'CST-REPO0000001',
    expectedVersion: 1,
    patch: { name: '新名称', email: 'new@example.com' },
    updatedBy: 'user-002',
    updatedAt: '2026-09-15T00:00:00.000Z',
  });
  assert.equal(first.applied, true);
  assert.equal(first.rowCount, 1);
  assert.equal(first.record.version, 2);
  assert.equal(first.record.name, '新名称');
  assert.equal(first.record.email, 'new@example.com');
  assert.equal(first.record.contact_person, null);

  const stale = await repository.updateVersioned({
    customerId: 'CST-REPO0000001',
    expectedVersion: 1,
    patch: { name: '过期写入' },
    updatedBy: 'user-003',
    updatedAt: '2026-09-16T00:00:00.000Z',
  });
  assert.deepEqual(stale, { applied: false, rowCount: 0, rowExists: true });
  const afterStale = await repository.findById('CST-REPO0000001');
  assert.equal(afterStale.name, '新名称');
  assert.equal(afterStale.version, 2);

  await assert.rejects(
    () =>
      repository.updateVersioned({
        customerId: 'CST-REPO0000001',
        expectedVersion: 2,
        patch: { created_at: ISO_FIXED },
        updatedBy: 'user-002',
        updatedAt: '2026-09-16T00:00:00.000Z',
      }),
    (error) => {
      assert.ok(error instanceof ImmutableCustomerColumnError);
      assert.deepEqual(error.columns, ['created_at']);
      return true;
    },
  );
  await assert.rejects(
    () =>
      repository.updateVersioned({
        customerId: 'CST-REPO0000001',
        expectedVersion: 2,
        patch: {},
        updatedBy: 'user-002',
        updatedAt: '2026-09-16T00:00:00.000Z',
      }),
    CustomerSchemaError,
  );
  await assert.rejects(
    () =>
      repository.updateVersioned({
        customerId: 'CST-REPO0000001',
        expectedVersion: 2,
        patch: { salary: 'x' },
        updatedBy: 'user-002',
        updatedAt: '2026-09-16T00:00:00.000Z',
      }),
    CustomerSchemaError,
  );
  assert.equal(await repository.count(), 1);
});

// ---------------------------------------------------------------------------
// T-03 — createCustomer 用例
// ---------------------------------------------------------------------------

test('T-03/AC-001: 领域校验→聚合构建→仓储落库，成功后同一假仓储可回读', async () => {
  const repository = new MemoryCustomerRepository();
  const customer = await createCustomer(
    validDraft({ name: '  落库客户  ', contactPerson: '李明', email: 'li@example.com' }),
    { repository, actor: ACTOR, domain: fixedDeps() },
  );
  assert.equal(customer.customerId, 'CST-TEST000001');
  assert.equal(await repository.count(), 1);
  assert.deepEqual(await repository.findById('CST-TEST000001'), {
    customer_id: 'CST-TEST000001',
    name: '落库客户',
    contact_person: '李明',
    phone: '138-0000-5678',
    phone_key: '13800005678',
    email: 'li@example.com',
    company: null,
    note: null,
    version: 1,
    created_by: 'user-001',
    updated_by: 'user-001',
    created_at: ISO_FIXED,
    updated_at: ISO_FIXED,
  });
});

test('T-03/AC-002: 校验失败不产生任何记录，字段错误项可定位到具体字段', async () => {
  const repository = new MemoryCustomerRepository();
  await assert.rejects(
    () =>
      createCustomer(
        { name: '   ', phone: 'bad/phone', email: 'nope' },
        { repository, actor: ACTOR, domain: fixedDeps(), requestId: 'req-usecase-1' },
      ),
    (error) => {
      assert.ok(error instanceof CreateCustomerValidationError);
      assert.deepEqual(codes(error.fieldErrors), [
        'name:REQUIRED',
        'phone:INVALID_FORMAT',
        'email:INVALID_FORMAT',
      ]);
      assert.equal(error.requestId, 'req-usecase-1');
      return true;
    },
  );
  assert.equal(await repository.count(), 0);
  assert.equal(await repository.findById('CST-TEST000001'), null);
});

test('T-03/AC-001: 仓储拒绝的写入不产生半记录，异常原样上抛', async () => {
  const repository = new MemoryCustomerRepository();
  await repository.insert(repoRow());
  await assert.rejects(
    () => createCustomer(validDraft(), { repository, actor: ACTOR, domain: fixedDeps('CST-REPO0000001') }),
    DuplicateCustomerIdError,
  );
  assert.equal(await repository.count(), 1);
});

// ---------------------------------------------------------------------------
// T-07/T-08/T-09/T-10 — 电话归一化、唯一冲突及 HTTP 映射
// ---------------------------------------------------------------------------

test('T-07: 电话归一化与数据模型 STORED 表达式一致', () => {
  assert.equal(normalizePhoneKey('138-0000-5678'), '13800005678');
  assert.equal(normalizePhoneKey('138 0000 (5678)'), '13800005678');
  assert.equal(normalizePhoneKey('+86.138-0000-5678'), '+8613800005678');
  assert.equal(normalizePhoneKey('\t138\n0000\t5678'), '13800005678');
});

test('T-08: 归一化电话冲突抛出 PhoneTaken，且不写入新记录', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert({
    ...repoRow({ customer_id: 'CST-T08TEST000001', name: '已有客户' }),
    phone: '138-0000-5678',
  });

  await assert.rejects(
    () =>
      repository.insert({
        ...repoRow({ customer_id: 'CST-T08TEST000002', name: '重复客户' }),
        phone: '13800005678',
      }),
    (error) => {
      assert.ok(error instanceof PhoneTakenError);
      assert.equal(error.code, 'CUSTOMER_PHONE_TAKEN');
      assert.deepEqual(error.existingCustomer, {
        customerId: 'CST-T08TEST000001',
        name: '已有客户',
      });
      return true;
    },
  );
  assert.equal(await repository.count(), 1);
});

test('T-09: 创建用例原样上抛 PhoneTaken，并保持仓储无半记录', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  let nextId = 0;
  const dependencies = {
    repository,
    actor: ACTOR,
    phoneKeyFor: normalizePhoneKey,
    domain: {
      newCustomerId: () => `CST-T09TEST${String(++nextId).padStart(6, '0')}`,
      clock: { now: () => FIXED_NOW },
    },
  };
  await createCustomer(validDraft({ name: '已有客户' }), dependencies);

  await assert.rejects(
    () => createCustomer(validDraft({ name: '重复客户', phone: '13800005678' }), dependencies),
    (error) => {
      assert.ok(error instanceof PhoneTakenError);
      assert.equal(error.code, 'CUSTOMER_PHONE_TAKEN');
      assert.deepEqual(error.existingCustomer, {
        customerId: 'CST-T09TEST000001',
        name: '已有客户',
      });
      return true;
    },
  );
  assert.equal(await repository.count(), 1);
});

test('T-10: 创建路由将电话冲突映射为 409，并返回已有客户摘要', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  let nextId = 0;
  const useCase = (input) =>
    createCustomer(input, {
      repository,
      actor: ACTOR,
      phoneKeyFor: normalizePhoneKey,
      domain: {
        newCustomerId: () => `CST-T10TEST${String(++nextId).padStart(6, '0')}`,
        clock: { now: () => FIXED_NOW },
      },
    });

  const first = await handleCreateCustomer(validDraft({ name: '已有客户' }), {
    requestId: 'req-t10-first',
    principal: ACTOR,
    useCase,
  });
  assert.equal(first.status, 201);

  const conflict = await handleCreateCustomer(
    validDraft({ name: '重复客户', phone: '13800005678' }),
    { requestId: 'req-t10-conflict', principal: ACTOR, useCase },
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'CUSTOMER_PHONE_TAKEN');
  assert.equal(conflict.body.requestId, 'req-t10-conflict');
  assert.deepEqual(conflict.body.details, {
    existingCustomer: { customerId: 'CST-T10TEST000001', name: '已有客户' },
  });
  assert.match(conflict.body.message, /已有客户/);
  assert.equal(await repository.count(), 1);
});

// ---------------------------------------------------------------------------
// T-15/T-16/T-17/T-19 — 关键词查询与分页
// ---------------------------------------------------------------------------

test('T-15: 仓储按名称/联系人/电话匹配并以稳定键分页', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(
    repoRow({
      customer_id: 'CST-SRCH000001',
      name: '上海星河',
      contact_person: '李明',
      phone: '138-0000-5678',
    }),
  );
  await repository.insert(
    repoRow({
      customer_id: 'CST-SRCH000002',
      name: '北京云杉',
      contact_person: '王芳',
      phone: '139-1111-2222',
      phone_key: '13911112222',
    }),
  );
  await repository.insert(
    repoRow({
      customer_id: 'CST-SRCH000003',
      name: '深圳远山',
      contact_person: '赵六',
      phone: '137-3333-4444',
      phone_key: '13733334444',
    }),
  );
  await repository.updateVersioned({
    customerId: 'CST-SRCH000001',
    expectedVersion: 1,
    patch: { name: '上海星河' },
    updatedBy: 'user-001',
    updatedAt: '2026-09-14T00:00:01.000Z',
  });
  await repository.updateVersioned({
    customerId: 'CST-SRCH000002',
    expectedVersion: 1,
    patch: { name: '北京云杉' },
    updatedBy: 'user-001',
    updatedAt: '2026-09-14T00:00:03.000Z',
  });
  await repository.updateVersioned({
    customerId: 'CST-SRCH000003',
    expectedVersion: 1,
    patch: { name: '深圳远山' },
    updatedBy: 'user-001',
    updatedAt: '2026-09-14T00:00:02.000Z',
  });

  const byName = await repository.search('星河', 1, 20);
  assert.deepEqual(byName.items.map((item) => item.customer_id), ['CST-SRCH000001']);
  assert.equal(byName.total, 1);
  const byContact = await repository.search('王芳', 1, 20);
  assert.deepEqual(byContact.items.map((item) => item.customer_id), ['CST-SRCH000002']);
  const byPhone = await repository.search('139-1111', 1, 20);
  assert.deepEqual(byPhone.items.map((item) => item.customer_id), ['CST-SRCH000002']);
  const page1 = await repository.search('', 1, 2);
  const page2 = await repository.search('', 2, 2);
  assert.deepEqual(page1.items.map((item) => item.customer_id), ['CST-SRCH000002', 'CST-SRCH000003']);
  assert.deepEqual(page2.items.map((item) => item.customer_id), ['CST-SRCH000001']);
  assert.equal(page1.total, 3);
  assert.equal((await repository.search('不存在', 1, 20)).items.length, 0);
});

test('T-16: 查询用例 trim 关键词、返回 CustomerPage，并拒绝越界分页', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(repoRow({ customer_id: 'CST-SRCH000010', name: '上海星河' }));
  const page = await searchCustomers(
    { keyword: '  星河  ', page: 1, pageSize: 20 },
    { repository },
  );
  assert.deepEqual(page, {
    items: [{
      customerId: 'CST-SRCH000010',
      name: '上海星河',
      contactPerson: null,
      phone: '138-0000-5678',
      company: null,
      updatedAt: ISO_FIXED,
    }],
    page: 1,
    pageSize: 20,
    total: 1,
  });
  await assert.rejects(
    () => searchCustomers({ page: 0, pageSize: 20 }, { repository }),
    (error) => {
      assert.equal(error.name, 'SearchCustomerValidationError');
      assert.deepEqual(error.fieldErrors.map((entry) => entry.field), ['page']);
      return true;
    },
  );
  await assert.rejects(
    () => searchCustomers({ page: 1, pageSize: 101 }, { repository }),
    (error) => {
      assert.deepEqual(error.fieldErrors.map((entry) => entry.field), ['pageSize']);
      return true;
    },
  );
});

test('T-17/T-19: GET 查询路由返回 CustomerPage，参数错误返回 400', async (t) => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(repoRow({ customer_id: 'CST-SRCH000020', name: '上海星河' }));
  const app = createCustomersApp();
  mountSearchCustomersRoute(app, {
    useCase: (input) => searchCustomers(input, { repository }),
  });
  const server = await startLoopbackServer(app);
  t.after(() => server.close());

  const found = await send(server, 'GET', '/api/v1/customers?keyword=%E6%98%9F%E6%B2%B3&page=1&pageSize=20');
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.items.map((item) => item.customerId), ['CST-SRCH000020']);
  assert.equal(found.body.total, 1);
  assert.equal(found.body.page, 1);

  const invalid = await send(server, 'GET', '/api/v1/customers?pageSize=101');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'BAD_REQUEST');
  assertErrorEnvelope(invalid.body, { expectFieldErrors: true });
  assert.deepEqual(codes(invalid.body.fieldErrors), ['pageSize:INVALID_FORMAT']);
});

// ---------------------------------------------------------------------------
// T-20/T-21 — 变更留痕脱敏值对象
// ---------------------------------------------------------------------------

test('T-20: 电话和邮箱按约定脱敏，普通字段与业务响应值保持原文', () => {
  assert.equal(redactPhone('138-0000-5678'), '138****5678');
  assert.equal(redactPhone('+86 13800005678'), '861****5678');
  assert.equal(redactPhone(null), null);
  assert.equal(redactEmail('alice@example.com'), 'a***@example.com');
  assert.equal(redactEmail('a@example.com'), 'a***@example.com');
  assert.equal(redactEmail(null), null);
});

test('T-21: ChangeLog 值对象限制字段白名单并在构造时保存脱敏前后值', () => {
  const entry = createChangeLogEntry({
    field: 'phone',
    oldValue: '138-0000-5678',
    newValue: '139-1111-2222',
    changedBy: 'user-002',
    changedAt: FIXED_NOW,
    requestId: 'req-change-1',
  });
  assert.deepEqual(entry, {
    field: 'phone',
    oldValue: '138****5678',
    newValue: '139****2222',
    changedBy: 'user-002',
    changedAt: ISO_FIXED,
    requestId: 'req-change-1',
  });
  assert.throws(
    () =>
      createChangeLogEntry({
        field: 'phone_key',
        oldValue: '1',
        newValue: '2',
        changedBy: 'user-002',
        changedAt: ISO_FIXED,
      }),
    ChangeLogValidationError,
  );
});

// ---------------------------------------------------------------------------
// T-22/T-23 — 详情读取与 ETag
// ---------------------------------------------------------------------------

test('T-22: 按编号读取完整档案并附带最近变更，不存在时返回 CustomerNotFound', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(repoRow({ customer_id: 'CST-DETAIL000001', name: '详情客户' }));
  const change = createChangeLogEntry({
    field: 'email',
    oldValue: 'a@example.com',
    newValue: 'b@example.com',
    changedBy: 'user-002',
    changedAt: FIXED_NOW,
    requestId: 'req-detail-1',
  });
  const detail = await getCustomer('CST-DETAIL000001', {
    repository,
    recentChanges: () => [change],
  });
  assert.equal(detail.customerId, 'CST-DETAIL000001');
  assert.equal(detail.name, '详情客户');
  assert.equal(detail.version, 1);
  assert.deepEqual(detail.recentChanges, [change]);
  await assert.rejects(
    () => getCustomer('CST-DETAIL-MISSING', { repository }),
    (error) => {
      assert.ok(error instanceof CustomerNotFoundError);
      assert.equal(error.code, 'CUSTOMER_NOT_FOUND');
      return true;
    },
  );
});

test('T-23: 详情路由返回 200 + ETag，编号不存在返回 404', async (t) => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(repoRow({ customer_id: 'CST-DETAIL000010', name: '详情客户' }));
  const app = createCustomersApp();
  mountCustomerDetailRoute(app, {
    useCase: (customerId) => getCustomer(customerId, { repository }),
  });
  const server = await startLoopbackServer(app);
  t.after(() => server.close());

  const ok = await send(server, 'GET', '/api/v1/customers/CST-DETAIL000010');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.etag, '"1"');
  assert.equal(ok.body.customerId, 'CST-DETAIL000010');
  const missing = await send(server, 'GET', '/api/v1/customers/CST-DETAIL-MISSING');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'CUSTOMER_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// T-24/T-25 — 局部更新、乐观并发与冲突映射
// ---------------------------------------------------------------------------

test('T-24: 局部更新只改提交字段、版本自增并写入脱敏留痕', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(repoRow({ customer_id: 'CST-UPDTE000001', name: '原客户', email: 'old@example.com' }));
  const result = await updateCustomer(
    {
      customerId: 'CST-UPDTE000001',
      expectedVersion: 1,
      patch: { name: '新客户', phone: '139-1111-2222', email: 'new@example.com' },
    },
    {
      repository,
      actor: { userId: 'user-002' },
      clock: { now: () => new Date('2026-09-14T00:00:10.000Z') },
      phoneKeyFor: normalizePhoneKey,
      requestId: 'req-update-1',
    },
  );
  assert.equal(result.customer.version, 2);
  assert.equal(result.customer.name, '新客户');
  assert.equal(result.customer.phone, '139-1111-2222');
  assert.equal(result.customer.email, 'new@example.com');
  assert.deepEqual(result.changes.map((entry) => [entry.field, entry.oldValue, entry.newValue]), [
    ['name', '原客户', '新客户'],
    ['phone', '138****5678', '139****2222'],
    ['email', 'o***@example.com', 'n***@example.com'],
  ]);
  const stored = await repository.findById('CST-UPDTE000001');
  assert.equal(stored.version, 2);
  assert.equal(stored.contact_person, null);
  assert.deepEqual(await repository.listChanges('CST-UPDTE000001'), result.changes);
});

test('T-24: 过期版本与身份字段修改被拒绝，原记录保持不变', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(repoRow({ customer_id: 'CST-UPDTE000010', name: '并发客户' }));
  await assert.rejects(
    () => updateCustomer(
      { customerId: 'CST-UPDTE000010', expectedVersion: 0, patch: { name: '不会保存' } },
      { repository, actor: ACTOR, clock: { now: () => FIXED_NOW }, phoneKeyFor: normalizePhoneKey },
    ),
    UpdateCustomerValidationError,
  );
  await assert.rejects(
    () => updateCustomer(
      { customerId: 'CST-UPDTE000010', expectedVersion: 1, patch: { customerId: 'CST-OTHER000001' } },
      { repository, actor: ACTOR, clock: { now: () => FIXED_NOW }, phoneKeyFor: normalizePhoneKey },
    ),
    UpdateCustomerValidationError,
  );
  const first = await updateCustomer(
    { customerId: 'CST-UPDTE000010', expectedVersion: 1, patch: { name: '先保存' } },
    { repository, actor: ACTOR, clock: { now: () => FIXED_NOW }, phoneKeyFor: normalizePhoneKey },
  );
  assert.equal(first.customer.version, 2);
  await assert.rejects(
    () => updateCustomer(
      { customerId: 'CST-UPDTE000010', expectedVersion: 1, patch: { name: '过期覆盖' } },
      { repository, actor: { userId: 'user-002' }, clock: { now: () => FIXED_NOW }, phoneKeyFor: normalizePhoneKey },
    ),
    (error) => {
      assert.ok(error instanceof CustomerVersionConflictError);
      assert.equal(error.code, 'CUSTOMER_VERSION_CONFLICT');
      return true;
    },
  );
  assert.equal((await repository.findById('CST-UPDTE000010')).name, '先保存');
  assert.equal((await repository.listChanges('CST-UPDTE000010')).length, 1);
});

test('T-25: PATCH 路由强制 If-Match，成功返回新 ETag，冲突返回 409', async (t) => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(repoRow({ customer_id: 'CST-UPDTE000020', name: '接口客户' }));
  const app = createCustomersApp();
  mountUpdateCustomerRoute(app, {
    useCase: (input) => updateCustomer(input, {
      repository,
      actor: { userId: 'user-002' },
      clock: { now: () => new Date('2026-09-14T00:00:20.000Z') },
      phoneKeyFor: normalizePhoneKey,
      requestId: 'req-update-route',
    }),
  });
  const server = await startLoopbackServer(app);
  t.after(() => server.close());

  const missingIfMatch = await send(
    server,
    'PATCH',
    '/api/v1/customers/CST-UPDTE000020',
    { name: '不会保存' },
  );
  assert.equal(missingIfMatch.status, 412);
  assert.equal(missingIfMatch.body.code, 'PRECONDITION_FAILED');

  const updated = await send(
    server,
    'PATCH',
    '/api/v1/customers/CST-UPDTE000020',
    { name: '已更新' },
    { 'if-match': '"1"', 'x-request-id': 'req-update-http' },
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.headers.etag, '"2"');
  assert.equal(updated.body.name, '已更新');

  const stale = await send(
    server,
    'PATCH',
    '/api/v1/customers/CST-UPDTE000020',
    { name: '旧版本' },
    { 'if-match': '1' },
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CUSTOMER_VERSION_CONFLICT');
});

// ---------------------------------------------------------------------------
// T-29/T-30 — 变更历史分页读取
// ---------------------------------------------------------------------------

test('T-29: 变更历史按客户分页读取并返回 total，不存在客户返回 404 语义', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(repoRow({ customer_id: 'CST-CHGLOG000001', name: '历史客户' }));
  await updateCustomer(
    { customerId: 'CST-CHGLOG000001', expectedVersion: 1, patch: { name: '历史客户二' } },
    { repository, actor: { userId: 'user-002' }, clock: { now: () => new Date('2026-09-14T00:00:01.000Z') }, phoneKeyFor: normalizePhoneKey },
  );
  await updateCustomer(
    { customerId: 'CST-CHGLOG000001', expectedVersion: 2, patch: { email: 'new@example.com', phone: '139-1111-2222' } },
    { repository, actor: { userId: 'user-002' }, clock: { now: () => new Date('2026-09-14T00:00:02.000Z') }, phoneKeyFor: normalizePhoneKey },
  );
  const page = await listChanges('CST-CHGLOG000001', 1, 2, { repository });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items.map((entry) => entry.field), ['phone', 'email']);
  const secondPage = await listChanges('CST-CHGLOG000001', 2, 2, { repository });
  assert.deepEqual(secondPage.items.map((entry) => entry.field), ['name']);
  await assert.rejects(
    () => listChanges('CST-CHGLOG-MISSING', 1, 20, { repository }),
    (error) => error.name === 'CustomerNotFound',
  );
});

test('T-30: 变更历史路由返回脱敏记录、分页信息和 404', async (t) => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  await repository.insert(repoRow({ customer_id: 'CST-CHGLOG000010', name: '路由历史客户' }));
  await updateCustomer(
    { customerId: 'CST-CHGLOG000010', expectedVersion: 1, patch: { phone: '139-1111-2222' } },
    { repository, actor: { userId: 'user-002' }, clock: { now: () => new Date('2026-09-14T00:00:03.000Z') }, phoneKeyFor: normalizePhoneKey, requestId: 'req-history' },
  );
  const app = createCustomersApp();
  mountCustomerChangesRoute(app, {
    useCase: (customerId, page, pageSize) => listChanges(customerId, page, pageSize, { repository }),
  });
  const server = await startLoopbackServer(app);
  t.after(() => server.close());
  const ok = await send(server, 'GET', '/api/v1/customers/CST-CHGLOG000010/changes');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.total, 1);
  assert.equal(ok.body.items[0].oldValue, '138****5678');
  assert.equal(ok.body.items[0].newValue, '139****2222');
  const missing = await send(server, 'GET', '/api/v1/customers/CST-CHGLOG-MISSING/changes');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'CUSTOMER_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// T-04 — loopback HTTP 应用与统一错误结构
// ---------------------------------------------------------------------------

test('T-04/AC-002: loopback 应用统一错误结构（code/message/requestId）与 422 fieldErrors', async (t) => {
  const app = createCustomersApp();
  app.addRoute('GET', '/api/v1/customers/{customerId}', (ctx) => {
    const error = new Error('客户不存在');
    error.name = 'CustomerNotFound';
    error.customerId = ctx.params.customerId;
    throw error;
  });
  app.addRoute('POST', '/api/v1/customers', async (ctx) => {
    await ctx.readJson();
    const error = new Error('输入未通过字段校验');
    error.name = 'ValidationFailure';
    error.fieldErrors = [{ field: 'name', code: 'REQUIRED', message: '客户名称不能为空' }];
    throw error;
  });
  app.registerErrorMapper((error) =>
    error instanceof Error && error.name === 'ValidationFailure'
      ? new HttpApiError(422, ERROR_CODES.VALIDATION_ERROR, '输入未通过字段校验', {
          fieldErrors: error.fieldErrors,
        })
      : null,
  );
  const server = await startLoopbackServer(app);
  t.after(() => server.close());

  const notFound = await send(server, 'GET', '/api/v1/customers/CST-ABSENT000001');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers['x-request-id'], notFound.body.requestId);
  assert.equal(notFound.body.code, ERROR_CODES.CUSTOMER_NOT_FOUND);
  assertErrorEnvelope(notFound.body, { expectFieldErrors: false });

  const unknown = await send(server, 'GET', '/api/v1/other');
  assert.equal(unknown.status, 404);
  assertErrorEnvelope(unknown.body, { expectFieldErrors: false });

  const invalid = await postJson(server, '/api/v1/customers', { name: '' }, { 'x-request-id': 'req-t04' });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.headers['x-request-id'], 'req-t04');
  // 应用层（T-04）统一错误映射使用 VALIDATION_ERROR；端点层（T-05）自带
  // VALIDATION_FAILED —— 两个机器码并存，已在测试器 risks 中记录为契约一致性问题。
  assert.equal(invalid.body.code, ERROR_CODES.VALIDATION_ERROR);
  assertErrorEnvelope(invalid.body, { expectFieldErrors: true });
  assert.deepEqual(codes(invalid.body.fieldErrors), ['name:REQUIRED']);

  const malformed = await postJson(server, '/api/v1/customers', '{not json');
  assert.equal(malformed.status, 400);
  assertErrorEnvelope(malformed.body, { expectFieldErrors: false });
});

test('T-04/D-05: 既有 HTTP 入口以前缀分流方式委托模块应用（tryHandleRequest）', async (t) => {
  const app = createCustomersApp();
  app.addRoute('POST', '/api/v1/customers', () => ({ status: 201, body: { mounted: true } }));
  const outer = http.createServer((req, res) => {
    void app.tryHandleRequest(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('outer-entry');
    });
  });
  await new Promise((resolve) => outer.listen({ port: 0, host: '127.0.0.1' }, resolve));
  const endpoint = { port: outer.address().port };
  t.after(() => new Promise((resolve) => outer.close(resolve)));

  const outside = await send(endpoint, 'GET', '/api/v1/other');
  assert.equal(outside.status, 200);
  assert.equal(outside.text, 'outer-entry');
  assert.equal(outside.body, null);

  const inside = await postJson(endpoint, '/api/v1/customers', {});
  assert.equal(inside.status, 201);
  assert.equal(inside.body.mounted, true);
});

// ---------------------------------------------------------------------------
// T-05 — POST /api/v1/customers
// ---------------------------------------------------------------------------

test('T-05/AC-001: 201 + Location + CustomerDetail，且真实假仓储已落库', async (t) => {
  const repository = new MemoryCustomerRepository();
  const app = createCustomersApp();
  app.addRoute('POST', '/api/v1/customers', async (ctx) => {
    const body = await ctx.readJson();
    return handleCreateCustomer(body, {
      requestId: ctx.requestId,
      principal: { userId: 'user-001', displayName: '测试用户' },
      useCase: (input) => createCustomer(input, { repository, actor: ACTOR, domain: fixedDeps() }),
    });
  });
  const server = await startLoopbackServer(app);
  t.after(() => server.close());

  const created = await postJson(
    server,
    '/api/v1/customers',
    validDraft({ name: 'HTTP 客户', contactPerson: '李明', email: 'li@example.com' }),
    { 'x-request-id': 'req-http-201' },
  );
  assert.equal(created.status, 201);
  assert.equal(created.headers['x-request-id'], 'req-http-201');
  assert.equal(created.headers.location, '/api/v1/customers/CST-TEST000001');
  assert.match(created.headers.location, /^\/api\/v1\/customers\/[A-Z]{2,4}-[0-9A-Za-z-]{6,32}$/);
  assert.deepEqual(Object.keys(created.body).sort(), [
    'company', 'contactPerson', 'createdAt', 'createdBy', 'customerId', 'email',
    'name', 'note', 'phone', 'recentChanges', 'updatedAt', 'updatedBy', 'version',
  ]);
  assert.equal(created.body.customerId, 'CST-TEST000001');
  assert.equal(created.body.name, 'HTTP 客户');
  assert.equal(created.body.contactPerson, '李明');
  assert.equal(created.body.email, 'li@example.com');
  assert.equal(created.body.phone, '138-0000-5678');
  assert.equal(created.body.version, 1);
  assert.equal(UTC_ISO.test(created.body.createdAt), true);
  assert.equal(UTC_ISO.test(created.body.updatedAt), true);
  // 用例返回领域聚合（createdBy 为 userId 字符串），因此 PersonRef.displayName
  // 回退为 userId；契约 PersonRef 仍满足 required=[userId, displayName]。
  assert.deepEqual(created.body.createdBy, { userId: 'user-001', displayName: 'user-001' });
  assert.deepEqual(created.body.updatedBy, { userId: 'user-001', displayName: 'user-001' });
  assert.deepEqual(created.body.recentChanges, []);
  assert.equal(await repository.count(), 1);
  assert.equal((await repository.findById('CST-TEST000001')).contact_person, '李明');
});

test('T-05/AC-002: 字段不合法返回 422 并逐项列出 fieldErrors，清单外字段显式拒绝且不写入', async (t) => {
  const repository = new MemoryCustomerRepository();
  const useCase = (input) => createCustomer(input, { repository, actor: ACTOR, domain: fixedDeps() });
  const app = createCustomersApp();
  app.addRoute('POST', '/api/v1/customers', async (ctx) => {
    const body = await ctx.readJson();
    return handleCreateCustomer(body, { requestId: ctx.requestId, principal: { userId: 'user-001' }, useCase });
  });
  const server = await startLoopbackServer(app);
  t.after(() => server.close());

  const multiInvalid = await postJson(
    server,
    '/api/v1/customers',
    { name: '   ', phone: 'bad/phone', email: 'not-an-email', note: 'x'.repeat(1001) },
    { 'x-request-id': 'req-http-422' },
  );
  assert.equal(multiInvalid.status, 422);
  assert.equal(multiInvalid.headers['x-request-id'], 'req-http-422');
  assertErrorEnvelope(multiInvalid.body, { expectFieldErrors: true });
  assert.deepEqual(codes(multiInvalid.body.fieldErrors), [
    'name:REQUIRED',
    'phone:INVALID_FORMAT',
    'email:INVALID_FORMAT',
    'note:TOO_LONG',
  ]);
  assert.equal(await repository.count(), 0);

  const unknownField = await postJson(
    server,
    '/api/v1/customers',
    validDraft({ extra: true, customerId: 'CST-CLIENT999999' }),
  );
  assert.equal(unknownField.status, 422);
  assertErrorEnvelope(unknownField.body, { expectFieldErrors: true });
  assert.deepEqual(codes(unknownField.body.fieldErrors), ['extra:INVALID_FORMAT', 'customerId:IMMUTABLE']);
  assert.equal(await repository.count(), 0, '清单外字段不得静默写入');

  const legal = await postJson(server, '/api/v1/customers', validDraft());
  assert.equal(legal.status, 201);
  assert.equal(await repository.count(), 1);
});

test('T-05/T-03: 应用层字段错误项映射为 422，不降级为 500', async () => {
  const outcome = await handleCreateCustomer(validDraft(), {
    requestId: 'req-mapping-1',
    principal: { userId: 'user-001' },
    useCase: async () => {
      throw new CreateCustomerValidationError(
        [{ field: 'note', code: 'TOO_LONG', message: '备注长度不能超过 1000 个字符' }],
        'req-mapping-1',
      );
    },
  });
  assert.equal(outcome.status, 422);
  assert.equal(outcome.body.code, 'VALIDATION_FAILED');
  assert.equal(outcome.body.requestId, 'req-mapping-1');
  assert.deepEqual(codes(outcome.body.fieldErrors), ['note:TOO_LONG']);
});

test('T-05/T-04: node:http 入口适配器（405 / 201+Location / 422）', async () => {
  const repository = new MemoryCustomerRepository();
  const handler = createCustomerNodeHandler({
    principal: { userId: 'user-001', displayName: '测试用户' },
    useCase: (input) => createCustomer(input, { repository, actor: ACTOR, domain: fixedDeps() }),
  });

  const run = async (method, body) => {
    const listeners = {};
    const req = {
      method,
      headers: { 'x-request-id': 'req-node-1' },
      setEncoding() {
        return req;
      },
      on(event, listener) {
        (listeners[event] ??= []).push(listener);
        return req;
      },
      destroy() {
        return req;
      },
    };
    const res = {
      statusCode: 0,
      headers: {},
      body: undefined,
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
        return res;
      },
      end(chunk) {
        this.body = chunk;
        return res;
      },
    };
    const pending = handler(req, res);
    for (const listener of listeners.data ?? []) {
      listener(typeof body === 'string' ? body : JSON.stringify(body));
    }
    for (const listener of listeners.end ?? []) listener();
    await pending;
    return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
  };

  const wrongMethod = await run('GET', {});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  assertErrorEnvelope(wrongMethod.body, { expectFieldErrors: false });

  const ok = await run('POST', validDraft({ name: '直跑客户' }));
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.location, '/api/v1/customers/CST-TEST000001');
  assert.equal(ok.body.name, '直跑客户');
  assert.equal(await repository.count(), 1);

  const rejected = await run('POST', { name: '', phone: 'bad', extraField: 1 });
  assert.equal(rejected.status, 422);
  assertErrorEnvelope(rejected.body, { expectFieldErrors: true });
  assert.deepEqual(codes(rejected.body.fieldErrors), [
    'extraField:INVALID_FORMAT',
    'name:REQUIRED',
    'phone:INVALID_FORMAT',
  ]);
  assert.equal(rejected.body.requestId, 'req-node-1');
  assert.equal(await repository.count(), 1);
});

// ---------------------------------------------------------------------------
// 装配缺口特征用例（业务侧修复 .js 说明符后应改为断言真实装配返回 201）
// ---------------------------------------------------------------------------

test('T-05 装配缺口（现状记录）：未注入 useCase 时在 Node 24 type-stripping 运行时无法解析 T-03 用例', async () => {
  let nativeLoadError = null;
  try {
    await import(SOURCE.application.href);
  } catch (error) {
    nativeLoadError = error;
  }
  assert.ok(nativeLoadError, '业务侧 .js 说明符修复后请删除本特征用例，并改为断言真实装配 201');
  assert.equal(nativeLoadError.code, 'ERR_MODULE_NOT_FOUND');

  const outcome = await handleCreateCustomer(validDraft({ name: '装配客户' }), {
    requestId: 'req-assembly-1',
    principal: { userId: 'user-001' },
  });
  assert.equal(outcome.status, 500);
  assert.equal(outcome.body.code, 'CREATE_CUSTOMER_UNAVAILABLE');
});

test('T-05 装配缺口（HTTP 边界现状记录）：默认装配经 loopback POST 返回 500 且不写入', async (t) => {
  const app = createCustomersApp();
  // 与生产挂载口径一致：不注入 useCase，依赖端点模块自身的动态解析。
  app.addRoute('POST', '/api/v1/customers', async (ctx) => {
    const body = await ctx.readJson();
    return handleCreateCustomer(body, { requestId: ctx.requestId, principal: { userId: 'user-001' } });
  });
  const server = await startLoopbackServer(app);
  t.after(() => server.close());

  const response = await postJson(server, '/api/v1/customers', validDraft({ name: '直跑装配客户' }));
  assert.equal(response.status, 500);
  assert.equal(response.headers['x-request-id'], response.body.requestId);
  assertErrorEnvelope(response.body, { expectFieldErrors: false });
  assert.equal(response.body.code, 'CREATE_CUSTOMER_UNAVAILABLE');
  assert.equal('location' in response.headers, false, '未装配成功时不得返回 Location 头');
});

test('T-05/T-06：显式模块装配后五个客户端点可在同一个 loopback 应用中连续使用', async () => {
  const repository = new MemoryCustomerRepository({ phoneKeyFor: normalizePhoneKey });
  const app = createConfiguredCustomersApp({
    repository,
    actor: ACTOR,
    clock: { now: () => FIXED_NOW },
    phoneKeyFor: normalizePhoneKey,
  });
  const server = await startLoopbackServer(app);
  try {
    const createdResponse = await fetch(`${server.origin}/api/v1/customers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'module-create-1' },
      body: JSON.stringify({ name: '装配客户', phone: '138-0000-5678', contactPerson: '李四' }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.name, '装配客户');
    assert.match(created.customerId, CUSTOMER_ID_PATTERN);
    assert.equal(created.createdBy.userId, ACTOR.userId);
    const customerId = created.customerId;

    const searchResponse = await fetch(`${server.origin}/api/v1/customers?keyword=${encodeURIComponent('装配')}`);
    assert.equal(searchResponse.status, 200);
    assert.deepEqual((await searchResponse.json()).items.map((item) => item.customerId), [customerId]);

    const updateResponse = await fetch(`${server.origin}/api/v1/customers/${encodeURIComponent(customerId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"1"' },
      body: JSON.stringify({ company: '示例公司' }),
    });
    assert.equal(updateResponse.status, 200);
    assert.equal(updateResponse.headers.get('etag'), '"2"');
    assert.equal((await updateResponse.json()).company, '示例公司');

    const detailResponse = await fetch(`${server.origin}/api/v1/customers/${encodeURIComponent(customerId)}`);
    assert.equal(detailResponse.status, 200);
    assert.equal((await detailResponse.json()).version, 2);

    const changesResponse = await fetch(`${server.origin}/api/v1/customers/${encodeURIComponent(customerId)}/changes`);
    assert.equal(changesResponse.status, 200);
    const changes = await changesResponse.json();
    assert.equal(changes.total, 1);
    assert.equal(changes.items[0].field, 'company');
  } finally {
    await server.close();
  }
});
