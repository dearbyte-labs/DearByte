// The agent's commands, shared by the `npm run dearbyte` entry point (which
// routes them to the agent) and the agent itself.

export const AGENT_COMMANDS = ["ask", "chat", "status", "brief", "check", "watch", "alerts", "telegram", "calendar", "news", "fire", "wallet", "approvals", "approve", "reject", "wechat", "imessage", "help"] as const;

/** `npm run dearbyte -- <command>` runs the agent; no command (or only flags, like --draft) runs 小拜 the companion in WeChat. */
export const isAgentCommand = (arg: string | undefined): boolean => (AGENT_COMMANDS as readonly string[]).includes(arg ?? "");
