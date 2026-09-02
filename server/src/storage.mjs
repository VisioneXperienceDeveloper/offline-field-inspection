import {mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {clone, DomainError, isPlainObject} from './domain.mjs';

export const STORAGE_VERSION = 1;

export function emptyState() {
  return {
    version: STORAGE_VERSION,
    inspections: {},
    audits: {},
    operations: {byOperation: {}, byIdempotencyKey: {}},
    securityAudit: [],
  };
}

function normalizeState(value) {
  if (!isPlainObject(value) || value.version !== STORAGE_VERSION) {
    throw new DomainError(500, 'STORAGE_VERSION_UNSUPPORTED', `Only storage version ${STORAGE_VERSION} is supported.`);
  }
  if (!isPlainObject(value.inspections) || !isPlainObject(value.audits) || !isPlainObject(value.operations)) {
    throw new DomainError(500, 'STORAGE_CORRUPT', 'The persisted server state is malformed.');
  }
  if (!isPlainObject(value.operations.byOperation) || !isPlainObject(value.operations.byIdempotencyKey)) {
    throw new DomainError(500, 'STORAGE_CORRUPT', 'The persisted operation index is malformed.');
  }
  return {
    ...value,
    securityAudit: Array.isArray(value.securityAudit) ? value.securityAudit : [],
  };
}

export class TransactionalStorage {
  #state;
  #tail = Promise.resolve();
  #persist;

  constructor(initialState = emptyState(), persist = async () => undefined) {
    this.#state = normalizeState(clone(initialState));
    this.#persist = persist;
  }

  transaction(work) {
    const operation = this.#tail.then(async () => {
      const draft = clone(this.#state);
      const result = await work(draft);
      await this.#persist(draft);
      this.#state = draft;
      return clone(result);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async snapshot() {
    await this.#tail;
    return clone(this.#state);
  }
}

export function createMemoryStorage(initialState = emptyState()) {
  return new TransactionalStorage(initialState);
}

async function atomicWrite(filePath, state) {
  const directory = dirname(filePath);
  await mkdir(directory, {recursive: true});
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, {force: true}).catch(() => undefined);
    throw error;
  }
}

export async function createFileStorage(inputPath) {
  const filePath = resolve(inputPath);
  let initialState;
  try {
    const raw = await readFile(filePath, 'utf8');
    initialState = normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error?.code === 'ENOENT') initialState = emptyState();
    else if (error instanceof SyntaxError) throw new DomainError(500, 'STORAGE_CORRUPT', `The storage file at ${filePath} is not valid JSON.`);
    else throw error;
  }
  return new TransactionalStorage(initialState, state => atomicWrite(filePath, state));
}
