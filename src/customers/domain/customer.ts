/**
 * T-01 — Customer aggregate (domain layer, vertical slice S-1).
 *
 * Pure domain module: it has NO imports from outer layers, ORM/DB, HTTP or
 * other business packages, per architecture.md "Module Boundaries" and the
 * dependency rule (`api -> application -> domain <- persistence`). Time comes
 * from an injected Clock so the aggregate stays deterministic under test.
 *
 * Scope (AC-001 / AC-002 only):
 *  - name required: 1..100 chars after trim, non-empty.
 *  - phone required: matches the contract regex ^[0-9()+ -]{6,20}$ (raw kept,
 *    outer whitespace trimmed; internal separators preserved).
 *  - contactPerson / company / note / email optional.
 *  - email, when provided, basic format: has "@", a dot in the domain, no
 *    spaces (data-model.md "含 @ 与点、无空格").
 *  - customerId is server generated ^[A-Z]{2,4}-[0-9A-Za-z-]{6,32}$; a
 *    client-supplied customerId is IGNORED on create (never an error).
 *  - version starts at INITIAL_VERSION (1).
 *  - After creation the identity fields (customerId / createdAt / createdBy /
 *    version) are immutable; attempting to change them yields an IMMUTABLE
 *    field error (spec.md Rules, CustomerUpdateRequest "不接受 ...").
 *  - Field errors carry REQUIRED / TOO_LONG / INVALID_FORMAT / IMMUTABLE.
 *    DUPLICATED is reserved for the phone-uniqueness slice (S-2) and is never
 *    produced here.
 *
 * Phone normalization, uniqueness, persistence and HTTP mapping are
 * intentionally NOT implemented here (they belong to other tasks/slices).
 */

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** Server-generated customer id shape (openapi CustomerIdPath / data-model). */
export const CUSTOMER_ID_PATTERN = /^[A-Z]{2,4}-[0-9A-Za-z-]{6,32}$/;

/** Display phone shape (openapi CustomerCreateRequest.phone). */
export const PHONE_PATTERN = /^[0-9()+ -]{6,20}$/;

/** Basic email shape: non-space local, "@", domain with at least one dot. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export const NAME_MAX = 100;
export const CONTACT_PERSON_MAX = 50;
export const COMPANY_MAX = 100;
export const NOTE_MAX = 1000;
export const EMAIL_MAX = 100;

/** Optimistic-lock version assigned at creation; equivalent to the ETag. */
export const INITIAL_VERSION = 1;

/** Mutable fields, named exactly as the contract request properties. */
export const MUTABLE_FIELDS = [
  'name',
  'contactPerson',
  'phone',
  'email',
  'company',
  'note',
] as const;
export type MutableField = (typeof MUTABLE_FIELDS)[number];

/** Read-only identity fields; the update path must reject all of them. */
export const IMMUTABLE_FIELDS = [
  'customerId',
  'createdAt',
  'createdBy',
  'version',
] as const;
export type ImmutableField = (typeof IMMUTABLE_FIELDS)[number];

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/** FieldError codes from the contract; DUPLICATED is reserved for S-2. */
export type FieldErrorCode =
  | 'REQUIRED'
  | 'TOO_LONG'
  | 'INVALID_FORMAT'
  | 'DUPLICATED'
  | 'IMMUTABLE';

/** Single field error, aligned with openapi components.schemas.FieldError. */
export interface FieldError {
  readonly field: string;
  readonly code: FieldErrorCode;
  readonly message: string;
}

/** Optional scalar as accepted from a decoded request body. */
export type OptionalField = string | null | undefined;

/** Normalized, validated mutable values (trimmed / cleared). */
export interface CustomerMutableValues {
  readonly name: string;
  readonly contactPerson: string | null;
  readonly phone: string;
  readonly email: string | null;
  readonly company: string | null;
  readonly note: string | null;
}

/** Writable counterpart used only while accumulating a partial update. */
type MutableValuesDraft = { [K in MutableField]?: string | null };

/** A decoded create/patch body. Identity fields, if present, are handled by
 *  the operation: ignored on create, rejected (IMMUTABLE) on update. */
