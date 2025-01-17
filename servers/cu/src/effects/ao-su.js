/* eslint-disable camelcase */
import { Transform, compose as composeStreams } from 'node:stream'
import { createHash } from 'node:crypto'

import { of } from 'hyper-async'
import { always, applySpec, filter, has, ifElse, isNil, isNotNil, juxt, last, mergeAll, path, pathOr, pipe, prop } from 'ramda'
import DataLoader from 'dataloader'

import { backoff, mapForwardedBy, mapFrom, addressFrom, parseTags, strFromFetchError } from '../domain/utils.js'

const base64UrlToBytes = (b64Url) =>
  Buffer.from(b64Url, 'base64url')

const okRes = (res) => {
  if (res.ok) return res
  throw res
}

const resToJson = (res) => res.json()

const hashChain = (prevHashChain, prevAssignmentId) => {
  const hash = createHash('sha256')

  /**
   * For the very first message, there is no previous id,
   * so it is not included in the hashed bytes, to produce the very first
   * hash chain
   */
  if (prevAssignmentId) hash.update(base64UrlToBytes(prevAssignmentId))
  /**
   * Always include the previous hash chain
   */
  hash.update(base64UrlToBytes(prevHashChain))

  return hash.digest('base64url')
}

export const isHashChainValid = (scheduled) => {
  const { prevAssignment, message } = scheduled
  const actual = message['Hash-Chain']

  /**
   * This will match in cases where the SU returns no prevAssignment
   * which is to say the feature isn't live on the SU.
   *
   * AND will match validating the first assignment, which needs
   * no validation, besides needing to check its hashChain is present
   */
  if (!prevAssignment?.id || !prevAssignment?.hashChain) return !!actual

  const expected = hashChain(prevAssignment.hashChain, prevAssignment.id)
  return expected === actual
}

/**
 * See new shape in https://github.com/permaweb/ao/issues/563#issuecomment-2020597581
 */
export const mapNode = pipe(
  juxt([
    // fromAssignment
    pipe(
      path(['assignment']),
      (assignment) => {
        const tags = parseTags(assignment.tags)

        return applySpec({
          /**
           * The assignment id is needed in order to compute
           * and verify the hash chain
           */
          AssignmentId: always(assignment.id),
          /**
           * There could be multiple Exclude tags,
           * but parseTags will accumulate them into an array,
           *
           * which is what we want
           */
          Exclude: path(['Exclude']),
          /**
           * Data from the assignment, to be placed
           * on the message
           */
          message: applySpec({
            Message: path(['Message']),
            Target: path(['Process']),
            Epoch: pipe(path(['Epoch']), parseInt),
            Nonce: pipe(path(['Nonce']), parseInt),
            Timestamp: pipe(path(['Timestamp']), parseInt),
            'Block-Height': pipe(
            /**
             * Returns a left padded integer like '000001331218'
             *
             * So use parseInt to convert it into a number
             */
              path(['Block-Height']),
              parseInt
            ),
            'Hash-Chain': path(['Hash-Chain'])
          })
        })(tags)
      }
    ),
    // fromMessage
    pipe(
      path(['message']),
      (message) => {
        /**
         * No message, meaning this is an Assignment for an existing message
         * on chain, to be hydrated later (see hydrateMessages)
         */
        if (isNil(message)) return undefined

        const address = addressFrom(message.owner)

        return applySpec({
          Id: path(['id']),
          Signature: path(['signature']),
          Data: path(['data']),
          Owner: always(address),
          Anchor: path(['anchor']),
          From: (message) => mapFrom({ tags: message.tags, owner: address }),
          'Forwarded-By': (message) => mapForwardedBy({ tags: message.tags, owner: address }),
          Tags: pathOr([], ['tags'])
        })(message)
      }
    ),
    // both
    applySpec({
      isAssignment: pipe(
        path(['message', 'id']),
        isNil
      )
    }),
    // static
    always({ Cron: false })
  ]),
  // Combine into the desired shape
  ([fAssignment, fMessage = {}, fBoth, fStatic]) => ({
    cron: undefined,
    ordinate: fAssignment.message.Nonce,
    name: `${fBoth.isAssignment ? 'Assigned' : 'Scheduled'} Message ${fBoth.isAssignment ? fAssignment.message.Message : fMessage.Id} ${fAssignment.message.Timestamp}:${fAssignment.message.Nonce}`,
    exclude: fAssignment.Exclude,
    isAssignment: fBoth.isAssignment,
    assignmentId: fAssignment.AssignmentId,
    message: mergeAll([
      fMessage,
      fAssignment.message,
      /**
       * For an Assignment, the message, and ergo it's Id will be undefined,
       * but the assignment will contain a Message Tag that indicates the assigned tx.
       * In this case, the assigned data can be queried for and hydrated, using the Id.
       *
       * So we must ensure that this field is always set, regardless if this is a message
       * or just an Assignment for an existing message on-chain
       */
      { Id: fBoth.isAssignment ? fAssignment.message.Message : fMessage.Id },
      /**
       * For an Assignment, the Target is derived from the recipient of
       * the assigned tx.
       *
       * So we explicitly set Target to undefined here, such that hydration of Target
       * must occur later. Otherwise we will receive high signal, in the form of an error,
       * that the impl is incorrect, as opposed to an assignment potentially being misinterpreted
       * as a bonafide scheduled message.
       */
      { Target: fBoth.isAssignment ? undefined : fAssignment.message.Target },
      fStatic
    ]),
    /**
     * We need the block metadata per message,
     * so that we can calculate cron messages
     *
     * Separating them here, makes it easier to access later
     * down the pipeline
     */
    block: {
      height: fAssignment.message['Block-Height'],
      timestamp: fAssignment.message.Timestamp
    }
  })
)

