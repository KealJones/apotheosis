import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getDb, tracked } from '@apotheosis/core';

import * as recentActivity from './tools/recent_activity.js';
import * as summarizeWindow from './tools/summarize_window.js';
import * as logIdea from './tools/log_idea.js';
import * as listIdeas from './tools/list_ideas.js';
import * as standupDraft from './tools/standup_draft.js';
import * as logStandup from './tools/log_standup.js';
import * as codeTime from './tools/code_time.js';
import * as mentions from './tools/mentions.js';
import * as triageSamples from './tools/triage_samples.js';
import * as deleteSamples from './tools/delete_samples.js';
import * as deleteMeeting from './tools/delete_meeting.js';
import * as linkEvidence from './tools/link_evidence.js';
import * as createProject from './tools/create_project.js';
import * as getProject from './tools/get_project.js';
import * as getInbox from './tools/get_inbox.js';
import * as contextTimeline from './tools/context_timeline.js';
import * as slackSearch from './tools/slack_search.js';
import * as logUsage from './tools/log_usage.js';
import * as usageStats from './tools/usage_stats.js';
import * as evidenceReport from './tools/evidence_report.js';
import * as listMeetings from './tools/list_meetings.js';
import * as getMeeting from './tools/get_meeting.js';
import * as searchMeetings from './tools/search_meetings.js';
import * as summarizeMeeting from './tools/summarize_meeting.js';
import * as listUncorrelatedMeetings from './tools/list_uncorrelated_meetings.js';
import * as linkMeetingCalendarEvent from './tools/link_meeting_calendar_event.js';
import * as reviewStatus from './tools/review_status.js';
import * as todoList from './tools/todo_list.js';
import * as todoResolve from './tools/todo_resolve.js';
import * as todoSnooze from './tools/todo_snooze.js';
import * as todoAdd from './tools/todo_add.js';
import * as runDetectors from './tools/run_detectors.js';

// Initialize DB on startup (creates tables, data dir, screenshots dir)
getDb();

const server = new McpServer({
  name: 'apotheosis',
  version: '0.1.0',
});

// Every module in tools/ exports name, description, inputSchema (a zod shape), and handler.
const tools = [
  recentActivity,
  summarizeWindow,
  logIdea,
  listIdeas,
  standupDraft,
  logStandup,
  codeTime,
  mentions,
  triageSamples,
  deleteSamples,
  deleteMeeting,
  linkEvidence,
  createProject,
  getProject,
  getInbox,
  contextTimeline,
  slackSearch,
  logUsage,
  usageStats,
  evidenceReport,
  listMeetings,
  getMeeting,
  searchMeetings,
  summarizeMeeting,
  listUncorrelatedMeetings,
  linkMeetingCalendarEvent,
  reviewStatus,
  todoList,
  todoResolve,
  todoSnooze,
  todoAdd,
  runDetectors,
];

for (const tool of tools) {
  const handler = 'trackUsage' in tool && tool.trackUsage === false
    ? tool.handler
    : tracked(tool.name, tool.handler);
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, handler);
}

// ── start ─────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP servers communicate over stdio; log to stderr so it doesn't corrupt the protocol
  process.stderr.write('apotheosis MCP server running\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