export interface CustomerInput extends Partial<Record<ImmutableField, unknown>> {
  name: OptionalField;
  phone: OptionalField;
  contactPerson?: OptionalField;
  email?: OptionalField;
  company?: OptionalField;
  note?: OptionalField;
}

/** A PATCH body: every key is optional, but submitted keys must be valid. */
export type CustomerPatchInput = Partial<Record<MutableField, OptionalField>> &
  Partial<Record<ImmutableField, unknown>>;

// ---------------------------------------------------------------------------
// Ports (injected for determinism; default implementations are pure)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

/** Deterministic time source for tests; defaults to the system clock. */
export const systemClock: Clock = { now: () => new Date() };

export type RandomSource = () => number;

/** Defaults to Math.random (returns [0, 1)). */
export const systemRandom: RandomSource = () => Math.random();

export interface CustomerCreateDeps {
  readonly clock?: Clock;
  readonly random?: RandomSource;
  /** Advanced override for fully deterministic ids in tests. */
  readonly newCustomerId?: () => string;
}

/** Authenticated principal userId (server assigned, never user input). */
export interface CustomerActor {
  readonly userId: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Precondition / programming error (not a user validation error). */
export class CustomerDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomerDomainError';
  }
}

// ---------------------------------------------------------------------------
// Customer id generation
// ---------------------------------------------------------------------------

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ID_PREFIX = 'CST'; // 2..4 uppercase letters -> matches ^[A-Z]{2,4}-
const ID_BODY_LENGTH = 12; // 6..32 chars -> within [0-9A-Za-z-]{6,32}

/**
 * Generate a server-side customer id matching CUSTOMER_ID_PATTERN. Global
 * uniqueness is enforced by the primary key (persistence, S-2+); this only
 * guarantees contract shape and low collision probability.
 */
