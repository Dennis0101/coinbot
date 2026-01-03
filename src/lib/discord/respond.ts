import type { APIInteractionResponse } from "discord-api-types/v10";

export const EPHEMERAL_FLAG = 1 << 6; // 64

export function pong(): APIInteractionResponse {
  return { type: 1 };
}

export function message(content: string, opts?: { ephemeral?: boolean }): APIInteractionResponse {
  return {
    type: 4,
    data: {
      content,
      flags: opts?.ephemeral ? EPHEMERAL_FLAG : undefined,
    },
  };
}

export function errorMessage(content: string): APIInteractionResponse {
  return message(content, { ephemeral: true });
}