export const loadMessagesWith = ({ fetch, logger: _logger, pageSize }) => {
  const logger = _logger.child('ao-su:loadMessages')

  const fetchPageDataloader = new DataLoader(async (args) => {
    fetchPageDataloader.clearAll()

    return Promise.allSettled(
      args.map(({ suUrl, processId, from, to, pageSize }) => {
        return Promise.resolve({ 'process-id': processId, from, to, limit: pageSize })
          .then(filter(isNotNil))
          .then(params => new URLSearchParams(params))
          .then((params) => fetch(`${suUrl}/${processId}?${params.toString()}`).then(okRes))
          .catch(async (err) => {
            logger(
              'Error Encountered when fetching page of scheduled messages from SU \'%s\' for process \'%s\' between \'%s\' and \'%s\'',
              suUrl,
              processId,
              from,
              to
            )
            throw new Error(`Encountered Error fetching scheduled messages from Scheduler Unit: ${await strFromFetchError(err)}`)
          })
          .then(resToJson)
      })
    ).then((values) =>
      /**
       * By returning the error, Dataloader will register as an error
       * for the individual call to load, without failing the batch as a whole
       *
       * See https://www.npmjs.com/package/dataloader#caching-errors
       */
      values.map(v => v.status === 'fulfilled' ? v.value : v.reason)
    )
  }, {
    cacheKeyFn: ({ suUrl, processId, from, to, pageSize }) => `${suUrl},${processId},${from},${to},${pageSize}`,
    batchScheduleFn: (cb) => setTimeout(cb, 20)
  })

  /**
   * Returns an async generator that emits scheduled messages,
   * one at a time
   *
   * Scheduled messages are fetched a page at a time, but
   * emitted from the generator one message at a time.
   *
   * When the currently fetched page is drained, the next page is fetched
   * dynamically
   */
  function fetchAllPages ({ suUrl, processId, from, to }) {
    async function fetchPage ({ from }) {
      const params = new URLSearchParams(filter(isNotNil, { 'process-id': processId, from, to, limit: pageSize }))

      return backoff(
        () => fetchPageDataloader.load({ suUrl, processId, from, to, pageSize }),
        { maxRetries: 5, delay: 500, log: logger, name: `loadMessages(${JSON.stringify({ suUrl, processId, params: params.toString() })})` }
      )
    }

    return async function * scheduled () {
      let curPage = []
      let curFrom = from
      let hasNextPage = true

      let total = 0

      while (hasNextPage) {
        await Promise.resolve()
          .then(() => {
            logger(
              'Loading next page of max %s messages for process "%s" from SU "%s" between "%s" and "%s"',
              pageSize,
              processId,
              suUrl,
              from || 'initial',
              to || 'latest'
            )
            return fetchPage({ from: curFrom })
          })
          .then(({ page_info, edges }) => {
            total += edges.length
            curPage = edges
            hasNextPage = page_info.has_next_page
            curFrom = page_info.has_next_page && pipe(
              last,
              path(['cursor'])
            )(edges)
          })

        while (curPage.length) yield curPage.shift()
      }

      logger(
        'Successfully loaded a total of %s scheduled messages for process "%s" from SU "%s" between "%s" and "%s"...',
        total,
        processId,
        suUrl,
        from || 'initial',
        to || 'latest')
    }
  }

  function mapAoMessage ({ processId, processOwner, processTags, moduleId, moduleOwner, moduleTags, logger }) {
    const AoGlobal = {
      Process: { Id: processId, Owner: processOwner, Tags: processTags },
      Module: { Id: moduleId, Owner: moduleOwner, Tags: moduleTags }
    }

    return async function * (edges) {
      for await (const edge of edges) {
        const scheduled = pipe(
          prop('node'),
          /**
           * Map to the expected shape
           */
          mapNode,
          (scheduled) => {
            scheduled.AoGlobal = AoGlobal
            return scheduled
          }
        )(edge)

        // if (!isHashChainValid(scheduled)) {
        //   logger('HashChain invalid on message "%s" scheduled on process "%s"', scheduled.message.Id, processId)
        //   const err = new Error(`HashChain invalid on message ${scheduled.message.Id}`)
        //   err.status = 422
        //   throw err
        // }

        yield scheduled
      }
    }
  }

  return (args) =>
    of(args)
      .map(({ suUrl, processId, owner: processOwner, tags: processTags, moduleId, moduleOwner, moduleTags, from, to }) => {
        return composeStreams(
          /**
           * compose will convert the AsyncIterable into a readable Duplex
           */
          fetchAllPages({ suUrl, processId, from, to })(),
          Transform.from(mapAoMessage({ processId, processOwner, processTags, moduleId, moduleOwner, moduleTags, logger }))
        )
      })
      .toPromise()
}