export function generateCustomerId(
  random: RandomSource = systemRandom,
): string {
  let body = '';
  for (let i = 0; i < ID_BODY_LENGTH; i += 1) {
    const idx = Math.floor(random() * ID_ALPHABET.length) % ID_ALPHABET.length;
    body += ID_ALPHABET.charAt(idx);
  }
  const id = `${ID_PREFIX}-${body}`;
  if (!CUSTOMER_ID_PATTERN.test(id)) {
    throw new CustomerDomainError(
      `generated customer id "${id}" violates the contract pattern`,
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Field validation helpers (shared by create & update)
// ---------------------------------------------------------------------------

function error(
  field: string,
  code: FieldErrorCode,
  message: string,
): FieldError {
  return { field, code, message };
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBlankString(value: unknown): boolean {
  return isString(value) && value.trim() === '';
}

interface TextResult {
  readonly error?: FieldError;
  readonly value?: string;
}

/**
 * Validate a text field.
 *  - required=true : absent / blank -> REQUIRED, wrong type -> INVALID_FORMAT
 *  - required=false: absent / blank -> null (no error), wrong type -> INVALID
 *  - length > max  -> TOO_LONG (measured after trim)
 */
function validateText(
  field: string,
  raw: unknown,
  opts: { readonly required: boolean; readonly max: number; readonly label: string },
): TextResult {
  if (!isPresent(raw) || isBlankString(raw)) {
    return opts.required
      ? { error: error(field, 'REQUIRED', `${opts.label}不能为空`) }
      : { value: undefined };
  }
  if (!isString(raw)) {
    return { error: error(field, 'INVALID_FORMAT', `${opts.label}格式不正确`) };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return opts.required
      ? { error: error(field, 'REQUIRED', `${opts.label}不能为空`) }
      : { value: undefined };
  }
  if (trimmed.length > opts.max) {
    return {
      error: error(
        field,
        'TOO_LONG',
        `${opts.label}长度不能超过 ${opts.max} 个字符`,
      ),
    };
  }
  return { value: trimmed };
}

/**
 * Validate the phone field.
 *  - required=true : absent / blank -> REQUIRED
 *  - wrong type / not matching PHONE_PATTERN -> INVALID_FORMAT
 * Returns the trimmed raw value (internal separators preserved).
 */
function validatePhone(field: string, raw: unknown, required: boolean): TextResult {
  if (!isPresent(raw) || isBlankString(raw)) {
    return required
      ? { error: error(field, 'REQUIRED', '联系电话不能为空') }
      : { value: undefined };
  }
  if (!isString(raw)) {
    return { error: error(field, 'INVALID_FORMAT', '联系电话格式不正确') };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return required
      ? { error: error(field, 'REQUIRED', '联系电话不能为空') }
      : { value: undefined };
  }
  if (!PHONE_PATTERN.test(trimmed)) {
    return { error: error(field, 'INVALID_FORMAT', '联系电话格式不正确') };
  }
  return { value: trimmed };
}

/**
 * Validate the email field (optional).
 *  - absent / blank -> null
 *  - length > EMAIL_MAX -> TOO_LONG
 *  - not matching EMAIL_PATTERN -> INVALID_FORMAT
 */
function validateEmail(field: string, raw: unknown): TextResult {
  if (!isPresent(raw) || isBlankString(raw)) {
    return { value: undefined };
  }
  if (!isString(raw)) {
    return { error: error(field, 'INVALID_FORMAT', '邮箱格式不正确') };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { value: undefined };
  }
  if (trimmed.length > EMAIL_MAX) {
    return {
      error: error(field, 'TOO_LONG', `邮箱长度不能超过 ${EMAIL_MAX} 个字符`),
    };
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    return { error: error(field, 'INVALID_FORMAT', '邮箱格式不正确') };
  }
  return { value: trimmed };
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Identity fields the client tried to send on create (silently ignored). */
function collectIgnoredIdentityFields(input: CustomerInput): string[] {
  const ignored: string[] = [];
  for (const field of IMMUTABLE_FIELDS) {
    if (hasOwn(input, field)) {
      ignored.push(field);
    }
  }
  return ignored;
}

/**
 * Coerce a create input into normalized mutable values, collecting every
 * failing field (multi-field failures are reported one by one, AC-002).
 */
function coerceCreate(input: CustomerInput): {
  readonly errors: FieldError[];
  readonly values: CustomerMutableValues | null;
} {
  const errors: FieldError[] = [];
  const name = validateText('name', input.name, {
    required: true,
    max: NAME_MAX,
    label: '客户名称',
  });
  const phone = validatePhone('phone', input.phone, true);
  const contactPerson = validateText('contactPerson', input.contactPerson, {
    required: false,
    max: CONTACT_PERSON_MAX,
    label: '联系人',
  });
  const email = validateEmail('email', input.email);
  const company = validateText('company', input.company, {
    required: false,
    max: COMPANY_MAX,
    label: '公司名称',
  });
  const note = validateText('note', input.note, {
    required: false,
    max: NOTE_MAX,
    label: '备注',
  });
  for (const r of [name, phone, contactPerson, email, company, note]) {
    if (r.error) {
      errors.push(r.error);
    }
  }
  if (errors.length > 0) {
    return { errors, values: null };
  }
  return {
    errors,
    values: {
      name: name.value as string,
      contactPerson: contactPerson.value ?? null,
      phone: phone.value as string,
      email: email.value ?? null,
      company: company.value ?? null,
      note: note.value ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CreateSuccess {
  readonly ok: true;
  readonly customer: Customer;
  /** Identity keys the client sent that create deliberately ignored. */
  readonly ignoredClientFields: readonly string[];
}

export interface CreateFailure {
  readonly ok: false;
  readonly errors: readonly FieldError[];
  readonly ignoredClientFields: readonly string[];
}

export type CreateResult = CreateSuccess | CreateFailure;

/**
 * Result of an update attempt. `changes` holds only the submitted mutable
 * fields; applying them, bumping the version and enforcing concurrency are
 * orchestrated by the application layer (S-4).
 */
export type UpdateResult =
  | { readonly ok: true; readonly changes: Partial<CustomerMutableValues> }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface CustomerProps {
  readonly customerId: string;
  readonly name: string;
  readonly contactPerson: string | null;
  readonly phone: string;
  readonly email: string | null;
  readonly company: string | null;
  readonly note: string | null;
  readonly version: number;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Customer aggregate. Instances are immutable from the outside: fields are
 * private with read-only getters and every state transition returns a new
 * aggregate. Identity fields are fixed at construction.
 */
export class Customer {
  private readonly _customerId: string;
  private readonly _name: string;
  private readonly _contactPerson: string | null;
  private readonly _phone: string;
  private readonly _email: string | null;
  private readonly _company: string | null;
  private readonly _note: string | null;
  private readonly _version: number;
  private readonly _createdBy: string;
  private readonly _updatedBy: string;
  private readonly _createdAt: Date;
  private readonly _updatedAt: Date;

  private constructor(props: CustomerProps) {
    this._customerId = props.customerId;
    this._name = props.name;
    this._contactPerson = props.contactPerson;
    this._phone = props.phone;
    this._email = props.email;
    this._company = props.company;
    this._note = props.note;
    this._version = props.version;
    this._createdBy = props.createdBy;
    this._updatedBy = props.updatedBy;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  // --- read-only accessors -------------------------------------------------

  get customerId(): string {
    return this._customerId;
  }
  get name(): string {
    return this._name;
  }
  get contactPerson(): string | null {
    return this._contactPerson;
  }
  get phone(): string {
    return this._phone;
  }
  get email(): string | null {
    return this._email;
  }
  get company(): string | null {
    return this._company;
  }
  get note(): string | null {
    return this._note;
  }
  get version(): number {
    return this._version;
  }
  get createdBy(): string {
    return this._createdBy;
  }
  get updatedBy(): string {
    return this._updatedBy;
  }
  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }
  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  // --- factory -------------------------------------------------------------

  /**
   * Validate a create input and build a new Customer with a server-generated
   * id and version = INITIAL_VERSION. Returns field errors (no aggregate) on
   * any validation failure, so no half-created record can be persisted.
   *
   * @param actor authenticated principal providing createdBy/updatedBy.
   * @throws CustomerDomainError when the server-supplied actor or the
   *         generated id violate their preconditions (programming errors, not
   *         user validation errors).
   */
  static create(
    input: CustomerInput,
    actor: CustomerActor,
    deps: CustomerCreateDeps = {},
  ): CreateResult {
    const ignoredClientFields = collectIgnoredIdentityFields(input);
    const { errors, values } = coerceCreate(input);
    if (errors.length > 0 || values === null) {
      return { ok: false, errors, ignoredClientFields };
    }

    const createdBy = typeof actor?.userId === 'string' ? actor.userId.trim() : '';
    if (createdBy === '') {
      throw new CustomerDomainError(
        'createdBy (authenticated principal) is required to create a Customer',
      );
    }

    const clock = deps.clock ?? systemClock;
    const newId =
      deps.newCustomerId ?? (() => generateCustomerId(deps.random ?? systemRandom));
    const customerId = newId();
    if (!CUSTOMER_ID_PATTERN.test(customerId)) {
      throw new CustomerDomainError(
        `generated customer id "${customerId}" violates the contract pattern`,
      );
    }

    const now = clock.now();
    const customer = new Customer({
      customerId,
      name: values.name,
      contactPerson: values.contactPerson,
      phone: values.phone,
      email: values.email,
      company: values.company,
      note: values.note,
      version: INITIAL_VERSION,
      createdBy,
      updatedBy: createdBy,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, customer, ignoredClientFields };
  }

  /**
   * Rebuild a trusted Customer (e.g. from persistence). This does not re-run
   * user validation, but it guards grossly broken invariants (id shape,
   * version >= 1).
   * @throws CustomerDomainError if the id or version are invalid.
   */
  static restore(props: CustomerProps): Customer {
    if (!CUSTOMER_ID_PATTERN.test(props.customerId)) {
      throw new CustomerDomainError(
        `customer id "${props.customerId}" violates the contract pattern`,
      );
    }
    if (!Number.isInteger(props.version) || props.version < INITIAL_VERSION) {
      throw new CustomerDomainError(
        `customer version must be an integer >= ${INITIAL_VERSION}`,
      );
    }
    return new Customer({
      customerId: props.customerId,
      name: props.name,
      contactPerson: props.contactPerson ?? null,
      phone: props.phone,
      email: props.email ?? null,
      company: props.company ?? null,
      note: props.note ?? null,
      version: props.version,
      createdBy: props.createdBy,
      updatedBy: props.updatedBy,
      createdAt: props.createdAt,
      updatedAt: props.updatedAt,
    });
  }

  // --- behavior ------------------------------------------------------------

  /**
   * Validate a PATCH against this aggregate without mutating it. Submitted
   * mutable fields are checked; the identity fields are rejected with an
   * IMMUTABLE error (spec: customerId / createdAt / createdBy / version are
   * read-only after creation). Multi-field failures are listed one by one.
   */
  attemptUpdate(patch: CustomerPatchInput): UpdateResult {
    const errors: FieldError[] = [];

    for (const field of IMMUTABLE_FIELDS) {
      if (hasOwn(patch, field)) {
        errors.push(error(field, 'IMMUTABLE', `${field} 创建后不可修改`));
      }
    }

    const changes: MutableValuesDraft = {};
    const submitted: Array<readonly [MutableField, TextResult]> = [];

    if (hasOwn(patch, 'name')) {
      submitted.push([
        'name',
        validateText('name', patch.name, {
          required: true,
          max: NAME_MAX,
          label: '客户名称',
        }),
      ]);
    }
    if (hasOwn(patch, 'phone')) {
      submitted.push(['phone', validatePhone('phone', patch.phone, true)]);
    }
    if (hasOwn(patch, 'contactPerson')) {
      submitted.push([
        'contactPerson',
        validateText('contactPerson', patch.contactPerson, {
          required: false,
          max: CONTACT_PERSON_MAX,
          label: '联系人',
        }),
      ]);
    }
    if (hasOwn(patch, 'email')) {
      submitted.push(['email', validateEmail('email', patch.email)]);
    }
    if (hasOwn(patch, 'company')) {
      submitted.push([
        'company',
        validateText('company', patch.company, {
          required: false,
          max: COMPANY_MAX,
          label: '公司名称',
        }),
      ]);
    }
    if (hasOwn(patch, 'note')) {
      submitted.push([
        'note',
        validateText('note', patch.note, {
          required: false,
          max: NOTE_MAX,
          label: '备注',
        }),
      ]);
    }

    for (const [field, result] of submitted) {
      if (result.error) {
        errors.push(result.error);
      } else {
        changes[field] = result.value ?? null;
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true, changes: changes as Partial<CustomerMutableValues> };
  }

  /**
   * Produce a new aggregate with `changes` applied, version +1 and the update
   * audit stamps advanced. Identity fields are never touched. Concurrency
   * (If-Match / version comparison) is the application layer's concern; this
   * method is the domain's version self-increment.
   */
  withAppliedUpdate(
    changes: Partial<CustomerMutableValues>,
    actor: CustomerActor,
    clock: Clock = systemClock,
  ): Customer {
    const updatedBy = typeof actor?.userId === 'string' ? actor.userId.trim() : '';
    if (updatedBy === '') {
      throw new CustomerDomainError(
        'updatedBy (authenticated principal) is required to update a Customer',
      );
    }
    return new Customer({
      customerId: this._customerId,
      name: changes.name ?? this._name,
      contactPerson:
        'contactPerson' in changes
          ? changes.contactPerson ?? null
          : this._contactPerson,
      phone: changes.phone ?? this._phone,
      email: 'email' in changes ? changes.email ?? null : this._email,
      company: 'company' in changes ? changes.company ?? null : this._company,
      note: 'note' in changes ? changes.note ?? null : this._note,
      version: this._version + 1,
      createdBy: this._createdBy,
      updatedBy,
      createdAt: this._createdAt,
      updatedAt: clock.now(),
    });
  }

  /** Plain snapshot of the current values (Dates cloned). */
  snapshot(): CustomerProps {
    return {
      customerId: this._customerId,
      name: this._name,
      contactPerson: this._contactPerson,
      phone: this._phone,
      email: this._email,
      company: this._company,
      note: this._note,
      version: this._version,
      createdBy: this._createdBy,
      updatedBy: this._updatedBy,
      createdAt: new Date(this._createdAt.getTime()),
      updatedAt: new Date(this._updatedAt.getTime()),
    };
  }
}
