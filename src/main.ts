// `npm run dearbyte`: one entry point for everything.
//
//   npm run dearbyte -- <command>   the agent: status, chat, watch, wechat, imessage… (help lists them)
//   npm run dearbyte [-- --flags]   小拜 the companion in WeChat, as before (src/dearbyte.ts)

import { isAgentCommand } from "./commands.ts";

const first = process.argv[2];
if (isAgentCommand(first)) await import("./agent-cli.ts");
else if (first === undefined || first.startsWith("-")) await import("./dearbyte.ts");
else {
  console.error(`Unknown command "${first}". Run npm run dearbyte -- help for the list.`);
  process.exit(1);
}
