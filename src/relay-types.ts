/**
 * Shared type augmentations for orchestra-dsh.
 *
 * The a2a relay message source is merge-extensible in dsh-llm's
 * MessageSourceMap; this declaration makes the runtime shape type-safe.
 */

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    a2a: {
      kind: "a2a";
      form: "relay";
      senderSessionId?: string;
      replyTo?: string;
    };
  }
}

export {};
