import type { Detector } from '../types.js';
import { gitLocal } from './gitLocal.js';
import { githubCiFailing } from './githubCiFailing.js';
import { githubReviewRequested } from './githubReviewRequested.js';
import { githubStale } from './githubStale.js';
import { githubUnaddressed } from './githubUnaddressed.js';
import { meeting } from './meeting.js';
import { idea } from './idea.js';
import { standupCarryover } from './standupCarryover.js';
import { slackAsk } from './slackAsk.js';
import { slackPromise } from './slackPromise.js';
import { slackUnanswered } from './slackUnanswered.js';

/**
 * The detector registry. One file per detector in this directory; import it here and add
 * it to the array. `runDetectors()` runs these in array order.
 *
 * Rules the runner enforces at startup: ids are unique, and no source is owned by two
 * detectors (two reconcilers deciding the same row's fate would fight).
 */
export const detectors: Detector[] = [
  githubReviewRequested,
  githubUnaddressed,
  githubStale,
  githubCiFailing,
  gitLocal,
  meeting,
  idea,
  standupCarryover,
  slackPromise,
  // slack_ask before slack_unanswered: they share inbound classifications, so the second is cache hits.
  slackAsk,
  slackUnanswered,
];