export const loadProcessWith = ({ fetch, logger }) => {
  return async ({ suUrl, processId }) => {
    return backoff(
      () => fetch(`${suUrl}/processes/${processId}`, { method: 'GET' }).then(okRes),
      { maxRetries: 5, delay: 500, log: logger, name: `loadProcess(${JSON.stringify({ suUrl, processId })})` }
    )
      .catch(async (err) => {
        logger('Error Encountered when loading process "%s" from SU "%s"', processId, suUrl)
        throw new Error(`Error Encountered when loading process from Scheduler Unit: ${await strFromFetchError(err)}`)
      })
      .then(resToJson)
      .then(applySpec({
        owner: path(['owner']),
        tags: path(['tags']),
        block: applySpec({
          height: pipe(
            path(['block']),
            (block) => parseInt(block)
          ),
          /**
           * SU is currently sending back timestamp in milliseconds,
           */
          timestamp: path(['timestamp'])
        }),
        /**
         * These were added for the aop6 Boot Loader change so that
         * the Process can be used properly downstream.
         *
         * See https://github.com/permaweb/ao/issues/730
         */
        processId: always(processId),
        timestamp: path(['timestamp']),
        nonce: always(0),
        signature: path(['signature']),
        data: path(['data']),
        anchor: path(['anchor'])
      }))
  }
}

export const loadTimestampWith = ({ fetch, logger }) => {
  return ({ suUrl, processId }) => backoff(
    () => fetch(`${suUrl}/timestamp?process-id=${processId}`).then(okRes),
    { maxRetries: 5, delay: 500, log: logger, name: `loadTimestamp(${JSON.stringify({ suUrl, processId })})` }
  )
    .catch(async (err) => {
      logger('Error Encountered when loading timestamp for process "%s" from SU "%s"', processId, suUrl)
      throw new Error(`Error Encountered when loading timestamp for process from Scheduler Unit: ${await strFromFetchError(err)}`)
    })
    .then(resToJson)
    .then((res) => ({
      /**
       * TODO: SU currently sends these back as strings
       * so need to parse them to integers
       */
      timestamp: parseInt(res.timestamp),
      height: parseInt(res.block_height)
    }))
}

export const loadMessageMetaWith = ({ fetch, logger }) => {
  const legacyMeta = (res) => ({
    processId: res.process_id,
    timestamp: res.timestamp,
    nonce: res.nonce
  })

  const meta = pipe(
    pathOr([], ['assignment', 'tags']),
    parseTags,
    applySpec({
      processId: path(['Process']),
      timestamp: pipe(
        path(['Timestamp']),
        parseInt
      ),
      nonce: pipe(
        path(['Nonce']),
        parseInt
      )
    })
  )

  const mapMeta = ifElse(has('assignment'), meta, legacyMeta)

  return async ({ suUrl, processId, messageTxId }) => {
    return backoff(
      () => fetch(`${suUrl}/${messageTxId}?process-id=${processId}`, { method: 'GET' }).then(okRes),
      { maxRetries: 5, delay: 500, log: logger, name: `loadMessageMeta(${JSON.stringify({ suUrl, processId, messageTxId })})` }
    )
      .catch(async (err) => {
        logger(
          'Error Encountered when loading message meta for message "%s" to process "%s" from SU "%s"',
          messageTxId, processId, suUrl
        )
        throw new Error(`Error Encountered when loading message from Scheduler Unit: ${await strFromFetchError(err)}`)
      })
      .then(resToJson)
      /**
       * Map to the expected shape, depending on the response shape.
       * See https://github.com/permaweb/ao/issues/563
       */
      .then(mapMeta)
  }
}
