import type { APIInteractionResponse } from "discord-api-types/v10";

export const EPHEMERAL_FLAG = 1 << 6; // 64

export function pong(): APIInteractionResponse {
  return { type: 1 };
}

export function message(
  content: string,
  opts?: { ephemeral?: boolean; components?: unknown[] }
): APIInteractionResponse {
  const data: Record<string, unknown> = {
    content,
    flags: opts?.ephemeral ? EPHEMERAL_FLAG : undefined,
  };
  if (opts?.components) data.components = opts.components;
  return {
    type: 4,
    data: data as unknown as Record<string, unknown>,
  } as unknown as APIInteractionResponse;
}

export function errorMessage(content: string): APIInteractionResponse {
  return message(content, { ephemeral: true });
}

export function updateMessage(content: string, opts?: { components?: unknown[] }): APIInteractionResponse {
  return {
    type: 7,
    data: { content, components: opts?.components ?? [] } as unknown as Record<string, unknown>,
  } as unknown as APIInteractionResponse;
}

export function modal(opts: {
  custom_id: string;
  title: string;
  components: unknown[];
}): APIInteractionResponse {
  return {
    type: 9,
    data: opts as unknown as Record<string, unknown>,
  } as unknown as APIInteractionResponse;
}

