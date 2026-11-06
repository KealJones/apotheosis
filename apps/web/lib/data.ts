// Server-only gateway onto @apotheosis/core.
//
// packages/core touches the local SQLite database directly (node:sqlite),
// filesystem paths, and other server-side-only concerns. It must never end
// up in a client bundle. Importing "server-only" here makes that a build
// error instead of a runtime footgun: any client component that transitively
// imports this module will fail to compile.
//
// Server components and route handlers should import from "@/lib/data"
// rather than "@apotheosis/core" directly, so this guard is never bypassed.
import "server-only";

export * from "@apotheosis/core";
