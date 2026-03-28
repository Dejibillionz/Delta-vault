import { AgentDecision } from "./decision";

export function logAgent(message: string): void {
  console.log(`[AI AGENT] ${message}`);
}

export function logDecision(decision: AgentDecision): void {
  console.log(`[AI AGENT] Decision -> ${JSON.stringify(decision)}`);
}
