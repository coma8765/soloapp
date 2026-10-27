export interface ChatMessage {
  id: string;
  user_id: string;
  text: string;
  sent_at: number;
}
export interface DeliveryTask {
  task_id: string;
  recipient: string;
  payload: string;
}
export interface ChatConfig {
  notify?: { url: string; token: string };
}
export class ChatError extends Error {
  status: number;
  constructor(status: number, reason: string);
}
export class Database {
  constructor(file?: string);
  config(): Promise<ChatConfig>;
  close(): Promise<void>;
}
export class ChatStore {
  constructor(database?: Database);
  database: Database;
  history(): Promise<{ messages: ChatMessage[] }>;
  send(user: string, body: unknown): Promise<ChatMessage>;
  ticket(user: string): Promise<{ ticket: string; expires_in: number }>;
  consumeTicket(ticket: string): Promise<string | null>;
  close(): Promise<void>;
}
export class Outbox {
  constructor(
    database: Database,
    publish: (task: DeliveryTask) => Promise<void>,
  );
  start(): void;
  close(): Promise<void>;
}
export function publishTask(
  config: ChatConfig,
  task: DeliveryTask,
): Promise<void>;
export function validateSend(body: unknown): {
  text: string;
  client_id: string;
};
