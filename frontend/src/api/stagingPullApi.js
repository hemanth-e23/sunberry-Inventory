// Forklift staging-pull API surface.
//
// Plain functions over the shared axios instance (`src/api/client.js`, whose
// baseURL already ends in `/api`). Same shape as `lotReceivingApi.js`, for the
// same reason: pull requests are per-batch and high-cardinality, so the screen
// fetches what it is looking at when it opens it.

import apiClient from './client';
import { apiErrorMessage } from './ingredientContainerApi';

const unwrap = (promise) => promise.then((response) => response.data);

export { apiErrorMessage };

/** Open pull requests for this warehouse — what the gun's list screen shows. */
export const listStagingPullRequests = () =>
  unwrap(apiClient.get('/staging-pull/requests'));

/** One request with its items, FEFO suggestions included. */
export const getStagingPullRequest = (requestId) =>
  unwrap(apiClient.get(`/staging-pull/requests/${requestId}`));

/**
 * Path of the pull-scan endpoint.
 *
 * Exported rather than inlined because it is used twice for the same call: as
 * `scanQueue`'s `endpoint` field (offline replay) and to scope drain results.
 * One definition means the queued path and the live path cannot drift apart.
 */
export const stagingPullScanEndpoint = (requestId) =>
  `/staging-pull/requests/${requestId}/scan`;

/** Recover the request id from a queued item's endpoint, to scope drain results. */
export const requestIdFromEndpoint = (endpoint) => {
  const match = /\/staging-pull\/requests\/([^/]+)\/scan$/.exec(endpoint || '');
  return match ? match[1] : null;
};

/** Take the last pull back off the cart. Server-side; never a client delete. */
export const undoStagingPull = (requestId) =>
  unwrap(apiClient.post(`/staging-pull/requests/${requestId}/undo`));

/**
 * Hand the cart over to staging.
 *
 * Returns `needs_confirm` with the short lines named when the pull is short —
 * call again with `confirmed: true` to go through. Short is legal; the confirm
 * exists so the shortfall is said out loud, not to block it.
 */
export const submitStagingPull = (
  requestId,
  { staging_location_id, staging_sub_location_id = null, confirmed = false } = {},
) =>
  unwrap(apiClient.post(
    `/staging-pull/requests/${requestId}/submit`,
    {
      staging_location_id,
      staging_sub_location_id: staging_sub_location_id || null,
    },
    { params: { confirmed } },
  ));
