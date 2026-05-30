#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// stdout is the JSON-RPC channel — redirect any accidental console.log to stderr
console.log = console.error;

import { registerWikiDump } from "./tools/wiki-dump.js";
import { registerWikiRecall } from "./tools/wiki-recall.js";
import { registerWikiSetup } from "./tools/wiki-setup.js";
import { registerWikiUnstick } from "./tools/wiki-unstick.js";
import { registerWikiQuery } from "./tools/wiki-query.js";
import { registerWikiPages } from "./tools/wiki-pages.js";
import { registerWikiLink } from "./tools/wiki-link.js";
import { registerWikiGraph } from "./tools/wiki-graph.js";
import { registerWikiStructure } from "./tools/wiki-structure.js";
import { registerWikiSave } from "./tools/wiki-save.js";
import { registerWikiDelete } from "./tools/wiki-delete.js";

const server = new McpServer({
  name: "oh-my-adhd",
  version: "0.2.0",
});

registerWikiDump(server);
registerWikiRecall(server);
registerWikiSetup(server);
registerWikiUnstick(server);
registerWikiQuery(server);
registerWikiPages(server);
registerWikiLink(server);
registerWikiGraph(server);
registerWikiStructure(server);
registerWikiSave(server);
registerWikiDelete(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
