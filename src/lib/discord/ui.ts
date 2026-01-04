import { SUPPORTED_COINS } from "@/lib/constants";

// Discord component JSON is verbose; we keep it as plain objects (validated by Discord).

export function button(custom_id: string, label: string, style: 1 | 2 | 3 | 4 = 2) {
  return { type: 2, style, custom_id, label };
}

export function actionRow(components: unknown[]) {
  return { type: 1, components };
}

export function selectMenu(custom_id: string, placeholder: string) {
  return {
    type: 3,
    custom_id,
    placeholder,
    min_values: 1,
    max_values: 1,
    options: SUPPORTED_COINS.map((c) => ({ label: c, value: c })),
  };
}

export function textInput(custom_id: string, label: string, opts?: { required?: boolean; placeholder?: string }) {
  return {
    type: 4,
    custom_id,
    label,
    style: 1, // short
    required: opts?.required ?? true,
    placeholder: opts?.placeholder,
  };
}

export function paragraphInput(custom_id: string, label: string, opts?: { required?: boolean; placeholder?: string }) {
  return {
    type: 4,
    custom_id,
    label,
    style: 2, // paragraph
    required: opts?.required ?? true,
    placeholder: opts?.placeholder,
  };
}

