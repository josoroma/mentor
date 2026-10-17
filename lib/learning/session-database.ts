import { SessionRecordSchema } from '@/app/_schema'
import type { SessionRecord } from '@/app/_types'
import { mergeSessions, normalizeSessions } from '@/lib/learning/storage'

const DATABASE_NAME = 'mentor-learning'
const STORE_NAME = 'sessions'

const openSessionDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Your browser does not support the local learning database.'))
      return
    }
    const request = indexedDB.open(DATABASE_NAME, 1)
    let settled = false
    const fail = (error: Error) => {
      settled = true
      reject(error)
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () =>
      fail(
        new Error(
          'The local learning database could not be opened. Check browser storage settings.',
        ),
      )
    request.onblocked = () =>
      fail(new Error('Close other Mentor tabs and retry saving to the local learning database.'))
  })

export const readSessionDatabase = async (
  options: { strict?: boolean } = {},
): Promise<SessionRecord[]> => {
  const database = await openSessionDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).getAll()
    transaction.oncomplete = () => {
      database.close()
      try {
        resolve(
          options.strict
            ? SessionRecordSchema.array().parse(request.result)
            : normalizeSessions(request.result),
        )
      } catch {
        reject(new Error('Some saved sessions could not be validated. The backup was not created.'))
      }
    }
    transaction.onabort = transaction.onerror = () => {
      database.close()
      reject(new Error('Your saved learning sessions could not be read from the local database.'))
    }
  })
}

// Replacing a whole collection is one transaction: a failed restore keeps the old rows.
export const replaceSessionDatabase = async (
  values: SessionRecord[],
  updateRecoveryCache?: () => void,
): Promise<void> => {
  const sessions = SessionRecordSchema.array().parse(values)
  const database = await openSessionDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.clear()
    let failure: unknown
    request.onsuccess = () => {
      try {
        for (const session of sessions) store.put(session)
        updateRecoveryCache?.()
      } catch (error) {
        failure = error
        transaction.abort()
      }
    }
    transaction.oncomplete = () => {
      database.close()
      resolve()
    }
    transaction.onabort = transaction.onerror = () => {
      database.close()
      reject(
        failure ?? new Error('The local learning database could not be updated. Please retry.'),
      )
    }
  })
}

export const writeSessionDatabase = async (value: SessionRecord): Promise<SessionRecord> => {
  const session = SessionRecordSchema.parse(value)
  const database = await openSessionDatabase()
  return new Promise((resolve, reject) => {
    // The read and merge belong to the same transaction, including writes from another tab.
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(session.id)
    let saved = session
    request.onsuccess = () => {
      const previous = SessionRecordSchema.safeParse(request.result)
      saved = mergeSessions(previous.success ? [previous.data] : [], [session])[0]
      store.put(saved)
    }
    transaction.oncomplete = () => {
      database.close()
      resolve(saved)
    }
    transaction.onabort = transaction.onerror = () => {
      database.close()
      reject(new Error('Your session could not be saved to the local learning database.'))
    }
  })
}
